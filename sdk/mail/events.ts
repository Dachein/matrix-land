export const WORKSPACE_MAIL_EVENT_PATH = "/_workspace/mail/received";
export type WorkspaceMailEvent = {
  id: string;
  type: "workspace.mail.received";
  appId: string;
  messageId: string;
  mailbox: string;
  receivedAt: string;
};

/** Verify before parsing or using a callback. Persist event.id before acknowledging it. */
export async function verifyWorkspaceMailEvent(
  request: Request,
  options: { token: string; appId: string; now?: number },
): Promise<WorkspaceMailEvent> {
  if (!options.appId || request.method !== "POST" || !/^fmail_[a-f0-9]{64}$/.test(options.token)) throw new Error("mail_event_unauthorized");
  const signature = request.headers.get("x-workspace-mail-signature") || "";
  const match = /^t=(\d{10}),v1=([a-f0-9]{64})$/.exec(signature);
  if (!match || Math.abs((options.now ?? Date.now()) / 1000 - Number(match[1])) > 300) throw new Error("mail_event_unauthorized");
  if (Number(request.headers.get("content-length") || 0) > 16384) throw new Error("mail_event_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("mail_event_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error("mail_event_too_large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(options.token), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = new Uint8Array(match[2].match(/../g)!.map(value => parseInt(value, 16)));
  if (!await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(`${match[1]}.${raw}`))) throw new Error("mail_event_unauthorized");
  const event = JSON.parse(raw) as WorkspaceMailEvent;
  if (event.type !== "workspace.mail.received" || event.appId !== options.appId || !event.messageId?.startsWith("mail_") || event.id !== event.messageId || typeof event.mailbox !== "string" || !Number.isFinite(Date.parse(event.receivedAt))) throw new Error("mail_event_invalid");
  return event;
}

/** Return only after the event has been durably accepted; delivery is at least once. */
export function acknowledgeWorkspaceMailEvent(event: WorkspaceMailEvent): Response {
  return new Response(null, { status: 204, headers: { "x-workspace-mail-ack": event.id } });
}
