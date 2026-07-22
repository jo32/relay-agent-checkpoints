"""Privacy-aware public metadata for Relay checkpoint agents."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


MAX_AGENT_NAME_CHARACTERS = 80
MAX_AGENT_DESCRIPTION_CHARACTERS = 280
AGENT_METADATA_MODES = ("shared", "pseudonymous")

_FUN_ADJECTIVES = (
    "Bouncy",
    "Caffeinated",
    "Cosmic",
    "Dapper",
    "Disco",
    "Fuzzy",
    "Jolly",
    "Quantum",
    "Sneaky",
    "Wobbly",
)
_FUN_NOUNS = (
    "Badger",
    "Capybara",
    "Ferret",
    "Goose",
    "Llama",
    "Marmot",
    "Octopus",
    "Otter",
    "Pangolin",
    "Turnip",
)
_PSEUDONYMOUS_DESCRIPTION = (
    "A privacy-minded helper that summarized progress and prepared an encrypted "
    "workspace handoff."
)


class AgentMetadataError(RuntimeError):
    pass


def resolve_agent_metadata(
    *,
    checkpoint_id: str,
    mode: str | None,
    name: str | None,
    description: str | None,
) -> dict[str, str]:
    normalized_mode = (mode or "pseudonymous").strip().lower()
    if normalized_mode not in AGENT_METADATA_MODES:
        raise AgentMetadataError("Agent metadata mode must be shared or pseudonymous")

    if normalized_mode == "shared":
        normalized_name = clean_text(name, MAX_AGENT_NAME_CHARACTERS)
        normalized_description = clean_text(
            description,
            MAX_AGENT_DESCRIPTION_CHARACTERS,
        )
        if not normalized_name or not normalized_description:
            raise AgentMetadataError(
                "Shared agent metadata requires both a name and description"
            )
    else:
        # A declined or unanswered sharing choice must not preserve a supplied
        # identity accidentally. Always replace it with a Relay pseudonym.
        normalized_name = funny_agent_name(checkpoint_id)
        normalized_description = _PSEUDONYMOUS_DESCRIPTION

    return {
        "name": normalized_name,
        "description": normalized_description,
        "mode": normalized_mode,
    }


def funny_agent_name(checkpoint_id: str) -> str:
    digest = hashlib.sha256(checkpoint_id.encode("utf-8")).digest()
    adjective = _FUN_ADJECTIVES[digest[0] % len(_FUN_ADJECTIVES)]
    noun = _FUN_NOUNS[digest[1] % len(_FUN_NOUNS)]
    return f"{adjective} {noun}"


def metadata_sidecar_path(archive_path: Path) -> Path:
    return archive_path.with_name(archive_path.name + ".metadata.json")


def save_agent_metadata(
    archive_path: Path,
    checkpoint_id: str,
    metadata: dict[str, str],
) -> Path:
    path = metadata_sidecar_path(archive_path)
    payload = {
        "version": 1,
        "checkpointId": checkpoint_id,
        "agent": metadata,
    }
    descriptor: int | None = None
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = None
            json.dump(payload, handle, indent=2, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
        if os.name != "nt":
            path.chmod(0o600)
    except FileExistsError:
        if path.is_symlink() or not path.is_file():
            raise AgentMetadataError(
                "Checkpoint agent metadata sidecar is unsafe"
            )
        path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        if os.name != "nt":
            path.chmod(0o600)
    except OSError as error:
        path.unlink(missing_ok=True)
        raise AgentMetadataError("Unable to save checkpoint agent metadata") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return path


def load_agent_metadata(
    archive_path: Path,
    checkpoint_id: str,
) -> dict[str, str] | None:
    path = metadata_sidecar_path(archive_path)
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise AgentMetadataError("Checkpoint agent metadata sidecar is unsafe")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AgentMetadataError("Checkpoint agent metadata sidecar is invalid") from error
    if (
        not isinstance(payload, dict)
        or payload.get("version") != 1
        or payload.get("checkpointId") != checkpoint_id
        or not isinstance(payload.get("agent"), dict)
    ):
        raise AgentMetadataError("Checkpoint agent metadata sidecar does not match")
    agent = payload["agent"]
    return resolve_agent_metadata(
        checkpoint_id=checkpoint_id,
        mode=agent.get("mode"),
        name=agent.get("name"),
        description=agent.get("description"),
    )


def clean_text(value: str | None, max_characters: int) -> str:
    if not value:
        return ""
    normalized = " ".join(value.split())
    if len(normalized) > max_characters:
        raise AgentMetadataError(
            f"Agent metadata is limited to {max_characters} characters"
        )
    return normalized
