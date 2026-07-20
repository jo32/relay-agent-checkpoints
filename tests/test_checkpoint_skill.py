from __future__ import annotations

import io
import base64
import hashlib
import json
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
RESTORE = (
    ROOT
    / ".agents"
    / "skills"
    / "restore-agent-workspace"
    / "scripts"
    / "download_checkpoint.py"
)
CHECKPOINT_KEY = base64.urlsafe_b64encode(bytes(range(32))).rstrip(b"=").decode()
OTHER_KEY = base64.urlsafe_b64encode(bytes(range(31, -1, -1))).rstrip(b"=").decode()


class CheckpointSkillTests(unittest.TestCase):
    def run_script(
        self,
        script: Path,
        *args: str,
        check: bool = True,
        input_text: str | None = None,
    ):
        return subprocess.run(
            [sys.executable, str(script), *args],
            check=check,
            capture_output=True,
            text=True,
            input=input_text,
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
                input_text=f"{CHECKPOINT_KEY}\n{CHECKPOINT_KEY}\n",
            )
            payload = json.loads(result.stdout)
            archive = Path(payload["archive"])
            self.assertEqual(archive.suffix, ".relay")
            self.assertEqual(archive.read_bytes()[:9], b"RELAYCP2\n")
            self.assertNotIn(CHECKPOINT_KEY, result.stdout)
            self.assertNotIn(CHECKPOINT_KEY.encode(), archive.read_bytes())
            self.assertNotIn(b"console.log('safe')", archive.read_bytes())
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

    def test_create_rejects_mismatched_key_confirmation(self):
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
                input_text=f"{CHECKPOINT_KEY}\n{OTHER_KEY}\n",
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("do not match", result.stderr)
            self.assertFalse(output.exists() and any(output.iterdir()))

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
                input_text=f"{CHECKPOINT_KEY}\n{CHECKPOINT_KEY}\n",
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
                    input_text=f"{CHECKPOINT_KEY}\n{CHECKPOINT_KEY}\n",
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
                    input_text=f"{CHECKPOINT_KEY}\n{CHECKPOINT_KEY}\n",
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
                    input_text=f"{CHECKPOINT_KEY}\n{CHECKPOINT_KEY}\n",
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
                    input_text=f"{CHECKPOINT_KEY}\n{CHECKPOINT_KEY}\n",
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
                    input_text=f"{CHECKPOINT_KEY}\n{CHECKPOINT_KEY}\n",
                )
            payload = json.loads(result.stdout)
            self.assertTrue(payload["uploaded"])
            self.assertEqual(payload["relay"]["checkpoint"]["id"], payload["checkpointId"])
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0]["authorization"], f"Bearer {token}")
            self.assertIn(b'name="archive"', requests[0]["body"])
            self.assertIn(b'name="encryptionVersion"', requests[0]["body"])
            self.assertIn(b"RELAYCP2\n", requests[0]["body"])
            self.assertNotIn(b'name="sourceAgent"', requests[0]["body"])
            self.assertNotIn(b'name="workspaceName"', requests[0]["body"])
            self.assertNotIn(b'name="handoff"', requests[0]["body"])
            self.assertNotIn(b"print('relay')", requests[0]["body"])
            self.assertNotIn(CHECKPOINT_KEY.encode(), requests[0]["body"])
            self.assertFalse(payload["keyStored"])

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
                    input_text=f"{CHECKPOINT_KEY}\n{CHECKPOINT_KEY}\n",
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

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            requests.append(
                {
                    "authorization": self.headers.get("Authorization"),
                    "body": body,
                }
            )
            marker = b'name="checkpointId"'
            marker_index = body.index(marker)
            value_start = body.index(b"\r\n\r\n", marker_index) + 4
            value_end = body.index(b"\r\n", value_start)
            checkpoint_id = body[value_start:value_end].decode()
            response = json.dumps(
                {"checkpoint": {"id": checkpoint_id, "status": "ready"}}
            ).encode()
            self.send_response(
                201
                if self.headers.get("Authorization") == f"Bearer {expected_token}"
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


if __name__ == "__main__":
    unittest.main()
