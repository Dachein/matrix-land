import { createHash } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { strToU8, zipSync } from "fflate";
import ignore from "ignore";

export const MAX_ARCHIVE_BYTES = 50_000_000;
export const MAX_FILE_BYTES = 20_000_000;
export const MAX_FILE_COUNT = 10_000;
export const MAX_SOURCE_BYTES = 100_000_000;

export const DEFAULT_IGNORE_RULES = [
  ".git/",
  "node_modules/",
  ".build/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  ".cache/",
  ".turbo/",
  ".wrangler/",
  "coverage/",
  ".workspace-snapshot/",
  ".DS_Store",
  "Thumbs.db",
  "*.log",
  "*.zip",
  "*.tar",
  "*.tar.gz",
  "*.tgz",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  ".npmrc",
  ".pypirc",
  "*.pem",
  "*.key",
  "id_rsa*",
  "credentials*.json",
  "*.mp4",
  "*.mov",
  "*.avi",
  "*.mkv",
  "*.webm",
  "*.mp3",
  "*.wav",
  "*.flac",
  "*.psd",
  "*.sketch"
];

const FIXED_ZIP_DATE = new Date(1980, 0, 1, 0, 0, 0, 0);
const MANIFEST_PATH = ".workspace-snapshot/manifest.json";

export async function createSourceSnapshot(sourceDirectory, options = {}) {
  const root = resolve(sourceDirectory || ".");
  const rootStat = await lstat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Snapshot source is not a directory: ${root}`);
  }

  const sourceExcludes = normalizeAdditionalIgnoreRules(options.ignoreRules);
  const matcher = ignore().add(DEFAULT_IGNORE_RULES).add(sourceExcludes);
  const customRules = await readOptionalText(join(root, ".appsignore"));
  if (customRules) matcher.add(customRules);

  const sourceFiles = [];
  const skippedSymlinks = [];
  await walk(root, "");
  sourceFiles.sort((left, right) => compareText(left.path, right.path));
  if (sourceFiles.length === 0) {
    throw new Error("No source files remain after applying snapshot exclusions");
  }

  const files = [];
  let sourceSizeBytes = 0;
  const contentHash = createHash("sha256");
  const archiveEntries = {};
  for (const file of sourceFiles) {
    const bytes = await readFile(file.absolutePath);
    const sha256 = digest(bytes);
    sourceSizeBytes += bytes.byteLength;
    if (sourceSizeBytes > (options.maxSourceBytes ?? MAX_SOURCE_BYTES)) {
      throw new Error(`Snapshot source exceeds ${formatBytes(options.maxSourceBytes ?? MAX_SOURCE_BYTES)}; add generated or media files to .appsignore`);
    }
    const item = { path: file.path, sha256, sizeBytes: bytes.byteLength };
    files.push(item);
    contentHash.update(item.path).update("\0").update(String(item.sizeBytes)).update("\0").update(item.sha256).update("\n");
    archiveEntries[item.path] = [bytes, { level: 6, mtime: FIXED_ZIP_DATE }];
  }

  const contentSha256 = contentHash.digest("hex");
  const manifest = {
    schemaVersion: 1,
    kind: "workspace-apps-source-snapshot",
    archiveFormat: "zip",
    contentSha256,
    fileCount: files.length,
    sourceSizeBytes,
    files
  };
  archiveEntries[MANIFEST_PATH] = [strToU8(`${JSON.stringify(manifest, null, 2)}\n`), { level: 6, mtime: FIXED_ZIP_DATE }];
  const archive = zipSync(archiveEntries, { level: 6, mtime: FIXED_ZIP_DATE });
  const maxArchiveBytes = options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
  if (archive.byteLength > maxArchiveBytes) {
    throw new Error(`Snapshot archive is ${formatBytes(archive.byteLength)}, above the ${formatBytes(maxArchiveBytes)} limit; update .appsignore`);
  }

  return {
    archive,
    archiveName: `${safeFileName(basename(root))}-${contentSha256.slice(0, 12)}.zip`,
    archiveSha256: digest(archive),
    contentSha256,
    fileCount: files.length,
    manifest,
    root,
    skippedSymlinkCount: skippedSymlinks.length,
    sourceExcludes,
    sourceSizeBytes
  };

  async function walk(absoluteDirectory, relativeDirectory) {
    const directory = await opendir(absoluteDirectory);
    const entries = [];
    for await (const entry of directory) entries.push(entry);
    entries.sort((left, right) => compareText(left.name, right.name));

    for (const entry of entries) {
      const relativePath = normalizePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinks.push(relativePath);
        continue;
      }
      if (entry.isDirectory()) {
        if (!matcher.ignores(`${relativePath}/`)) await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() || matcher.ignores(relativePath)) continue;
      if (relativePath === MANIFEST_PATH) continue;

      const stat = await lstat(absolutePath);
      const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
      if (stat.size > maxFileBytes) {
        throw new Error(`Source file '${relativePath}' is ${formatBytes(stat.size)}, above the ${formatBytes(maxFileBytes)} per-file limit; add it to .appsignore or raise the limit explicitly`);
      }
      sourceFiles.push({ absolutePath, path: relativePath });
      if (sourceFiles.length > (options.maxFileCount ?? MAX_FILE_COUNT)) {
        throw new Error(`Snapshot contains more than ${options.maxFileCount ?? MAX_FILE_COUNT} files; check dependency and build-output exclusions`);
      }
    }
  }
}

function normalizeAdditionalIgnoreRules(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Source exclusions must be an array");
  if (value.length > 100) throw new Error("No more than 100 --source-exclude rules are allowed");
  return value.map((item) => {
    const rule = String(item ?? "").trim();
    if (!rule || rule.length > 256 || rule.includes("\0") || rule.includes("\n") || rule.includes("\r")) {
      throw new Error("Each --source-exclude rule must be a non-empty single-line pattern of at most 256 characters");
    }
    return rule;
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value) {
  return value.split(sep).join("/").replace(/^\.\//, "");
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
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "source";
}

export function formatBytes(value) {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
