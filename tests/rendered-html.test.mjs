import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  assert.match(source, /Install Relay's checkpoint skills in this project/);
  assert.match(source, /relay-checkpoint-skills\.zip/);
  assert.match(source, /skillChecksumUrl = `\$\{skillBundleUrl\}\.sha256`/);
  assert.match(source, /No API key is copied/);
  assert.match(source, /relay_auth\.py login/);
});

test("serves the downloadable skill bundle with a matching checksum", async () => {
  const bundleResponse = await fetch(`${origin}/skills/relay-checkpoint-skills.zip`);
  assert.equal(bundleResponse.status, 200);
  const bundle = Buffer.from(await bundleResponse.arrayBuffer());
  assert.equal(bundle.subarray(0, 2).toString(), "PK");

  const checksumResponse = await fetch(
    `${origin}/skills/relay-checkpoint-skills.zip.sha256`,
  );
  assert.equal(checksumResponse.status, 200);
  const expected = (await checksumResponse.text()).trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(bundle).digest("hex");
  assert.equal(actual, expected);
});

test("device authorization issues and revokes a scoped agent credential", async () => {
  const authorizationResponse = await fetch(`${origin}/api/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Rendered HTML test agent" }),
  });
  assert.equal(authorizationResponse.status, 201);
  const authorization = await authorizationResponse.json();
  assert.match(authorization.device_code, /^rdc_[a-f0-9]{64}$/);
  assert.match(authorization.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(
    authorization.verification_uri_complete,
    `${origin}/device?code=${authorization.user_code}`,
  );

  const pendingResponse = await fetch(`${origin}/api/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: authorization.device_code }),
  });
  assert.equal(pendingResponse.status, 400);
  assert.deepEqual(await pendingResponse.json(), { error: "authorization_pending" });

  const approvalPage = await fetch(authorization.verification_uri_complete);
  assert.equal(approvalPage.status, 200);
  const approvalHtml = await approvalPage.text();
  assert.match(approvalHtml, /Connect a local agent/);
  assert.match(approvalHtml, /Rendered HTML test agent/);
  assert.match(approvalHtml, new RegExp(authorization.user_code));

  const approvalResponse = await fetch(`${origin}/api/device/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify({
      user_code: authorization.user_code,
      decision: "approve",
    }),
  });
  assert.equal(approvalResponse.status, 200);
  assert.deepEqual(await approvalResponse.json(), { status: "approved" });

  const tokenResponse = await fetch(`${origin}/api/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: authorization.device_code }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  assert.match(token.access_token, /^rly_[a-f0-9]{64}$/);
  assert.equal(token.token_type, "Bearer");
  assert.match(token.scope, /checkpoints:write/);

  const authorizedUpload = await fetch(`${origin}/api/checkpoints`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(authorizedUpload.status, 400);

  const revokeResponse = await fetch(`${origin}/api/device/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(revokeResponse.status, 204);

  const revokedUpload = await fetch(`${origin}/api/checkpoints`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(revokedUpload.status, 401);
});
