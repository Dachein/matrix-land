import type { AppsSkillKind } from "../../../../src/shared/types";
import { HttpError } from "../core/types";
import { asRecord, readString, requireText, slugify } from "../core/utils";

export type SkillFileInput = {
  content?: string;
  path?: string;
};

export type PublishSkillInput = {
  capabilities?: string[];
  changelog?: string;
  description?: string;
  files?: SkillFileInput[];
  kind?: string;
  manifest?: Record<string, unknown>;
  name?: string;
  skillId?: string;
  skillMarkdown?: string;
  slug?: string;
  version?: string;
  visibility?: string;
};

export function validateSkillPackage(input: Record<string, unknown> | PublishSkillInput) {
  const skillMarkdown = requireText((input as PublishSkillInput).skillMarkdown, "missing_skill_markdown", 200000);
  const frontmatter = parseSkillFrontmatter(skillMarkdown);
  const name = readString(frontmatter.name);
  const description = readString(frontmatter.description);

  if (!name) {
    throw new HttpError(400, "missing_skill_frontmatter_name");
  }

  if (!description) {
    throw new HttpError(400, "missing_skill_frontmatter_description");
  }

  const files = normalizeSkillFiles((input as PublishSkillInput).files);
  const hasSkillMd = files.some((file) => file.path === "SKILL.md");

  return {
    ok: true,
    slug: slugify(name),
    frontmatter,
    skillMarkdown,
    files: hasSkillMd ? files : [{ path: "SKILL.md", content: skillMarkdown }, ...files],
    warnings: files.length === 0 ? ["Package contains only SKILL.md. Use a folder package for references/scripts/assets."] : []
  };
}

export function buildPintailManifest(input: {
  capabilities: string[];
  description: string;
  inputManifest?: Record<string, unknown>;
  kind: AppsSkillKind;
  name: string;
  orgSlug: string;
  slug: string;
  version: string;
}) {
  return {
    schemaVersion: "pintail.skill.v1",
    slug: input.slug,
    displayName: input.name,
    summary: input.description,
    version: input.version,
    kind: input.kind,
    capabilities: input.capabilities,
    visibility: "private",
    publisher: {
      orgSlug: input.orgSlug
    },
    downloads: {
      allowInstallPrompt: true,
      allowRawSkillMd: true,
      allowZip: true
    },
    ...(input.inputManifest ?? {})
  };
}

export function withSkillPackageStructure(manifest: Record<string, unknown>, files: Array<{ bytes: Uint8Array; path: string }>) {
  const existingPackage = manifest.package && typeof manifest.package === "object" && !Array.isArray(manifest.package)
    ? manifest.package as Record<string, unknown>
    : {};
  const sourceFiles = files
    .filter((file) => file.path !== "pintail.json")
    .map((file) => ({
      path: file.path,
      sizeBytes: file.bytes.byteLength,
      kind: skillPackageFileKind(file.path)
    }));

  return {
    ...manifest,
    package: {
      ...existingPackage,
      fileCount: files.length,
      sourceFileCount: sourceFiles.length,
      files: sourceFiles,
      groups: skillPackageGroups(sourceFiles)
    }
  };
}

export function canonicalSkillFiles(files: Array<{ content: string; path: string }>, skillMarkdown: string, manifest: Record<string, unknown>) {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  byPath.set("SKILL.md", skillMarkdown);
  byPath.set("pintail.json", JSON.stringify(manifest, null, 2));

  return [...byPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({ path, bytes: new TextEncoder().encode(content) }));
}

export async function sha256Bytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes);
  const data = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createZip(files: Array<{ bytes: Uint8Array; path: string }>) {
  const entries = files.map((file) => ({
    ...file,
    nameBytes: new TextEncoder().encode(file.path),
    crc: crc32(file.bytes)
  }));
  const chunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const localOffset = offset;
    const localHeader = new Uint8Array(30 + entry.nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, entry.crc, true);
    localView.setUint32(18, entry.bytes.byteLength, true);
    localView.setUint32(22, entry.bytes.byteLength, true);
    localView.setUint16(26, entry.nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(entry.nameBytes, 30);
    chunks.push(localHeader, entry.bytes);
    offset += localHeader.byteLength + entry.bytes.byteLength;

    const centralHeader = new Uint8Array(46 + entry.nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, entry.crc, true);
    centralView.setUint32(20, entry.bytes.byteLength, true);
    centralView.setUint32(24, entry.bytes.byteLength, true);
    centralView.setUint16(28, entry.nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(entry.nameBytes, 46);
    centralChunks.push(centralHeader);
  }

  const centralStart = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralStart, true);
  endView.setUint16(20, 0, true);

  return concatBytes([...chunks, ...centralChunks, end]);
}

function normalizeSkillFiles(files: SkillFileInput[] | undefined) {
  const normalized = (Array.isArray(files) ? files : [])
    .map((file) => ({
      path: sanitizePackagePath(file.path),
      content: readString(file.content)
    }))
    .filter((file) => file.path && file.content.length <= 500000);
  const seen = new Set<string>();

  return normalized.filter((file) => {
    if (seen.has(file.path)) {
      return false;
    }
    seen.add(file.path);
    return true;
  });
}

function sanitizePackagePath(value: unknown) {
  const path = readString(value).replaceAll("\\", "/").trim().replace(/^\.\/+/, "");
  const parts = path.split("/");

  if (!path || path.startsWith("/") || path.includes("\0") || parts.some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(400, "invalid_skill_file_path");
  }

  return path.slice(0, 240);
}

function parseSkillFrontmatter(markdown: string): Record<string, unknown> {
  if (!markdown.startsWith("---\n")) {
    throw new HttpError(400, "missing_skill_frontmatter");
  }

  const end = markdown.indexOf("\n---", 4);
  if (end < 0) {
    throw new HttpError(400, "invalid_skill_frontmatter");
  }

  const raw = markdown.slice(4, end).trim();
  const result: Record<string, unknown> = {};
  let currentKey = "";
  let folded = "";

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (match) {
      if (currentKey && folded) {
        result[currentKey] = folded.trim();
        folded = "";
      }
      currentKey = match[1];
      const value = match[2].trim();
      if (value === ">-" || value === "|") {
        folded = "";
      } else {
        result[currentKey] = parseFrontmatterValue(value);
        currentKey = "";
      }
      continue;
    }

    if (currentKey) {
      folded += `${line.trim()} `;
    }
  }

  if (currentKey && folded) {
    result[currentKey] = folded.trim();
  }

  return result;
}

function parseFrontmatterValue(value: string): unknown {
  const unquoted = value.replace(/^['"]|['"]$/g, "");
  if (unquoted.startsWith("[") && unquoted.endsWith("]")) {
    return unquoted.slice(1, -1).split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }
  return unquoted;
}

function skillPackageGroups(files: Array<{ path: string; sizeBytes: number }>) {
  const groups = new Map<string, { fileCount: number; path: string; sizeBytes: number }>();

  for (const file of files) {
    const path = file.path.includes("/") ? `${file.path.split("/")[0]}/` : "/";
    const current = groups.get(path) ?? { fileCount: 0, path, sizeBytes: 0 };
    current.fileCount += 1;
    current.sizeBytes += file.sizeBytes;
    groups.set(path, current);
  }

  return [...groups.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function skillPackageFileKind(path: string) {
  if (path === "SKILL.md") {
    return "instruction";
  }
  if (path.endsWith(".json")) {
    return "manifest";
  }
  const root = path.split("/")[0];
  if (["docs", "references", "reference", "wiki"].includes(root)) {
    return "knowledge";
  }
  if (["scripts", "tools", "bin"].includes(root)) {
    return "script";
  }
  if (["assets", "images", "public"].includes(root)) {
    return "asset";
  }
  if (["data", "examples", "fixtures"].includes(root)) {
    return "data";
  }
  return "file";
}

function concatBytes(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

let crc32Table: Uint32Array | undefined;

function crc32(bytes: Uint8Array) {
  const table = crc32Table ?? createCrc32Table();
  crc32Table = table;
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
