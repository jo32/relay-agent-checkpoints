"""Load and store revocable Relay access credentials outside the project."""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, urlunparse


TOKEN_PATTERN = re.compile(r"^rly_[a-f0-9]{64}$", re.I)


class RelayCredentialError(RuntimeError):
    pass


def normalize_api_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RelayCredentialError("Relay URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RelayCredentialError("Relay URL cannot contain credentials, a query, or a fragment")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RelayCredentialError("Relay requires HTTPS except for local development")
    return urlunparse(parsed._replace(path=parsed.path.rstrip("/"), params=""))


def credentials_path() -> Path:
    override = os.environ.get("RELAY_CREDENTIALS_FILE")
    if override:
        return Path(override).expanduser()
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        return base / "Relay" / "credentials.json"
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "relay" / "credentials.json"


def load_access_token(
    api_url: str,
    explicit_token: str | None = None,
    required_scope: str | None = None,
) -> str:
    token = explicit_token or os.environ.get("RELAY_API_TOKEN")
    if token:
        return _validate_token(token)

    origin = normalize_api_url(api_url)
    payload = _read_credentials()
    entry = payload.get("sites", {}).get(origin)
    if not isinstance(entry, dict):
        raise RelayCredentialError(
            "Relay is not connected. Run relay_auth.py login for this Relay URL."
        )
    expires_at = entry.get("expiresAt")
    if isinstance(expires_at, str) and _is_expired(expires_at):
        raise RelayCredentialError(
            "Relay access has expired. Run relay_auth.py login again."
        )
    scopes = str(entry.get("scopes", "")).split()
    if required_scope and required_scope not in scopes:
        command = (
            "relay_auth.py login --publish"
            if required_scope == "checkpoints:publish"
            else "relay_auth.py login --delete"
            if required_scope == "checkpoints:delete"
            else "relay_auth.py login"
        )
        raise RelayCredentialError(
            f"Relay access lacks {required_scope}. Run {command} for this Relay URL."
        )
    return _validate_token(str(entry.get("accessToken", "")))


def save_access_token(
    api_url: str,
    token: str,
    expires_at: str,
    scopes: str,
) -> Path:
    origin = normalize_api_url(api_url)
    token = _validate_token(token)
    path = credentials_path()
    payload = _read_credentials()
    sites = payload.setdefault("sites", {})
    if not isinstance(sites, dict):
        sites = {}
        payload["sites"] = sites
    sites[origin] = {
        "accessToken": token,
        "expiresAt": expires_at,
        "scopes": scopes,
        "savedAt": datetime.now(timezone.utc).isoformat(),
    }
    payload["version"] = 1
    _write_credentials(path, payload)
    return path


def remove_access_token(api_url: str) -> bool:
    origin = normalize_api_url(api_url)
    path = credentials_path()
    payload = _read_credentials()
    sites = payload.get("sites")
    if not isinstance(sites, dict) or origin not in sites:
        return False
    del sites[origin]
    _write_credentials(path, payload)
    return True


def credential_status(api_url: str) -> dict[str, object]:
    origin = normalize_api_url(api_url)
    entry = _read_credentials().get("sites", {}).get(origin)
    if not isinstance(entry, dict):
        return {"connected": False, "apiUrl": origin}
    expires_at = entry.get("expiresAt")
    return {
        "connected": isinstance(expires_at, str) and not _is_expired(expires_at),
        "apiUrl": origin,
        "expiresAt": expires_at,
        "scopes": entry.get("scopes"),
        "credentialStore": str(credentials_path()),
    }


def _read_credentials() -> dict[str, object]:
    path = credentials_path()
    if not path.exists():
        return {"version": 1, "sites": {}}
    try:
        if os.name != "nt" and path.stat().st_mode & 0o077:
            path.chmod(0o600)
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RelayCredentialError("Relay credential store is unreadable") from error
    if not isinstance(payload, dict):
        raise RelayCredentialError("Relay credential store is invalid")
    return payload


def _write_credentials(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        path.parent.chmod(0o700)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix="credentials-",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            if os.name != "nt":
                os.chmod(temporary, 0o600)
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
        if os.name != "nt":
            path.chmod(0o600)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def _validate_token(token: str) -> str:
    token = token.strip()
    if not TOKEN_PATTERN.fullmatch(token):
        raise RelayCredentialError("Relay access credential is invalid")
    return token


def _is_expired(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed <= datetime.now(timezone.utc)
