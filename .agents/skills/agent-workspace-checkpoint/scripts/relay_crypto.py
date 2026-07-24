"""Authenticated, streaming Relay checkpoint encryption through Node.js crypto."""

from __future__ import annotations

import base64
import getpass
import hmac
import json
import re
import secrets
import shutil
import struct
import subprocess
from pathlib import Path

MAGIC = b"RELAYCP2\n"
MAX_HEADER_BYTES = 16 * 1024
HELPER = Path(__file__).with_name("relay_crypto.mjs")
MIN_PASSPHRASE_CHARACTERS = 8
KDF_NAME = "scrypt"
KDF_SALT_BYTES = 16
KDF_N = 131_072
KDF_R = 8
KDF_P = 1
CHECKPOINT_ID_PATTERN = re.compile(r"^cp_[A-Za-z0-9_-]{6,80}$")


class RelayCryptoError(RuntimeError):
    pass


def encode_secret(secret: bytes) -> str:
    if not secret:
        raise RelayCryptoError("Checkpoint encryption key cannot be empty")
    return base64.urlsafe_b64encode(secret).rstrip(b"=").decode("ascii")


def validate_checkpoint_passphrase(value: str) -> bytes:
    if len(value) < MIN_PASSPHRASE_CHARACTERS:
        raise RelayCryptoError(
            "Checkpoint passphrase must be at least 8 characters"
        )
    try:
        return value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise RelayCryptoError(
            "Checkpoint passphrase contains invalid Unicode"
        ) from error


def read_checkpoint_passphrase(prompt: str) -> bytes:
    return validate_checkpoint_passphrase(getpass.getpass(prompt))


def prompt_checkpoint_secret() -> bytes:
    return read_checkpoint_passphrase(
        "Checkpoint passphrase or recovery key (minimum 8 characters): "
    )


def prompt_new_checkpoint_passphrase() -> bytes:
    passphrase = read_checkpoint_passphrase(
        "Choose checkpoint passphrase (minimum 8 characters): "
    )
    confirmation = read_checkpoint_passphrase("Confirm checkpoint passphrase: ")
    if not hmac.compare_digest(passphrase, confirmation):
        raise RelayCryptoError("Checkpoint passphrases do not match")
    return passphrase


def generate_checkpoint_recovery_key() -> bytes:
    return encode_secret(secrets.token_bytes(32)).encode("ascii")


def is_encrypted_checkpoint(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(len(MAGIC)) == MAGIC
    except OSError:
        return False


def read_encrypted_header(path: Path) -> dict[str, object]:
    try:
        with path.open("rb") as handle:
            if handle.read(len(MAGIC)) != MAGIC:
                raise RelayCryptoError("File is not a Relay encrypted checkpoint")
            length_bytes = handle.read(4)
            if len(length_bytes) != 4:
                raise RelayCryptoError("Encrypted checkpoint is truncated")
            header_length = struct.unpack(">I", length_bytes)[0]
            if header_length < 2 or header_length > MAX_HEADER_BYTES:
                raise RelayCryptoError("Encrypted checkpoint header length is invalid")
            header_bytes = handle.read(header_length)
            if len(header_bytes) != header_length:
                raise RelayCryptoError("Encrypted checkpoint is truncated")
        header = json.loads(header_bytes)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as error:
        if isinstance(error, RelayCryptoError):
            raise
        raise RelayCryptoError("Encrypted checkpoint header is invalid") from error
    if (
        not isinstance(header, dict)
        or header.get("formatVersion") != 2
        or header.get("cipher") != "AES-256-GCM"
        or not isinstance(header.get("checkpointId"), str)
    ):
        raise RelayCryptoError("Encrypted checkpoint format is unsupported")
    kdf = header.get("kdf")
    if kdf is not None and (
        not isinstance(kdf, dict)
        or set(kdf) != {"name", "salt", "N", "r", "p"}
        or kdf.get("name") != KDF_NAME
        or not isinstance(kdf.get("salt"), str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{22}", kdf["salt"])
        or kdf.get("N") != KDF_N
        or kdf.get("r") != KDF_R
        or kdf.get("p") != KDF_P
    ):
        raise RelayCryptoError("Encrypted checkpoint key derivation is unsupported")
    return header


def encrypt_checkpoint(
    plaintext: Path,
    encrypted: Path,
    checkpoint_id: str,
    key: bytes,
) -> None:
    _run_helper("encrypt", plaintext, encrypted, checkpoint_id, key=key)


def decrypt_checkpoint(
    encrypted: Path,
    plaintext: Path,
    key: bytes,
    expected_checkpoint_id: str | None = None,
) -> dict[str, object]:
    header = read_encrypted_header(encrypted)
    if (
        expected_checkpoint_id
        and header.get("checkpointId") != expected_checkpoint_id
    ):
        raise RelayCryptoError("Encrypted checkpoint ID does not match the request")
    _run_helper("decrypt", encrypted, plaintext, key=key)
    return header


def _run_helper(
    action: str,
    input_path: Path,
    output_path: Path,
    checkpoint_id: str | None = None,
    *,
    key: bytes,
) -> None:
    node = shutil.which("node")
    if not node:
        raise RelayCryptoError(
            "Node.js 22 or newer is required for checkpoint encryption"
        )
    command = [node, str(HELPER), action, str(input_path), str(output_path)]
    if checkpoint_id:
        command.append(checkpoint_id)
    result = subprocess.run(
        command,
        input=encode_secret(key) + "\n",
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.strip() or "Checkpoint cryptography failed"
        raise RelayCryptoError(detail)
