import { audit } from "../core/audit";
import { HttpError, type Env, type Principal } from "../core/types";
import { randomToken, readOptionalString, readString } from "../core/utils";
import type { AppsAppRow } from "../db/rows";
import { canReadApp, requireWritableApp } from "./queries";

const MAX_ARCHIVE_BYTES = 50_000_000;
const MAX_FILE_COUNT = 10_000;

type SourceSnapshotRow = {
  app_id: string;
  archive_format: string;
  archive_key: string;
  archive_sha256: string;
  archive_size_bytes: number;
  content_sha256: string;
  created_at: string;
  created_by: string;
  created_by_name?: string;
  file_count: number;
  id: string;
  notes?: string;
  source_size_bytes: number;
  upload_context?: string;
  version: string;
  version_name?: string;
};

export async function uploadSourceSnapshot(request: Request, env: Env, principal: Principal, appId: string) {
  await requireWritableApp(env.APPS_DB, principal, appId);
  const bucket = env.APPS_ARTIFACTS;
  if (!bucket) throw new HttpError(503, "apps_artifacts_bucket_unavailable");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/zip")) {
    throw new HttpError(415, "source_snapshot_zip_required");
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    throw new HttpError(413, "source_snapshot_too_large");
  }
  const archive = new Uint8Array(await request.arrayBuffer());
  if (archive.byteLength === 0) throw new HttpError(400, "source_snapshot_empty");
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new HttpError(413, "source_snapshot_too_large");
  if (!isZip(archive)) throw new HttpError(400, "source_snapshot_invalid_zip");

  const archiveSha256 = await sha256Hex(archive);
  const declaredArchiveSha256 = optionalSha256(request.headers.get("x-workspace-source-archive-sha256"));
  if (declaredArchiveSha256 && declaredArchiveSha256 !== archiveSha256) {
    throw new HttpError(400, "source_snapshot_archive_sha256_mismatch");
  }
  const contentSha256 = requiredSha256(request.headers.get("x-workspace-source-content-sha256"), "invalid_source_content_sha256");
  const fileCount = boundedInteger(request.headers.get("x-workspace-source-file-count"), 1, MAX_FILE_COUNT, "invalid_source_file_count");
  const sourceSizeBytes = boundedInteger(request.headers.get("x-workspace-source-size"), 1, 100_000_000, "invalid_source_size");
  const metadata = sourceMetadata(request);
  const now = new Date().toISOString();
  const version = snapshotVersion(metadata.version, now, contentSha256);
  const versionName = optionalMetadataText(metadata.versionName, 160);
  const notes = optionalMetadataText(metadata.notes, 4_000);
  const uploadContext = snapshotUploadContext(metadata.purpose);

  const existing = await env.APPS_DB
    .prepare("SELECT * FROM apps_app_source_snapshots WHERE app_id = ? AND archive_sha256 = ? LIMIT 1")
    .bind(appId, archiveSha256)
    .first<SourceSnapshotRow>();
  if (existing) {
    const object = await bucket.head(existing.archive_key);
    if (!object) await putArchive(bucket, existing.archive_key, archive, appId, existing.id, contentSha256, archiveSha256);
    const mergedContext = mergeUploadContext(existing.upload_context, uploadContext);
    if (mergedContext !== existing.upload_context || uploadContext === "backup") {
      await env.APPS_DB.prepare(
        `UPDATE apps_app_source_snapshots
         SET upload_context = ?, version = ?, version_name = ?, notes = ?, created_by = ?, created_by_name = ?, created_at = ?
         WHERE id = ?`
      ).bind(
        mergedContext,
        uploadContext === "backup" ? version : existing.version,
        uploadContext === "backup" ? versionName : readString(existing.version_name),
        uploadContext === "backup" ? notes : readString(existing.notes),
        uploadContext === "backup" ? principal.sub : existing.created_by,
        uploadContext === "backup" ? readString(principal.name) : readString(existing.created_by_name),
        uploadContext === "backup" ? now : existing.created_at,
        existing.id
      ).run();
    }
    const row = await readSourceSnapshot(env, principal, appId, existing.id);
    await audit(env.APPS_DB, principal, "reused app source snapshot via cli", "apps_app", appId, {
      archiveSha256,
      sourceSnapshotId: existing.id,
      purpose: uploadContext,
      version,
      versionName
    });
    return { deduplicated: true, sourceSnapshot: sourceSnapshotFromRow(row) };
  }

  const sourceSnapshotId = `snap_${randomToken(12)}`;
  const archiveKey = `apps/${r2Segment(appId)}/source-snapshots/${sourceSnapshotId}/source.zip`;
  await putArchive(bucket, archiveKey, archive, appId, sourceSnapshotId, contentSha256, archiveSha256);

  await env.APPS_DB
    .prepare(
      `
      INSERT INTO apps_app_source_snapshots (
        id, app_id, version, version_name, notes, content_sha256, archive_key, archive_sha256,
        archive_format, file_count, source_size_bytes, archive_size_bytes,
        created_by, created_by_name, upload_context, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'zip', ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      sourceSnapshotId,
      appId,
      version,
      versionName,
      notes,
      contentSha256,
      archiveKey,
      archiveSha256,
      fileCount,
      sourceSizeBytes,
      archive.byteLength,
      principal.sub,
      readString(principal.name),
      uploadContext,
      now
    )
    .run();

  await audit(env.APPS_DB, principal, "uploaded app source snapshot via cli", "apps_app", appId, {
    archiveSha256,
    archiveSizeBytes: archive.byteLength,
    contentSha256,
    fileCount,
    sourceSnapshotId,
    sourceSizeBytes,
    versionName,
    notes,
    purpose: uploadContext,
    version
  });

  const row = await readSourceSnapshot(env, principal, appId, sourceSnapshotId);
  return { deduplicated: false, sourceSnapshot: sourceSnapshotFromRow(row) };
}

export async function listSourceSnapshots(env: Env, principal: Principal, appId: string) {
  await requireReadableApp(env, principal, appId);
  const rows = await env.APPS_DB
    .prepare("SELECT * FROM apps_app_source_snapshots WHERE app_id = ? ORDER BY created_at DESC LIMIT 100")
    .bind(appId)
    .all<SourceSnapshotRow>();
  return { sourceSnapshots: (rows.results ?? []).map(sourceSnapshotFromRow) };
}

export async function downloadSourceSnapshot(env: Env, principal: Principal, appId: string, sourceSnapshotId: string) {
  const bucket = env.APPS_ARTIFACTS;
  if (!bucket) throw new HttpError(503, "apps_artifacts_bucket_unavailable");
  const row = await readSourceSnapshot(env, principal, appId, sourceSnapshotId);
  const object = await bucket.get(row.archive_key);
  if (!object) throw new HttpError(404, "source_snapshot_archive_not_found");
  return sourceSnapshotResponse(object, row);
}

export async function downloadCurrentPublishedSourceSnapshot(
  env: Env,
  principal: Principal,
  appId: string
) {
  await requireReadableApp(env, principal, appId);
  const deployment = await env.APPS_DB
    .prepare(
      `
      SELECT id, source_snapshot_id AS sourceSnapshotId, version
      FROM apps_deployments
      WHERE app_id = ?
        AND environment = 'production'
        AND status = 'published'
      ORDER BY created_at DESC
      LIMIT 1
      `
    )
    .bind(appId)
    .first<{ id: string; sourceSnapshotId?: string; version: string }>();
  if (!deployment) throw new HttpError(404, "published_deployment_not_found");
  const sourceSnapshotId = readString(deployment.sourceSnapshotId).trim();
  if (!sourceSnapshotId) {
    throw new HttpError(409, "published_deployment_source_snapshot_not_found");
  }

  const bucket = env.APPS_ARTIFACTS;
  if (!bucket) throw new HttpError(503, "apps_artifacts_bucket_unavailable");
  const row = await readSourceSnapshot(env, principal, appId, sourceSnapshotId);
  const object = await bucket.get(row.archive_key);
  if (!object) throw new HttpError(404, "source_snapshot_archive_not_found");
  return sourceSnapshotResponse(object, row, {
    "X-Workspace-Deployment-Id": deployment.id,
    "X-Workspace-Deployment-Version": deployment.version,
    "X-Workspace-Source-Snapshot-Id": row.id
  });
}

async function readSourceSnapshot(env: Env, principal: Principal, appId: string, sourceSnapshotId: string) {
  await requireReadableApp(env, principal, appId);
  const row = await env.APPS_DB
    .prepare("SELECT * FROM apps_app_source_snapshots WHERE app_id = ? AND id = ? LIMIT 1")
    .bind(appId, sourceSnapshotId)
    .first<SourceSnapshotRow>();
  if (!row) throw new HttpError(404, "source_snapshot_not_found");
  return row;
}

async function requireReadableApp(env: Env, principal: Principal, appId: string) {
  const row = await env.APPS_DB.prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1").bind(appId).first<AppsAppRow>();
  if (!row || !canReadApp(row, principal)) throw new HttpError(404, "apps_app_not_found");
  return row;
}

async function putArchive(
  bucket: R2Bucket,
  key: string,
  archive: Uint8Array,
  appId: string,
  sourceSnapshotId: string,
  contentSha256: string,
  archiveSha256: string
) {
  await bucket.put(key, archive, {
    sha256: archiveSha256,
    httpMetadata: {
      contentType: "application/zip",
      contentDisposition: `attachment; filename="${sourceSnapshotId}.zip"`
    },
    customMetadata: {
      appId,
      archiveSha256,
      contentSha256,
      sourceSnapshotId,
      uploadedVia: "workspace-cli"
    }
  });
}

function sourceSnapshotFromRow(row: SourceSnapshotRow) {
  return {
    id: row.id,
    appId: row.app_id,
    version: row.version,
    versionName: readOptionalString(row.version_name),
    notes: readOptionalString(row.notes),
    contentSha256: row.content_sha256,
    archiveSha256: row.archive_sha256,
    archiveFormat: row.archive_format,
    fileCount: row.file_count,
    sourceSizeBytes: row.source_size_bytes,
    archiveSizeBytes: row.archive_size_bytes,
    purpose: snapshotUploadContext(row.upload_context, "legacy"),
    createdBy: row.created_by,
    createdByName: readOptionalString(row.created_by_name),
    createdAt: row.created_at
  };
}

function snapshotVersion(value: unknown, now: string, contentSha256: string) {
  const requested = readString(value).trim();
  if (requested) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(requested)) throw new HttpError(400, "invalid_source_snapshot_version");
    return requested;
  }
  return `source-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${contentSha256.slice(0, 8)}`;
}

function sourceMetadata(request: Request) {
  const encoded = readString(request.headers.get("x-workspace-source-metadata")).trim();
  if (encoded) {
    if (encoded.length > 8_192) throw new HttpError(400, "source_snapshot_metadata_too_long");
    try {
      const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
      const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "invalid_source_snapshot_metadata");
    }
    throw new HttpError(400, "invalid_source_snapshot_metadata");
  }
  const search = new URL(request.url).searchParams;
  return {
    version: search.get("version"),
    versionName: search.get("versionName"),
    notes: search.get("notes"),
    purpose: search.get("purpose")
  };
}

function optionalMetadataText(value: unknown, maxLength: number) {
  const text = readString(value).trim();
  if (text.length > maxLength) throw new HttpError(400, "source_snapshot_metadata_too_long");
  return text;
}

function snapshotUploadContext(value: unknown, fallback: "backup" | "legacy" = "backup"): "backup" | "deployment" | "both" | "legacy" {
  const context = readString(value).trim();
  if (!context) return fallback;
  if (context === "backup" || context === "deployment" || context === "both" || context === "legacy") return context;
  throw new HttpError(400, "invalid_source_snapshot_purpose");
}

function mergeUploadContext(existing: unknown, incoming: "backup" | "deployment" | "both" | "legacy") {
  const current = snapshotUploadContext(existing, "legacy");
  if (current === incoming || incoming === "legacy") return current;
  if (current === "legacy") return incoming;
  return "both";
}

function optionalSha256(value: string | null) {
  const normalized = readString(value).trim().toLowerCase();
  if (!normalized) return "";
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new HttpError(400, "invalid_source_archive_sha256");
  return normalized;
}

function requiredSha256(value: string | null, code: string) {
  const normalized = readString(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new HttpError(400, code);
  return normalized;
}

function boundedInteger(value: string | null, min: number, max: number, code: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, code);
  return parsed;
}

function isZip(bytes: Uint8Array) {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function r2Segment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function downloadFileName(row: SourceSnapshotRow) {
  const version = row.version.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${r2Segment(row.app_id)}-${version}.zip`;
}

function sourceSnapshotResponse(
  object: R2ObjectBody,
  row: SourceSnapshotRow,
  extraHeaders: Record<string, string> = {}
) {
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${downloadFileName(row)}"`,
      "Content-Length": String(object.size),
      "Content-Type": "application/zip",
      "X-Workspace-Source-Archive-Sha256": row.archive_sha256,
      "X-Workspace-Source-Content-Sha256": row.content_sha256,
      ...extraHeaders
    }
  });
}
