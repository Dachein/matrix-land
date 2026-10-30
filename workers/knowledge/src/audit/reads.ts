import type { Env, Principal, ObjectRow } from "../types.ts";
import { HttpError } from "../http.ts";
import { knowledgeObjectIncludingDeleted } from "../objects/history.ts";
import { readLimit } from "../query/text.ts";
import { escapeLike } from "../sql.ts";
import { readString } from "../values.ts";
import {
  requireObject,
  requireRootObjectForMutation,
  requireNamespaceForPrincipal
} from "../objects/repository.ts";
import { accessRoleForObject } from "../access/authorization.ts";
import { roleHasKnowledgeCapability } from "../access/policy.ts";

export async function listKnowledgeChanges(
  env: Env,
  principal: Principal,
  filters: {
    action: string;
    category: string;
    cursor: string;
    limit: string;
    objectId: string;
    query: string;
    sourceChannel: string;
  }
) {
  if (!filters.objectId) {
    throw new HttpError(400, "knowledge_audit_object_id_required");
  }
  const object = await knowledgeObjectIncludingDeleted(env, filters.objectId);
  const root = await requireRootForAuditObject(env, object);
  await requireKnowledgeChangeAuditAccess(env, principal, root);
  const cursor = decodeKnowledgeAuditCursor(filters.cursor);
  const limit = readLimit(filters.limit, 10, 100);
  const query = filters.query.trim();
  if (query.length > 240 || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new HttpError(400, "knowledge_audit_query_invalid");
  }
  const category = filters.category.trim().toLowerCase();
  const categoryOperations = knowledgeAuditCategoryOperations(category);
  const where: string[] = [];
  const bindings: unknown[] = [];
  if (object.id === root.id) {
    where.push("change_set.root_object_id = ?");
    bindings.push(object.id);
  } else if (object.object_kind === "folder") {
    const scopePaths = await knowledgeAuditFolderPaths(env, object);
    const pathClauses = scopePaths.map(
      () =>
        `(item.path_before = ? OR item.path_after = ?
          OR item.path_before LIKE ? ESCAPE '\\'
          OR item.path_after LIKE ? ESCAPE '\\')`
    );
    where.push(
      `EXISTS (
         SELECT 1 FROM knowledge_change_items item
         WHERE item.change_set_id = change_set.id
           AND (
             item.object_id = ?
             ${pathClauses.length > 0 ? `OR ${pathClauses.join(" OR ")}` : ""}
           )
       )`
    );
    bindings.push(object.id);
    for (const path of scopePaths) {
      const descendantPattern = `${escapeLike(path)}/%`;
      bindings.push(path, path, descendantPattern, descendantPattern);
    }
  } else {
    where.push(
      "EXISTS (SELECT 1 FROM knowledge_change_items item WHERE item.change_set_id = change_set.id AND item.object_id = ?)"
    );
    bindings.push(object.id);
  }
  if (categoryOperations.length > 0) {
    where.push(`change_set.operation IN (${categoryOperations.map(() => "?").join(", ")})`);
    bindings.push(...categoryOperations);
  }
  if (filters.action) {
    where.push("EXISTS (SELECT 1 FROM knowledge_change_items item WHERE item.change_set_id = change_set.id AND item.action = ?)");
    bindings.push(filters.action);
  }
  if (filters.sourceChannel) {
    where.push("change_set.source_channel = ?");
    bindings.push(filters.sourceChannel);
  }
  if (query) {
    const pattern = `%${escapeLike(query.toLowerCase())}%`;
    where.push(
      `(lower(change_set.operation) LIKE ? ESCAPE '\\'
        OR lower(change_set.summary) LIKE ? ESCAPE '\\'
        OR lower(change_set.actor_user_id) LIKE ? ESCAPE '\\'
        OR lower(change_set.actor_email) LIKE ? ESCAPE '\\'
        OR lower(change_set.source_channel) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM knowledge_change_items item
          WHERE item.change_set_id = change_set.id
            AND (
              lower(item.action) LIKE ? ESCAPE '\\'
              OR lower(item.object_id) LIKE ? ESCAPE '\\'
              OR lower(item.path_before) LIKE ? ESCAPE '\\'
              OR lower(item.path_after) LIKE ? ESCAPE '\\'
            )
        ))`
    );
    bindings.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (cursor) {
    where.push("(change_set.created_at < ? OR (change_set.created_at = ? AND change_set.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT change_set.*,
              (SELECT COUNT(*) FROM knowledge_change_items item WHERE item.change_set_id = change_set.id) AS resolved_item_count
       FROM knowledge_change_sets AS change_set
       WHERE ${where.join(" AND ")}
       ORDER BY change_set.created_at DESC, change_set.id DESC
       LIMIT ?`
    )
    .bind(...bindings, limit + 1)
    .all<Record<string, unknown>>();
  const hasMore = (rows.results?.length ?? 0) > limit;
  const selected = (rows.results ?? []).slice(0, limit);
  const last = selected.at(-1);
  const scopePath = await knowledgeAuditScopePath(env, object);
  return {
    changes: selected.map(knowledgeChangeSetJson),
    nextCursor: hasMore && last
      ? encodeKnowledgeAuditCursor(readString(last.created_at), readString(last.id))
      : null,
    rootObjectId: root.id,
    scope: {
      includesDescendants: object.object_kind === "folder",
      kind: object.object_kind === "folder" ? "folder" : "file",
      objectId: object.id,
      path: scopePath
    }
  };
}

async function knowledgeAuditScopePath(env: Env, object: ObjectRow) {
  if (!object.path.startsWith("/.workspace-deleted/")) {
    return object.path;
  }
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT path_before, path_after
       FROM knowledge_change_items
       WHERE object_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 20`
    )
    .bind(object.id)
    .all<Record<string, unknown>>();
  for (const row of rows.results ?? []) {
    for (const candidate of [readString(row.path_after), readString(row.path_before)]) {
      if (candidate && !candidate.startsWith("/.workspace-deleted/")) {
        return candidate;
      }
    }
  }
  return object.file_name || object.path;
}

async function knowledgeAuditFolderPaths(env: Env, object: ObjectRow) {
  const paths: string[] = [];
  const addPath = (value: string) => {
    if (value && !value.startsWith("/.workspace-deleted/") && !paths.includes(value)) {
      paths.push(value);
    }
  };
  addPath(object.path);
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT path_before, path_after
       FROM knowledge_change_items
       WHERE object_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 100`
    )
    .bind(object.id)
    .all<Record<string, unknown>>();
  for (const row of rows.results ?? []) {
    addPath(readString(row.path_after));
    addPath(readString(row.path_before));
  }
  return paths;
}

function knowledgeAuditCategoryOperations(category: string) {
  const categories: Record<string, string[]> = {
    "": [],
    all: [],
    create: ["create", "folder_create"],
    edit: ["update", "edit", "batch_edit"],
    import: ["zip_import"],
    lifecycle: ["delete", "restore", "restore_version"],
    structure: ["rename", "move", "folder_rename", "folder_move"]
  };
  const operations = categories[category];
  if (!operations) {
    throw new HttpError(400, "knowledge_audit_category_invalid");
  }
  return operations;
}

export async function readKnowledgeChange(env: Env, principal: Principal, changeSetId: string) {
  const changeSet = await env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_change_sets WHERE id = ?")
    .bind(changeSetId)
    .first<Record<string, unknown>>();
  if (!changeSet) {
    throw new HttpError(404, "knowledge_change_set_not_found");
  }
  const root = await requireObject(env, readString(changeSet.root_object_id));
  await requireKnowledgeChangeAuditAccess(env, principal, root);
  const items = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT id, change_set_id, root_object_id, object_id, action, edit_operation,
              path_before, path_after, version_before_id, version_after_id,
              sha256_before, sha256_after, size_before, size_after,
              mime_type_before, mime_type_after, expected_version_id, forced,
              diff_status, diff_format, diff_sha256, diff_size_bytes,
              diff_original_size_bytes, diff_line_count, diff_generator_version,
              error_code, created_at
       FROM knowledge_change_items
       WHERE change_set_id = ?
       ORDER BY created_at, id`
    )
    .bind(changeSetId)
    .all<Record<string, unknown>>();
  return {
    change: knowledgeChangeSetJson(changeSet),
    items: (items.results ?? []).map(knowledgeChangeItemJson)
  };
}

export async function readKnowledgeDiff(
  env: Env,
  principal: Principal,
  changeItemId: string,
  options: { maxBytes: string }
) {
  const item = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT item.*, change_set.root_object_id AS resolved_root_object_id
       FROM knowledge_change_items AS item
       JOIN knowledge_change_sets AS change_set ON change_set.id = item.change_set_id
       WHERE item.id = ?`
    )
    .bind(changeItemId)
    .first<Record<string, unknown>>();
  if (!item) {
    throw new HttpError(404, "knowledge_change_item_not_found");
  }
  const root = await requireObject(env, readString(item.resolved_root_object_id));
  await requireKnowledgeChangeAuditAccess(env, principal, root);
  const diffStatus = readString(item.diff_status);
  if (diffStatus !== "ready") {
    return { changeItemId, diffStatus };
  }
  const r2Object = await env.KNOWLEDGE_OBJECTS.get(readString(item.diff_r2_key));
  if (!r2Object) {
    throw new HttpError(409, "knowledge_diff_object_missing");
  }
  const requestedMax = Number(options.maxBytes);
  const maxBytes = Number.isFinite(requestedMax)
    ? Math.max(1_024, Math.min(1_000_000, Math.trunc(requestedMax)))
    : 200_000;
  const bytes = new Uint8Array(await r2Object.arrayBuffer());
  const selected = bytes.slice(0, maxBytes);
  return {
    changeItemId,
    diff: new TextDecoder().decode(selected),
    diffFormat: readString(item.diff_format),
    diffSha256: readString(item.diff_sha256),
    diffStatus,
    originalSizeBytes: Number(item.diff_original_size_bytes ?? bytes.byteLength),
    returnedSizeBytes: selected.byteLength,
    truncated: bytes.byteLength > selected.byteLength
  };
}

async function requireRootForAuditObject(env: Env, object: ObjectRow) {
  if (!object.parent_path && object.object_kind === "folder") {
    return object;
  }
  const rootId = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT root_object_id AS id
       FROM knowledge_change_items
       WHERE object_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(object.id)
    .first<{ id: string }>();
  if (rootId?.id) {
    return requireObject(env, rootId.id);
  }
  return requireRootObjectForMutation(env, object);
}

export async function requireKnowledgeChangeAuditAccess(env: Env, principal: Principal, root: ObjectRow) {
  const namespace = await requireNamespaceForPrincipal(env, root.namespace_id, principal);
  const role = await accessRoleForObject(env, namespace, root, principal);
  if (!roleHasKnowledgeCapability(role, "readChangeAudit")) {
    throw new HttpError(403, "knowledge_change_audit_denied");
  }
}

function knowledgeChangeSetJson(row: Record<string, unknown>) {
  return {
    actor: {
      agentType: readString(row.actor_agent_type),
      clientId: readString(row.actor_client_id),
      connectionId: readString(row.actor_connection_id),
      email: readString(row.actor_email),
      type: readString(row.actor_type),
      userId: readString(row.actor_user_id)
    },
    createdAt: readString(row.created_at),
    id: readString(row.id),
    itemCount: Number(row.resolved_item_count ?? row.item_count ?? 0),
    operation: readString(row.operation),
    requestId: readString(row.request_id),
    rootObjectId: readString(row.root_object_id),
    sourceChannel: readString(row.source_channel),
    summary: readString(row.summary)
  };
}

function knowledgeChangeItemJson(row: Record<string, unknown>) {
  return {
    action: readString(row.action),
    changeSetId: readString(row.change_set_id),
    createdAt: readString(row.created_at),
    diff: {
      format: readString(row.diff_format),
      generatorVersion: readString(row.diff_generator_version),
      lineCount: Number(row.diff_line_count ?? 0),
      originalSizeBytes: Number(row.diff_original_size_bytes ?? 0),
      sha256: readString(row.diff_sha256),
      sizeBytes: Number(row.diff_size_bytes ?? 0),
      status: readString(row.diff_status)
    },
    editOperation: readString(row.edit_operation),
    expectedVersionId: readString(row.expected_version_id),
    id: readString(row.id),
    objectId: readString(row.object_id),
    pathAfter: readString(row.path_after),
    pathBefore: readString(row.path_before),
    versionAfterId: readString(row.version_after_id),
    versionBeforeId: readString(row.version_before_id)
  };
}

function encodeKnowledgeAuditCursor(createdAt: string, id: string) {
  return btoa(JSON.stringify({ createdAt, id }));
}

function decodeKnowledgeAuditCursor(value: string) {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(atob(value)) as Record<string, unknown>;
    const createdAt = readString(parsed.createdAt);
    const id = readString(parsed.id);
    return createdAt && id ? { createdAt, id } : undefined;
  } catch {
    throw new HttpError(400, "invalid_knowledge_audit_cursor");
  }
}
