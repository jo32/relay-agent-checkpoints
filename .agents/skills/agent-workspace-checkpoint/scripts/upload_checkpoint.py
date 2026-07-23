#!/usr/bin/env python3
"""Upload and API-verify an existing encrypted Relay checkpoint without its key."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from agent_metadata import (
    AGENT_METADATA_MODES,
    AgentMetadataError,
    load_agent_metadata,
    resolve_agent_metadata,
    save_agent_metadata,
)
from checkpoint_lib import sha256_file
from relay_credentials import RelayCredentialError, load_access_token
from relay_crypto import RelayCryptoError, is_encrypted_checkpoint, read_encrypted_header
from relay_upload import RelayUploadError, upload_checkpoint


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--api-url", default=os.environ.get("RELAY_API_URL"))
    parser.add_argument("--api-token", default=os.environ.get("RELAY_API_TOKEN"))
    parser.add_argument("--agent-metadata", choices=AGENT_METADATA_MODES)
    parser.add_argument("--agent-name")
    parser.add_argument("--agent-description")
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
        token = load_access_token(
            args.api_url,
            args.api_token,
            required_scope="checkpoints:write",
        )
        stored_metadata = load_agent_metadata(archive, checkpoint_id)
        agent_metadata = resolve_agent_metadata(
            checkpoint_id=checkpoint_id,
            mode=(
                args.agent_metadata
                or (stored_metadata or {}).get("mode")
                or "pseudonymous"
            ),
            name=args.agent_name or (stored_metadata or {}).get("name"),
            description=(
                args.agent_description
                or (stored_metadata or {}).get("description")
            ),
        )
    except (AgentMetadataError, RelayCredentialError, RelayCryptoError) as error:
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
            agent_metadata=agent_metadata,
        )
    except (OSError, RelayUploadError) as error:
        raise SystemExit(str(error)) from error

    try:
        metadata_sidecar = save_agent_metadata(
            archive,
            checkpoint_id,
            agent_metadata,
        )
    except AgentMetadataError as error:
        raise SystemExit(str(error)) from error
    result = {
        "checkpointId": checkpoint_id,
        "archive": str(archive),
        "archiveSha256": checksum,
        "sizeBytes": archive.stat().st_size,
        "uploaded": True,
        "keyRequired": False,
        "agent": agent_metadata,
        "agentMetadataFile": str(metadata_sidecar),
        "relay": relay,
    }
    if args.json_output:
        print(json.dumps(result, indent=2))
    else:
        print(f"Uploaded and API-verified Relay checkpoint {checkpoint_id}.")
        print(f"Archive: {archive}")
        print(f"Checksum: {checksum}")
        print(
            f"Agent metadata: {agent_metadata['name']} "
            f"({agent_metadata['mode']}) — {agent_metadata['description']}"
        )
        print("Encryption key: not required for upload retry.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
