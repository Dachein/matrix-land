import { accessRoleForObject } from "../access/authorization.ts";
import { roleHasKnowledgeCapability } from "../access/policy.ts";
import { writeAuditEvent } from "../audit/events.ts";
import { HttpError } from "../http.ts";
import { isKnowledgeServiceHandbookObject } from "../objects/access.ts";
import { currentKnowledgeIngestionState, requireNamespaceForPrincipal, requireObject } from "../objects/repository.ts";
import { objectJsonForPrincipal } from "../objects/representation.ts";
import type { Env, NamespaceRow, ObjectRow, Principal, ShareRow } from "../types.ts";
import { activePublicShareForObject } from "./repository.ts";
import {
  isUniqueConstraintError,
  normalizePublicShareExpiry,
  publicShareExpiresAt,
  publicShareUrl,
  randomShareSlug,
  shareJson
} from "./values.ts";

export async function createPublicShare(env: Env, principal: Principal, objectId: string, body: Record<string, unknown>) {
  const object = await requireObject(env, objectId);
  if (object.object_kind === "folder") {
    throw new HttpError(400, "folder_public_share_not_supported");
  }
  const namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
  const actorRole = await accessRoleForObject(env, namespace, object, principal);
  if (!roleHasKnowledgeCapability(actorRole, "createPublicShare")) {
    throw new HttpError(403, "knowledge_share_denied");
  }
  if (await isKnowledgeServiceHandbookObject(env, object.id)) {
    throw new HttpError(409, "knowledge_service_handbook_public_share_not_allowed");
  }
  const ingestion = await currentKnowledgeIngestionState(env, object);
  if (ingestion !== "clean") {
    throw new HttpError(409, "knowledge_file_not_scan_clean");
  }

  const expiry = normalizePublicShareExpiry(body.expiry ?? body.expiresIn ?? body.expires_in);
  const share = await insertPublicShare(env, namespace, object, principal, expiry);
  await writeAuditEvent(env, {
    action: "knowledge.public_share.create",
    metadata: { expiry, shareId: share.id },
    namespace,
    objectId: object.id,
    principal
  });
  return {
    active: true,
    item: { ...(await objectJsonForPrincipal(env, { ...object, share_mode: "public" }, principal)), shareMode: "public" },
    share: shareJson(share, env),
    url: publicShareUrl(env, share.slug)
  };
}

export async function getPublicShare(env: Env, principal: Principal, objectId: string) {
  const object = await requireObject(env, objectId);
  if (object.object_kind === "folder") {
    throw new HttpError(400, "folder_public_share_not_supported");
  }
  const namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
  const actorRole = await accessRoleForObject(env, namespace, object, principal);
  if (!roleHasKnowledgeCapability(actorRole, "createPublicShare")) {
    throw new HttpError(403, "knowledge_share_denied");
  }
  const share = await activePublicShareForObject(env, object.id);
  return share
    ? { active: true, share: shareJson(share, env), url: publicShareUrl(env, share.slug) }
    : { active: false, share: null, url: null };
}

export async function revokePublicShare(env: Env, principal: Principal, objectId: string) {
  const object = await requireObject(env, objectId);
  if (object.object_kind === "folder") {
    throw new HttpError(400, "folder_public_share_not_supported");
  }
  const namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
  const actorRole = await accessRoleForObject(env, namespace, object, principal);
  if (!roleHasKnowledgeCapability(actorRole, "createPublicShare")) {
    throw new HttpError(403, "knowledge_share_denied");
  }
  const active = await activePublicShareForObject(env, object.id);
  if (!active) {
    return { revoked: false, active: false, share: null };
  }
  await env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_shares
       SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE object_id = ? AND visibility = 'public' AND revoked_at IS NULL`
    )
    .bind(object.id)
    .run();
  await writeAuditEvent(env, {
    action: "knowledge.public_share.revoke",
    metadata: { shareId: active.id },
    namespace,
    objectId: object.id,
    principal
  });
  return { revoked: true, active: false, share: { ...shareJson(active, env), revokedAt: new Date().toISOString() } };
}

async function insertPublicShare(env: Env, namespace: NamespaceRow, object: ObjectRow, principal: Principal, expiry: "24h" | "permanent") {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const share = {
      id: `kshare_${crypto.randomUUID()}`,
      slug: randomShareSlug()
    };
    try {
      // Keep the previous link active unless its replacement commits successfully.
      // Expired but non-revoked rows also occupy the partial unique index.
      await env.KNOWLEDGE_DB.batch([
        env.KNOWLEDGE_DB.prepare(
          `UPDATE knowledge_shares
           SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE object_id = ? AND visibility = 'public' AND revoked_at IS NULL`
        ).bind(object.id),
        env.KNOWLEDGE_DB
          .prepare(
            `
            INSERT INTO knowledge_shares (
              id, namespace_id, object_id, slug, visibility, role, created_by_user_id, expires_at
            )
            VALUES (?, ?, ?, ?, 'public', 'viewer', ?, ?)
            `
          )
          .bind(share.id, namespace.id, object.id, share.slug, principal.sub, publicShareExpiresAt(expiry))
      ]);
      const row = await env.KNOWLEDGE_DB.prepare("SELECT * FROM knowledge_shares WHERE id = ?").bind(share.id).first<ShareRow>();
      if (!row) {
        throw new HttpError(500, "knowledge_public_share_create_failed");
      }
      return row;
    } catch (error) {
      // A lost batch response may follow a successful commit; preserve that result.
      const committed = await env.KNOWLEDGE_DB.prepare("SELECT * FROM knowledge_shares WHERE id = ?").bind(share.id).first<ShareRow>();
      if (committed) return committed;
      if (attempt < 3 && isUniqueConstraintError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new HttpError(500, "knowledge_public_share_create_failed");
}
