import { HttpError, type Env } from "../types.ts";
import { base64UrlDecodeBytes, randomBase64Url } from "../crypto.ts";

async function key(env: Env) {
  const secret = env.THIRD_PARTY_CREDENTIAL_KEY;
  if (!secret || secret.length < 32) throw new HttpError(503, "third_party_credentials_not_configured");
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealCredential(env: Env, owner: string, value: unknown) {
  const nonce = randomBase64Url(12);
  const encrypted = await crypto.subtle.encrypt({
    name: "AES-GCM", iv: base64UrlDecodeBytes(nonce), additionalData: new TextEncoder().encode(owner)
  }, await key(env), new TextEncoder().encode(JSON.stringify(value)));
  let binary = "";
  for (const byte of new Uint8Array(encrypted)) binary += String.fromCharCode(byte);
  return `${nonce}.${btoa(binary)}`;
}

export async function openCredential<T>(env: Env, owner: string, ciphertext: string): Promise<T> {
  const [nonce, encrypted] = ciphertext.split(".");
  if (!nonce || !encrypted) throw new HttpError(503, "third_party_credential_invalid");
  const bytes = Uint8Array.from(atob(encrypted), char => char.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: base64UrlDecodeBytes(nonce), additionalData: new TextEncoder().encode(owner)
  }, await key(env), bytes);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
