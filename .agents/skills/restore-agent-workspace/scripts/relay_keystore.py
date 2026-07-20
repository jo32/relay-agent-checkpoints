"""Store small per-checkpoint keys in the operating-system credential vault."""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

if sys.platform == "darwin":
    import pty
    import select
    import signal

from relay_crypto import decode_key, encode_key

KEY_ID = re.compile(r"^cp_[a-z0-9_-]{6,80}$", re.I)
MACOS_ACCOUNT = "relay-checkpoints"
MACOS_SERVICE_PREFIX = "dev.relay.checkpoint."
WINDOWS_RESOURCE = "Relay encrypted checkpoints"
KEY_FILE_VERSION = 1


class KeyStoreError(RuntimeError):
    pass


class KeyNotFound(KeyStoreError):
    pass


class KeyAlreadyExists(KeyStoreError):
    pass


def generate_checkpoint_key() -> bytes:
    return secrets.token_bytes(32)


def store_checkpoint_key(
    checkpoint_id: str,
    key: bytes,
    key_file: Path | None = None,
) -> str:
    _validate(checkpoint_id, key)
    if key_file:
        _file_store(key_file.expanduser(), checkpoint_id, key)
        return "key file"
    if sys.platform == "darwin":
        _macos_store(checkpoint_id, key)
        return "macOS Keychain"
    if sys.platform == "win32":
        _windows_store(checkpoint_id, key)
        return "Windows Credential Locker"
    raise KeyStoreError(
        "This platform has no configured secure key store. "
        "Use --key-file with a protected recovery file."
    )


def load_checkpoint_key(
    checkpoint_id: str,
    key_file: Path | None = None,
) -> tuple[bytes, str]:
    _validate_id(checkpoint_id)
    if key_file:
        return _file_load(key_file.expanduser(), checkpoint_id), "key file"
    if sys.platform == "darwin":
        return _macos_load(checkpoint_id), "macOS Keychain"
    if sys.platform == "win32":
        return _windows_load(checkpoint_id), "Windows Credential Locker"
    raise KeyStoreError(
        "This platform has no configured secure key store. "
        "Use --key-file with a protected recovery file."
    )


def remember_shared_key(
    checkpoint_id: str,
    key: bytes,
    key_file: Path | None = None,
) -> str:
    try:
        existing, source = load_checkpoint_key(checkpoint_id, key_file)
    except KeyNotFound:
        return store_checkpoint_key(checkpoint_id, key, key_file)
    if not secrets.compare_digest(existing, key):
        raise KeyAlreadyExists(
            "A different key is already stored for this checkpoint"
        )
    return source


def _validate_id(checkpoint_id: str) -> None:
    if not KEY_ID.fullmatch(checkpoint_id):
        raise KeyStoreError("Checkpoint key ID is invalid")


def _validate(checkpoint_id: str, key: bytes) -> None:
    _validate_id(checkpoint_id)
    if len(key) != 32:
        raise KeyStoreError("Checkpoint encryption key must be 32 bytes")


def _macos_service(checkpoint_id: str) -> str:
    return MACOS_SERVICE_PREFIX + checkpoint_id


def _macos_load(checkpoint_id: str) -> bytes:
    security = shutil.which("security")
    if not security:
        raise KeyStoreError("macOS Keychain command is unavailable")
    result = subprocess.run(
        [
            security,
            "find-generic-password",
            "-a",
            MACOS_ACCOUNT,
            "-s",
            _macos_service(checkpoint_id),
            "-w",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise KeyNotFound(
            f"No macOS Keychain key is available for {checkpoint_id}"
        )
    return decode_key(result.stdout.strip())


def _macos_store(checkpoint_id: str, key: bytes) -> None:
    try:
        _macos_load(checkpoint_id)
    except KeyNotFound:
        pass
    else:
        raise KeyAlreadyExists(f"A key is already stored for {checkpoint_id}")
    security = shutil.which("security")
    if not security:
        raise KeyStoreError("macOS Keychain command is unavailable")
    command = [
        security,
        "add-generic-password",
        "-a",
        MACOS_ACCOUNT,
        "-s",
        _macos_service(checkpoint_id),
        "-l",
        f"Relay encrypted checkpoint {checkpoint_id}",
        "-w",
    ]
    _macos_add_with_private_terminal(command, encode_key(key))


def _macos_add_with_private_terminal(
    command: list[str],
    secret: str,
) -> None:
    child, terminal = pty.fork()
    if child == 0:
        os.execv(command[0], command)
    deadline = time.monotonic() + 15
    prompts_answered = 0
    output_tail = b""
    try:
        while True:
            waited, status = os.waitpid(child, os.WNOHANG)
            if waited:
                if os.waitstatus_to_exitcode(status):
                    raise KeyStoreError("macOS Keychain rejected the key")
                return
            if time.monotonic() >= deadline:
                os.kill(child, signal.SIGKILL)
                os.waitpid(child, 0)
                raise KeyStoreError("macOS Keychain timed out while storing the key")
            ready, _, _ = select.select([terminal], [], [], 0.1)
            if ready:
                try:
                    output_tail = (output_tail + os.read(terminal, 4096))[-512:]
                    if b"item:" in output_tail and prompts_answered < 2:
                        os.write(terminal, secret.encode("ascii") + b"\n")
                        prompts_answered += 1
                        output_tail = b""
                except OSError:
                    pass
    finally:
        os.close(terminal)


def _powershell() -> str:
    executable = shutil.which("powershell.exe") or shutil.which("powershell")
    if not executable:
        raise KeyStoreError("Windows PowerShell is unavailable")
    return executable


def _windows_load(checkpoint_id: str) -> bytes:
    script = r"""
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = [Windows.Security.Credentials.PasswordVault]::new()
try {
  $credential = $vault.Retrieve($env:RELAY_KEY_RESOURCE, $env:RELAY_KEY_ID)
  $credential.RetrievePassword()
  [Console]::Out.Write($credential.Password)
} catch {
  exit 44
}
"""
    result = subprocess.run(
        [_powershell(), "-NoProfile", "-NonInteractive", "-Command", script],
        env={
            **os.environ,
            "RELAY_KEY_RESOURCE": WINDOWS_RESOURCE,
            "RELAY_KEY_ID": checkpoint_id,
        },
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise KeyNotFound(
            f"No Windows Credential Locker key is available for {checkpoint_id}"
        )
    return decode_key(result.stdout.strip())


def _windows_store(checkpoint_id: str, key: bytes) -> None:
    try:
        _windows_load(checkpoint_id)
    except KeyNotFound:
        pass
    else:
        raise KeyAlreadyExists(f"A key is already stored for {checkpoint_id}")
    script = r"""
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$secret = [Console]::In.ReadToEnd().Trim()
$vault = [Windows.Security.Credentials.PasswordVault]::new()
$credential = [Windows.Security.Credentials.PasswordCredential]::new(
  $env:RELAY_KEY_RESOURCE,
  $env:RELAY_KEY_ID,
  $secret
)
$vault.Add($credential)
"""
    result = subprocess.run(
        [_powershell(), "-NoProfile", "-NonInteractive", "-Command", script],
        env={
            **os.environ,
            "RELAY_KEY_RESOURCE": WINDOWS_RESOURCE,
            "RELAY_KEY_ID": checkpoint_id,
        },
        input=encode_key(key),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.strip() or "Windows Credential Locker rejected the key"
        raise KeyStoreError(detail)


def _read_key_file(path: Path, *, allow_missing: bool = False) -> dict[str, object]:
    if not path.exists():
        if allow_missing:
            return {"formatVersion": KEY_FILE_VERSION, "keys": {}}
        raise KeyNotFound(f"Recovery key file does not exist: {path}")
    if path.is_symlink() or not path.is_file():
        raise KeyStoreError("Recovery key path must be a regular file")
    if os.name == "posix" and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise KeyStoreError(
            "Recovery key file permissions are too broad; use mode 600"
        )
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise KeyStoreError("Recovery key file is invalid") from error
    if (
        not isinstance(payload, dict)
        or payload.get("formatVersion") != KEY_FILE_VERSION
        or not isinstance(payload.get("keys"), dict)
    ):
        raise KeyStoreError("Recovery key file format is unsupported")
    return payload


def _file_load(path: Path, checkpoint_id: str) -> bytes:
    payload = _read_key_file(path)
    value = payload["keys"].get(checkpoint_id)  # type: ignore[union-attr]
    if not isinstance(value, str):
        raise KeyNotFound(f"Recovery key file has no key for {checkpoint_id}")
    return decode_key(value)


def _file_store(path: Path, checkpoint_id: str, key: bytes) -> None:
    payload = _read_key_file(path, allow_missing=True)
    keys = payload["keys"]
    assert isinstance(keys, dict)
    if checkpoint_id in keys:
        raise KeyAlreadyExists(f"A key is already stored for {checkpoint_id}")
    keys[checkpoint_id] = encode_key(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        if os.name == "posix":
            os.chmod(path, 0o600)
    finally:
        temporary.unlink(missing_ok=True)
