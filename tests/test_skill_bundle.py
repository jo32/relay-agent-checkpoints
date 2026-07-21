from __future__ import annotations

import hashlib
import subprocess
import sys
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "public" / "skills" / "relay-checkpoint-skills.zip"
CHECKSUM = ROOT / "public" / "skills" / "relay-checkpoint-skills.zip.sha256"
SKILL_ROOTS = (
    ROOT / ".agents" / "skills" / "agent-workspace-checkpoint",
    ROOT / ".agents" / "skills" / "restore-agent-workspace",
)


class SkillBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build_skill_bundle.py")],
            check=True,
        )

    def test_checksum_matches_bundle(self):
        expected = CHECKSUM.read_text(encoding="utf-8").split()[0]
        actual = hashlib.sha256(BUNDLE.read_bytes()).hexdigest()
        self.assertEqual(actual, expected)

    def test_bundle_contains_only_current_skill_sources(self):
        expected: dict[str, bytes] = {}
        for skill_root in SKILL_ROOTS:
            for source in sorted(skill_root.rglob("*")):
                if (
                    source.is_file()
                    and "__pycache__" not in source.parts
                    and source.suffix not in {".pyc", ".pyo"}
                    and source.name != ".DS_Store"
                ):
                    expected[source.relative_to(ROOT).as_posix()] = source.read_bytes()

        with zipfile.ZipFile(BUNDLE) as archive:
            names = archive.namelist()
            self.assertEqual(names, sorted(expected))
            self.assertTrue(all(not name.startswith("/") for name in names))
            self.assertTrue(all(".." not in Path(name).parts for name in names))
            for name, contents in expected.items():
                self.assertEqual(archive.read(name), contents)


if __name__ == "__main__":
    unittest.main()
