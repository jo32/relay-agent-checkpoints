from __future__ import annotations

import io
import base64
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
import urllib.parse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / ".agents" / "skills" / "agent-workspace-checkpoint" / "scripts"
CREATE = SCRIPTS / "create_checkpoint.py"
INSPECT = SCRIPTS / "inspect_checkpoint.py"
SHARE = SCRIPTS / "create_share.py"
AUTH = SCRIPTS / "relay_auth.py"
UPLOAD = SCRIPTS / "upload_checkpoint.py"
PUBLISH = SCRIPTS / "publish_checkpoint.py"
DELETE = SCRIPTS / "delete_checkpoint.py"
RESTORE = (
    ROOT
    / ".agents"
    / "skills"
    / "restore-agent-workspace"
    / "scripts"
    / "download_checkpoint.py"
)
CHECKPOINT_KEY = "correct horse battery staple 🔐"
OTHER_KEY = "different horse battery staple 🔐"
LEGACY_KEY = base64.urlsafe_b64encode(bytes(range(32))).rstrip(b"=").decode()


class CheckpointSkillTests(unittest.TestCase):
    def run_script(
        self,
        script: Path,
        *args: str,
        check: bool = True,
        input_text: str | None = None,
        env: dict[str, str] | None = None,
    ):
        script_args = list(args)
        if (
            script == CREATE
            and input_text is not None
            and not (
                "--visibility" in script_args
                and script_args[script_args.index("--visibility") + 1] == "public"
            )
        ):
            input_lines = input_text.splitlines(keepends=True)
            if len(input_lines) == 1:
                input_text = input_lines[0] + input_lines[0]
        return subprocess.run(
            [sys.executable, str(script), *script_args],
            check=check,
            capture_output=True,
            text=True,
            input=input_text,
            env={**os.environ, **(env or {})},
        )

    def test_create_excludes_secrets_and_inferred_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
            restored = base / "restored"
            project.mkdir()
            (project / "package.json").write_text('{"name":"demo"}')
            (project / "src").mkdir()
            (project / "src" / "index.js").write_text("console.log('safe')")
            (project / "node_modules" / "pkg").mkdir(parents=True)
            (project / "node_modules" / "pkg" / "index.js").write_text("generated")
            (project / ".env").write_text("TOKEN=secret")
            fake_key = "sk-" + "proj-" + "abcdefghijklmnopqrstuvwxyz"
            (project / "leaked.txt").write_text(f"api_key='{fake_key}'")

            result = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--output-dir",
                str(output),
                "--source-agent",
                "codex",
                "--json",
                input_text=f"{CHECKPOINT_KEY}\n",
            )
            payload = json.loads(result.stdout)
            archive = Path(payload["archive"])
            self.assertEqual(archive.suffix, ".relay")
            encrypted_bytes = archive.read_bytes()
            self.assertEqual(encrypted_bytes[:9], b"RELAYCP2\n")
            header_length = int.from_bytes(encrypted_bytes[9:13], "big")
            header = json.loads(encrypted_bytes[13:13 + header_length])
            self.assertEqual(header["kdf"]["name"], "scrypt")
            self.assertEqual(header["kdf"]["N"], 131_072)
            salt = base64.urlsafe_b64decode(header["kdf"]["salt"] + "==")
            self.assertEqual(len(salt), 16)
            self.assertNotIn(CHECKPOINT_KEY, result.stdout)
            self.assertNotIn(CHECKPOINT_KEY.encode(), encrypted_bytes)
            self.assertNotIn(b"console.log('safe')", encrypted_bytes)
            self.assertNotIn(
                payload["treeHash"].removeprefix("sha256:")[:12],
                payload["checkpointId"],
            )
            inspected = json.loads(
                self.run_script(
                    INSPECT,
                    "--verify",
                    "--show-excluded",
                    "--json",
                    str(archive),
                    input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            reasons = {
                item["path"]: item["reason"]
                for item in inspected["exclusions"]
            }
            self.assertTrue(inspected["encrypted"])
            self.assertEqual(reasons[".env"], "credential or secret file")
            self.assertEqual(reasons["leaked.txt"], "API key")
            with archive_server(archive) as url:
                self.run_script(
                    RESTORE,
                    "--checkpoint",
                    url,
                    "--destination",
                    str(restored),
                    "--new-workspace",
                    input_text=f"{CHECKPOINT_KEY}\n",
                )
            self.assertTrue((restored / "src" / "index.js").is_file())
            self.assertFalse((restored / ".env").exists())
            self.assertFalse((restored / "leaked.txt").exists())

    def test_private_create_uses_confirmed_passphrase_without_storing_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
            restored = base / "restored"
            key_directory = base / "keys"
            project.mkdir()
            (project / "README.md").write_text("passphrase checkpoint")
            environment = {"RELAY_KEYS_DIR": str(key_directory)}

            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(output),
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                    env=environment,
                ).stdout
            )
            self.assertEqual(created["secretMode"], "passphrase")
            self.assertFalse(created["secretStored"])
            self.assertIsNone(created["recoveryKey"])
            self.assertNotIn("keyFile", created)
            self.assertNotIn("keyGenerated", created)
            self.assertNotIn(CHECKPOINT_KEY, json.dumps(created))
            self.assertNotIn(
                CHECKPOINT_KEY.encode(),
                Path(created["archive"]).read_bytes(),
            )
            self.assertFalse(key_directory.exists())

            inspected = json.loads(
                self.run_script(
                    INSPECT,
                    "--verify",
                    "--json",
                    created["archive"],
                    input_text=f"{CHECKPOINT_KEY}\n",
                    env=environment,
                ).stdout
            )
            self.assertTrue(inspected["decryptionSecretRequired"])
            self.assertFalse(inspected["secretStored"])
            with archive_server(Path(created["archive"])) as url:
                restored_result = json.loads(
                    self.run_script(
                        RESTORE,
                        "--checkpoint",
                        url,
                        "--destination",
                        str(restored),
                        "--new-workspace",
                        "--json",
                        input_text=f"{CHECKPOINT_KEY}\n",
                        env=environment,
                    ).stdout
                )
            self.assertTrue(restored_result["decryptionSecretRequired"])
            self.assertFalse(restored_result["secretStored"])
            self.assertEqual(
                (restored / "README.md").read_text(),
                "passphrase checkpoint",
            )
            self.assertFalse(key_directory.exists())

    def test_private_create_can_display_generated_recovery_key_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            restored = base / "restored"
            project.mkdir()
            (project / "README.md").write_text("generated recovery key")

            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--generate-key",
                    "--json",
                ).stdout
            )
            recovery_key = created["recoveryKey"]
            self.assertEqual(created["secretMode"], "generated-recovery-key")
            self.assertFalse(created["secretStored"])
            self.assertRegex(recovery_key, r"^[A-Za-z0-9_-]{43}$")
            self.assertEqual(
                json.dumps(created).count(recovery_key),
                1,
            )
            self.assertNotIn(
                recovery_key.encode(),
                Path(created["archive"]).read_bytes(),
            )

            with archive_server(Path(created["archive"])) as url:
                restored_result = json.loads(
                    self.run_script(
                        RESTORE,
                        "--checkpoint",
                        url,
                        "--destination",
                        str(restored),
                        "--new-workspace",
                        "--json",
                        input_text=f"{recovery_key}\n",
                    ).stdout
                )
            self.assertTrue(restored_result["decryptionSecretRequired"])
            self.assertFalse(restored_result["secretStored"])
            self.assertEqual(
                (restored / "README.md").read_text(),
                "generated recovery key",
            )

    def test_private_create_rejects_mismatched_passphrase_confirmation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
            project.mkdir()
            (project / "README.md").write_text("passphrase confirmation")

            result = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--output-dir",
                str(output),
                "--json",
                input_text=f"{CHECKPOINT_KEY}\n{OTHER_KEY}\n",
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("passphrases do not match", result.stderr)
            self.assertFalse(output.exists() and any(output.iterdir()))

    def test_create_defaults_to_playful_pseudonymous_agent_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "README.md").write_text("pseudonymous metadata")
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            self.assertEqual(created["agent"]["mode"], "pseudonymous")
            self.assertRegex(created["agent"]["name"], r"^[A-Z][a-z]+ [A-Z][a-z]+$")
            self.assertIn("privacy-minded helper", created["agent"]["description"])
            metadata_file = Path(created["agentMetadataFile"])
            metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
            self.assertEqual(metadata["checkpointId"], created["checkpointId"])
            self.assertEqual(metadata["agent"], created["agent"])
            if os.name != "nt":
                self.assertEqual(metadata_file.stat().st_mode & 0o777, 0o600)

    def test_create_accepts_user_approved_agent_summary(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "README.md").write_text("shared metadata")
            description = "Refactored Relay metadata and verified the encrypted handoff."
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--agent-metadata",
                    "shared",
                    "--agent-name",
                    "Release Gardener",
                    "--agent-description",
                    description,
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            self.assertEqual(
                created["agent"],
                {
                    "name": "Release Gardener",
                    "description": description,
                    "mode": "shared",
                },
            )
            with archive_server(Path(created["archive"]), created["agent"]) as url:
                restored = json.loads(
                    self.run_script(
                        RESTORE,
                        "--checkpoint",
                        url,
                        "--destination",
                        str(base / "restored"),
                        "--new-workspace",
                        "--json",
                        input_text=f"{CHECKPOINT_KEY}\n",
                    ).stdout
                )
            self.assertEqual(restored["agent"], created["agent"])

    def test_create_public_checkpoint_without_key_and_restore_anonymously(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "README.md").write_text(
                "This workspace is intentionally public.",
                encoding="utf-8",
            )
            publication = {
                "title": "Public Relay example",
                "description": "A reviewed workspace that anyone can restore.",
            }
            key_dir = base / "keys"
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--visibility",
                    "public",
                    "--public-title",
                    publication["title"],
                    "--public-description",
                    publication["description"],
                    "--yes",
                    "--json",
                    env={"RELAY_KEYS_DIR": str(key_dir)},
                ).stdout
            )

            archive_path = Path(created["archive"])
            self.assertEqual(created["visibility"], "public")
            self.assertEqual(created["publication"], publication)
            self.assertEqual(created["publicFiles"], ["README.md"])
            self.assertEqual(
                created["publicManifestMetadata"]["publication"],
                publication,
            )
            self.assertFalse(created["encrypted"])
            self.assertEqual(created["encryptionVersion"], 0)
            self.assertEqual(created["cipher"], "none")
            self.assertIsNone(created["secretMode"])
            self.assertFalse(created["secretStored"])
            self.assertIsNone(created["recoveryKey"])
            self.assertTrue(archive_path.name.endswith(".relay-public.tar.gz"))
            self.assertFalse(key_dir.exists())
            self.assertFalse(archive_path.read_bytes().startswith(b"RELAYCP2\n"))

            with tarfile.open(archive_path, "r:gz") as archive:
                manifest_file = archive.extractfile(
                    ".agent-checkpoint/manifest.json"
                )
                self.assertIsNotNone(manifest_file)
                manifest = json.load(manifest_file)
                handoff_file = archive.extractfile(
                    ".agent-checkpoint/HANDOFF.md"
                )
                self.assertIsNotNone(handoff_file)
                handoff = handoff_file.read().decode("utf-8")
            self.assertEqual(manifest["formatVersion"], 2)
            self.assertEqual(manifest["visibility"], "public")
            self.assertEqual(manifest["publication"], publication)
            self.assertEqual(manifest["workspace"], "Public workspace")
            self.assertEqual(manifest["label"], publication["title"])
            self.assertIsNone(manifest["baseSnapshot"])
            self.assertEqual(manifest["exclusions"], [])
            self.assertNotIn("remote", manifest["git"])
            self.assertIn(publication["title"], handoff)
            self.assertIn(publication["description"], handoff)

            with archive_server(
                archive_path,
                checkpoint_id=created["checkpointId"],
                publication=publication,
                uppercase_checksum=True,
            ) as url:
                restored = json.loads(
                    self.run_script(
                        RESTORE,
                        "--checkpoint",
                        url,
                        "--destination",
                        str(base / "restored"),
                        "--new-workspace",
                        "--json",
                        env={"RELAY_KEYS_DIR": str(key_dir)},
                    ).stdout
                )
            self.assertEqual(restored["visibility"], "public")
            self.assertEqual(restored["encryptionVersion"], 0)
            self.assertFalse(restored["encrypted"])
            self.assertFalse(restored["decryptionSecretRequired"])
            self.assertFalse(restored["secretStored"])
            self.assertEqual(restored["publication"], publication)
            self.assertEqual(
                (base / "restored" / "README.md").read_text(encoding="utf-8"),
                "This workspace is intentionally public.",
            )
            self.assertFalse(key_dir.exists())

            mismatched_destination = base / "mismatched"
            with archive_server(
                archive_path,
                checkpoint_id="cp_different01",
                publication=publication,
                send_checkpoint_id_header=False,
            ) as url:
                mismatched = self.run_script(
                    RESTORE,
                    "--checkpoint",
                    url,
                    "--destination",
                    str(mismatched_destination),
                    "--new-workspace",
                    check=False,
                )
            self.assertNotEqual(mismatched.returncode, 0)
            self.assertIn(
                "manifest ID does not match Relay metadata",
                mismatched.stderr,
            )
            self.assertFalse(mismatched_destination.exists())

            header_mismatched_destination = base / "header-mismatched"
            with archive_server(
                archive_path,
                checkpoint_id=created["checkpointId"],
                header_checkpoint_id="cp_different01",
                publication=publication,
            ) as url:
                header_mismatched = self.run_script(
                    RESTORE,
                    "--checkpoint",
                    url,
                    "--destination",
                    str(header_mismatched_destination),
                    "--new-workspace",
                    check=False,
                )
            self.assertNotEqual(header_mismatched.returncode, 0)
            self.assertIn(
                "Relay checkpoint ID does not match the requested checkpoint",
                header_mismatched.stderr,
            )
            self.assertFalse(header_mismatched_destination.exists())

    def test_public_create_requires_metadata_and_rejects_key_options(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary) / "project"
            project.mkdir()
            (project / "README.md").write_text("public", encoding="utf-8")
            missing_metadata = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--visibility",
                "public",
                "--dry-run",
                "--json",
                check=False,
            )
            self.assertNotEqual(missing_metadata.returncode, 0)
            self.assertIn(
                "require both --public-title and --public-description",
                missing_metadata.stderr,
            )

            removed_key_option = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--visibility",
                "public",
                "--public-title",
                "Public example",
                "--public-description",
                "Reviewed public workspace.",
                "--prompt-key",
                "--dry-run",
                "--json",
                check=False,
            )
            self.assertNotEqual(removed_key_option.returncode, 0)
            self.assertIn(
                "unrecognized arguments: --prompt-key",
                removed_key_option.stderr,
            )

            generated_key = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--visibility",
                "public",
                "--public-title",
                "Public example",
                "--public-description",
                "Reviewed public workspace.",
                "--generate-key",
                "--dry-run",
                "--json",
                check=False,
            )
            self.assertNotEqual(generated_key.returncode, 0)
            self.assertIn(
                "Public checkpoints do not use --generate-key",
                generated_key.stderr,
            )

            preview = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--visibility",
                    "public",
                    "--public-title",
                    "Public example",
                    "--public-description",
                    "Reviewed public workspace.",
                    "--dry-run",
                    "--json",
                ).stdout
            )
            self.assertEqual(preview["publicFiles"], ["README.md"])
            self.assertEqual(
                preview["publicManifestMetadata"]["visibility"],
                "public",
            )

    def test_direct_public_confirmation_lists_files_and_manifest_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            (project / "nested").mkdir(parents=True)
            (project / "nested" / "main.py").write_text(
                "print('public')",
                encoding="utf-8",
            )

            created = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--output-dir",
                str(base / "out"),
                "--visibility",
                "public",
                "--public-title",
                "Public example",
                "--public-description",
                "Reviewed public workspace.",
                input_text="public\n",
            )

            self.assertIn("Public manifest metadata:", created.stdout)
            self.assertIn('"visibility": "public"', created.stdout)
            self.assertIn("Files becoming readable (1):", created.stdout)
            self.assertIn("  - nested/main.py", created.stdout)

    def test_direct_public_cancellation_sends_no_upload(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "README.md").write_text("review first", encoding="utf-8")
            token = "rly_" + "2" * 64

            with upload_server(token) as (api_url, requests):
                cancelled = self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--visibility",
                    "public",
                    "--public-title",
                    "Public example",
                    "--public-description",
                    "Reviewed public workspace.",
                    "--upload",
                    "--api-url",
                    api_url,
                    "--api-token",
                    token,
                    input_text="cancel\n",
                    check=False,
                )

            self.assertNotEqual(cancelled.returncode, 0)
            self.assertIn("cancelled", cancelled.stderr.lower())
            self.assertEqual(requests, [])
            self.assertFalse(any((base / "out").glob("*.relay-public.tar.gz")))

    def test_public_create_scans_large_binary_content_for_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            fake_key = b"sk-proj-abcdefghijklmnopqrstuvwxyz"
            (project / "large.bin").write_bytes(
                b"\0" * 4096 + b"x" * (2 * 1024 * 1024) + b"\n" + fake_key
            )

            blocked = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--output-dir",
                str(base / "out"),
                "--visibility",
                "public",
                "--public-title",
                "Reviewed workspace",
                "--public-description",
                "A workspace reviewed for public release.",
                check=False,
            )

            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn("API key", blocked.stderr)
            self.assertFalse(any((base / "out").glob("*.relay-public.tar.gz")))

    def test_public_scan_isolates_adjacent_file_boundaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            plaintext = base / "private.tar.gz"
            output = base / "public.tar.gz"
            checkpoint_id = "cp_boundary01"
            contents = {
                "a.txt": b"A",
                "b.txt": b"sk-proj-abcdefghijklmnopqrstuvwxyz",
            }
            records = []
            for path, data in contents.items():
                records.append(
                    {
                        "path": path,
                        "size": len(data),
                        "mode": 0o644,
                        "sha256": (
                            f"sha256:{hashlib.sha256(data).hexdigest()}"
                        ),
                    }
                )
            tree_material = "".join(
                f"{record['path']}\0"
                f"{record['sha256'].removeprefix('sha256:')}\n"
                for record in records
            ).encode()
            manifest = {
                "checkpointId": checkpoint_id,
                "files": records,
                "treeHash": (
                    f"sha256:{hashlib.sha256(tree_material).hexdigest()}"
                ),
                "stacks": [],
                "git": {"isRepository": False},
            }
            with tarfile.open(plaintext, "w:gz") as archive:
                for name, data in {
                    **contents,
                    ".agent-checkpoint/manifest.json": json.dumps(
                        manifest
                    ).encode("utf-8"),
                    ".agent-checkpoint/HANDOFF.md": b"# Handoff\n",
                }.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    member.mode = 0o600
                    archive.addfile(member, io.BytesIO(data))

            sys.path.insert(0, str(SCRIPTS))
            try:
                from public_checkpoint import (
                    PublicCheckpointError,
                    canonicalize_public_archive,
                )
            finally:
                sys.path.remove(str(SCRIPTS))

            with self.assertRaisesRegex(PublicCheckpointError, "API key"):
                canonicalize_public_archive(
                    plaintext,
                    output,
                    checkpoint_id=checkpoint_id,
                    title="Boundary test",
                    description="Adjacent files remain isolated while scanning.",
                )
            self.assertFalse(output.exists())

    def test_public_upload_requires_explicit_publish_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "README.md").write_text("public", encoding="utf-8")
            api_url = "https://relay.example"
            credentials = base / "credentials.json"
            credentials.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "sites": {
                            api_url: {
                                "accessToken": "rly_" + "a" * 64,
                                "expiresAt": "2099-01-01T00:00:00+00:00",
                                "scopes": (
                                    "checkpoints:read checkpoints:write "
                                    "checkpoints:share"
                                ),
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            credentials.chmod(0o600)
            result = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--output-dir",
                str(base / "out"),
                "--visibility",
                "public",
                "--public-title",
                "Public example",
                "--public-description",
                "Reviewed public workspace.",
                "--upload",
                "--api-url",
                api_url,
                "--json",
                check=False,
                env={"RELAY_CREDENTIALS_FILE": str(credentials)},
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("lacks checkpoints:publish", result.stderr)
            self.assertIn("relay_auth.py login --publish", result.stderr)
            self.assertFalse((base / "out").exists())

    def test_shared_agent_metadata_requires_name_and_description(self):
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary) / "project"
            project.mkdir()
            (project / "README.md").write_text("shared metadata")
            result = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--agent-metadata",
                "shared",
                "--agent-name",
                "Release Gardener",
                "--dry-run",
                "--json",
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("requires both a name and description", result.stderr)

    def test_create_accepts_eight_character_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "README.md").write_text("minimum key length")
            minimum_key = "12345678"
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--json",
                    input_text=f"{minimum_key}\n{minimum_key}\n",
                ).stdout
            )
            inspected = json.loads(
                self.run_script(
                    INSPECT,
                    "--verify",
                    "--json",
                    created["archive"],
                    input_text=f"{minimum_key}\n",
                ).stdout
            )
            self.assertEqual(inspected["errors"], [])

    def test_create_rejects_passphrase_shorter_than_eight_characters(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
            project.mkdir()
            (project / "README.md").write_text("private content")
            result = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--output-dir",
                str(output),
                "--json",
                check=False,
                input_text="1234567\n",
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("at least 8 characters", result.stderr)
            self.assertFalse(output.exists() and any(output.iterdir()))

    def test_create_requires_passphrase_confirmation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
            project.mkdir()
            (project / "README.md").write_text("private content")
            result = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--output-dir",
                str(output),
                "--json",
                input_text=f"{CHECKPOINT_KEY}\n",
            )
            payload = json.loads(result.stdout)
            self.assertTrue(Path(payload["archive"]).is_file())
            self.assertIn("Confirm checkpoint passphrase", result.stderr)

    def test_preserves_tracked_temporary_named_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "repo"
            output = base / "out"
            restored = base / "restored"
            project.mkdir()
            subprocess.run(["git", "init", "-q", str(project)], check=True)
            (project / ".gitignore").write_text("*.tmp\n")
            (project / "fixture.tmp").write_text("intentional fixture")
            subprocess.run(["git", "-C", str(project), "add", ".gitignore"], check=True)
            subprocess.run(["git", "-C", str(project), "add", "-f", "fixture.tmp"], check=True)
            result = self.run_script(
                CREATE,
                "--root",
                str(project),
                "--output-dir",
                str(output),
                "--json",
                input_text=f"{CHECKPOINT_KEY}\n",
            )
            with archive_server(Path(json.loads(result.stdout)["archive"])) as url:
                self.run_script(
                    RESTORE,
                    "--checkpoint",
                    url,
                    "--destination",
                    str(restored),
                    "--new-workspace",
                    input_text=f"{CHECKPOINT_KEY}\n",
                )
            self.assertEqual(
                (restored / "fixture.tmp").read_text(),
                "intentional fixture",
            )

    def test_restore_verifies_round_trip(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
            restored = base / "restored"
            project.mkdir()
            (project / "README.md").write_text("hello checkpoint")
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(output),
                    "--json",
                input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            inspected = self.run_script(
                INSPECT,
                "--verify",
                "--json",
                created["archive"],
                input_text=f"{CHECKPOINT_KEY}\n",
            )
            self.assertEqual(json.loads(inspected.stdout)["errors"], [])
            with archive_server(Path(created["archive"])) as url:
                restored_result = self.run_script(
                    RESTORE,
                    "--checkpoint",
                    url,
                    "--destination",
                    str(restored),
                    "--new-workspace",
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                )
            self.assertEqual(json.loads(restored_result.stdout)["verifiedFiles"], 1)
            self.assertTrue(json.loads(restored_result.stdout)["encrypted"])
            self.assertEqual((restored / "README.md").read_text(), "hello checkpoint")

    def test_restore_requires_an_explicit_new_or_merge_choice(self):
        result = self.run_script(
            RESTORE,
            "--checkpoint",
            "https://relay.invalid/api/shared/example",
            "--destination",
            "/tmp/relay-explicit-mode-test",
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("one of the arguments --new-workspace --merge is required", result.stderr)

    def test_restore_merges_without_overwriting_current_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "checkpoint-project"
            current = base / "current-project"
            project.mkdir()
            current.mkdir()
            (project / "README.md").write_text("incoming version")
            (project / "same.txt").write_text("same version")
            (project / "src").mkdir()
            (project / "src" / "new.py").write_text("print('incoming')")
            (current / "README.md").write_text("current version")
            (current / "same.txt").write_text("same version")
            (current / "local-only.txt").write_text("keep me")
            (current / ".agent-checkpoint").mkdir()
            current_handoff = current / ".agent-checkpoint" / "HANDOFF.md"
            current_handoff.write_text("current handoff")

            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            with archive_server(Path(created["archive"])) as url:
                merged = json.loads(
                    self.run_script(
                        RESTORE,
                        "--checkpoint",
                        url,
                        "--destination",
                        str(current),
                        "--merge",
                        "--json",
                        input_text=f"{CHECKPOINT_KEY}\n",
                    ).stdout
                )

            self.assertEqual(merged["restoreMode"], "merge")
            self.assertEqual(merged["addedFiles"], 1)
            self.assertEqual(merged["identicalFiles"], 1)
            self.assertEqual(merged["conflictedFiles"], 1)
            self.assertEqual((current / "README.md").read_text(), "current version")
            self.assertEqual((current / "same.txt").read_text(), "same version")
            self.assertEqual((current / "local-only.txt").read_text(), "keep me")
            self.assertEqual(
                (current / "src" / "new.py").read_text(),
                "print('incoming')",
            )
            self.assertEqual(current_handoff.read_text(), "current handoff")
            incoming = Path(merged["incomingRoot"]) / "README.md"
            self.assertEqual(incoming.read_text(), "incoming version")
            self.assertTrue(Path(merged["mergeReport"]).is_file())
            self.assertTrue(Path(merged["handoff"]).is_file())

    def test_restore_merge_never_writes_through_current_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "checkpoint-project"
            current = base / "current-project"
            outside = base / "outside"
            project.mkdir()
            current.mkdir()
            outside.mkdir()
            (project / "src").mkdir()
            (project / "src" / "new.py").write_text("do not escape")
            (current / "src").symlink_to(outside, target_is_directory=True)

            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            with archive_server(Path(created["archive"])) as url:
                merged = json.loads(
                    self.run_script(
                        RESTORE,
                        "--checkpoint",
                        url,
                        "--destination",
                        str(current),
                        "--merge",
                        "--json",
                        input_text=f"{CHECKPOINT_KEY}\n",
                    ).stdout
                )

            self.assertEqual(merged["addedFiles"], 0)
            self.assertEqual(merged["conflictedFiles"], 1)
            self.assertFalse((outside / "new.py").exists())
            self.assertEqual(
                (Path(merged["incomingRoot"]) / "src" / "new.py").read_text(),
                "do not escape",
            )

    def test_restore_supports_legacy_format_v2_raw_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            plaintext = base / "legacy.tar.gz"
            encrypted = base / "legacy.relay"
            restored = base / "restored"
            content = b"legacy encrypted content"
            digest = hashlib.sha256(content).hexdigest()
            tree_material = f"README.md\0{digest}\n".encode()
            manifest = {
                "checkpointId": "cp_legacy01",
                "workspace": "legacy",
                "sourceAgent": "test",
                "files": [
                    {
                        "path": "README.md",
                        "sha256": f"sha256:{digest}",
                    }
                ],
                "exclusions": [],
                "treeHash": f"sha256:{hashlib.sha256(tree_material).hexdigest()}",
            }
            with tarfile.open(plaintext, "w:gz") as archive:
                for name, data in {
                    "README.md": content,
                    ".agent-checkpoint/manifest.json": json.dumps(manifest).encode(),
                    ".agent-checkpoint/HANDOFF.md": b"# Legacy handoff\n",
                }.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    member.mode = 0o600
                    archive.addfile(member, io.BytesIO(data))

            legacy_encrypt = """
const crypto = require("node:crypto");
const fs = require("node:fs");
const [input, output, checkpointId] = process.argv.slice(1);
const key = Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64url");
const nonce = crypto.randomBytes(12);
const header = Buffer.from(JSON.stringify({
  formatVersion: 2,
  cipher: "AES-256-GCM",
  checkpointId,
  nonce: nonce.toString("base64url"),
}));
const length = Buffer.alloc(4);
length.writeUInt32BE(header.length);
const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
cipher.setAAD(header);
const ciphertext = Buffer.concat([
  cipher.update(fs.readFileSync(input)),
  cipher.final(),
]);
fs.writeFileSync(output, Buffer.concat([
  Buffer.from("RELAYCP2\\n"),
  length,
  header,
  ciphertext,
  cipher.getAuthTag(),
]));
"""
            subprocess.run(
                [
                    "node",
                    "-e",
                    legacy_encrypt,
                    str(plaintext),
                    str(encrypted),
                    "cp_legacy01",
                ],
                input=f"{LEGACY_KEY}\n",
                text=True,
                check=True,
            )

            with archive_server(encrypted) as url:
                self.run_script(
                    RESTORE,
                    "--checkpoint",
                    url,
                    "--destination",
                    str(restored),
                    "--new-workspace",
                    input_text=f"{LEGACY_KEY}\n",
                )
            self.assertEqual((restored / "README.md").read_bytes(), content)

    def test_restore_rejects_tampered_ciphertext(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
            project.mkdir()
            (project / "README.md").write_text("authenticated content")
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(output),
                    "--json",
                input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            tampered = base / "tampered.relay"
            ciphertext = bytearray(Path(created["archive"]).read_bytes())
            ciphertext[-1] ^= 1
            tampered.write_bytes(ciphertext)
            with archive_server(tampered) as url:
                result = self.run_script(
                    RESTORE,
                    "--checkpoint",
                    url,
                    "--destination",
                    str(base / "restored"),
                    "--new-workspace",
                    check=False,
                    input_text=f"{CHECKPOINT_KEY}\n",
                )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("authentication failed", result.stderr.lower())
            self.assertFalse((base / "restored").exists())

    def test_share_url_restores_with_separately_entered_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
            restored = base / "restored"
            project.mkdir()
            (project / "README.md").write_text("portable encrypted content")
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(output),
                    "--json",
                input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            with archive_server(Path(created["archive"])) as base_url:
                result = self.run_script(
                    RESTORE,
                    "--checkpoint",
                    base_url,
                    "--destination",
                    str(restored),
                    "--new-workspace",
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                )
            restored_result = json.loads(result.stdout)
            self.assertNotIn("#relay-key", restored_result["downloadUrl"])
            self.assertFalse(restored_result["secretStored"])
            self.assertEqual(
                (restored / "README.md").read_text(),
                "portable encrypted content",
            )

    def test_restore_rejects_wrong_user_entered_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "README.md").write_text("private content")
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--json",
                input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            with archive_server(Path(created["archive"])) as url:
                result = self.run_script(
                    RESTORE,
                    "--checkpoint",
                    url,
                    "--destination",
                    str(base / "restored"),
                    "--new-workspace",
                    check=False,
                    input_text=f"{OTHER_KEY}\n",
                )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("authentication failed", result.stderr.lower())

    def test_restore_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            archive = base / "evil.tar.gz"
            with tarfile.open(archive, "w:gz") as handle:
                data = b"nope"
                member = tarfile.TarInfo("../escape.txt")
                member.size = len(data)
                handle.addfile(member, io.BytesIO(data))
            with archive_server(archive) as url:
                result = self.run_script(
                    RESTORE,
                    "--checkpoint",
                    url,
                    "--destination",
                    str(base / "restored"),
                    "--new-workspace",
                    check=False,
                )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((base / "escape.txt").exists())

    def test_restore_rejects_windows_unsafe_member_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            for index, unsafe_name in enumerate(
                ("CON", "file.", "file:stream", 'bad"name', "bad?name")
            ):
                with self.subTest(unsafe_name=unsafe_name):
                    archive = base / f"unsafe-{index}.tar.gz"
                    with tarfile.open(archive, "w:gz") as handle:
                        data = b"unsafe"
                        member = tarfile.TarInfo(unsafe_name)
                        member.size = len(data)
                        handle.addfile(member, io.BytesIO(data))
                    destination = base / f"restored-{index}"
                    with archive_server(archive) as url:
                        result = self.run_script(
                            RESTORE,
                            "--checkpoint",
                            url,
                            "--destination",
                            str(destination),
                            "--new-workspace",
                            check=False,
                        )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(destination.exists())

    def test_restore_rejects_case_insensitive_path_collisions(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            collision_sets = (
                ("Readme", "README"),
                ("foo", "FOO/bar"),
            )
            for index, names in enumerate(collision_sets):
                with self.subTest(names=names):
                    archive = base / f"collision-{index}.tar.gz"
                    with tarfile.open(archive, "w:gz") as handle:
                        for name in names:
                            data = name.encode("utf-8")
                            member = tarfile.TarInfo(name)
                            member.size = len(data)
                            handle.addfile(member, io.BytesIO(data))
                    destination = base / f"collision-restored-{index}"
                    with archive_server(archive) as url:
                        result = self.run_script(
                            RESTORE,
                            "--checkpoint",
                            url,
                            "--destination",
                            str(destination),
                            "--new-workspace",
                            check=False,
                        )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(destination.exists())

    def test_create_uploads_with_bearer_token(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
            project.mkdir()
            (project / "main.py").write_text("print('relay')")
            token = "rly_" + "a" * 64
            with upload_server(token) as (api_url, requests):
                result = self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(output),
                    "--label",
                    "handoff",
                    "--source-agent",
                    "codex",
                    "--agent-metadata",
                    "shared",
                    "--agent-name",
                    "Release Gardener",
                    "--agent-description",
                    "Hardened checkpoint uploads and verified the handoff.",
                    "--upload",
                    "--api-url",
                    api_url,
                    "--api-token",
                    token,
                    "--json",
                input_text=f"{CHECKPOINT_KEY}\n",
                )
            payload = json.loads(result.stdout)
            self.assertTrue(payload["uploaded"])
            self.assertEqual(payload["relay"]["checkpoint"]["id"], payload["checkpointId"])
            self.assertTrue(payload["relay"]["upload"]["apiVerified"])
            self.assertEqual(payload["relay"]["checkpoint"]["agentName"], "Release Gardener")
            initialized = json.loads(requests[0]["body"])
            self.assertEqual(initialized["agentMetadataMode"], "shared")
            self.assertEqual(initialized["agentName"], "Release Gardener")
            self.assertTrue(all(
                request["authorization"] == f"Bearer {token}"
                for request in requests
            ))
            self.assertEqual(requests[0]["path"], "/api/checkpoints/uploads")
            self.assertEqual(requests[-1]["method"], "GET")
            uploaded_body = b"".join(
                request["body"]
                for request in requests
                if request["method"] == "PUT"
            )
            self.assertIn(b"RELAYCP2\n", uploaded_body)
            self.assertNotIn(b"print('relay')", uploaded_body)
            self.assertNotIn(CHECKPOINT_KEY.encode(), uploaded_body)
            self.assertTrue(all(
                len(request["body"]) <= 1024 * 1024
                for request in requests
                if request["method"] == "PUT"
            ))
            self.assertFalse(payload["secretStored"])

    def test_publish_private_checkpoint_uses_passphrase_only_locally(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "main.py").write_text(
                "print('safe public workspace')",
                encoding="utf-8",
            )
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "private"),
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            token = "rly_" + "e" * 64
            title = "Reviewed public handoff"
            description = "A sanitized workspace published for keyless restore."

            with publication_server(
                Path(created["archive"]),
                expected_token=token,
                checkpoint_id=created["checkpointId"],
                uppercase_checksum=True,
            ) as (api_url, requests):
                publication_process = self.run_script(
                    PUBLISH,
                    "--checkpoint",
                    created["checkpointId"],
                    "--public-title",
                    title,
                    "--public-description",
                    description,
                    "--api-url",
                    api_url,
                    "--api-token",
                    token,
                    "--yes",
                    "--json",
                    check=False,
                    input_text=f"{CHECKPOINT_KEY}\n",
                )
            self.assertEqual(
                publication_process.returncode,
                0,
                publication_process.stderr,
            )
            published = json.loads(publication_process.stdout)

            self.assertEqual(published["visibility"], "public")
            self.assertEqual(
                published["publication"],
                {"title": title, "description": description},
            )
            self.assertEqual(
                published["sourceCiphertextChecksum"],
                created["archiveSha256"],
            )
            self.assertFalse(published["secretStored"])
            self.assertFalse(published["secretSentToRelay"])
            self.assertEqual(
                published["marketplaceUrl"],
                (
                    f"{api_url}/marketplace?q="
                    f"{urllib.parse.quote(created['checkpointId'], safe='')}"
                ),
            )
            self.assertTrue(published["relay"]["marketplace"]["indexed"])
            self.assertEqual(published["publicFiles"], ["main.py"])
            self.assertEqual(
                published["publicManifestMetadata"]["publication"],
                {"title": title, "description": description},
            )
            self.assertNotIn(CHECKPOINT_KEY, json.dumps(published))

            initialized_request = next(
                request
                for request in requests
                if request["method"] == "POST"
                and request["path"] == "/api/checkpoints/uploads"
            )
            initialized = json.loads(initialized_request["body"])
            self.assertEqual(initialized["operation"], "publish-existing")
            self.assertEqual(initialized["publicTitle"], title)
            self.assertEqual(initialized["publicDescription"], description)
            self.assertEqual(
                initialized["sourceCiphertextChecksum"],
                created["archiveSha256"],
            )
            self.assertEqual(initialized["encryptionVersion"], 0)
            self.assertEqual(initialized["cipher"], "none")
            self.assertNotIn("key", " ".join(initialized).lower())

            public_bytes = b"".join(
                request["body"]
                for request in requests
                if request["method"] == "PUT"
            )
            self.assertTrue(public_bytes.startswith(b"\x1f\x8b"))
            self.assertNotIn(b"RELAYCP2\n", public_bytes)
            self.assertNotIn(CHECKPOINT_KEY.encode("utf-8"), public_bytes)
            with tarfile.open(fileobj=io.BytesIO(public_bytes), mode="r:gz") as archive:
                for member in archive.getmembers():
                    if not member.isfile():
                        continue
                    member_file = archive.extractfile(member)
                    self.assertIsNotNone(member_file)
                    self.assertNotIn(
                        CHECKPOINT_KEY.encode("utf-8"),
                        member_file.read(),
                    )
                restored_file = archive.extractfile("main.py")
                self.assertIsNotNone(restored_file)
                self.assertEqual(
                    restored_file.read(),
                    b"print('safe public workspace')",
                )
                manifest_file = archive.extractfile(
                    ".agent-checkpoint/manifest.json"
                )
                self.assertIsNotNone(manifest_file)
                manifest = json.load(manifest_file)
            self.assertEqual(manifest["visibility"], "public")
            self.assertEqual(
                manifest["publication"],
                {"title": title, "description": description},
            )
            for request in requests:
                self.assertNotIn(
                    CHECKPOINT_KEY,
                    str(request["path"]),
                )
                self.assertNotIn(
                    CHECKPOINT_KEY,
                    json.dumps(request["headers"]),
                )
                self.assertNotIn(
                    CHECKPOINT_KEY.encode("utf-8"),
                    request["body"],
                )

            with publication_server(
                Path(created["archive"]),
                expected_token=token,
                checkpoint_id=created["checkpointId"],
            ) as (api_url, wrong_key_requests):
                failed = self.run_script(
                    PUBLISH,
                    "--checkpoint",
                    created["checkpointId"],
                    "--public-title",
                    title,
                    "--public-description",
                    description,
                    "--api-url",
                    api_url,
                    "--api-token",
                    token,
                    "--yes",
                    "--json",
                    check=False,
                    input_text=f"{OTHER_KEY}\n",
                )
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("authentication failed", failed.stderr.lower())
            self.assertEqual(
                [request["method"] for request in wrong_key_requests],
                ["GET"],
            )

    def test_publish_blocks_literal_passphrase_before_upload(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "notes.txt").write_text(
                f"Local recovery phrase: {CHECKPOINT_KEY}",
                encoding="utf-8",
            )
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "private"),
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            token = "rly_" + "f" * 64

            with publication_server(
                Path(created["archive"]),
                expected_token=token,
                checkpoint_id=created["checkpointId"],
            ) as (api_url, requests):
                blocked = self.run_script(
                    PUBLISH,
                    "--checkpoint",
                    created["checkpointId"],
                    "--public-title",
                    "Reviewed handoff",
                    "--public-description",
                    "A workspace reviewed for public release.",
                    "--api-url",
                    api_url,
                    "--api-token",
                    token,
                    "--yes",
                    "--json",
                    check=False,
                    input_text=f"{CHECKPOINT_KEY}\n",
                )

            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn("passphrase", blocked.stderr.lower())
            self.assertNotIn(CHECKPOINT_KEY, blocked.stdout)
            self.assertNotIn(CHECKPOINT_KEY, blocked.stderr)
            self.assertEqual(
                [request["method"] for request in requests],
                ["GET"],
            )

    def test_publish_confirmation_lists_exact_public_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            (project / "nested").mkdir(parents=True)
            (project / "nested" / "main.py").write_text(
                "print('review me')",
                encoding="utf-8",
            )
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "private"),
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            token = "rly_" + "1" * 64

            with publication_server(
                Path(created["archive"]),
                expected_token=token,
                checkpoint_id=created["checkpointId"],
            ) as (api_url, _requests):
                published = self.run_script(
                    PUBLISH,
                    "--checkpoint",
                    created["checkpointId"],
                    "--public-title",
                    "Reviewed handoff",
                    "--public-description",
                    "A workspace reviewed for public release.",
                    "--api-url",
                    api_url,
                    "--api-token",
                    token,
                    input_text=f"{CHECKPOINT_KEY}\npublish\n",
                )

            self.assertIn("Files becoming readable (1):", published.stdout)
            self.assertIn("Public manifest metadata:", published.stdout)
            self.assertIn("  - nested/main.py", published.stdout)

    def test_publish_rejects_case_colliding_legacy_private_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            checkpoint_id = "cp_casecollision"
            plaintext = base / "legacy.tar.gz"
            encrypted = base / "legacy.relay"
            records = []
            contents = {
                "Readme": b"first",
                "README": b"second",
            }
            for path, data in contents.items():
                records.append(
                    {
                        "path": path,
                        "size": len(data),
                        "mode": 0o644,
                        "sha256": (
                            f"sha256:{hashlib.sha256(data).hexdigest()}"
                        ),
                    }
                )
            manifest = {
                "checkpointId": checkpoint_id,
                "files": records,
                "treeHash": "sha256:" + "0" * 64,
                "stacks": [],
                "git": {"isRepository": False},
            }
            with tarfile.open(plaintext, "w:gz") as archive:
                for name, data in {
                    **contents,
                    ".agent-checkpoint/manifest.json": json.dumps(
                        manifest
                    ).encode("utf-8"),
                    ".agent-checkpoint/HANDOFF.md": b"# Handoff\n",
                }.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    member.mode = 0o600
                    archive.addfile(member, io.BytesIO(data))

            sys.path.insert(0, str(SCRIPTS))
            try:
                from relay_crypto import encrypt_checkpoint
            finally:
                sys.path.remove(str(SCRIPTS))
            encrypt_checkpoint(
                plaintext,
                encrypted,
                checkpoint_id,
                CHECKPOINT_KEY.encode("utf-8"),
            )
            token = "rly_" + "3" * 64

            with publication_server(
                encrypted,
                expected_token=token,
                checkpoint_id=checkpoint_id,
            ) as (api_url, requests):
                blocked = self.run_script(
                    PUBLISH,
                    "--checkpoint",
                    checkpoint_id,
                    "--public-title",
                    "Reviewed handoff",
                    "--public-description",
                    "A workspace reviewed for public release.",
                    "--api-url",
                    api_url,
                    "--api-token",
                    token,
                    "--yes",
                    check=False,
                    input_text=f"{CHECKPOINT_KEY}\n",
                )

            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn("case-insensitive", blocked.stderr)
            self.assertEqual(
                [request["method"] for request in requests],
                ["GET"],
            )

    def test_existing_large_archive_retries_without_key_or_oversized_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "large.bin").write_bytes(os.urandom(4_800_000))
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            archive = Path(created["archive"])
            self.assertGreater(archive.stat().st_size, 4_500_000)
            token = "rly_" + "d" * 64
            with upload_server(token) as (api_url, requests):
                retried = json.loads(
                    self.run_script(
                        UPLOAD,
                        str(archive),
                        "--api-url",
                        api_url,
                        "--api-token",
                        token,
                        "--json",
                    ).stdout
                )
            put_requests = [item for item in requests if item["method"] == "PUT"]
            self.assertTrue(retried["uploaded"])
            self.assertFalse(retried["decryptionSecretRequired"])
            self.assertEqual(retried["agent"], created["agent"])
            retry_initialized = json.loads(requests[0]["body"])
            self.assertEqual(
                retry_initialized["agentName"],
                created["agent"]["name"],
            )
            self.assertEqual(
                retry_initialized["agentMetadataMode"],
                "pseudonymous",
            )
            self.assertGreater(len(put_requests), 4)
            self.assertTrue(all(len(item["body"]) <= 1024 * 1024 for item in put_requests))
            self.assertEqual(
                sum(len(item["body"]) for item in put_requests),
                archive.stat().st_size,
            )

    def test_create_share_returns_link_without_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "main.py").write_text("print('share')")
            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--json",
                input_text=f"{CHECKPOINT_KEY}\n",
                ).stdout
            )
            token = "rly_" + "b" * 64
            checkpoint_id = created["checkpointId"]
            with share_server(token) as (api_url, requests):
                result = self.run_script(
                    SHARE,
                    "--checkpoint",
                    checkpoint_id,
                    "--api-url",
                    api_url,
                    "--api-token",
                    token,
                    "--json",
                )
            payload = json.loads(result.stdout)
            self.assertNotIn("#", payload["url"])
            self.assertFalse(payload["containsEncryptionKey"])
            self.assertEqual(requests[0]["body"], b"")
            self.assertNotIn(CHECKPOINT_KEY, str(requests[0]))

    def test_delete_checkpoint_requires_exact_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            token = "rly_" + "e" * 64
            checkpoint_id = "cp_delete_example"
            with deletion_server(
                token,
                checkpoint_id,
                visibility="public",
            ) as (api_url, requests):
                cancelled = self.run_script(
                    DELETE,
                    "--checkpoint",
                    checkpoint_id,
                    "--api-url",
                    api_url,
                    "--api-token",
                    token,
                    check=False,
                    input_text="wrong-checkpoint\n",
                )
                self.assertNotEqual(cancelled.returncode, 0)
                self.assertIn("cancelled", cancelled.stderr)
                self.assertEqual([request["method"] for request in requests], ["GET"])

                deleted = self.run_script(
                    DELETE,
                    "--checkpoint",
                    checkpoint_id,
                    "--api-url",
                    api_url,
                    "--api-token",
                    token,
                    "--json",
                    input_text=f"{checkpoint_id}\n",
                )

            payload = json.loads(deleted.stdout)
            self.assertTrue(payload["deleted"])
            self.assertEqual(payload["visibility"], "public")
            self.assertNotIn("localKey", payload)
            self.assertFalse(payload["localArchivesRemoved"])
            self.assertEqual(
                [request["method"] for request in requests],
                ["GET", "GET", "DELETE"],
            )
            delete_request = requests[-1]
            self.assertEqual(
                json.loads(delete_request["body"]),
                {"confirmation": checkpoint_id},
            )
            self.assertEqual(
                delete_request["authorization"],
                f"Bearer {token}",
            )

    def test_device_login_stores_credential_and_upload_uses_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            project.mkdir()
            (project / "main.py").write_text("print('device auth')")
            credential_file = base / "credentials.json"
            token = "rly_" + "c" * 64
            environment = {"RELAY_CREDENTIALS_FILE": str(credential_file)}

            with device_upload_server(token) as (api_url, requests):
                login = self.run_script(
                    AUTH,
                    "login",
                    "--api-url",
                    api_url,
                    "--no-browser",
                    "--json",
                    env=environment,
                )
                login_payload = json.loads(login.stdout)
                self.assertTrue(login_payload["connected"])
                self.assertTrue(login_payload["remoteVerified"])
                self.assertNotIn(token, login.stdout)
                self.assertEqual(credential_file.stat().st_mode & 0o777, 0o600)

                status = self.run_script(
                    AUTH,
                    "status",
                    "--api-url",
                    api_url,
                    "--json",
                    env=environment,
                )
                status_payload = json.loads(status.stdout)
                self.assertTrue(status_payload["connected"])
                self.assertTrue(status_payload["remoteVerified"])
                self.assertEqual(status_payload["checkpointCount"], 0)

                created = self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(base / "out"),
                    "--upload",
                    "--api-url",
                    api_url,
                    "--json",
                input_text=f"{CHECKPOINT_KEY}\n",
                    env=environment,
                )
                self.assertTrue(json.loads(created.stdout)["uploaded"])

            paths = [request["path"] for request in requests]
            self.assertEqual(paths[:4], [
                "/api/device/authorize",
                "/api/device/token",
                "/api/agent/status",
                "/api/agent/status",
            ])
            self.assertEqual(paths[4], "/api/checkpoints/uploads")
            self.assertRegex(paths[5], r"/api/checkpoints/uploads/a{32}/parts/1")
            self.assertEqual(paths[6], f"/api/checkpoints/uploads/{'a' * 32}/complete")
            self.assertRegex(paths[7], r"/api/checkpoints/cp_[A-Za-z0-9_-]+")
            self.assertTrue(all(
                request["authorization"] == f"Bearer {token}"
                for request in requests[2:]
            ))


@contextmanager
def archive_server(
    archive: Path,
    agent: dict[str, str] | None = None,
    *,
    checkpoint_id: str | None = None,
    header_checkpoint_id: str | None = None,
    publication: dict[str, str] | None = None,
    uppercase_checksum: bool = False,
    send_checkpoint_id_header: bool = True,
):
    archive_bytes = archive.read_bytes()
    checksum = hashlib.sha256(archive_bytes).hexdigest()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            if publication:
                content_type = (
                    "application/vnd.relay.public-checkpoint+gzip"
                )
            else:
                content_type = (
                    "application/vnd.relay.checkpoint"
                    if archive_bytes.startswith(b"RELAYCP2\n")
                    else "application/gzip"
                )
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(archive_bytes)))
            checksum_header = (
                f"SHA256:{checksum.upper()}"
                if uppercase_checksum
                else f"sha256:{checksum}"
            )
            self.send_header("X-Checkpoint-Sha256", checksum_header)
            response_checkpoint_id = header_checkpoint_id or checkpoint_id
            if response_checkpoint_id and send_checkpoint_id_header:
                self.send_header("X-Checkpoint-Id", response_checkpoint_id)
            if publication:
                self.send_header("X-Checkpoint-Encryption", "0")
                self.send_header("X-Relay-Public-Format", "1")
                self.send_header(
                    "X-Relay-Public-Title",
                    urllib.parse.quote(publication["title"], safe=""),
                )
                self.send_header(
                    "X-Relay-Public-Description",
                    urllib.parse.quote(publication["description"], safe=""),
                )
            if agent:
                self.send_header(
                    "X-Relay-Agent-Name",
                    urllib.parse.quote(agent["name"], safe=""),
                )
                self.send_header(
                    "X-Relay-Agent-Description",
                    urllib.parse.quote(agent["description"], safe=""),
                )
                self.send_header("X-Relay-Agent-Metadata-Mode", agent["mode"])
            self.end_headers()
            self.wfile.write(archive_bytes)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        route = (
            f"/api/public/checkpoints/{checkpoint_id}/download"
            if publication and checkpoint_id
            else "/api/shared/test"
        )
        yield f"http://127.0.0.1:{server.server_port}{route}"
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


@contextmanager
def upload_server(expected_token: str):
    requests: list[dict[str, object]] = []
    upload: dict[str, object] = {}
    chunks: dict[int, bytes] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            self._record("POST", body)
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            if self.path == "/api/checkpoints/uploads":
                upload.update(json.loads(body))
                chunk_size = 1024 * 1024
                size = int(upload["sizeBytes"])
                self._json(
                    201,
                    {
                        "uploadId": "a" * 32,
                        "checkpointId": upload["checkpointId"],
                        "chunkSize": chunk_size,
                        "partCount": (size + chunk_size - 1) // chunk_size,
                        "sizeBytes": size,
                        "expiresAt": "2099-01-01T00:00:00.000Z",
                    },
                )
                return
            if self.path == f"/api/checkpoints/uploads/{'a' * 32}/complete":
                self._json(201, {"checkpoint": self._checkpoint()})
                return
            self._json(404, {"error": "not_found"})

        def do_PUT(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            self._record("PUT", body)
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            part_number = int(self.path.rsplit("/", 1)[-1])
            checksum = f"sha256:{hashlib.sha256(body).hexdigest()}"
            if self.headers.get("X-Chunk-Sha256") != checksum:
                self._json(400, {"error": "checksum"})
                return
            chunks[part_number] = body
            self._json(
                200,
                {
                    "partNumber": part_number,
                    "sizeBytes": len(body),
                    "checksum": checksum,
                    "etag": checksum[-32:],
                },
            )

        def do_GET(self):
            self._record("GET", b"")
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            checkpoint_id = str(upload.get("checkpointId", ""))
            if self.path == f"/api/checkpoints/{checkpoint_id}":
                self._json(200, {"checkpoint": self._checkpoint()})
                return
            self._json(404, {"error": "not_found"})

        def do_DELETE(self):
            self._record("DELETE", b"")
            self.send_response(204)
            self.end_headers()

        def _checkpoint(self):
            return {
                "id": upload["checkpointId"],
                "status": "ready",
                "checksum": upload["checksum"],
                "sizeBytes": upload["sizeBytes"],
                "agentName": upload["agentName"],
                "agentDescription": upload["agentDescription"],
                "agentMetadataMode": upload["agentMetadataMode"],
                "encryptionVersion": 2,
                "cipher": "AES-256-GCM",
            }

        def _authorized(self):
            return self.headers.get("Authorization") == f"Bearer {expected_token}"

        def _record(self, method: str, body: bytes):
            requests.append(
                {
                    "method": method,
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "body": body,
                }
            )

        def _json(self, status: int, payload: dict[str, object]):
            response = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


@contextmanager
def publication_server(
    private_archive: Path,
    *,
    expected_token: str,
    checkpoint_id: str,
    uppercase_checksum: bool = False,
):
    requests: list[dict[str, object]] = []
    private_bytes = private_archive.read_bytes()
    private_checksum = f"sha256:{hashlib.sha256(private_bytes).hexdigest()}"
    upload: dict[str, object] = {}
    chunks: dict[int, bytes] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self._record("GET", b"")
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            if self.path == f"/api/checkpoints/{checkpoint_id}/download":
                self.send_response(200)
                self.send_header(
                    "Content-Type",
                    "application/vnd.relay.checkpoint",
                )
                self.send_header("Content-Length", str(len(private_bytes)))
                self.send_header("X-Checkpoint-Id", checkpoint_id)
                self.send_header(
                    "X-Checkpoint-Sha256",
                    private_checksum.upper()
                    if uppercase_checksum
                    else private_checksum,
                )
                self.end_headers()
                self.wfile.write(private_bytes)
                return
            if self.path == f"/api/checkpoints/{checkpoint_id}":
                self._json(200, {"checkpoint": self._checkpoint()})
                return
            self._json(404, {"error": "not_found"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            self._record("POST", body)
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            if self.path == "/api/checkpoints/uploads":
                upload.update(json.loads(body))
                chunk_size = 1024 * 1024
                size = int(upload["sizeBytes"])
                self._json(
                    201,
                    {
                        "uploadId": "b" * 32,
                        "checkpointId": checkpoint_id,
                        "chunkSize": chunk_size,
                        "partCount": (size + chunk_size - 1) // chunk_size,
                        "sizeBytes": size,
                        "expiresAt": "2099-01-01T00:00:00.000Z",
                    },
                )
                return
            if self.path == f"/api/checkpoints/uploads/{'b' * 32}/complete":
                public_bytes = b"".join(
                    chunks[index] for index in sorted(chunks)
                )
                if len(public_bytes) != int(upload["sizeBytes"]):
                    self._json(400, {"error": "size"})
                    return
                actual_checksum = (
                    f"sha256:{hashlib.sha256(public_bytes).hexdigest()}"
                )
                if actual_checksum != upload["checksum"]:
                    self._json(400, {"error": "checksum"})
                    return
                self._json(201, {"checkpoint": self._checkpoint()})
                return
            self._json(404, {"error": "not_found"})

        def do_PUT(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            self._record("PUT", body)
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            part_number = int(self.path.rsplit("/", 1)[-1])
            checksum = f"sha256:{hashlib.sha256(body).hexdigest()}"
            if self.headers.get("X-Chunk-Sha256") != checksum:
                self._json(400, {"error": "checksum"})
                return
            chunks[part_number] = body
            self._json(
                200,
                {
                    "partNumber": part_number,
                    "sizeBytes": len(body),
                    "checksum": checksum,
                    "etag": checksum[-32:],
                },
            )

        def do_DELETE(self):
            self._record("DELETE", b"")
            self.send_response(204)
            self.end_headers()

        def _checkpoint(self):
            return {
                "id": checkpoint_id,
                "status": "ready",
                "checksum": private_checksum,
                "sizeBytes": len(private_bytes),
                "encryptionVersion": 2,
                "cipher": "AES-256-GCM",
                "visibility": "public",
                "marketplaceUrl": (
                    f"/marketplace?q={urllib.parse.quote(checkpoint_id, safe='')}"
                ),
                "publication": {
                    "title": upload["publicTitle"],
                    "description": upload["publicDescription"],
                    "checksum": upload["checksum"],
                    "sizeBytes": upload["sizeBytes"],
                    "formatVersion": upload["publicFormatVersion"],
                    "sourceCiphertextChecksum": upload[
                        "sourceCiphertextChecksum"
                    ],
                    "publishedAt": "2026-07-23T00:00:00.000Z",
                },
            }

        def _authorized(self):
            return self.headers.get("Authorization") == f"Bearer {expected_token}"

        def _record(self, method: str, body: bytes):
            requests.append(
                {
                    "method": method,
                    "path": self.path,
                    "headers": dict(self.headers.items()),
                    "body": body,
                }
            )

        def _json(self, status: int, payload: dict[str, object]):
            response = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


@contextmanager
def share_server(expected_token: str):
    requests: list[dict[str, object]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            requests.append(
                {
                    "authorization": self.headers.get("Authorization"),
                    "path": self.path,
                    "body": body,
                }
            )
            response = json.dumps(
                {
                    "url": (
                        f"http://127.0.0.1:{self.server.server_port}"
                        "/api/shared/0123456789abcdef0123456789abcdef"
                    ),
                    "expiresAt": "2026-07-27T00:00:00.000Z",
                }
            ).encode()
            self.send_response(
                200
                if self.headers.get("Authorization")
                == f"Bearer {expected_token}"
                else 401
            )
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


@contextmanager
def deletion_server(
    expected_token: str,
    checkpoint_id: str,
    *,
    visibility: str,
):
    requests: list[dict[str, object]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self._record("GET", b"")
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            self._json(
                200,
                {
                    "checkpoint": {
                        "id": checkpoint_id,
                        "visibility": visibility,
                        "label": "Deletion test checkpoint",
                    }
                },
            )

        def do_DELETE(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            self._record("DELETE", body)
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            if json.loads(body) != {"confirmation": checkpoint_id}:
                self._json(400, {"error": "confirmation"})
                return
            self._json(
                200,
                {
                    "deleted": True,
                    "checkpointId": checkpoint_id,
                    "visibility": visibility,
                    "deletedObjects": 1,
                    "publicCopiesWarning": (
                        "Previously downloaded or cached copies cannot be retracted."
                        if visibility == "public"
                        else None
                    ),
                },
            )

        def _authorized(self):
            return self.headers.get("Authorization") == f"Bearer {expected_token}"

        def _record(self, method: str, body: bytes):
            requests.append(
                {
                    "method": method,
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "body": body,
                }
            )

        def _json(self, status: int, payload: dict[str, object]):
            response = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


@contextmanager
def device_upload_server(expected_token: str):
    requests: list[dict[str, object]] = []
    upload: dict[str, object] = {}
    chunks: dict[int, bytes] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            self._record("POST", body)
            if self.path == "/api/device/authorize":
                response = {
                    "device_code": "rdc_" + "d" * 64,
                    "user_code": "ABCD-EFGH",
                    "verification_uri_complete": (
                        f"http://127.0.0.1:{self.server.server_port}"
                        "/device?code=ABCD-EFGH"
                    ),
                    "expires_in": 30,
                    "interval": 0,
                }
                self._json(201, response)
                return
            if self.path == "/api/device/token":
                self._json(
                    200,
                    {
                        "access_token": expected_token,
                        "token_type": "Bearer",
                        "expires_at": "2099-01-01T00:00:00.000Z",
                        "expires_in": 3600,
                        "scope": "checkpoints:read checkpoints:write checkpoints:share",
                    },
                )
                return
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            if self.path == "/api/checkpoints/uploads":
                upload.update(json.loads(body))
                chunk_size = 1024 * 1024
                size = int(upload["sizeBytes"])
                self._json(
                    201,
                    {
                        "uploadId": "a" * 32,
                        "checkpointId": upload["checkpointId"],
                        "chunkSize": chunk_size,
                        "partCount": (size + chunk_size - 1) // chunk_size,
                        "sizeBytes": size,
                        "expiresAt": "2099-01-01T00:00:00.000Z",
                    },
                )
                return
            if self.path == f"/api/checkpoints/uploads/{'a' * 32}/complete":
                self._json(201, {"checkpoint": self._checkpoint()})
                return
            self._json(404, {"error": "not_found"})

        def do_PUT(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            self._record("PUT", body)
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            part_number = int(self.path.rsplit("/", 1)[-1])
            checksum = f"sha256:{hashlib.sha256(body).hexdigest()}"
            if self.headers.get("X-Chunk-Sha256") != checksum:
                self._json(400, {"error": "checksum"})
                return
            chunks[part_number] = body
            self._json(
                200,
                {
                    "partNumber": part_number,
                    "sizeBytes": len(body),
                    "checksum": checksum,
                    "etag": checksum[-32:],
                },
            )

        def do_GET(self):
            self._record("GET", b"")
            if not self._authorized():
                self._json(401, {"error": "unauthorized"})
                return
            if self.path == "/api/agent/status":
                self._json(
                    200,
                    {
                        "connected": True,
                        "scopes": [
                            "checkpoints:read",
                            "checkpoints:write",
                            "checkpoints:share",
                        ],
                        "checkpointCount": 0,
                    },
                )
                return
            checkpoint_id = str(upload.get("checkpointId", ""))
            if self.path == f"/api/checkpoints/{checkpoint_id}":
                self._json(200, {"checkpoint": self._checkpoint()})
                return
            self._json(404, {"error": "not_found"})

        def do_DELETE(self):
            self._record("DELETE", b"")
            self.send_response(204)
            self.end_headers()

        def _checkpoint(self):
            return {
                "id": upload["checkpointId"],
                "status": "ready",
                "checksum": upload["checksum"],
                "sizeBytes": upload["sizeBytes"],
                "agentName": upload["agentName"],
                "agentDescription": upload["agentDescription"],
                "agentMetadataMode": upload["agentMetadataMode"],
                "encryptionVersion": 2,
                "cipher": "AES-256-GCM",
            }

        def _authorized(self):
            return self.headers.get("Authorization") == f"Bearer {expected_token}"

        def _record(self, method: str, body: bytes):
            requests.append(
                {
                    "method": method,
                    "path": self.path,
                    "authorization": self.headers.get("Authorization"),
                    "body": body,
                }
            )

        def _json(self, status: int, payload: dict[str, object]):
            response = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


if __name__ == "__main__":
    unittest.main()
