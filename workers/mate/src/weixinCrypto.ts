import { RuntimeHttpError, type RuntimeEnv } from "./types.ts";

const encoder = new TextEncoder();
const AAD = "workspace-mate-weixin-channel-v1";

export type EncryptedChannelValue = { ciphertext: string; iv: string };

export async function encryptWeixinValue(
  env: RuntimeEnv,
  value: unknown,
  cryptoImpl: Crypto = crypto
): Promise<EncryptedChannelValue> {
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const ciphertext = await cryptoImpl.subtle.encrypt(
    { additionalData: encoder.encode(AAD), iv, name: "AES-GCM" },
    await encryptionKey(env, cryptoImpl),
    encoder.encode(JSON.stringify(value))
  );
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv) };
}

export async function decryptWeixinValue<T>(
  env: RuntimeEnv,
  encrypted: EncryptedChannelValue,
  cryptoImpl: Crypto = crypto
): Promise<T> {
  try {
    const plaintext = await cryptoImpl.subtle.decrypt({
      additionalData: encoder.encode(AAD),
      iv: fromBase64Url(encrypted.iv),
      name: "AES-GCM"
    }, await encryptionKey(env, cryptoImpl), fromBase64Url(encrypted.ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw new RuntimeHttpError(503, "mate_weixin_credentials_unavailable");
  }
}

export async function weixinIdentityHash(
  env: RuntimeEnv,
  purpose: "account" | "subject",
  value: string,
  cryptoImpl: Crypto = crypto
) {
  const key = await cryptoImpl.subtle.importKey(
    "raw",
    encoder.encode(channelSecret(env)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = await cryptoImpl.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`workspace-mate-weixin-${purpose}-v1\u0000${value}`)
  );
  return base64Url(new Uint8Array(signature));
}

function channelSecret(env: RuntimeEnv) {
  const secret = env.MATE_WEIXIN_CHANNEL_SECRET?.trim() || "";
  if (secret.length < 32) throw new RuntimeHttpError(503, "mate_weixin_secret_not_configured");
  return secret;
}

async function encryptionKey(env: RuntimeEnv, cryptoImpl: Crypto) {
  const material = encoder.encode(`${channelSecret(env)}\u0000workspace-mate-weixin-encryption-v1`);
  const digest = await cryptoImpl.subtle.digest("SHA-256", material);
  return cryptoImpl.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64Url(value: Uint8Array) {
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
