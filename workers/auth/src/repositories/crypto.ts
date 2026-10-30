// Hash and create one-use persistence credentials.
export async function hashLaunchCode(code: string) {
  return `sha256:${await sha256Hex(code)}`;
}

export async function hashOpaqueToken(token: string) {
  return `sha256:${await sha256Hex(token)}`;
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function randomOpaqueCode(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = base64UrlEncode(bytes);
  return `${prefix}_${token}`;
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
