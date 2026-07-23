#!/usr/bin/env python3
"""Permanently delete an owned Relay checkpoint after exact-ID confirmation."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from relay_credentials import (
    RelayCredentialError,
    load_access_token,
    normalize_api_url,
)
from relay_crypto import checkpoint_key_path


CHECKPOINT_ID_PATTERN = re.compile(r"^cp_[A-Za-z0-9_-]{6,80}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--api-url", default=os.environ.get("RELAY_API_URL"))
    parser.add_argument("--api-token", default=os.environ.get("RELAY_API_TOKEN"))
    parser.add_argument(
        "--delete-local-key",
        action="store_true",
        help="Also remove Relay's locally saved generated recovery key, if present",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the prompt only after the user explicitly confirmed this checkpoint ID",
    )
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    checkpoint_id = args.checkpoint.strip()
    if not CHECKPOINT_ID_PATTERN.fullmatch(checkpoint_id):
        raise SystemExit("Checkpoint must be a valid Relay cp_ ID")
    if not args.api_url:
        raise SystemExit("Relay URL is required (--api-url or RELAY_API_URL).")

    try:
        api_url = normalize_api_url(args.api_url)
        token = load_access_token(
            api_url,
            args.api_token,
            required_scope="checkpoints:delete",
        )
    except RelayCredentialError as error:
        raise SystemExit(str(error)) from error

    encoded_id = urllib.parse.quote(checkpoint_id, safe="")
    status, metadata = request_json(
        f"{api_url}/api/checkpoints/{encoded_id}",
        token,
        method="GET",
    )
    if status == 404:
        raise SystemExit("Checkpoint not found")
    if status != 200 or not isinstance(metadata.get("checkpoint"), dict):
        raise SystemExit(
            f"Relay could not inspect the checkpoint ({status}): "
            f"{metadata.get('error', 'invalid response')}"
        )

    checkpoint = metadata["checkpoint"]
    visibility = str(checkpoint.get("visibility", "private"))
    key_path = checkpoint_key_path(checkpoint_id)
    if not args.yes:
        print(
            f"Delete Relay checkpoint {checkpoint_id} ({visibility}) permanently.",
            file=sys.stderr,
        )
        if visibility == "public":
            print(
                "Its public URL and marketplace listing will stop working, but "
                "downloaded or cached copies cannot be retracted.",
                file=sys.stderr,
            )
        if args.delete_local_key and key_path.exists():
            print(
                f"The locally saved recovery key at {key_path} will also be removed.",
                file=sys.stderr,
            )
        print(
            f"Type {checkpoint_id} to confirm: ",
            end="",
            file=sys.stderr,
            flush=True,
        )
        if sys.stdin.readline().rstrip("\r\n") != checkpoint_id:
            raise SystemExit("Checkpoint deletion cancelled")

    status, deleted = request_json(
        f"{api_url}/api/checkpoints/{encoded_id}",
        token,
        method="DELETE",
        payload={"confirmation": checkpoint_id},
    )
    if status != 200 or deleted.get("deleted") is not True:
        raise SystemExit(
            f"Relay could not delete the checkpoint ({status}): "
            f"{deleted.get('error', 'invalid response')}"
        )

    key_removed = False
    key_error = None
    if args.delete_local_key and key_path.exists():
        try:
            key_path.unlink()
            key_removed = True
        except OSError as error:
            key_error = f"Unable to remove local recovery key: {error}"

    result = {
        "deleted": True,
        "checkpointId": checkpoint_id,
        "visibility": visibility,
        "deletedObjects": deleted.get("deletedObjects"),
        "localKey": {
            "requested": bool(args.delete_local_key),
            "path": str(key_path),
            "removed": key_removed,
            "error": key_error,
        },
        "localArchivesRemoved": False,
        "publicCopiesWarning": deleted.get("publicCopiesWarning"),
    }
    if args.json_output:
        print(json.dumps(result, indent=2))
    else:
        print(f"Deleted Relay checkpoint {checkpoint_id}.")
        if key_removed:
            print(f"Deleted local recovery key: {key_path}")
        elif key_error:
            print(key_error, file=sys.stderr)
        print("Local checkpoint archives were not removed.")
        if result["publicCopiesWarning"]:
            print(result["publicCopiesWarning"])
    return 0


def request_json(
    url: str,
    token: str,
    *,
    method: str,
    payload: dict[str, object] | None = None,
) -> tuple[int, dict[str, object]]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "relay-delete-checkpoint/1",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            return response.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        body = error.read()
        try:
            response_payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            response_payload = {"error": "invalid_server_response"}
        return error.code, response_payload
    except urllib.error.URLError as error:
        raise SystemExit(f"Relay checkpoint deletion failed: {error.reason}") from error


if __name__ == "__main__":
    raise SystemExit(main())
