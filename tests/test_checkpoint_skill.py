from __future__ import annotations

import io
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
RESTORE = (
    ROOT
    / ".agents"
    / "skills"
    / "restore-agent-workspace"
    / "scripts"
    / "download_checkpoint.py"
)


class CheckpointSkillTests(unittest.TestCase):
    def run_script(self, script: Path, *args: str, check: bool = True):
        return subprocess.run(
            [sys.executable, str(script), *args],
            check=check,
            capture_output=True,
            text=True,
        )

    def test_create_excludes_secrets_and_inferred_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "project"
            output = base / "out"
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
            )
            payload = json.loads(result.stdout)
            archive = Path(payload["archive"])
            with tarfile.open(archive, "r:gz") as checkpoint:
                names = set(checkpoint.getnames())
                self.assertIn("src/index.js", names)
                self.assertIn(".agent-checkpoint/manifest.json", names)
                self.assertNotIn(".env", names)
                self.assertNotIn("leaked.txt", names)
                self.assertNotIn("node_modules/pkg/index.js", names)
                manifest = json.load(checkpoint.extractfile(".agent-checkpoint/manifest.json"))
                reasons = {item["path"]: item["reason"] for item in manifest["exclusions"]}
                self.assertEqual(reasons[".env"], "credential or secret file")
                self.assertEqual(reasons["leaked.txt"], "API key")

    def test_preserves_tracked_temporary_named_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            project = base / "repo"
            output = base / "out"
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
            )
            with tarfile.open(json.loads(result.stdout)["archive"], "r:gz") as checkpoint:
                self.assertIn("fixture.tmp", checkpoint.getnames())

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
                ).stdout
            )
            inspected = self.run_script(INSPECT, "--verify", "--json", created["archive"])
            self.assertEqual(json.loads(inspected.stdout)["errors"], [])
            with archive_server(Path(created["archive"])) as url:
                restored_result = self.run_script(
                    RESTORE,
                    "--checkpoint",
                    url,
                    "--destination",
                    str(restored),
                    "--json",
                )
            self.assertEqual(json.loads(restored_result.stdout)["verifiedFiles"], 1)
            self.assertEqual((restored / "README.md").read_text(), "hello checkpoint")

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
                )
            payload = json.loads(result.stdout)
            self.assertTrue(payload["uploaded"])
            self.assertEqual(payload["relay"]["checkpoint"]["id"], payload["checkpointId"])
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0]["authorization"], f"Bearer {token}")
            self.assertIn(b'name="archive"', requests[0]["body"])
            self.assertIn(b'name="sourceAgent"', requests[0]["body"])


@contextmanager
def archive_server(archive: Path):
    archive_bytes = archive.read_bytes()
    checksum = __import__("hashlib").sha256(archive_bytes).hexdigest()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
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


if __name__ == "__main__":
    unittest.main()
