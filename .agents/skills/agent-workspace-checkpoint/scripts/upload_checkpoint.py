#!/usr/bin/env python3
"""Upload and API-verify an existing encrypted Relay checkpoint without its key."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from checkpoint_lib import sha256_file
from relay_credentials import RelayCredentialError, load_access_token
from relay_crypto import RelayCryptoError, is_encrypted_checkpoint, read_encrypted_header
from relay_upload import RelayUploadError, upload_checkpoint


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--api-url", default=os.environ.get("RELAY_API_URL"))
    parser.add_argument("--api-token", default=os.environ.get("RELAY_API_TOKEN"))
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    archive = args.archive.expanduser().resolve()
    if not archive.is_file() or not is_encrypted_checkpoint(archive):
        raise SystemExit("Upload requires an existing encrypted .relay checkpoint")
    if not args.api_url:
        raise SystemExit("Upload requires RELAY_API_URL (or --api-url).")
    try:
        header = read_encrypted_header(archive)
        checkpoint_id = str(header["checkpointId"])
        token = load_access_token(args.api_url, args.api_token)
    except (RelayCredentialError, RelayCryptoError) as error:
        raise SystemExit(str(error)) from error

    digest = sha256_file(archive)
    checksum = f"sha256:{digest}"
    sidecar = archive.with_name(archive.name + ".sha256")
    if sidecar.exists():
        expected = sidecar.read_text(encoding="utf-8").split()[0]
        if expected.removeprefix("sha256:").lower() != digest:
            raise SystemExit("Checkpoint sidecar checksum does not match the archive")
    try:
        relay = upload_checkpoint(
            archive_path=archive,
            api_url=args.api_url,
            api_token=token,
            checkpoint_id=checkpoint_id,
            checksum=checksum,
        )
    except (OSError, RelayUploadError) as error:
        raise SystemExit(str(error)) from error

    result = {
        "checkpointId": checkpoint_id,
        "archive": str(archive),
        "archiveSha256": checksum,
        "sizeBytes": archive.stat().st_size,
        "uploaded": True,
        "keyRequired": False,
        "relay": relay,
    }
    if args.json_output:
        print(json.dumps(result, indent=2))
    else:
        print(f"Uploaded and API-verified Relay checkpoint {checkpoint_id}.")
        print(f"Archive: {archive}")
        print(f"Checksum: {checksum}")
        print("Encryption key: not required for upload retry.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
