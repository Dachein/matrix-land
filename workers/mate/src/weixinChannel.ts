import { requireRuntimeMode, requireRuntimeScope, resolveRuntimePrincipal } from "./auth.ts";
import { loadRuntimeDefinition } from "./controlPlane.ts";
import { createConversation } from "./storage.ts";
import { RuntimeHttpError, type RuntimeEnv } from "./types.ts";
import { decryptWeixinValue, encryptWeixinValue, weixinIdentityHash } from "./weixinCrypto.ts";
import {
  pollWeixinQr,
  safeIlinkOrigin,
  startWeixinQr
} from "./weixinIlink.ts";

const QR_TTL_MS = 5 * 60_000;
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;

type QrRow = {
  binding_id: string | null;
  error_code: string | null;
  expires_at: number;
  id: string;
  org_id: string;
  polling_base_url: string;
  qr_ciphertext: string;
  qr_iv: string;
  qr_url: string;
  status: string;
  mate_id: string;
  user_id: string;
  verify_code_ciphertext: string | null;
  verify_code_iv: string | null;
};

type BindingRow = {
  active_conversation_id: string;
  bound_at: number;
  channel_account_hash: string;
  credentials_ciphertext: string;
  credentials_iv: string;
  external_subject_hash: string;
  id: string;
  last_used_at: number | null;
  org_id: string;
  status: "active" | "revoked";
  mate_id: string;
  user_id: string;
};

export type WeixinCredentials = {
  baseUrl: string;
  botId: string;
  cursor?: string;
  token: string;
  userId: string;
};

export type ActiveWeixinBinding = BindingRow & { credentials: WeixinCredentials };

export async function routeMateWeixinChannel(
  request: Request,
  env: RuntimeEnv
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/v1\/mates\/([^/]+)\/channels\/weixin(?:\/(authorize)(?:\/([^/]+)(?:\/(verify))?)?)?$/);
  if (!match?.[1]) return undefined;
  const mateId = decodeSegment(match[1]);
  const principal = await resolveRuntimePrincipal(request, env);
  requireRuntimeMode(principal, "live");
  requireRuntimeScope(principal, "mate:invoke");
  if (principal.callerKind !== "user") throw new RuntimeHttpError(403, "mate_weixin_user_caller_required");
  const definition = await loadRuntimeDefinition(env, principal, mateId, "live");
  assertConversationEnabled(definition.release.manifest as Record<string, any>);
  const now = Date.now();

  if (!match[2] && request.method === "GET") {
    const binding = await activeBindingForUser(env.RUNTIME_DB, mateId, principal.userId);
    return Response.json(binding ? bindingView(binding) : { state: "unbound" });
  }
  if (!match[2] && request.method === "DELETE") {
    const binding = await activeBindingForUser(env.RUNTIME_DB, mateId, principal.userId);
    if (binding) {
      await env.RUNTIME_DB.prepare(
        "UPDATE mate_weixin_bindings SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND status = 'active'"
      ).bind(now, now, binding.id).run();
      if (env.MATE_WEIXIN_GATEWAY) {
        const gateway = env.MATE_WEIXIN_GATEWAY.get(env.MATE_WEIXIN_GATEWAY.idFromName(binding.id));
        await gateway.stop(binding.id);
      }
    }
    return Response.json({ state: "unbound" });
  }
  if (match[2] === "authorize" && !match[3] && request.method === "POST") {
    await cleanupChannelState(env.RUNTIME_DB, now);
    const started = await startWeixinQr();
    const encrypted = await encryptWeixinValue(env, { qrcode: started.qrcode });
    const id = crypto.randomUUID();
    await env.RUNTIME_DB.prepare(`
      INSERT INTO mate_weixin_qr_sessions (
        id, mate_id, user_id, org_id, status, qr_url, qr_ciphertext, qr_iv,
        polling_base_url, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, mateId, principal.userId, principal.orgId, started.qrUrl,
      encrypted.ciphertext, encrypted.iv, started.baseUrl, now + QR_TTL_MS, now, now
    ).run();
    return Response.json(qrView({ expires_at: now + QR_TTL_MS, id, qr_url: started.qrUrl }, "pending"), { status: 201 });
  }

  const sessionId = match[3] ? safeId(match[3]) : "";
  if (match[2] === "authorize" && sessionId && match[4] === "verify" && request.method === "POST") {
    const row = await qrSessionForUser(env.RUNTIME_DB, sessionId, mateId, principal.userId);
    if (!row || row.expires_at <= now) throw new RuntimeHttpError(404, "mate_weixin_qr_session_not_found");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^\d{4,8}$/.test(code)) throw new RuntimeHttpError(400, "mate_weixin_verify_code_invalid");
    const encrypted = await encryptWeixinValue(env, { code });
    await env.RUNTIME_DB.prepare(`
      UPDATE mate_weixin_qr_sessions
      SET verify_code_ciphertext = ?, verify_code_iv = ?, status = 'scanned', updated_at = ?
      WHERE id = ? AND mate_id = ? AND user_id = ?
    `).bind(encrypted.ciphertext, encrypted.iv, now, sessionId, mateId, principal.userId).run();
    return Response.json({ state: "scanned" });
  }
  if (match[2] !== "authorize" || !sessionId || match[4] || request.method !== "GET") {
    throw new RuntimeHttpError(405, "mate_weixin_method_not_allowed");
  }
  const row = await qrSessionForUser(env.RUNTIME_DB, sessionId, mateId, principal.userId);
  if (!row) throw new RuntimeHttpError(404, "mate_weixin_qr_session_not_found");
  if (row.status === "confirmed" && row.binding_id) {
    const binding = await bindingById(env.RUNTIME_DB, row.binding_id);
    return Response.json(binding ? bindingView(binding) : { state: "unbound" });
  }
  if (row.expires_at <= now || row.status === "expired") {
    await updateQrStatus(env.RUNTIME_DB, sessionId, "expired", now);
    return Response.json({ state: "expired" });
  }
  if (row.status === "failed") return Response.json({ error: row.error_code || "mate_weixin_qr_failed", state: "failed" });
  const qr = await decryptWeixinValue<{ qrcode: string }>(env, { ciphertext: row.qr_ciphertext, iv: row.qr_iv });
  const verifyCode = row.verify_code_ciphertext && row.verify_code_iv
    ? (await decryptWeixinValue<{ code: string }>(env, {
      ciphertext: row.verify_code_ciphertext,
      iv: row.verify_code_iv
    })).code
    : undefined;
  const polled = await pollWeixinQr(qr.qrcode, row.polling_base_url, verifyCode);
  if (polled.status === "wait") return Response.json(qrView(row, "pending"));
  if (polled.status === "scaned") {
    await env.RUNTIME_DB.prepare(
      "UPDATE mate_weixin_qr_sessions SET status = 'scanned', verify_code_ciphertext = NULL, verify_code_iv = NULL, updated_at = ? WHERE id = ?"
    ).bind(now, sessionId).run();
    return Response.json(qrView(row, "scanned"));
  }
  if (polled.status === "need_verifycode") {
    await updateQrStatus(env.RUNTIME_DB, sessionId, "need_verify_code", now);
    return Response.json(qrView(row, "need_verify_code"));
  }
  if (polled.status === "scaned_but_redirect" && polled.redirect_host) {
    const baseUrl = safeIlinkOrigin(`https://${polled.redirect_host}`);
    await env.RUNTIME_DB.prepare(
      "UPDATE mate_weixin_qr_sessions SET status = 'scanned', polling_base_url = ?, updated_at = ? WHERE id = ?"
    ).bind(baseUrl, now, sessionId).run();
    return Response.json(qrView(row, "scanned"));
  }
  if (polled.status === "expired" || polled.status === "verify_code_blocked") {
    await updateQrStatus(env.RUNTIME_DB, sessionId, "expired", now, polled.status);
    return Response.json({ error: polled.status, state: "expired" });
  }
  if (polled.status === "binded_redirect") {
    await updateQrStatus(env.RUNTIME_DB, sessionId, "failed", now, "mate_weixin_account_already_connected");
    return Response.json({ error: "mate_weixin_account_already_connected", state: "failed" });
  }
  if (polled.status !== "confirmed") return Response.json(qrView(row, "pending"));

  const botId = polled.ilink_bot_id?.trim();
  const token = polled.bot_token?.trim();
  const weixinUserId = polled.ilink_user_id?.trim();
  if (!botId || !token || !weixinUserId) {
    await updateQrStatus(env.RUNTIME_DB, sessionId, "failed", now, "mate_weixin_confirmation_invalid");
    throw new RuntimeHttpError(502, "mate_weixin_confirmation_invalid");
  }
  const baseUrl = safeIlinkOrigin(polled.baseurl || row.polling_base_url);
  const bindingId = crypto.randomUUID();
  const conversation = await createConversation(env.RUNTIME_DB, mateId, principal, "live", {
    channel: "sdk",
    title: "微信对话"
  });
  const [accountHash, subjectHash, credentials] = await Promise.all([
    weixinIdentityHash(env, "account", botId),
    weixinIdentityHash(env, "subject", `${botId}\u0000${weixinUserId}`),
    encryptWeixinValue(env, { baseUrl, botId, token, userId: weixinUserId } satisfies WeixinCredentials)
  ]);
  await env.RUNTIME_DB.batch([
    env.RUNTIME_DB.prepare(`
      UPDATE mate_weixin_bindings SET status = 'revoked', revoked_at = ?, updated_at = ?
      WHERE status = 'active' AND ((mate_id = ? AND user_id = ?) OR external_subject_hash = ?)
    `).bind(now, now, mateId, principal.userId, subjectHash),
    env.RUNTIME_DB.prepare(`
      INSERT INTO mate_weixin_bindings (
        id, mate_id, user_id, org_id, channel_account_hash, external_subject_hash,
        credentials_ciphertext, credentials_iv, active_conversation_id, status, bound_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).bind(
      bindingId, mateId, principal.userId, principal.orgId, accountHash, subjectHash,
      credentials.ciphertext, credentials.iv, conversation.id, now, now
    ),
    env.RUNTIME_DB.prepare(`
      UPDATE mate_weixin_qr_sessions SET status = 'confirmed', binding_id = ?,
      verify_code_ciphertext = NULL, verify_code_iv = NULL, updated_at = ?
      WHERE id = ? AND mate_id = ? AND user_id = ?
    `).bind(bindingId, now, sessionId, mateId, principal.userId)
  ]);
  if (!env.MATE_WEIXIN_GATEWAY) throw new RuntimeHttpError(503, "mate_weixin_gateway_not_configured");
  const gateway = env.MATE_WEIXIN_GATEWAY.get(
    env.MATE_WEIXIN_GATEWAY.idFromName(bindingId),
    { locationHint: "apac" }
  );
  await gateway.start(bindingId);
  return Response.json(bindingView((await bindingById(env.RUNTIME_DB, bindingId))!));
}

export async function activeWeixinBinding(env: RuntimeEnv, bindingId: string) {
  const row = await bindingById(env.RUNTIME_DB, bindingId);
  if (!row || row.status !== "active") return undefined;
  const credentials = await decryptWeixinValue<WeixinCredentials>(env, {
    ciphertext: row.credentials_ciphertext,
    iv: row.credentials_iv
  });
  return { ...row, credentials } satisfies ActiveWeixinBinding;
}

export async function updateWeixinCursor(env: RuntimeEnv, binding: ActiveWeixinBinding, cursor: string) {
  const encrypted = await encryptWeixinValue(env, { ...binding.credentials, cursor });
  await env.RUNTIME_DB.prepare(`
    UPDATE mate_weixin_bindings SET credentials_ciphertext = ?, credentials_iv = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
  `).bind(encrypted.ciphertext, encrypted.iv, Date.now(), binding.id).run();
}

export async function rotateWeixinConversation(env: RuntimeEnv, binding: ActiveWeixinBinding, principal: Parameters<typeof createConversation>[2]) {
  const conversation = await createConversation(env.RUNTIME_DB, binding.mate_id, principal, "live", {
    channel: "sdk",
    title: "微信对话"
  });
  await env.RUNTIME_DB.prepare(`
    UPDATE mate_weixin_bindings SET active_conversation_id = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
  `).bind(conversation.id, Date.now(), binding.id).run();
  return String(conversation.id);
}

export async function beginWeixinMessage(env: RuntimeEnv, bindingId: string, externalMessageId: string, requestId: string) {
  const result = await env.RUNTIME_DB.prepare(`
    INSERT OR IGNORE INTO mate_weixin_message_receipts (
      binding_id, external_message_id, status, request_id, created_at
    ) VALUES (?, ?, 'processing', ?, ?)
  `).bind(bindingId, externalMessageId, requestId, Date.now()).run();
  return Number(result.meta.changes ?? 0) > 0;
}

export async function finishWeixinMessage(
  env: RuntimeEnv,
  bindingId: string,
  externalMessageId: string,
  status: "completed" | "failed" | "ignored",
  errorCode?: string
) {
  const now = Date.now();
  await env.RUNTIME_DB.batch([
    env.RUNTIME_DB.prepare(`
      UPDATE mate_weixin_message_receipts SET status = ?, error_code = ?, completed_at = ?
      WHERE binding_id = ? AND external_message_id = ?
    `).bind(status, errorCode ?? null, now, bindingId, externalMessageId),
    env.RUNTIME_DB.prepare("UPDATE mate_weixin_bindings SET last_used_at = ?, updated_at = ? WHERE id = ?")
      .bind(now, now, bindingId)
  ]);
}

function assertConversationEnabled(manifest: Record<string, any>) {
  if (manifest.channels?.embedded?.enabled !== true && manifest.channels?.standalone?.enabled !== true) {
    throw new RuntimeHttpError(403, "mate_chat_channel_disabled");
  }
}

async function activeBindingForUser(db: D1Database, mateId: string, userId: string) {
  return db.prepare(`
    SELECT * FROM mate_weixin_bindings
    WHERE mate_id = ? AND user_id = ? AND status = 'active' LIMIT 1
  `).bind(mateId, userId).first<BindingRow>();
}
async function bindingById(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM mate_weixin_bindings WHERE id = ? LIMIT 1").bind(id).first<BindingRow>();
}
async function qrSessionForUser(db: D1Database, id: string, mateId: string, userId: string) {
  return db.prepare(`
    SELECT * FROM mate_weixin_qr_sessions
    WHERE id = ? AND mate_id = ? AND user_id = ? LIMIT 1
  `).bind(id, mateId, userId).first<QrRow>();
}
async function updateQrStatus(db: D1Database, id: string, status: "need_verify_code" | "expired" | "failed", now: number, errorCode?: string) {
  await db.prepare("UPDATE mate_weixin_qr_sessions SET status = ?, error_code = ?, updated_at = ? WHERE id = ?")
    .bind(status, errorCode ?? null, now, id).run();
}
async function cleanupChannelState(db: D1Database, now: number) {
  await db.batch([
    db.prepare("DELETE FROM mate_weixin_qr_sessions WHERE expires_at < ?").bind(now - QR_TTL_MS),
    db.prepare("DELETE FROM mate_weixin_message_receipts WHERE created_at < ?").bind(now - RECEIPT_TTL_MS)
  ]);
}
function bindingView(binding: BindingRow) {
  return {
    bindingId: binding.id,
    boundAt: new Date(binding.bound_at).toISOString(),
    conversationId: binding.active_conversation_id,
    lastUsedAt: binding.last_used_at ? new Date(binding.last_used_at).toISOString() : undefined,
    state: binding.status === "active" ? "active" : "unbound"
  };
}
function qrView(row: Pick<QrRow, "expires_at" | "id" | "qr_url">, state: "pending" | "scanned" | "need_verify_code") {
  return { expiresAt: new Date(row.expires_at).toISOString(), qrContent: row.qr_url, sessionId: row.id, state };
}
function safeId(value: string) {
  const decoded = decodeSegment(value);
  if (!/^[0-9a-f-]{36}$/i.test(decoded)) throw new RuntimeHttpError(404, "mate_weixin_qr_session_not_found");
  return decoded;
}
function decodeSegment(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes("/") || decoded.length > 180) throw new Error();
    return decoded;
  } catch { throw new RuntimeHttpError(404, "runtime_route_not_found"); }
}
