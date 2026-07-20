import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";

const port = 4178;
const origin = `http://localhost:${port}`;
let server;
let serverOutput = "";

before(async () => {
  server = spawn("npm", ["run", "dev", "--", "--port", String(port)], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      BETTER_AUTH_SECRET:
        "relay-rendered-html-test-secret-is-at-least-32-characters",
      BETTER_AUTH_URL: origin,
      NO_COLOR: "1",
      RELAY_LOCAL_PREVIEW: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // Production server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start.\n${serverOutput}`);
});

after(() => {
  server?.kill("SIGTERM");
});

async function render() {
  return fetch(origin, { headers: { accept: "text/html" } });
}

test("server-renders the Relay product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Relay — Private agent checkpoints<\/title>/i);
  assert.match(html, /Workspace continuity/);
  assert.match(html, /Connect skills/);
  assert.match(html, /Checkpoint registry/);
  assert.match(html, /Latest checkpoint/);
  assert.match(html, /User-keyed checkpoint registry/);
  assert.match(html, /key you enter locally and Relay never stores/);
  assert.doesNotMatch(html, /Agent runners|Use runner|Start a handoff/);
  assert.doesNotMatch(html, /Keychain|Credential Locker|OS-held key|URL fragment/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("includes accessible product landmarks", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /<main[^>]*class="relay-main"/);
  assert.match(html, /<nav[^>]*aria-label="Primary"/);
  assert.match(html, /aria-label="Workspace overview"/);
  assert.match(html, /aria-label="Search checkpoints"/);
});

test("skill commands are copy-ready", async () => {
  const source = await readFile(
    new URL("../app/relay-dashboard.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\\n\+\s+--/);
  assert.match(source, /\\n\s+--root/);
  assert.match(source, /\\n\s+--checkpoint/);
});
