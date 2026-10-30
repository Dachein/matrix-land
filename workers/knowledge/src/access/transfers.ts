import { writeAuditEvent } from "../audit/events.ts";
import { safeErrorMessage } from "../errors.ts";
import { HttpError } from "../http.ts";
import { activeRootOwnerGrant } from "../objects/access.ts";
import { requireNamespaceForPrincipal, requireObject } from "../objects/repository.ts";
import { objectJsonForPrincipal } from "../objects/representation.ts";
import { publicSharesCreatedByUsersRevokeStatement } from "../shares/revocation.ts";
import type { Env, Principal, RootOwnerTransferRow } from "../types.ts";
import { readBoolean } from "../values.ts";
import { accessRoleForObject } from "./authorization.ts";
import { roleHasKnowledgeCapability, validateSubjectId } from "./policy.ts";

export async function listRootOwnerTransfers(
  env: Env,
  principal: Principal,
  rawRootObjectId: string
) {
  const rootObjectId = rawRootObjectId.trim();
  if (rootObjectId) {
    const root = await requireObject(env, rootObjectId);
    const namespace = await requireNamespaceForPrincipal(env, root.namespace_id, principal);
    const role = await accessRoleForObject(env, namespace, root, principal);
    const canManageTransfers = roleHasKnowledgeCapability(role, "transferOwnership")
      || principal.sub === (await activeRootOwnerGrant(env, root.id))?.subject_id;
    if (canManageTransfers) {
      const rows = await env.KNOWLEDGE_DB
        .prepare(
          `SELECT * FROM knowledge_root_owner_transfers
           WHERE root_object_id = ?
           ORDER BY created_at DESC
           LIMIT 100`
        )
        .bind(root.id)
        .all<RootOwnerTransferRow>();
      return (rows.results ?? []).map(rootOwnerTransferJson);
    }
    const rows = await env.KNOWLEDGE_DB
      .prepare(
        `SELECT * FROM knowledge_root_owner_transfers
         WHERE root_object_id = ?
           AND (from_user_id = ? OR to_user_id = ?)
         ORDER BY created_at DESC
         LIMIT 100`
      )
      .bind(root.id, principal.sub, principal.sub)
      .all<RootOwnerTransferRow>();
    if ((rows.results ?? []).length === 0) {
      throw new HttpError(403, "knowledge_owner_transfer_denied");
    }
    return (rows.results ?? []).map(rootOwnerTransferJson);
  }
  const rows = await env.KNOWLEDGE_DB
    .prepare(
      `SELECT transfer.*
       FROM knowledge_root_owner_transfers AS transfer
       JOIN knowledge_namespaces AS namespace ON namespace.id = transfer.namespace_id
       WHERE namespace.org_id = ?
         AND (transfer.from_user_id = ? OR transfer.to_user_id = ?)
       ORDER BY transfer.created_at DESC
       LIMIT 100`
    )
    .bind(principal.orgId, principal.sub, principal.sub)
    .all<RootOwnerTransferRow>();
  return (rows.results ?? []).map(rootOwnerTransferJson);
}

export async function initiateRootOwnerTransfer(
  env: Env,
  principal: Principal,
  rootObjectId: string,
  body: Record<string, unknown>
) {
  const root = await requireObject(env, rootObjectId);
  const namespace = await requireNamespaceForPrincipal(env, root.namespace_id, principal);
  if (root.object_kind !== "folder" || root.parent_path) {
    throw new HttpError(400, "knowledge_owner_transfer_root_required");
  }
  const role = await accessRoleForObject(env, namespace, root, principal);
  if (!roleHasKnowledgeCapability(role, "transferOwnership")) {
    throw new HttpError(403, "knowledge_owner_transfer_denied");
  }
  const ownerGrant = await activeRootOwnerGrant(env, root.id);
  if (!ownerGrant) {
    throw new HttpError(409, "knowledge_root_owner_missing");
  }
  const toUserId = validateSubjectId(body.toUserId ?? body.to_user_id, "user", namespace.org_id);
  if (toUserId === ownerGrant.subject_id) {
    throw new HttpError(400, "knowledge_owner_transfer_same_user");
  }
  const retainPreviousOwner = body.retainPreviousOwner === undefined
    && body.retain_previous_owner === undefined
    ? true
    : readBoolean(body.retainPreviousOwner ?? body.retain_previous_owner);
  await env.KNOWLEDGE_DB
    .prepare(
      `UPDATE knowledge_root_owner_transfers
       SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE root_object_id = ?
         AND status = 'pending'
         AND expires_at IS NOT NULL
         AND datetime(expires_at) <= CURRENT_TIMESTAMP`
    )
    .bind(root.id)
    .run();
  const id = `ktransfer_${crypto.randomUUID()}`;
  try {
    await env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_root_owner_transfers (
           id, namespace_id, root_object_id, from_user_id, to_user_id,
           status, initiated_by_user_id, retain_previous_owner, expires_at
         ) VALUES (
           ?, ?, ?, ?, ?, 'pending', ?, ?, datetime(CURRENT_TIMESTAMP, '+7 days')
         )`
      )
      .bind(
        id,
        namespace.id,
        root.id,
        ownerGrant.subject_id,
        toUserId,
        principal.sub,
        retainPreviousOwner ? 1 : 0
      )
      .run();
  } catch (error) {
    if (/unique/i.test(safeErrorMessage(error))) {
      throw new HttpError(409, "knowledge_owner_transfer_already_pending");
    }
    throw error;
  }
  const transfer = await requireRootOwnerTransfer(env, id);
  await writeAuditEvent(env, {
    action: "knowledge.owner_transfer.initiate",
    metadata: {
      fromUserId: transfer.from_user_id,
      retainPreviousOwner,
      toUserId: transfer.to_user_id,
      transferId: transfer.id
    },
    namespace,
    objectId: root.id,
    principal
  });
  return { transfer: rootOwnerTransferJson(transfer), root: await objectJsonForPrincipal(env, root, principal) };
}

export async function decideRootOwnerTransfer(
  env: Env,
  principal: Principal,
  transferId: string,
  action: "accept" | "reject" | "cancel"
) {
  let transfer = await requireRootOwnerTransfer(env, transferId);
  const namespace = await requireNamespaceForPrincipal(env, transfer.namespace_id, principal);
  const root = await requireObject(env, transfer.root_object_id);
  if (transfer.status !== "pending") {
    if (action === "accept" && transfer.status === "accepted" && transfer.to_user_id === principal.sub) {
      return { transfer: rootOwnerTransferJson(transfer), root: await objectJsonForPrincipal(env, root, principal) };
    }
    throw new HttpError(409, "knowledge_owner_transfer_not_pending");
  }
  if (transfer.expires_at && Date.parse(transfer.expires_at) <= Date.now()) {
    await env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_root_owner_transfers
         SET status = 'expired', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`
      )
      .bind(transfer.id)
      .run();
    throw new HttpError(409, "knowledge_owner_transfer_expired");
  }
  if (action === "cancel") {
    if (principal.sub !== transfer.from_user_id && !principal.breakGlassReason) {
      throw new HttpError(403, "knowledge_owner_transfer_cancel_denied");
    }
  } else if (principal.sub !== transfer.to_user_id) {
    throw new HttpError(403, "knowledge_owner_transfer_recipient_required");
  }

  if (action !== "accept") {
    const status = action === "reject" ? "rejected" : "cancelled";
    const decided = await env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_root_owner_transfers
         SET status = ?, decided_by_user_id = ?, decided_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`
      )
      .bind(status, principal.sub, transfer.id)
      .run();
    if (!decided.meta.changes) throw new HttpError(409, "knowledge_owner_transfer_not_pending");
    transfer = await requireRootOwnerTransfer(env, transfer.id);
    await writeAuditEvent(env, {
      action: `knowledge.owner_transfer.${action}`,
      metadata: { transferId: transfer.id },
      namespace,
      objectId: root.id,
      principal
    });
    return { transfer: rootOwnerTransferJson(transfer), root: await objectJsonForPrincipal(env, root, principal) };
  }

  const newOwnerPermissionId = `kperm_${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_root_owner_transfers
         SET status = CASE
               WHEN status = 'pending'
                 AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
                 AND EXISTS (
                   SELECT 1 FROM knowledge_permissions
                   WHERE object_id = knowledge_root_owner_transfers.root_object_id
                     AND subject_type = 'user' AND subject_id = knowledge_root_owner_transfers.from_user_id
                     AND role = 'owner' AND revoked_at IS NULL
                     AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
                 )
               THEN 'accepted' ELSE NULL
             END,
             decided_by_user_id = ?, decided_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(principal.sub, transfer.id)
  ];
  if (transfer.retain_previous_owner === 1) {
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_permissions
           SET role = 'editor', can_share = 1, can_publish_skill = 0,
               updated_at = CURRENT_TIMESTAMP
           WHERE object_id = ? AND subject_type = 'user' AND subject_id = ?
             AND role = 'owner' AND revoked_at IS NULL`
        )
        .bind(root.id, transfer.from_user_id)
    );
  } else {
    statements.push(
      env.KNOWLEDGE_DB
        .prepare(
          `UPDATE knowledge_permissions
           SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE object_id = ? AND subject_type = 'user' AND subject_id = ?
             AND role = 'owner' AND revoked_at IS NULL`
        )
        .bind(root.id, transfer.from_user_id)
    );
  }
  statements.push(
    publicSharesCreatedByUsersRevokeStatement(
      env,
      namespace.id,
      root,
      [transfer.from_user_id]
    ),
    env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_permissions
         SET role = 'owner', can_share = 1, can_publish_skill = 0,
             expires_at = NULL, granted_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE namespace_id = ? AND object_id = ? AND subject_type = 'user'
           AND subject_id = ? AND revoked_at IS NULL`
      )
      .bind(transfer.from_user_id, namespace.id, root.id, transfer.to_user_id),
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_permissions (
           id, namespace_id, object_id, subject_type, subject_id, role,
           can_share, can_publish_skill, granted_by_user_id, expires_at
         )
         SELECT ?, ?, ?, 'user', ?, 'owner', 1, 0, ?, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM knowledge_permissions
           WHERE namespace_id = ? AND object_id = ? AND subject_type = 'user'
             AND subject_id = ? AND revoked_at IS NULL
         )`
      )
      .bind(
        newOwnerPermissionId,
        namespace.id,
        root.id,
        transfer.to_user_id,
        transfer.from_user_id,
        namespace.id,
        root.id,
        transfer.to_user_id
      ),
    env.KNOWLEDGE_DB
      .prepare(
        `INSERT INTO knowledge_permission_provenance (
           permission_id, grant_source, source_id
         )
         SELECT id, 'direct', ?
         FROM knowledge_permissions
         WHERE namespace_id = ? AND object_id = ? AND subject_type = 'user'
           AND subject_id = ? AND role = 'owner' AND revoked_at IS NULL
         ON CONFLICT(permission_id) DO UPDATE SET
           grant_source = 'direct',
           source_id = excluded.source_id,
           updated_at = CURRENT_TIMESTAMP`
      )
      .bind(root.id, namespace.id, root.id, transfer.to_user_id)
  );
  try {
    // The existing NOT NULL constraint aborts every ownership/link change if this decision lost the race.
    await env.KNOWLEDGE_DB.batch(statements);
  } catch (error) {
    const current = await requireRootOwnerTransfer(env, transfer.id);
    if (current.status !== "accepted" || current.to_user_id !== principal.sub) {
      if (current.status !== "pending") throw new HttpError(409, "knowledge_owner_transfer_not_pending");
      if (current.expires_at && Date.parse(current.expires_at) <= Date.now()) {
        throw new HttpError(409, "knowledge_owner_transfer_expired");
      }
      if ((await activeRootOwnerGrant(env, root.id))?.subject_id !== transfer.from_user_id) {
        throw new HttpError(409, "knowledge_owner_transfer_owner_changed");
      }
      throw error;
    }
    // Reconcile a lost commit response through the normal audit and response path.
  }
  transfer = await requireRootOwnerTransfer(env, transfer.id);
  await writeAuditEvent(env, {
    action: "knowledge.owner_transfer.accept",
    metadata: {
      fromUserId: transfer.from_user_id,
      retainPreviousOwner: transfer.retain_previous_owner === 1,
      toUserId: transfer.to_user_id,
      transferId: transfer.id
    },
    namespace,
    objectId: root.id,
    principal
  });
  return { transfer: rootOwnerTransferJson(transfer), root: await objectJsonForPrincipal(env, root, principal) };
}

async function requireRootOwnerTransfer(env: Env, transferId: string) {
  const transfer = await env.KNOWLEDGE_DB
    .prepare("SELECT * FROM knowledge_root_owner_transfers WHERE id = ? LIMIT 1")
    .bind(transferId)
    .first<RootOwnerTransferRow>();
  if (!transfer) {
    throw new HttpError(404, "knowledge_owner_transfer_not_found");
  }
  return transfer;
}

function rootOwnerTransferJson(row: RootOwnerTransferRow) {
  return {
    id: row.id,
    rootObjectId: row.root_object_id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    status: row.status,
    retainPreviousOwner: row.retain_previous_owner === 1,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
