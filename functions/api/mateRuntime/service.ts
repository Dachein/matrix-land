import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import type { PortalCatalog } from "../../../src/shared/types.ts";

type CurrentUser = PortalCatalog["currentUser"];

export type MatePreviewSessionEnv = {
  APPS_ORG_ID?: string;
  APPS_ORG_SLUG?: string;
  APPS_WORKER_URL?: string;
  PORTAL_ISSUER?: string;
  MATE_PREVIEW_HOST_ENABLED?: string;
  MATE_RUNTIME_URL?: string;
};

type MatePreviewSessionContext<TEnv extends MatePreviewSessionEnv> = EventContext<TEnv, string, unknown>;

type MatePreviewSessionDeps<TEnv extends MatePreviewSessionEnv> = {
  audit?(
    db: D1Database | undefined,
    actorType: string,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>
  ): Promise<string>;
  fetch?: typeof fetch;
  httpError(status: number, code: string): Error;
  now?: () => number;
  opaquePrincipalKey(value: string, env: TEnv): Promise<string>;
  randomUUID?: () => string;
  readBody<T>(request: Request): Promise<T>;
  resolveCurrentUser(context: MatePreviewSessionContext<TEnv>): Promise<CurrentUser>;
  signAppsToken(env: TEnv, payload: Record<string, unknown>): Promise<string>;
  signRuntimeToken(env: TEnv, payload: Record<string, unknown>): Promise<string>;
};

type PreviewSessionBody = {
  conversationId?: unknown;
  newConversation?: unknown;
  releaseId?: unknown;
  mateId?: unknown;
};

type LiveSessionBody = {
  conversationId?: unknown;
  includeConversations?: unknown;
  newConversation?: unknown;
  mateId?: unknown;
};

type AppsMate = {
  avatarUrl?: string;
  description: string;
  displayName: string;
  id: string;
  jobRole: string;
  orgId: string;
  ownerUserId: string;
  previewReleaseId: string;
};

type AppsRelease = {
  id: string;
  manifest?: Record<string, unknown>;
  manifestSha256: string;
  status: string;
  mateId: string;
  version: number;
};

const LIVE_SESSION_TTL_SECONDS = 30 * 60;
const PREVIEW_SESSION_TTL_SECONDS = 5 * 60;
const COORDINATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,179}$/;

export function createMatePreviewSessionApi<
  TEnv extends MatePreviewSessionEnv & { DB?: D1Database }
>(deps: MatePreviewSessionDeps<TEnv>) {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());

  return {
    async createLiveSession(context: MatePreviewSessionContext<TEnv>) {
      assertPreviewHostEnabled(context.env, deps);
      assertSameOrigin(context.request, deps);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<LiveSessionBody>(context.request);
      const mateId = coordinate(body.mateId, "mate_id_invalid", deps);
      const requestedConversationId = body.conversationId === undefined
        ? undefined
        : coordinate(body.conversationId, "conversation_id_invalid", deps);
      const newConversation = optionalBoolean(body.newConversation, "new_conversation_invalid", deps);
      const includeConversations = optionalBoolean(body.includeConversations, "include_conversations_invalid", deps);
      if (newConversation && requestedConversationId) {
        throw deps.httpError(400, "conversation_intent_ambiguous");
      }
      const { orgId, orgSlug } = organization(context.env, currentUser);
      const issuedAt = epochSeconds(now, deps);
      const expiresAt = issuedAt + LIVE_SESSION_TTL_SECONDS;
      const accessToken = await deps.signRuntimeToken(context.env, {
        typ: "mate_runtime_access",
        token_use: "mate_web_session",
        aud: "workspace-mate-runtime",
        iss: context.env.PORTAL_ISSUER ?? "frontier-workspace",
        sub: currentUser.id,
        org_id: orgId,
        org_slug: orgSlug,
        email: currentUser.email,
        name: currentUser.name,
        caller_kind: "user",
        department_id: currentUser.departmentId,
        department_path: currentUser.departmentPath ?? [],
        scopes: ["mate:invoke", "mate:preferences"],
        runtime_mode: "live",
        mate_id: mateId,
        iat: issuedAt,
        exp: expiresAt,
        jti: randomUUID()
      });
      const origin = runtimeOrigin(context.env, deps);
      const requestId = context.request.headers.get("x-request-id")?.trim() || randomUUID();
      const [runtime, directory] = await Promise.all([
        runtimeJson(
          fetchImpl,
          new URL(`/v1/mates/${encodeURIComponent(mateId)}/runtime`, origin),
          accessToken,
          requestId,
          deps
        ),
        runtimeJson(
          fetchImpl,
          new URL(`/v1/mates/${encodeURIComponent(mateId)}/conversations`, origin),
          accessToken,
          requestId,
          deps
        )
      ]);
      const conversations = Array.isArray(directory.conversations)
        ? directory.conversations.map(object).filter((candidate) => candidate.channel === "sdk")
        : [];
      const requestedConversation = !newConversation && requestedConversationId
        ? conversations.find((candidate) => candidate.id === requestedConversationId)
        : undefined;
      // A Workspace link can briefly carry a stale draft coordinate when an
      // embedded Host is replaced, or keep a coordinate after its Conversation
      // was deleted. Live navigation must stay inside the current user's own
      // directory, so recover to their most recent persisted Conversation (or
      // a local draft when none exists) instead of leaking Preview semantics.
      const conversation = newConversation
        ? undefined
        : requestedConversation ?? conversations[0];
      const conversationRecovered = Boolean(requestedConversationId && !requestedConversation);
      const conversationState = conversation ? "persisted" as const : "draft" as const;
      const conversationId = conversation
        ? coordinate(conversation.id, "runtime_conversation_invalid", deps)
        : `conv_${randomUUID().replaceAll("-", "")}`;
      const mate = object(runtime.mate);
      const release = object(runtime.release);
      const principalKey = await deps.opaquePrincipalKey([
        "workspace.mate-live-principal/v1",
        currentUser.id,
        mateId
      ].join("\u0000"), context.env);
      await deps.audit?.(
        context.env.DB,
        "user",
        currentUser.id,
        "issued Mate Live Web session",
        "apps_mate",
        mateId,
        { conversationId, expiresAt, runtimeMode: "live" }
      );
      return {
        ...(includeConversations ? { conversations } : {}),
        session: {
          accessToken,
          conversationId,
          ...(conversationRecovered ? { conversationRecovered: true } : {}),
          conversationState,
          expiresAt: new Date(expiresAt * 1_000).toISOString(),
          mode: "live" as const,
          principalKey,
          release: {
            id: coordinate(release.id, "runtime_release_invalid", deps),
            ...(typeof release.manifestSha256 === "string" ? { manifestSha256: release.manifestSha256 } : {}),
            ...(Number.isSafeInteger(release.version) ? { version: Number(release.version) } : {})
          },
          runtimeOrigin: origin,
          surface: runtimeSurface(runtime.surface, deps),
          mate: {
            ...(typeof mate.avatarUrl === "string" ? { avatarUrl: mate.avatarUrl } : {}),
            description: typeof mate.description === "string" ? mate.description : "",
            displayName: requiredRuntimeText(mate.displayName, "runtime_mate_invalid", deps),
            id: mateId,
            jobRole: typeof mate.jobRole === "string" ? mate.jobRole : ""
          },
          user: sessionUser(currentUser)
        }
      };
    },
    async createPreviewSession(context: MatePreviewSessionContext<TEnv>) {
      assertPreviewHostEnabled(context.env, deps);
      assertSameOrigin(context.request, deps);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await deps.readBody<PreviewSessionBody>(context.request);
      const mateId = coordinate(body.mateId, "mate_id_invalid", deps);
      const releaseId = coordinate(body.releaseId, "mate_release_id_invalid", deps);
      const newConversation = optionalBoolean(body.newConversation, "new_conversation_invalid", deps);
      if (newConversation && body.conversationId !== undefined) {
        throw deps.httpError(400, "conversation_intent_ambiguous");
      }
      const requestedConversationId = body.conversationId === undefined
        ? undefined
        : coordinate(body.conversationId, "conversation_id_invalid", deps);
      const { orgId, orgSlug } = organization(context.env, currentUser);
      const appsToken = await deps.signAppsToken(context.env, {
        typ: "apps_access",
        iss: context.env.PORTAL_ISSUER ?? "frontier-workspace",
        sub: currentUser.id,
        org_id: orgId,
        org_slug: orgSlug,
        provider: currentUser.identity.provider,
        oid: currentUser.identity.objectId,
        tid: currentUser.identity.tenantId,
        email: currentUser.email,
        name: currentUser.name,
        department_id: currentUser.departmentId,
        department_path: currentUser.departmentPath ?? [],
        scopes: ["apps:mates:read"],
        exp: epochSeconds(now, deps) + 120
      });
      const requestId = context.request.headers.get("x-request-id")?.trim() || randomUUID();
      const [mate, release] = await Promise.all([
        readAppsEntity<AppsMate>(
          context.env,
          `/mates/${encodeURIComponent(mateId)}`,
          "mate",
          appsToken,
          requestId,
          fetchImpl,
          deps
        ),
        readAppsEntity<AppsRelease>(
          context.env,
          `/mates/${encodeURIComponent(mateId)}/releases/${encodeURIComponent(releaseId)}`,
          "release",
          appsToken,
          requestId,
          fetchImpl,
          deps
        )
      ]);
      assertExactPreview(mate, release, {
        orgId,
        ownerUserIds: [currentUser.id, currentUser.email],
        releaseId,
        mateId
      }, deps);

      const issuedAt = epochSeconds(now, deps);
      const expiresAt = issuedAt + PREVIEW_SESSION_TTL_SECONDS;
      const accessToken = await deps.signRuntimeToken(context.env, {
        typ: "mate_runtime_access",
        aud: "workspace-mate-runtime",
        iss: context.env.PORTAL_ISSUER ?? "frontier-workspace",
        sub: currentUser.id,
        org_id: orgId,
        org_slug: orgSlug,
        email: currentUser.email,
        name: currentUser.name,
        caller_kind: "user",
        department_id: currentUser.departmentId,
        department_path: currentUser.departmentPath ?? [],
        scopes: ["mate:owner_test", "mate:invoke"],
        runtime_mode: "preview",
        mate_id: mateId,
        release_id: releaseId,
        iat: issuedAt,
        exp: expiresAt,
        jti: randomUUID()
      });
      const principalKey = await deps.opaquePrincipalKey([
        "workspace.mate-preview-principal/v1",
        currentUser.id,
        mateId,
        releaseId
      ].join("\u0000"), context.env);
      const origin = runtimeOrigin(context.env, deps);
      const directory = await runtimeJson(
        fetchImpl,
        new URL(`/v1/owner-test/mates/${encodeURIComponent(mateId)}/conversations`, origin),
        accessToken,
        requestId,
        deps
      );
      const conversations = Array.isArray(directory.conversations)
        ? directory.conversations.map(object).filter((candidate) => candidate.channel === "sdk")
        : [];
      const conversation = !newConversation && requestedConversationId
        ? conversations.find((candidate) => candidate.id === requestedConversationId)
        : newConversation ? undefined : conversations[0];
      if (requestedConversationId && !conversation) throw deps.httpError(404, "conversation_not_found");
      const conversationState = conversation ? "persisted" as const : "draft" as const;
      const conversationId = conversation
        ? coordinate(conversation.id, "runtime_conversation_invalid", deps)
        : `conv_preview_${randomUUID().replaceAll("-", "")}`;

      await deps.audit?.(
        context.env.DB,
        "user",
        currentUser.id,
        "issued Mate Preview session",
        "apps_mate",
        mateId,
        { conversationId, expiresAt, releaseId, runtimeMode: "preview" }
      );
      const mateAvatarUrl = releaseMateAvatar(release);

      return {
        session: {
          accessToken,
          conversationId,
          conversationState,
          expiresAt: new Date(expiresAt * 1_000).toISOString(),
          mode: "preview" as const,
          principalKey,
          release: {
            id: release.id,
            manifestSha256: release.manifestSha256,
            version: release.version
          },
          runtimeOrigin: origin,
          surface: previewSurface(release),
          mate: {
            ...(mateAvatarUrl ? { avatarUrl: mateAvatarUrl } : {}),
            description: mate.description,
            displayName: mate.displayName,
            id: mate.id,
            jobRole: mate.jobRole
          },
          user: sessionUser(currentUser)
        }
      };
    }
  };
}

function sessionUser(user: CurrentUser) {
  const avatarUrl = typeof user.avatarUrl === "string" ? user.avatarUrl.trim() : "";
  return {
    ...(avatarUrl.length <= 2_048 && /^https:\/\//i.test(avatarUrl) ? { avatarUrl } : {}),
    name: user.name
  };
}

function releaseMateAvatar(release: AppsRelease) {
  const manifest = release.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return "";
  const mate = manifest.mate;
  if (!mate || typeof mate !== "object" || Array.isArray(mate)) return "";
  return typeof (mate as Record<string, unknown>).avatarRef === "string"
    ? String((mate as Record<string, unknown>).avatarRef).trim()
    : "";
}

async function runtimeJson<TEnv extends MatePreviewSessionEnv>(
  fetchImpl: typeof fetch,
  url: URL,
  accessToken: string,
  requestId: string,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">,
  body?: Record<string, unknown>
) {
  const response = await fetchImpl(url, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "x-request-id": requestId,
      ...(body ? { "content-type": "application/json" } : {})
    },
    method: body ? "POST" : "GET"
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof payload.error === "string" ? payload.error : "mate_runtime_unavailable";
    throw deps.httpError(response.status === 401 ? 502 : response.status, code);
  }
  return payload;
}

function runtimeSurface<TEnv extends MatePreviewSessionEnv>(
  value: unknown,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
  const source = object(value);
  const entries = Array.isArray(source.entries) ? source.entries.flatMap((value) => {
    const entry = object(value);
    const channel = entry.channel;
    const kind = entry.kind;
    return (
      (channel === "sdk" || channel === "email" || channel === "schedule" || channel === "mate_call")
      && (kind === "conversation" || kind === "task_inbox")
    ) ? [{ channel, kind }] : [];
  }) : [];
  const kind = source.kind;
  if (kind !== "conversation" && kind !== "task_inbox" && kind !== "unavailable") {
    throw deps.httpError(502, "runtime_surface_invalid");
  }
  return {
    channels: entries.map((entry) => entry.channel),
    entries,
    kind
  };
}

function requiredRuntimeText<TEnv extends MatePreviewSessionEnv>(
  value: unknown,
  code: string,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output || output.length > 500) throw deps.httpError(502, code);
  return output;
}

function previewSurface(release: AppsRelease) {
  const manifest = object(release.manifest);
  const channels = object(manifest.channels);
  const experience = object(manifest.experiencePolicy);
  const conversation = object(experience.conversation);
  const taskInbox = object(experience.taskInbox);
  const declaredConversationChannels = stringList(conversation.channels);
  const sdkConversationEnabled = conversation.enabled === true
    && declaredConversationChannels.includes("sdk")
    && (object(channels.embedded).enabled === true || object(channels.standalone).enabled === true);
  const inboxChannels = object(channels.inbox);
  const declaredTaskChannels = stringList(taskInbox.channels).filter((channel) => (
    channel === "email" || channel === "schedule" || channel === "mate_call"
  ));
  const enabledTaskChannels = declaredTaskChannels.filter((channel) => (
    channel === "email" ? object(inboxChannels.email).enabled === true
      : channel === "schedule" ? object(inboxChannels.schedule).enabled === true
        : object(inboxChannels.mateCall).enabled === true
  ));
  const entries = [
    ...(sdkConversationEnabled ? [{ channel: "sdk" as const, kind: "conversation" as const }] : []),
    ...enabledTaskChannels.map((channel) => ({ channel, kind: "task_inbox" as const }))
  ];
  const channelsForHost = entries.map((entry) => entry.channel);

  if (sdkConversationEnabled) {
    return {
      channels: channelsForHost,
      entries,
      kind: "conversation" as const
    };
  }
  if (taskInbox.enabled === true && enabledTaskChannels.length > 0) {
    return {
      channels: enabledTaskChannels,
      entries,
      kind: "task_inbox" as const
    };
  }
  return {
    channels: [],
    entries: [],
    kind: "unavailable" as const
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === "string")))
    : [];
}

function assertPreviewHostEnabled<TEnv extends MatePreviewSessionEnv>(
  env: TEnv,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
  if (env.MATE_PREVIEW_HOST_ENABLED?.trim().toLowerCase() !== "true") {
    throw deps.httpError(404, "mate_preview_host_disabled");
  }
}

function assertSameOrigin<TEnv extends MatePreviewSessionEnv>(
  request: Request,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw deps.httpError(415, "mate_preview_json_required");
  }
  const origin = request.headers.get("origin")?.trim();
  if (origin && origin !== new URL(request.url).origin) {
    throw deps.httpError(403, "mate_preview_origin_invalid");
  }
}

async function readAppsEntity<T>(
  env: MatePreviewSessionEnv,
  path: string,
  key: string,
  token: string,
  requestId: string,
  fetchImpl: typeof fetch,
  deps: Pick<MatePreviewSessionDeps<MatePreviewSessionEnv>, "httpError">
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${appsOrigin(env, deps)}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "x-request-id": requestId
      },
      method: "GET",
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw deps.httpError(502, "mate_preview_control_plane_unavailable");
  }
  if (!response.ok) {
    throw deps.httpError(
      response.status === 404 || response.status === 403 ? 404 : 502,
      response.status === 404 || response.status === 403
        ? "mate_preview_not_found"
        : "mate_preview_control_plane_unavailable"
    );
  }
  const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const value = payload?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw deps.httpError(502, "mate_preview_control_plane_invalid");
  }
  return value as T;
}

function assertExactPreview<TEnv extends MatePreviewSessionEnv>(
  mate: AppsMate,
  release: AppsRelease,
  expected: { orgId: string; ownerUserIds: string[]; releaseId: string; mateId: string },
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
  if (
    mate.id !== expected.mateId
    || mate.orgId !== expected.orgId
    || !expected.ownerUserIds.some((value) => (
      value.toLowerCase() === String(mate.ownerUserId ?? "").toLowerCase()
    ))
    || mate.previewReleaseId !== expected.releaseId
    || release.id !== expected.releaseId
    || release.mateId !== expected.mateId
    || release.status !== "candidate"
    || !Number.isSafeInteger(Number(release.version))
    || !/^sha256:[a-f0-9]{64}$/i.test(String(release.manifestSha256 ?? ""))
  ) throw deps.httpError(409, "mate_preview_release_changed");
}

function coordinate<TEnv extends MatePreviewSessionEnv>(
  value: unknown,
  code: string,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!COORDINATE_PATTERN.test(text)) throw deps.httpError(400, code);
  return text;
}

function optionalBoolean<TEnv extends MatePreviewSessionEnv>(
  value: unknown,
  code: string,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw deps.httpError(400, code);
  return value;
}

function organization(env: MatePreviewSessionEnv, currentUser: CurrentUser) {
  const orgId = env.APPS_ORG_ID?.trim() || slug(currentUser.team) || currentUser.team;
  const orgSlug = env.APPS_ORG_SLUG?.trim() || slug(orgId) || orgId;
  return { orgId, orgSlug };
}

function appsOrigin<TEnv extends MatePreviewSessionEnv>(
  env: TEnv,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
  return safeOrigin(env.APPS_WORKER_URL || "", "apps_worker_url_not_configured", deps);
}

function runtimeOrigin<TEnv extends MatePreviewSessionEnv>(
  env: TEnv,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
  return safeOrigin(
    env.MATE_RUNTIME_URL || missingConfiguration("MATE_RUNTIME_URL"),
    "mate_runtime_url_invalid",
    deps
  );
}

function safeOrigin<TEnv extends MatePreviewSessionEnv>(
  value: string,
  code: string,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
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
    throw deps.httpError(503, code);
  }
}

function epochSeconds<TEnv extends MatePreviewSessionEnv>(
  now: () => number,
  deps: Pick<MatePreviewSessionDeps<TEnv>, "httpError">
) {
  const value = now();
  if (!Number.isFinite(value) || value < 0) throw deps.httpError(500, "mate_preview_clock_invalid");
  return Math.floor(value / 1_000);
}

function slug(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
