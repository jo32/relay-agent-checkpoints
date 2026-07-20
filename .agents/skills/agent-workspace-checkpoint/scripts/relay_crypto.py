"""Authenticated, streaming Relay checkpoint encryption through Node.js crypto."""

from __future__ import annotations

import base64
import json
import re
import shutil
import struct
import subprocess
from pathlib import Path

MAGIC = b"RELAYCP2\n"
MAX_HEADER_BYTES = 16 * 1024
HELPER = Path(__file__).with_name("relay_crypto.mjs")


class RelayCryptoError(RuntimeError):
    pass


def encode_key(key: bytes) -> str:
    if len(key) != 32:
        raise RelayCryptoError("Checkpoint encryption key must be 32 bytes")
    return base64.urlsafe_b64encode(key).rstrip(b"=").decode("ascii")


def decode_key(value: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", value.strip()):
        raise RelayCryptoError("Checkpoint encryption key is invalid")
    try:
        padding = "=" * (-len(value.strip()) % 4)
        key = base64.urlsafe_b64decode(value.strip() + padding)
    except (ValueError, UnicodeError) as error:
        raise RelayCryptoError("Checkpoint encryption key is invalid") from error
    if len(key) != 32:
        raise RelayCryptoError("Checkpoint encryption key must be 32 bytes")
    return key


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
        input=encode_key(key) + "\n",
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.strip() or "Checkpoint cryptography failed"
        raise RelayCryptoError(detail)
