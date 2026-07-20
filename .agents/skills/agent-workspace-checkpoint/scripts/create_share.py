#!/usr/bin/env python3
"""Create an expiring zero-knowledge Relay share link."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from relay_crypto import encode_key
from relay_keystore import KeyStoreError, load_checkpoint_key


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, help="Relay checkpoint ID")
    parser.add_argument("--api-url", default=os.environ.get("RELAY_API_URL"))
    parser.add_argument("--api-token", default=os.environ.get("RELAY_API_TOKEN"))
    parser.add_argument(
        "--key-file",
        type=Path,
        help="Explicit mode-600 recovery key file instead of the OS credential vault",
    )
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.api_url or not args.api_token:
        raise SystemExit(
            "Sharing requires RELAY_API_URL and RELAY_API_TOKEN "
            "(or --api-url and --api-token)."
        )
    try:
        key, key_store = load_checkpoint_key(
            args.checkpoint,
            args.key_file,
        )
    except KeyStoreError as error:
        raise SystemExit(str(error)) from error

    endpoint = (
        f"{args.api_url.rstrip('/')}/api/checkpoints/"
        f"{urllib.parse.quote(args.checkpoint, safe='')}/share"
    )
    request = urllib.request.Request(
        endpoint,
        data=b"",
        method="POST",
        headers={
            "Authorization": f"Bearer {args.api_token}",
            "Accept": "application/json",
            "User-Agent": "relay-agent-workspace-share/2",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Relay share failed ({error.code}): {detail}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"Relay share failed: {error.reason}") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("url"), str):
        raise SystemExit("Relay share returned an invalid response")

    base_url = payload["url"].split("#", 1)[0]
    share_url = f"{base_url}#relay-key={encode_key(key)}"
    result = {
        "checkpointId": args.checkpoint,
        "url": share_url,
        "expiresAt": payload.get("expiresAt"),
        "keyStore": key_store,
        "serverReceivedKey": False,
    }
    if args.json_output:
        print(json.dumps(result, indent=2))
    else:
        print(share_url)
        print(
            "The decryption key is after #relay-key= and is not sent to Relay.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
