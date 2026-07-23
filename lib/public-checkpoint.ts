export const PUBLIC_CHECKPOINT_CONTENT_TYPE =
  "application/vnd.relay.public-checkpoint+gzip";
export const PUBLIC_CHECKPOINT_FORMAT_VERSION = 1;
export const MAX_PUBLIC_TITLE_CHARACTERS = 120;
export const MAX_PUBLIC_DESCRIPTION_CHARACTERS = 1000;
export const MAX_PUBLIC_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
export const MAX_PUBLIC_ARCHIVE_ENTRIES = 100_000;
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export type PublicCheckpointMetadata = {
  publicTitle: string;
  publicDescription: string;
};

export type PublicCheckpointArchiveExpectation = {
  checkpointId: string;
  title: string;
  description: string;
};

export class PublicCheckpointError extends Error {}

export function resolvePublicCheckpointMetadata(input: {
  publicTitle?: unknown;
  publicDescription?: unknown;
}): PublicCheckpointMetadata {
  const publicTitle = cleanPublicText(
    input.publicTitle,
    MAX_PUBLIC_TITLE_CHARACTERS,
    "Public checkpoint title",
  );
  const publicDescription = cleanPublicText(
    input.publicDescription,
    MAX_PUBLIC_DESCRIPTION_CHARACTERS,
    "Public checkpoint description",
  );
  if (!publicTitle || !publicDescription) {
    throw new PublicCheckpointError(
      "Public checkpoints require both a public title and description.",
    );
  }
  return { publicTitle, publicDescription };
}

export function hasGzipHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
}

/**
 * Fully consumes and validates the gzip stream, then checks the decompressed
 * payload as a framed tar archive and binds its public manifest to the API
 * request. Project file contents remain the client's local secret-scan duty.
 */
export async function validatePublicCheckpointArchive(
  archive: ReadableStream<Uint8Array>,
  expectation?: PublicCheckpointArchiveExpectation,
): Promise<boolean> {
  let decompressed: ReadableStream<Uint8Array>;
  try {
    const gzip = new DecompressionStream(
      "gzip",
    ) as unknown as TransformStream<Uint8Array, Uint8Array>;
    decompressed = archive.pipeThrough(gzip);
  } catch {
    return false;
  }

  const reader = decompressed.getReader();
  const parser = new TarFramingValidator(expectation);
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!parser.push(result.value)) {
        await reader.cancel("Public checkpoint validation limit exceeded");
        return false;
      }
    }
    return parser.finish();
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

class TarFramingValidator {
  private static readonly MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
  private static readonly MAX_PAX_BYTES = 64 * 1024;
  private readonly block = new Uint8Array(512);
  private readonly manifestChunks: Uint8Array[] = [];
  private readonly paxChunks: Uint8Array[] = [];
  private blockLength = 0;
  private dataBlocksRemaining = 0;
  private manifestBytesRemaining = 0;
  private paxBytesRemaining = 0;
  private pendingPaxPath: string | undefined;
  private manifestSeen = false;
  private zeroBlocks = 0;
  private entryCount = 0;
  private ended = false;
  private totalBytes = 0;
  private invalid = false;
  private readonly windowsPaths = new Map<string, string>();

  constructor(
    private readonly expectation?: PublicCheckpointArchiveExpectation,
  ) {}

  push(bytes: Uint8Array): boolean {
    if (this.invalid) return false;
    if (bytes.length === 0) return true;
    this.totalBytes += bytes.length;
    if (this.totalBytes > MAX_PUBLIC_UNCOMPRESSED_BYTES) {
      this.invalid = true;
      return false;
    }

    let offset = 0;
    while (offset < bytes.length && !this.invalid) {
      const take = Math.min(512 - this.blockLength, bytes.length - offset);
      this.block.set(bytes.subarray(offset, offset + take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === 512) {
        this.consumeBlock();
        this.blockLength = 0;
      }
    }
    return !this.invalid;
  }

  finish() {
    return (
      !this.invalid &&
      this.blockLength === 0 &&
      this.dataBlocksRemaining === 0 &&
      this.paxBytesRemaining === 0 &&
      this.pendingPaxPath === undefined &&
      this.entryCount > 0 &&
      this.ended &&
      this.matchesExpectedManifest()
    );
  }

  private consumeBlock() {
    if (this.dataBlocksRemaining > 0) {
      if (this.manifestBytesRemaining > 0) {
        const take = Math.min(
          this.manifestBytesRemaining,
          this.block.length,
        );
        this.manifestChunks.push(this.block.slice(0, take));
        this.manifestBytesRemaining -= take;
      }
      if (this.paxBytesRemaining > 0) {
        const take = Math.min(this.paxBytesRemaining, this.block.length);
        this.paxChunks.push(this.block.slice(0, take));
        this.paxBytesRemaining -= take;
      }
      this.dataBlocksRemaining -= 1;
      if (this.dataBlocksRemaining === 0 && this.paxChunks.length > 0) {
        const pax = parsePaxRecords(this.paxChunks);
        this.paxChunks.length = 0;
        if (pax === null) {
          this.invalid = true;
          return;
        }
        this.pendingPaxPath = pax.path;
      }
      return;
    }

    if (isZeroBlock(this.block)) {
      this.zeroBlocks += 1;
      if (this.zeroBlocks >= 2) this.ended = true;
      return;
    }
    if (this.ended || this.zeroBlocks > 0 || !hasValidTarHeader(this.block)) {
      this.invalid = true;
      return;
    }

    const size = parseTarOctal(this.block.subarray(124, 136));
    if (size === null || size > MAX_PUBLIC_UNCOMPRESSED_BYTES) {
      this.invalid = true;
      return;
    }
    const name = tarString(this.block.subarray(0, 100));
    const prefix = tarString(this.block.subarray(345, 500));
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const type = this.block[156];
    if (type === "x".charCodeAt(0)) {
      if (
        size < 1 ||
        size > TarFramingValidator.MAX_PAX_BYTES ||
        this.paxChunks.length > 0 ||
        this.pendingPaxPath !== undefined
      ) {
        this.invalid = true;
        return;
      }
      this.paxBytesRemaining = size;
      this.entryCount += 1;
      if (this.entryCount > MAX_PUBLIC_ARCHIVE_ENTRIES) {
        this.invalid = true;
        return;
      }
      this.dataBlocksRemaining = Math.ceil(size / 512);
      return;
    }
    const path = this.pendingPaxPath ?? headerPath;
    this.pendingPaxPath = undefined;
    if (
      !isSafeTarPath(path) ||
      !recordWindowsPath(path, this.windowsPaths)
    ) {
      this.invalid = true;
      return;
    }
    this.manifestBytesRemaining = 0;
    if (
      this.expectation &&
      path === ".agent-checkpoint/manifest.json"
    ) {
      if (
        this.manifestSeen ||
        !isRegularTarType(type) ||
        size < 2 ||
        size > TarFramingValidator.MAX_MANIFEST_BYTES
      ) {
        this.invalid = true;
        return;
      }
      this.manifestSeen = true;
      this.manifestBytesRemaining = size;
    }
    this.entryCount += 1;
    if (this.entryCount > MAX_PUBLIC_ARCHIVE_ENTRIES) {
      this.invalid = true;
      return;
    }
    this.dataBlocksRemaining = Math.ceil(size / 512);
  }

  private matchesExpectedManifest() {
    if (!this.expectation) return true;
    if (
      !this.manifestSeen ||
      this.manifestBytesRemaining !== 0 ||
      this.manifestChunks.length === 0
    ) {
      return false;
    }
    const length = this.manifestChunks.reduce(
      (total, chunk) => total + chunk.length,
      0,
    );
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.manifestChunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      const manifest = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as Record<string, unknown>;
      const publication = manifest.publication;
      return (
        manifest.formatVersion === 2 &&
        manifest.visibility === "public" &&
        manifest.checkpointId === this.expectation.checkpointId &&
        manifest.label === this.expectation.title &&
        typeof publication === "object" &&
        publication !== null &&
        !Array.isArray(publication) &&
        (publication as Record<string, unknown>).title ===
          this.expectation.title &&
        (publication as Record<string, unknown>).description ===
          this.expectation.description
      );
    } catch {
      return false;
    }
  }
}

function hasValidTarHeader(header: Uint8Array) {
  const recordedChecksum = parseTarOctal(header.subarray(148, 156));
  if (recordedChecksum === null) return false;
  let checksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (checksum !== recordedChecksum) return false;

  const name = tarString(header.subarray(0, 100));
  const prefix = tarString(header.subarray(345, 500));
  const path = prefix ? `${prefix}/${name}` : name;
  if (!isSafeTarPath(path)) return false;
  const type = header[156];
  return (
    isRegularTarType(type) ||
    type === "5".charCodeAt(0) ||
    type === "x".charCodeAt(0)
  );
}

function isRegularTarType(type: number) {
  return type === 0 || type === "0".charCodeAt(0);
}

function isSafeTarPath(path: string) {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    /[<>"|?*]/.test(path) ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return false;
  }
  return !path.split("/").some((segment) => {
    const windowsBase = (segment.split(".", 1)[0] ?? "").toLowerCase();
    return (
      segment === ".." ||
      segment.includes(":") ||
      (segment !== "." && segment.endsWith(".")) ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED_NAMES.has(windowsBase)
    );
  });
}

function recordWindowsPath(path: string, paths: Map<string, string>) {
  const segments = path.split("/").filter((segment) => segment && segment !== ".");
  for (let length = 1; length <= segments.length; length += 1) {
    const exact = segments.slice(0, length).join("/");
    const folded = exact.normalize("NFC").toLowerCase();
    const previous = paths.get(folded);
    if (previous !== undefined && previous !== exact) return false;
    paths.set(folded, exact);
  }
  return true;
}

function parsePaxRecords(
  chunks: Uint8Array[],
): { path?: string } | null {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let writeOffset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  let offset = 0;
  let path: string | undefined;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (offset < bytes.length) {
      const space = bytes.indexOf(0x20, offset);
      if (space <= offset || space - offset > 10) return null;
      const lengthText = new TextDecoder("ascii", { fatal: true }).decode(
        bytes.subarray(offset, space),
      );
      if (!/^[1-9][0-9]*$/.test(lengthText)) return null;
      const recordLength = Number.parseInt(lengthText, 10);
      const recordEnd = offset + recordLength;
      if (
        !Number.isSafeInteger(recordLength) ||
        recordEnd > bytes.length ||
        recordEnd <= space + 2 ||
        bytes[recordEnd - 1] !== 0x0a
      ) {
        return null;
      }
      const payload = bytes.subarray(space + 1, recordEnd - 1);
      const equals = payload.indexOf(0x3d);
      if (equals <= 0) return null;
      const key = decoder.decode(payload.subarray(0, equals));
      const value = decoder.decode(payload.subarray(equals + 1));
      if (!/^[A-Za-z0-9_.]+$/.test(key)) return null;
      if (key === "path") {
        if (path !== undefined) return null;
        path = value;
      }
      offset = recordEnd;
    }
  } catch {
    return null;
  }
  return offset === bytes.length ? { path } : null;
}

function parseTarOctal(bytes: Uint8Array): number | null {
  const value = tarString(bytes).trim();
  if (!/^[0-7]+$/.test(value)) return value === "" ? 0 : null;
  const parsed = Number.parseInt(value, 8);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function tarString(bytes: Uint8Array) {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes);
}

function isZeroBlock(bytes: Uint8Array) {
  return bytes.every((byte) => byte === 0);
}

function cleanPublicText(
  value: unknown,
  maxCharacters: number,
  fieldName: string,
) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if ([...normalized].length > maxCharacters) {
    throw new PublicCheckpointError(
      `${fieldName} is limited to ${maxCharacters} characters.`,
    );
  }
  return normalized;
}
