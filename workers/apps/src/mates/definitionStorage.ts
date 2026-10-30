import type {
  WorkspaceAgentRuntimeManifest,
  MateDocument
} from "../../../../src/shared/mate.ts";
import { HttpError, type Env } from "../core/types.ts";
import { asWorkspaceAgentRuntimeManifest, asMateDocuments } from "./validation.ts";

export type MateReleaseStorageRow = {
  documents_json: string;
  manifest_json: string;
  manifest_r2_key?: string;
  manifest_sha256: string;
  manifest_size_bytes?: number;
  storage_mode?: string;
};

type DefinitionRevisionRow = {
  created_at: string;
  created_by: string;
  definition_type: MateDocument["kind"];
  digest: string;
  id: string;
  r2_object_key: string;
  size_bytes: number;
  source: "native" | "legacy_inline_import";
  mate_id: string;
  version: number;
};

export type PreparedReleaseDefinition = {
  documents: MateDocument[];
  manifest: WorkspaceAgentRuntimeManifest;
  manifestJson: string;
  manifestR2Key: string;
  manifestSha256: string;
  manifestSizeBytes: number;
  revisions: Array<DefinitionRevisionRow & { ordinal: number }>;
};

export async function prepareReleaseDefinition(input: {
  createdAt: string;
  createdBy: string;
  documents: MateDocument[];
  env: Env;
  manifest: WorkspaceAgentRuntimeManifest;
  releaseId: string;
  releaseVersion: number;
  mateId: string;
}): Promise<PreparedReleaseDefinition> {
  const bucket = requireDefinitionBucket(input.env);
  const resolved = await resolveDefinitionRevisions(input.env.APPS_DB, {
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    documents: input.documents,
    mateId: input.mateId
  });
  for (const revision of resolved) {
    await putImmutableText(bucket, revision.r2_object_key, revision.content, revision.digest, {
      definitionType: revision.definition_type,
      mateId: input.mateId,
      version: String(revision.version)
    });
  }

  const manifest = structuredClone(input.manifest);
  manifest.release = {
    ...manifest.release,
    handbooks: orderedHandbookRefs(input.manifest, input.documents, resolved),
    releaseId: input.releaseId,
    soul: revisionRef(requireSoul(resolved)),
    mail: revisionRef(requireMail(resolved)),
    status: "candidate",
    version: input.releaseVersion
  };
  const manifestJson = canonicalJson(manifest);
  const manifestSha256 = await sha256Digest(manifestJson);
  const manifestR2Key = releaseManifestKey(input.mateId, input.releaseId, manifestSha256);
  await putImmutableText(bucket, manifestR2Key, manifestJson, manifestSha256, {
    releaseId: input.releaseId,
    schemaVersion: manifest.schemaVersion,
    mateId: input.mateId
  }, "application/json; charset=utf-8");

  return {
    documents: resolved.map(({ content, ...revision }) => ({
      content,
      digest: revision.digest,
      id: revision.id,
      kind: revision.definition_type,
      version: revision.version
    })),
    manifest,
    manifestJson,
    manifestR2Key,
    manifestSha256,
    manifestSizeBytes: byteLength(manifestJson),
    revisions: resolved.map(({ content: _content, ordinal, ...revision }) => ({ ...revision, ordinal }))
  };
}

export function releaseDefinitionStatements(
  db: D1Database,
  releaseId: string,
  revisions: PreparedReleaseDefinition["revisions"]
) {
  return revisions.flatMap((revision) => [
    db.prepare(`
      INSERT OR IGNORE INTO apps_mate_definition_revisions (
        id, mate_id, definition_type, version, digest, r2_object_key,
        size_bytes, source, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      revision.id,
      revision.mate_id,
      revision.definition_type,
      revision.version,
      revision.digest,
      revision.r2_object_key,
      revision.size_bytes,
      revision.source,
      revision.created_by,
      revision.created_at
    ),
    db.prepare(`
      INSERT INTO apps_mate_release_definitions (
        release_id, definition_revision_id, definition_type, ordinal,
        document_id, document_version, document_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      releaseId,
      revision.id,
      revision.definition_type,
      revision.ordinal,
      revision.id,
      revision.version,
      revision.digest
    )
  ]);
}

export async function loadReleaseDefinition(
  env: Env,
  releaseId: string,
  row: MateReleaseStorageRow
): Promise<{ documents: MateDocument[]; manifest: WorkspaceAgentRuntimeManifest }> {
  if (row.storage_mode !== "r2" || !row.manifest_r2_key) {
    return {
      documents: asMateDocuments(parseArray(row.documents_json)),
      manifest: asWorkspaceAgentRuntimeManifest(parseObject(row.manifest_json))
    };
  }
  const bucket = requireDefinitionBucket(env);
  const manifestJson = await getVerifiedText(bucket, row.manifest_r2_key, row.manifest_sha256);
  const manifest = asWorkspaceAgentRuntimeManifest(parseObject(manifestJson));
  const revisions = await env.APPS_DB.prepare(`
    SELECT revision.id, revision.definition_type, revision.version, revision.digest,
           revision.r2_object_key, revision.size_bytes, binding.ordinal,
           binding.document_id, binding.document_version, binding.document_digest
    FROM apps_mate_release_definitions AS binding
    JOIN apps_mate_definition_revisions AS revision
      ON revision.id = binding.definition_revision_id
    WHERE binding.release_id = ?
    ORDER BY CASE binding.definition_type WHEN 'soul' THEN 0 WHEN 'handbook' THEN 1 ELSE 2 END, binding.ordinal
  `).bind(releaseId).all<Record<string, unknown>>();
  if (!(revisions.results ?? []).length) throw new HttpError(500, "mate_release_definition_bindings_missing");
  const documents = await Promise.all((revisions.results ?? []).map(async (revision) => {
    const digest = String(revision.digest || "");
    if (digest !== String(revision.document_digest || "")) {
      throw new HttpError(500, "mate_release_definition_digest_binding_mismatch");
    }
    const content = await getVerifiedText(bucket, String(revision.r2_object_key || ""), digest);
    if (byteLength(content) !== Number(revision.size_bytes)) {
      throw new HttpError(500, "mate_definition_size_mismatch", { definitionRevisionId: String(revision.id || "") });
    }
    return {
      content,
      digest,
      id: String(revision.document_id || ""),
      kind: String(revision.definition_type) as MateDocument["kind"],
      version: Number(revision.document_version)
    };
  }));
  assertManifestDefinitionRefs(manifest, documents);
  return { documents, manifest };
}

async function resolveDefinitionRevisions(
  db: D1Database,
  input: {
    createdAt: string;
    createdBy: string;
    documents: MateDocument[];
    mateId: string;
  }
) {
  const nextVersion = new Map<MateDocument["kind"], number>();
  const resolved: Array<DefinitionRevisionRow & { content: string; ordinal: number }> = [];
  const kindOrdinals = new Map<MateDocument["kind"], number>();
  for (const document of input.documents) {
    const existing = await db.prepare(`
      SELECT * FROM apps_mate_definition_revisions
      WHERE mate_id = ? AND definition_type = ? AND digest = ?
      LIMIT 1
    `).bind(input.mateId, document.kind, document.digest).first<DefinitionRevisionRow>();
    const ordinal = kindOrdinals.get(document.kind) ?? 0;
    kindOrdinals.set(document.kind, ordinal + 1);
    if (existing) {
      resolved.push({ ...existing, content: document.content, ordinal });
      continue;
    }
    let version = nextVersion.get(document.kind);
    if (!version) {
      const latest = await db.prepare(`
        SELECT COALESCE(MAX(version), 0) AS version
        FROM apps_mate_definition_revisions
        WHERE mate_id = ? AND definition_type = ?
      `).bind(input.mateId, document.kind).first<{ version?: number }>();
      version = Number(latest?.version || 0) + 1;
    }
    nextVersion.set(document.kind, version + 1);
    const id = `${input.mateId}-${document.kind}-v${version}-${digestPart(document.digest).slice(0, 12)}`;
    resolved.push({
      content: document.content,
      created_at: input.createdAt,
      created_by: input.createdBy,
      definition_type: document.kind,
      digest: document.digest,
      id,
      ordinal,
      r2_object_key: definitionObjectKey(input.mateId, document.kind, version, document.digest),
      size_bytes: byteLength(document.content),
      source: "native",
      mate_id: input.mateId,
      version
    });
  }
  return resolved;
}

function orderedHandbookRefs(
  manifest: WorkspaceAgentRuntimeManifest,
  originalDocuments: MateDocument[],
  resolved: Array<DefinitionRevisionRow & { content: string; ordinal: number }>
) {
  const handbooks = resolved.filter((revision) => revision.definition_type === "handbook");
  return manifest.release.handbooks.map((ref, index) => {
    const original = originalDocuments.find((document) => document.kind === "handbook" && document.id === ref.id && document.version === ref.version)
      ?? originalDocuments.find((document) => document.kind === "handbook" && document.id === ref.id);
    const originalIndex = original ? originalDocuments.filter((document) => document.kind === "handbook").indexOf(original) : index;
    const revision = handbooks[originalIndex] ?? handbooks[index];
    if (!revision) throw new HttpError(422, "mate_handbook_document_missing");
    return revisionRef(revision);
  });
}

function requireSoul(revisions: Array<DefinitionRevisionRow>) {
  const soul = revisions.find((revision) => revision.definition_type === "soul");
  if (!soul) throw new HttpError(422, "mate_soul_document_missing");
  return soul;
}

function requireMail(revisions: Array<DefinitionRevisionRow>) {
  const mail = revisions.filter(revision => revision.definition_type === "mail");
  if (mail.length !== 1) throw new HttpError(422, "mate_mail_document_missing");
  return mail[0];
}

function revisionRef(revision: DefinitionRevisionRow) {
  return { digest: revision.digest, id: revision.id, version: revision.version };
}

function assertManifestDefinitionRefs(manifest: WorkspaceAgentRuntimeManifest, documents: MateDocument[]) {
  const soul = documents.find((document) => document.kind === "soul");
  if (!soul || soul.id !== manifest.release.soul.id || soul.version !== manifest.release.soul.version || soul.digest !== manifest.release.soul.digest) {
    throw new HttpError(500, "mate_release_soul_reference_mismatch");
  }
  if (manifest.release.mail && !documents.some(document => document.kind === "mail" && document.id === manifest.release.mail!.id && document.version === manifest.release.mail!.version && document.digest === manifest.release.mail!.digest)) throw new HttpError(500, "mate_release_mail_reference_mismatch");
  for (const ref of manifest.release.handbooks) {
    if (!documents.some((document) => document.kind === "handbook" && document.id === ref.id && document.version === ref.version && document.digest === ref.digest)) {
      throw new HttpError(500, "mate_release_handbook_reference_mismatch");
    }
  }
}

function requireDefinitionBucket(env: Env) {
  if (!env.MATE_DEFINITIONS) throw new HttpError(503, "mate_definition_storage_not_configured");
  return env.MATE_DEFINITIONS;
}

async function putImmutableText(
  bucket: R2Bucket,
  key: string,
  content: string,
  digest: string,
  customMetadata: Record<string, string>,
  contentType = "text/markdown; charset=utf-8"
) {
  const existing = await bucket.head(key);
  if (existing) {
    if (existing.size !== byteLength(content)) {
      throw new HttpError(409, "mate_definition_object_conflict", { key });
    }
    if (existing.customMetadata?.sha256 === digest) return;
    // Definition objects imported before sha256 metadata was standardized are
    // still immutable and reusable when their stored body is byte-for-byte the
    // expected content. Never rewrite the historical object just to repair
    // metadata because an existing Release may already reference it.
    const stored = await bucket.get(key);
    if (!stored || await stored.text() !== content) {
      throw new HttpError(409, "mate_definition_object_conflict", { key });
    }
    return;
  }
  const stored = await bucket.put(key, content, {
    customMetadata: { ...customMetadata, sha256: digest },
    httpMetadata: { contentType }
  });
  if (!stored || stored.size !== byteLength(content)) throw new HttpError(502, "mate_definition_object_write_failed", { key });
}

async function getVerifiedText(bucket: R2Bucket, key: string, expectedDigest: string) {
  if (!key || key.includes("..") || key.startsWith("/")) throw new HttpError(500, "mate_definition_object_key_invalid");
  const object = await bucket.get(key);
  if (!object) throw new HttpError(503, "mate_definition_object_missing", { key });
  const content = await object.text();
  const digest = await sha256Digest(content);
  if (digest !== expectedDigest) throw new HttpError(500, "mate_definition_digest_mismatch", { key });
  return content;
}

function definitionObjectKey(mateId: string, kind: MateDocument["kind"], version: number, digest: string) {
  return `mates/${mateId}/definitions/${kind}/${version}-${digestPart(digest)}.md`;
}

function releaseManifestKey(mateId: string, releaseId: string, digest: string) {
  return `mates/${mateId}/releases/${releaseId}/${digestPart(digest)}.json`;
}

function digestPart(digest: string) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest);
  if (!match) throw new HttpError(422, "mate_definition_digest_invalid");
  return match[1];
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    throw new HttpError(500, "mate_release_manifest_corrupt");
  }
}

function parseArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new HttpError(500, "mate_release_documents_corrupt");
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
