import type { EmitActivityEventInput } from "../activity/service.ts";
import type { PortalCatalog } from "../../../src/shared/types.ts";
import type {
  PortalLiveDeferredContext,
  PortalLivePublisherEnv
} from "../../../src/shared/portalLivePublisher.ts";
import type { UserProfileColumns } from "../catalog/types.ts";
import type { PortalUserJourneySummary } from "../journey/service.ts";

export type CurrentUser = PortalCatalog["currentUser"];

export type ForumAttachmentInput = {
  storageProvider?: string;
  storageKey?: string;
  publicUrl?: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
};

export type ForumAttachmentRecord = {
  storageProvider: "r2";
  storageKey: string;
  publicUrl: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
};

export type ForumLinkEmbedRecord = {
  url: string;
  provider: string;
  title: string;
  description: string;
  previewImageUrl?: string;
  embedType: "link" | "video" | "social";
};

export type ForumContentPluginRecord = {
  actionLabel?: string;
  category?: string;
  description?: string;
  iconUrl?: string;
  installs?: number;
  owner?: string;
  pluginType: "app_card" | "app_launch" | "app_release" | "app_support";
  targetId: string;
  targetType: "app" | "skill";
  title?: string;
};

export type ForumEnv = PortalLivePublisherEnv & {
  PLATFORM_BRAND_JSON?: string;
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  DB?: D1Database;
  FORUM_MEDIA?: R2Bucket;
  DEFAULT_TEAM_ID?: string;
  PORTAL_AUTH_SERVICE_TOKEN?: string;
  PORTAL_EMAIL_FROM?: string;
  PORTAL_URL?: string;
};

export type ForumContext<TEnv extends ForumEnv> = EventContext<TEnv, string, unknown>;

export type ForumDeps<TEnv extends ForumEnv> = {
  audit(
    db: D1Database | undefined,
    actorType: string,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>
  ): Promise<string>;
  currentUserTeamId(db: D1Database, currentUser: CurrentUser, env: TEnv): Promise<string>;
  emitActivityEvent(
    db: D1Database | undefined,
    input: EmitActivityEventInput,
    publishContext?: PortalLiveDeferredContext<PortalLivePublisherEnv>
  ): Promise<unknown>;
  excerpt(value: string): string;
  fetchForumLinkPreview?: typeof fetch;
  forumLinkPreviewTimeoutMs?: number;
  httpError(status: number, message: string): Error;
  readBody<T>(request: Request): Promise<T>;
  refreshUserJourneyState(
    db: D1Database,
    userId: string,
    publishContext?: PortalLiveDeferredContext<PortalLivePublisherEnv>
  ): Promise<PortalUserJourneySummary | undefined>;
  requireDb(db: D1Database | undefined): D1Database;
  requireText(value: unknown, errorCode: string, maxLength: number): string;
  resolveCurrentUser(context: ForumContext<TEnv>): Promise<CurrentUser>;
  sanitizeTags(value: unknown): string[];
  userProfileColumns(db: D1Database): Promise<UserProfileColumns>;
};
