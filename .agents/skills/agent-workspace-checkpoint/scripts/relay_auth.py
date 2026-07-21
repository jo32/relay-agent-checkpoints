#!/usr/bin/env python3
"""Connect local Relay skills with a one-time browser authorization."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import webbrowser

from relay_credentials import (
    RelayCredentialError,
    credential_status,
    load_access_token,
    normalize_api_url,
    remove_access_token,
    save_access_token,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("login", "status", "logout"):
        command = subparsers.add_parser(name)
        command.add_argument("--api-url", default=os.environ.get("RELAY_API_URL"))
        command.add_argument("--json", action="store_true", dest="json_output")
        if name == "login":
            command.add_argument("--no-browser", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.api_url:
        raise SystemExit("Relay URL is required (--api-url or RELAY_API_URL).")
    try:
        api_url = normalize_api_url(args.api_url)
        if args.command == "login":
            return login(api_url, args.no_browser, args.json_output)
        if args.command == "status":
            return show_status(api_url, args.json_output)
        return logout(api_url, args.json_output)
    except RelayCredentialError as error:
        raise SystemExit(str(error)) from error


def login(api_url: str, no_browser: bool, json_output: bool) -> int:
    status, authorization = request_json(
        f"{api_url}/api/device/authorize",
        {"client_name": "Relay checkpoint skills"},
    )
    if status != 201:
        raise SystemExit(
            f"Relay sign-in could not start ({status}): "
            f"{authorization.get('error', 'unknown error')}"
        )
    required = (
        "device_code",
        "user_code",
        "verification_uri_complete",
        "expires_in",
        "interval",
    )
    if any(key not in authorization for key in required):
        raise SystemExit("Relay returned an invalid device authorization response")

    verification_url = str(authorization["verification_uri_complete"])
    if not verification_url.startswith(f"{api_url}/"):
        raise SystemExit("Relay returned an unsafe verification URL")
    user_code = str(authorization["user_code"])
    browser_opened = False
    if not no_browser:
        browser_opened = webbrowser.open(verification_url)
    if not json_output:
        if no_browser:
            print(f"Open this approval page once: {verification_url}")
        elif browser_opened:
            print("Approval page opened automatically; do not open it again.")
        else:
            print("Automatic browser launch failed.")
            print(f"Open this approval page once: {verification_url}")
        print(f"One-time code: {user_code}")
        print("Waiting for approval…")

    device_code = str(authorization["device_code"])
    interval = max(2, int(authorization["interval"]))
    deadline = time.monotonic() + int(authorization["expires_in"])
    while time.monotonic() < deadline:
        time.sleep(interval)
        token_status, token_payload = request_json(
            f"{api_url}/api/device/token",
            {"device_code": device_code},
        )
        if token_status == 200:
            token = str(token_payload.get("access_token", ""))
            expires_at = str(token_payload.get("expires_at", ""))
            scopes = str(token_payload.get("scope", ""))
            remote_status, remote_payload = request_get_json(
                f"{api_url}/api/agent/status",
                token,
            )
            if remote_status != 200 or not remote_payload.get("connected"):
                raise SystemExit(
                    "Relay issued a credential but its agent API could not verify it"
                )
            credential_store = save_access_token(
                api_url,
                token,
                expires_at,
                scopes,
            )
            result = {
                "connected": True,
                "apiUrl": api_url,
                "expiresAt": expires_at,
                "scopes": scopes,
                "credentialStore": str(credential_store),
                "remoteVerified": True,
                "checkpointCount": remote_payload.get("checkpointCount"),
            }
            if json_output:
                print(json.dumps(result, indent=2))
            else:
                print("Relay agent connected.")
                print(f"Credential: {credential_store}")
                print(f"Expires: {expires_at}")
            return 0
        error = token_payload.get("error")
        if error == "authorization_pending":
            continue
        if error == "slow_down":
            interval += 5
            continue
        if error == "access_denied":
            raise SystemExit("Relay device authorization was denied")
        if error == "expired_token":
            raise SystemExit("Relay device authorization expired")
        raise SystemExit(f"Relay sign-in failed: {error or token_status}")
    raise SystemExit("Relay device authorization expired")


def show_status(api_url: str, json_output: bool) -> int:
    result = credential_status(api_url)
    if result["connected"]:
        token = load_access_token(api_url)
        remote_status, remote_payload = request_get_json(
            f"{api_url}/api/agent/status",
            token,
        )
        remote_connected = remote_status == 200 and bool(
            remote_payload.get("connected")
        )
        result["connected"] = remote_connected
        result["remoteVerified"] = remote_connected
        if remote_connected:
            result["checkpointCount"] = remote_payload.get("checkpointCount")
            result["scopes"] = remote_payload.get("scopes", result.get("scopes"))
        else:
            result["remoteError"] = remote_payload.get(
                "error",
                f"Relay agent API returned {remote_status}",
            )
    if json_output:
        print(json.dumps(result, indent=2))
    elif result["connected"]:
        print(f"Connected to {result['apiUrl']}")
        print(f"Expires: {result['expiresAt']}")
        print(f"Relay API verified; checkpoints: {result.get('checkpointCount', 0)}")
    else:
        print(f"Not connected to {result['apiUrl']}")
    return 0 if result["connected"] else 1


def logout(api_url: str, json_output: bool) -> int:
    try:
        token = load_access_token(api_url)
    except RelayCredentialError:
        token = None
    if token:
        status, _ = request_json(
            f"{api_url}/api/device/revoke",
            {},
            access_token=token,
        )
        if status != 204:
            raise SystemExit(f"Relay credential could not be revoked ({status})")
    removed = remove_access_token(api_url)
    result = {"connected": False, "apiUrl": api_url, "removed": removed}
    if json_output:
        print(json.dumps(result, indent=2))
    else:
        print("Relay agent disconnected.")
    return 0


def request_json(
    url: str,
    payload: dict[str, object],
    access_token: str | None = None,
) -> tuple[int, dict[str, object]]:
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "relay-device-auth/1",
    }
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
            return response.status, json.loads(data) if data else {}
    except urllib.error.HTTPError as error:
        data = error.read()
        try:
            payload = json.loads(data) if data else {}
        except json.JSONDecodeError:
            payload = {"error": "invalid_server_response"}
        return error.code, payload
    except urllib.error.URLError as error:
        raise SystemExit(f"Relay sign-in failed: {error.reason}") from error


def request_get_json(
    url: str,
    access_token: str,
) -> tuple[int, dict[str, object]]:
    request = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {access_token}",
            "User-Agent": "relay-device-auth/2",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
            return response.status, json.loads(data) if data else {}
    except urllib.error.HTTPError as error:
        data = error.read()
        try:
            payload = json.loads(data) if data else {}
        except json.JSONDecodeError:
            payload = {"error": "invalid_server_response"}
        return error.code, payload
    except urllib.error.URLError as error:
        raise SystemExit(f"Relay agent API check failed: {error.reason}") from error


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nRelay sign-in cancelled.", file=sys.stderr)
        raise SystemExit(130) from None
