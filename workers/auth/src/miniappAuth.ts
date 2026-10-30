import { HttpError, type Env, type WorkspaceUser } from "./types.ts";

const DEFAULT_LOGIN_TTL_SECONDS = 120;
const WECHAT_API = "https://api.weixin.qq.com";

type WechatTokenResponse = { access_token?: string; errcode?: number; errmsg?: string; expires_in?: number };

/** Creates a one-time Workspace session transfer ticket. It is not a WeChat identity. */
export async function createMiniappLoginTicket(
  env: Env,
  user: WorkspaceUser,
  fetcher: typeof fetch = fetch,
  now = Date.now()
) {
  const config = miniappQrConfig(env);
  const ticket = randomTicket();
  const ticketHash = await sha256(ticket);
  const createdAt = Math.floor(now / 1_000);
  const expiresAt = createdAt + loginTtlSeconds(env);
  await env.AUTH_DB.prepare("DELETE FROM auth_miniapp_login_tickets WHERE expires_at <= ?").bind(createdAt).run();
  await env.AUTH_DB.prepare(`
    INSERT INTO auth_miniapp_login_tickets (
      ticket_hash, user_id, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, 'pending', ?, ?, ?)
  `).bind(ticketHash, user.id, expiresAt, createdAt, createdAt).run();

  try {
    const accessToken = await wechatAccessToken(config, fetcher);
    const qrResponse = await fetcher(`${WECHAT_API}/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(accessToken)}`, {
      body: JSON.stringify({
        check_path: false,
        env_version: miniappEnvVersion(env),
        page: "pages/login/index",
        scene: ticket,
        width: 430
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const bytes = new Uint8Array(await qrResponse.arrayBuffer());
    const contentType = qrResponse.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const validPng = contentType === "image/png" && bytes.length >= 8
      && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    const validJpeg = contentType === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216;
    if (!qrResponse.ok || (!validPng && !validJpeg) || bytes.length > 1_000_000) {
      const payload = safeJson(new TextDecoder().decode(bytes));
      throw new HttpError(502, "miniapp_login_qr_failed", String(payload.errmsg || "miniapp_login_qr_failed"));
    }
    return {
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
      qrImageDataUrl: `data:${contentType};base64,${bytesToBase64(bytes)}`,
      ticket
    };
  } catch (error) {
    await env.AUTH_DB.prepare("DELETE FROM auth_miniapp_login_tickets WHERE ticket_hash = ?").bind(ticketHash).run();
    throw error;
  }
}

/** Atomically consumes one ticket and resolves the Workspace user it represents. */
export async function exchangeMiniappLoginTicket(env: Env, ticketValue: unknown, now = Date.now()) {
  const ticket = bounded(ticketValue, 80, "miniapp_login_ticket_required");
  const ticketHash = await sha256(ticket);
  const timestamp = Math.floor(now / 1_000);
  const row = await env.AUTH_DB.prepare(`
    SELECT user_id AS userId, status, expires_at AS expiresAt, scanned_at AS scannedAt
    FROM auth_miniapp_login_tickets WHERE ticket_hash = ? LIMIT 1
  `).bind(ticketHash).first<{ expiresAt?: number; scannedAt?: number; status?: string; userId?: string }>();
  if (!row?.userId || row.status !== "pending" || !row.scannedAt || Number(row.expiresAt) <= timestamp) {
    throw new HttpError(410, "miniapp_login_ticket_expired");
  }
  const consumed = await env.AUTH_DB.prepare(`
    UPDATE auth_miniapp_login_tickets
    SET status = 'consumed', consumed_at = ?, updated_at = ?
    WHERE ticket_hash = ? AND status = 'pending' AND scanned_at IS NOT NULL AND expires_at > ?
  `).bind(timestamp, timestamp, ticketHash, timestamp).run();
  if (!Number(consumed.meta.changes)) throw new HttpError(409, "miniapp_login_ticket_consumed");
  return { ticketHash, userId: row.userId };
}

/** Marks the miniapp code as opened and resolves its Workspace identity. */
export async function prepareMiniappLoginTicket(env: Env, ticketValue: unknown, now = Date.now()) {
  const ticket = bounded(ticketValue, 80, "miniapp_login_ticket_required");
  const ticketHash = await sha256(ticket);
  const timestamp = Math.floor(now / 1_000);
  const row = await env.AUTH_DB.prepare(`
    SELECT user_id AS userId, status, expires_at AS expiresAt
    FROM auth_miniapp_login_tickets WHERE ticket_hash = ? LIMIT 1
  `).bind(ticketHash).first<{ expiresAt?: number; status?: string; userId?: string }>();
  if (!row?.userId || row.status !== "pending" || Number(row.expiresAt) <= timestamp) {
    throw new HttpError(410, "miniapp_login_ticket_expired");
  }
  await env.AUTH_DB.prepare(`
    UPDATE auth_miniapp_login_tickets SET scanned_at = COALESCE(scanned_at, ?), updated_at = ?
    WHERE ticket_hash = ? AND status = 'pending' AND expires_at > ?
  `).bind(timestamp, timestamp, ticketHash, timestamp).run();
  return { expiresAt: new Date(Number(row.expiresAt) * 1_000).toISOString(), userId: row.userId };
}

export async function readMiniappLoginTicketStatus(env: Env, userId: string, ticket: string, now = Date.now()) {
  const ticketHash = await sha256(bounded(ticket, 80, "miniapp_login_ticket_invalid"));
  const timestamp = Math.floor(now / 1_000);
  const row = await env.AUTH_DB.prepare(`
    SELECT status, scanned_at AS scannedAt, expires_at AS expiresAt FROM auth_miniapp_login_tickets
    WHERE ticket_hash = ? AND user_id = ? LIMIT 1
  `).bind(ticketHash, userId).first<{ expiresAt?: number; scannedAt?: number; status?: string }>();
  if (!row) throw new HttpError(404, "miniapp_login_ticket_not_found");
  const status = row.status === "consumed" ? "authenticated" : Number(row.expiresAt) <= timestamp ? "expired" : row.scannedAt ? "scanned" : "pending";
  return { expiresAt: new Date(Number(row.expiresAt) * 1_000).toISOString(), status };
}

function miniappQrConfig(env: Env) {
  const appId = env.WECHAT_MINIAPP_APP_ID?.trim();
  const secret = env.WECHAT_MINIAPP_APP_SECRET?.trim();
  if (!appId || !secret) throw new HttpError(503, "miniapp_login_qr_not_configured");
  return { appId, secret };
}

function safeJson(value: string): { errmsg?: string } {
  try { return JSON.parse(value) as { errmsg?: string }; } catch { return {}; }
}

async function wechatAccessToken(config: { appId: string; secret: string }, fetcher: typeof fetch) {
  const url = new URL(`${WECHAT_API}/cgi-bin/token`);
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", config.appId);
  url.searchParams.set("secret", config.secret);
  const response = await fetcher(url, { headers: { accept: "application/json" } });
  const payload = await response.json().catch(() => ({})) as WechatTokenResponse;
  if (!response.ok || !payload.access_token || payload.errcode) throw new HttpError(502, "miniapp_login_token_failed", payload.errmsg);
  return payload.access_token;
}

function miniappEnvVersion(env: Env) {
  const value = env.WECHAT_MINIAPP_ENV_VERSION?.trim();
  return value === "develop" || value === "release" ? value : "trial";
}
function loginTtlSeconds(env: Env) {
  const value = Number(env.MINIAPP_SCAN_LOGIN_TTL_SECONDS);
  return Number.isInteger(value) && value >= 60 && value <= 300 ? value : DEFAULT_LOGIN_TTL_SECONDS;
}
function bounded(value: unknown, max: number, code: string) { const text = typeof value === "string" ? value.trim() : ""; if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new HttpError(400, code); return text; }
function randomTicket() { const bytes = crypto.getRandomValues(new Uint8Array(18)); return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function sha256(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function bytesToBase64(bytes: Uint8Array) { let binary = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) { binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); } return btoa(binary); }
