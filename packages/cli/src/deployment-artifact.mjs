import { createHash } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { strToU8, zipSync } from "fflate";
import ignore from "ignore";

export const MAX_DEPLOY_ARCHIVE_BYTES = 25_000_000;
export const MAX_DEPLOY_FILE_BYTES = 20_000_000;
export const MAX_DEPLOY_FILE_COUNT = 1_000;
export const MAX_DEPLOY_CONTENT_BYTES = 25_000_000;

const FIXED_ZIP_DATE = new Date(1980, 0, 1, 0, 0, 0, 0);
const MANIFEST_PATH = ".workspace-deploy/manifest.json";
const WORKER_ASSET_ARCHIVE_DIRECTORY = ".workspace-assets";
const DEFAULT_IGNORE_RULES = [
  ".git/",
  "node_modules/",
  ".workspace-deploy/",
  ".DS_Store",
  "Thumbs.db",
  ".env",
  ".env.*",
  ".npmrc",
  ".pypirc",
  "*.pem",
  "*.key",
  "id_rsa*",
  "credentials*.json"
];

export async function createDeploymentArtifact(deployDirectory, options = {}) {
  const root = resolve(deployDirectory || ".");
  const rootStat = await lstat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Deployment output is not a directory: ${root}`);
  }

  const target = deploymentTarget(options.target);
  const entrypoint = normalizePath(options.entrypoint || (target === "pages" ? "index.html" : "index.js"));
  const assets = normalizeWorkerAssets(options.assets, target);
  await assertReservedArchiveDirectoryAbsent(root);
  const matcher = ignore().add(DEFAULT_IGNORE_RULES);
  const customRules = await readOptionalText(join(root, ".appsdeployignore"));
  if (customRules) matcher.add(customRules);

  const candidates = [];
  const skippedSymlinks = [];
  await walk(root, "", matcher, "");
  if (target === "worker" && candidates.some((file) => file.path === "index.html")) {
    throw new Error("Worker deployment output contains browser entry file 'index.html'. Keep Worker modules in --deploy-dir and pass frontend output separately with --assets-dir <directory>");
  }
  if (assets) {
    const assetsRoot = resolve(assets.sourceDirectory);
    const assetsRootStat = await lstat(assetsRoot).catch(() => undefined);
    if (!assetsRootStat?.isDirectory()) {
      throw new Error(`Worker assets output is not a directory: ${assetsRoot}`);
    }
    if (directoriesOverlap(root, assetsRoot)) {
      throw new Error("--deploy-dir and --assets-dir must be separate, non-overlapping directories so browser assets are not uploaded as Worker modules");
    }
    const assetsMatcher = ignore().add(DEFAULT_IGNORE_RULES);
    const assetsIgnore = await readOptionalText(join(assetsRoot, ".assetsignore"));
    if (assetsIgnore) assetsMatcher.add(assetsIgnore);
    await walk(assetsRoot, "", assetsMatcher, WORKER_ASSET_ARCHIVE_DIRECTORY);
  }
  candidates.sort((left, right) => compareText(left.path, right.path));
  if (candidates.length === 0) {
    throw new Error("No deployment files remain after applying deployment exclusions");
  }
  if (!candidates.some((file) => file.path === entrypoint)) {
    throw new Error(`Deployment entrypoint is missing from output: ${entrypoint}`);
  }

  const files = [];
  const archiveEntries = {};
  const contentHash = createHash("sha256");
  let contentSizeBytes = 0;
  for (const file of candidates) {
    const bytes = await readFile(file.absolutePath);
    const sha256 = digest(bytes);
    const contentType = contentTypeForPath(file.path);
    contentSizeBytes += bytes.byteLength;
    if (contentSizeBytes > (options.maxContentBytes ?? MAX_DEPLOY_CONTENT_BYTES)) {
      throw new Error(`Deployment output exceeds ${formatBytes(options.maxContentBytes ?? MAX_DEPLOY_CONTENT_BYTES)}`);
    }
    const item = { path: file.path, sha256, sizeBytes: bytes.byteLength, contentType };
    files.push(item);
    contentHash
      .update(item.path).update("\0")
      .update(String(item.sizeBytes)).update("\0")
      .update(item.sha256).update("\0")
      .update(item.contentType).update("\n");
    archiveEntries[item.path] = [bytes, { level: 6, mtime: FIXED_ZIP_DATE }];
  }

  const contentSha256 = contentHash.digest("hex");
  const manifest = {
    schemaVersion: assets ? 2 : 1,
    kind: "workspace-apps-deployment-artifact",
    archiveFormat: "zip",
    target,
    entrypoint,
    contentSha256,
    fileCount: files.length,
    contentSizeBytes,
    files,
    ...(assets ? {
      assets: {
        binding: assets.binding,
        directory: WORKER_ASSET_ARCHIVE_DIRECTORY,
        htmlHandling: assets.htmlHandling,
        notFoundHandling: assets.notFoundHandling,
        runWorkerFirst: assets.runWorkerFirst
      }
    } : {})
  };
  archiveEntries[MANIFEST_PATH] = [strToU8(`${JSON.stringify(manifest, null, 2)}\n`), { level: 6, mtime: FIXED_ZIP_DATE }];
  const archive = zipSync(archiveEntries, { level: 6, mtime: FIXED_ZIP_DATE });
  const maxArchiveBytes = options.maxArchiveBytes ?? MAX_DEPLOY_ARCHIVE_BYTES;
  if (archive.byteLength > maxArchiveBytes) {
    throw new Error(`Deployment artifact is ${formatBytes(archive.byteLength)}, above the ${formatBytes(maxArchiveBytes)} limit`);
  }

  return {
    archive,
    archiveName: `${safeFileName(basename(root))}-${contentSha256.slice(0, 12)}.zip`,
    archiveSha256: digest(archive),
    contentSha256,
    contentSizeBytes,
    entrypoint,
    fileCount: files.length,
    manifest,
    root,
    skippedSymlinkCount: skippedSymlinks.length,
    target,
    assets: manifest.assets
  };

  async function walk(absoluteDirectory, relativeDirectory, activeMatcher, archivePrefix) {
    const directory = await opendir(absoluteDirectory);
    const entries = [];
    for await (const entry of directory) entries.push(entry);
    entries.sort((left, right) => compareText(left.name, right.name));

    for (const entry of entries) {
      const relativePath = normalizePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      const absolutePath = join(absoluteDirectory, entry.name);
      const archivePath = normalizePath(archivePrefix ? `${archivePrefix}/${relativePath}` : relativePath);
      if (entry.isSymbolicLink()) {
        skippedSymlinks.push(archivePath);
        continue;
      }
      if (entry.isDirectory()) {
        if (!activeMatcher.ignores(`${relativePath}/`)) await walk(absolutePath, relativePath, activeMatcher, archivePrefix);
        continue;
      }
      if (!entry.isFile() || activeMatcher.ignores(relativePath) || relativePath === ".appsdeployignore" || relativePath === ".assetsignore") continue;
      const stat = await lstat(absolutePath);
      const maxFileBytes = options.maxFileBytes ?? MAX_DEPLOY_FILE_BYTES;
      if (stat.size > maxFileBytes) {
        throw new Error(`Deployment file '${relativePath}' is ${formatBytes(stat.size)}, above the ${formatBytes(maxFileBytes)} per-file limit`);
      }
      candidates.push({ absolutePath, path: archivePath });
      if (candidates.length > (options.maxFileCount ?? MAX_DEPLOY_FILE_COUNT)) {
        throw new Error(`Deployment output contains more than ${options.maxFileCount ?? MAX_DEPLOY_FILE_COUNT} files`);
      }
    }
  }
}

async function assertReservedArchiveDirectoryAbsent(root) {
  const reservedPath = join(root, WORKER_ASSET_ARCHIVE_DIRECTORY);
  const reservedStat = await lstat(reservedPath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (reservedStat) {
    throw new Error("Deployment output contains reserved path '.workspace-assets'. Do not create it manually; pass browser output with --assets-dir <directory> and Workspace CLI will package it");
  }
}

function directoriesOverlap(left, right) {
  return isSameOrInside(left, right) || isSameOrInside(right, left);
}

function isSameOrInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function normalizeWorkerAssets(value, target) {
  if (!value?.sourceDirectory) return undefined;
  if (target !== "worker") throw new Error("Static assets are supported only for Worker deployments");
  const binding = String(value.binding || "ASSETS").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(binding)) throw new Error("Invalid Worker assets binding");
  const notFoundHandling = String(value.notFoundHandling || "none").trim();
  if (!["none", "404-page", "single-page-application"].includes(notFoundHandling)) {
    throw new Error("Invalid Worker assets not-found handling");
  }
  const htmlHandling = String(value.htmlHandling || "auto-trailing-slash").trim();
  if (!["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"].includes(htmlHandling)) {
    throw new Error("Invalid Worker assets HTML handling");
  }
  const runWorkerFirst = Array.isArray(value.runWorkerFirst)
    ? value.runWorkerFirst.map((route) => String(route).trim()).filter(Boolean)
    : value.runWorkerFirst === true;
  if (Array.isArray(runWorkerFirst) && runWorkerFirst.length === 0) {
    throw new Error("Worker-first asset routes must not be empty");
  }
  return {
    binding,
    htmlHandling,
    notFoundHandling,
    runWorkerFirst,
    sourceDirectory: value.sourceDirectory
  };
}

export function contentTypeForPath(path) {
  const extension = extname(path).toLowerCase();
  const known = {
    ".avif": "image/avif",
    ".css": "text/css; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".xml": "application/xml; charset=utf-8"
  };
  return known[extension] ?? "application/octet-stream";
}

function deploymentTarget(value) {
  const target = String(value || "").trim().toLowerCase();
  if (target === "pages" || target === "worker") return target;
  throw new Error("Deployment target must be 'pages' or 'worker'");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value) {
  const path = String(value || "").split(sep).join("/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!path || path.length > 240 || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid deployment path: ${value}`);
  }
  return path;
}

async function readOptionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function safeFileName(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "deploy";
}

function formatBytes(value) {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
