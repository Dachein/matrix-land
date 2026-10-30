import type { NamespaceRow } from "../types.ts";

export function namespaceJson(row: NamespaceRow) {
  return {
    id: row.id,
    name: row.name,
    orgId: row.org_id,
    ownerUserId: row.owner_user_id,
    r2BucketName: row.r2_bucket_name,
    r2Prefix: row.r2_prefix,
    slug: row.slug,
    status: row.status,
    usedBytes: row.used_bytes
  };
}
