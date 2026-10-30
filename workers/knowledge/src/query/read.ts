import { HttpError } from "../http.ts";
import { knowledgeServiceJson, knowledgeServiceVersionJson } from "../services/representation.ts";
import { findKnowledgeSnapshot, readSnapshotContent } from "../services/snapshots.ts";
import type { Env, Principal } from "../types.ts";
import { readableKnowledgeServiceContext } from "./context.ts";

export async function knowledgeServiceRead(env: Env, principal: Principal, serviceId: string, body: Record<string, unknown>) {
  const context = await readableKnowledgeServiceContext(env, principal, serviceId);
  const snapshot = findKnowledgeSnapshot(context.snapshots, body);
  if (!snapshot) {
    throw new HttpError(404, "knowledge_service_file_not_found");
  }
  const content = await readSnapshotContent(env, snapshot);
  return {
    service: knowledgeServiceJson(context.service, context.version, context.effectiveRole),
    version: knowledgeServiceVersionJson(context.version),
    file: {
      objectId: snapshot.objectId,
      versionId: snapshot.versionId,
      path: snapshot.path,
      relativePath: snapshot.relativePath,
      fileName: snapshot.fileName,
      contentKind: snapshot.contentKind,
      mimeType: content.mimeType,
      sizeBytes: content.sizeBytes,
      sha256: snapshot.sha256
    },
    content
  };
}
