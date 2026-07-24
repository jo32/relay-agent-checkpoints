#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import {
  appendFile,
  open,
  rm,
  stat,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const MAGIC = Buffer.from("RELAYCP2\n", "ascii");
const TAG_BYTES = 16;
const NONCE_BYTES = 12;
const MAX_HEADER_BYTES = 16 * 1024;
const KEY_BYTES = 32;
const KDF_NAME = "scrypt";
const KDF_SALT_BYTES = 16;
const KDF_N = 131_072;
const KDF_R = 8;
const KDF_P = 1;
const KDF_MAX_MEMORY = 256 * 1024 * 1024;
const scryptAsync = promisify(scrypt);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function readSecret() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const encoded = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Checkpoint passphrase transport is invalid.");
  }
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length === 0 || secret.toString("base64url") !== encoded) {
    throw new Error("Checkpoint passphrase transport is invalid.");
  }
  return secret;
}

async function deriveScryptKey(secret, salt) {
  return Buffer.from(
    await scryptAsync(secret, salt, KEY_BYTES, {
      N: KDF_N,
      r: KDF_R,
      p: KDF_P,
      maxmem: KDF_MAX_MEMORY,
    }),
  );
}

function decodeLegacyKey(secret) {
  const encoded = secret.toString("utf8");
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error(
      "This older checkpoint requires its original 43-character base64url key.",
    );
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== KEY_BYTES) {
    throw new Error("Legacy checkpoint recovery key is invalid.");
  }
  return key;
}

function makeHeader(checkpointId, nonce, salt) {
  const header = Buffer.from(
    JSON.stringify({
      formatVersion: 2,
      cipher: "AES-256-GCM",
      checkpointId,
      nonce: nonce.toString("base64url"),
      kdf: {
        name: KDF_NAME,
        salt: salt.toString("base64url"),
        N: KDF_N,
        r: KDF_R,
        p: KDF_P,
      },
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
    let kdf = null;
    if (header.kdf !== undefined) {
      const candidate = header.kdf;
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        Object.keys(candidate).sort().join(",") !== "N,name,p,r,salt" ||
        candidate.name !== KDF_NAME ||
        typeof candidate.salt !== "string" ||
        !/^[A-Za-z0-9_-]{22}$/.test(candidate.salt) ||
        candidate.N !== KDF_N ||
        candidate.r !== KDF_R ||
        candidate.p !== KDF_P
      ) {
        throw new Error("Encrypted checkpoint key derivation is unsupported.");
      }
      const salt = Buffer.from(candidate.salt, "base64url");
      if (salt.length !== KDF_SALT_BYTES) {
        throw new Error("Encrypted checkpoint key derivation salt is invalid.");
      }
      kdf = { salt };
    }
    return {
      header,
      headerBytes,
      nonce,
      kdf,
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
  const secret = await readSecret();
  const salt = randomBytes(KDF_SALT_BYTES);
  const key = await deriveScryptKey(secret, salt);
  const nonce = randomBytes(NONCE_BYTES);
  const header = makeHeader(checkpointId, nonce, salt);
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
  const parsed = await parseHeader(input);
  const secret = await readSecret();
  const key = parsed.kdf
    ? await deriveScryptKey(secret, parsed.kdf.salt)
    : decodeLegacyKey(secret);
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
    throw new Error("Checkpoint authentication failed. The passphrase or recovery key is wrong, or the file was changed.");
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
