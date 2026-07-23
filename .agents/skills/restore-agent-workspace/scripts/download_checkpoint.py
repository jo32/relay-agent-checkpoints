#!/usr/bin/env python3
"""Download, validate, and restore or merge a Relay checkpoint."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import shutil
import tarfile
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

from relay_crypto import (
    RelayCryptoError,
    checkpoint_key_path,
    decrypt_checkpoint,
    is_encrypted_checkpoint,
    load_checkpoint_key,
    prompt_checkpoint_key,
    read_encrypted_header,
)
from relay_credentials import RelayCredentialError, load_access_token

MAX_MEMBERS = 100_000
MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBER_BYTES = 100 * 1024 * 1024
PUBLIC_FORMAT_VERSION = 1
CHECKSUM_PATTERN = re.compile(r"^(?:sha256:)?([0-9a-f]{64})$", re.IGNORECASE)
CHECKPOINT_ID_PATTERN = re.compile(r"^cp_[A-Za-z0-9_-]{6,80}$")
WINDOWS_RESERVED_NAMES = {
    "con",
    "prn",
    "aux",
    "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}
PUBLIC_METADATA_FILES = {
    ".agent-checkpoint/manifest.json",
    ".agent-checkpoint/HANDOFF.md",
    ".agent-checkpoint/README.md",
    ".agent-checkpoint/inferred.gitignore",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint",
        required=True,
        help="Relay checkpoint ID or expiring share URL",
    )
    parser.add_argument("--destination", type=Path, required=True)
    restore_mode = parser.add_mutually_exclusive_group(required=True)
    restore_mode.add_argument(
        "--new-workspace",
        action="store_const",
        const="new",
        dest="restore_mode",
        help="restore into a new or empty workspace",
    )
    restore_mode.add_argument(
        "--merge",
        action="store_const",
        const="merge",
        dest="restore_mode",
        help="merge into an existing workspace without overwriting conflicts",
    )
    parser.add_argument("--api-url", default=os.environ.get("RELAY_API_URL"))
    parser.add_argument("--api-token", default=os.environ.get("RELAY_API_TOKEN"))
    parser.add_argument(
        "--key-file",
        type=Path,
        help="Permission-restricted recovery key file; otherwise use the saved key or prompt",
    )
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
    if destination.exists() and not destination.is_dir():
        raise SystemExit(f"Destination must be a directory: {destination}")
    if (
        args.restore_mode == "new"
        and destination.exists()
        and any(destination.iterdir())
    ):
        raise SystemExit(f"Destination must be empty: {destination}")

    url, needs_token = checkpoint_url(checkpoint_input, args.api_url)
    api_token: str | None = None
    if needs_token:
        try:
            api_token = load_access_token(
                args.api_url or "",
                args.api_token,
                required_scope="checkpoints:read",
            )
        except RelayCredentialError as error:
            raise SystemExit(str(error)) from error

    with tempfile.TemporaryDirectory(prefix="relay-restore-") as temporary:
        downloaded_path = Path(temporary) / "checkpoint.download"
        relay_metadata = download_archive(
            url,
            downloaded_path,
            api_token,
        )
        archive_checksum = f"sha256:{sha256_file(downloaded_path)}"
        relay_checksum = relay_metadata.get("checksum")
        if (
            isinstance(relay_checksum, str)
            and normalize_checksum(relay_checksum) != archive_checksum
        ):
            raise SystemExit(
                "Downloaded archive checksum does not match Relay metadata"
            )

        encrypted = is_encrypted_checkpoint(downloaded_path)
        checkpoint_id: str | None = None
        archive_path = downloaded_path
        used_key_file: Path | None = None
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
                    isinstance(relay_checkpoint_id, str)
                    and relay_checkpoint_id != checkpoint_id
                ):
                    raise RelayCryptoError(
                        "Encrypted checkpoint ID does not match Relay metadata"
                    )
                candidate = (
                    args.key_file.expanduser()
                    if args.key_file
                    else checkpoint_key_path(checkpoint_id)
                )
                if args.key_file or candidate.exists():
                    key = load_checkpoint_key(candidate)
                    used_key_file = candidate.resolve()
                else:
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

        public_format = relay_metadata.get("publicFormatVersion")
        if public_format is not None and public_format != PUBLIC_FORMAT_VERSION:
            raise SystemExit(
                "Relay returned an unsupported public checkpoint format"
            )
        is_public = public_format == PUBLIC_FORMAT_VERSION
        publication = relay_metadata.get("publication")
        relay_checkpoint_id = relay_metadata.get("checkpointId")
        requested_checkpoint_id = (
            checkpoint_input
            if needs_token
            and CHECKPOINT_ID_PATTERN.fullmatch(checkpoint_input)
            else checkpoint_id_from_url(url)
        )
        if (
            isinstance(relay_checkpoint_id, str)
            and requested_checkpoint_id is not None
            and relay_checkpoint_id != requested_checkpoint_id
        ):
            raise SystemExit(
                "Relay checkpoint ID does not match the requested checkpoint"
            )
        expected_checkpoint_id = (
            relay_checkpoint_id
            if isinstance(relay_checkpoint_id, str)
            else checkpoint_id
            or requested_checkpoint_id
        )
        result = restore_archive(
            archive_path,
            destination,
            merge=args.restore_mode == "merge",
            expected_checkpoint_id=expected_checkpoint_id,
            public_metadata=(
                publication if is_public and isinstance(publication, dict) else None
            ),
        )
        result.update(
            {
                "downloadUrl": url,
                "archiveSha256": archive_checksum,
                "encrypted": encrypted,
                "visibility": "public" if is_public else "private",
                "encryptionVersion": 2 if encrypted else (0 if is_public else 1),
                "cipher": "AES-256-GCM" if encrypted else "none",
                "keyStored": used_key_file is not None,
                "keyFile": str(used_key_file) if used_key_file else None,
                "agent": relay_metadata.get("agent"),
                "publication": publication,
            }
        )
        if args.keep_archive:
            keep = args.keep_archive.expanduser().resolve()
            keep.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(downloaded_path, keep)
            result["archive"] = str(keep)

    if args.json_output:
        print(json.dumps(result, indent=2))
    else:
        print(
            f"{('Merged' if result['restoreMode'] == 'merge' else 'Restored')} "
            f"{result['verifiedFiles']} verified files "
            f"to {result['destination']}"
        )
        if result["restoreMode"] == "merge":
            print(
                f"Merge result: {result['addedFiles']} added, "
                f"{result['identicalFiles']} identical, "
                f"{result['conflictedFiles']} awaiting reconciliation."
            )
            print(f"Merge report: {result['mergeReport']}")
        if result["encrypted"]:
            if result["keyStored"]:
                print(f"Recovery key: loaded from {result['keyFile']}")
            else:
                print("Encryption key: entered interactively and not stored.")
        elif result["visibility"] == "public":
            print("Recovery key: not required for this public checkpoint.")
        print(f"Read the handoff: {result['handoff']}")
        if isinstance(result.get("agent"), dict):
            agent = result["agent"]
            print(
                f"Checkpoint agent: {agent['name']} ({agent['mode']}) — "
                f"{agent['description']}"
            )
    return 0


def checkpoint_url(
    checkpoint: str,
    api_url: str | None,
) -> tuple[str, bool]:
    parsed = urllib.parse.urlparse(checkpoint)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        clean_url = urllib.parse.urlunparse(parsed._replace(fragment=""))
        return clean_url, False
    if not CHECKPOINT_ID_PATTERN.fullmatch(checkpoint):
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
) -> dict[str, object]:
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
            metadata: dict[str, object] = {
                key: value
                for key, value in {
                    "checksum": response.headers.get("x-checkpoint-sha256"),
                    "checkpointId": response.headers.get("x-checkpoint-id"),
                }.items()
                if value
            }
            agent = decode_agent_metadata(response.headers)
            if agent:
                metadata["agent"] = agent
            public_format = response.headers.get("x-relay-public-format")
            if public_format:
                try:
                    metadata["publicFormatVersion"] = int(public_format)
                except ValueError as error:
                    raise SystemExit(
                        "Relay returned an invalid public checkpoint format"
                    ) from error
                metadata["publication"] = decode_publication_metadata(
                    response.headers
                )
            return metadata
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(
            f"Relay download failed ({error.code}): {detail}"
        ) from error
    except urllib.error.URLError as error:
        raise SystemExit(f"Relay download failed: {error.reason}") from error


def decode_agent_metadata(headers) -> dict[str, str] | None:
    encoded_name = headers.get("x-relay-agent-name")
    encoded_description = headers.get("x-relay-agent-description")
    mode = headers.get("x-relay-agent-metadata-mode")
    if not encoded_name and not encoded_description and not mode:
        return None
    if not encoded_name or not encoded_description or mode not in {
        "shared",
        "pseudonymous",
    }:
        raise SystemExit("Relay returned invalid checkpoint agent metadata")
    name = urllib.parse.unquote(encoded_name)
    description = urllib.parse.unquote(encoded_description)
    if not name or len(name) > 80 or not description or len(description) > 280:
        raise SystemExit("Relay returned invalid checkpoint agent metadata")
    return {"name": name, "description": description, "mode": mode}


def decode_publication_metadata(headers) -> dict[str, str]:
    encoded_title = headers.get("x-relay-public-title")
    encoded_description = headers.get("x-relay-public-description")
    if not encoded_title or not encoded_description:
        raise SystemExit("Relay returned incomplete public checkpoint metadata")
    title = urllib.parse.unquote(encoded_title)
    description = urllib.parse.unquote(encoded_description)
    if not title or len(title) > 120 or not description or len(description) > 1000:
        raise SystemExit("Relay returned invalid public checkpoint metadata")
    return {"title": title, "description": description}


def restore_archive(
    archive_path: Path,
    destination: Path,
    *,
    merge: bool = False,
    expected_checkpoint_id: str | None = None,
    public_metadata: dict[str, object] | None = None,
) -> dict[str, object]:
    seen: set[str] = set()
    windows_paths: dict[str, str] = {}
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
            record_windows_path(name, windows_paths)
            if name in seen:
                raise SystemExit(f"Duplicate archive member: {name}")
            seen.add(name)
            if member.issym() or member.islnk():
                raise SystemExit(f"Checkpoint contains a link: {name}")
            if not (member.isfile() or member.isdir()):
                raise SystemExit(f"Unsafe archive member type: {name}")
            if member.size < 0:
                raise SystemExit(f"Invalid archive member size: {name}")
            if member.size > MAX_MEMBER_BYTES:
                raise SystemExit(f"Archive member exceeds the size limit: {name}")
            total_size += member.size
            if total_size > MAX_EXTRACTED_BYTES:
                raise SystemExit("Checkpoint exceeds the extracted-size limit")
        validate_archive_tree(members)

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
        if not isinstance(manifest, dict):
            raise SystemExit("Checkpoint manifest must be an object")
        if (
            expected_checkpoint_id is not None
            and manifest.get("checkpointId") != expected_checkpoint_id
        ):
            raise SystemExit(
                "Checkpoint manifest ID does not match Relay metadata"
            )
        if public_metadata is not None:
            validate_public_manifest(
                manifest,
                members,
                public_metadata,
            )

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
            if path.startswith(".agent-checkpoint/"):
                raise SystemExit(
                    f"Manifest uses the reserved checkpoint metadata path: {path}"
                )
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
            digest_actual = sha256_stream(source)
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

        if merge:
            return merge_archive(
                archive,
                members,
                expected_files,
                manifest,
                destination,
            )

        destination.mkdir(parents=True, exist_ok=True)
        for member in members:
            name = validate_member_name(member.name)
            target = destination.joinpath(*PurePosixPath(name).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            write_archive_member(archive, member, target)

    for expected in expected_files:
        verify_file(
            destination.joinpath(
                *PurePosixPath(validate_member_name(expected["path"])).parts
            ),
            expected["path"],
            expected["sha256"],
            "restored",
        )

    return restore_result(
        manifest,
        destination,
        len(expected_files),
        destination / ".agent-checkpoint" / "HANDOFF.md",
        restore_mode="new",
    )


def validate_public_manifest(
    manifest: dict[str, object],
    members: list[tarfile.TarInfo],
    public_metadata: dict[str, object],
) -> None:
    tree_hash = manifest.get("treeHash")
    if (
        manifest.get("formatVersion") != 2
        or manifest.get("visibility") != "public"
        or manifest.get("workspace") != "Public workspace"
        or manifest.get("baseSnapshot") is not None
        or manifest.get("exclusions") != []
        or manifest.get("publication") != public_metadata
        or not isinstance(tree_hash, str)
        or CHECKSUM_PATTERN.fullmatch(tree_hash) is None
    ):
        raise SystemExit(
            "Public checkpoint manifest does not match Relay publication metadata"
        )
    metadata_files: set[str] = set()
    for member in members:
        name = validate_member_name(member.name)
        if name == ".agent-checkpoint" and member.isdir():
            continue
        if not name.startswith(".agent-checkpoint/"):
            continue
        if not member.isfile() or name not in PUBLIC_METADATA_FILES:
            raise SystemExit(
                "Public checkpoint contains missing or unexpected reserved metadata"
            )
        metadata_files.add(name)
    if metadata_files != PUBLIC_METADATA_FILES:
        raise SystemExit(
            "Public checkpoint contains missing or unexpected reserved metadata"
        )


def merge_archive(
    archive: tarfile.TarFile,
    members: list[tarfile.TarInfo],
    expected_files: list[dict[str, object]],
    manifest: dict[str, object],
    destination: Path,
) -> dict[str, object]:
    destination.mkdir(parents=True, exist_ok=True)
    checkpoint_id = str(manifest.get("checkpointId") or "unknown")
    merge_id = (
        checkpoint_id
        if re.fullmatch(r"cp_[A-Za-z0-9_-]+", checkpoint_id)
        else f"checkpoint-{hashlib.sha256(checkpoint_id.encode()).hexdigest()[:16]}"
    )
    checkpoint_root = destination / ".agent-checkpoint"
    merges_root = checkpoint_root / "merges"
    merge_root = merges_root / merge_id
    require_safe_directory(destination, checkpoint_root)
    require_safe_directory(destination, merges_root)
    if merge_root.exists() or merge_root.is_symlink():
        raise SystemExit(f"Checkpoint already has a merge record: {merge_root}")

    added: list[dict[str, object]] = []
    identical: list[dict[str, object]] = []
    conflicts: list[dict[str, object]] = []
    for expected in expected_files:
        path = validate_member_name(str(expected["path"]))
        if path.startswith(".agent-checkpoint/"):
            continue
        expected_checksum = normalize_checksum(str(expected["sha256"]))
        target = destination.joinpath(*PurePosixPath(path).parts)
        blocked_by = unsafe_existing_parent(destination, target.parent)
        if blocked_by is not None:
            conflicts.append(
                {
                    "path": path,
                    "reason": f"parent is not a safe directory: {blocked_by}",
                    "checkpointSha256": expected_checksum,
                    "currentSha256": None,
                }
            )
        elif target.is_symlink():
            conflicts.append(
                {
                    "path": path,
                    "reason": "current path is a symbolic link",
                    "checkpointSha256": expected_checksum,
                    "currentSha256": None,
                }
            )
        elif not target.exists():
            added.append(expected)
        elif target.is_file():
            try:
                current_checksum = f"sha256:{sha256_file(target)}"
            except OSError:
                conflicts.append(
                    {
                        "path": path,
                        "reason": "current file could not be read for comparison",
                        "checkpointSha256": expected_checksum,
                        "currentSha256": None,
                    }
                )
                continue
            record = {
                "path": path,
                "checkpointSha256": expected_checksum,
                "currentSha256": current_checksum,
            }
            if current_checksum == expected_checksum:
                identical.append(record)
            else:
                conflicts.append({**record, "reason": "file contents differ"})
        else:
            conflicts.append(
                {
                    "path": path,
                    "reason": "current path is not a regular file",
                    "checkpointSha256": expected_checksum,
                    "currentSha256": None,
                }
            )

    merge_root.mkdir(parents=True)
    source_root = merge_root / "source"
    for member in members:
        name = validate_member_name(member.name)
        if not name.startswith(".agent-checkpoint/") or member.isdir():
            continue
        target = source_root.joinpath(*PurePosixPath(name).parts)
        write_archive_member(archive, member, target)

    expected_by_path = {
        validate_member_name(str(item["path"])): item for item in expected_files
    }
    for expected in added:
        path = validate_member_name(str(expected["path"]))
        member = archive.getmember(path)
        target = destination.joinpath(*PurePosixPath(path).parts)
        write_archive_member(archive, member, target)
        verify_file(target, path, expected["sha256"], "merged")

    incoming_root = merge_root / "incoming"
    for conflict in conflicts:
        path = str(conflict["path"])
        expected = expected_by_path[path]
        member = archive.getmember(path)
        target = incoming_root.joinpath(*PurePosixPath(path).parts)
        write_archive_member(archive, member, target)
        verify_file(target, path, expected["sha256"], "staged incoming")

    report = {
        "checkpointId": manifest.get("checkpointId"),
        "workspace": manifest.get("workspace"),
        "destination": str(destination),
        "added": [str(item["path"]) for item in added],
        "identical": [str(item["path"]) for item in identical],
        "conflicts": conflicts,
        "incomingRoot": str(incoming_root),
    }
    report_path = merge_root / "merge.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    handoff = source_root / ".agent-checkpoint" / "HANDOFF.md"
    result = restore_result(
        manifest,
        destination,
        len(expected_files),
        handoff,
        restore_mode="merge",
    )
    result.update(
        {
            "addedFiles": len(added),
            "identicalFiles": len(identical),
            "conflictedFiles": len(conflicts),
            "mergeReport": str(report_path),
            "incomingRoot": str(incoming_root),
        }
    )
    return result


def restore_result(
    manifest: dict[str, object],
    destination: Path,
    verified_files: int,
    handoff: Path,
    *,
    restore_mode: str,
) -> dict[str, object]:
    return {
        "checkpointId": manifest.get("checkpointId"),
        "workspace": manifest.get("workspace"),
        "destination": str(destination),
        "verifiedFiles": verified_files,
        "handoff": str(handoff),
        "treeHash": manifest.get("treeHash"),
        "restoreMode": restore_mode,
    }


def require_safe_directory(destination: Path, path: Path) -> None:
    blocked_by = unsafe_existing_parent(destination, path)
    if blocked_by is not None:
        raise SystemExit(f"Unsafe merge metadata path: {blocked_by}")
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise SystemExit(f"Unsafe merge metadata directory: {path}")


def unsafe_existing_parent(destination: Path, parent: Path) -> Path | None:
    relative = parent.relative_to(destination)
    current = destination
    for part in relative.parts:
        current /= part
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            return current
    return None


def write_archive_member(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    target: Path,
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    source = archive.extractfile(member)
    if source is None:
        raise SystemExit(f"Archive member is unreadable: {member.name}")
    try:
        with target.open("xb") as output:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                output.write(chunk)
        os.chmod(target, member.mode & 0o777)
    except OSError as error:
        raise SystemExit(f"Could not write restored file {target}: {error}") from error


def verify_file(
    target: Path,
    path: object,
    checksum: object,
    action: str,
) -> None:
    if not target.is_file():
        raise SystemExit(f"Missing {action} file: {path}")
    if f"sha256:{sha256_file(target)}" != normalize_checksum(str(checksum)):
        raise SystemExit(f"{action.capitalize()} file hash mismatch: {path}")


def validate_archive_tree(members: list[tarfile.TarInfo]) -> None:
    file_names = {
        validate_member_name(member.name) for member in members if member.isfile()
    }
    for member in members:
        name = validate_member_name(member.name)
        pure = PurePosixPath(name)
        for parent in pure.parents:
            normalized = parent.as_posix()
            if normalized == ".":
                break
            if normalized in file_names:
                raise SystemExit(
                    f"Archive file blocks a child path: {normalized}"
                )


def validate_member_name(name: str) -> str:
    if (
        not name
        or "\0" in name
        or "\\" in name
        or re.match(r"^[A-Za-z]:", name)
        or any(character in '<>"|?*' for character in name)
        or any(ord(character) < 32 or ord(character) == 127 for character in name)
    ):
        raise SystemExit("Checkpoint contains an invalid member name")
    pure = PurePosixPath(name)
    if pure.is_absolute() or ".." in pure.parts:
        raise SystemExit(f"Archive member escapes the destination: {name}")
    for part in pure.parts:
        windows_base = part.split(".", 1)[0].casefold()
        if (
            ":" in part
            or part.endswith((".", " "))
            or windows_base in WINDOWS_RESERVED_NAMES
        ):
            raise SystemExit(
                "Checkpoint contains a member name that is unsafe on Windows"
            )
    normalized = pure.as_posix()
    if normalized in {"", "."}:
        raise SystemExit("Checkpoint contains an empty member name")
    return normalized


def record_windows_path(name: str, paths: dict[str, str]) -> None:
    parts = PurePosixPath(name).parts
    for length in range(1, len(parts) + 1):
        exact = "/".join(parts[:length])
        folded = unicodedata.normalize("NFC", exact).casefold()
        previous = paths.get(folded)
        if previous is not None and previous != exact:
            raise SystemExit(
                "Checkpoint contains paths that collide on a case-insensitive filesystem"
            )
        paths[folded] = exact


def checkpoint_id_from_url(url: str) -> str | None:
    path = urllib.parse.unquote(urllib.parse.urlparse(url).path)
    match = re.fullmatch(
        r"/api/(?:public/)?checkpoints/(cp_[A-Za-z0-9_-]{6,80})/download",
        path,
    )
    return match.group(1) if match else None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_stream(handle) -> str:
    digest = hashlib.sha256()
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def normalize_checksum(value: str) -> str:
    normalized = value.strip()
    match = CHECKSUM_PATTERN.fullmatch(normalized)
    if not match:
        return normalized
    return f"sha256:{match.group(1).lower()}"


if __name__ == "__main__":
    raise SystemExit(main())
