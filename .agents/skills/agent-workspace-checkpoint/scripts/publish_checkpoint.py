#!/usr/bin/env python3
"""Publish a private Relay checkpoint without sending its recovery key."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from public_checkpoint import (
    PublicCheckpointError,
    canonicalize_public_archive,
    public_metadata,
)
from relay_credentials import RelayCredentialError, load_access_token
from relay_crypto import (
    RelayCryptoError,
    checkpoint_key_path,
    decrypt_checkpoint,
    load_checkpoint_key,
    prompt_checkpoint_key,
    read_encrypted_header,
)
from relay_upload import RelayUploadError, upload_checkpoint

CHECKPOINT_ID_PATTERN = re.compile(r"^cp_[A-Za-z0-9_-]{6,80}$")
CHECKSUM_PATTERN = re.compile(r"^(?:sha256:)?([0-9a-f]{64})$", re.IGNORECASE)
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--public-title", required=True)
    parser.add_argument("--public-description", required=True)
    parser.add_argument("--api-url", default=os.environ.get("RELAY_API_URL"))
    parser.add_argument("--api-token", default=os.environ.get("RELAY_API_TOKEN"))
    parser.add_argument(
        "--key-file",
        type=Path,
        help="Permission-restricted recovery key file; otherwise use the saved key or prompt",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Confirm the irreversible public disclosure non-interactively",
    )
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    checkpoint_id = args.checkpoint.strip()
    if not CHECKPOINT_ID_PATTERN.fullmatch(checkpoint_id):
        raise SystemExit("Checkpoint must be a Relay cp_ ID")
    if not args.api_url:
        raise SystemExit("Publishing requires RELAY_API_URL (or --api-url)")
    try:
        metadata = public_metadata(
            args.public_title,
            args.public_description,
        )
        api_token = load_access_token(
            args.api_url,
            args.api_token,
            required_scope="checkpoints:publish",
        )
    except (PublicCheckpointError, RelayCredentialError) as error:
        raise SystemExit(str(error)) from error

    with tempfile.TemporaryDirectory(prefix="relay-publish-") as temporary:
        temporary_root = Path(temporary)
        encrypted_path = temporary_root / "source.relay"
        plaintext_path = temporary_root / "source.tar.gz"
        public_path = temporary_root / f"{checkpoint_id}.relay-public.tar.gz"

        source = download_private_checkpoint(
            checkpoint_id=checkpoint_id,
            api_url=args.api_url,
            api_token=api_token,
            destination=encrypted_path,
        )
        try:
            header = read_encrypted_header(encrypted_path)
            if header.get("checkpointId") != checkpoint_id:
                raise RelayCryptoError(
                    "Encrypted checkpoint ID does not match the request"
                )
            candidate = (
                args.key_file.expanduser()
                if args.key_file
                else checkpoint_key_path(checkpoint_id)
            )
            used_key_file: Path | None = None
            if args.key_file or candidate.exists():
                key = load_checkpoint_key(candidate)
                used_key_file = candidate.resolve()
            else:
                key = prompt_checkpoint_key()
            decrypt_checkpoint(
                encrypted_path,
                plaintext_path,
                key,
                checkpoint_id,
            )
            public_result = canonicalize_public_archive(
                plaintext_path,
                public_path,
                checkpoint_id=checkpoint_id,
                title=metadata["title"],
                description=metadata["description"],
                forbidden_secrets=(key,),
            )
        except (RelayCryptoError, PublicCheckpointError) as error:
            raise SystemExit(str(error)) from error

        if not args.yes:
            print("This publication is effectively irreversible.")
            print(f"Checkpoint: {checkpoint_id}")
            print(f"Public title: {metadata['title']}")
            print(f"Public description: {metadata['description']}")
            print("Public manifest metadata:")
            print(
                json.dumps(
                    public_result["manifestMetadata"],
                    indent=2,
                    sort_keys=True,
                )
            )
            print(
                f"Files becoming readable ({public_result['includedFiles']}):"
            )
            for path in public_result["files"]:
                print(f"  - {path}")
            answer = input("Type 'publish' to upload this public artifact: ")
            if answer.strip().lower() != "publish":
                raise SystemExit("Publication cancelled")

        try:
            public_skill = public_result.get("skill")
            uploaded = upload_checkpoint(
                archive_path=public_path,
                api_url=args.api_url,
                api_token=api_token,
                checkpoint_id=checkpoint_id,
                checksum=str(public_result["checksum"]),
                agent_metadata=None,
                artifact_metadata={
                    "artifactType": public_result["artifactType"],
                    "skillName": (
                        public_skill.get("name")
                        if isinstance(public_skill, dict)
                        else None
                    ),
                    "skillDescription": (
                        public_skill.get("description")
                        if isinstance(public_skill, dict)
                        else None
                    ),
                },
                operation="publish-existing",
                public_metadata=metadata,
                source_ciphertext_checksum=str(source["checksum"]),
            )
        except (OSError, RelayUploadError) as error:
            raise SystemExit(str(error)) from error

        result = {
            "checkpointId": checkpoint_id,
            "visibility": "public",
            "artifactType": public_result["artifactType"],
            "skill": public_result["skill"],
            "publication": metadata,
            "publicFormatVersion": public_result["formatVersion"],
            "archiveSha256": public_result["checksum"],
            "includedFiles": public_result["includedFiles"],
            "publicFiles": public_result["files"],
            "publicManifestMetadata": public_result["manifestMetadata"],
            "treeHash": public_result["treeHash"],
            "sourceCiphertextChecksum": source["checksum"],
            "keyStored": used_key_file is not None,
            "keyFile": str(used_key_file) if used_key_file else None,
            "keySentToRelay": False,
            "publicUrl": (
                f"{args.api_url.rstrip('/')}/api/public/checkpoints/"
                f"{urllib.parse.quote(checkpoint_id, safe='')}/download"
            ),
            "marketplaceUrl": uploaded["marketplace"]["url"],
            "relay": uploaded,
        }

    if args.json_output:
        print(json.dumps(result, indent=2))
    else:
        print(f"Published checkpoint: {checkpoint_id}")
        print(f"Public title: {metadata['title']}")
        print(f"Public URL: {result['publicUrl']}")
        print(f"Marketplace: {result['marketplaceUrl']}")
        print("Recovery key: used locally and never sent to Relay.")
    return 0


def download_private_checkpoint(
    *,
    checkpoint_id: str,
    api_url: str,
    api_token: str,
    destination: Path,
) -> dict[str, str]:
    url = (
        f"{api_url.rstrip('/')}/api/checkpoints/"
        f"{urllib.parse.quote(checkpoint_id, safe='')}/download"
    )
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.relay.checkpoint",
            "Authorization": f"Bearer {api_token}",
            "User-Agent": "relay-publish-checkpoint/1",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            response_id = response.headers.get("x-checkpoint-id")
            if response_id and response_id != checkpoint_id:
                raise SystemExit(
                    "Relay checkpoint ID does not match the publication request"
                )
            declared_checksum = normalize_checksum(
                response.headers.get("x-checkpoint-sha256") or ""
            )
            digest = hashlib.sha256()
            total = 0
            descriptor = os.open(
                destination,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            with os.fdopen(descriptor, "wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_ARCHIVE_BYTES:
                        raise SystemExit(
                            "Downloaded checkpoint exceeds the size limit"
                        )
                    digest.update(chunk)
                    output.write(chunk)
            actual_checksum = f"sha256:{digest.hexdigest()}"
            if declared_checksum and declared_checksum != actual_checksum:
                destination.unlink(missing_ok=True)
                raise SystemExit(
                    "Downloaded archive checksum does not match Relay metadata"
                )
            return {
                "checkpointId": checkpoint_id,
                "checksum": actual_checksum,
            }
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(
            f"Relay private checkpoint download failed ({error.code}): {detail}"
        ) from error
    except urllib.error.URLError as error:
        raise SystemExit(
            f"Relay private checkpoint download failed: {error.reason}"
        ) from error


def normalize_checksum(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        return ""
    match = CHECKSUM_PATTERN.fullmatch(normalized)
    if not match:
        return normalized
    return f"sha256:{match.group(1).lower()}"


if __name__ == "__main__":
    raise SystemExit(main())
