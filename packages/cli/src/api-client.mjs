import { assertCredentialInstallation, installationOptions } from "./installation.mjs";
import { CLI_VERSION } from "./constants.mjs";
import { currentCredential, refreshCurrentCredential } from "./auth.mjs";

export async function authenticatedRequest(store, url, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let credential = await currentCredential(store, { ...options, fetchImpl });
  if (!credential?.access_token) {
    throw new Error("Workspace CLI is not authenticated. Run 'frontier-workspace auth login' first");
  }

  assertCredentialInstallation(credential, options);
  if (new URL(url).origin !== installationOptions(options).apiUrl) throw new Error("Refusing to send credentials to another workspace");
  let response = await send(credential);
  if (response.status === 401) {
    credential = await refreshCurrentCredential(store, credential, { ...options, fetchImpl });
    if (!credential?.access_token) {
      throw new Error("Workspace CLI authentication expired. Run 'frontier-workspace auth login' again");
    }
    response = await send(credential);
  }
  return response;

  function send(activeCredential) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${activeCredential.access_token}`);
    headers.set("User-Agent", `workspace-cli/${CLI_VERSION}`);
    return fetchImpl(url, { ...init, headers, redirect: "error" });
  }
}

export async function responsePayload(response) {
  const text = await response.text();
  let payload;
  try {
    payload = text.trim() ? JSON.parse(text) : {};
  } catch {
    payload = { message: text.trim() };
  }
  if (!response.ok) {
    const message = payload?.message || payload?.error || `Workspace API returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}
