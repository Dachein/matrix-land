export type WorkspaceMateAccessToken = string | (() => string | Promise<string>);
export type WorkspaceMateChatMode = "live" | "preview";

export type WorkspaceMateChatGrant = {
  expiresAt: string;
  grant: string;
  mode: WorkspaceMateChatMode;
  releaseId: string;
};

export type RequestWorkspaceMateChatGrantOptions = {
  accessToken: WorkspaceMateAccessToken;
  conversationId: string;
  fetch?: typeof fetch;
  mode?: WorkspaceMateChatMode;
  runtimeOrigin: string;
  mateId: string;
};

export type WorkspaceMateChatGrantManagerOptions = RequestWorkspaceMateChatGrantOptions & {
  now?: () => number;
  /**
   * Stable, opaque Host auth-session identity. This is not a bearer token or
   * user identifier. Rotate it whenever the authenticated principal changes.
   */
  principalKey: string;
  refreshSkewMs?: number;
};

export type WorkspaceMateChatGrantCredentials = Pick<
  RequestWorkspaceMateChatGrantOptions,
  "accessToken" | "fetch"
>;

export class WorkspaceMateChatHostError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly status: number;

  constructor(code: string, status: number, details?: Record<string, unknown>) {
    super(code);
    this.name = "WorkspaceMateChatHostError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class WorkspaceMateChatGrantManager {
  readonly dependencyKey: string;
  private cached?: WorkspaceMateChatGrant;
  private inFlight?: Promise<WorkspaceMateChatGrant>;
  private readonly now: () => number;
  private options: RequestWorkspaceMateChatGrantOptions;
  private readonly refreshSkewMs: number;

  constructor(options: WorkspaceMateChatGrantManagerOptions) {
    this.options = normalizeRequestOptions(options);
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = boundedMilliseconds(
      options.refreshSkewMs ?? 30_000,
      "mate_chat_grant_refresh_skew_invalid"
    );
    this.dependencyKey = createGrantDependencyKey({
      conversationId: this.options.conversationId,
      mode: normalizeWorkspaceMateChatMode(this.options.mode),
      principalKey: normalizePrincipalKey(options.principalKey),
      runtimeOrigin: this.options.runtimeOrigin,
      mateId: this.options.mateId
    });
  }

  /**
   * Update volatile credentials without changing the stable Suspense/query
   * resource identity. A principal change requires a new manager and key.
   */
  updateCredentials(credentials: WorkspaceMateChatGrantCredentials) {
    this.options = {
      ...this.options,
      accessToken: credentials.accessToken,
      fetch: credentials.fetch
    };
  }

  current() {
    return this.cached && this.isFresh(this.cached) ? { ...this.cached } : undefined;
  }

  invalidate() {
    this.cached = undefined;
  }

  async get(options: { forceRefresh?: boolean } = {}) {
    if (!options.forceRefresh) {
      const current = this.current();
      if (current) return current;
    }
    if (this.inFlight) return this.inFlight;
    const request = requestWorkspaceMateChatGrant(this.options).then((grant) => {
      if (!this.isUsable(grant)) {
        throw new WorkspaceMateChatHostError("mate_chat_grant_expired", 401);
      }
      this.cached = grant;
      return { ...grant };
    }).finally(() => {
      if (this.inFlight === request) this.inFlight = undefined;
    });
    this.inFlight = request;
    return request;
  }

  private isFresh(grant: WorkspaceMateChatGrant) {
    return Date.parse(grant.expiresAt) > normalizedNow(this.now) + this.refreshSkewMs;
  }

  private isUsable(grant: WorkspaceMateChatGrant) {
    return Date.parse(grant.expiresAt) > normalizedNow(this.now);
  }
}

export function createWorkspaceMateChatGrantManager(options: WorkspaceMateChatGrantManagerOptions) {
  return new WorkspaceMateChatGrantManager(options);
}

export async function requestWorkspaceMateChatGrant(
  options: RequestWorkspaceMateChatGrantOptions
): Promise<WorkspaceMateChatGrant> {
  const normalized = normalizeRequestOptions(options);
  const token = await resolveAccessToken(normalized.accessToken);
  const response = await (normalized.fetch ?? fetch)(chatGrantUrl(normalized), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`
    },
    method: "POST"
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new WorkspaceMateChatHostError(
      typeof payload.error === "string" ? payload.error : "mate_chat_grant_request_failed",
      response.status,
      payload
    );
  }
  return normalizeGrant(payload, normalized.mode);
}

export function workspaceMateChatGrantUrl(options: Pick<
  RequestWorkspaceMateChatGrantOptions,
  "conversationId" | "mode" | "runtimeOrigin" | "mateId"
>) {
  return chatGrantUrl(options);
}

export function normalizeWorkspaceMateRuntimeOrigin(value: string) {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      || url.pathname !== "/"
      || url.search
      || url.hash
      || url.username
      || url.password
    ) throw new Error("invalid_origin");
    return url.origin;
  } catch {
    throw new WorkspaceMateChatHostError("runtime_origin_invalid", 400);
  }
}

export function normalizeWorkspaceMateChatMode(value: WorkspaceMateChatMode | undefined) {
  if (value === undefined || value === "live") return "live" as const;
  if (value === "preview") return "preview" as const;
  throw new WorkspaceMateChatHostError("mate_chat_mode_invalid", 400);
}

export function normalizeWorkspaceMateChatIdentifier(value: string, code: string) {
  const identifier = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{3,180}$/.test(identifier)) {
    throw new WorkspaceMateChatHostError(code, 400);
  }
  return identifier;
}

function normalizeRequestOptions<T extends RequestWorkspaceMateChatGrantOptions>(
  options: T
): Omit<T, "mode"> & { mode: WorkspaceMateChatMode } {
  const mode = normalizeWorkspaceMateChatMode(options.mode);
  return {
    ...options,
    conversationId: normalizeWorkspaceMateChatIdentifier(options.conversationId, "conversation_id_invalid"),
    mode,
    runtimeOrigin: normalizeWorkspaceMateRuntimeOrigin(options.runtimeOrigin),
    mateId: normalizeWorkspaceMateChatIdentifier(options.mateId, "mate_id_invalid")
  };
}

function chatGrantUrl(options: Pick<
  RequestWorkspaceMateChatGrantOptions,
  "conversationId" | "mode" | "runtimeOrigin" | "mateId"
>) {
  const mode = normalizeWorkspaceMateChatMode(options.mode);
  const origin = normalizeWorkspaceMateRuntimeOrigin(options.runtimeOrigin);
  const mateId = normalizeWorkspaceMateChatIdentifier(options.mateId, "mate_id_invalid");
  const conversationId = normalizeWorkspaceMateChatIdentifier(options.conversationId, "conversation_id_invalid");
  const namespace = mode === "preview" ? "owner-test/mates" : "mates";
  return `${origin}/v1/${namespace}/${encodeURIComponent(mateId)}/conversations/${encodeURIComponent(conversationId)}/chat-grants`;
}

async function resolveAccessToken(source: WorkspaceMateAccessToken) {
  const value = typeof source === "function" ? await source() : source;
  const token = typeof value === "string" ? value.trim() : "";
  if (!token) throw new WorkspaceMateChatHostError("mate_access_token_missing", 401);
  return token;
}

function normalizeGrant(
  value: Record<string, unknown>,
  expectedMode: WorkspaceMateChatMode
): WorkspaceMateChatGrant {
  const grant = boundedText(value.grant, 8_192, "mate_chat_grant_response_invalid");
  const releaseId = boundedText(value.releaseId, 180, "mate_chat_grant_response_invalid");
  const expiresAt = boundedText(value.expiresAt, 80, "mate_chat_grant_response_invalid");
  if (!Number.isFinite(Date.parse(expiresAt)) || value.mode !== expectedMode) {
    throw new WorkspaceMateChatHostError("mate_chat_grant_response_invalid", 502);
  }
  return { expiresAt, grant, mode: expectedMode, releaseId };
}

function boundedText(value: unknown, maximum: number, code: string) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new WorkspaceMateChatHostError(code, 502);
  return value;
}

function boundedMilliseconds(value: number, code: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 5 * 60_000) {
    throw new WorkspaceMateChatHostError(code, 400);
  }
  return value;
}

function normalizedNow(now: () => number) {
  const value = now();
  if (!Number.isFinite(value) || value < 0) {
    throw new WorkspaceMateChatHostError("mate_chat_clock_invalid", 500);
  }
  return value;
}

function normalizePrincipalKey(value: string) {
  const key = typeof value === "string" ? value.trim() : "";
  if (
    key.length < 8
    || key.length > 256
    || /[\u0000-\u001f\u007f]/.test(key)
  ) throw new WorkspaceMateChatHostError("mate_principal_key_invalid", 400);
  return key;
}

function createGrantDependencyKey(options: {
  conversationId: string;
  mode: WorkspaceMateChatMode;
  principalKey: string;
  runtimeOrigin: string;
  mateId: string;
}) {
  const input = [
    "workspace.mate-chat-resource/v1",
    options.runtimeOrigin,
    options.mateId,
    options.mode,
    options.conversationId,
    options.principalKey
  ].join("\u0000");
  return `workspace-chat-resource-v1-${opaqueHash128(input)}`;
}

function opaqueHash128(input: string) {
  const bytes = new TextEncoder().encode(input);
  const prime = 0x100000001b3n;
  let first = 0xcbf29ce484222325n;
  let second = 0x6c62272e07bb0142n;
  for (const byte of bytes) {
    first ^= BigInt(byte);
    first = BigInt.asUintN(64, first * prime);
    second ^= BigInt(byte ^ 0xa5);
    second = BigInt.asUintN(64, second * prime);
  }
  return `${first.toString(16).padStart(16, "0")}${second.toString(16).padStart(16, "0")}`;
}
