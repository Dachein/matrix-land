export type MailAuthority = {
  userId: string;
  orgId: string;
  mateId?: string;
  appId?: string;
  scopes: string[];
  exp?: number;
};
export async function mailToken(secret: string, authority: MailAuthority) {
  if (secret.length < 32) throw new Error("workspace_mail_secret_not_configured");
  const payload = encode(
    JSON.stringify({
      ...authority,
      aud: "workspace-mail-worker",
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `${payload}.${encodeBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))))}`;
}
export async function verifyMailToken(
  secret: string,
  token: string,
): Promise<MailAuthority> {
  if (secret.length < 32) throw new Error("workspace_mail_secret_not_configured");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("mail_unauthorized");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBytes(signature),
      new TextEncoder().encode(payload),
    ))
  )
    throw new Error("mail_unauthorized");
  const value = JSON.parse(new TextDecoder().decode(decodeBytes(payload)));
  if (
    value.aud !== "workspace-mail-worker" ||
    !Number.isInteger(value.exp) ||
    value.exp <= Date.now() / 1000 ||
    value.exp > Date.now() / 1000 + 90 ||
    typeof value.userId !== "string" ||
    !value.userId ||
    typeof value.orgId !== "string" ||
    !value.orgId ||
    !Array.isArray(value.scopes) ||
    value.scopes.some((scope: unknown) => typeof scope !== "string")
  )
    throw new Error("mail_unauthorized");
  return value;
}
export async function workspaceMailRequest(
  env: { WORKSPACE_MAIL?: Fetcher; WORKSPACE_MAIL_SECRET?: string },
  authority: MailAuthority,
  path: string,
  body: unknown,
) {
  if (!env.WORKSPACE_MAIL) throw new Error("workspace_mail_service_not_configured");
  return env.WORKSPACE_MAIL.fetch(
    new Request(`https://workspace-mail.internal${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await mailToken(env.WORKSPACE_MAIL_SECRET || "", authority)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}
const encode = (value: string) => encodeBytes(new TextEncoder().encode(value));
function encodeBytes(bytes: Uint8Array) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decodeBytes(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}

/** The same typed SDK is used by trusted platform clients and app/local clients. */
export async function workspaceMailJson(
  env: Parameters<typeof workspaceMailRequest>[0],
  authority: MailAuthority,
  path: string,
  body: unknown,
) {
  const response = await workspaceMailRequest(env, authority, path, body);
  const result = (await response.json()) as any;
  if (!response.ok)
    throw new Error(result.error || "workspace_mail_request_failed");
  return result;
}
