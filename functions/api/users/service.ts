import { hasUserRolesTable, type UserProfileColumns } from "../identity/profileSchema.ts";
import { profileDetailsFromRow, profileJsonObject, readJsonStringList } from "../identity/profileDetails.ts";
export { profileDetailsFromRow } from "../identity/profileDetails.ts";
import { resolvePortalJourneyLevel } from "../../../src/shared/journey.ts";
import { normalizeAssignedRoles, normalizeEditableAssignedRoles } from "../values.ts";
import type {
  IdentityProvider,
  PortalCatalog,
  PortalJourneyBadgeCategory,
  PortalJourneyLevelKey,
  UserRole
} from "../../../src/shared/types.ts";
import { cacheableUserAvatarUrl, userAvatarImageResponse } from "./avatar.ts";
import { cacheableCatalogImageUrl } from "../catalog/coverImage.ts";

type CurrentUser = PortalCatalog["currentUser"];
type PublicJourneyBadge = {
  awardedAt: string;
  badgeKey: string;
  descriptionEn: string;
  descriptionZh: string;
  nameEn: string;
  nameZh: string;
  points: number;
};

type PublicRecentPost = {
  createdAt: string;
  id: string;
  replyCount: number;
  title: string;
};

type PublicPublishedSkill = {
  coverImageUrl?: string;
  id: string;
  installs: number;
  name: string;
  publishedAt: string;
  summary: string;
  targetId: string;
};

type PublicUserProfile = Omit<CurrentUser, "identity"> & {
  journeyBadgeCount: number;
  journeyBadges: PublicJourneyBadge[];
  journeyCommunityContributionPoints: number;
  journeyLevelKey: PortalJourneyLevelKey;
  journeyTotalPoints: number;
  publishedSkills: PublicPublishedSkill[];
  recentPosts: PublicRecentPost[];
};

type UserEnv = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
  DB?: D1Database;
  PORTAL_AUTH_SERVICE_TOKEN?: string;
};

type UserContext<TEnv extends UserEnv> = EventContext<TEnv, string, unknown>;

type UserDeps<TEnv extends UserEnv> = {
  audit(
    db: D1Database | undefined,
    actorType: string,
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>
  ): Promise<string>;
  httpError(status: number, message: string): Error;
  normalizeAvatarUrl(value: unknown): string;
  normalizeEditableRole(value: unknown): UserRole;
  normalizeIdentityProvider(value: unknown): IdentityProvider;
  normalizeProfileDepartment(value: unknown): string;
  normalizeRole(value: unknown): UserRole;
  optionalText(value: unknown, maxLength: number): string;
  readBody<T>(request: Request): Promise<T>;
  requireAdminPortalUser(context: UserContext<TEnv>): Promise<CurrentUser>;
  requireDb(db: D1Database | undefined): D1Database;
  requireText(value: unknown, errorCode: string, maxLength: number): string;
  resolveCurrentUser(context: UserContext<TEnv>): Promise<CurrentUser>;
  userProfileColumns(db: D1Database): Promise<UserProfileColumns>;
};

const AUTH_USER_ROLE_SYNC_TIMEOUT_MS = 8000;

export function createUsersApi<TEnv extends UserEnv>(deps: UserDeps<TEnv>) {
  return {
    async listUserDepartments(context: UserContext<TEnv>) {
      await deps.resolveCurrentUser(context);
      const baseUrl = context.env.AUTH_WORKER_URL?.trim().replace(/\/+$/, "");
      const serviceToken = context.env.PORTAL_AUTH_SERVICE_TOKEN?.trim() || context.env.AUTH_SERVICE_TOKEN?.trim();
      if (!baseUrl || !serviceToken) throw deps.httpError(503, "auth_departments_unavailable");

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/v1/admin/departments`, {
          headers: { accept: "application/json", authorization: `Bearer ${serviceToken}` },
          signal: AbortSignal.timeout(8000)
        });
      } catch {
        throw deps.httpError(503, "auth_departments_unavailable");
      }
      if (!response.ok) throw deps.httpError(503, "auth_departments_unavailable");
      const payload = await response.json().catch(() => ({})) as { departments?: unknown };
      if (!Array.isArray(payload.departments)) throw deps.httpError(503, "auth_departments_unavailable");
      return payload.departments.flatMap((row): Array<{ id: string; name: string; parentId?: string; path?: string[]; status?: "active" | "inactive" }> => {
        if (!row || typeof row !== "object") throw deps.httpError(503, "auth_departments_unavailable");
        const item = row as Record<string, unknown>;
        const id = readString(item.id).trim();
        const name = readString(item.name).trim();
        if (!id || !name) throw deps.httpError(503, "auth_departments_unavailable");
        return [{ id, name,
          ...(readOptionalString(item.parentId) ? { parentId: readOptionalString(item.parentId) } : {}),
          ...(Array.isArray(item.path) ? { path: item.path.map(readString).filter(Boolean) } : {}),
          ...(item.status === "active" || item.status === "inactive" ? { status: item.status } : {})
        }];
      });
    },

    async readUserAvatar(context: UserContext<TEnv>, profileUserId: string) {
      const db = deps.requireDb(context.env.DB);
      await deps.resolveCurrentUser(context);
      const userColumns = await deps.userProfileColumns(db);
      if (!userColumns.avatarUrl) {
        throw deps.httpError(404, "user_avatar_not_found");
      }
      const row = await db
        .prepare("SELECT avatar_url AS avatarUrl FROM users WHERE id = ? AND status = 'active' LIMIT 1")
        .bind(profileUserId)
        .first<Record<string, unknown>>();
      const response = userAvatarImageResponse(
        row?.avatarUrl,
        new URL(context.request.url).searchParams.get("v"),
        context.request.headers
      );
      if (!response) {
        throw deps.httpError(404, "user_avatar_not_found");
      }
      return response;
    },

    async readUserBatch(context: UserContext<TEnv>) {
      const db = deps.requireDb(context.env.DB);
      await deps.resolveCurrentUser(context);
      const url = new URL(context.request.url);
      const ids = Array.from(
        new Set(
          url.searchParams
            .getAll("ids")
            .flatMap((value) => value.split(","))
            .map((value) => value.trim())
            .filter(Boolean)
        )
      ).slice(0, 100);

      if (ids.length === 0) {
        return [];
      }

      const userColumns = await deps.userProfileColumns(db);
      const hasJourneyState = await hasPortalJourneyStateTable(db);
      const journeySelect = hasJourneyState
        ? `
            portal_user_journey_state.current_level_key AS journeyLevelKey,
            portal_user_journey_state.total_points AS journeyTotalPoints,
            portal_user_journey_state.community_contribution_points AS journeyCommunityContributionPoints
          `
        : `
            NULL AS journeyLevelKey,
            0 AS journeyTotalPoints,
            0 AS journeyCommunityContributionPoints
          `;
      const journeyJoin = hasJourneyState
        ? "LEFT JOIN portal_user_journey_state ON portal_user_journey_state.user_id = users.id"
        : "";
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await db
        .prepare(
          `
          SELECT
            users.id,
            users.name,
            users.email,
            ${userColumns.avatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS avatarUrl,
            user_identity_profiles.department,
            ${userColumns.departmentId ? "user_identity_profiles.department_id" : "''"} AS departmentId,
            ${userColumns.departmentPathJson ? "user_identity_profiles.department_path_json" : "'[]'"} AS departmentPathJson,
            user_identity_profiles.job_title AS jobTitle,
            user_identity_profiles.profile_json AS profileJson,
            teams.name AS team,
            ${journeySelect}
          FROM users
          JOIN teams ON teams.id = users.team_id
          LEFT JOIN user_identity_profiles ON user_identity_profiles.user_id = users.id
          ${journeyJoin}
          WHERE users.status = 'active'
            AND users.id IN (${placeholders})
          ORDER BY users.name
          `
        )
        .bind(...ids)
        .all<Record<string, unknown>>();

      return (rows.results ?? []).map((row) => {
        const journeyLevelKey = readOptionalJourneyLevelKey(row.journeyLevelKey);

        return {
          id: readString(row.id),
          name: readString(row.name),
          email: readString(row.email),
          avatarUrl: cacheableUserAvatarUrl(row.id, row.avatarUrl),
          team: "",
          department: readOptionalString(row.department),
          ...(readOptionalString(row.departmentId) ? { departmentId: readOptionalString(row.departmentId) } : {}),
          ...(readJsonStringList(row.departmentPathJson).length > 0
            ? { departmentPath: readJsonStringList(row.departmentPathJson) }
            : {}),
          jobTitle: readOptionalString(row.jobTitle),
          bio: readOptionalString(profileJsonObject(row.profileJson).bio),
          journeyCommunityContributionPoints: readNumber(row.journeyCommunityContributionPoints),
          journeyTotalPoints: readNumber(row.journeyTotalPoints),
          ...(journeyLevelKey ? { journeyLevelKey } : {})
        };
      });
    },

    async readUserProfile(context: UserContext<TEnv>, profileUserId: string): Promise<PublicUserProfile> {
      const db = deps.requireDb(context.env.DB);
      await deps.resolveCurrentUser(context);
      const userColumns = await deps.userProfileColumns(db);
      const row = await db
        .prepare(
          `
          SELECT
            users.id,
            users.name,
            users.email,
            ${userColumns.avatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS avatarUrl,
            users.role,
            users.status,
            user_identity_profiles.department,
            ${userColumns.departmentId ? "user_identity_profiles.department_id" : "''"} AS departmentId,
            ${userColumns.departmentPathJson ? "user_identity_profiles.department_path_json" : "'[]'"} AS departmentPathJson,
            user_identity_profiles.job_title AS jobTitle,
            user_identity_profiles.profile_json AS profileJson,
            teams.name AS team
          FROM users
          JOIN teams ON teams.id = users.team_id
          LEFT JOIN user_identity_profiles ON user_identity_profiles.user_id = users.id
          WHERE users.id = ?
          LIMIT 1
          `
        )
        .bind(profileUserId)
        .first<Record<string, unknown>>();

      if (!row || String(row.status) !== "active") {
        throw deps.httpError(404, "user_not_found");
      }

      const [journey, recentPosts, publishedSkills] = await Promise.all([
        readPublicJourneySummary(db, profileUserId),
        readPublicRecentPosts(db, profileUserId),
        readPublicPublishedSkills(db, profileUserId)
      ]);

      return {
        id: String(row.id),
        name: String(row.name),
        email: String(row.email),
        avatarUrl: cacheableUserAvatarUrl(row.id, row.avatarUrl),
        team: "",
        ...profileDetailsFromRow(row),
        role: deps.normalizeRole(row.role),
        ...journey,
        recentPosts,
        publishedSkills
      };
    },

    async updateUserProfile(context: UserContext<TEnv>, profileUserId: string): Promise<CurrentUser> {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.resolveCurrentUser(context);

      if (profileUserId !== currentUser.id) {
        throw deps.httpError(403, "profile_update_not_allowed");
      }

      const body = await deps.readBody<{ name?: string; avatarUrl?: string; bio?: string; jobTitle?: string; location?: string }>(context.request);
      const name = deps.requireText(body.name, "missing_profile_name", 120);
      const submittedAvatarUrl = body.avatarUrl ?? currentUser.avatarUrl ?? "";
      const currentCacheUrl = cacheableUserAvatarUrl(currentUser.id, currentUser.avatarUrl);
      const avatarUrl = deps.normalizeAvatarUrl(
        submittedAvatarUrl === currentCacheUrl ? currentUser.avatarUrl ?? "" : submittedAvatarUrl
      );
      const bio = deps.optionalText(body.bio, 280);
      const jobTitle = deps.optionalText(body.jobTitle, 120);
      const location = deps.optionalText(body.location, 80);

      if (!avatarUrl) {
        throw deps.httpError(400, "missing_profile_avatar");
      }

      if (!bio) {
        throw deps.httpError(400, "missing_profile_bio");
      }

      const userColumns = await deps.userProfileColumns(db);
      const existingIdentity = await db
        .prepare(
          `
          SELECT
            department,
            ${userColumns.departmentId ? "department_id" : "''"} AS departmentId,
            ${userColumns.departmentPathJson ? "department_path_json" : "'[]'"} AS departmentPathJson,
            job_title AS jobTitle,
            profile_json AS profileJson
          FROM user_identity_profiles
          WHERE user_id = ?
          LIMIT 1
          `
        )
        .bind(currentUser.id)
        .first<Record<string, unknown>>();
      const nextProfileJson = {
        ...profileJsonObject(existingIdentity?.profileJson),
        bio,
        location
      };
      const department = readString(existingIdentity?.department) || currentUser.department || "";
      const departmentId = readString(existingIdentity?.departmentId) || currentUser.departmentId || "";
      const existingDepartmentPath = readJsonStringList(existingIdentity?.departmentPathJson);
      const departmentPath = existingDepartmentPath.length > 0 ? existingDepartmentPath : currentUser.departmentPath ?? [];

      if (userColumns.avatarUrl) {
        await db
          .prepare(
            `
            UPDATE users
            SET name = ?,
                avatar_url = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `
          )
          .bind(name, avatarUrl, currentUser.id)
          .run();
      } else {
        await db
          .prepare(
            `
            UPDATE users
            SET name = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `
          )
          .bind(name, currentUser.id)
          .run();
      }

      const orgColumnNames = [
        userColumns.departmentId ? "department_id" : "",
        userColumns.departmentPathJson ? "department_path_json" : ""
      ].filter(Boolean);
      const orgPlaceholders = orgColumnNames.map(() => "?");
      const orgUpdateLines = [
        userColumns.departmentId ? "department_id = excluded.department_id" : "",
        userColumns.departmentPathJson ? "department_path_json = excluded.department_path_json" : ""
      ].filter(Boolean);
      const orgValues = [
        ...(userColumns.departmentId ? [departmentId] : []),
        ...(userColumns.departmentPathJson ? [JSON.stringify(departmentPath)] : [])
      ];

      await db
        .prepare(
          `
          INSERT INTO user_identity_profiles (
            user_id,
            provider,
            provider_tenant_id,
            provider_subject_id,
            principal_name,
            email,
            display_name,
            department,
            ${orgColumnNames.length > 0 ? `${orgColumnNames.join(",")},` : ""}
            job_title,
            profile_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${orgPlaceholders.length > 0 ? `${orgPlaceholders.join(",")},` : ""} ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            display_name = excluded.display_name,
            department = excluded.department,
            ${orgUpdateLines.length > 0 ? `${orgUpdateLines.join(",")},` : ""}
            job_title = excluded.job_title,
            profile_json = excluded.profile_json,
            synced_at = CURRENT_TIMESTAMP
          `
        )
        .bind(
          currentUser.id,
          currentUser.identity.provider,
          currentUser.identity.tenantId,
          currentUser.identity.objectId,
          currentUser.identity.principalName,
          currentUser.email,
          name,
          department,
          ...orgValues,
          jobTitle,
          JSON.stringify(nextProfileJson)
        )
        .run();

      await deps.audit(db, "user", currentUser.id, "updated profile", "user", currentUser.id, {
        nameChanged: name !== currentUser.name,
        avatarChanged: avatarUrl !== (currentUser.avatarUrl ?? ""),
        bioChanged: bio !== (currentUser.bio ?? ""),
        departmentChanged: false,
        jobTitleChanged: jobTitle !== (currentUser.jobTitle ?? ""),
        locationChanged: location !== (currentUser.location ?? "")
      });

      const row = await db
        .prepare(
          `
          SELECT
            users.id,
            users.name,
            users.email,
            ${userColumns.avatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS avatarUrl,
            users.role,
            users.status,
            user_identity_profiles.department,
            ${userColumns.departmentId ? "user_identity_profiles.department_id" : "''"} AS departmentId,
            ${userColumns.departmentPathJson ? "user_identity_profiles.department_path_json" : "'[]'"} AS departmentPathJson,
            user_identity_profiles.job_title AS jobTitle,
            user_identity_profiles.profile_json AS profileJson,
            user_identity_profiles.provider,
            user_identity_profiles.provider_tenant_id AS tenantId,
            user_identity_profiles.provider_subject_id AS objectId,
            user_identity_profiles.principal_name AS principalName,
            teams.name AS team
          FROM users
          JOIN teams ON teams.id = users.team_id
          LEFT JOIN user_identity_profiles ON user_identity_profiles.user_id = users.id
          WHERE users.id = ?
          LIMIT 1
          `
        )
        .bind(currentUser.id)
        .first<Record<string, unknown>>();

      if (!row) {
        throw deps.httpError(404, "user_not_found");
      }

      return {
        id: String(row.id),
        name: String(row.name),
        email: String(row.email),
        avatarUrl: cacheableUserAvatarUrl(row.id, row.avatarUrl),
        team: "",
        ...profileDetailsFromRow(row),
        role: deps.normalizeRole(row.role),
        identity: {
          provider: deps.normalizeIdentityProvider(row.provider),
          tenantId: readString(row.tenantId) || currentUser.identity.tenantId,
          objectId: readString(row.objectId) || currentUser.identity.objectId,
          principalName: readString(row.principalName) || currentUser.identity.principalName
        }
      };
    },

    async updateAdminUserRole(context: UserContext<TEnv>, userId: string) {
      const db = deps.requireDb(context.env.DB);
      const currentUser = await deps.requireAdminPortalUser(context);
      const body = await deps.readBody<{ role?: string; roles?: unknown }>(context.request);
      const roles = body.roles === undefined
        ? deps.normalizeEditableRole(body.role) === "admin" ? ["admin"] as const : []
        : normalizeEditableAssignedRoles(body.roles);
      const role: UserRole = roles.includes("admin") ? "admin" : "member";
      const existingUser = await db
        .prepare(
          `
          SELECT
            id,
            role,
            status
          FROM users
          WHERE id = ?
          LIMIT 1
          `
        )
        .bind(userId)
        .first<{ id: string; role: string; status: string }>();

      if (!existingUser || existingUser.status === "deleted") {
        throw deps.httpError(404, "user_not_found");
      }

      if (role === "member" && deps.normalizeRole(existingUser.role) === "admin") {
        const adminCount = await db
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM users
            WHERE status = 'active'
              AND role = 'admin'
              AND id != ?
            `
          )
          .bind(userId)
          .first<{ count: number }>();

        if (readNumber(adminCount?.count) === 0) {
          throw deps.httpError(400, "last_admin_required");
        }
      }

      try {
        await syncAuthUserRole(context.env, userId, role);
      } catch {
        throw deps.httpError(502, "auth_user_role_sync_failed");
      }

      const statements: D1PreparedStatement[] = [
        db.prepare("DELETE FROM user_roles WHERE user_id = ?").bind(userId),
        ...roles.map((assignedRole) => db
          .prepare(
            `
            INSERT INTO user_roles (user_id, role, assigned_by_user_id)
            VALUES (?, ?, ?)
            `
          )
          .bind(userId, assignedRole, currentUser.id)),
        db
          .prepare(
            `
            UPDATE users
            SET role = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `
          )
          .bind(role, userId)
      ];

      await db.batch(statements);

      await deps.audit(db, "user", currentUser.id, "updated user role", "user", userId, {
        role,
        roles,
        previousRole: deps.normalizeRole(existingUser.role)
      });

      return await readAdminUserProfile(db, userId, deps);
    }
  };
}

export async function syncAuthUserRole<TEnv extends UserEnv>(
  env: TEnv,
  userId: string,
  role: UserRole,
  fetchImpl: typeof fetch = fetch
) {
  const baseUrl = env.AUTH_WORKER_URL?.trim().replace(/\/+$/, "");
  const serviceToken = env.AUTH_SERVICE_TOKEN?.trim();

  if (!baseUrl || !serviceToken) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_USER_ROLE_SYNC_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${baseUrl}/v1/admin/users/${encodeURIComponent(userId)}/role`, {
      method: "PATCH",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ role }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error("auth_user_role_sync_failed");
    }

    return true;
  } finally {
    clearTimeout(timeout);
  }
}

type PublicJourneySummary = {
  journeyBadgeCount: number;
  journeyBadges: PublicJourneyBadge[];
  journeyCommunityContributionPoints: number;
  journeyLevelKey: PortalJourneyLevelKey;
  journeyTotalPoints: number;
};

const emptyPublicJourneySummary: PublicJourneySummary = {
  journeyBadgeCount: 0,
  journeyBadges: [],
  journeyCommunityContributionPoints: 0,
  journeyLevelKey: "newcomer",
  journeyTotalPoints: 0
};

async function readPublicJourneySummary(db: D1Database, userId: string): Promise<PublicJourneySummary> {
  let persistedSummary = emptyPublicJourneySummary;
  let hasPersistedSummary = false;

  try {
    const row = await db
      .prepare(
        `
        SELECT
          current_level_key AS currentLevelKey,
          total_points AS totalPoints,
          community_contribution_points AS communityContributionPoints,
          badge_count AS badgeCount
        FROM portal_user_journey_state
        WHERE user_id = ?
        LIMIT 1
        `
      )
      .bind(userId)
      .first<Record<string, unknown>>();

    if (row) {
      hasPersistedSummary = true;
      persistedSummary = {
        journeyBadgeCount: readNumber(row.badgeCount),
        journeyBadges: [],
        journeyCommunityContributionPoints: readNumber(row.communityContributionPoints),
        journeyLevelKey: readJourneyLevelKey(row.currentLevelKey),
        journeyTotalPoints: readNumber(row.totalPoints)
      };
    }
  } catch (error) {
    if (!isMissingOptionalProfileTable(error, ["portal_user_journey_state"])) {
      throw error;
    }
  }

  let rows: Record<string, unknown>[];

  try {
    const result = await db
      .prepare(
        `
        SELECT
          portal_user_badges.badge_key AS badgeKey,
          portal_badge_definitions.category,
          portal_badge_definitions.name_zh AS nameZh,
          portal_badge_definitions.name_en AS nameEn,
          portal_badge_definitions.description_zh AS descriptionZh,
          portal_badge_definitions.description_en AS descriptionEn,
          portal_badge_definitions.points,
          portal_user_badges.awarded_at AS awardedAt
        FROM portal_user_badges
        JOIN portal_badge_definitions
          ON portal_badge_definitions.badge_key = portal_user_badges.badge_key
        WHERE portal_user_badges.user_id = ?
        ORDER BY portal_user_badges.awarded_at DESC, portal_badge_definitions.sort_order
        `
      )
      .bind(userId)
      .all<Record<string, unknown>>();
    rows = result.results ?? [];
  } catch (error) {
    if (isMissingOptionalProfileTable(error, ["portal_user_badges", "portal_badge_definitions"])) {
      return persistedSummary;
    }
    throw error;
  }

  const journeyBadgesWithCategory = rows.map((row) => ({
    badgeKey: readString(row.badgeKey),
    category: readJourneyBadgeCategory(row.category),
    nameZh: readString(row.nameZh),
    nameEn: readString(row.nameEn),
    descriptionZh: readString(row.descriptionZh),
    descriptionEn: readString(row.descriptionEn),
    points: readNumber(row.points),
    awardedAt: readString(row.awardedAt)
  }));
  const journeyTotalPoints = journeyBadgesWithCategory.reduce((total, badge) => total + badge.points, 0);
  const journeyBadges: PublicJourneyBadge[] = journeyBadgesWithCategory.map(({ category: _category, ...badge }) => badge);

  return {
    journeyBadgeCount: hasPersistedSummary ? persistedSummary.journeyBadgeCount : journeyBadges.length,
    journeyBadges,
    journeyCommunityContributionPoints: persistedSummary.journeyCommunityContributionPoints,
    journeyLevelKey: hasPersistedSummary
      ? persistedSummary.journeyLevelKey
      : resolvePortalJourneyLevel(journeyTotalPoints, journeyBadgesWithCategory).key,
    journeyTotalPoints: hasPersistedSummary ? persistedSummary.journeyTotalPoints : journeyTotalPoints
  };
}

async function readPublicRecentPosts(db: D1Database, userId: string): Promise<PublicRecentPost[]> {
  try {
    const rows = await db
      .prepare(
        `
        SELECT
          forum_topics.id,
          forum_topics.title,
          forum_topics.reply_count AS replyCount,
          forum_topics.created_at AS createdAt
        FROM forum_topics
        WHERE forum_topics.author_user_id = ?
          AND forum_topics.status != 'archived'
        ORDER BY forum_topics.created_at DESC
        LIMIT 5
        `
      )
      .bind(userId)
      .all<Record<string, unknown>>();

    return (rows.results ?? []).map((row) => ({
      id: readString(row.id),
      title: readString(row.title),
      createdAt: readString(row.createdAt),
      replyCount: readNumber(row.replyCount)
    }));
  } catch (error) {
    if (isMissingOptionalProfileTable(error, ["forum_topics"])) {
      return [];
    }
    throw error;
  }
}

async function readPublicPublishedSkills(db: D1Database, userId: string): Promise<PublicPublishedSkill[]> {
  try {
    const rows = await db
      .prepare(
        `
        SELECT
          publication_listings.id,
          publication_listings.target_id AS targetId,
          publication_listings.name,
          publication_listings.summary,
          publication_listings.cover_image_url AS coverImageUrl,
          publication_listings.install_count AS installs,
          COALESCE(publication_listings.published_at, publication_listings.updated_at) AS publishedAt
        FROM publication_listings
        WHERE publication_listings.created_by_user_id = ?
          AND publication_listings.listing_type = 'skill'
          AND publication_listings.effective_status = 'listed'
          AND publication_listings.visibility = 'org'
        ORDER BY COALESCE(publication_listings.published_at, publication_listings.updated_at) DESC,
                 publication_listings.name
        `
      )
      .bind(userId)
      .all<Record<string, unknown>>();

    return (rows.results ?? []).map((row) => ({
      id: readString(row.id),
      targetId: readString(row.targetId),
      name: readString(row.name),
      summary: readString(row.summary),
      coverImageUrl: cacheableCatalogImageUrl("skill", row.targetId, row.coverImageUrl),
      installs: readNumber(row.installs),
      publishedAt: readString(row.publishedAt)
    }));
  } catch (error) {
    if (isMissingOptionalProfileTable(error, ["publication_listings"])) {
      return [];
    }
    throw error;
  }
}

export async function loadAdminUsers<TEnv extends UserEnv>(db: D1Database, userColumns: UserProfileColumns, deps: Pick<UserDeps<TEnv>, "normalizeIdentityProvider" | "normalizeRole">) {
  const hasJourneyState = await hasPortalJourneyStateTable(db);
  const hasUserRoles = await hasUserRolesTable(db);
  const journeySelect = hasJourneyState
    ? `
        portal_user_journey_state.current_level_key AS journeyLevelKey,
        portal_user_journey_state.total_points AS journeyTotalPoints,
        portal_user_journey_state.badge_count AS journeyBadgeCount,
      `
    : `
        'newcomer' AS journeyLevelKey,
        0 AS journeyTotalPoints,
        0 AS journeyBadgeCount,
      `;
  const journeyJoin = hasJourneyState
    ? "LEFT JOIN portal_user_journey_state ON portal_user_journey_state.user_id = users.id"
    : "";
  const users = await db
    .prepare(
      `
      SELECT
        users.id,
        users.name,
        users.email,
        ${userColumns.avatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS avatarUrl,
        users.role,
        ${hasUserRoles ? "COALESCE((SELECT group_concat(user_roles.role) FROM user_roles WHERE user_roles.user_id = users.id), '')" : "''"} AS roles,
        users.status,
        users.created_at AS createdAt,
        users.last_seen_at AS lastSeenAt,
        teams.name AS team,
        user_identity_profiles.department,
        ${userColumns.departmentId ? "user_identity_profiles.department_id" : "''"} AS departmentId,
        ${userColumns.departmentPathJson ? "user_identity_profiles.department_path_json" : "'[]'"} AS departmentPathJson,
        user_identity_profiles.job_title AS jobTitle,
        user_identity_profiles.profile_json AS profileJson,
        ${journeySelect}
        user_identity_profiles.provider AS identityProvider,
        user_identity_profiles.principal_name AS principalName
      FROM users
      JOIN teams ON teams.id = users.team_id
      LEFT JOIN user_identity_profiles ON user_identity_profiles.user_id = users.id
      ${journeyJoin}
      WHERE users.status != 'deleted'
      ORDER BY COALESCE(users.last_seen_at, users.created_at) DESC, users.name
      LIMIT 500
      `
    )
    .all<Record<string, unknown>>();

  return (users.results ?? []).map((row) => adminUserFromRow(row, deps));
}

async function readAdminUserProfile<TEnv extends UserEnv>(
  db: D1Database,
  userId: string,
  deps: Pick<UserDeps<TEnv>, "httpError" | "normalizeIdentityProvider" | "normalizeRole" | "userProfileColumns">,
  userColumns?: UserProfileColumns
) {
  const columns = userColumns ?? await deps.userProfileColumns(db);
  const hasJourneyState = await hasPortalJourneyStateTable(db);
  const hasUserRoles = await hasUserRolesTable(db);
  const journeySelect = hasJourneyState
    ? `
        portal_user_journey_state.current_level_key AS journeyLevelKey,
        portal_user_journey_state.total_points AS journeyTotalPoints,
        portal_user_journey_state.badge_count AS journeyBadgeCount,
      `
    : `
        'newcomer' AS journeyLevelKey,
        0 AS journeyTotalPoints,
        0 AS journeyBadgeCount,
      `;
  const journeyJoin = hasJourneyState
    ? "LEFT JOIN portal_user_journey_state ON portal_user_journey_state.user_id = users.id"
    : "";
  const row = await db
    .prepare(
      `
      SELECT
        users.id,
        users.name,
        users.email,
        ${columns.avatarUrl ? "COALESCE(users.avatar_url, '')" : "''"} AS avatarUrl,
        users.role,
        ${hasUserRoles ? "COALESCE((SELECT group_concat(user_roles.role) FROM user_roles WHERE user_roles.user_id = users.id), '')" : "''"} AS roles,
        users.status,
        users.created_at AS createdAt,
        users.last_seen_at AS lastSeenAt,
        teams.name AS team,
        user_identity_profiles.department,
        ${columns.departmentId ? "user_identity_profiles.department_id" : "''"} AS departmentId,
        ${columns.departmentPathJson ? "user_identity_profiles.department_path_json" : "'[]'"} AS departmentPathJson,
        user_identity_profiles.job_title AS jobTitle,
        user_identity_profiles.profile_json AS profileJson,
        ${journeySelect}
        user_identity_profiles.provider AS identityProvider,
        user_identity_profiles.principal_name AS principalName
      FROM users
      JOIN teams ON teams.id = users.team_id
      LEFT JOIN user_identity_profiles ON user_identity_profiles.user_id = users.id
      ${journeyJoin}
      WHERE users.id = ?
      LIMIT 1
      `
    )
    .bind(userId)
    .first<Record<string, unknown>>();

  if (!row) {
    throw deps.httpError(404, "user_not_found");
  }

  return adminUserFromRow(row, deps);
}

function adminUserFromRow<TEnv extends UserEnv>(
  row: Record<string, unknown>,
  deps: Pick<UserDeps<TEnv>, "normalizeIdentityProvider" | "normalizeRole">
) {
  const details = profileDetailsFromRow(row);

  return {
    id: readString(row.id),
    name: readString(row.name),
    email: readString(row.email),
    avatarUrl: cacheableUserAvatarUrl(row.id, row.avatarUrl),
    team: "",
    department: details.department,
    jobTitle: details.jobTitle,
    journeyLevelKey: readJourneyLevelKey(row.journeyLevelKey),
    journeyTotalPoints: readNumber(row.journeyTotalPoints),
    journeyBadgeCount: readNumber(row.journeyBadgeCount),
    bio: details.bio,
    location: details.location,
    role: deps.normalizeRole(row.role),
    roles: normalizeAssignedRoles(row.roles, row.role),
    status: readString(row.status) || "active",
    lastSeenAt: readOptionalString(row.lastSeenAt),
    createdAt: readOptionalString(row.createdAt),
    identityProvider: deps.normalizeIdentityProvider(row.identityProvider),
    principalName: readOptionalString(row.principalName)
  };
}

async function hasPortalJourneyStateTable(db: D1Database) {
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'portal_user_journey_state' LIMIT 1")
      .first<{ name: string }>();

    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readOptionalString(value: unknown) {
  const text = readString(value).trim();
  return text.length > 0 ? text : undefined;
}

function readJourneyLevelKey(value: unknown): PortalJourneyLevelKey {
  return readOptionalJourneyLevelKey(value) ?? "newcomer";
}

function readOptionalJourneyLevelKey(value: unknown): PortalJourneyLevelKey | undefined {
  const key = readString(value);
  return key === "newcomer" || key === "explorer" || key === "contributor" || key === "builder" || key === "master"
    ? key
    : undefined;
}

function readJourneyBadgeCategory(value: unknown): PortalJourneyBadgeCategory {
  const category = readString(value);
  return category === "community" || category === "usage" || category === "builder" || category === "impact"
    ? category
    : "foundation";
}

function isMissingOptionalProfileTable(error: unknown, tableNames: string[]) {
  const message = error instanceof Error ? error.message : readString(error);
  const normalized = message.toLowerCase();

  return /no such table|does not exist/i.test(message)
    && tableNames.some((tableName) => normalized.includes(tableName.toLowerCase()));
}

function readNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
