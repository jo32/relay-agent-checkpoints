#!/usr/bin/env python3
"""Build the downloadable Relay skill bundle deterministically."""

from __future__ import annotations

import hashlib
import os
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_SKILLS = ROOT / "public" / "skills"
BUNDLE = PUBLIC_SKILLS / "relay-checkpoint-skills.zip"
CHECKSUM = PUBLIC_SKILLS / "relay-checkpoint-skills.zip.sha256"
SKILLS = (
    ROOT / ".agents" / "skills" / "agent-workspace-checkpoint",
    ROOT / ".agents" / "skills" / "restore-agent-workspace",
)
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def included_files(skill: Path) -> list[Path]:
    return sorted(
        path
        for path in skill.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and path.suffix not in {".pyc", ".pyo"}
        and path.name != ".DS_Store"
    )


def main() -> None:
    for skill in SKILLS:
        if not (skill / "SKILL.md").is_file():
            raise SystemExit(f"Skill is incomplete: {skill}")

    PUBLIC_SKILLS.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix="relay-checkpoint-skills-",
        suffix=".zip",
        dir=PUBLIC_SKILLS,
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)

    try:
        with zipfile.ZipFile(
            temporary_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as archive:
            for skill in SKILLS:
                for source in included_files(skill):
                    relative = source.relative_to(ROOT).as_posix()
                    info = zipfile.ZipInfo(relative, FIXED_TIMESTAMP)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.create_system = 3
                    info.external_attr = (source.stat().st_mode & 0xFFFF) << 16
                    archive.writestr(info, source.read_bytes(), compresslevel=9)
        os.replace(temporary_path, BUNDLE)
        BUNDLE.chmod(0o644)
    finally:
        temporary_path.unlink(missing_ok=True)

    digest = hashlib.sha256(BUNDLE.read_bytes()).hexdigest()
    CHECKSUM.write_text(f"{digest}  {BUNDLE.name}\n", encoding="utf-8")


if __name__ == "__main__":
    main()
