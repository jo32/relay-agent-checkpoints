"""Artifact metadata and SKILL.md validation for Relay checkpoints."""

from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path


ARTIFACT_TYPES = ("agent", "skill")
MAX_SKILL_NAME_CHARACTERS = 80
MAX_SKILL_DESCRIPTION_CHARACTERS = 1000
SKILL_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")


class ArtifactMetadataError(RuntimeError):
    pass


def resolve_artifact_metadata(
    *,
    artifact_type: str | None,
    root: Path | None = None,
    skill_name: str | None = None,
    skill_description: str | None = None,
) -> dict[str, object]:
    normalized_type = (artifact_type or "agent").strip().lower()
    if normalized_type not in ARTIFACT_TYPES:
        raise ArtifactMetadataError("Artifact type must be agent or skill")
    if normalized_type == "agent":
        if skill_name is not None or skill_description is not None:
            raise ArtifactMetadataError(
                "Agent checkpoints cannot include skill metadata"
            )
        return {"type": "agent", "skill": None}

    declared = read_skill_metadata(root) if root is not None else None
    normalized_name = normalize_skill_name(
        skill_name or (declared or {}).get("name")
    )
    normalized_description = clean_text(
        skill_description or (declared or {}).get("description"),
        MAX_SKILL_DESCRIPTION_CHARACTERS,
        "Skill description",
    )
    if not normalized_name or not normalized_description:
        raise ArtifactMetadataError(
            "Skill checkpoints require SKILL.md name and description"
        )
    if declared and (
        normalized_name != declared["name"]
        or normalized_description != declared["description"]
    ):
        raise ArtifactMetadataError(
            "Skill metadata must match the target SKILL.md frontmatter"
        )
    return {
        "type": "skill",
        "skill": {
            "name": normalized_name,
            "description": normalized_description,
        },
    }


def read_skill_metadata(root: Path | None) -> dict[str, str]:
    if root is None:
        raise ArtifactMetadataError("Skill checkpoints require a skill directory")
    skill_file = root / "SKILL.md"
    if skill_file.is_symlink() or not skill_file.is_file():
        raise ArtifactMetadataError(
            "Skill checkpoints require a regular SKILL.md at the skill root"
        )
    try:
        text = skill_file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise ArtifactMetadataError("SKILL.md is unreadable") from error
    metadata = parse_skill_metadata(text)
    if root.name != metadata["name"]:
        raise ArtifactMetadataError(
            "Skill directory name must match the SKILL.md name"
        )
    return metadata


def parse_skill_metadata(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise ArtifactMetadataError("SKILL.md requires YAML frontmatter")
    try:
        end = next(
            index
            for index, line in enumerate(lines[1:], start=1)
            if line.strip() == "---"
        )
    except StopIteration as error:
        raise ArtifactMetadataError("SKILL.md frontmatter is not closed") from error

    fields: dict[str, str] = {}
    index = 1
    while index < end:
        match = re.match(r"^(name|description):\s*(.*)$", lines[index])
        if not match:
            index += 1
            continue
        key, value = match.groups()
        if value in {"|", "|-", "|+", ">", ">-", ">+"}:
            block: list[str] = []
            index += 1
            while index < end and (
                not lines[index].strip() or lines[index][:1].isspace()
            ):
                block.append(lines[index].strip())
                index += 1
            value = " ".join(part for part in block if part)
        else:
            index += 1
        fields[key] = unquote_yaml_scalar(value.strip())

    name = normalize_skill_name(fields.get("name"))
    description = clean_text(
        fields.get("description"),
        MAX_SKILL_DESCRIPTION_CHARACTERS,
        "Skill description",
    )
    if not name or not description:
        raise ArtifactMetadataError(
            "SKILL.md frontmatter requires name and description"
        )
    return {"name": name, "description": description}


def normalize_skill_name(value: object) -> str:
    normalized = clean_text(value, MAX_SKILL_NAME_CHARACTERS, "Skill name")
    if normalized and not SKILL_NAME_PATTERN.fullmatch(normalized):
        raise ArtifactMetadataError(
            "Skill name must use lowercase letters, numbers, hyphens, or underscores"
        )
    return normalized


def artifact_sidecar_path(archive_path: Path) -> Path:
    return archive_path.with_name(archive_path.name + ".artifact.json")


def save_artifact_metadata(
    archive_path: Path,
    checkpoint_id: str,
    metadata: dict[str, object],
) -> Path:
    path = artifact_sidecar_path(archive_path)
    payload = {
        "version": 1,
        "checkpointId": checkpoint_id,
        "artifact": metadata,
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
            raise ArtifactMetadataError("Checkpoint artifact sidecar is unsafe")
        path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True)
            + "\n",
            encoding="utf-8",
        )
        if os.name != "nt":
            path.chmod(0o600)
    except OSError as error:
        path.unlink(missing_ok=True)
        raise ArtifactMetadataError(
            "Unable to save checkpoint artifact metadata"
        ) from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return path


def load_artifact_metadata(
    archive_path: Path,
    checkpoint_id: str,
) -> dict[str, object]:
    path = artifact_sidecar_path(archive_path)
    if not path.exists():
        return {"type": "agent", "skill": None}
    if path.is_symlink() or not path.is_file():
        raise ArtifactMetadataError("Checkpoint artifact sidecar is unsafe")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ArtifactMetadataError("Checkpoint artifact sidecar is invalid") from error
    if (
        not isinstance(payload, dict)
        or payload.get("version") != 1
        or payload.get("checkpointId") != checkpoint_id
        or not isinstance(payload.get("artifact"), dict)
    ):
        raise ArtifactMetadataError("Checkpoint artifact sidecar does not match")
    artifact = payload["artifact"]
    skill = artifact.get("skill")
    return resolve_artifact_metadata(
        artifact_type=artifact.get("type"),
        skill_name=skill.get("name") if isinstance(skill, dict) else None,
        skill_description=(
            skill.get("description") if isinstance(skill, dict) else None
        ),
    )


def api_artifact_metadata(metadata: dict[str, object]) -> dict[str, object]:
    skill = metadata.get("skill")
    return {
        "artifactType": metadata["type"],
        "skillName": skill.get("name") if isinstance(skill, dict) else None,
        "skillDescription": (
            skill.get("description") if isinstance(skill, dict) else None
        ),
    }


def unquote_yaml_scalar(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            decoded = json.loads(value)
            return decoded if isinstance(decoded, str) else value
        except json.JSONDecodeError:
            return value
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def clean_text(value: object, max_characters: int, field_name: str) -> str:
    if not isinstance(value, str):
        return ""
    normalized = " ".join(unicodedata.normalize("NFC", value).strip().split())
    if len(normalized) > max_characters:
        raise ArtifactMetadataError(
            f"{field_name} is limited to {max_characters} characters"
        )
    return normalized
