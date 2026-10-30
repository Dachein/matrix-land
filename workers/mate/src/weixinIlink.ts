import { RuntimeHttpError } from "./types.ts";

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const CLIENT_VERSION = 0x00020406;

export type WeixinQrStatus = {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
};

export type WeixinMessage = {
  client_id?: string;
  context_token?: string;
  from_user_id?: string;
  group_id?: string;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
    voice_item?: { text?: string };
  }>;
  message_id?: number;
  message_type?: number;
};

export async function startWeixinQr(fetchImpl: typeof fetch = fetch) {
  const payload = await ilinkJson(fetchImpl, `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    body: JSON.stringify({ local_token_list: [] }),
    headers: authenticatedHeaders(),
    method: "POST"
  }, 15_000) as Record<string, unknown>;
  const qrcode = stringValue(payload.qrcode);
  const qrUrl = stringValue(payload.qrcode_img_content);
  if (!qrcode || !safeQrUrl(qrUrl)) throw new RuntimeHttpError(502, "weixin_qr_response_invalid");
  return { baseUrl: FIXED_BASE_URL, qrcode, qrUrl };
}

export async function pollWeixinQr(
  qrcode: string,
  baseUrl = FIXED_BASE_URL,
  verifyCode?: string,
  fetchImpl: typeof fetch = fetch
) {
  const query = new URLSearchParams({ qrcode });
  if (verifyCode) query.set("verify_code", verifyCode);
  return ilinkJson(
    fetchImpl,
    `${safeIlinkOrigin(baseUrl)}/ilink/bot/get_qrcode_status?${query.toString()}`,
    { headers: commonHeaders(), method: "GET" },
    32_000,
    true
  ) as Promise<WeixinQrStatus>;
}

export async function getWeixinUpdates(
  credentials: { baseUrl: string; token: string; cursor?: string },
  fetchImpl: typeof fetch = fetch
) {
  return ilinkJson(fetchImpl, `${safeIlinkOrigin(credentials.baseUrl)}/ilink/bot/getupdates`, {
    body: JSON.stringify({
      base_info: baseInfo(),
      get_updates_buf: credentials.cursor ?? ""
    }),
    headers: authenticatedHeaders(credentials.token),
    method: "POST"
  }, 28_000, true) as Promise<{
    errcode?: number;
    errmsg?: string;
    get_updates_buf?: string;
    longpolling_timeout_ms?: number;
    msgs?: WeixinMessage[];
    ret?: number;
  }>;
}

export async function sendWeixinText(
  credentials: { baseUrl: string; token: string },
  input: { contextToken?: string; text: string; to: string },
  fetchImpl: typeof fetch = fetch
) {
  const response = await ilinkJson(fetchImpl, `${safeIlinkOrigin(credentials.baseUrl)}/ilink/bot/sendmessage`, {
    body: JSON.stringify({
      base_info: baseInfo(),
      msg: {
        client_id: `workspace-mate-${crypto.randomUUID()}`,
        context_token: input.contextToken,
        from_user_id: "",
        item_list: [{ type: 1, text_item: { text: input.text.slice(0, 4000) } }],
        message_state: 2,
        message_type: 2,
        to_user_id: input.to
      }
    }),
    headers: authenticatedHeaders(credentials.token),
    method: "POST"
  }, 15_000) as Record<string, unknown>;
  if (Number(response.ret ?? 0) !== 0) throw new RuntimeHttpError(502, "weixin_message_send_failed");
}

export function safeIlinkOrigin(value: string | undefined) {
  try {
    const url = new URL(value?.trim() || FIXED_BASE_URL);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
      || (host !== "weixin.qq.com" && !host.endsWith(".weixin.qq.com"))
    ) throw new Error("invalid");
    return url.origin;
  } catch {
    throw new RuntimeHttpError(502, "weixin_api_origin_invalid");
  }
}

function safeQrUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (host === "weixin.qq.com" || host.endsWith(".weixin.qq.com"));
  } catch {
    return false;
  }
}

function baseInfo() {
  return { bot_agent: "WorkspaceMate/3.0", channel_version: "3.0" };
}

function commonHeaders() {
  return {
    "iLink-App-ClientVersion": String(CLIENT_VERSION),
    "iLink-App-Id": "bot"
  };
}

function authenticatedHeaders(token?: string) {
  const headers: Record<string, string> = {
    ...commonHeaders(),
    "AuthorizationType": "ilink_bot_token",
    "Content-Type": "application/json",
    "X-WECHAT-UIN": randomWechatUin()
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

async function ilinkJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutIsWait = false
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => undefined) as unknown;
    if (!response.ok || !payload || typeof payload !== "object") {
      throw new RuntimeHttpError(502, "weixin_api_unavailable");
    }
    return payload;
  } catch (error) {
    if (timeoutIsWait && error instanceof Error && error.name === "AbortError") {
      return { status: "wait", msgs: [], ret: 0 };
    }
    if (error instanceof RuntimeHttpError) throw error;
    throw new RuntimeHttpError(502, "weixin_api_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function randomWechatUin() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const decimal = String(new DataView(bytes.buffer).getUint32(0));
  let binary = "";
  new TextEncoder().encode(decimal).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
