import { base64UrlDecodeBytes, randomBase64Url } from "./crypto.ts";
import { readAuthUserByEmail } from "./repositories/users/reads.ts";
import { HttpError, type Env } from "./types.ts";
import { isEmailAllowedByInstallation, isEmailAllowedByPolicy, readAuthEmailPolicy } from "../../../src/shared/authEmailPolicy.ts";

// A challenge may precede an account. Keep its recipient encrypted and bind it
// to the challenge ID; neither the recipient nor a user record is a login proof.
async function recipientKey(env: Env) {
  const secret = env.AUTH_EMAIL_OTP_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, "email_otp_not_configured");
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`email-otp-recipient:v1:${secret}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealOtpRecipient(env: Env, challengeId: string, email: string) {
  const nonce = randomBase64Url(12);
  const encrypted = await crypto.subtle.encrypt({
    name: "AES-GCM", iv: base64UrlDecodeBytes(nonce), additionalData: new TextEncoder().encode(challengeId)
  }, await recipientKey(env), new TextEncoder().encode(email));
  return `${nonce}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
}

export async function enrollVerifiedOtpRecipient(env: Env, challengeId: string, ciphertext: string) {
  if (env.EMAIL_OTP_ALLOW_SIGNUP !== "1") throw new HttpError(403, "email_otp_not_eligible");
  let email: string;
  try {
    const [nonce, encoded] = ciphertext.split(".");
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM", iv: base64UrlDecodeBytes(nonce), additionalData: new TextEncoder().encode(challengeId)
    }, await recipientKey(env), Uint8Array.from(atob(encoded), char => char.charCodeAt(0)));
    email = new TextDecoder().decode(plaintext);
  } catch { throw new HttpError(400, "email_otp_invalid"); }
  if (!isEmailAllowedByInstallation(env.AUTH_LOGIN_ALLOWED_EMAILS_JSON, email)
    || !isEmailAllowedByPolicy(await readAuthEmailPolicy(env.AUTH_DB), email)) {
    throw new HttpError(403, "email_otp_not_eligible");
  }
  // The unique normalized email index handles simultaneous verified challenges
  // and directory imports. Never update an existing account's role or status.
  await env.AUTH_DB.prepare(`
    INSERT INTO auth_users (id, email, name, role, status, provider, provider_subject, source)
    VALUES (?, ?, ?, 'member', 'active', 'generic_oidc', ?, 'email_otp')
    ON CONFLICT DO NOTHING
  `).bind(crypto.randomUUID(), email, email.split("@")[0], email).run();
  const user = await readAuthUserByEmail(env, email);
  if (!user || !["active", "invited"].includes(user.status ?? "")) throw new HttpError(403, "email_otp_not_eligible");
  return user.id;
}
