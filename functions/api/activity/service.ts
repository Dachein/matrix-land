import type { ActivityEvent, ActivityScenario, PortalCatalog } from "../../../src/shared/types";
import {
  schedulePortalLiveEvent,
  type PortalLiveDeferredContext,
  type PortalLivePublisherEnv
} from "../../../src/shared/portalLivePublisher.ts";
import {
  isAgentActivityActionType,
  normalizeActivityActionType,
  normalizeActivityLimit,
  normalizeActivityScenario,
  normalizeActivityTargetType,
  normalizeActivityVisibility
} from "./normalizers.ts";
import { cacheableUserAvatarUrl } from "../users/avatar.ts";

type CurrentUser = PortalCatalog["currentUser"];

type ActivityEnv = PortalLivePublisherEnv & {
  DB?: D1Database;
  DEFAULT_TEAM_ID?: string;
};

type ActivityContext<TEnv extends ActivityEnv> = EventContext<TEnv, string, unknown>;

type ActivityDeps<TEnv extends ActivityEnv> = {
  currentUserTeamId(db: D1Database, currentUser: CurrentUser, env: TEnv): Promise<string>;
  requireDb(db: D1Database | undefined): D1Database;
  resolveCurrentUser(context: ActivityContext<TEnv>): Promise<CurrentUser>;
};

const COMMUNITY_ACTIVITY_CACHE_TTL_SECONDS = 30;

export type EmitActivityEventInput = {
  actionType: ActivityEvent["actionType"];
  actor: CurrentUser;
  createdAt?: string;
  href?: string;
  metadata?: Record<string, unknown>;
  parent?: {
    id: string;
    title: string;
    type: ActivityEvent["targetType"];
  };
  scenario: ActivityScenario;
  source?: ActivityEvent["source"];
  sourceEventId?: string;
  summary: string;
  target: {
    id: string;
    title: string;
    type: ActivityEvent["targetType"];
  };
  teamId?: string;
  visibility?: ActivityEvent["visibility"];
};

export function createActivityApi<TEnv extends ActivityEnv>(deps: ActivityDeps<TEnv>) {
  return {
    async listActivityEvents(context: ActivityContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const url = new URL(context.request.url);
      const scenario = normalizeActivityScenario(url.searchParams.get("scenario"));
      const limit = normalizeActivityLimit(url.searchParams.get("limit"));

      return {
        events: scenario === "community"
          ? await readSharedCommunityActivityEvents(db, currentUser, {
            env: context.env,
            limit,
            requestUrl: context.request.url
          })
          : await readActivityEvents(db, currentUser, { env: context.env, scenario, limit }, deps)
      };
    },

    async joinCommunity(context: ActivityContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const teamId = await deps.currentUserTeamId(db, currentUser, context.env);

      await emitActivityEvent(db, {
        scenario: "community",
        actionType: "community.member.joined",
        actor: currentUser,
        target: {
          type: "community",
          id: "default",
          title: "Frontier Workspace 社区"
        },
        summary: `${currentUser.name} 新加入了社区`,
        href: "#/community",
        teamId,
        sourceEventId: `community.member.joined:${currentUser.id}`
      }, context);

      return { joined: true };
    },

    async publishAgentActivityEvent(context: ActivityContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);
      const body = await readRequestJson(context.request);
      const teamId = await deps.currentUserTeamId(db, currentUser, context.env);
      const agentId = readOptionalString(body.agentId) ?? readOptionalString(body.connectionId) ?? "agent";
      const agentName = readOptionalString(body.agentName) ?? "Agent";
      const actionType = normalizeAgentActivityActionType(body.actionType);
      const action = readOptionalString(body.action);
      const summary = readOptionalString(body.summary)
        ?? (action ? `${agentName} ${action}` : `${agentName} 提交了一条操作动态`);
      const sourceEventId = readOptionalString(body.sourceEventId);

      const eventId = await emitActivityEvent(db, {
        scenario: "agent",
        actionType,
        actor: currentUser,
        target: {
          type: "agent",
          id: agentId,
          title: agentName
        },
        summary,
        href: readOptionalString(body.href),
        visibility: normalizeActivityVisibility(body.visibility),
        teamId,
        metadata: {
          ...readMetadataObject(body.metadata),
          action,
          agentId,
          agentName,
          agentType: readOptionalString(body.agentType),
          connectionId: readOptionalString(body.connectionId),
          operationId: readOptionalString(body.operationId),
          status: readOptionalString(body.status),
          title: readOptionalString(body.title)
        },
        source: "agent",
        sourceEventId
      }, context);

      return { id: eventId };
    },

    readActivityEvents(
      db: D1Database,
      currentUser: CurrentUser,
      options: { env?: TEnv; limit?: number; scenario?: ActivityScenario } = {}
    ) {
      return readActivityEvents(db, currentUser, options, deps);
    }
  };
}

async function readSharedCommunityActivityEvents<TEnv extends ActivityEnv>(
  db: D1Database,
  currentUser: CurrentUser,
  options: { env: TEnv; limit: number; requestUrl: string }
): Promise<ActivityEvent[]> {
  const tenantId = currentUser.identity?.tenantId;
  const cache = typeof caches === "undefined"
    ? undefined
    : (caches as CacheStorage & { default: Cache }).default;
  const cacheRequest = tenantId ? createCommunityActivityCacheRequest(options.requestUrl, tenantId, options.env, options.limit) : undefined;

  if (cache && cacheRequest) {
    try {
      const cached = await cache.match(cacheRequest);
      if (cached) {
        const payload = await cached.json() as { events?: unknown };
        if (Array.isArray(payload.events)) {
          return payload.events as ActivityEvent[];
        }
      }
    } catch {
      // A cache outage or stale entry should not prevent the database read.
    }
  }

  let events: ActivityEvent[];
  try {
    const rows = await db
      .prepare(
        `
        SELECT
          id,
          scenario,
          action_type AS actionType,
          actor_user_id AS actorUserId,
          actor_name AS actorName,
          actor_avatar_url AS actorAvatarUrl,
          actor_team AS actorTeam,
          target_type AS targetType,
          target_id AS targetId,
          target_title AS targetTitle,
          parent_type AS parentType,
          parent_id AS parentId,
          parent_title AS parentTitle,
          summary,
          href,
          visibility,
          metadata_json AS metadataJson,
          source,
          source_event_id AS sourceEventId,
          created_at AS createdAt
        FROM activity_events
        WHERE scenario = 'community'
          AND visibility IN ('org', 'public')
        ORDER BY created_at DESC
        LIMIT ?
        `
      )
      .bind(options.limit)
      .all<Record<string, unknown>>();

    events = (rows.results ?? []).map(activityEventFromRow);
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("activity_events")) {
      events = [];
    } else {
      throw error;
    }
  }

  if (cache && cacheRequest) {
    try {
      await cache.put(cacheRequest, new Response(JSON.stringify({ events }), {
        headers: {
          "Cache-Control": `public, max-age=${COMMUNITY_ACTIVITY_CACHE_TTL_SECONDS}`,
          "Content-Type": "application/json"
        }
      }));
    } catch {
      // The cache is an optimization; return the database result if it is unavailable.
    }
  }

  return events;
}

function createCommunityActivityCacheRequest<TEnv extends ActivityEnv>(
  requestUrl: string,
  tenantId: string,
  env: TEnv,
  limit: number
) {
  const url = new URL("/__shared-cache/activity/community", requestUrl);
  url.searchParams.set("tenant", tenantId);
  url.searchParams.set("team", env.DEFAULT_TEAM_ID ?? "default");
  url.searchParams.set("limit", String(limit));
  return new Request(url.toString());
}

function normalizeAgentActivityActionType(value: unknown): ActivityEvent["actionType"] {
  const actionType = readString(value).trim();
  return isAgentActivityActionType(actionType)
    ? actionType
    : "agent.operation.progress";
}

export async function readActivityEvents<TEnv extends ActivityEnv>(
  db: D1Database,
  currentUser: CurrentUser,
  options: { env?: TEnv; limit?: number; scenario?: ActivityScenario } = {},
  deps: Pick<ActivityDeps<TEnv>, "currentUserTeamId">
): Promise<ActivityEvent[]> {
  const limit = normalizeActivityLimit(options.limit);
  const scenario = options.scenario ?? null;
  const teamId = await deps.currentUserTeamId(db, currentUser, options.env ?? {} as TEnv);

  try {
    const rows = await db
      .prepare(
        `
        SELECT
          id,
          scenario,
          action_type AS actionType,
          actor_user_id AS actorUserId,
          actor_name AS actorName,
          actor_avatar_url AS actorAvatarUrl,
          actor_team AS actorTeam,
          target_type AS targetType,
          target_id AS targetId,
          target_title AS targetTitle,
          parent_type AS parentType,
          parent_id AS parentId,
          parent_title AS parentTitle,
          summary,
          href,
          visibility,
          metadata_json AS metadataJson,
          source,
          source_event_id AS sourceEventId,
          created_at AS createdAt
        FROM activity_events
        WHERE (? IS NULL OR scenario = ?)
          AND (
            visibility = 'org'
            OR visibility = 'public'
            OR (visibility = 'team' AND (team_id IS NULL OR team_id = ?))
            OR actor_user_id = ?
          )
        ORDER BY created_at DESC
        LIMIT ?
        `
      )
      .bind(scenario, scenario, teamId, currentUser.id, limit)
      .all<Record<string, unknown>>();

    return (rows.results ?? []).map(activityEventFromRow);
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("activity_events")) {
      return [];
    }

    throw error;
  }
}

export async function emitActivityEvent(
  db: D1Database | undefined,
  input: EmitActivityEventInput,
  publishContext?: PortalLiveDeferredContext<PortalLivePublisherEnv>
) {
  if (!db) {
    return undefined;
  }

  const id = crypto.randomUUID();

  try {
    const result = await db
      .prepare(
        `
        INSERT OR IGNORE INTO activity_events (
          id,
          scenario,
          action_type,
          actor_user_id,
          actor_name,
          actor_avatar_url,
          actor_team,
          target_type,
          target_id,
          target_title,
          parent_type,
          parent_id,
          parent_title,
          summary,
          href,
          visibility,
          team_id,
          metadata_json,
          source,
          source_event_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
        `
      )
      .bind(
        id,
        input.scenario,
        input.actionType,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl ?? "",
        input.actor.team ?? "",
        input.target.type,
        input.target.id,
        input.target.title,
        input.parent?.type ?? null,
        input.parent?.id ?? null,
        input.parent?.title ?? null,
        input.summary,
        input.href ?? "",
        input.visibility ?? "org",
        input.teamId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.source ?? "portal",
        input.sourceEventId ?? null,
        input.createdAt ?? null
      )
      .run();

    const inserted = typeof result?.meta?.changes !== "number" || result.meta.changes > 0;
    if (!inserted) {
      if (!input.sourceEventId) {
        return undefined;
      }
      const existing = await db
        .prepare("SELECT id FROM activity_events WHERE source_event_id = ? LIMIT 1")
        .bind(input.sourceEventId)
        .first<{ id?: string }>();
      return readOptionalString(existing?.id);
    }
  } catch (error) {
    console.warn("activity_event_write_failed", error);
    return undefined;
  }

  if (publishContext) {
    schedulePortalLiveEvent(publishContext, { activityEventId: id });
  }
  return id;
}

export function activityEventFromRow(row: Record<string, unknown>): ActivityEvent {
  const metadata = readJsonObject(row.metadataJson);

  return {
    id: readString(row.id),
    scenario: normalizeActivityScenario(row.scenario) ?? "community",
    actionType: normalizeActivityActionType(row.actionType),
    actorUserId: readOptionalString(row.actorUserId),
    actorName: readString(row.actorName),
    actorAvatarUrl: cacheableUserAvatarUrl(row.actorUserId, row.actorAvatarUrl),
    actorTeam: readOptionalString(row.actorTeam),
    targetType: normalizeActivityTargetType(row.targetType),
    targetId: readString(row.targetId),
    targetTitle: readString(row.targetTitle),
    parentType: readOptionalString(row.parentType) ? normalizeActivityTargetType(row.parentType) : undefined,
    parentId: readOptionalString(row.parentId),
    parentTitle: readOptionalString(row.parentTitle),
    summary: readString(row.summary),
    href: readOptionalString(row.href),
    visibility: normalizeActivityVisibility(row.visibility),
    metadata,
    source: normalizeActivitySource(row.source),
    sourceEventId: readOptionalString(row.sourceEventId),
    createdAt: readString(row.createdAt)
  };
}

function normalizeActivitySource(value: unknown): ActivityEvent["source"] {
  const source = readString(value);
  return source === "agent" || source === "workspace-mcp-worker" || source === "apps-worker" || source === "mcp"
    ? source
    : "portal";
}

async function readRequestJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {};
  }

  const value: unknown = await request.json().catch(() => undefined);
  return readMetadataObject(value);
}

function readMetadataObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function readJsonObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
