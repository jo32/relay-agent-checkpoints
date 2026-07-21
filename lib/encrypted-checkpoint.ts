export const ENCRYPTED_CHECKPOINT_MAGIC = new TextEncoder().encode("RELAYCP2\n");
export const MAX_ENCRYPTED_HEADER_BYTES = 16 * 1024;

export function hasValidEncryptedHeader(
  bytes: Uint8Array,
  checkpointId: string,
): boolean {
  const prefixLength = ENCRYPTED_CHECKPOINT_MAGIC.length + 4;
  if (bytes.length < prefixLength) return false;
  if (
    !ENCRYPTED_CHECKPOINT_MAGIC.every(
      (byte, index) => bytes[index] === byte,
    )
  ) {
    return false;
  }
  const headerLength = new DataView(
    bytes.buffer,
    bytes.byteOffset + ENCRYPTED_CHECKPOINT_MAGIC.length,
    4,
  ).getUint32(0);
  if (headerLength < 2 || headerLength > MAX_ENCRYPTED_HEADER_BYTES) {
    return false;
  }
  const headerEnd = prefixLength + headerLength;
  if (bytes.length < headerEnd) return false;
  try {
    const header = JSON.parse(
      new TextDecoder().decode(bytes.subarray(prefixLength, headerEnd)),
    ) as {
      formatVersion?: unknown;
      cipher?: unknown;
      checkpointId?: unknown;
      nonce?: unknown;
      kdf?: {
        name?: unknown;
        salt?: unknown;
        N?: unknown;
        r?: unknown;
        p?: unknown;
      };
    };
    const validKdf =
      header.kdf === undefined ||
      (header.kdf.name === "scrypt" &&
        typeof header.kdf.salt === "string" &&
        /^[A-Za-z0-9_-]{22}$/.test(header.kdf.salt) &&
        header.kdf.N === 131_072 &&
        header.kdf.r === 8 &&
        header.kdf.p === 1);
    return (
      header.formatVersion === 2 &&
      header.cipher === "AES-256-GCM" &&
      header.checkpointId === checkpointId &&
      typeof header.nonce === "string" &&
      /^[A-Za-z0-9_-]{16}$/.test(header.nonce) &&
      validKdf
    );
  } catch {
    return false;
  }
}
