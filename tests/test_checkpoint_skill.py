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
            and "--generate-key" not in script_args
            and "--prompt-key" not in script_args
        ):
            script_args.insert(0, "--prompt-key")
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
                    input_text=f"{CHECKPOINT_KEY}\n",
                )
            self.assertTrue((restored / "src" / "index.js").is_file())
            self.assertFalse((restored / ".env").exists())
            self.assertFalse((restored / "leaked.txt").exists())

    def test_create_generates_saved_key_without_terminal_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
            restored = base / "restored"
            key_directory = base / "keys"
            project.mkdir()
            (project / "README.md").write_text("generated key checkpoint")
            environment = {"RELAY_KEYS_DIR": str(key_directory)}

            created = json.loads(
                self.run_script(
                    CREATE,
                    "--root",
                    str(project),
                    "--output-dir",
                    str(output),
                    "--json",
                    env=environment,
                ).stdout
            )
            key_file = Path(created["keyFile"])
            generated_key = key_file.read_text(encoding="utf-8").strip()
            self.assertTrue(created["keyGenerated"])
            self.assertTrue(created["keyStored"])
            self.assertEqual(key_file.parent, key_directory.resolve())
            self.assertEqual(len(generated_key), 43)
            self.assertNotIn(generated_key, json.dumps(created))
            self.assertNotIn(generated_key.encode(), Path(created["archive"]).read_bytes())
            if os.name != "nt":
                self.assertEqual(key_directory.stat().st_mode & 0o777, 0o700)
                self.assertEqual(key_file.stat().st_mode & 0o777, 0o600)

            inspected = json.loads(
                self.run_script(
                    INSPECT,
                    "--verify",
                    "--json",
                    created["archive"],
                    env=environment,
                ).stdout
            )
            self.assertTrue(inspected["keyStored"])
            self.assertEqual(inspected["keyFile"], str(key_file))
            with archive_server(Path(created["archive"])) as url:
                restored_result = json.loads(
                    self.run_script(
                        RESTORE,
                        "--checkpoint",
                        url,
                        "--destination",
                        str(restored),
                        "--json",
                        env=environment,
                    ).stdout
                )
            self.assertTrue(restored_result["keyStored"])
            self.assertEqual((restored / "README.md").read_text(), "generated key checkpoint")

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

    def test_create_rejects_key_shorter_than_eight_characters(self):
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

    def test_create_accepts_user_key_once_without_confirmation(self):
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
            self.assertNotIn("Confirm checkpoint encryption key", result.stderr)

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
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                )
            self.assertEqual(json.loads(restored_result.stdout)["verifiedFiles"], 1)
            self.assertTrue(json.loads(restored_result.stdout)["encrypted"])
            self.assertEqual((restored / "README.md").read_text(), "hello checkpoint")

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
                    "--json",
                    input_text=f"{CHECKPOINT_KEY}\n",
                )
            restored_result = json.loads(result.stdout)
            self.assertNotIn("#relay-key", restored_result["downloadUrl"])
            self.assertFalse(restored_result["keyStored"])
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
                    check=False,
                )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((base / "escape.txt").exists())

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
            self.assertFalse(payload["keyStored"])

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
            self.assertFalse(retried["keyRequired"])
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
def archive_server(archive: Path):
    archive_bytes = archive.read_bytes()
    checksum = hashlib.sha256(archive_bytes).hexdigest()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            content_type = (
                "application/vnd.relay.checkpoint"
                if archive_bytes.startswith(b"RELAYCP2\n")
                else "application/gzip"
            )
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(archive_bytes)))
            self.send_header("X-Checkpoint-Sha256", f"sha256:{checksum}")
            self.end_headers()
            self.wfile.write(archive_bytes)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/api/shared/test"
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
