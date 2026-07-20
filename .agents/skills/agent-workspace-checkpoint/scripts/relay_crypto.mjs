#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  appendFile,
  open,
  rm,
  stat,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("RELAYCP2\n", "ascii");
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MAX_HEADER_BYTES = 16 * 1024;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function readKey() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const encoded = Buffer.concat(chunks).toString("utf8").trim();
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) throw new Error("Checkpoint encryption key must be 32 bytes.");
  return key;
}

function makeHeader(checkpointId, nonce) {
  const header = Buffer.from(
    JSON.stringify({
      formatVersion: 2,
      cipher: "AES-256-GCM",
      checkpointId,
      nonce: nonce.toString("base64url"),
    }),
    "utf8",
  );
  if (header.length > MAX_HEADER_BYTES) throw new Error("Checkpoint header is too large.");
  return header;
}

function makePrefix(header) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([MAGIC, length, header]);
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("Encrypted checkpoint is truncated.");
  return buffer;
}

async function parseHeader(input) {
  const handle = await open(input, "r");
  try {
    const prefix = await readExactly(handle, MAGIC.length + 4, 0);
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("File is not a Relay encrypted checkpoint.");
    }
    const headerLength = prefix.readUInt32BE(MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
      throw new Error("Encrypted checkpoint header length is invalid.");
    }
    const headerBytes = await readExactly(handle, headerLength, MAGIC.length + 4);
    let header;
    try {
      header = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      throw new Error("Encrypted checkpoint header is invalid.");
    }
    if (
      header?.formatVersion !== 2 ||
      header?.cipher !== "AES-256-GCM" ||
      typeof header?.checkpointId !== "string" ||
      !/^cp_[a-z0-9_-]{6,80}$/i.test(header.checkpointId)
    ) {
      throw new Error("Encrypted checkpoint header is unsupported.");
    }
    const nonce = Buffer.from(String(header.nonce ?? ""), "base64url");
    if (nonce.length !== NONCE_BYTES) {
      throw new Error("Encrypted checkpoint nonce is invalid.");
    }
    return {
      header,
      headerBytes,
      nonce,
      bodyStart: MAGIC.length + 4 + headerLength,
    };
  } finally {
    await handle.close();
  }
}

async function encrypt(input, output, checkpointId) {
  if (!/^cp_[a-z0-9_-]{6,80}$/i.test(checkpointId)) {
    throw new Error("Checkpoint ID is invalid.");
  }
  const key = await readKey();
  const nonce = randomBytes(NONCE_BYTES);
  const header = makeHeader(checkpointId, nonce);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(header);

  const handle = await open(output, "wx", 0o600);
  try {
    await handle.write(makePrefix(header));
  } finally {
    await handle.close();
  }

  try {
    await pipeline(
      createReadStream(input),
      cipher,
      createWriteStream(output, { flags: "a", mode: 0o600 }),
    );
    await appendFile(output, cipher.getAuthTag());
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  }
}

async function decrypt(input, output) {
  const key = await readKey();
  const parsed = await parseHeader(input);
  const inputStat = await stat(input);
  const bodyEnd = inputStat.size - TAG_BYTES - 1;
  if (bodyEnd < parsed.bodyStart) throw new Error("Encrypted checkpoint has no ciphertext.");

  const handle = await open(input, "r");
  let tag;
  try {
    tag = await readExactly(handle, TAG_BYTES, inputStat.size - TAG_BYTES);
  } finally {
    await handle.close();
  }

  const decipher = createDecipheriv("aes-256-gcm", key, parsed.nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(parsed.headerBytes);
  decipher.setAuthTag(tag);

  try {
    await pipeline(
      createReadStream(input, { start: parsed.bodyStart, end: bodyEnd }),
      decipher,
      createWriteStream(output, { flags: "wx", mode: 0o600 }),
    );
  } catch {
    await rm(output, { force: true });
    throw new Error("Checkpoint authentication failed. The key is wrong or the file was changed.");
  }
}

async function main() {
  const [action, input, output, checkpointId] = process.argv.slice(2);
  if (action === "encrypt" && input && output && checkpointId) {
    await encrypt(input, output, checkpointId);
    return;
  }
  if (action === "decrypt" && input && output) {
    await decrypt(input, output);
    return;
  }
  throw new Error(
    "Usage: relay_crypto.mjs encrypt INPUT OUTPUT CHECKPOINT_ID | decrypt INPUT OUTPUT",
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Checkpoint cryptography failed.");
});
