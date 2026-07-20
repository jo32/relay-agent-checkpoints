#!/usr/bin/env python3
"""Download, validate, and restore a Relay checkpoint into a new workspace."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

from relay_crypto import (
    RelayCryptoError,
    decrypt_checkpoint,
    is_encrypted_checkpoint,
    prompt_checkpoint_key,
    read_encrypted_header,
)

MAX_MEMBERS = 100_000
MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint",
        required=True,
        help="Relay checkpoint ID or expiring share URL",
    )
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--api-url", default=os.environ.get("RELAY_API_URL"))
    parser.add_argument("--api-token", default=os.environ.get("RELAY_API_TOKEN"))
    parser.add_argument("--keep-archive", type=Path)
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    checkpoint_input = (
        getpass.getpass("Relay share URL: ")
        if args.checkpoint == "-"
        else args.checkpoint
    )
    destination_input = args.destination.expanduser()
    if destination_input.is_symlink():
        raise SystemExit("Destination cannot be a symbolic link")
    destination = destination_input.resolve()
    if destination.exists() and any(destination.iterdir()):
        raise SystemExit(f"Destination must be empty: {destination}")

    url, needs_token = checkpoint_url(checkpoint_input, args.api_url)
    if needs_token and not args.api_token:
        raise SystemExit(
            "A checkpoint ID requires RELAY_API_TOKEN "
            "(or --api-token). Share URLs do not."
        )

    with tempfile.TemporaryDirectory(prefix="relay-restore-") as temporary:
        downloaded_path = Path(temporary) / "checkpoint.download"
        relay_metadata = download_archive(
            url,
            downloaded_path,
            args.api_token if needs_token else None,
        )
        archive_checksum = f"sha256:{sha256_file(downloaded_path)}"
        relay_checksum = relay_metadata.get("checksum")
        if (
            relay_checksum
            and normalize_checksum(relay_checksum) != archive_checksum
        ):
            raise SystemExit(
                "Downloaded archive checksum does not match Relay metadata"
            )

        encrypted = is_encrypted_checkpoint(downloaded_path)
        checkpoint_id: str | None = None
        archive_path = downloaded_path
        if encrypted:
            try:
                header = read_encrypted_header(downloaded_path)
                checkpoint_id = str(header["checkpointId"])
                if needs_token and checkpoint_id != checkpoint_input:
                    raise RelayCryptoError(
                        "Encrypted checkpoint ID does not match the request"
                    )
                relay_checkpoint_id = relay_metadata.get("checkpointId")
                if (
                    relay_checkpoint_id
                    and relay_checkpoint_id != checkpoint_id
                ):
                    raise RelayCryptoError(
                        "Encrypted checkpoint ID does not match Relay metadata"
                    )
                key = prompt_checkpoint_key()
                archive_path = Path(temporary) / "checkpoint.tar.gz"
                decrypt_checkpoint(
                    downloaded_path,
                    archive_path,
                    key,
                    checkpoint_id,
                )
            except RelayCryptoError as error:
                raise SystemExit(str(error)) from error

        result = restore_archive(archive_path, destination)
        result.update(
            {
                "downloadUrl": url,
                "archiveSha256": archive_checksum,
                "encrypted": encrypted,
                "encryptionVersion": 2 if encrypted else 1,
                "cipher": "AES-256-GCM" if encrypted else "none",
                "keyStored": False,
            }
        )
        if args.keep_archive:
            keep = args.keep_archive.expanduser().resolve()
            keep.parent.mkdir(parents=True, exist_ok=True)
            keep.write_bytes(downloaded_path.read_bytes())
            result["archive"] = str(keep)

    if args.json_output:
        print(json.dumps(result, indent=2))
    else:
        print(
            f"Restored {result['verifiedFiles']} verified files "
            f"to {result['destination']}"
        )
        if result["encrypted"]:
            print("Encryption key: entered interactively and not stored.")
        print(f"Read the handoff: {result['handoff']}")
    return 0


def checkpoint_url(
    checkpoint: str,
    api_url: str | None,
) -> tuple[str, bool]:
    parsed = urllib.parse.urlparse(checkpoint)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        clean_url = urllib.parse.urlunparse(parsed._replace(fragment=""))
        return clean_url, False
    if not checkpoint.startswith("cp_"):
        raise SystemExit("Checkpoint must be a Relay cp_ ID or an HTTPS share URL")
    if not api_url:
        raise SystemExit(
            "A checkpoint ID requires RELAY_API_URL (or --api-url)"
        )
    return (
        f"{api_url.rstrip('/')}/api/checkpoints/"
        f"{urllib.parse.quote(checkpoint, safe='')}/download",
        True,
    )


def download_archive(
    url: str,
    destination: Path,
    api_token: str | None,
) -> dict[str, str]:
    headers = {"User-Agent": "relay-restore-agent-workspace/2"}
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            content_type = response.headers.get("content-type", "")
            if "json" in content_type:
                raise SystemExit(
                    "Relay returned JSON instead of a checkpoint archive"
                )
            with destination.open("wb") as output:
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_EXTRACTED_BYTES:
                        raise SystemExit("Downloaded checkpoint exceeds the size limit")
                    output.write(chunk)
            return {
                key: value
                for key, value in {
                    "checksum": response.headers.get("x-checkpoint-sha256"),
                    "checkpointId": response.headers.get("x-checkpoint-id"),
                }.items()
                if value
            }
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(
            f"Relay download failed ({error.code}): {detail}"
        ) from error
    except urllib.error.URLError as error:
        raise SystemExit(f"Relay download failed: {error.reason}") from error


def restore_archive(archive_path: Path, destination: Path) -> dict[str, object]:
    seen: set[str] = set()
    try:
        archive = tarfile.open(archive_path, "r:gz")
    except (tarfile.TarError, OSError) as error:
        raise SystemExit("Downloaded file is not a valid .tar.gz checkpoint") from error

    with archive:
        members = archive.getmembers()
        if len(members) > MAX_MEMBERS:
            raise SystemExit("Checkpoint contains too many archive members")
        total_size = 0
        for member in members:
            name = validate_member_name(member.name)
            if name in seen:
                raise SystemExit(f"Duplicate archive member: {name}")
            seen.add(name)
            if member.issym() or member.islnk():
                raise SystemExit(f"Checkpoint contains a link: {name}")
            if not (member.isfile() or member.isdir()):
                raise SystemExit(f"Unsafe archive member type: {name}")
            if member.size < 0:
                raise SystemExit(f"Invalid archive member size: {name}")
            total_size += member.size
            if total_size > MAX_EXTRACTED_BYTES:
                raise SystemExit("Checkpoint exceeds the extracted-size limit")

        required = {
            ".agent-checkpoint/manifest.json",
            ".agent-checkpoint/HANDOFF.md",
        }
        if not required.issubset(seen):
            raise SystemExit("Checkpoint manifest or handoff is missing")

        manifest_source = archive.extractfile(".agent-checkpoint/manifest.json")
        if manifest_source is None:
            raise SystemExit("Checkpoint manifest is unreadable")
        try:
            manifest = json.load(manifest_source)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise SystemExit("Checkpoint manifest is invalid") from error

        expected_files = manifest.get("files")
        if not isinstance(expected_files, list):
            raise SystemExit("Checkpoint manifest has no file list")

        expected_paths: set[str] = set()
        for expected in expected_files:
            if not isinstance(expected, dict):
                raise SystemExit("Malformed file record in manifest")
            path = expected.get("path")
            digest = expected.get("sha256")
            if not isinstance(path, str) or not isinstance(digest, str):
                raise SystemExit("Malformed file record in manifest")
            path = validate_member_name(path)
            if path in expected_paths:
                raise SystemExit(f"Duplicate manifest file: {path}")
            expected_paths.add(path)
            try:
                member = archive.getmember(path)
            except KeyError as error:
                raise SystemExit(f"Manifest file is missing: {path}") from error
            if not member.isfile():
                raise SystemExit(f"Manifest path is not a regular file: {path}")
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit(f"Manifest file is unreadable: {path}")
            digest_actual = hashlib.sha256(source.read()).hexdigest()
            if f"sha256:{digest_actual}" != normalize_checksum(digest):
                raise SystemExit(f"Hash mismatch: {path}")

        for member in members:
            name = validate_member_name(member.name)
            if (
                member.isfile()
                and not name.startswith(".agent-checkpoint/")
                and name not in expected_paths
            ):
                raise SystemExit(f"Unmanifested project file: {name}")

        tree_material = "".join(
            f"{expected['path']}\0{normalize_checksum(expected['sha256']).removeprefix('sha256:')}\n"
            for expected in sorted(expected_files, key=lambda item: item["path"])
        ).encode()
        expected_tree = manifest.get("treeHash")
        actual_tree = f"sha256:{hashlib.sha256(tree_material).hexdigest()}"
        if expected_tree and normalize_checksum(str(expected_tree)) != actual_tree:
            raise SystemExit("Checkpoint tree hash does not match the manifest")

        destination.mkdir(parents=True, exist_ok=True)
        for member in members:
            name = validate_member_name(member.name)
            target = destination.joinpath(*PurePosixPath(name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise SystemExit(f"Archive member is unreadable: {name}")
            with target.open("xb") as output:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    output.write(chunk)
            os.chmod(target, member.mode & 0o777)

    for expected in expected_files:
        path = expected["path"]
        target = destination.joinpath(*PurePosixPath(validate_member_name(path)).parts)
        if not target.is_file():
            raise SystemExit(f"Missing restored file: {path}")
        if f"sha256:{sha256_file(target)}" != normalize_checksum(expected["sha256"]):
            raise SystemExit(f"Restored file hash mismatch: {path}")

    return {
        "checkpointId": manifest.get("checkpointId"),
        "workspace": manifest.get("workspace"),
        "destination": str(destination),
        "verifiedFiles": len(expected_files),
        "handoff": str(destination / ".agent-checkpoint" / "HANDOFF.md"),
        "treeHash": manifest.get("treeHash"),
    }


def validate_member_name(name: str) -> str:
    if not name or "\0" in name:
        raise SystemExit("Checkpoint contains an invalid member name")
    pure = PurePosixPath(name)
    if pure.is_absolute() or ".." in pure.parts:
        raise SystemExit(f"Archive member escapes the destination: {name}")
    normalized = pure.as_posix()
    if normalized in {"", "."}:
        raise SystemExit("Checkpoint contains an empty member name")
    return normalized


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_checksum(value: str) -> str:
    return value if value.startswith("sha256:") else f"sha256:{value}"


if __name__ == "__main__":
    raise SystemExit(main())
