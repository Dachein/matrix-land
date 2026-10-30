import { installationOptions, assertCredentialInstallation } from "./installation.mjs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { CLI_VERSION, DEVICE_CODE_GRANT_TYPE, OAUTH_CLIENT_ID, OAUTH_SCOPE, SUPPORTED_AGENT_TYPES } from "./constants.mjs";
import { createLoopbackReceiver } from "./loopback-receiver.mjs";

export async function authorizePkce(store, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const authUrl = installationOptions(options).authUrl;
  const mcpUrl = installationOptions(options).mcpUrl;
  const metadata = await discoverOAuthMetadata(authUrl, fetchImpl);
  const random = options.randomBytes ?? randomBytes;
  const verifier = random(32).toString("base64url");
  const state = random(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const agentType = normalizeAgentType(options.agentType ?? process.env.WORKSPACE_AGENT ?? "codex");
  const clientName = agentClientName(agentType);
  const receiver = await (options.loopbackReceiverFactory ?? createLoopbackReceiver)({
    expectedState: state,
    randomBytes: random,
    timeoutMs: options.authorizationTimeoutMs
  });

  try {
    const registrationResponse = await fetchImpl(metadata.registration_endpoint, {
      redirect: "error",
    method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `workspace-cli/${CLI_VERSION}` },
      body: JSON.stringify({
        agent_type: agentType,
        client_name: clientName,
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [receiver.redirectUri],
        response_types: ["code"],
        software_id: "@frontier-workspace/cli",
        software_version: CLI_VERSION,
        token_endpoint_auth_method: "none"
      })
    });
    const registration = await readOAuthResponse(registrationResponse);
    if (typeof registration.client_id !== "string" || !registration.client_id) {
      throw new Error("OAuth client registration did not return a client_id");
    }

    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.search = new URLSearchParams({
      client_id: registration.client_id,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: receiver.redirectUri,
      resource: mcpUrl,
      response_type: "code",
      scope: OAUTH_SCOPE,
      state
    }).toString();
    await options.onAuthorization?.({ authorizationUrl: authorizationUrl.toString(), redirectUri: receiver.redirectUri });
    if (options.openBrowser !== false) (options.browserOpener ?? openBrowser)(authorizationUrl.toString());

    const callback = await receiver.waitForCallback();
    if (callback.searchParams.get("state") !== state) {
      throw new Error("OAuth callback state did not match the pending Workspace authorization");
    }
    const oauthError = callback.searchParams.get("error");
    if (oauthError) throw new Error(`OAuth authorization was not completed (${oauthError})`);
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("OAuth callback did not contain an authorization code");

    const tokenResponse = await fetchImpl(metadata.token_endpoint, {
      redirect: "error",
    method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `workspace-cli/${CLI_VERSION}` },
      body: new URLSearchParams({
        client_id: registration.client_id,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: receiver.redirectUri
      })
    });
    const payload = await readOAuthResponse(tokenResponse);
    const credential = credentialFromToken(payload, authUrl, {
      agent_type: agentType,
      authorization_method: "authorization_code_pkce",
      client_id: registration.client_id,
      resource_url: mcpUrl,
      token_endpoint: metadata.token_endpoint
    });
    await store.save(credential);
    return credential;
  } finally {
    await receiver.close();
  }
}

export async function startDeviceAuthorization(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const authUrl = installationOptions(options).authUrl;
  const mcpUrl = installationOptions(options).mcpUrl;
  const response = await fetchImpl(`${authUrl}/v1/mcp/oauth/device_authorization`, {
    redirect: "error",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `workspace-cli/${CLI_VERSION}` },
    body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, resource: mcpUrl, scope: OAUTH_SCOPE })
  });
  return readOAuthResponse(response);
}

export async function pollDeviceAuthorization(device, store, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const authUrl = installationOptions(options).authUrl;
  let interval = Math.max(1, Number(device.interval) || 5);
  const expiresAt = Date.now() + Math.max(1, Number(device.expires_in) || 600) * 1000;
  while (Date.now() < expiresAt) {
    await sleep(interval * 1000);
    const response = await fetchImpl(`${authUrl}/v1/mcp/oauth/token`, {
      redirect: "error",
    method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `workspace-cli/${CLI_VERSION}` },
      body: new URLSearchParams({ grant_type: DEVICE_CODE_GRANT_TYPE, client_id: OAUTH_CLIENT_ID, device_code: device.device_code })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      const credential = credentialFromToken(payload, authUrl, {
        agent_type: "workbuddy",
        authorization_method: "device_flow",
        client_id: OAUTH_CLIENT_ID,
        resource_url: installationOptions(options).mcpUrl,
        token_endpoint: `${authUrl}/v1/mcp/oauth/token`
      });
      await store.save(credential);
      return credential;
    }
    if (payload.error === "authorization_pending") continue;
    if (payload.error === "slow_down") { interval += 5; continue; }
    throw new Error(payload.error_description || payload.message || payload.error || `Token request failed (${response.status})`);
  }
  throw new Error("Device authorization expired");
}

export async function refreshCredential(store, credential, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  assertCredentialInstallation(credential, options);
  const authUrl = installationOptions(options).authUrl;
  const clientId = credential.client_id ?? OAUTH_CLIENT_ID;
  const tokenEndpoint = credential.token_endpoint ?? `${authUrl}/v1/mcp/oauth/token`;
  const response = await fetchImpl(tokenEndpoint, {
    redirect: "error",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": `workspace-cli/${CLI_VERSION}` },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: credential.refresh_token })
  });
  const payload = await readOAuthResponse(response);
  const refreshed = credentialFromToken(payload, authUrl, {
    agent_type: credential.agent_type,
    authorization_method: credential.authorization_method,
    client_id: clientId,
    resource_url: credential.resource_url,
    token_endpoint: tokenEndpoint
  });
  await store.save(refreshed);
  return refreshed;
}

export async function currentCredential(store, options = {}) {
  let credential = await store.load();
  if (!credential) return undefined;
  assertCredentialInstallation(credential, options);
  if (!credential.access_token || Number(credential.expires_at) <= Date.now() + 60_000) {
    credential = await refreshCurrentCredential(store, credential, options);
  }
  return credential;
}

export async function refreshCurrentCredential(store, observedCredential, options = {}) {
  const refresh = async () => {
    const latest = await store.load();
    if (!latest) return undefined;
    if (latest.refresh_token !== observedCredential.refresh_token) return latest;
    try {
      return await refreshCredential(store, latest, options);
    } catch (error) {
      const recovered = await store.load();
      if (recovered?.refresh_token && recovered.refresh_token !== latest.refresh_token) return recovered;
      throw error;
    }
  };
  return typeof store.withRefreshLock === "function" ? store.withRefreshLock(refresh) : refresh();
}

export function openBrowser(url, platform = process.platform) {
  const { args, command } = browserLaunchCommand(url, platform);
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {
    // The authorization URL is emitted before this best-effort launch, so the
    // host can still open it when no platform browser launcher is available.
  });
  child.unref();
}

export function browserLaunchCommand(url, platform = process.platform) {
  if (platform === "win32") {
    // Do not route OAuth URLs through `cmd.exe start`: unescaped `&` query
    // separators are parsed by CMD and truncate the URL after client_id.
    return { command: "explorer.exe", args: [url] };
  }
  return { command: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}

export function normalizeAgentType(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
  const aliases = {
    cc: "claude-code",
    claude: "claude-code",
    "claude-code": "claude-code",
    codex: "codex",
    cursor: "cursor",
    workbuddy: "workbuddy",
    "work-buddy": "workbuddy"
  };
  const agentType = aliases[normalized];
  if (!agentType || !SUPPORTED_AGENT_TYPES.includes(agentType)) {
    throw new Error(`Unsupported Agent '${value}'. Expected: ${SUPPORTED_AGENT_TYPES.join(", ")}`);
  }
  return agentType;
}

function agentClientName(agentType) {
  const labels = {
    "claude-code": "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    workbuddy: "WorkBuddy"
  };
  return `Workspace CLI for ${labels[agentType]}`;
}

function credentialFromToken(payload, authUrl, metadata = {}) {
  if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") {
    throw new Error("OAuth token response did not contain rotating credentials");
  }
  return { ...payload, ...metadata, auth_url: authUrl, obtained_at: Date.now(), expires_at: Date.now() + Math.max(1, Number(payload.expires_in) || 3600) * 1000 };
}

async function readOAuthResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.message || payload.error || `OAuth request failed (${response.status})`);
  return payload;
}

async function discoverOAuthMetadata(authUrl, fetchImpl) {
  const response = await fetchImpl(`${authUrl.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`, {
    redirect: "error",
    headers: { "Accept": "application/json", "User-Agent": `workspace-cli/${CLI_VERSION}` }
  });
  const metadata = await readOAuthResponse(response);
  for (const field of ["authorization_endpoint", "registration_endpoint", "token_endpoint"]) {
    if (typeof metadata[field] !== "string" || !metadata[field]) {
      throw new Error(`OAuth metadata did not contain ${field}`);
    }
    const endpoint = new URL(metadata[field]);
    if ((field !== "authorization_endpoint" && endpoint.origin !== new URL(authUrl).origin) || endpoint.username || endpoint.password) throw new Error(`OAuth ${field} belongs to a different workspace`);
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost") {
      throw new Error(`OAuth metadata returned an unsafe ${field}`);
    }
  }
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes("S256")) {
    throw new Error("OAuth server does not advertise PKCE S256 support");
  }
  return metadata;
}
