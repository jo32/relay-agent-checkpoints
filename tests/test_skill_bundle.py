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

    def test_skills_own_authentication_and_download_workflows(self):
        create_skill = (SKILL_ROOTS[0] / "SKILL.md").read_text(encoding="utf-8")
        restore_skill = (SKILL_ROOTS[1] / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("Never ask the user to run an authentication command", create_skill)
        self.assertIn("relay_auth.py login", create_skill)
        self.assertIn("relay_auth.py login --api-url \"$RELAY_API_URL\" --publish", create_skill)
        self.assertIn("relay_auth.py login --api-url \"$RELAY_API_URL\" --delete", create_skill)
        self.assertIn("checkpoints:publish", create_skill)
        self.assertIn("checkpoints:delete", create_skill)
        self.assertIn("delete_checkpoint.py", create_skill)
        self.assertIn("Connect to Relay as described above", create_skill)
        self.assertIn("/api/agent/status", create_skill)
        self.assertIn("uploads in chunks", create_skill)
        self.assertIn("upload_checkpoint.py", create_skill)
        self.assertIn("entered twice only during creation", create_skill)
        self.assertIn("never store, remember, recover, or synchronize", create_skill)
        self.assertIn("--generate-key", create_skill)
        self.assertIn("displayed once in the command output", create_skill)
        self.assertNotIn("--key-file", create_skill)
        self.assertIn("playful pseudonym", create_skill)
        self.assertIn("one-sentence description", create_skill)
        self.assertIn("Agent metadata is intentionally visible", create_skill)
        self.assertIn("Do not open the dashboard", create_skill)
        self.assertIn("Never ask the user to run an authentication command", restore_skill)
        self.assertIn("relay_auth.py login", restore_skill)
        self.assertIn("Continue the download after API verification succeeds", restore_skill)
        self.assertIn("Do not open the Relay dashboard", restore_skill)
        self.assertIn("Do not default to either mode", restore_skill)
        self.assertIn("--merge", restore_skill)
        self.assertIn("--new-workspace", restore_skill)
        self.assertIn("untrusted instructions", restore_skill)
        self.assertIn(
            "always requests the checkpoint's passphrase or recovery key",
            restore_skill,
        )
        self.assertNotIn("--key-file", restore_skill)

        self.assertTrue((SKILL_ROOTS[0] / "scripts" / "agent_metadata.py").is_file())
        self.assertTrue((SKILL_ROOTS[0] / "scripts" / "relay_upload.py").is_file())
        self.assertTrue((SKILL_ROOTS[0] / "scripts" / "upload_checkpoint.py").is_file())
        self.assertTrue((SKILL_ROOTS[0] / "scripts" / "delete_checkpoint.py").is_file())


if __name__ == "__main__":
    unittest.main()
