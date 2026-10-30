import { HttpError } from "../http.ts";
import type { Env, NamespaceRow, Principal } from "../types.ts";
import { slugPart } from "../values.ts";

const DEFAULT_BUCKET = "workspace-knowledge-objects";

export async function ensurePersonalNamespace(env: Env, principal: Principal) {
  const existing = await env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_namespaces WHERE org_id = ? AND owner_user_id = ? AND kind = 'personal' AND status != 'archived' LIMIT 1")
    .bind(principal.orgId, principal.sub)
    .first<NamespaceRow>();
  if (existing) {
    return existing;
  }

  const orgId = principal.orgId;
  const namespaceId = `kns_${crypto.randomUUID()}`;
  const topDepartmentId = slugPart(principal.departmentPath[0] || principal.departmentId || principal.department || "default");
  const r2Prefix = `org/${slugPart(orgId)}/dept/${topDepartmentId}/ns/${namespaceId}`;
  const name = `${principal.name}'s Knowledge`;
  const slug = slugPart(`${principal.name}-${principal.sub}`).slice(0, 80) || namespaceId;

  await env.KNOWLEDGE_DB
    .prepare(
      `
      INSERT INTO knowledge_namespaces (
        id, org_id, owner_user_id, kind, name, slug, storage_mode, r2_bucket_name, r2_prefix, status, quota_bytes, used_bytes
      )
      VALUES (?, ?, ?, 'personal', ?, ?, 'shared_bucket', ?, ?, 'ready', 0, 0)
      `
    )
    .bind(namespaceId, orgId, principal.sub, name, slug, DEFAULT_BUCKET, r2Prefix)
    .run();

  const namespace = await env.KNOWLEDGE_DB.prepare("SELECT * FROM knowledge_namespaces WHERE id = ?").bind(namespaceId).first<NamespaceRow>();
  if (!namespace) {
    throw new HttpError(500, "namespace_create_failed");
  }
  return namespace;
}
