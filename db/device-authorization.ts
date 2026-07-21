import {
  getRuntimeEnv,
  hashToken,
  issueApiToken,
} from "./checkpoints";
import { ensureRelaySchema } from "./identity";

const DEVICE_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type DeviceAuthorizationRow = {
  clientName: string;
  status: string;
  tenantId: string | null;
  userId: string | null;
  expiresAt: string;
};

export type DeviceExchangeResult =
  | {
      ok: true;
      accessToken: string;
      expiresAt: string;
      scopes: string;
    }
  | {
      ok: false;
      error:
        | "authorization_pending"
        | "access_denied"
        | "expired_token"
        | "invalid_grant";
    };

export async function createDeviceAuthorization(clientName: string) {
  const { DB } = getRuntimeEnv();
  await ensureRelaySchema(DB);
  const deviceCode = `rdc_${randomHex(32)}`;
  const userCode = createUserCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEVICE_TTL_MS).toISOString();
  await DB.batch([
    DB.prepare(
      "DELETE FROM device_authorizations WHERE expires_at < ?",
    ).bind(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()),
    DB.prepare(
      `INSERT INTO device_authorizations (
        device_code_hash, user_code_hash, client_name, status,
        tenant_id, user_id, created_at, expires_at, approved_at, consumed_at
      ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL, NULL)`,
    ).bind(
      await hashToken(deviceCode),
      await hashToken(normalizeUserCode(userCode)),
      clientName,
      now.toISOString(),
      expiresAt,
    ),
  ]);
  return {
    deviceCode,
    userCode,
    expiresAt,
    expiresIn: Math.floor(DEVICE_TTL_MS / 1000),
    interval: POLL_INTERVAL_SECONDS,
  };
}

export async function findDeviceAuthorization(userCode: string) {
  const normalized = normalizeUserCode(userCode);
  if (!/^[A-Z2-9]{8}$/.test(normalized)) return null;
  const { DB } = getRuntimeEnv();
  await ensureRelaySchema(DB);
  const record = await DB.prepare(
    `SELECT client_name AS clientName, status, expires_at AS expiresAt
    FROM device_authorizations
    WHERE user_code_hash = ?
    LIMIT 1`,
  )
    .bind(await hashToken(normalized))
    .first<Pick<DeviceAuthorizationRow, "clientName" | "status" | "expiresAt">>();
  if (!record) return null;
  return {
    ...record,
    userCode: formatUserCode(normalized),
    expired: record.expiresAt <= new Date().toISOString(),
  };
}

export async function decideDeviceAuthorization(
  userCode: string,
  decision: "approve" | "deny",
  tenantId: string,
  userId: string,
) {
  const normalized = normalizeUserCode(userCode);
  if (!/^[A-Z2-9]{8}$/.test(normalized)) return false;
  const { DB } = getRuntimeEnv();
  await ensureRelaySchema(DB);
  const now = new Date().toISOString();
  const result = await DB.prepare(
    `UPDATE device_authorizations
    SET status = ?, tenant_id = ?, user_id = ?, approved_at = ?
    WHERE user_code_hash = ?
      AND status = 'pending'
      AND expires_at > ?`,
  )
    .bind(
      decision === "approve" ? "approved" : "denied",
      tenantId,
      userId,
      now,
      await hashToken(normalized),
      now,
    )
    .run();
  return result.meta.changes > 0;
}

export async function exchangeDeviceCode(
  deviceCode: string,
): Promise<DeviceExchangeResult> {
  if (!/^rdc_[a-f0-9]{64}$/i.test(deviceCode)) {
    return { ok: false, error: "invalid_grant" };
  }
  const { DB } = getRuntimeEnv();
  await ensureRelaySchema(DB);
  const deviceCodeHash = await hashToken(deviceCode);
  const record = await DB.prepare(
    `SELECT
      client_name AS clientName,
      status,
      tenant_id AS tenantId,
      user_id AS userId,
      expires_at AS expiresAt
    FROM device_authorizations
    WHERE device_code_hash = ?
    LIMIT 1`,
  )
    .bind(deviceCodeHash)
    .first<DeviceAuthorizationRow>();
  if (!record) return { ok: false, error: "invalid_grant" };
  const now = new Date().toISOString();
  if (record.expiresAt <= now) {
    await DB.prepare(
      "UPDATE device_authorizations SET status = 'expired' WHERE device_code_hash = ?",
    )
      .bind(deviceCodeHash)
      .run();
    return { ok: false, error: "expired_token" };
  }
  if (record.status === "pending") {
    return { ok: false, error: "authorization_pending" };
  }
  if (record.status === "denied") {
    return { ok: false, error: "access_denied" };
  }
  if (record.status !== "approved" || !record.tenantId || !record.userId) {
    return { ok: false, error: "expired_token" };
  }

  const claimed = await DB.prepare(
    `UPDATE device_authorizations
    SET status = 'exchanging'
    WHERE device_code_hash = ? AND status = 'approved'`,
  )
    .bind(deviceCodeHash)
    .run();
  if (claimed.meta.changes === 0) {
    return { ok: false, error: "expired_token" };
  }

  try {
    const token = await issueApiToken(
      record.tenantId,
      record.userId,
      `Device sign-in: ${record.clientName}`,
    );
    await DB.prepare(
      `UPDATE device_authorizations
      SET status = 'consumed', consumed_at = ?
      WHERE device_code_hash = ?`,
    )
      .bind(now, deviceCodeHash)
      .run();
    return {
      ok: true,
      accessToken: token.token,
      expiresAt: token.expiresAt,
      scopes: token.scopes,
    };
  } catch (error) {
    await DB.prepare(
      `UPDATE device_authorizations
      SET status = 'approved'
      WHERE device_code_hash = ? AND status = 'exchanging'`,
    )
      .bind(deviceCodeHash)
      .run();
    throw error;
  }
}

export async function revokeAccessToken(token: string) {
  if (!/^rly_[a-f0-9]{64}$/i.test(token)) return;
  const { DB } = getRuntimeEnv();
  await ensureRelaySchema(DB);
  await DB.prepare(
    "UPDATE api_tokens SET revoked_at = ? WHERE token_hash = ?",
  )
    .bind(new Date().toISOString(), await hashToken(token))
    .run();
}

function createUserCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = [...bytes]
    .map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length])
    .join("");
  return formatUserCode(raw);
}

function normalizeUserCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatUserCode(value: string) {
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function randomHex(byteLength: number) {
  return [...crypto.getRandomValues(new Uint8Array(byteLength))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
