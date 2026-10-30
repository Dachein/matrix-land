import type { Env, NamespaceRow, Principal } from "./types.ts";
import { json, readJson, HttpError } from "./http.ts";
import { requirePublicShare } from "./shares/repository.ts";
import { requireObject, requireNamespaceForPrincipal } from "./objects/repository.ts";
import { renderViewer, rawObjectResponse } from "./viewer/render.ts";
import { resolvePrincipal, listWritableFolderRows } from "./requestIdentity.ts";
import { effectiveKnowledgePolicy } from "./policy.ts";
import {
  submitKnowledgeFeedback,
  knowledgeFeedbackSourceChannel,
  listKnowledgeFeedback,
  listMyKnowledgeFeedback,
  readKnowledgeFeedback,
  updateKnowledgeFeedback
} from "./feedback/service.ts";
import { readString } from "./values.ts";
import { assertKnowledgeOpsPrincipal, knowledgeOpsMetrics } from "./indexing/operations.ts";
import { requireKnowledgeService } from "./services/repository.ts";
import { dispatchKnowledgeIndexOutbox } from "./indexing/outbox.ts";
import { ensurePersonalNamespace } from "./namespaces/repository.ts";
import { namespaceJson } from "./namespaces/representation.ts";
import {
  requireReadableObject,
  requireWritableObject,
  assertObjectMutationAllowed
} from "./objects/access.ts";
import { normalizePath } from "./paths.ts";
import { listObjects, listSharedWithMe } from "./objects/listing.ts";
import { objectJsonListForPrincipal, objectJsonForPrincipal, versionJson } from "./objects/representation.ts";
import { createFolder } from "./mutations/folders.ts";
import { mutationContextFromRequest, requireArgString } from "./mutations/context.ts";
import { uploadFile, uploadNewVersion } from "./mutations/uploads.ts";
import { listObjectVersions } from "./objects/history.ts";
import { restoreObjectVersion, restoreDeletedObject } from "./mutations/restore.ts";
import { editKnowledgeFile, editKnowledgeBatch } from "./mutations/edits.ts";
import { renameObject } from "./mutations/rename.ts";
import { moveObject } from "./mutations/move.ts";
import {
  initiateRootOwnerTransfer,
  listRootOwnerTransfers,
  decideRootOwnerTransfer
} from "./access/transfers.ts";
import { deleteObject } from "./mutations/delete.ts";
import { assertKnowledgeAdminReadPrincipal, listAdminKnowledgeServices } from "./services/admin.ts";
import {
  listKnowledgeServices,
  readKnowledgeService,
  readKnowledgeServiceHandbook
} from "./services/reads.ts";
import { knowledgeServicePreflight } from "./services/preflight.ts";
import { publishKnowledgeService, updateKnowledgeService } from "./services/lifecycle.ts";
import { updateKnowledgeServiceInfo } from "./services/info.ts";
import { listKnowledgeChanges, readKnowledgeChange, readKnowledgeDiff } from "./audit/reads.ts";
import { executeKnowledgeServiceQuery } from "./query/execute.ts";
import { knowledgeFolderTextQuery } from "./query/folder.ts";
import { listAccess, createAccessGrant, revokeAccessGrant } from "./access/grants.ts";
import { permissionJson } from "./access/representation.ts";
import { replaceFolderCollaborators } from "./access/collaborators.ts";
import { createPublicShare, getPublicShare, revokePublicShare } from "./shares/public.ts";

const READ_SCOPES = ["workspace:knowledge:read", "workspace:knowledge:admin"];

const WRITE_SCOPES = ["workspace:knowledge:write", "workspace:knowledge:admin"];

const SHARE_SCOPES = ["workspace:knowledge:share", "workspace:knowledge:admin"];

export async function handleRequest(request: Request, env: Env, requestId: string) {
  const url = new URL(request.url);
  const path = normalizeRoutePath(url.pathname);

  if (request.method === "GET" && path === "/health") {
    return json({ ok: true, service: "workspace-knowledge-worker", requestId });
  }

  const publicShareMatch = path.match(/^\/public\/([^/]+)$/);
  if (publicShareMatch?.[1] && request.method === "GET") {
    const share = await requirePublicShare(env, decodeURIComponent(publicShareMatch[1]));
    const object = await requireObject(env, share.object_id);
    return await renderViewer(env, object, { embedded: true, cacheControl: "public, no-cache, must-revalidate", rawUrl: `${url.pathname}/raw` });
  }

  const publicRawMatch = path.match(/^\/public\/([^/]+)\/(raw|download)$/);
  if (publicRawMatch?.[1] && publicRawMatch[2] && request.method === "GET") {
    const share = await requirePublicShare(env, decodeURIComponent(publicRawMatch[1]));
    const object = await requireObject(env, share.object_id);
    return await rawObjectResponse(env, object, request, {
      disposition: publicRawMatch[2] === "download" ? "attachment" : "inline",
      cacheControl: "public, no-cache, must-revalidate"
    });
  }

  if (request.method === "GET" && path === "/api/session") {
    const principal = await resolvePrincipal(request, env);
    return json({ principal: publicPrincipal(principal), requestId });
  }

  if (request.method === "GET" && path === "/api/capabilities") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    return json({
      capabilities: {
        audit: ["change_list", "change_get", "diff_read"],
        editExtensions: [".txt", ".md", ".markdown", ".csv", ".json", ".jsonl", ".ndjson", ".html", ".htm"],
        editOperations: ["replace_text", "append_text", "replace_content", "apply_patch", "batch"],
        feedback: ["submit", "list_mine", "get", "list", "status_update"],
        ownerTransfer: ["list", "initiate", "accept", "reject", "cancel"],
        previewKinds: ["markdown", "text", "html", "image", "pdf", "binary_download"],
        search: {
          bodyExtensions: [
            ".txt", ".md", ".markdown", ".csv", ".json", ".jsonl", ".ndjson",
            ".html", ".htm", ".tsv", ".xml", ".yaml", ".yml", ".sql", ".js",
            ".ts", ".tsx", ".jsx", ".css"
          ],
          engine: "d1_fts_lexical",
          metadataDiscovery: ["tree", "glob"],
          nonTextBodySearch: false
        },
        serviceActions: ["handbook", "tree", "glob", "search", "grep", "read"],
        upload: { anyBinary: true, zipExtract: true, zipStore: true }
      },
      policy: effectiveKnowledgePolicy(env),
      requestId,
      schemaVersion: "workspace.knowledge-capabilities.v1"
    });
  }

  if (request.method === "GET" && path === "/api/policy/effective") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    return json({ policy: effectiveKnowledgePolicy(env), requestId });
  }

  if (request.method === "POST" && path === "/api/feedback") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const feedback = await submitKnowledgeFeedback(env, principal, body, {
      idempotencyKey:
        request.headers.get("idempotency-key")
        ?? request.headers.get("x-idempotency-key")
        ?? `request:${requestId}`,
      requestId,
      sourceChannel: knowledgeFeedbackSourceChannel(request)
    });
    return json({ feedback, requestId }, { status: feedback.replayed ? 200 : 201 });
  }

  if (request.method === "GET" && path === "/api/feedback") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    return json({
      ...(await listKnowledgeFeedback(env, principal, {
        limit: readString(url.searchParams.get("limit")),
        rootObjectId: readString(url.searchParams.get("rootObjectId") ?? url.searchParams.get("root_object_id")),
        serviceId: readString(url.searchParams.get("serviceId") ?? url.searchParams.get("service_id")),
        status: readString(url.searchParams.get("status"))
      })),
      requestId
    });
  }

  if (request.method === "GET" && path === "/api/feedback/mine") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    return json({
      ...(await listMyKnowledgeFeedback(env, principal, {
        limit: readString(url.searchParams.get("limit")),
        serviceId: readString(url.searchParams.get("serviceId") ?? url.searchParams.get("service_id")),
        status: readString(url.searchParams.get("status"))
      })),
      requestId
    });
  }

  const feedbackMatch = path.match(/^\/api\/feedback\/([^/]+)$/);
  if (feedbackMatch?.[1] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const feedback = await readKnowledgeFeedback(
      env,
      principal,
      decodeURIComponent(feedbackMatch[1])
    );
    return json({ feedback, requestId });
  }
  if (feedbackMatch?.[1] && request.method === "PATCH") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const feedback = await updateKnowledgeFeedback(
      env,
      principal,
      decodeURIComponent(feedbackMatch[1]),
      body
    );
    return json({ feedback, requestId });
  }

  if (request.method === "GET" && path === "/api/ops/status") {
    const principal = await resolvePrincipal(request, env);
    assertKnowledgeOpsPrincipal(principal);
    return json({ metrics: await knowledgeOpsMetrics(env), requestId });
  }

  if (request.method === "POST" && path === "/api/ops/index/replay") {
    const principal = await resolvePrincipal(request, env);
    assertKnowledgeOpsPrincipal(principal);
    const body = await readJson<Record<string, unknown>>(request);
    const serviceId = readString(body.serviceId ?? body.service_id).trim();
    if (!serviceId) {
      throw new HttpError(400, "knowledge_ops_service_id_required");
    }
    await requireKnowledgeService(env, serviceId);
    await env.KNOWLEDGE_DB
      .prepare(
        `UPDATE knowledge_index_outbox
         SET status = 'pending', next_attempt_at = NULL, last_error = '',
             updated_at = CURRENT_TIMESTAMP
         WHERE service_id = ? AND status IN ('failed', 'dispatched', 'dispatching')`
      )
      .bind(serviceId)
      .run();
    await dispatchKnowledgeIndexOutbox(env);
    return json({ replayQueued: true, requestId, serviceId });
  }

  if (request.method === "GET" && path === "/api/namespaces/me") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const namespace = await ensurePersonalNamespace(env, principal);
    return json({ namespace: namespaceJson(namespace), requestId });
  }

  if (request.method === "GET" && path === "/api/tree") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const folderObjectId = readString(url.searchParams.get("folderObjectId") ?? url.searchParams.get("folder_object_id")).trim();
    let namespace: NamespaceRow;
    let prefix: string;
    if (folderObjectId) {
      const folder = await requireReadableObject(env, principal, folderObjectId);
      if (folder.object_kind !== "folder") {
        throw new HttpError(400, "knowledge_tree_target_not_folder");
      }
      namespace = await requireNamespaceForPrincipal(env, folder.namespace_id, principal);
      prefix = folder.path;
    } else {
      namespace = await ensurePersonalNamespace(env, principal);
      prefix = normalizePath(url.searchParams.get("prefix") ?? "");
    }
    const rows = await listObjects(env, namespace.id, prefix, principal.orgId);
    const items = await objectJsonListForPrincipal(env, rows, principal, namespace);
    return json({ items, namespace: namespaceJson(namespace), requestId });
  }

  if (request.method === "POST" && path === "/api/folders") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const parentObjectId = readString(body.parentObjectId ?? body.parent_object_id).trim();
    let namespace: NamespaceRow;
    let parentPath: string;
    if (parentObjectId) {
      const parent = await requireWritableObject(env, principal, parentObjectId);
      if (parent.object_kind !== "folder") {
        throw new HttpError(400, "knowledge_parent_not_folder");
      }
      namespace = await requireNamespaceForPrincipal(env, parent.namespace_id, principal);
      parentPath = parent.path;
    } else {
      namespace = await ensurePersonalNamespace(env, principal);
      parentPath = readString(body.parentPath);
      if (normalizePath(parentPath)) {
        throw new HttpError(400, "knowledge_parent_object_id_required");
      }
    }
    const folder = await createFolder(
      env,
      namespace,
      principal,
      parentPath,
      readString(body.name),
      mutationContextFromRequest(request, requestId, "folder_create", readString(body.expectedCurrentVersionId))
    );
    return json({ item: await objectJsonForPrincipal(env, folder, principal), namespace: namespaceJson(namespace), requestId }, { status: 201 });
  }

  if (request.method === "POST" && path === "/api/files/upload") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const form = await request.formData();
    const parentObjectId = readString(form.get("parentObjectId") ?? form.get("parent_object_id")).trim();
    let namespace: NamespaceRow;
    if (parentObjectId) {
      const parent = await requireWritableObject(env, principal, parentObjectId);
      if (parent.object_kind !== "folder") {
        throw new HttpError(400, "knowledge_parent_not_folder");
      }
      namespace = await requireNamespaceForPrincipal(env, parent.namespace_id, principal);
      form.set("parentPath", parent.path);
      // Object-id targeting is an authorization boundary; a caller-supplied
      // absolute path must not escape the authorized parent folder.
      form.delete("path");
    } else {
      namespace = await ensurePersonalNamespace(env, principal);
    }
    const uploaded = await uploadFile(
      form,
      env,
      namespace,
      principal,
      mutationContextFromRequest(
        request,
        requestId,
        "upload",
        readString(form.get("expectedCurrentVersionId") ?? form.get("expected_current_version_id"))
      )
    );
    const importJobId = "importJobId" in uploaded ? uploaded.importJobId : undefined;
    const uploadedObjects = "objects" in uploaded ? uploaded.objects : undefined;
    const uploadedVersion = "version" in uploaded ? uploaded.version : undefined;
    return json({
      item: await objectJsonForPrincipal(env, uploaded.object, principal),
      importJobId,
      items: uploadedObjects ? await Promise.all(uploadedObjects.map((row) => objectJsonForPrincipal(env, row, principal))) : undefined,
      version: uploadedVersion ? versionJson(uploadedVersion) : undefined,
      namespace: namespaceJson(namespace),
      requestId
    }, { status: 201 });
  }

  const versionUploadMatch = path.match(/^\/api\/files\/([^/]+)\/versions$/);
  if (versionUploadMatch?.[1] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const object = await requireReadableObject(env, principal, decodeURIComponent(versionUploadMatch[1]));
    if (object.object_kind !== "file") {
      throw new HttpError(400, "knowledge_version_target_not_file");
    }
    const versions = await listObjectVersions(env, object.id);
    return json({
      currentVersionId: object.current_version_id,
      item: await objectJsonForPrincipal(env, object, principal),
      requestId,
      versions: versions.map(versionJson)
    });
  }
  if (versionUploadMatch?.[1] && request.method === "POST") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const object = await requireWritableObject(env, principal, decodeURIComponent(versionUploadMatch[1]));
    const namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
    await assertObjectMutationAllowed(env, namespace, object, principal, "content");
    const uploaded = await uploadNewVersion(request, env, namespace, object, principal, requestId);
    return json({ item: await objectJsonForPrincipal(env, uploaded.object, principal), version: versionJson(uploaded.version), namespace: namespaceJson(namespace), requestId }, { status: 201 });
  }

  const versionRestoreMatch = path.match(/^\/api\/files\/([^/]+)\/versions\/([^/]+)\/restore$/);
  if (versionRestoreMatch?.[1] && versionRestoreMatch[2] && request.method === "POST") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const object = await requireWritableObject(env, principal, decodeURIComponent(versionRestoreMatch[1]));
    const namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
    await assertObjectMutationAllowed(env, namespace, object, principal, "content");
    const body = await readJson<Record<string, unknown>>(request);
    const restored = await restoreObjectVersion(
      env,
      namespace,
      object,
      principal,
      decodeURIComponent(versionRestoreMatch[2]),
      mutationContextFromRequest(
        request,
        requestId,
        "restore_version",
        readString(body.expectedCurrentVersionId ?? body.expected_current_version_id)
      )
    );
    return json({
      item: await objectJsonForPrincipal(env, restored.object, principal),
      requestId,
      version: versionJson(restored.version)
    });
  }

  const fileEditMatch = path.match(/^\/api\/files\/([^/]+)\/edit$/);
  if (fileEditMatch?.[1] && request.method === "POST") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const object = await requireWritableObject(env, principal, decodeURIComponent(fileEditMatch[1]));
    const namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
    await assertObjectMutationAllowed(env, namespace, object, principal, "content");
    const body = await readJson<Record<string, unknown>>(request);
    const edited = await editKnowledgeFile(
      env,
      namespace,
      object,
      principal,
      body,
      mutationContextFromRequest(
        request,
        requestId,
        "edit",
        readString(body.expectedCurrentVersionId ?? body.expected_current_version_id)
      )
    );
    return json({ ...edited, requestId });
  }

  if (request.method === "POST" && path === "/api/edit/batch") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const edited = await editKnowledgeBatch(
      env,
      principal,
      body,
      mutationContextFromRequest(request, requestId, "batch_edit")
    );
    return json({ ...edited, requestId });
  }

  const renameMatch = path.match(/^\/api\/objects\/([^/]+)\/rename$/);
  if (renameMatch?.[1] && (request.method === "POST" || request.method === "PATCH")) {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const object = await requireWritableObject(env, principal, decodeURIComponent(renameMatch[1]));
    await assertObjectMutationAllowed(env, await requireNamespaceForPrincipal(env, object.namespace_id, principal), object, principal, "structure");
    const body = await readJson<Record<string, unknown>>(request);
    const renamed = await renameObject(
      env,
      principal,
      object,
      readString(body.name),
      mutationContextFromRequest(request, requestId, "rename", readString(body.expectedCurrentVersionId))
    );
    return json({ item: await objectJsonForPrincipal(env, renamed, principal), requestId });
  }

  const moveMatch = path.match(/^\/api\/objects\/([^/]+)\/move$/);
  if (moveMatch?.[1] && (request.method === "POST" || request.method === "PATCH")) {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const object = await requireWritableObject(env, principal, decodeURIComponent(moveMatch[1]));
    const body = await readJson<Record<string, unknown>>(request);
    const parentObjectId = requireArgString(
      body.parentObjectId ?? body.parent_object_id,
      "knowledge_move_parent_required"
    );
    const parent = await requireWritableObject(env, principal, parentObjectId);
    const namespace = await requireNamespaceForPrincipal(env, object.namespace_id, principal);
    await assertObjectMutationAllowed(env, namespace, object, principal, "structure");
    const moved = await moveObject(
      env,
      principal,
      object,
      parent,
      mutationContextFromRequest(
        request,
        requestId,
        "move",
        readString(body.expectedCurrentVersionId ?? body.expected_current_version_id)
      )
    );
    return json({ item: await objectJsonForPrincipal(env, moved, principal), requestId });
  }

  const ownerTransferMatch = path.match(/^\/api\/objects\/([^/]+)\/owner-transfer$/);
  if (ownerTransferMatch?.[1] && request.method === "POST") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, SHARE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const transfer = await initiateRootOwnerTransfer(
      env,
      principal,
      decodeURIComponent(ownerTransferMatch[1]),
      body
    );
    return json({ ...transfer, requestId }, { status: 201 });
  }

  if (request.method === "GET" && path === "/api/owner-transfers") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, SHARE_SCOPES);
    const transfers = await listRootOwnerTransfers(
      env,
      principal,
      readString(url.searchParams.get("rootObjectId") ?? url.searchParams.get("root_object_id"))
    );
    return json({ transfers, requestId });
  }

  const ownerTransferActionMatch = path.match(/^\/api\/owner-transfers\/([^/]+)\/(accept|reject|cancel)$/);
  if (ownerTransferActionMatch?.[1] && ownerTransferActionMatch[2] && request.method === "POST") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, SHARE_SCOPES);
    const transfer = await decideRootOwnerTransfer(
      env,
      principal,
      decodeURIComponent(ownerTransferActionMatch[1]),
      ownerTransferActionMatch[2] as "accept" | "reject" | "cancel"
    );
    return json({ ...transfer, requestId });
  }

  const restoreMatch = path.match(/^\/api\/objects\/([^/]+)\/restore$/);
  if (restoreMatch?.[1] && request.method === "POST") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const restored = await restoreDeletedObject(
      env,
      principal,
      decodeURIComponent(restoreMatch[1]),
      mutationContextFromRequest(
        request,
        requestId,
        "restore",
        readString(body.expectedCurrentVersionId ?? body.expected_current_version_id)
      )
    );
    return json({
      item: await objectJsonForPrincipal(env, restored.object, principal),
      restoredCount: restored.restoredCount,
      requestId
    });
  }

  const deleteMatch = path.match(/^\/api\/objects\/([^/]+)$/);
  if (deleteMatch?.[1] && request.method === "DELETE") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const object = await requireWritableObject(env, principal, decodeURIComponent(deleteMatch[1]));
    await assertObjectMutationAllowed(env, await requireNamespaceForPrincipal(env, object.namespace_id, principal), object, principal, "delete");
    const deleted = await deleteObject(
      env,
      principal,
      object,
      mutationContextFromRequest(
        request,
        requestId,
        "delete",
        readString(url.searchParams.get("expectedCurrentVersionId") ?? request.headers.get("x-expected-current-version-id"))
      )
    );
    return json({ ...deleted, requestId });
  }

  if (request.method === "GET" && path === "/api/editable-folders") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const includeDescendants = new URL(request.url).searchParams.get("scope") === "all";
    const rows = await listWritableFolderRows(env, principal, includeDescendants);
    const namespaceById = new Map(rows.map((row) => [row.id, row.namespace_id]));
    const items = (await objectJsonListForPrincipal(env, rows, principal))
      .map((item) => ({ ...item, namespaceId: namespaceById.get(item.id) }));
    return json({ items, requestId });
  }

  if (request.method === "GET" && path === "/api/shared-with-me") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const items = await listSharedWithMe(env, principal);
    return json({ items, requestId });
  }

  if (request.method === "GET" && path === "/api/admin/knowledge-services") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    await assertKnowledgeAdminReadPrincipal(request, env, principal);
    const services = await listAdminKnowledgeServices(env, principal);
    return json({
      services,
      summary: {
        companyVisibleCount: services.filter((service) => service.permissionType === "company").length,
        fileCount: services.reduce((total, service) => total + service.fileCount, 0),
        requestCount: services.reduce((total, service) => total + service.requestCount, 0),
        serviceCount: services.length
      },
      requestId
    });
  }

  if (request.method === "GET" && path === "/api/knowledge-services") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const services = await listKnowledgeServices(env, principal, {
      cardView: url.searchParams.get("view") === "card"
    });
    return json({ services, requestId });
  }

  if (request.method === "GET" && path === "/api/knowledge-services/preflight") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const folderObjectId = readString(url.searchParams.get("folderObjectId") ?? url.searchParams.get("folder_object_id")).trim();
    const preflight = await knowledgeServicePreflight(env, principal, folderObjectId);
    return json({ ...preflight, requestId });
  }

  if (request.method === "POST" && (path === "/api/knowledge-services" || path === "/api/knowledge-services/publish")) {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const published = await publishKnowledgeService(env, principal, body);
    return json({ ...published, requestId }, { status: 201 });
  }

  const serviceMatch = path.match(/^\/api\/knowledge-services\/([^/]+)$/);
  if (serviceMatch?.[1] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const service = await readKnowledgeService(env, principal, decodeURIComponent(serviceMatch[1]));
    return json({ ...service, requestId });
  }

  if (serviceMatch?.[1] && request.method === "PATCH") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const service = await updateKnowledgeService(env, principal, decodeURIComponent(serviceMatch[1]), body);
    return json({ ...service, requestId });
  }

  const serviceInfoMatch = path.match(/^\/api\/knowledge-services\/([^/]+)\/info$/);
  if (serviceInfoMatch?.[1] && request.method === "PATCH") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, WRITE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const service = await updateKnowledgeServiceInfo(env, principal, decodeURIComponent(serviceInfoMatch[1]), body);
    return json({ ...service, requestId });
  }

  const serviceHandbookMatch = path.match(/^\/api\/knowledge-services\/([^/]+)\/handbook$/);
  if (serviceHandbookMatch?.[1] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const handbook = await readKnowledgeServiceHandbook(env, principal, decodeURIComponent(serviceHandbookMatch[1]));
    return json({ ...handbook, requestId });
  }

  if (request.method === "GET" && path === "/api/audit/changes") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    return json({
      ...(await listKnowledgeChanges(env, principal, {
        action: readString(url.searchParams.get("action")),
        category: readString(url.searchParams.get("category")),
        cursor: readString(url.searchParams.get("cursor")),
        limit: readString(url.searchParams.get("limit")),
        objectId: readString(url.searchParams.get("objectId") ?? url.searchParams.get("object_id")),
        query: readString(url.searchParams.get("q") ?? url.searchParams.get("query")),
        sourceChannel: readString(url.searchParams.get("sourceChannel") ?? url.searchParams.get("source_channel"))
      })),
      requestId
    });
  }

  const auditChangeMatch = path.match(/^\/api\/audit\/changes\/([^/]+)$/);
  if (auditChangeMatch?.[1] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    return json({
      ...(await readKnowledgeChange(env, principal, decodeURIComponent(auditChangeMatch[1]))),
      requestId
    });
  }

  const auditDiffMatch = path.match(/^\/api\/audit\/change-items\/([^/]+)\/diff$/);
  if (auditDiffMatch?.[1] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    return json({
      ...(await readKnowledgeDiff(env, principal, decodeURIComponent(auditDiffMatch[1]), {
        maxBytes: readString(url.searchParams.get("maxBytes") ?? url.searchParams.get("max_bytes"))
      })),
      requestId
    });
  }

  const servicePackageMatch = path.match(/^\/api\/knowledge-services\/([^/]+)\/package$/);
  if (servicePackageMatch?.[1] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    throw new HttpError(410, "knowledge_service_package_removed", "Knowledge Services are accessed in place and are no longer installable packages.");
  }

  const serviceQueryMatch = path.match(/^\/api\/knowledge-services\/([^/]+)\/query$/);
  if (serviceQueryMatch?.[1] && request.method === "POST") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const serviceId = decodeURIComponent(serviceQueryMatch[1]);
    const body = await readJson<Record<string, unknown>>(request);
    const action = readString(body.action).trim().toLowerCase();
    return json({
      ...(await executeKnowledgeServiceQuery(env, principal, serviceId, action, body, requestId)),
      requestId
    });
  }

  const folderQueryMatch = path.match(/^\/api\/knowledge-folders\/([^/]+)\/query$/);
  if (folderQueryMatch?.[1] && request.method === "POST") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const action = readString(body.action).trim().toLowerCase();
    if (action !== "search" && action !== "grep") {
      throw new HttpError(400, "knowledge_folder_query_action_invalid");
    }
    return json({
      ...(await knowledgeFolderTextQuery(env, principal, decodeURIComponent(folderQueryMatch[1]), action, body)),
      requestId
    });
  }

  const serviceActionMatch = path.match(/^\/api\/knowledge-services\/([^/]+)\/(search|grep|read|tree|glob)$/);
  if (serviceActionMatch?.[1] && serviceActionMatch[2] && request.method === "POST") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const serviceId = decodeURIComponent(serviceActionMatch[1]);
    const body = await readJson<Record<string, unknown>>(request);
    return json({
      ...(await executeKnowledgeServiceQuery(
        env,
        principal,
        serviceId,
        serviceActionMatch[2],
        body,
        requestId
      )),
      requestId
    });
  }

  if (request.method === "GET" && path === "/api/access") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const objectId = readString(url.searchParams.get("objectId"));
    const namespaceId = readString(url.searchParams.get("namespaceId"));
    const access = await listAccess(env, principal, objectId, namespaceId);
    return json({ access, requestId });
  }

  if (request.method === "POST" && path === "/api/access-grants") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, SHARE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const grant = await createAccessGrant(env, principal, body);
    return json({ grant: permissionJson(grant), requestId }, { status: 201 });
  }

  const accessGrantMatch = path.match(/^\/api\/access-grants\/([^/]+)$/);
  if (accessGrantMatch?.[1] && request.method === "DELETE") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, SHARE_SCOPES);
    const result = await revokeAccessGrant(env, principal, decodeURIComponent(accessGrantMatch[1]));
    return json({ ...result, requestId });
  }

  const collaboratorsMatch = path.match(/^\/api\/objects\/([^/]+)\/collaborators$/);
  if (collaboratorsMatch?.[1] && request.method === "PUT") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, SHARE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const result = await replaceFolderCollaborators(env, principal, decodeURIComponent(collaboratorsMatch[1]), body);
    return json({ ...result, requestId });
  }

  const publicShareCreateMatch = path.match(/^\/api\/objects\/([^/]+)\/public-share$/);
  if (publicShareCreateMatch?.[1] && request.method === "POST") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, SHARE_SCOPES);
    const body = await readJson<Record<string, unknown>>(request);
    const shared = await createPublicShare(env, principal, decodeURIComponent(publicShareCreateMatch[1]), body);
    return json({ ...shared, requestId }, { status: 201 });
  }

  if (publicShareCreateMatch?.[1] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, SHARE_SCOPES);
    const shared = await getPublicShare(env, principal, decodeURIComponent(publicShareCreateMatch[1]));
    return json({ ...shared, requestId });
  }

  if (publicShareCreateMatch?.[1] && request.method === "DELETE") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, SHARE_SCOPES);
    const revoked = await revokePublicShare(env, principal, decodeURIComponent(publicShareCreateMatch[1]));
    return json({ ...revoked, requestId });
  }

  const fileMatch = path.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch?.[1] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const object = await requireReadableObject(env, principal, decodeURIComponent(fileMatch[1]));
    return json({ item: await objectJsonForPrincipal(env, object, principal), requestId });
  }

  const rawMatch = path.match(/^\/api\/files\/([^/]+)\/(raw|download)$/);
  if (rawMatch?.[1] && rawMatch[2] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const object = await requireReadableObject(env, principal, decodeURIComponent(rawMatch[1]));
    return await rawObjectResponse(env, object, request, {
      disposition: rawMatch[2] === "download" ? "attachment" : "inline",
      cacheControl: "private, no-store"
    });
  }

  const viewMatch = path.match(/^\/view\/([^/]+)$/);
  if (viewMatch?.[1] && request.method === "GET") {
    const principal = await resolvePrincipal(request, env);
    assertScope(principal, READ_SCOPES);
    const object = await requireReadableObject(env, principal, decodeURIComponent(viewMatch[1]));
    return await renderViewer(env, object, { embedded: isEmbeddedViewer(url), cacheControl: "private, no-store" });
  }

  return json({ error: "not_found", path, requestId }, { status: 404 });
}

function normalizeRoutePath(pathname: string) {
  const normalized = `/${pathname.replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/k" ? "/" : normalized.startsWith("/k/") ? normalized.slice(2) || "/" : normalized;
}

function isEmbeddedViewer(url: URL) {
  const embed = url.searchParams.get("embed")?.trim().toLowerCase();
  return embed === "1" || embed === "true" || embed === "modal";
}

function publicPrincipal(principal: Principal) {
  return {
    id: principal.sub,
    name: principal.name,
    email: principal.email,
    orgId: principal.orgId,
    role: principal.role,
    team: principal.team,
    department: principal.department
  };
}

function assertScope(principal: Principal, acceptedScopes: string[]) {
  if (principal.scopes.includes("workspace:*") || acceptedScopes.some((scope) => principal.scopes.includes(scope))) {
    return;
  }
  throw new HttpError(403, "insufficient_knowledge_scope");
}
