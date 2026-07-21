"""Chunked, authenticated Relay checkpoint upload and API verification."""

from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class RelayUploadError(RuntimeError):
    pass


def upload_checkpoint(
    *,
    archive_path: Path,
    api_url: str,
    api_token: str,
    checkpoint_id: str,
    checksum: str,
) -> dict[str, object]:
    endpoint = api_url.rstrip("/")
    size_bytes = archive_path.stat().st_size
    initialized = request_json(
        "POST",
        f"{endpoint}/api/checkpoints/uploads",
        api_token,
        payload={
            "checkpointId": checkpoint_id,
            "checksum": checksum,
            "encryptionVersion": 2,
            "cipher": "AES-256-GCM",
            "sizeBytes": size_bytes,
        },
    )
    upload_id = str(initialized.get("uploadId", ""))
    chunk_size = initialized.get("chunkSize")
    part_count = initialized.get("partCount")
    if (
        not upload_id
        or not isinstance(chunk_size, int)
        or chunk_size < 64 * 1024
        or not isinstance(part_count, int)
        or part_count < 1
    ):
        raise RelayUploadError("Relay upload initialization response is invalid")

    try:
        uploaded_parts = 0
        with archive_path.open("rb") as source:
            for part_number in range(1, part_count + 1):
                chunk = source.read(chunk_size)
                if not chunk:
                    raise RelayUploadError("Checkpoint archive ended before all parts were read")
                chunk_checksum = f"sha256:{hashlib.sha256(chunk).hexdigest()}"
                response = request_json(
                    "PUT",
                    (
                        f"{endpoint}/api/checkpoints/uploads/"
                        f"{urllib.parse.quote(upload_id, safe='')}/parts/{part_number}"
                    ),
                    api_token,
                    data=chunk,
                    headers={
                        "Content-Type": "application/octet-stream",
                        "X-Chunk-Sha256": chunk_checksum,
                    },
                    retries=3,
                )
                if response.get("checksum") != chunk_checksum:
                    raise RelayUploadError(
                        f"Relay did not verify upload part {part_number}"
                    )
                uploaded_parts += 1
            if source.read(1):
                raise RelayUploadError("Checkpoint archive has unexpected trailing data")

        completed = request_json(
            "POST",
            (
                f"{endpoint}/api/checkpoints/uploads/"
                f"{urllib.parse.quote(upload_id, safe='')}/complete"
            ),
            api_token,
            payload={},
            retries=3,
        )
        checkpoint = completed.get("checkpoint")
        if not isinstance(checkpoint, dict) or checkpoint.get("id") != checkpoint_id:
            raise RelayUploadError("Relay upload completion response is invalid")
        verified = request_json(
            "GET",
            f"{endpoint}/api/checkpoints/{urllib.parse.quote(checkpoint_id, safe='')}",
            api_token,
            retries=3,
        )
        verified_checkpoint = verified.get("checkpoint")
        if (
            not isinstance(verified_checkpoint, dict)
            or verified_checkpoint.get("id") != checkpoint_id
            or str(verified_checkpoint.get("checksum", "")).lower()
            != checksum.lower()
            or verified_checkpoint.get("sizeBytes") != size_bytes
        ):
            raise RelayUploadError("Relay API could not verify the stored checkpoint")
        completed["upload"] = {
            "id": upload_id,
            "parts": uploaded_parts,
            "chunkSize": chunk_size,
            "apiVerified": True,
        }
        return completed
    except (OSError, RelayUploadError):
        abort_upload(endpoint, api_token, upload_id)
        raise


def request_json(
    method: str,
    url: str,
    api_token: str,
    *,
    payload: dict[str, object] | None = None,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    retries: int = 0,
) -> dict[str, object]:
    if payload is not None and data is not None:
        raise RelayUploadError("Relay API request cannot contain two bodies")
    body = json.dumps(payload).encode("utf-8") if payload is not None else data
    request_headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_token}",
        "User-Agent": "relay-agent-workspace-checkpoint/3",
        **(headers or {}),
    }
    if payload is not None:
        request_headers["Content-Type"] = "application/json"
    if body is not None:
        request_headers["Content-Length"] = str(len(body))

    last_error: BaseException | None = None
    for attempt in range(retries + 1):
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers=request_headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                content = response.read()
                if response.status == 204 or not content:
                    return {}
                result = json.loads(content.decode("utf-8"))
                if not isinstance(result, dict):
                    raise RelayUploadError("Relay API returned invalid JSON")
                return result
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            last_error = RelayUploadError(
                f"Relay API request failed ({error.code}): {detail}"
            )
            if error.code not in {429, 500, 502, 503, 504} or attempt >= retries:
                raise last_error from error
        except urllib.error.URLError as error:
            last_error = RelayUploadError(f"Relay API request failed: {error.reason}")
            if attempt >= retries:
                raise last_error from error
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise RelayUploadError("Relay API returned an invalid response") from error
        time.sleep(2**attempt)
    raise RelayUploadError("Relay API request failed") from last_error


def abort_upload(api_url: str, api_token: str, upload_id: str) -> None:
    if not upload_id:
        return
    try:
        request_json(
            "DELETE",
            (
                f"{api_url}/api/checkpoints/uploads/"
                f"{urllib.parse.quote(upload_id, safe='')}"
            ),
            api_token,
        )
    except RelayUploadError:
        pass
