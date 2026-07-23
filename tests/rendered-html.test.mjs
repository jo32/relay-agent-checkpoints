import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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

function publicCheckpointArchive(
  checkpointId,
  title,
  description,
  additionalEntries = [],
) {
  const source = Buffer.from("public checkpoint content\n");
  const sourceDigest = createHash("sha256").update(source).digest("hex");
  const treeMaterial = Buffer.from(`README.md\0${sourceDigest}\n`);
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        formatVersion: 2,
        visibility: "public",
        checkpointId,
        createdAt: "2026-07-23T00:00:00.000Z",
        workspace: "Public workspace",
        root: ".",
        label: title,
        sourceAgent: "Rendered HTML test agent",
        baseSnapshot: null,
        treeHash: `sha256:${createHash("sha256").update(treeMaterial).digest("hex")}`,
        stacks: ["Test"],
        git: { isRepository: false },
        files: [
          {
            path: "README.md",
            size: source.length,
            mode: 0o644,
            sha256: `sha256:${sourceDigest}`,
          },
        ],
        exclusions: [],
        publication: { title, description },
      },
      null,
      2,
    )}\n`,
  );
  const handoff = Buffer.from(`# ${title}\n\n${description}\n`);
  const archive = Buffer.concat([
    tarEntry("././@PaxHeader", paxRecord("path", "README.md"), "x"),
    // Python's tarfile uses question marks in the legacy header when a PAX
    // path contains characters that cannot be represented there.
    tarEntry("README??.md", source),
    ...additionalEntries.flatMap(({ name, data, pax }) =>
      pax
        ? [
            tarEntry("././@PaxHeader", paxRecord("path", name), "x"),
            tarEntry("PaxPath", Buffer.from(data)),
          ]
        : [tarEntry(name, Buffer.from(data))],
    ),
    tarEntry(".agent-checkpoint/manifest.json", manifest),
    tarEntry(".agent-checkpoint/HANDOFF.md", handoff),
    Buffer.alloc(1024),
  ]);
  return gzipSync(archive, { level: 9 });
}

function tarEntry(name, data, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, data.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  const encodedChecksum = checksum.toString(8).padStart(6, "0");
  header.write(encodedChecksum, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 3;
  while (true) {
    const record = Buffer.from(`${length} ${body}`);
    if (record.length === length) return record;
    length = record.length;
  }
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function encryptedCheckpointArchive(checkpointId, payloadBytes = 4096) {
  const encryptedHeader = Buffer.from(JSON.stringify({
    formatVersion: 2,
    cipher: "AES-256-GCM",
    checkpointId,
    nonce: "A".repeat(16),
  }));
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(encryptedHeader.length);
  return Buffer.concat([
    Buffer.from("RELAYCP2\n"),
    headerLength,
    encryptedHeader,
    Buffer.alloc(payloadBytes, 0x5a),
  ]);
}

async function uploadCheckpointArchive(
  accessToken,
  metadata,
  archive,
  expectedCompletionStatus,
) {
  const initialized = await stageCheckpointArchive(
    accessToken,
    metadata,
    archive,
  );
  const completeResponse = await fetch(
    `${origin}/api/checkpoints/uploads/${initialized.uploadId}/complete`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (expectedCompletionStatus !== undefined) {
    assert.equal(completeResponse.status, expectedCompletionStatus);
    return {
      initialized,
      completionStatus: completeResponse.status,
      completed: await completeResponse.json(),
    };
  }
  assert.ok(
    completeResponse.status === 200 || completeResponse.status === 201,
    `upload completion failed (${completeResponse.status}): ${await completeResponse
      .clone()
      .text()}`,
  );
  return {
    initialized,
    completed: await completeResponse.json(),
  };
}

async function stageCheckpointArchive(accessToken, metadata, archive) {
  const initializeResponse = await fetch(`${origin}/api/checkpoints/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...metadata,
      checksum: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      sizeBytes: archive.length,
    }),
  });
  assert.equal(
    initializeResponse.status,
    201,
    `upload initialization failed: ${await initializeResponse.clone().text()}`,
  );
  const initialized = await initializeResponse.json();
  for (let partNumber = 1; partNumber <= initialized.partCount; partNumber += 1) {
    const start = (partNumber - 1) * initialized.chunkSize;
    const part = archive.subarray(
      start,
      Math.min(start + initialized.chunkSize, archive.length),
    );
    const partChecksum = `sha256:${createHash("sha256").update(part).digest("hex")}`;
    const partResponse = await fetch(
      `${origin}/api/checkpoints/uploads/${initialized.uploadId}/parts/${partNumber}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/octet-stream",
          "x-chunk-sha256": partChecksum,
        },
        body: part,
      },
    );
    assert.equal(partResponse.status, 200);
  }
  return initialized;
}

test("server-renders the Relay product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>Relay — Private or public checkpoints for agent workspaces\.<\/title>/i,
  );
  assert.match(html, /Workspace continuity/);
  assert.match(html, /Connect skills/);
  assert.match(html, /Checkpoint registry/);
  assert.match(html, /Latest checkpoint/);
  assert.doesNotMatch(html, /Private and public checkpoint registry/);
  assert.match(html, /Private checkpoints stay locally encrypted/);
  assert.match(html, /public checkpoints are separate, intentionally readable artifacts/i);
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

test("renders an anonymous public checkpoint marketplace", async () => {
  const response = await fetch(`${origin}/marketplace`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Public checkpoint marketplace/);
  assert.match(html, /Start from work/);
  assert.match(html, /What do you want to build on\?/);
  assert.match(html, /Recommended/);
  assert.match(html, /Public checkpoints/);
  assert.match(html, /No key or sign-in/);
  assert.match(html, /aria-label="Marketplace navigation"/);
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

test("leads with Relay's explicit private and public security boundary", async () => {
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
  assert.match(landingSource, /Private by default · public by choice/);
  assert.match(landingSource, /href="\/marketplace"/);
  assert.match(landingSource, /Private by default/);
  assert.match(landingSource, /private or public/);
  assert.match(landingSource, /Install Relay skills/);
  assert.match(landingSource, /relay-checkpoint-skills\.zip/);
  assert.match(landingSource, /Private checkpoints are sealed locally/);
  assert.match(landingSource, /Public is intentionally readable/);
  assert.match(landingSource, /AES-256-GCM/);
  assert.match(landingSource, /Recovery key stays local/);
  assert.match(landingSource, /Restore with proof/);
  assert.match(landingSource, /Publication is effectively irreversible/);
  assert.doesNotMatch(landingSource, /Install without login|Sign in to upload|Login required/);
  assert.match(landingSource, /Do not sign in, connect an account/);
  assert.match(landingSource, /approved\s+or pseudonymous agent metadata/);
  assert.match(landingSource, /Shared or pseudonymous, independently/);
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
  assert.match(source, /Install or update Relay's checkpoint skills in this project\. No Relay sign-in is needed for installation or updates/);
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
  assert.match(source, /checkpoint\.publication\?\.title \|\| checkpoint\.label/);
  assert.match(source, /return checkpoint\.publication\.description/);
  assert.match(source, /visibility-badge \$\{checkpoint\.visibility\}/);
  assert.match(source, /Shared" : "Pseudonym/);
  assert.match(source, /Make public/);
  assert.match(source, /Copy public URL/);
  assert.match(source, /Keyless restore/);
  assert.match(source, /Delete checkpoint/);
  assert.match(source, /Type <strong className="mono">\{checkpoint\.id\}<\/strong> to confirm/);
  assert.match(source, /downloaded or cached cannot be retracted/);
  assert.match(source, /\/api\/public\/checkpoints\/\$\{encodeURIComponent\(checkpoint\.id\)\}\/download/);
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
  const privateAuthorizationResponse = await fetch(
    `${origin}/api/device/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Private-only test agent" }),
    },
  );
  assert.equal(privateAuthorizationResponse.status, 201);
  const privateAuthorization = await privateAuthorizationResponse.json();
  assert.match(privateAuthorization.scope, /checkpoints:write/);
  assert.doesNotMatch(privateAuthorization.scope, /checkpoints:publish/);
  assert.doesNotMatch(privateAuthorization.scope, /checkpoints:delete/);

  const invalidScopeResponse = await fetch(`${origin}/api/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Invalid scope test agent",
      scope: "checkpoints:read checkpoints:admin",
    }),
  });
  assert.equal(invalidScopeResponse.status, 400);
  assert.deepEqual(await invalidScopeResponse.json(), {
    error: "invalid_scope",
  });

  const authorizationResponse = await fetch(`${origin}/api/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Rendered HTML test agent",
      scope:
        "checkpoints:read checkpoints:write checkpoints:share checkpoints:publish checkpoints:delete",
    }),
  });
  assert.equal(authorizationResponse.status, 201);
  const authorization = await authorizationResponse.json();
  assert.match(authorization.device_code, /^rdc_[a-f0-9]{64}$/);
  assert.match(authorization.scope, /checkpoints:publish/);
  assert.match(authorization.scope, /checkpoints:delete/);
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
  assert.match(approvalHtml, /effectively irreversible/);
  assert.match(approvalHtml, /permanently deleting your Relay-hosted checkpoint/);

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
  assert.match(token.scope, /checkpoints:publish/);
  assert.match(token.scope, /checkpoints:delete/);

  const statusResponse = await fetch(`${origin}/api/agent/status`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.connected, true);
  assert.match(status.scopes.join(" "), /checkpoints:write/);
  assert.match(status.scopes.join(" "), /checkpoints:publish/);
  assert.match(status.scopes.join(" "), /checkpoints:delete/);

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

  const anonymousPrivateResponse = await fetch(
    `${origin}/api/public/checkpoints/${checkpointId}`,
  );
  assert.equal(anonymousPrivateResponse.status, 404);

  const directPublicId = `cp_public_${Date.now()}`;
  const directPublicTitle = "Public release checkpoint";
  const directPublicDescription =
    "A keyless public workspace checkpoint with approved publication metadata.";
  const directPublicArchive = publicCheckpointArchive(
    directPublicId,
    directPublicTitle,
    directPublicDescription,
  );
  const directPublic = await uploadCheckpointArchive(
    token.access_token,
    {
      operation: "create-public",
      checkpointId: directPublicId,
      encryptionVersion: 0,
      cipher: "none",
      publicFormatVersion: 1,
      publicTitle: directPublicTitle,
      publicDescription: directPublicDescription,
      agentName: "Release Gardener",
      agentDescription:
        "Published a sanitized checkpoint with metadata and verified keyless restore.",
      agentMetadataMode: "shared",
    },
    directPublicArchive,
  );
  assert.equal(directPublic.completed.checkpoint.visibility, "public");
  assert.equal(
    directPublic.completed.checkpoint.publication.title,
    directPublicTitle,
  );
  assert.equal(
    directPublic.completed.checkpoint.publication.description,
    directPublicDescription,
  );
  assert.equal(
    directPublic.completed.checkpoint.publication.sourceCiphertextChecksum,
    null,
  );
  assert.equal(
    directPublic.completed.checkpoint.marketplaceUrl,
    `/marketplace?q=${directPublicId}`,
  );

  const publicMetadataResponse = await fetch(
    `${origin}/api/public/checkpoints/${directPublicId}`,
  );
  assert.equal(publicMetadataResponse.status, 200);
  const publicMetadata = await publicMetadataResponse.json();
  assert.equal(publicMetadata.checkpoint.visibility, "public");
  assert.equal(publicMetadata.checkpoint.agent.name, "Release Gardener");
  assert.equal(publicMetadata.checkpoint.agent.metadataMode, "shared");
  assert.equal(publicMetadata.checkpoint.publication.title, directPublicTitle);
  assert.equal(
    publicMetadata.checkpoint.publication.description,
    directPublicDescription,
  );
  assert.deepEqual(
    Object.keys(publicMetadata.checkpoint).sort(),
    ["agent", "id", "marketplaceUrl", "publication", "visibility"],
  );
  assert.equal(
    publicMetadata.checkpoint.publication.sourceCiphertextChecksum,
    undefined,
  );
  assert.equal(
    publicMetadata.checkpoint.marketplaceUrl,
    `/marketplace?q=${directPublicId}`,
  );

  const marketplaceSearchResponse = await fetch(
    `${origin}/api/public/checkpoints?q=release&sort=recommended&limit=12`,
  );
  assert.equal(marketplaceSearchResponse.status, 200);
  const marketplaceSearch = await marketplaceSearchResponse.json();
  const marketplaceItem = marketplaceSearch.checkpoints.find(
    (item) => item.id === directPublicId,
  );
  assert.ok(marketplaceItem);
  assert.equal(marketplaceItem.title, directPublicTitle);
  assert.equal(marketplaceItem.agent.name, "Release Gardener");
  assert.equal(marketplaceItem.agent.metadataMode, "shared");
  assert.equal(
    marketplaceItem.downloadUrl,
    `/api/public/checkpoints/${directPublicId}/download`,
  );
  assert.equal(
    marketplaceItem.marketplaceUrl,
    `/marketplace?q=${directPublicId}`,
  );
  assert.ok(
    marketplaceSearch.recommendations.some((item) => item.id === directPublicId),
  );
  assert.ok(
    marketplaceSearch.checkpoints.every((item) => item.id !== checkpointId),
    "private checkpoints must never enter the public marketplace index",
  );

  const marketplaceIdSearchResponse = await fetch(
    `${origin}/api/public/checkpoints?q=${encodeURIComponent(directPublicId)}`,
  );
  assert.equal(marketplaceIdSearchResponse.status, 200);
  const marketplaceIdSearch = await marketplaceIdSearchResponse.json();
  assert.deepEqual(
    marketplaceIdSearch.checkpoints.map((item) => item.id),
    [directPublicId],
  );

  const marketplaceListingResponse = await fetch(
    `${origin}/api/public/checkpoints?sort=latest&limit=48`,
  );
  assert.equal(marketplaceListingResponse.status, 200);
  const marketplaceListing = await marketplaceListingResponse.json();
  assert.ok(
    marketplaceListing.checkpoints.some((item) => item.id === directPublicId),
  );
  assert.ok(
    marketplaceListing.checkpoints.every((item) => item.id !== checkpointId),
    "private checkpoints must never enter the public marketplace index",
  );
  const publicDownloadResponse = await fetch(
    `${origin}/api/public/checkpoints/${directPublicId}/download`,
  );
  assert.equal(publicDownloadResponse.status, 200);
  assert.equal(
    publicDownloadResponse.headers.get("content-type"),
    "application/vnd.relay.public-checkpoint+gzip",
  );
  assert.match(
    publicDownloadResponse.headers.get("cache-control") ?? "",
    /public.*immutable/,
  );
  assert.equal(publicDownloadResponse.headers.get("x-relay-agent-name"), null);
  assert.deepEqual(
    Buffer.from(await publicDownloadResponse.arrayBuffer()),
    directPublicArchive,
  );
  const abortCompletedResponse = await fetch(
    `${origin}/api/checkpoints/uploads/${directPublic.initialized.uploadId}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${token.access_token}` },
    },
  );
  assert.equal(abortCompletedResponse.status, 409);
  const publicDownloadAfterAbort = await fetch(
    `${origin}/api/public/checkpoints/${directPublicId}/download`,
  );
  assert.equal(publicDownloadAfterAbort.status, 200);
  assert.deepEqual(
    Buffer.from(await publicDownloadAfterAbort.arrayBuffer()),
    directPublicArchive,
  );

  const mismatchedPublicId = `cp_public_mismatch_${Date.now()}`;
  const mismatchedPublic = await uploadCheckpointArchive(
    token.access_token,
    {
      operation: "create-public",
      checkpointId: mismatchedPublicId,
      encryptionVersion: 0,
      cipher: "none",
      publicFormatVersion: 1,
      publicTitle: "Different API title",
      publicDescription: directPublicDescription,
      agentName: "Release Gardener",
      agentDescription: "Attempted mismatched public metadata.",
      agentMetadataMode: "shared",
    },
    publicCheckpointArchive(
      mismatchedPublicId,
      "Embedded archive title",
      directPublicDescription,
    ),
    400,
  );
  assert.match(
    mismatchedPublic.completed.error,
    /valid gzip\/tar archive/,
  );
  const mismatchedAnonymous = await fetch(
    `${origin}/api/public/checkpoints/${mismatchedPublicId}`,
  );
  assert.equal(mismatchedAnonymous.status, 404);

  for (const [suffix, additionalEntries] of [
    ["windows-name", [{ name: "bad?name", data: "unsafe", pax: true }]],
    ["case-collision", [{ name: "readme.md", data: "collision", pax: true }]],
  ]) {
    const unsafePublicId = `cp_public_${suffix}_${Date.now()}`;
    const unsafeTitle = `Rejected ${suffix}`;
    const rejected = await uploadCheckpointArchive(
      token.access_token,
      {
        operation: "create-public",
        checkpointId: unsafePublicId,
        encryptionVersion: 0,
        cipher: "none",
        publicFormatVersion: 1,
        publicTitle: unsafeTitle,
        publicDescription: directPublicDescription,
        agentName: "Release Gardener",
        agentDescription: "Attempted an unsafe public archive path.",
        agentMetadataMode: "shared",
      },
      publicCheckpointArchive(
        unsafePublicId,
        unsafeTitle,
        directPublicDescription,
        additionalEntries,
      ),
      400,
    );
    assert.match(rejected.completed.error, /valid gzip\/tar archive/);
  }

  const promotedTitle = "Published encrypted checkpoint";
  const promotedDescription =
    "A locally decrypted and validated public representation with its original key kept off Relay.";
  const promotedArchive = publicCheckpointArchive(
    checkpointId,
    promotedTitle,
    promotedDescription,
  );
  const promoted = await uploadCheckpointArchive(
    token.access_token,
    {
      operation: "publish-existing",
      checkpointId,
      encryptionVersion: 0,
      cipher: "none",
      publicFormatVersion: 1,
      publicTitle: promotedTitle,
      publicDescription: promotedDescription,
      sourceCiphertextChecksum: archiveChecksum,
    },
    promotedArchive,
  );
  assert.equal(promoted.completed.checkpoint.visibility, "public");
  assert.equal(
    promoted.completed.checkpoint.publication.sourceCiphertextChecksum,
    archiveChecksum,
  );

  const promotedDownloadResponse = await fetch(
    `${origin}/api/public/checkpoints/${checkpointId}/download`,
  );
  assert.equal(promotedDownloadResponse.status, 200);
  assert.deepEqual(
    Buffer.from(await promotedDownloadResponse.arrayBuffer()),
    promotedArchive,
  );
  const promotedMetadataResponse = await fetch(
    `${origin}/api/public/checkpoints/${checkpointId}`,
  );
  assert.equal(promotedMetadataResponse.status, 200);
  const promotedMetadata = await promotedMetadataResponse.json();
  assert.equal(promotedMetadata.checkpoint.workspaceName, undefined);
  assert.equal(promotedMetadata.checkpoint.parentId, undefined);
  assert.equal(promotedMetadata.checkpoint.handoff, undefined);
  assert.equal(
    promotedMetadata.checkpoint.publication.sourceCiphertextChecksum,
    undefined,
  );
  const originalDownloadAfterPublish = await fetch(
    `${origin}/api/checkpoints/${checkpointId}/download`,
    { headers: { authorization: `Bearer ${token.access_token}` } },
  );
  assert.equal(originalDownloadAfterPublish.status, 200);
  assert.deepEqual(
    Buffer.from(await originalDownloadAfterPublish.arrayBuffer()),
    encryptedArchive,
  );

  const recoveredAfterCrashId = `cp_lease_recovery_${Date.now()}`;
  const recoveredAfterCrashArchive = encryptedCheckpointArchive(
    recoveredAfterCrashId,
  );
  const recoveredAfterCrashUpload = await stageCheckpointArchive(
    token.access_token,
    {
      checkpointId: recoveredAfterCrashId,
      encryptionVersion: 2,
      cipher: "AES-256-GCM",
      agentName: "Lease Recovery Agent",
      agentDescription:
        "Recovered an expired completion lease after an interrupted worker.",
      agentMetadataMode: "shared",
    },
    recoveredAfterCrashArchive,
  );
  const interruptedBeforeDurable = await fetch(
    `${origin}/api/checkpoints/uploads/${recoveredAfterCrashUpload.uploadId}/complete`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "x-relay-test-interrupt-completion": "before-durable",
      },
    },
  );
  assert.equal(interruptedBeforeDurable.status, 503);
  const interruptedBeforeDurableStatus = await fetch(
    `${origin}/api/checkpoints/uploads/${recoveredAfterCrashUpload.uploadId}`,
    { headers: { authorization: `Bearer ${token.access_token}` } },
  );
  assert.equal(interruptedBeforeDurableStatus.status, 200);
  assert.equal(
    (await interruptedBeforeDurableStatus.json()).status,
    "completing",
  );
  const recoveredCompletion = await fetch(
    `${origin}/api/checkpoints/uploads/${recoveredAfterCrashUpload.uploadId}/complete`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}` },
    },
  );
  assert.equal(recoveredCompletion.status, 201);
  assert.equal(
    (await recoveredCompletion.json()).checkpoint.id,
    recoveredAfterCrashId,
  );

  const durableCrashId = `cp_lease_durable_${Date.now()}`;
  const durableCrashArchive = encryptedCheckpointArchive(durableCrashId);
  const durableCrashUpload = await stageCheckpointArchive(
    token.access_token,
    {
      checkpointId: durableCrashId,
      encryptionVersion: 2,
      cipher: "AES-256-GCM",
      agentName: "Durable Lease Agent",
      agentDescription:
        "Verified durable state before cleaning an interrupted completion.",
      agentMetadataMode: "shared",
    },
    durableCrashArchive,
  );
  const interruptedAfterDurable = await fetch(
    `${origin}/api/checkpoints/uploads/${durableCrashUpload.uploadId}/complete`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "x-relay-test-interrupt-completion": "after-durable",
      },
    },
  );
  assert.equal(interruptedAfterDurable.status, 503);
  const abortDurableCrash = await fetch(
    `${origin}/api/checkpoints/uploads/${durableCrashUpload.uploadId}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${token.access_token}` },
    },
  );
  assert.equal(abortDurableCrash.status, 409);
  const recoveredDurableCompletion = await fetch(
    `${origin}/api/checkpoints/uploads/${durableCrashUpload.uploadId}/complete`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}` },
    },
  );
  assert.equal(recoveredDurableCompletion.status, 200);
  assert.equal(
    (await recoveredDurableCompletion.json()).checkpoint.id,
    durableCrashId,
  );
  const durableCrashDownload = await fetch(
    `${origin}/api/checkpoints/${durableCrashId}/download`,
    { headers: { authorization: `Bearer ${token.access_token}` } },
  );
  assert.equal(durableCrashDownload.status, 200);
  assert.deepEqual(
    Buffer.from(await durableCrashDownload.arrayBuffer()),
    durableCrashArchive,
  );

  const abandonedCrashId = `cp_lease_abort_${Date.now()}`;
  const abandonedCrashArchive = encryptedCheckpointArchive(abandonedCrashId);
  const abandonedCrashUpload = await stageCheckpointArchive(
    token.access_token,
    {
      checkpointId: abandonedCrashId,
      encryptionVersion: 2,
      cipher: "AES-256-GCM",
      agentName: "Lease Cleanup Agent",
      agentDescription:
        "Cleaned an expired completion lease with no durable checkpoint.",
      agentMetadataMode: "shared",
    },
    abandonedCrashArchive,
  );
  const interruptedForAbort = await fetch(
    `${origin}/api/checkpoints/uploads/${abandonedCrashUpload.uploadId}/complete`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "x-relay-test-interrupt-completion": "before-durable-active",
      },
    },
  );
  assert.equal(interruptedForAbort.status, 503);
  const abortActiveCrash = await fetch(
    `${origin}/api/checkpoints/uploads/${abandonedCrashUpload.uploadId}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${token.access_token}` },
    },
  );
  assert.equal(abortActiveCrash.status, 409);
  assert.equal(abortActiveCrash.headers.get("retry-after"), "1");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const abortAbandonedCrash = await fetch(
    `${origin}/api/checkpoints/uploads/${abandonedCrashUpload.uploadId}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${token.access_token}` },
    },
  );
  assert.equal(abortAbandonedCrash.status, 204);
  const abandonedCrashStatus = await fetch(
    `${origin}/api/checkpoints/uploads/${abandonedCrashUpload.uploadId}`,
    { headers: { authorization: `Bearer ${token.access_token}` } },
  );
  assert.equal(abandonedCrashStatus.status, 404);
  const abandonedCrashCompletion = await fetch(
    `${origin}/api/checkpoints/uploads/${abandonedCrashUpload.uploadId}/complete`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token.access_token}` },
    },
  );
  assert.equal(abandonedCrashCompletion.status, 404);

  const mismatchedDelete = await fetch(
    `${origin}/api/checkpoints/${directPublicId}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ confirmation: checkpointId }),
    },
  );
  assert.equal(mismatchedDelete.status, 400);
  const publicStillAvailable = await fetch(
    `${origin}/api/public/checkpoints/${directPublicId}/download`,
  );
  assert.equal(publicStillAvailable.status, 200);

  const missingOriginBrowserDelete = await fetch(
    `${origin}/api/checkpoints/${durableCrashId}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: durableCrashId }),
    },
  );
  assert.equal(missingOriginBrowserDelete.status, 403);
  const browserDelete = await fetch(
    `${origin}/api/checkpoints/${durableCrashId}`,
    {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ confirmation: durableCrashId }),
    },
  );
  assert.equal(browserDelete.status, 200);
  assert.equal((await browserDelete.json()).visibility, "private");
  const browserDeletedDownload = await fetch(
    `${origin}/api/checkpoints/${durableCrashId}/download`,
    { headers: { authorization: `Bearer ${token.access_token}` } },
  );
  assert.equal(browserDeletedDownload.status, 404);

  const deleteResponse = await fetch(
    `${origin}/api/checkpoints/${directPublicId}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ confirmation: directPublicId }),
    },
  );
  assert.equal(deleteResponse.status, 200);
  const deletion = await deleteResponse.json();
  assert.equal(deletion.deleted, true);
  assert.equal(deletion.checkpointId, directPublicId);
  assert.equal(deletion.visibility, "public");
  assert.match(deletion.publicCopiesWarning, /cannot be retracted/);

  const deletedOwnerMetadata = await fetch(
    `${origin}/api/checkpoints/${directPublicId}`,
    { headers: { authorization: `Bearer ${token.access_token}` } },
  );
  assert.equal(deletedOwnerMetadata.status, 404);
  const deletedPublicDownload = await fetch(
    `${origin}/api/public/checkpoints/${directPublicId}/download`,
  );
  assert.equal(deletedPublicDownload.status, 404);
  const marketplaceAfterDeleteResponse = await fetch(
    `${origin}/api/public/checkpoints?q=${encodeURIComponent(directPublicId)}`,
  );
  assert.equal(marketplaceAfterDeleteResponse.status, 200);
  const marketplaceAfterDelete = await marketplaceAfterDeleteResponse.json();
  assert.ok(
    marketplaceAfterDelete.checkpoints.every(
      (item) => item.id !== directPublicId,
    ),
  );

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
