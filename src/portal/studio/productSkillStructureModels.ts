import type { AppsSkill, AppsSkillVersion } from "../../shared/types";
import { appsSkillGroupLabel, type AppsTFunction } from "./labels";
import type { AppsSkillProjectStructureModel, AppsSkillStructureFile, AppsSkillStructureGroup } from "./types";

export function appsSkillProjectStructureModel(skill: AppsSkill, t: AppsTFunction): AppsSkillProjectStructureModel {
  const version = currentSkillVersion(skill);
  const files = version ? skillVersionStructureFiles(version) : [];
  const groups = version ? skillVersionStructureGroups(version, files, t) : [];

  return {
    currentVersionLabel: version?.version ?? skill.currentVersion ?? "1.0.0",
    fileCount: version?.fileCount || files.length,
    groups,
    totalSize: version?.sizeBytes || groups.reduce((sum, group) => sum + group.sizeBytes, 0)
  };
}

function currentSkillVersion(skill: AppsSkill) {
  return skill.versions.find((version) => version.id === skill.currentVersionId || version.version === skill.currentVersion) ?? skill.versions[0];
}

function skillVersionStructureFiles(version: AppsSkillVersion): AppsSkillStructureFile[] {
  const packageManifest = recordValue(version.manifest.package);
  const candidates = [
    packageManifest?.files,
    packageManifest?.sourceFiles,
    version.manifest.files
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    const files = candidate
      .map((item) => {
        if (typeof item === "string") {
          return { path: item };
        }
        const record = recordValue(item);
        const path = stringValue(record?.path ?? record?.name);

        if (!path) {
          return undefined;
        }

        return {
          kind: stringValue(record?.kind ?? record?.type) || undefined,
          path,
          sizeBytes: numberValue(record?.sizeBytes ?? record?.bytes ?? record?.size)
        };
      })
      .filter((item): item is AppsSkillStructureFile => Boolean(item?.path));

    if (files.length > 0) {
      return files.sort((left, right) => left.path.localeCompare(right.path));
    }
  }

  const fallbackFiles: AppsSkillStructureFile[] = [
    { kind: "instruction", path: "SKILL.md" },
    { kind: "manifest", path: "pintail.json" }
  ];
  const extraCount = Math.max(0, version.fileCount - fallbackFiles.length);

  return extraCount > 0
    ? [...fallbackFiles, { kind: "package", path: `package/* (${extraCount} more)` }]
    : fallbackFiles.slice(0, Math.max(0, version.fileCount || fallbackFiles.length));
}

function skillVersionStructureGroups(version: AppsSkillVersion, files: AppsSkillStructureFile[], t: AppsTFunction): AppsSkillStructureGroup[] {
  const packageManifest = recordValue(version.manifest.package);
  const manifestGroups = Array.isArray(packageManifest?.groups) ? packageManifest.groups : [];
  const groupsByPath = new Map<string, AppsSkillStructureGroup>();

  for (const file of files) {
    const path = skillFileGroupPath(file.path);
    const current = groupsByPath.get(path) ?? {
      files: [],
      fileCount: 0,
      label: skillFileGroupLabel(path, t),
      path,
      sizeBytes: 0
    };

    current.files.push(file);
    current.fileCount += 1;
    current.sizeBytes += file.sizeBytes ?? 0;
    groupsByPath.set(path, current);
  }

  for (const item of manifestGroups) {
    const record = recordValue(item);
    const path = stringValue(record?.path);

    if (!path) {
      continue;
    }

    const current = groupsByPath.get(path) ?? {
      files: [],
      fileCount: 0,
      label: skillFileGroupLabel(path, t),
      path,
      sizeBytes: 0
    };
    current.fileCount = numberValue(record?.fileCount) || current.fileCount;
    current.sizeBytes = numberValue(record?.sizeBytes) || current.sizeBytes;
    groupsByPath.set(path, current);
  }

  if (groupsByPath.size === 0 && version.fileCount > 0) {
    return [{
      files,
      fileCount: version.fileCount,
      label: "Skill package",
      path: "/",
      sizeBytes: version.sizeBytes
    }];
  }

  return [...groupsByPath.values()].sort((left, right) => skillGroupSortWeight(left.path) - skillGroupSortWeight(right.path) || left.path.localeCompare(right.path));
}

function skillFileGroupPath(path: string) {
  if (!path.includes("/")) {
    return "/";
  }
  return `${path.split("/")[0]}/`;
}

function skillFileGroupLabel(path: string, t: AppsTFunction) {
  const labels: Record<string, string> = {
    "/": appsSkillGroupLabel(path, t),
    "assets/": "assets/",
    "data/": "data/",
    "docs/": "docs/",
    "examples/": "examples/",
    "fixtures/": "fixtures/",
    "images/": "images/",
    "public/": "public/",
    "references/": "references/",
    "reference/": "reference/",
    "scripts/": "scripts/",
    "tools/": "tools/",
    "wiki/": "wiki/"
  };

  return labels[path] ?? path;
}

function skillGroupSortWeight(path: string) {
  const order = ["/", "references/", "reference/", "wiki/", "docs/", "scripts/", "tools/", "data/", "examples/", "fixtures/", "assets/", "images/", "public/"];
  const index = order.indexOf(path);
  return index >= 0 ? index : order.length;
}

function recordValue(value: unknown) {
  return isPlainRecord(value) ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
