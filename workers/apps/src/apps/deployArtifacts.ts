import { strFromU8, unzipSync } from "fflate";
import { audit } from "../core/audit";
import { HttpError, type Env, type Principal } from "../core/types";
import { randomToken, readString } from "../core/utils";
import type { AppsAppRow } from "../db/rows";
import { canReadApp, requireWritableApp } from "./queries";

const MANIFEST_PATH = ".workspace-deploy/manifest.json";
const WORKER_ASSET_ARCHIVE_DIRECTORY = ".workspace-assets";
const MAX_ARCHIVE_BYTES = 25_000_000;
const MAX_CONTENT_BYTES = 25_000_000;
const MAX_FILE_COUNT = 1_000;
const MAX_MANIFEST_BYTES = 1_000_000;

type DeployArtifactRow = {
  app_id: string;
  archive_key: string;
  archive_sha256: string;
  archive_size_bytes: number;
  content_sha256: string;
  content_size_bytes: number;
  created_at: string;
  created_by: string;
  entrypoint: string;
  file_count: number;
  id: string;
  manifest_json: string;
  target: "pages" | "worker";
  version: string;
};

type DeployArtifactManifest = {
  assets?: unknown;
  archiveFormat?: unknown;
  contentSha256?: unknown;
  contentSizeBytes?: unknown;
  entrypoint?: unknown;
  fileCount?: unknown;
  files?: unknown;
  kind?: unknown;
  schemaVersion?: unknown;
  target?: unknown;
};

export type DeployArtifactWorkerAssets = {
  binding: string;
  directory: string;
  htmlHandling: "auto-trailing-slash" | "drop-trailing-slash" | "force-trailing-slash" | "none";
  notFoundHandling: "404-page" | "none" | "single-page-application";
  runWorkerFirst: boolean | string[];
};

type DeployArtifactManifestFile = {
  contentType: string;
  path: string;
  sha256: string;
  sizeBytes: number;
};

export type DeployArtifactFile = {
  content: string;
  contentType: string;
  encoding: "base64" | "text";
  path: string;
};

export async function uploadDeployArtifact(request: Request, env: Env, principal: Principal, appId: string) {
  await requireWritableApp(env.APPS_DB, principal, appId);
  const bucket = env.APPS_ARTIFACTS;
  if (!bucket) throw new HttpError(503, "apps_artifacts_bucket_unavailable");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/zip")) {
    throw new HttpError(415, "deploy_artifact_zip_required");
  }
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    throw new HttpError(413, "deploy_artifact_too_large");
  }

  const archive = new Uint8Array(await request.arrayBuffer());
  if (archive.byteLength === 0) throw new HttpError(400, "deploy_artifact_empty");
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new HttpError(413, "deploy_artifact_too_large");
  if (!isZip(archive)) throw new HttpError(400, "deploy_artifact_invalid_zip");

  const archiveSha256 = await sha256Hex(archive);
  const declaredArchiveSha256 = requiredSha256(request.headers.get("x-workspace-deploy-archive-sha256"), "invalid_deploy_archive_sha256");
  if (declaredArchiveSha256 !== archiveSha256) throw new HttpError(400, "deploy_artifact_archive_sha256_mismatch");
  const parsed = await parseDeployArtifact(archive);
  assertHeaderEquals(request, "x-workspace-deploy-content-sha256", parsed.manifest.contentSha256, "deploy_artifact_content_sha256_mismatch");
  assertHeaderEquals(request, "x-workspace-deploy-content-size", String(parsed.manifest.contentSizeBytes), "deploy_artifact_content_size_mismatch");
  assertHeaderEquals(request, "x-workspace-deploy-entrypoint", parsed.manifest.entrypoint, "deploy_artifact_entrypoint_mismatch");
  assertHeaderEquals(request, "x-workspace-deploy-file-count", String(parsed.manifest.fileCount), "deploy_artifact_file_count_mismatch");
  assertHeaderEquals(request, "x-workspace-deploy-target", parsed.manifest.target, "deploy_artifact_target_mismatch");

  const existing = await env.APPS_DB
    .prepare("SELECT * FROM apps_app_deploy_artifacts WHERE app_id = ? AND archive_sha256 = ? LIMIT 1")
    .bind(appId, archiveSha256)
    .first<DeployArtifactRow>();
  if (existing) {
    const object = await bucket.head(existing.archive_key);
    if (!object) await putArchive(bucket, existing, archive);
    return { deduplicated: true, deployArtifact: deployArtifactFromRow(existing) };
  }

  const now = new Date().toISOString();
  const deployArtifactId = `artifact_${randomToken(12)}`;
  const version = artifactVersion(new URL(request.url).searchParams.get("version"), now, parsed.manifest.contentSha256);
  const archiveKey = `apps/${r2Segment(appId)}/deploy-artifacts/${deployArtifactId}/artifact.zip`;
  const row: DeployArtifactRow = {
    app_id: appId,
    archive_key: archiveKey,
    archive_sha256: archiveSha256,
    archive_size_bytes: archive.byteLength,
    content_sha256: parsed.manifest.contentSha256,
    content_size_bytes: parsed.manifest.contentSizeBytes,
    created_at: now,
    created_by: principal.sub,
    entrypoint: parsed.manifest.entrypoint,
    file_count: parsed.manifest.fileCount,
    id: deployArtifactId,
    manifest_json: JSON.stringify(parsed.manifest),
    target: parsed.manifest.target,
    version
  };
  await putArchive(bucket, row, archive);
  await env.APPS_DB.prepare(`
    INSERT INTO apps_app_deploy_artifacts (
      id, app_id, version, target, entrypoint, content_sha256, archive_key,
      archive_sha256, file_count, content_size_bytes, archive_size_bytes,
      manifest_json, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.id, row.app_id, row.version, row.target, row.entrypoint, row.content_sha256,
    row.archive_key, row.archive_sha256, row.file_count, row.content_size_bytes,
    row.archive_size_bytes, row.manifest_json, row.created_by, row.created_at
  ).run();

  await audit(env.APPS_DB, principal, "uploaded app deployment artifact via cli", "apps_app", appId, {
    archiveSha256,
    archiveSizeBytes: archive.byteLength,
    contentSha256: row.content_sha256,
    contentSizeBytes: row.content_size_bytes,
    deployArtifactId,
    entrypoint: row.entrypoint,
    fileCount: row.file_count,
    target: row.target,
    version
  });
  return { deduplicated: false, deployArtifact: deployArtifactFromRow(row) };
}

export async function listDeployArtifacts(env: Env, principal: Principal, appId: string) {
  await requireReadableApp(env, principal, appId);
  const rows = await env.APPS_DB
    .prepare("SELECT * FROM apps_app_deploy_artifacts WHERE app_id = ? ORDER BY created_at DESC LIMIT 100")
    .bind(appId)
    .all<DeployArtifactRow>();
  return { deployArtifacts: (rows.results ?? []).map(deployArtifactFromRow) };
}

export async function downloadDeployArtifact(env: Env, principal: Principal, appId: string, deployArtifactId: string) {
  const bucket = env.APPS_ARTIFACTS;
  if (!bucket) throw new HttpError(503, "apps_artifacts_bucket_unavailable");
  const row = await readDeployArtifactRow(env, principal, appId, deployArtifactId);
  const object = await bucket.get(row.archive_key);
  if (!object) throw new HttpError(404, "deploy_artifact_archive_not_found");
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${r2Segment(appId)}-${r2Segment(row.version)}-deploy.zip"`,
      "Content-Length": String(object.size),
      "Content-Type": "application/zip",
      "X-Workspace-Deploy-Archive-Sha256": row.archive_sha256,
      "X-Workspace-Deploy-Content-Sha256": row.content_sha256
    }
  });
}

export async function loadDeployArtifact(
  env: Env,
  principal: Principal,
  appId: string,
  deployArtifactId: string,
  expectedTarget: "pages" | "worker"
) {
  const bucket = env.APPS_ARTIFACTS;
  if (!bucket) throw new HttpError(503, "apps_artifacts_bucket_unavailable");
  const row = await readDeployArtifactRow(env, principal, appId, deployArtifactId, true);
  if (row.target !== expectedTarget) throw new HttpError(409, "deploy_artifact_target_mismatch");
  const object = await bucket.get(row.archive_key);
  if (!object) throw new HttpError(404, "deploy_artifact_archive_not_found");
  const archive = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(archive) !== row.archive_sha256) throw new HttpError(409, "deploy_artifact_archive_corrupt");
  const parsed = await parseDeployArtifact(archive);
  if (parsed.manifest.contentSha256 !== row.content_sha256) throw new HttpError(409, "deploy_artifact_manifest_drift");
  return {
    deployArtifact: deployArtifactFromRow(row),
    files: parsed.files,
    manifest: parsed.manifest
  };
}

async function parseDeployArtifact(archive: Uint8Array) {
  let declaredContentBytes = 0;
  let declaredFileCount = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive, {
      filter(file) {
        const info = file as unknown as { name?: string; originalSize?: number; size?: number };
        const path = validateArchivePath(readString(info.name));
        const originalSize = Number(info.originalSize ?? info.size ?? 0);
        if (path === MANIFEST_PATH) {
          if (originalSize > MAX_MANIFEST_BYTES) throw new HttpError(413, "deploy_artifact_manifest_too_large");
        } else {
          declaredFileCount += 1;
          declaredContentBytes += originalSize;
        }
        if (declaredFileCount > MAX_FILE_COUNT || declaredContentBytes > MAX_CONTENT_BYTES) {
          throw new HttpError(413, "deploy_artifact_expanded_too_large");
        }
        return true;
      }
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "deploy_artifact_invalid_zip");
  }
  const manifestBytes = entries[MANIFEST_PATH];
  if (!manifestBytes) throw new HttpError(400, "deploy_artifact_manifest_missing");
  let rawManifest: DeployArtifactManifest;
  try {
    rawManifest = JSON.parse(strFromU8(manifestBytes)) as DeployArtifactManifest;
  } catch {
    throw new HttpError(400, "deploy_artifact_manifest_invalid");
  }
  const manifest = normalizeManifest(rawManifest);
  const archiveFiles = Object.entries(entries).filter(([path]) => path !== MANIFEST_PATH);
  if (archiveFiles.length !== manifest.fileCount) throw new HttpError(400, "deploy_artifact_manifest_file_count_mismatch");

  const files: DeployArtifactFile[] = [];
  const contentHashParts: string[] = [];
  let contentSizeBytes = 0;
  const manifestFiles = new Map(manifest.files.map((file) => [file.path, file]));
  for (const [path, bytes] of archiveFiles.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    validateArchivePath(path);
    const declared = manifestFiles.get(path);
    if (!declared) throw new HttpError(400, "deploy_artifact_manifest_file_missing");
    const sha256 = await sha256Hex(bytes);
    if (declared.sizeBytes !== bytes.byteLength || declared.sha256 !== sha256) {
      throw new HttpError(400, "deploy_artifact_file_integrity_mismatch");
    }
    contentSizeBytes += bytes.byteLength;
    contentHashParts.push(`${path}\0${bytes.byteLength}\0${sha256}\0${declared.contentType}\n`);
    const text = isTextDeploymentFile(path, declared.contentType);
    files.push({
      content: text ? new TextDecoder().decode(bytes) : bytesToBase64(bytes),
      contentType: declared.contentType,
      encoding: text ? "text" : "base64",
      path
    });
  }
  const contentSha256 = await sha256Hex(new TextEncoder().encode(contentHashParts.join("")));
  if (contentSizeBytes !== manifest.contentSizeBytes || contentSha256 !== manifest.contentSha256) {
    throw new HttpError(400, "deploy_artifact_content_integrity_mismatch");
  }
  return { files, manifest };
}

function normalizeManifest(value: DeployArtifactManifest) {
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || value.kind !== "workspace-apps-deployment-artifact" || value.archiveFormat !== "zip") {
    throw new HttpError(400, "deploy_artifact_manifest_unsupported");
  }
  const target = readString(value.target) as "pages" | "worker";
  if (target !== "pages" && target !== "worker") throw new HttpError(400, "deploy_artifact_target_invalid");
  const entrypoint = validateArchivePath(readString(value.entrypoint));
  const contentSha256 = requiredSha256(readString(value.contentSha256), "invalid_deploy_content_sha256");
  const fileCount = boundedInteger(value.fileCount, 1, MAX_FILE_COUNT, "invalid_deploy_file_count");
  const contentSizeBytes = boundedInteger(value.contentSizeBytes, 0, MAX_CONTENT_BYTES, "invalid_deploy_content_size");
  if (!Array.isArray(value.files) || value.files.length !== fileCount) throw new HttpError(400, "deploy_artifact_manifest_files_invalid");
  const seen = new Set<string>();
  const files = value.files.map((item) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const path = validateArchivePath(readString(record.path));
    if (path === MANIFEST_PATH || seen.has(path)) throw new HttpError(400, "deploy_artifact_manifest_path_invalid");
    seen.add(path);
    const contentType = readString(record.contentType).trim().toLowerCase();
    if (!contentType || contentType.length > 120) throw new HttpError(400, "deploy_artifact_content_type_invalid");
    return {
      contentType,
      path,
      sha256: requiredSha256(readString(record.sha256), "deploy_artifact_file_sha256_invalid"),
      sizeBytes: boundedInteger(record.sizeBytes, 0, 20_000_000, "deploy_artifact_file_size_invalid")
    } satisfies DeployArtifactManifestFile;
  });
  if (!seen.has(entrypoint)) throw new HttpError(400, "deploy_artifact_entrypoint_missing");
  const containsReservedWorkerAssets = [...seen].some((path) => path.startsWith(`${WORKER_ASSET_ARCHIVE_DIRECTORY}/`));
  const containsBrowserEntrypoint = seen.has("index.html");
  if (target === "worker" && value.assets === undefined && (containsReservedWorkerAssets || containsBrowserEntrypoint)) {
    throw new HttpError(400, "deploy_artifact_worker_assets_metadata_missing", {
      detectedPath: containsReservedWorkerAssets ? `${WORKER_ASSET_ARCHIVE_DIRECTORY}/` : "index.html",
      remediation: "Keep Worker modules in --deploy-dir and pass frontend output with --assets-dir; do not create .workspace-assets manually"
    });
  }
  if (value.schemaVersion === 2 && value.assets === undefined) {
    throw new HttpError(400, "deploy_artifact_assets_metadata_missing");
  }
  const assets = normalizeWorkerAssets(value.assets, value.schemaVersion, target, seen, entrypoint);
  return { schemaVersion: assets ? 2 : 1, kind: "workspace-apps-deployment-artifact", archiveFormat: "zip", target, entrypoint, contentSha256, fileCount, contentSizeBytes, files, ...(assets ? { assets } : {}) };
}

function normalizeWorkerAssets(
  value: unknown,
  schemaVersion: unknown,
  target: "pages" | "worker",
  paths: Set<string>,
  entrypoint: string
): DeployArtifactWorkerAssets | undefined {
  if (value === undefined) return undefined;
  if (schemaVersion !== 2 || target !== "worker") throw new HttpError(400, "deploy_artifact_assets_unsupported");
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const directory = validateArchivePath(readString(record.directory));
  if (directory !== WORKER_ASSET_ARCHIVE_DIRECTORY) throw new HttpError(400, "deploy_artifact_assets_directory_invalid");
  if (entrypoint === directory || entrypoint.startsWith(`${directory}/`)) throw new HttpError(400, "deploy_artifact_entrypoint_is_asset");
  if (![...paths].some((path) => path.startsWith(`${directory}/`))) throw new HttpError(400, "deploy_artifact_assets_missing");
  const binding = readString(record.binding).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(binding)) throw new HttpError(400, "deploy_artifact_assets_binding_invalid");
  const notFoundHandling = readString(record.notFoundHandling) as DeployArtifactWorkerAssets["notFoundHandling"];
  if (!["404-page", "none", "single-page-application"].includes(notFoundHandling)) throw new HttpError(400, "deploy_artifact_assets_not_found_handling_invalid");
  const htmlHandling = readString(record.htmlHandling) as DeployArtifactWorkerAssets["htmlHandling"];
  if (!["auto-trailing-slash", "drop-trailing-slash", "force-trailing-slash", "none"].includes(htmlHandling)) throw new HttpError(400, "deploy_artifact_assets_html_handling_invalid");
  const rawRunWorkerFirst = record.runWorkerFirst;
  const runWorkerFirst = Array.isArray(rawRunWorkerFirst)
    ? rawRunWorkerFirst.map((item) => readString(item).trim()).filter(Boolean)
    : rawRunWorkerFirst === true;
  if (Array.isArray(runWorkerFirst) && runWorkerFirst.length === 0) throw new HttpError(400, "deploy_artifact_assets_worker_first_invalid");
  return { binding, directory, htmlHandling, notFoundHandling, runWorkerFirst };
}

async function readDeployArtifactRow(env: Env, principal: Principal, appId: string, deployArtifactId: string, writable = false) {
  if (writable) await requireWritableApp(env.APPS_DB, principal, appId);
  else await requireReadableApp(env, principal, appId);
  const row = await env.APPS_DB
    .prepare("SELECT * FROM apps_app_deploy_artifacts WHERE app_id = ? AND id = ? LIMIT 1")
    .bind(appId, deployArtifactId)
    .first<DeployArtifactRow>();
  if (!row) throw new HttpError(404, "deploy_artifact_not_found");
  return row;
}

async function requireReadableApp(env: Env, principal: Principal, appId: string) {
  const row = await env.APPS_DB.prepare("SELECT * FROM apps_apps WHERE id = ? LIMIT 1").bind(appId).first<AppsAppRow>();
  if (!row || !canReadApp(row, principal)) throw new HttpError(404, "apps_app_not_found");
}

async function putArchive(bucket: R2Bucket, row: DeployArtifactRow, archive: Uint8Array) {
  await bucket.put(row.archive_key, archive, {
    sha256: row.archive_sha256,
    httpMetadata: { contentType: "application/zip", contentDisposition: `attachment; filename="${row.id}.zip"` },
    customMetadata: {
      appId: row.app_id,
      archiveSha256: row.archive_sha256,
      contentSha256: row.content_sha256,
      deployArtifactId: row.id,
      target: row.target,
      uploadedVia: "workspace-cli"
    }
  });
}

function deployArtifactFromRow(row: DeployArtifactRow) {
  return {
    id: row.id,
    appId: row.app_id,
    version: row.version,
    target: row.target,
    entrypoint: row.entrypoint,
    contentSha256: row.content_sha256,
    archiveSha256: row.archive_sha256,
    fileCount: row.file_count,
    contentSizeBytes: row.content_size_bytes,
    archiveSizeBytes: row.archive_size_bytes,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

function validateArchivePath(value: string) {
  const path = value.trim().replace(/^\/+/, "");
  if (!path || path.length > 240 || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(400, "deploy_artifact_path_invalid");
  }
  return path;
}

function isTextDeploymentFile(path: string, contentType: string) {
  return contentType.startsWith("text/")
    || /(?:javascript|json|xml|svg)/.test(contentType)
    || /\.(?:cjs|css|cts|html|js|json|jsx|mjs|mts|svg|ts|tsx|txt|xml)$/i.test(path)
    || /(?:^|\/)(?:_headers|_redirects|_routes\.json|_worker\.bundle)$/.test(path);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function assertHeaderEquals(request: Request, name: string, expected: string, code: string) {
  if (readString(request.headers.get(name)).trim() !== expected) throw new HttpError(400, code);
}

function boundedInteger(value: unknown, min: number, max: number, code: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, code);
  return parsed;
}

function requiredSha256(value: string | null, code: string) {
  const normalized = readString(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new HttpError(400, code);
  return normalized;
}

function artifactVersion(value: string | null, now: string, contentSha256: string) {
  const requested = readString(value).trim();
  if (requested) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(requested)) throw new HttpError(400, "invalid_deploy_artifact_version");
    return requested;
  }
  return `deploy-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${contentSha256.slice(0, 8)}`;
}

function isZip(bytes: Uint8Array) {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function sha256Hex(bytes: Uint8Array) {
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function r2Segment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
