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
  assert.match(html, /<title>Relay — Install without login\. Sign in to upload\.<\/title>/i);
  assert.match(html, /Workspace continuity/);
  assert.match(html, /Connect skills/);
  assert.match(html, /Checkpoint registry/);
  assert.match(html, /Latest checkpoint/);
  assert.match(html, /Locally keyed checkpoint registry/);
  assert.match(html, /key generated or entered locally and never sent to Relay/);
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

test("uses ChatGPT as the only interactive sign-in provider", async () => {
  const pageSource = await readFile(
    new URL("../app/sign-in/page.tsx", import.meta.url),
    "utf8",
  );
  const buttonSource = await readFile(
    new URL("../app/sign-in/sign-in-buttons.tsx", import.meta.url),
    "utf8",
  );
  const authSources = `${pageSource}\n${buttonSource}`;

  assert.match(authSources, /Continue with ChatGPT/);
  assert.match(authSources, /\/signin-with-chatgpt\?return_to=/);
  assert.doesNotMatch(authSources, /Google|GitHub|signIn\.social/);
});

test("keeps skill installation public and gates only private backups", async () => {
  const pageSource = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );
  const landingSource = await readFile(
    new URL("../app/relay-landing.tsx", import.meta.url),
    "utf8",
  );
  const principalSource = await readFile(
    new URL("../lib/principal.ts", import.meta.url),
    "utf8",
  );

  assert.match(pageSource, /if \(!principal\) return <RelayLanding \/>/);
  assert.doesNotMatch(pageSource, /redirect\("\/sign-in"\)/);
  assert.match(landingSource, /Install without an account/);
  assert.match(landingSource, /Copy install prompt/);
  assert.match(landingSource, /relay-checkpoint-skills\.zip/);
  assert.match(landingSource, /Sign-in is required before the first upload/);
  assert.match(landingSource, /Login required/);
  assert.match(landingSource, /Only after approval does it upload/);
  assert.match(landingSource, /Do not sign in, connect an account/);
  assert.match(landingSource, /playful pseudonym/);
  assert.match(landingSource, /chosen agent profile/);
  assert.match(principalSource, /if \(!chatGPTUser && !useLocalPreview\) return null/);
  assert.ok(
    principalSource.indexOf("return null") <
      principalSource.indexOf("await prepareRelayStorage()"),
    "anonymous landing page should not depend on private checkpoint storage",
  );
});

test("agent-operated skill prompts are copy-ready", async () => {
  const source = await readFile(
    new URL("../app/relay-dashboard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Install Relay's checkpoint skills in this project\. No Relay sign-in is needed for installation/);
  assert.match(source, /relay-checkpoint-skills\.zip/);
  assert.match(source, /skillChecksumUrl = `\$\{skillBundleUrl\}\.sha256`/);
  assert.match(source, /Stop after installation\. Do not sign in, connect an account/);
  assert.match(source, /Use \$agent-workspace-checkpoint to create and upload/);
  assert.match(source, /Use \$restore-agent-workspace to download Relay checkpoint/);
  assert.match(source, /ask whether I want to merge it into the current agent workspace/);
  assert.match(source, /Do not default to either mode/);
  assert.match(source, /Run all commands yourself/);
  assert.match(source, /one-sentence summary of what this agent did/);
  assert.match(source, /playful pseudonym/);
  assert.doesNotMatch(source, /Download bundle|Device sign-in|Creation skill|Restore skill/);
  assert.doesNotMatch(source, /href=\{`\/api\/checkpoints\/\$\{checkpoint\.id\}\/download`\}/);
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

  const statusResponse = await fetch(`${origin}/api/agent/status`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.connected, true);
  assert.match(status.scopes.join(" "), /checkpoints:write/);

  const checkpointId = `cp_rendered_${Date.now()}`;
  const encryptedHeader = Buffer.from(JSON.stringify({
    formatVersion: 2,
    cipher: "AES-256-GCM",
    checkpointId,
    nonce: "A".repeat(16),
  }));
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(encryptedHeader.length);
  const encryptedArchive = Buffer.concat([
    Buffer.from("RELAYCP2\n"),
    headerLength,
    encryptedHeader,
    Buffer.alloc(2 * 1024 * 1024 + 123, 0x5a),
  ]);
  const archiveChecksum = `sha256:${createHash("sha256")
    .update(encryptedArchive)
    .digest("hex")}`;
  const initializeResponse = await fetch(`${origin}/api/checkpoints/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      checkpointId,
      checksum: archiveChecksum,
      encryptionVersion: 2,
      cipher: "AES-256-GCM",
      sizeBytes: encryptedArchive.length,
      agentName: "Release Gardener",
      agentDescription: "Hardened checkpoint uploads and verified the encrypted handoff.",
      agentMetadataMode: "shared",
    }),
  });
  assert.equal(initializeResponse.status, 201);
  const initialized = await initializeResponse.json();
  assert.equal(initialized.chunkSize, 1024 * 1024);
  assert.equal(initialized.partCount, 3);
  assert.deepEqual(initialized.agent, {
    name: "Release Gardener",
    description: "Hardened checkpoint uploads and verified the encrypted handoff.",
    mode: "shared",
  });

  for (let partNumber = 1; partNumber <= initialized.partCount; partNumber += 1) {
    const start = (partNumber - 1) * initialized.chunkSize;
    const part = encryptedArchive.subarray(
      start,
      Math.min(start + initialized.chunkSize, encryptedArchive.length),
    );
    const partChecksum = `sha256:${createHash("sha256").update(part).digest("hex")}`;
    const partResponse = await fetch(
      `${origin}/api/checkpoints/uploads/${initialized.uploadId}/parts/${partNumber}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/octet-stream",
          "x-chunk-sha256": partChecksum,
        },
        body: part,
      },
    );
    assert.equal(partResponse.status, 200);
    assert.equal((await partResponse.json()).checksum, partChecksum);
  }

  const completeResponse = await fetch(
    `${origin}/api/checkpoints/uploads/${initialized.uploadId}/complete`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}` },
    },
  );
  assert.equal(completeResponse.status, 201);
  const completed = await completeResponse.json();
  assert.equal(completed.checkpoint.id, checkpointId);
  assert.equal(completed.checkpoint.checksum, archiveChecksum);
  assert.equal(completed.checkpoint.agentName, "Release Gardener");
  assert.equal(completed.checkpoint.agentMetadataMode, "shared");

  const metadataResponse = await fetch(`${origin}/api/checkpoints/${checkpointId}`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.checkpoint.sizeBytes, encryptedArchive.length);
  assert.equal(metadata.checkpoint.checksum, archiveChecksum);
  assert.equal(metadata.checkpoint.agentName, "Release Gardener");
  assert.equal(
    metadata.checkpoint.agentDescription,
    "Hardened checkpoint uploads and verified the encrypted handoff.",
  );
  assert.equal(metadata.checkpoint.agentMetadataMode, "shared");

  const listResponse = await fetch(`${origin}/api/checkpoints`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  const listedCheckpoint = listed.checkpoints.find((item) => item.id === checkpointId);
  assert.equal(listedCheckpoint.agentName, "Release Gardener");
  assert.equal(listedCheckpoint.agentMetadataMode, "shared");

  const downloadResponse = await fetch(
    `${origin}/api/checkpoints/${checkpointId}/download`,
    { headers: { authorization: `Bearer ${token.access_token}` } },
  );
  assert.equal(downloadResponse.status, 200);
  const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
  assert.deepEqual(downloaded, encryptedArchive);
  assert.equal(downloadResponse.headers.get("x-checkpoint-sha256"), archiveChecksum);
  assert.equal(
    decodeURIComponent(downloadResponse.headers.get("x-relay-agent-name")),
    "Release Gardener",
  );
  assert.equal(downloadResponse.headers.get("x-relay-agent-metadata-mode"), "shared");

  const revokeResponse = await fetch(`${origin}/api/device/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(revokeResponse.status, 204);

  const revokedStatus = await fetch(`${origin}/api/agent/status`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(revokedStatus.status, 401);
});
