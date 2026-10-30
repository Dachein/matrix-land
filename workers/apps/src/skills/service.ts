import type { AppsSkill, AppsSkillVersion } from "../../../../src/shared/types";
import { accessTargetMatchesPrincipal } from "../core/accessTargets";
import { audit } from "../core/audit";
import { deleteR2ArtifactKeys } from "../core/artifacts";
import {
  collaboratorUserIdsFromJson,
  normalizeCollaboratorUserIds,
  normalizeUserIdentifier,
  principalCanManageAppsAsset,
  principalOwnsUserId,
  principalUserIdentifiers
} from "../core/collaborators";
import { JSON_HEADERS, readJson } from "../core/http";
import { normalizeCapabilities, normalizeSkillKind, normalizeSkillVersion, normalizeSkillVersionState } from "../core/normalizers";
import { HttpError, type Env, type Principal } from "../core/types";
import { bytesToBase64, optionalText, parseJsonObject, parseStringArray, randomToken, readOptionalString, readString, slugify } from "../core/utils";
import type { AppsSkillRow, AppsSkillVersionRow } from "../db/rows";
import { buildPintailManifest, canonicalSkillFiles, createZip, sha256Bytes, validateSkillPackage, withSkillPackageStructure, type PublishSkillInput } from "./package";

export async function listSkills(db: D1Database, principal: Principal): Promise<AppsSkill[]> {
  const rows = await listSkillRows(db, principal.orgId);
  return hydrateSkills(db, rows.filter((row) => canReadSkill(row, principal)));
}

export async function listManagedSkills(db: D1Database, principal: Principal): Promise<AppsSkill[]> {
  const rows = await listSkillRows(db, principal.orgId);
  return hydrateSkills(db, rows.filter((row) => canManageSkill(row, principal)));
}

async function listSkillRows(db: D1Database, orgId: string): Promise<AppsSkillRow[]> {
  const rows = await db
    .prepare(
      `
      SELECT *
      FROM apps_skills
      WHERE org_id = ?
      ORDER BY updated_at DESC, name
      `
    )
    .bind(orgId)
    .all<AppsSkillRow>();

  return rows.results ?? [];
}

export async function readSkill(db: D1Database, principal: Principal, skillId: string): Promise<AppsSkill> {
  const row = await db.prepare("SELECT * FROM apps_skills WHERE id = ? LIMIT 1").bind(skillId).first<AppsSkillRow>();

  if (!row || !canReadSkill(row, principal)) {
    throw new HttpError(404, "apps_skill_not_found");
  }

  return hydrateSkill(db, row);
}

export async function patchSkillMetadata(input: Record<string, unknown>, env: Env, principal: Principal, skillId: string): Promise<AppsSkill> {
  const existing = await requireWritableSkill(env.APPS_DB, principal, skillId);

  const now = new Date().toISOString();
  const name = readOptionalString(input.name)?.slice(0, 120) ?? existing.name;
  const requestedSlug = readOptionalString(input.slug);
  const slug = requestedSlug
    ? await uniqueSkillSlug(env.APPS_DB, principal.orgId, requestedSlug, skillId)
    : existing.slug;
  const description = hasInput(input, "description")
    ? optionalText(input.description, 1200)
    : existing.description;
  const kind = hasInput(input, "kind")
    ? normalizeSkillKind(input.kind)
    : normalizeSkillKind(existing.kind);
  const capabilities = hasInput(input, "capabilities")
    ? normalizeCapabilities(input.capabilities)
    : parseStringArray(existing.capabilities_json);

  await env.APPS_DB
    .prepare(
      `
      UPDATE apps_skills
      SET name = ?,
          slug = ?,
          description = ?,
          kind = ?,
          capabilities_json = ?,
          updated_at = ?
      WHERE id = ?
      `
    )
    .bind(name, slug, description, kind, JSON.stringify(capabilities), now, skillId)
    .run();

  await audit(env.APPS_DB, principal, "updated skill metadata", "apps_skill", skillId, { name, slug, kind });
  return readSkill(env.APPS_DB, principal, skillId);
}

export async function updateSkillVisibility(request: Request, env: Env, principal: Principal, skillId: string): Promise<AppsSkill> {
  const existing = await requireWritableSkill(env.APPS_DB, principal, skillId);
  const body = await readJson<SkillVisibilityInput>(request);
  await persistSkillVisibility(body, env, principal, skillId, existing);
  return readSkill(env.APPS_DB, principal, skillId);
}

// Portal issues this target-bound credential only after checking review-admin access.
export async function syncPublicationSkillVisibility(request: Request, env: Env, principal: Principal, skillId: string): Promise<void> {
  if (principal.tokenType !== "apps_publication_review") {
    throw new HttpError(403, "publication_review_token_required");
  }
  if (!principal.skillId || principal.skillId !== skillId) {
    throw new HttpError(403, "publication_review_target_mismatch");
  }
  const existing = await env.APPS_DB.prepare("SELECT * FROM apps_skills WHERE id = ? AND org_id = ? LIMIT 1")
    .bind(skillId, principal.orgId).first<AppsSkillRow>();
  if (!existing) throw new HttpError(404, "apps_skill_not_found");
  const body = await readJson<SkillVisibilityInput>(request);
  if (!["org", "team", "private"].includes(readString(body.visibility)) || body.accessTargets !== undefined) {
    throw new HttpError(400, "invalid_publication_skill_visibility");
  }
  return persistSkillVisibility(body, env, principal, skillId, existing);
}

type SkillVisibilityInput = { accessTargets?: unknown; loginRequired?: boolean; visibility?: unknown };

async function persistSkillVisibility(body: SkillVisibilityInput, env: Env, principal: Principal, skillId: string, existing: AppsSkillRow): Promise<void> {
  const visibility = normalizeSkillVisibilityInput(body.visibility, skillVisibilityFromRow(existing.visibility));
  const existingTargets = parseStringArray(existing.access_targets_json);
  const requestedTargets = body.accessTargets === undefined
    ? existingTargets
    : normalizeSkillAccessTargets(body.accessTargets);
  const accessTargets = visibility === "team" ? requestedTargets : [];
  const loginRequired = true;

  if (visibility === "team" && accessTargets.length === 0) {
    throw new HttpError(400, "skill_access_targets_required");
  }

  const now = new Date().toISOString();
  await env.APPS_DB
    .prepare(
      `
      UPDATE apps_skills
      SET visibility = ?,
          access_targets_json = ?,
          login_required = ?,
          updated_at = ?
      WHERE id = ?
      `
    )
    .bind(visibility, JSON.stringify(accessTargets), loginRequired ? 1 : 0, now, skillId)
    .run();

  await audit(env.APPS_DB, principal, "updated skill visibility", "apps_skill", skillId, {
    accessTargets,
    loginRequired,
    visibility
  });
}

export async function updateSkillCollaborators(request: Request, env: Env, principal: Principal, skillId: string): Promise<AppsSkill> {
  const existing = await requireWritableSkill(env.APPS_DB, principal, skillId);

  const body = await readJson<{ collaboratorUserIds?: unknown }>(request);
  const ownerIdentifiers = new Set([
    existing.owner_user_id,
    ...(principalOwnsUserId(existing.owner_user_id, principal) ? principalUserIdentifiers(principal) : [])
  ].map(normalizeUserIdentifier).filter(Boolean));
  const collaboratorUserIds = normalizeCollaboratorUserIds(body.collaboratorUserIds)
    .filter((userId) => !ownerIdentifiers.has(userId));
  const now = new Date().toISOString();

  const savedCollaborators = await env.APPS_DB
    .prepare("UPDATE apps_skills SET collaborator_user_ids_json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND ownership_sync_pending = 0 RETURNING id")
    .bind(JSON.stringify(collaboratorUserIds), now, skillId, existing.owner_user_id)
    .first();
  if (!savedCollaborators) throw new HttpError(409, "apps_owner_transfer_owner_changed");

  await audit(env.APPS_DB, principal, "updated skill collaborators", "apps_skill", skillId, {
    collaboratorUserIds
  });

  return hydrateSkill(env.APPS_DB, {
    ...existing,
    collaborator_user_ids_json: JSON.stringify(collaboratorUserIds),
    updated_at: now
  });
}

export async function deleteSkill(request: Request, env: Env, principal: Principal, skillId: string) {
  const existing = await requireWritableSkill(env.APPS_DB, principal, skillId);

  const body = await readJson<{ slug?: string }>(request);
  if (!existing.slug || readString(body.slug).trim() !== existing.slug) {
    throw new HttpError(400, "delete_confirmation_mismatch");
  }

  const versions = await env.APPS_DB
    .prepare("SELECT artifact_key AS artifactKey, skill_md_key AS skillMdKey, manifest_key AS manifestKey FROM apps_skill_versions WHERE skill_id = ?")
    .bind(skillId)
    .all<{ artifactKey: string; manifestKey: string; skillMdKey: string }>();
  const deletedArtifactKeys = await deleteR2ArtifactKeys(
    env,
    (versions.results ?? []).flatMap((version) => [version.artifactKey, version.skillMdKey, version.manifestKey])
  );

  await env.APPS_DB.batch([
    env.APPS_DB.prepare("DELETE FROM apps_skill_versions WHERE skill_id = ?").bind(skillId),
    env.APPS_DB.prepare("DELETE FROM apps_skills WHERE id = ?").bind(skillId)
  ]);

  await audit(env.APPS_DB, principal, "deleted skill", "apps_skill", skillId, {
    artifactKeys: deletedArtifactKeys,
    slug: existing.slug
  });

  return {
    deleted: true,
    skillId,
    cleanup: {
      artifactKeys: deletedArtifactKeys
    }
  };
}

export async function publishSkillPrivate(input: PublishSkillInput, env: Env, principal: Principal): Promise<AppsSkill> {
  const validated = validateSkillPackage(input);
  const existingSkillId = readOptionalString(input.skillId);
  const now = new Date().toISOString();
  const skillId = existingSkillId || `skill_${randomToken(12)}`;
  const versionId = `skv_${randomToken(12)}`;
  const orgSlug = slugify(principal.orgSlug) || principal.orgSlug || "org";
  const name = optionalText(input.name, 120) || readString(validated.frontmatter.name) || validated.slug;
  const slug = existingSkillId ? undefined : await uniqueSkillSlug(env.APPS_DB, principal.orgId, input.slug || validated.slug || name);
  const description = optionalText(input.description, 1200) || readString(validated.frontmatter.description) || "Private APPS Skill";
  const kind = normalizeSkillKind(input.kind);
  const capabilities = normalizeCapabilities(input.capabilities);
  const version = normalizeSkillVersion(input.version || readString(validated.frontmatter.version));
  const changelog = optionalText(input.changelog, 1200);
  let existingSkill: AppsSkillRow | undefined;

  if (existingSkillId) {
    const existing = await requireWritableSkill(env.APPS_DB, principal, existingSkillId);

    const duplicate = await env.APPS_DB
      .prepare("SELECT id FROM apps_skill_versions WHERE skill_id = ? AND version = ? LIMIT 1")
      .bind(existingSkillId, version)
      .first<{ id: string }>();
    if (duplicate) {
      throw new HttpError(409, "apps_skill_version_exists");
    }
    existingSkill = existing;
  }

  const baseManifest = buildPintailManifest({
    capabilities,
    description,
    inputManifest: input.manifest,
    kind,
    name,
    orgSlug,
    slug: existingSkill ? existingSkill.slug : slug ?? validated.slug,
    version
  });
  const manifest = withSkillPackageStructure(baseManifest, canonicalSkillFiles(validated.files, validated.skillMarkdown, baseManifest));
  const files = canonicalSkillFiles(validated.files, validated.skillMarkdown, manifest);
  const zipBytes = createZip(files);
  const artifactSha256 = await sha256Bytes(zipBytes);
  const baseKey = `apps/skills/${principal.orgId}/${skillId}/versions/${version}`;
  const artifactKey = `${baseKey}/skill.zip`;
  const skillMdKey = `${baseKey}/SKILL.md`;
  const manifestKey = `${baseKey}/pintail.json`;

  await putArtifact(env, artifactKey, zipBytes, "application/zip");
  await putArtifact(env, skillMdKey, validated.skillMarkdown, "text/markdown; charset=utf-8");
  await putArtifact(env, manifestKey, JSON.stringify(manifest, null, 2), "application/json; charset=utf-8");

  if (existingSkillId) {
    await env.APPS_DB.batch([
      env.APPS_DB
        .prepare("UPDATE apps_skill_versions SET state = 'private_superseded' WHERE skill_id = ? AND state = 'private_current'")
        .bind(existingSkillId),
      env.APPS_DB
        .prepare(
          `
          INSERT INTO apps_skill_versions (
            id,
            skill_id,
            version,
            state,
            artifact_key,
            skill_md_key,
            manifest_key,
            artifact_sha256,
            manifest_json,
            frontmatter_json,
            file_count,
            size_bytes,
            changelog,
            created_by,
            created_at
          )
          VALUES (?, ?, ?, 'private_current', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .bind(versionId, existingSkillId, version, artifactKey, skillMdKey, manifestKey, artifactSha256, JSON.stringify(manifest), JSON.stringify(validated.frontmatter), files.length, zipBytes.byteLength, changelog, principal.sub, now),
      env.APPS_DB
        .prepare(
          `
          UPDATE apps_skills
          SET name = ?,
              description = ?,
              kind = ?,
              capabilities_json = ?,
              current_version_id = ?,
              updated_at = ?
          WHERE id = ?
          `
        )
        .bind(name, description, kind, JSON.stringify(capabilities), versionId, now, existingSkillId)
    ]);
    await audit(env.APPS_DB, principal, "updated private skill", "apps_skill", existingSkillId, { version, artifactKey });
    return readSkill(env.APPS_DB, principal, existingSkillId);
  }

  await env.APPS_DB.batch([
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_skills (
          id,
          org_id,
          org_slug,
          owner_user_id,
          name,
          slug,
          description,
          kind,
          capabilities_json,
          status,
          visibility,
          access_targets_json,
          login_required,
          current_version_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', 'private', '[]', 1, ?, ?, ?)
        `
      )
      .bind(skillId, principal.orgId, orgSlug, principal.sub, name, slug ?? validated.slug, description, kind, JSON.stringify(capabilities), versionId, now, now),
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_skill_versions (
          id,
          skill_id,
          version,
          state,
          artifact_key,
          skill_md_key,
          manifest_key,
          artifact_sha256,
          manifest_json,
          frontmatter_json,
          file_count,
          size_bytes,
          changelog,
          created_by,
          created_at
        )
        VALUES (?, ?, ?, 'private_current', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(versionId, skillId, version, artifactKey, skillMdKey, manifestKey, artifactSha256, JSON.stringify(manifest), JSON.stringify(validated.frontmatter), files.length, zipBytes.byteLength, changelog, principal.sub, now)
  ]);

  await audit(env.APPS_DB, principal, "published private skill", "apps_skill", skillId, { version, artifactKey });
  return readSkill(env.APPS_DB, principal, skillId);
}

export async function skillZipResponse(env: Env, principal: Principal, skillId: string, version: string) {
  const skill = await readSkillForDownload(env.APPS_DB, principal, skillId);
  const selected = skill.versions.find((item) => item.version === version || item.id === version);

  if (!selected) {
    throw new HttpError(404, "skill_version_not_found");
  }

  if (!env.APPS_ARTIFACTS) {
    throw new HttpError(500, "apps_artifacts_bucket_unavailable");
  }

  const object = await env.APPS_ARTIFACTS.get(selected.artifactKey);
  if (!object) {
    throw new HttpError(404, "skill_artifact_not_found");
  }

  return new Response(object.body, {
    headers: {
      ...JSON_HEADERS,
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${skill.slug}-${selected.version}.zip"`
    }
  });
}

export async function downloadSkillPackage(env: Env, principal: Principal, skillId: string, version: string, client = "codex") {
  const skill = await readSkillForDownload(env.APPS_DB, principal, skillId);
  const selected = skill.versions.find((item) => item.version === version || item.id === version);

  if (!selected) {
    throw new HttpError(404, "skill_version_not_found");
  }

  if (!env.APPS_ARTIFACTS) {
    throw new HttpError(500, "apps_artifacts_bucket_unavailable");
  }

  const object = await env.APPS_ARTIFACTS.get(selected.artifactKey);
  if (!object) {
    throw new HttpError(404, "skill_artifact_not_found");
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  const computedSha256 = await sha256Bytes(bytes);
  if (selected.artifactSha256 && selected.artifactSha256 !== computedSha256) {
    throw new HttpError(500, "skill_artifact_integrity_mismatch");
  }

  return {
    skill: {
      id: skill.id,
      name: skill.name,
      slug: skill.slug,
      kind: skill.kind,
      capabilities: skill.capabilities
    },
    package: {
      version: selected.version,
      versionId: selected.id,
      filename: `${skill.slug}-${selected.version}.zip`,
      contentType: "application/zip",
      encoding: "base64",
      zipBase64: bytesToBase64(bytes),
      sha256: computedSha256,
      fileCount: selected.fileCount,
      sizeBytes: bytes.byteLength,
      artifactKey: selected.artifactKey
    },
    install: {
      client,
      target: installTarget(client, skill.slug),
      prompt: skillInstallPromptFromSkill(skill, selected, client)
    }
  };
}

export async function skillInstallPrompt(db: D1Database, principal: Principal, skillId: string, version: string, client: string) {
  const skill = await readSkill(db, principal, skillId);
  const selected = skill.versions.find((item) => item.version === version || item.id === version);
  if (!selected) {
    throw new HttpError(404, "skill_version_not_found");
  }

  return skillInstallPromptFromSkill(skill, selected, client);
}

function skillInstallPromptFromSkill(skill: AppsSkill, selected: AppsSkillVersion, client: string) {
  const target = installTarget(client, skill.slug);
  return [
    `Install ${skill.name} (${selected.version}) from Workspace APPS.`,
    "",
    `1. Download /skills/${encodeURIComponent(skill.id)}/versions/${encodeURIComponent(selected.version)}/download.zip from the Workspace APPS Worker.`,
    `2. Verify sha256 ${selected.artifactSha256}.`,
    `3. Extract the folder into ${target}.`,
    "4. Confirm SKILL.md and pintail.json exist.",
    "5. Restart or reload the client if the Skill does not appear automatically."
  ].join("\n");
}

async function hydrateSkills(db: D1Database, rows: AppsSkillRow[]): Promise<AppsSkill[]> {
  return Promise.all(rows.map((row) => hydrateSkill(db, row)));
}

async function hydrateSkill(db: D1Database, row: AppsSkillRow): Promise<AppsSkill> {
  const versions = await db
    .prepare("SELECT * FROM apps_skill_versions WHERE skill_id = ? ORDER BY created_at DESC")
    .bind(row.id)
    .all<AppsSkillVersionRow>();
  const normalizedVersions = (versions.results ?? []).map(skillVersionFromRow);
  const current = normalizedVersions.find((version) => version.id === row.current_version_id) ?? normalizedVersions[0];

  return {
    id: row.id,
    orgId: row.org_id,
    orgSlug: row.org_slug,
    ownerUserId: row.owner_user_id,
    collaboratorUserIds: collaboratorUserIdsFromJson(row.collaborator_user_ids_json),
    name: row.name,
    slug: row.slug,
    description: row.description,
    kind: normalizeSkillKind(row.kind),
    capabilities: parseStringArray(row.capabilities_json),
    status: row.status === "archived" ? "archived" : "private",
    visibility: skillVisibilityFromRow(row.visibility),
    accessTargets: parseStringArray(row.access_targets_json),
    loginRequired: row.login_required !== 0,
    currentVersionId: readOptionalString(row.current_version_id),
    currentVersion: current?.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    versions: normalizedVersions
  };
}

function skillVersionFromRow(row: AppsSkillVersionRow): AppsSkillVersion {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    state: normalizeSkillVersionState(row.state),
    artifactKey: row.artifact_key,
    skillMdKey: row.skill_md_key,
    manifestKey: row.manifest_key,
    artifactSha256: row.artifact_sha256,
    manifest: parseJsonObject(row.manifest_json),
    frontmatter: parseJsonObject(row.frontmatter_json),
    fileCount: Number(row.file_count) || 0,
    sizeBytes: Number(row.size_bytes) || 0,
    changelog: row.changelog,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

export function canManageSkill(row: AppsSkillRow, principal: Principal) {
  return principalCanManageAppsAsset(row, principal);
}

async function requireWritableSkill(db: D1Database, principal: Principal, skillId: string) {
  const row = await db.prepare("SELECT * FROM apps_skills WHERE id = ? LIMIT 1").bind(skillId).first<AppsSkillRow>();
  if (!row || !canManageSkill(row, principal)) {
    throw new HttpError(404, "apps_skill_not_found");
  }
  if (row.ownership_sync_pending) throw new HttpError(409, 'apps_ownership_sync_pending');
  return row;
}

function canReadSkill(row: AppsSkillRow, principal: Principal) {
  if (canManageSkill(row, principal)) {
    return true;
  }

  if (row.org_id !== principal.orgId) {
    return false;
  }

  const visibility = skillVisibilityFromRow(row.visibility);
  if (visibility === "org") {
    return true;
  }
  if (visibility === "private") {
    return false;
  }

  return parseStringArray(row.access_targets_json).some((target) => accessTargetMatchesPrincipal(target, principal));
}

function skillVisibilityFromRow(value: unknown): AppsSkill["visibility"] {
  const visibility = readString(value).trim().toLowerCase();
  if (visibility === "team") {
    return "team";
  }
  if (visibility === "org") {
    return "org";
  }
  return "private";
}

function normalizeSkillVisibilityInput(value: unknown, fallback: AppsSkill["visibility"]): AppsSkill["visibility"] {
  if (value === undefined || value === null || readString(value).trim() === "") {
    return fallback;
  }

  const visibility = readString(value).trim().toLowerCase();
  if (visibility === "private" || visibility === "team") {
    return visibility;
  }
  if (visibility === "org") {
    return "org";
  }
  throw new HttpError(400, "invalid_skill_visibility");
}

function normalizeSkillAccessTargets(value: unknown) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_skill_access_targets");
  }

  const normalized = value.map((target) => readString(target).trim()).filter(Boolean);
  if (normalized.some((target) => !isValidSkillAccessTarget(target))) {
    throw new HttpError(400, "invalid_skill_access_target");
  }

  return Array.from(new Set(normalized)).slice(0, 200);
}

function isValidSkillAccessTarget(target: string) {
  if (target.length > 180) {
    return false;
  }

  const separatorIndex = target.indexOf(":");
  const type = target.slice(0, separatorIndex).toLowerCase();
  const identifier = target.slice(separatorIndex + 1).trim();
  return (type === "department" || type === "user") && separatorIndex > 0 && identifier.length > 0;
}

function hasInput(input: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

async function readSkillForDownload(db: D1Database, principal: Principal, skillId: string): Promise<AppsSkill> {
  const row = await db.prepare("SELECT * FROM apps_skills WHERE id = ? LIMIT 1").bind(skillId).first<AppsSkillRow>();

  if (!row || (!canReadSkill(row, principal) && !canReadListedSkillArtifact(row, principal, skillId))) {
    throw new HttpError(404, "apps_skill_not_found");
  }

  return hydrateSkill(db, row);
}

function canReadListedSkillArtifact(row: AppsSkillRow, principal: Principal, skillId: string) {
  return principal.tokenType === "publication_access"
    && principal.skillId === skillId
    && row.org_id === principal.orgId;
}

async function putArtifact(env: Env, key: string, body: string | Uint8Array, contentType: string) {
  if (!env.APPS_ARTIFACTS) {
    throw new HttpError(500, "apps_artifacts_bucket_unavailable");
  }

  await env.APPS_ARTIFACTS.put(key, body, {
    httpMetadata: {
      contentType
    }
  });
}

function installTarget(client: string, slug: string) {
  if (client === "codex") {
    return `${"${CODEX_HOME:-$HOME/.codex}"}/skills/${slug}`;
  }
  if (client === "claude-code") {
    return `~/.claude/skills/${slug}`;
  }
  if (client === "codebuddy") {
    return `.codebuddy/skills/${slug} or ~/.codebuddy/skills/${slug}`;
  }
  if (client === "openclaw") {
    return `<workspace>/skills/${slug} or ~/.openclaw/skills/${slug}`;
  }
  return `~/.codex/skills/${slug}`;
}

async function uniqueSkillSlug(db: D1Database, orgId: string, value: unknown, currentSkillId?: string) {
  const base = slugify(value) || "skill";
  const candidate = base.slice(0, 72);
  const existing = await db
    .prepare(
      `
      SELECT id
      FROM apps_skills
      WHERE org_id = ?
        AND slug = ?
        AND (? IS NULL OR id != ?)
      LIMIT 1
      `
    )
    .bind(orgId, candidate, currentSkillId ?? null, currentSkillId ?? null)
    .first<{ id: string }>();

  return existing ? `${candidate}-${randomToken(6)}` : candidate;
}
