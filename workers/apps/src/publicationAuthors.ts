import { collaboratorUserIdsFromJson } from "./core/collaborators";
import { HttpError, type Principal } from "./core/types";

export type PublicationAuthorProjection = {
  ownerUserId: string;
  collaboratorUserIds: string[];
};

type PublicationAuthorRow = {
  collaborator_user_ids_json?: string;
  owner_user_id: string;
};

export async function readPublicationAuthorProjection(
  db: D1Database,
  principal: Principal,
  targetType: "app" | "skill",
  targetId: string
): Promise<PublicationAuthorProjection> {
  if (principal.tokenType !== "apps_publication_review") {
    throw new HttpError(403, "publication_review_token_required");
  }

  const tokenTargetId = targetType === "app" ? principal.appId : principal.skillId;
  if (!tokenTargetId || tokenTargetId !== targetId) {
    throw new HttpError(403, "publication_review_target_mismatch");
  }

  const table = targetType === "app" ? "apps_apps" : "apps_skills";
  const row = await db
    .prepare(
      `
      SELECT owner_user_id, collaborator_user_ids_json
      FROM ${table}
      WHERE id = ? AND org_id = ?
      LIMIT 1
      `
    )
    .bind(targetId, principal.orgId)
    .first<PublicationAuthorRow>();

  if (!row) {
    throw new HttpError(404, targetType === "app" ? "apps_app_not_found" : "apps_skill_not_found");
  }

  return {
    ownerUserId: row.owner_user_id,
    collaboratorUserIds: collaboratorUserIdsFromJson(row.collaborator_user_ids_json)
  };
}
