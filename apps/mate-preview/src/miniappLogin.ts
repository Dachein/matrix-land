export type MiniappLoginTicket = {
  expiresAt: string;
  qrImageDataUrl: string;
  ticket: string;
};

export type MiniappLoginStatus = "pending" | "scanned" | "authenticated" | "expired";

export async function createMiniappLoginTicket(fetcher: typeof globalThis.fetch, signal?: AbortSignal): Promise<MiniappLoginTicket> {
  const response = await fetcher("/auth/miniapp/login-tickets", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: "{}",
    credentials: "same-origin",
    signal
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(response.status === 401 ? "miniapp_login_required" : "miniapp_qr_failed");
  if (
    typeof payload.ticket !== "string" || !/^[A-Za-z0-9_-]{20,80}$/.test(payload.ticket)
    || !isWechatMiniappCodeImage(payload.qrImageDataUrl)
    || typeof payload.expiresAt !== "string" || !Number.isFinite(Date.parse(payload.expiresAt))
  ) throw new Error("miniapp_qr_invalid");
  return {
    ticket: payload.ticket,
    qrImageDataUrl: payload.qrImageDataUrl,
    expiresAt: payload.expiresAt
  };
}

function isWechatMiniappCodeImage(value: unknown): value is string {
  return typeof value === "string"
    && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    && value.length <= 1_400_000;
}

export async function readMiniappLoginStatus(
  fetcher: typeof globalThis.fetch,
  ticket: string,
  signal?: AbortSignal
): Promise<MiniappLoginStatus> {
  const response = await fetcher(`/auth/miniapp/login-tickets/${encodeURIComponent(ticket)}/status`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    signal
  });
  if (!response.ok) throw new Error("miniapp_status_failed");
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (payload.status !== "pending" && payload.status !== "scanned" && payload.status !== "authenticated" && payload.status !== "expired") {
    throw new Error("miniapp_status_invalid");
  }
  return payload.status;
}
