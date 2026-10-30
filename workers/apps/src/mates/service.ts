import { installationHostname } from "../../../../src/shared/installationDomains.ts";
import { ensureMateMailDocument, setMateMailContent, mateMailContent } from "../../../../src/shared/mateMail.ts";
import { WorkspaceMailProvisioner } from "../../../../sdk/mail/index.ts";
import { workspaceMailRequest, workspaceMailJson } from "../../../../src/shared/workspaceMailClient.ts";
import { unzipSync } from 'fflate';
import { sha256Bytes } from '../skills/package.ts';
import {
  WORKSPACE_AGENT_RUNTIME_SCHEMA_VERSION,
  WORKSPACE_DEFAULT_BUILT_IN_TOOL_IDS,
  WORKSPACE_MATE_CALL_TOOL,
  normalizeMateCode,
  mateCodeFromWorkEmail,
  withWorkspaceIntrinsicBuiltInToolIds,
  type WorkspaceAgentRuntimeManifest,
  type Mate,
  type MateAdoptionPreview,
  type MateDocument,
  type MateRelease,
  type MateScheduledJob,
  type MateVisibility
} from "../../../../src/shared/mate.ts";
import type { AppsSkill } from "../../../../src/shared/types.ts";
import { matePetIdFromAvatarUrl, randomMatePetAvatarUrl } from "../../../../src/shared/matePet.ts";
import { DEFAULT_MATE_MCP_CAPACITY, isMateMcpCapacity, migrateLegacyMateMcpCapacity } from "../../../../src/shared/mateMcpCapacity.ts";
import { WORKSPACE_MATE_DEFAULT_MODELS } from "../../../../src/shared/mateModelOptions.ts";
import { readAccessibleMcpApp } from "../apps/appMcpRegistry.ts";
import { audit } from "../core/audit.ts";
import { principalOwnsUserId } from "../core/collaborators.ts";
import { HttpError, type Env, type Principal } from "../core/types.ts";
import { optionalText, readString } from "../core/utils.ts";
import {
  asWorkspaceAgentRuntimeManifest,
  asMateDocuments,
  sha256Digest,
  validateMateDefinition
} from "./validation.ts";
import {
  loadReleaseDefinition,
  prepareReleaseDefinition,
  releaseDefinitionStatements,
  type MateReleaseStorageRow
} from "./definitionStorage.ts";
import { defaultIdentityDocuments } from "./defaults.ts";
import { publishSkillPrivate, readSkill } from "../skills/service.ts";
import type { PublishSkillInput } from "../skills/package.ts";

type MateRow = {
  active_release_id?: string;
  created_at: string;
  description: string;
  display_name: string;
  draft_documents_json: string;
  draft_manifest_json: string;
  draft_revision: number;
  id: string;
  is_default?: number;
  job_role: string;
  org_id: string;
  org_slug: string;
  owner_user_id: string;
  preview_release_id?: string;
  status: string;
  updated_at: string;
  visibility: string;
  work_email?: string;
};

type MateReleaseRow = MateReleaseStorageRow & {
  activated_at?: string;
  created_at: string;
  created_by: string;
  documents_json: string;
  id: string;
  manifest_json: string;
  manifest_r2_key?: string;
  manifest_sha256: string;
  manifest_size_bytes?: number;
  storage_mode?: string;
  status: string;
  mate_id: string;
  version: number;
};

export type CreateMateInput = {
  creationProfile?: unknown;
  mcpCapacity?: unknown;
  allAppMcp?: unknown;
  allFolderEdit?: unknown;
  /** Legacy compatibility input. Model switching is now derived from allowedModels length. */
  allowModelSelection?: unknown;
  allowedModels?: unknown;
  appMcpBindings?: unknown;
  workspacePassMcpEnabled?: unknown;
  avatarUrl?: unknown;
  builtInToolIds?: unknown;
  defaultModel?: unknown;
  defaultTimezone?: unknown;
  description?: unknown;
  displayName?: unknown;
  emailEnabled?: unknown;
  embeddedEnabled?: unknown;
  jobRole?: unknown;
  allKnowledgeServices?: unknown;
  knowledgeServiceIds?: unknown;
  folderEditIds?: unknown;
  scheduleEnabled?: unknown;
  scheduledJobs?: unknown;
  standaloneEnabled?: unknown;
  taskModeEnabled?: unknown;
  targetIds?: unknown;
  mateCallEnabled?: unknown;
  visibility?: unknown;
  workEmail?: unknown;
};

const PERSONAL_MATE_CREATION_DEFAULTS = {
  mcpCapacity: DEFAULT_MATE_MCP_CAPACITY,
  allAppMcp: true,
  allFolderEdit: true,
  allKnowledgeServices: true,
  allowedModels: [...WORKSPACE_MATE_DEFAULT_MODELS],
  appMcpBindings: [],
  builtInToolIds: [...WORKSPACE_DEFAULT_BUILT_IN_TOOL_IDS, "public_web_search", "ocr", "document_read", "artifact_create"],
  defaultTimezone: "Asia/Shanghai",
  emailEnabled: true,
  embeddedEnabled: true,
  workspacePassMcpEnabled: false,
  folderEditIds: [],
  knowledgeServiceIds: [],
  standaloneEnabled: true,
  taskModeEnabled: true,
  mateCallEnabled: true,
  visibility: "private"
} as const;

function applyCreationProfile(input: CreateMateInput): CreateMateInput {
  if (input.creationProfile === undefined) return input;
  if (input.creationProfile !== "personal_mate") throw new HttpError(422, "mate_creation_profile_invalid");
  return { ...PERSONAL_MATE_CREATION_DEFAULTS, ...input };
}

export async function listMates(db: D1Database, principal: Principal): Promise<Mate[]> {
  const rows = await db.prepare(`
    SELECT * FROM apps_mates
    WHERE org_id = ? AND owner_user_id = ?
    ORDER BY updated_at DESC, display_name
  `).bind(principal.orgId, principal.sub).all<MateRow>();
  return (rows.results ?? []).map((row) => mateFromRow(row, false));
}

export async function readDefaultMate(db: D1Database, principal: Principal): Promise<Mate | null> {
  const row = await db.prepare(`
    SELECT * FROM apps_mates WHERE org_id = ? AND owner_user_id = ? AND is_default = 1 LIMIT 1
  `).bind(principal.orgId, principal.sub).first<MateRow>();
  return row ? mateFromRow(row, false) : null;
}

/** Idempotent activation shared by the web and miniapp. Existing ordinary Mates keep their identity. */
export async function activateDefaultMate(input: { displayName?: unknown; avatarUrl?: unknown }, env: Env, principal: Principal): Promise<Mate> {
  const current = await readDefaultMate(env.APPS_DB, principal);
  // Activation is idempotent. Once published, the owner may customize every
  // setting except the Code; a repeated activation must preserve those edits.
  if (current?.status === "published") { await provisionMateMail(env,principal,current.id); return current; }
  const userEmail = principal.email?.trim().toLowerCase() || "";
  const localPart = userEmail.split("@")[0] || "";
  if (!/^[a-z0-9](?:[a-z0-9._+-]{0,61}[a-z0-9])?$/.test(localPart)) {
    throw new HttpError(422, "default_mate_user_email_invalid");
  }
  const workEmail = `${localPart}@${installationHostname(env.WORKSPACE_MATE_EMAIL_DOMAIN)}`;
  let mate = current;
  let adoptedExisting = false;
  if (!mate) {
    const existing = await env.APPS_DB.prepare("SELECT * FROM apps_mates WHERE work_email = ? LIMIT 1")
      .bind(workEmail).first<MateRow>();
    if (existing) {
      if (existing.org_id !== principal.orgId || existing.owner_user_id !== principal.sub || existing.status === "archived") {
        throw new HttpError(409, "default_mate_email_conflict");
      }
      mate = mateFromRow(existing, false);
      adoptedExisting = true;
    } else {
      const displayName = requireInputText(input.displayName, "mate_display_name_required", 120);
      const avatarUrl = readString(input.avatarUrl).trim();
      if (!matePetIdFromAvatarUrl(avatarUrl)) throw new HttpError(422, "default_mate_avatar_invalid");
      const ownerName = principal.name?.trim() || localPart;
      try {
        mate = await createMate({
          creationProfile: "personal_mate",
          avatarUrl,
          description: `${ownerName}的工作秘书，允许访问其有权访问的知识库、应用及相关内容，协助处理日常工作。`,
          displayName,
          jobRole: "个人工作秘书",
          workEmail
        }, env, principal);
      } catch (error) {
        if (!(error instanceof HttpError) || !["mate_email_conflict", "mate_identity_conflict"].includes(error.message)) throw error;
        const raced = await env.APPS_DB.prepare("SELECT * FROM apps_mates WHERE work_email = ? AND org_id = ? AND owner_user_id = ? LIMIT 1")
          .bind(workEmail, principal.orgId, principal.sub).first<MateRow>();
        if (!raced) throw new HttpError(409, "default_mate_email_conflict");
        mate = mateFromRow(raced, false);
      }
    }
  }
  // Expose the identity while provisioning so clients can observe real progress
  // and a retry can resume the same default Mate after a deployment failure.
  mate = await markDefaultMate(env.APPS_DB, principal, mate.id);
  if (adoptedExisting && input.displayName !== undefined && input.avatarUrl !== undefined) {
    const displayName = requireInputText(input.displayName, "mate_display_name_required", 120);
    const avatarUrl = readString(input.avatarUrl).trim();
    if (!matePetIdFromAvatarUrl(avatarUrl)) throw new HttpError(422, "default_mate_avatar_invalid");
    // A timed-out activation can leave a valid draft or release behind. Reuse it
    // when the retry carries the same identity instead of creating another release.
    if (mate.displayName !== displayName || mate.avatarUrl !== avatarUrl) {
      mate = await patchMate({
        displayName,
        avatarUrl,
        jobRole: "个人工作秘书",
        description: `${principal.name?.trim() || localPart}的工作秘书，允许访问其有权访问的知识库、应用及相关内容，协助处理日常工作。`,
        visibility: "private"
      }, env, principal, mate.id);
      const { documents, manifest } = await initialDefinition({
        ...PERSONAL_MATE_CREATION_DEFAULTS,
        avatarRef: avatarUrl,
        defaultModel: undefined,
        description: mate.description,
        displayName,
        jobRole: "个人工作秘书",
        ownerUserId: principal.sub,
        ownerName: principal.name,
        departmentName: principal.departmentName,
        scheduleEnabled: false,
        scheduledJobs: [],
        targetIds: [],
        mateId: mate.id,
        workEmail
      });
      mate = await updateMateDraft({
        documents,
        expectedRevision: mate.draftRevision,
        manifest
      }, env, principal, mate.id);
      const release = await deployMatePreview(env, principal, mate.id);
      await publishMateRelease(env, principal, mate.id, release.id);
      return markDefaultMate(env.APPS_DB, principal, mate.id);
    }
  }
  if (mate.status === "published") return markDefaultMate(env.APPS_DB, principal, mate.id);
  const draft = await readMate(env.APPS_DB, principal, mate.id, false);
  const releaseId = draft.previewReleaseId || (await deployMatePreview(env, principal, mate.id)).id;
  await publishMateRelease(env, principal, mate.id, releaseId);
  return markDefaultMate(env.APPS_DB, principal, mate.id);
}

async function markDefaultMate(db: D1Database, principal: Principal, mateId: string): Promise<Mate> {
  try {
    await db.prepare("UPDATE apps_mates SET is_default = 1 WHERE id = ? AND org_id = ? AND owner_user_id = ?")
      .bind(mateId, principal.orgId, principal.sub).run();
  } catch (error) {
    if (!String(error).toLowerCase().includes("unique")) throw error;
    const winner = await readDefaultMate(db, principal);
    if (!winner) throw error;
    return winner;
  }
  return readMate(db, principal, mateId, false);
}

export async function createMate(input: CreateMateInput, env: Env, principal: Principal): Promise<Mate> {
  input = applyCreationProfile(input);
  if (Object.hasOwn(input, "templateId")) {
    throw new HttpError(410, "mate_templates_removed", {
      migration: "Remove templateId and configure the Mate identity, resources, channels, Soul, and Handbook directly."
    });
  }
  const displayName = requireInputText(input.displayName, "mate_display_name_required", 120);
  const jobRole = requireInputText(input.jobRole, "mate_job_role_required", 200);
  const workEmail = normalizeEmail(input.workEmail, env);
  const avatarRef = normalizeMateAvatarRef(input.avatarUrl || randomMatePetAvatarUrl(), env);
  // Mate Code is the single immutable address key: it identifies both
  // the mailbox local-part and the public /mates/:code route.
  const mateId = mateCodeFromWorkEmail(workEmail);
  const description = optionalText(input.description, 1000);
  const visibility = normalizeVisibility(input.visibility);
  const targetIds = normalizeInvocationTargets(input.targetIds, visibility);
  const taskModeEnabled = input.taskModeEnabled === true;
  if (taskModeEnabled && input.emailEnabled === false && input.mateCallEnabled === false) {
    throw new HttpError(422, "mate_task_entry_required");
  }
  const now = new Date().toISOString();
  const { documents, manifest } = await initialDefinition({
    mcpCapacity: input.mcpCapacity,
    allAppMcp: input.allAppMcp,
    allFolderEdit: input.allFolderEdit,
    allowedModels: input.allowedModels,
    appMcpBindings: input.appMcpBindings,
    workspacePassMcpEnabled: input.workspacePassMcpEnabled,
    avatarRef,
    builtInToolIds: input.builtInToolIds,
    defaultModel: input.defaultModel,
    defaultTimezone: input.defaultTimezone,
    description,
    displayName,
    emailEnabled: taskModeEnabled && input.emailEnabled !== false,
    embeddedEnabled: true,
    jobRole,
    allKnowledgeServices: input.allKnowledgeServices,
    knowledgeServiceIds: input.knowledgeServiceIds,
    folderEditIds: input.folderEditIds,
    ownerUserId: principal.sub,
    ownerName: principal.name,
    departmentName: principal.departmentName,
    scheduleEnabled: taskModeEnabled && input.scheduleEnabled === true,
    scheduledJobs: input.scheduledJobs,
    standaloneEnabled: true,
    targetIds,
    mateCallEnabled: taskModeEnabled && input.mateCallEnabled !== false,
    mateId,
    visibility,
    workEmail
  });
  const validation = await validateMateDefinition({ documents, manifest, ownerUserId: principal.sub, mateId, workEmail });
  if (!validation.valid) throw new HttpError(422, "mate_definition_invalid", { validation });

  try {
    await env.APPS_DB.prepare(`
      INSERT INTO apps_mates (
        id, org_id, org_slug, owner_user_id, display_name, job_role, description,
        work_email, status, visibility, draft_revision, draft_manifest_json,
        draft_documents_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, 1, ?, ?, ?, ?)
    `).bind(
      mateId,
      principal.orgId,
      principal.orgSlug,
      principal.sub,
      displayName,
      jobRole,
      description,
      workEmail,
      visibility,
      JSON.stringify(manifest),
      JSON.stringify(documents),
      now,
      now
    ).run();
  } catch (error) {
    const message = String(error).toLowerCase();
    if (message.includes("unique") && message.includes("work_email")) throw new HttpError(409, "mate_email_conflict");
    if (message.includes("unique")) throw new HttpError(409, "mate_identity_conflict");
    throw error;
  }

  await audit(env.APPS_DB, principal, "created Mate", "apps_mate", mateId, { displayName, jobRole, workEmail });
  return readMate(env.APPS_DB, principal, mateId, true);
}

export async function readMate(db: D1Database, principal: Principal, mateId: string, includeDraft = true): Promise<Mate> {
  const row = await requireOwnedMate(db, principal, mateId);
  const mate = mateFromRow(row, includeDraft);
  if (mate.draftManifest && mate.draftDocuments) await ensureMateMailDocument(mate.draftManifest, mate.draftDocuments, mate.isDefault);
  return mate;
}

export type OwnerMateDefinitionChange = {
  expectedDraftRevision: number;
  expectedReleaseId: string;
  mail?: string;
  inboxPrompt?: string;
  soul?: string;
  handbook?: string;
  builtInToolIds?: string[];
  mcpCapacity?: unknown;
  skill?: { skillId?: string; skillMarkdown: string; version: string; files?: Array<{ path: string; content: string }> };
  installSkill?: { skillId: string; version: string; digest: string };
  removeSkillIds?: string[];
};

/** Native Runtime control-plane entry. The service identity authenticates the
 * transport; the invoking user must still own this exact Mate. */
export async function reviewOwnedMateDefinition(env: Env, principal: Principal, mateId: string) {
  const mate = await readMate(env.APPS_DB, principal, mateId, true);
  if (!mate.activeReleaseId) throw new HttpError(409, "mate_not_published");
  const active = await readMateRelease(env, principal, mateId, mate.activeReleaseId);
  const installedSkills = await Promise.all(active.manifest.release.skills.map(async ref => {
    const row = await env.APPS_DB.prepare('SELECT name FROM apps_skills WHERE id = ? AND org_id = ?')
      .bind(ref.skillId, mate.orgId).first<{ name: string }>();
    return { ...ref, name: row?.name || ref.skillId, source: 'installed', canUninstall: true };
  }));
  return {
    activeReleaseId: mate.activeReleaseId,
    draftRevision: mate.draftRevision,
    installedSkills,
    hasUnpublishedChanges: definitionContent(mate.draftManifest!, mate.draftDocuments!, mate.isDefault) !== definitionContent(active.manifest, active.documents, mate.isDefault),
    mail: mateMailContent(mate.draftManifest!, mate.draftDocuments!, mate.isDefault),
    inboxPrompt: mateMailContent(mate.draftManifest!, mate.draftDocuments!, mate.isDefault),
    soul: mate.draftDocuments?.find((document) => document.kind === "soul")?.content,
    handbook: mate.draftDocuments?.find((document) => document.kind === "handbook")?.content,
    skills: await Promise.all((mate.draftManifest?.release.skills ?? []).map(async ref => {
      const row = await env.APPS_DB.prepare('SELECT name FROM apps_skills WHERE id = ? AND org_id = ?')
        .bind(ref.skillId, mate.orgId).first<{ name: string }>();
      return { ...ref, name: row?.name || ref.skillId, source: 'installed', canUninstall: true };
    })),
    builtInToolIds: mate.draftManifest?.resources.builtInToolBindings.map((binding) => binding.toolId) ?? [],
    mcpCapacity: mate.draftManifest?.resources.mcpCapacity
  };
}

export async function updateOwnedMateDefinition(
  env: Env, principal: Principal, mateId: string, input: OwnerMateDefinitionChange
) {
  const mate = await readMate(env.APPS_DB, principal, mateId, true);
  if (!mate.activeReleaseId || mate.activeReleaseId !== input.expectedReleaseId) {
    throw new HttpError(409, "mate_active_release_changed");
  }
  if (mate.draftRevision !== input.expectedDraftRevision) {
    throw new HttpError(409, "mate_draft_revision_conflict", { currentRevision: mate.draftRevision });
  }
  if (!mate.draftManifest || !mate.draftDocuments) throw new HttpError(409, "mate_draft_missing");
  const active = await readMateRelease(env, principal, mateId, mate.activeReleaseId);
  // A plugin/SOUL approval must never silently publish unrelated pending edits.
  if (definitionContent(mate.draftManifest, mate.draftDocuments, mate.isDefault) !== definitionContent(active.manifest, active.documents, mate.isDefault))
    throw new HttpError(409, 'mate_unpublished_draft_changes');
  const documents = structuredClone(mate.draftDocuments);
  const manifest = structuredClone(mate.draftManifest);
  if (input.removeSkillIds !== undefined) {
    if (!Array.isArray(input.removeSkillIds) || !input.removeSkillIds.length || input.removeSkillIds.length > 64
      || input.removeSkillIds.some(id => typeof id !== 'string' || !manifest.release.skills.some(ref => ref.skillId === id))) {
      throw new HttpError(400, 'mate_skill_uninstall_invalid');
    }
    manifest.release.skills = manifest.release.skills.filter(ref => !input.removeSkillIds!.includes(ref.skillId));
  }
  if (input.installSkill) {
    const ref = input.installSkill;
    if (typeof ref.skillId !== 'string' || typeof ref.version !== 'string' || typeof ref.digest !== 'string')
      throw new HttpError(400, 'mate_skill_install_invalid');
    const skill = await readSkill(env.APPS_DB, principal, ref.skillId);
    const pinned = skill.versions.find(version => version.version === ref.version);
    if (!pinned || ref.digest !== `sha256:${pinned.artifactSha256}`) throw new HttpError(409, 'mate_skill_version_changed');
    if (manifest.release.skills.length >= 64 && !manifest.release.skills.some(item => item.skillId === ref.skillId))
      throw new HttpError(422, 'mate_skill_limit_exceeded');
    manifest.release.skills = [...manifest.release.skills.filter(item => item.skillId !== ref.skillId),
      { skillId: ref.skillId, version: ref.version, digest: ref.digest }];
  }
  const mailContent = requestedMailContent(input);
  if (mailContent !== undefined) await setMateMailContent(manifest, documents, mailContent);
  if (input.soul !== undefined || input.handbook !== undefined) {
    for (const kind of ["soul", "handbook"] as const) {
      const content = input[kind];
      if (content === undefined) continue;
      const limit = kind === "soul" ? 120_000 : 240_000;
      if (!content.trim() || content.length > limit) throw new HttpError(400, `mate_${kind}_invalid`);
      const document = documents.find((item) => item.kind === kind);
      if (!document) throw new HttpError(409, `mate_${kind}_missing`);
      document.content = content;
      document.digest = await sha256Digest(content);
      if (kind === "soul") manifest.release.soul.digest = document.digest;
      else {
        const ref = manifest.release.handbooks.find((item) => item.id === document.id);
        if (!ref) throw new HttpError(409, "mate_handbook_reference_missing");
        ref.digest = document.digest;
      }
    }
  }
  if (input.builtInToolIds !== undefined) {
    if (!Array.isArray(input.builtInToolIds) || input.builtInToolIds.length > 32
      || input.builtInToolIds.some((id) => typeof id !== "string")) {
      throw new HttpError(400, "mate_toolset_invalid");
    }
    manifest.resources.builtInToolBindings = withWorkspaceIntrinsicBuiltInToolIds(input.builtInToolIds)
      .map((toolId) => ({ toolId, requiresCurrentUserContext: true }));
  }
  if (input.mcpCapacity !== undefined) {
    if (!isMateMcpCapacity(input.mcpCapacity)) throw new HttpError(400, "mate_mcp_capacity_invalid");
    manifest.resources.mcpCapacity = input.mcpCapacity;
  }
  const preflight = await validateMateDefinition({
    documents, manifest, ownerUserId: mate.ownerUserId,
    mateId, workEmail: mate.workEmail
  });
  if (!preflight.valid) throw new HttpError(422, "mate_definition_invalid", { validation: preflight });
  let publishedSkill: AppsSkill | undefined;
  if (input.skill) {
    const { skillId, skillMarkdown, version, files } = input.skill;
    if (skillId && !manifest.release.skills.some((ref) => ref.skillId === skillId)) {
      throw new HttpError(403, "mate_skill_not_attached");
    }
    if (!skillId && manifest.release.skills.length >= 64) throw new HttpError(422, "mate_skill_limit_exceeded");
    if (skillId) {
      const existing = await readSkill(env.APPS_DB, principal, skillId);
      if (!principalOwnsUserId(existing.ownerUserId, principal)) throw new HttpError(403, "mate_skill_owner_required");
    }
    const skillInput: PublishSkillInput = { skillId, skillMarkdown, version, files };
    const skill = await publishSkillPrivate(skillInput, env, principal);
    publishedSkill = skill;
    const current = skill.versions.find((item) => item.id === skill.currentVersionId);
    if (!current?.artifactSha256) throw new HttpError(502, "mate_skill_version_missing");
    manifest.release.skills = [
      ...manifest.release.skills.filter((ref) => ref.skillId !== skill.id),
      { digest: `sha256:${current.artifactSha256}`, skillId: skill.id, version: current.version }
    ];
  }
  const updated = await updateMateDraft({
    documents, expectedRevision: input.expectedDraftRevision, manifest
  }, env, principal, mateId);
  return { mate: updated, skill: publishedSkill };
}

export async function patchMate(
  input: Record<string, unknown>,
  env: Env,
  principal: Principal,
  mateId: string
): Promise<Mate> {
  const row = await requireOwnedMate(env.APPS_DB, principal, mateId);
  const displayName = input.displayName === undefined ? row.display_name : requireInputText(input.displayName, "mate_display_name_required", 120);
  const jobRole = input.jobRole === undefined ? row.job_role : requireInputText(input.jobRole, "mate_job_role_required", 200);
  const description = input.description === undefined ? row.description : optionalText(input.description, 1000);
  const workEmail = row.work_email || "";
  if (input.workEmail !== undefined && normalizeEmail(input.workEmail, env) !== workEmail) {
    throw new HttpError(409, "mate_code_immutable");
  }
  const visibility = input.visibility === undefined ? normalizeVisibility(row.visibility) : normalizeVisibility(input.visibility);
  const manifest = parseObject(row.draft_manifest_json) as WorkspaceAgentRuntimeManifest;
  const avatarRef = input.avatarUrl === undefined
    ? normalizeMateAvatarRef(manifest.mate.avatarRef, env)
    : normalizeMateAvatarRef(input.avatarUrl, env);
  const targetIds = normalizeInvocationTargets(
    input.targetIds === undefined ? manifest.invocationPolicy.targetIds : input.targetIds,
    visibility
  );
  manifest.mate.displayName = displayName;
  manifest.mate.jobRole = jobRole;
  manifest.mate.description = description;
  if (avatarRef) manifest.mate.avatarRef = avatarRef;
  else delete manifest.mate.avatarRef;
  manifest.mate.addresses = [
    ...(workEmail ? [{ type: "email" as const, address: workEmail }] : []),
    { type: "pass_mcp" as const, tool: WORKSPACE_MATE_CALL_TOOL }
  ];
  manifest.invocationPolicy.visibility = visibility;
  if (visibility === "targets") manifest.invocationPolicy.targetIds = targetIds;
  else delete manifest.invocationPolicy.targetIds;
  const now = new Date().toISOString();

  try {
    await env.APPS_DB.prepare(`
      UPDATE apps_mates
      SET display_name = ?, job_role = ?, description = ?, visibility = ?,
          draft_manifest_json = ?, draft_revision = draft_revision + 1, updated_at = ?
      WHERE id = ?
    `).bind(displayName, jobRole, description, visibility, JSON.stringify(manifest), now, mateId).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) throw new HttpError(409, "mate_email_conflict");
    throw error;
  }
  await audit(env.APPS_DB, principal, "updated Mate identity", "apps_mate", mateId, { displayName, jobRole, workEmail });
  return readMate(env.APPS_DB, principal, mateId, true);
}

/** Retires a Mate from use while retaining its definitions and release audit trail. */
export async function archiveMate(env: Env, principal: Principal, mateId: string) {
  const row = await requireOwnedMate(env.APPS_DB, principal, mateId);
  if (row.is_default) throw new HttpError(409, "default_mate_cannot_archive");
  if (row.status === "archived") return { archived: true };
  if(env.WORKSPACE_MAIL) {
    const response=await workspaceMailRequest(env,{userId:row.owner_user_id,orgId:row.org_id,mateId:mateId,scopes:["mail:provision"]},"/internal/mailboxes/disable",{});
    if(!response.ok)throw new HttpError(503,"mate_mail_revocation_failed");
  }
  const now = new Date().toISOString();
  await env.APPS_DB.batch([
    env.APPS_DB.prepare(`
      UPDATE apps_mate_releases
      SET status = 'revoked'
      WHERE mate_id = ? AND status IN ('candidate', 'published')
    `).bind(mateId),
    env.APPS_DB.prepare(`
      UPDATE apps_mates
      SET status = 'archived', active_release_id = NULL, preview_release_id = NULL, updated_at = ?
      WHERE id = ?
    `).bind(now, mateId)
  ]);
  await audit(env.APPS_DB, principal, "archived Mate", "apps_mate", mateId, {
    previousStatus: row.status,
    activeReleaseId: row.active_release_id || null
  });
  return { archived: true };
}

export async function updateMateDraft(
  input: { documents?: unknown; expectedRevision?: unknown; manifest?: unknown },
  env: Env,
  principal: Principal,
  mateId: string
): Promise<Mate> {
  const row = await requireOwnedMate(env.APPS_DB, principal, mateId);
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== row.draft_revision) {
    throw new HttpError(409, "mate_draft_revision_conflict", { currentRevision: row.draft_revision });
  }
  const manifest = asWorkspaceAgentRuntimeManifest(input.manifest);
  manifest.resources.mcpCapacity = migrateLegacyMateMcpCapacity(manifest.resources);
  delete manifest.taskPolicy.defaultExecutor;
  for (const job of manifest.taskPolicy.scheduledJobs ?? []) {
    delete job.executor;
    delete job.forumReview;
  }
  manifest.resources.builtInToolBindings = withWorkspaceIntrinsicBuiltInToolIds(
    manifest.resources.builtInToolBindings.map((binding) => binding.toolId)
      .filter((toolId) => toolId !== "workspace_forum_read" && toolId !== "workspace_forum_post")
  ).map((toolId) => ({
    toolId,
    requiresCurrentUserContext: true
  }));
  const documents = asMateDocuments(input.documents);
  await ensureMateMailDocument(manifest, documents, row.is_default === 1);
  const validation = await validateMateDefinition({
    documents,
    manifest,
    ownerUserId: row.owner_user_id,
    mateId,
    workEmail: row.work_email
  });
  if (!validation.valid) throw new HttpError(422, "mate_definition_invalid", { validation });
  const now = new Date().toISOString();
  const updated = await env.APPS_DB.prepare(`
    UPDATE apps_mates
    SET draft_manifest_json = ?, draft_documents_json = ?, draft_revision = draft_revision + 1,
        visibility = ?, updated_at = ?
    WHERE id = ? AND draft_revision = ?
  `).bind(
    JSON.stringify(manifest),
    JSON.stringify(documents),
    manifest.invocationPolicy.visibility,
    now,
    mateId,
    row.draft_revision
  ).run();
  if (updated.meta?.changes === 0) {
    throw new HttpError(409, "mate_draft_revision_conflict");
  }
  await audit(env.APPS_DB, principal, "updated Mate draft", "apps_mate", mateId, { fromRevision: row.draft_revision });
  return readMate(env.APPS_DB, principal, mateId, true);
}

export async function validateMateDraft(env: Env, principal: Principal, mateId: string) {
  const row = await requireOwnedMate(env.APPS_DB, principal, mateId);
  const manifest = asWorkspaceAgentRuntimeManifest(parseObject(row.draft_manifest_json));
  const documents = asMateDocuments(parseArray(row.draft_documents_json));
  await ensureMateMailDocument(manifest, documents, row.is_default === 1);
  const validation = await validateMateDefinition({
    documents,
    manifest,
    ownerUserId: row.owner_user_id,
    mateId,
    workEmail: row.work_email
  });
  if (validation.valid) {
    const hasUsableCapability = manifest.resources.appMcpBindings.length > 0
      || manifest.resources.workspacePassMcpScope?.mode === "all_authorized_for_invoking_user"
      || manifest.resources.knowledgeServiceBindings.length > 0
      || manifest.resources.knowledgeServiceScope?.mode === "all_visible_to_invoking_user"
      || manifest.resources.builtInToolBindings.length > 0
      || manifest.release.skills.length > 0;
    if (!hasUsableCapability) {
      validation.errors.push({
        code: "mate_usable_capability_required",
        message: "Deploy Preview requires at least one App MCP, Knowledge Service, built-in Tool, or pinned Skill.",
        path: "/resources"
      });
      validation.valid = false;
    }
  }
  if (validation.valid) {
    for (const binding of manifest.resources.appMcpBindings) {
      try {
        const registered = await readAccessibleMcpApp(env, principal, binding.appId);
        if (binding.manifestVersion !== registered.manifest.schemaVersion) {
          validation.errors.push({
            code: "app_mcp_manifest_version_mismatch",
            message: `Configured ${binding.manifestVersion}; current registration is ${registered.manifest.schemaVersion}.`,
            path: `/resources/appMcpBindings/${binding.appId}/manifestVersion`
          });
        }
      } catch {
        validation.errors.push({
          code: "app_mcp_not_accessible",
          message: "The publisher cannot access the selected published App MCP registration.",
          path: `/resources/appMcpBindings/${binding.appId}`
        });
      }
    }
    validation.valid = validation.errors.length === 0;
  }
  return validation;
}

export async function reviewMateCore(db: D1Database, principal: Principal, mateId: string) {
  const mate = await readMate(db, principal, mateId, true);
  const manifest = mate.draftManifest;
  const documents = mate.draftDocuments ?? [];
  if (!manifest) throw new HttpError(409, "mate_draft_missing");
  return {
    mate: {
      mateId: mate.id,
      displayName: mate.displayName,
      jobRole: mate.jobRole,
      draftRevision: mate.draftRevision,
      activeReleaseId: mate.activeReleaseId,
      previewReleaseId: mate.previewReleaseId
    },
    soul: {
      ref: manifest.release.soul,
      content: documents.find((document) => document.kind === "soul")?.content ?? ""
    },
    mail: { ref: manifest.release.mail, fileName: "mail.md", content: mateMailContent(manifest, documents, mate.isDefault) },
    inboxPrompt: mateMailContent(manifest, documents, mate.isDefault),
    handbooks: manifest.release.handbooks.map((ref) => ({
      ref,
      content: documents.find((document) => document.kind === "handbook" && document.id === ref.id && document.version === ref.version)?.content ?? ""
    })),
    review: {
      automaticMutationAllowed: false,
      requiresHumanReview: true,
      deployAndPublishRequiredToTakeEffect: true,
      userIsolationRule: "Runtime data and delegated resource access are isolated by mateId × userId."
    }
  };
}

export async function updateMateCore(
  input: { expectedRevision?: unknown; handbook?: unknown; soul?: unknown; mail?: unknown; inboxPrompt?: unknown },
  env: Env,
  principal: Principal,
  mateId: string
) {
  const mate = await readMate(env.APPS_DB, principal, mateId, true);
  if (!mate.draftManifest || !mate.draftDocuments) throw new HttpError(409, "mate_draft_missing");
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== mate.draftRevision) {
    throw new HttpError(409, "mate_draft_revision_conflict", { currentRevision: mate.draftRevision });
  }
  const soulContent = input.soul === undefined
    ? mate.draftDocuments.find((document) => document.kind === "soul")?.content ?? ""
    : requireInputText(input.soul, "mate_soul_required", 120_000);
  const handbookContent = input.handbook === undefined
    ? mate.draftDocuments.find((document) => document.kind === "handbook")?.content ?? ""
    : requireInputText(input.handbook, "mate_handbook_required", 240_000);
  const documents = structuredClone(mate.draftDocuments);
  const soulDocument = documents.find((document) => document.kind === "soul");
  const handbookDocument = documents.find((document) => document.kind === "handbook");
  if (!soulDocument || !handbookDocument) throw new HttpError(409, "mate_core_documents_missing");
  soulDocument.content = soulContent;
  soulDocument.digest = await sha256Digest(soulContent);
  handbookDocument.content = handbookContent;
  handbookDocument.digest = await sha256Digest(handbookContent);
  const manifest = structuredClone(mate.draftManifest);
  const mailContent = requestedMailContent(input);
  if (mailContent !== undefined) await setMateMailContent(manifest, documents, mailContent);
  manifest.release.soul.digest = soulDocument.digest;
  const handbookRef = manifest.release.handbooks.find((ref) => ref.id === handbookDocument.id && ref.version === handbookDocument.version);
  if (!handbookRef) throw new HttpError(409, "mate_handbook_reference_missing");
  handbookRef.digest = handbookDocument.digest;
  return updateMateDraft({ documents, expectedRevision, manifest }, env, principal, mateId);
}

export async function deployMatePreview(env: Env, principal: Principal, mateId: string): Promise<MateRelease> {
  const row = await requireOwnedMate(env.APPS_DB, principal, mateId);
  const validation = await validateMateDraft(env, principal, mateId);
  if (!validation.valid) throw new HttpError(422, "mate_definition_invalid", { validation });
  const previous = await env.APPS_DB.prepare("SELECT MAX(version) AS version FROM apps_mate_releases WHERE mate_id = ?")
    .bind(mateId).first<{ version?: number }>();
  const version = Number(previous?.version || 0) + 1;
  const releaseId = `${mateId}-r${version}`;
  const now = new Date().toISOString();
  const draft = await readMate(env.APPS_DB, principal, mateId, true);
  const prepared = await prepareReleaseDefinition({
    createdAt: now,
    createdBy: principal.sub,
    documents: draft.draftDocuments!,
    env,
    manifest: draft.draftManifest!,
    releaseId,
    releaseVersion: version,
    mateId
  });

  await env.APPS_DB.batch([
    env.APPS_DB.prepare("UPDATE apps_mate_releases SET status = 'retired' WHERE mate_id = ? AND status = 'candidate'").bind(mateId),
    env.APPS_DB.prepare(`
      INSERT INTO apps_mate_releases (
        id, mate_id, version, status, schema_version, manifest_sha256, manifest_json,
        documents_json, storage_mode, manifest_r2_key, manifest_size_bytes,
        created_by, created_at, activated_at
      ) VALUES (?, ?, ?, 'candidate', ?, ?, '{}', '[]', 'r2', ?, ?, ?, ?, NULL)
    `).bind(
      releaseId,
      mateId,
      version,
      WORKSPACE_AGENT_RUNTIME_SCHEMA_VERSION,
      prepared.manifestSha256,
      prepared.manifestR2Key,
      prepared.manifestSizeBytes,
      principal.sub,
      now
    ),
    ...releaseDefinitionStatements(env.APPS_DB, releaseId, prepared.revisions),
    env.APPS_DB.prepare(`
      UPDATE apps_mates
      SET status = CASE WHEN active_release_id IS NULL THEN 'deployed' ELSE 'published' END,
          preview_release_id = ?, updated_at = ?
      WHERE id = ?
    `).bind(releaseId, now, mateId)
  ]);
  await audit(env.APPS_DB, principal, "deployed Mate Preview release", "apps_mate", mateId, {
    definitionStorage: "r2",
    manifestR2Key: prepared.manifestR2Key,
    manifestSha256: prepared.manifestSha256,
    releaseId,
    version
  });
  return readMateRelease(env, principal, mateId, releaseId);
}

export function mateAdoptionPreview(env: Env, release: MateRelease): MateAdoptionPreview {
  const configured = env.MATE_RUNTIME_PREVIEW_URL?.trim();
  const local = env.DEV_AUTH_BYPASS === "1" ? "http://localhost:8801" : "";
  const origin = safePreviewOrigin(configured || local);
  const webHostOrigin = safePreviewOrigin(env.MATE_WEB_HOST_URL?.trim() || "") || origin;
  const base = {
    available: Boolean(origin),
    mode: "shared-runtime-preview" as const,
    releaseId: release.id,
    mateId: release.mateId
  };
  if (!origin) return base;
  const matePath = `/mates/${encodeURIComponent(release.mateId)}`;
  return {
    ...base,
    testUrl: `${webHostOrigin}${matePath}/preview?release=${encodeURIComponent(release.id)}`,
    embedUrl: `${webHostOrigin}${matePath}/preview?release=${encodeURIComponent(release.id)}&presentation=embedded`,
    conversationUrl: `${webHostOrigin}${matePath}`
  };
}

export async function listMateReleases(env: Env, principal: Principal, mateId: string): Promise<MateRelease[]> {
  await requireOwnedMate(env.APPS_DB, principal, mateId);
  const rows = await env.APPS_DB.prepare("SELECT * FROM apps_mate_releases WHERE mate_id = ? ORDER BY version DESC")
    .bind(mateId).all<MateReleaseRow>();
  return Promise.all((rows.results ?? []).map((row) => releaseFromRow(env, row)));
}

export async function activateMateRelease(
  env: Env,
  principal: Principal,
  mateId: string,
  releaseId: string
): Promise<MateRelease> {
  await requireOwnedMate(env.APPS_DB, principal, mateId);
  const release = await requireRelease(env.APPS_DB, mateId, releaseId);
  if (release.status === "revoked") throw new HttpError(409, "mate_release_revoked");
  if (release.status === "candidate") throw new HttpError(409, "mate_release_not_previously_published");
  if (release.status === "published") return readMateRelease(env, principal, mateId, releaseId);
  if (!release.activated_at) throw new HttpError(409, "mate_release_not_previously_published");
  // Verify immutable document bytes and references before changing the live pointer.
  await releaseFromRow(env, release);
  await provisionMateMail(env,principal,mateId);
  const now = new Date().toISOString();
  await env.APPS_DB.batch([
    env.APPS_DB.prepare("UPDATE apps_mate_releases SET status = 'retired' WHERE mate_id = ? AND status = 'published'").bind(mateId),
    env.APPS_DB.prepare("UPDATE apps_mate_releases SET status = 'published', activated_at = ? WHERE id = ? AND mate_id = ?").bind(now, releaseId, mateId),
    env.APPS_DB.prepare("UPDATE apps_mates SET status = 'published', active_release_id = ?, updated_at = ? WHERE id = ?").bind(releaseId, now, mateId)
  ]);
  await audit(env.APPS_DB, principal, "activated Mate release", "apps_mate", mateId, { releaseId });
  return readMateRelease(env, principal, mateId, releaseId);
}

export async function publishMateRelease(
  env: Env,
  principal: Principal,
  mateId: string,
  releaseId: string
): Promise<MateRelease> {
  await requireOwnedMate(env.APPS_DB, principal, mateId);
  const release = await requireRelease(env.APPS_DB, mateId, releaseId);
  if (release.status !== "candidate") throw new HttpError(409, "mate_release_not_candidate");
  // Verify immutable document bytes and references before changing the live pointer.
  await releaseFromRow(env, release);
  await provisionMateMail(env,principal,mateId);
  const now = new Date().toISOString();
  await env.APPS_DB.batch([
    env.APPS_DB.prepare("UPDATE apps_mate_releases SET status = 'retired' WHERE mate_id = ? AND status = 'published'").bind(mateId),
    env.APPS_DB.prepare("UPDATE apps_mate_releases SET status = 'published', activated_at = ? WHERE id = ? AND mate_id = ? AND status = 'candidate'").bind(now, releaseId, mateId),
    env.APPS_DB.prepare(`
      UPDATE apps_mates
      SET status = 'published', active_release_id = ?,
          preview_release_id = CASE WHEN preview_release_id = ? THEN NULL ELSE preview_release_id END,
          updated_at = ?
      WHERE id = ?
    `).bind(releaseId, releaseId, now, mateId)
  ]);
  await audit(env.APPS_DB, principal, "published Mate release to Production", "apps_mate", mateId, { releaseId });
  return readMateRelease(env, principal, mateId, releaseId);
}

export async function readMateRelease(env: Env, principal: Principal, mateId: string, releaseId: string) {
  await requireOwnedMate(env.APPS_DB, principal, mateId);
  return releaseFromRow(env, await requireRelease(env.APPS_DB, mateId, releaseId));
}

export async function readActiveMateRuntimeRelease(env: Env, mateId: string, principal?: Principal) {
  const mate = await env.APPS_DB.prepare(`
    SELECT id, org_id, owner_user_id, display_name, job_role, description, work_email,
           status, visibility, active_release_id, created_at, updated_at
    FROM apps_mates
    WHERE id = ? AND status = 'published' AND active_release_id IS NOT NULL
    LIMIT 1
  `).bind(mateId).first<Pick<MateRow,
    "id" | "org_id" | "owner_user_id" | "display_name" | "job_role" | "description" |
    "work_email" | "status" | "visibility" | "active_release_id" | "created_at" | "updated_at"
  >>();
  if (!mate?.active_release_id) throw new HttpError(404, "mate_runtime_not_found");
  const release = await requireRelease(env.APPS_DB, mateId, mate.active_release_id);
  if (release.status !== "published") throw new HttpError(409, "mate_active_release_invalid");
  const runtimeRelease = await releaseFromRow(env, release);
  return {
    mate: {
      id: mate.id,
      orgId: mate.org_id,
      ownerUserId: mate.owner_user_id,
      displayName: mate.display_name,
      jobRole: mate.job_role,
      description: mate.description,
      workEmail: mate.work_email || undefined,
      visibility: normalizeVisibility(mate.visibility),
      updatedAt: mate.updated_at
    },
    release: runtimeRelease,
    skills: await runtimeSkillInstructions(env, mate.org_id, runtimeRelease, principal)
  };
}

async function runtimeSkillInstructions(env: Env, orgId: string, release: MateRelease, principal?: Principal) {
  const refs = release.manifest.release.skills;
  if (!refs.length || !principal || principal.orgId !== orgId) return [];
  if (!env.APPS_ARTIFACTS) throw new HttpError(503, "mate_skill_storage_unavailable");
  const skills = await Promise.all(refs.map(async (ref) => {
    try { await readSkill(env.APPS_DB, principal, ref.skillId); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
    const row = await env.APPS_DB.prepare(
      "SELECT skill.name, version.skill_md_key, version.artifact_sha256, version.manifest_json " +
      "FROM apps_skill_versions AS version JOIN apps_skills AS skill ON skill.id = version.skill_id " +
      "WHERE skill.id = ? AND skill.org_id = ? AND version.version = ? LIMIT 1"
    ).bind(ref.skillId, orgId, ref.version).first<{
      name: string; skill_md_key: string; artifact_sha256: string; manifest_json: string
    }>();
    if (!row || ref.digest !== "sha256:" + row.artifact_sha256) {
      throw new HttpError(409, "mate_skill_reference_invalid");
    }
    const object = await env.APPS_ARTIFACTS!.get(row.skill_md_key);
    if (!object) throw new HttpError(503, "mate_skill_content_unavailable");
    const markdown = await object.text();
    if (markdown.length > 200_000) throw new HttpError(409, "mate_skill_content_too_large");
    const metadata = JSON.parse(row.manifest_json) as { package?: { files?: Array<{ path: string }> } };
    const files = (metadata.package?.files || []).map(file => file.path).slice(0, 64);
    return { skillId: ref.skillId, version: ref.version, name: row.name, markdown, files };
  }));
  return skills.filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
}

export async function readRuntimeSkillFile(env: Env, principal: Principal, mateId: string, releaseId: string, skillId: string, path: string) {
  if (!path || path.length > 512 || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new HttpError(400, 'mate_skill_file_path_invalid');
  const definition = await readActiveMateRuntimeRelease(env, mateId, principal);
  if (definition.release.id !== releaseId) throw new HttpError(409, 'mate_active_release_changed');
  if (!definition.skills.some(skill => skill.skillId === skillId)) throw new HttpError(404, 'mate_skill_not_attached');
  const ref = definition.release.manifest.release.skills.find(item => item.skillId === skillId)!;
  const skill = await readSkill(env.APPS_DB, principal, skillId);
  const version = skill.versions.find(item => item.version === ref.version);
  if (!version || `sha256:${version.artifactSha256}` !== ref.digest) throw new HttpError(409, 'mate_skill_reference_invalid');
  const object = await env.APPS_ARTIFACTS?.get(version.artifactKey);
  if (!object) throw new HttpError(404, 'mate_skill_file_not_found');
  if (object.size > 2_000_000) throw new HttpError(413, 'mate_skill_package_too_large');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (`sha256:${await sha256Bytes(bytes)}` !== ref.digest) throw new HttpError(409, 'mate_skill_reference_invalid');
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes, { filter(file) {
    if (file.name !== path) return false;
    if (file.originalSize > 200_000) throw new HttpError(413, 'mate_skill_file_too_large');
    return true;
  } }); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'mate_skill_package_invalid'); }
  const file = files[path];
  if (!file) throw new HttpError(404, 'mate_skill_file_not_found');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(file); } catch { throw new HttpError(400, 'mate_skill_file_text_only'); }
  if (content.includes('\0')) throw new HttpError(400, 'mate_skill_file_text_only');
  return { skillId, version: ref.version, path, content, scriptsExecuted: false };
}

function definitionContent(sourceManifest: WorkspaceAgentRuntimeManifest, sourceDocuments: MateDocument[] = [], isDefault = true) {
  const manifest = structuredClone(sourceManifest);
  const mail = mateMailContent(manifest, sourceDocuments, isDefault);
  const documents = sourceDocuments.filter(document => document.kind !== "mail");
  manifest.channels.inbox.email.taskAuthority ??= manifest.channels.inbox.email.inboxPrompt === undefined && !isDefault ? "verified_sender" : "owner";
  delete manifest.channels.inbox.email.inboxPrompt;
  const value = { ...manifest, release: { skills: manifest.release.skills }, mail,
    documents: (documents || []).map(document => ({ kind: document.kind, content: document.content })).sort((a,b) =>
      `${a.kind}:${a.content}`.localeCompare(`${b.kind}:${b.content}`)) };
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => [key,canonical(value)])) : item;
  return JSON.stringify(canonical(value));
}

export async function listPublishedMateRuntimeIdentities(env: Env) {
  const rows = await env.APPS_DB.prepare(`
    SELECT id, org_id, owner_user_id, active_release_id
    FROM apps_mates
    WHERE status = 'published' AND active_release_id IS NOT NULL
    ORDER BY id
  `).all<{ active_release_id?: string; id: string; org_id: string; owner_user_id: string }>();
  return (rows.results ?? []).map((row) => ({
    activeReleaseId: row.active_release_id,
    id: row.id,
    orgId: row.org_id,
    ownerUserId: row.owner_user_id
  }));
}

export async function readActiveMateRuntimeReleaseByEmail(env: Env, workEmail: string, principal?: Principal) {
  const mate = await env.APPS_DB.prepare(`
    SELECT id FROM apps_mates
    WHERE lower(work_email) = lower(?) AND status = 'published' AND active_release_id IS NOT NULL
    LIMIT 1
  `).bind(workEmail.trim()).first<{ id?: string }>();
  if (!mate?.id) throw new HttpError(404, "mate_runtime_not_found");
  return readActiveMateRuntimeRelease(env, mate.id, principal);
}

export async function readOwnerTestRuntimeRelease(
  env: Env,
  mateId: string,
  releaseId: string,
  ownerUserId: string,
  principal?: Principal
) {
  const mate = await env.APPS_DB.prepare(`
    SELECT id, org_id, owner_user_id, display_name, job_role, description, work_email,
           status, visibility, active_release_id, created_at, updated_at
    FROM apps_mates
    WHERE id = ? AND owner_user_id = ?
    LIMIT 1
  `).bind(mateId, ownerUserId).first<Pick<MateRow,
    "id" | "org_id" | "owner_user_id" | "display_name" | "job_role" | "description" |
    "work_email" | "status" | "visibility" | "active_release_id" | "created_at" | "updated_at"
  >>();
  if (!mate) throw new HttpError(404, "mate_runtime_not_found");
  const release = await requireRelease(env.APPS_DB, mateId, releaseId);
  if (release.status !== "candidate") throw new HttpError(409, "mate_release_not_candidate");
  const runtimeRelease = await releaseFromRow(env, release);
  return {
    mate: {
      id: mate.id,
      orgId: mate.org_id,
      ownerUserId: mate.owner_user_id,
      displayName: mate.display_name,
      jobRole: mate.job_role,
      description: mate.description,
      workEmail: mate.work_email || undefined,
      visibility: normalizeVisibility(mate.visibility),
      updatedAt: mate.updated_at
    },
    release: runtimeRelease,
    skills: await runtimeSkillInstructions(env, mate.org_id, runtimeRelease, principal)
  };
}

async function initialDefinition(input: {
  mcpCapacity?: unknown;
  allAppMcp?: unknown;
  allFolderEdit?: unknown;
  allKnowledgeServices: unknown;
  allowedModels: unknown;
  appMcpBindings: unknown;
  workspacePassMcpEnabled: unknown;
  avatarRef: string;
  builtInToolIds: unknown;
  defaultModel: unknown;
  defaultTimezone: unknown;
  description: string;
  displayName: string;
  emailEnabled: boolean;
  embeddedEnabled: boolean;
  jobRole: string;
  knowledgeServiceIds: unknown;
  folderEditIds: unknown;
  ownerUserId: string;
  ownerName?: string;
  departmentName?: string;
  scheduleEnabled: boolean;
  scheduledJobs: unknown;
  standaloneEnabled: boolean;
  targetIds: string[];
  mateCallEnabled: boolean;
  mateId: string;
  visibility: MateVisibility;
  workEmail: string;
}) {
  const { handbook: handbookContent, soul: soulContent, mail: mailContent } = defaultIdentityDocuments(input);
  const soulDigest = await sha256Digest(soulContent);
  const handbookDigest = await sha256Digest(handbookContent);
  const documents: MateDocument[] = [
    { content: soulContent, digest: soulDigest, id: `${input.mateId}-soul`, kind: "soul", version: 1 },
    { content: handbookContent, digest: handbookDigest, id: `${input.mateId}-handbook`, kind: "handbook", version: 1 }
  ];
  const workspacePassMcpEnabled = input.workspacePassMcpEnabled === true;
  const allAppMcp = workspacePassMcpEnabled || input.allAppMcp === true;
  const allFolderEdit = input.allFolderEdit === true;
  const legacyToolIds = input.builtInToolIds === undefined ? [] : stringArray(input.builtInToolIds);
  const hasLegacyForumTools = legacyToolIds.some((id) => id === "workspace_forum_read" || id === "workspace_forum_post");
  const mcpCapacity = input.mcpCapacity === undefined
    ? hasLegacyForumTools
      ? migrateLegacyMateMcpCapacity({ builtInToolBindings: legacyToolIds.map((toolId) => ({ toolId })) })
      : structuredClone(DEFAULT_MATE_MCP_CAPACITY)
    : input.mcpCapacity;
  if (!isMateMcpCapacity(mcpCapacity)) throw new HttpError(422, "mate_mcp_capacity_invalid");
  const appMcpBindings = allAppMcp ? [] : normalizeAppBindings(input.appMcpBindings);
  const allKnowledgeServices = workspacePassMcpEnabled || input.allKnowledgeServices === true;
  const knowledgeServiceBindings = (allKnowledgeServices ? [] : stringArray(input.knowledgeServiceIds)).map((serviceId) => ({
    serviceId,
    allowedOperations: ["search", "read"] as Array<"search" | "read">,
    authority: { mode: "invoking_user" as const },
    requiresCurrentUserAuthorization: true as const
  }));
  const configuredBuiltInToolIds = input.builtInToolIds === undefined
    ? [...WORKSPACE_DEFAULT_BUILT_IN_TOOL_IDS]
    : stringArray(input.builtInToolIds).filter((id) => id !== "workspace_forum_read" && id !== "workspace_forum_post");
  const folderEditBindings = (allFolderEdit ? [] : stringArray(input.folderEditIds)).map((folderObjectId) => ({
    folderObjectId,
    authority: { mode: "invoking_user" as const },
    requiresCurrentUserAuthorization: true as const
  }));
  if ((allFolderEdit || folderEditBindings.length) && !configuredBuiltInToolIds.includes("workspace_knowledge_maintain")) {
    configuredBuiltInToolIds.push("workspace_knowledge_maintain");
  }
  const builtInToolIds = withWorkspaceIntrinsicBuiltInToolIds(configuredBuiltInToolIds);
  const builtInToolBindings = builtInToolIds.map((toolId) => ({
    toolId: toolId as WorkspaceAgentRuntimeManifest["resources"]["builtInToolBindings"][number]["toolId"],
    requiresCurrentUserContext: true as const
  }));
  const modelPolicy = normalizeModelPolicy(input.allowedModels, input.defaultModel);
  const manifest: WorkspaceAgentRuntimeManifest = {
    schemaVersion: WORKSPACE_AGENT_RUNTIME_SCHEMA_VERSION,
    mate: {
      mateId: input.mateId,
      displayName: input.displayName,
      jobRole: input.jobRole,
      description: input.description,
      ...(input.avatarRef ? { avatarRef: input.avatarRef } : {}),
      ownerUserId: input.ownerUserId,
      addresses: [
        { type: "email", address: input.workEmail },
        { type: "pass_mcp", tool: WORKSPACE_MATE_CALL_TOOL }
      ]
    },
    release: {
      releaseId: `${input.mateId}-draft-1`,
      version: 1,
      status: "draft",
      soul: { id: documents[0].id, version: 1, digest: soulDigest },
      handbooks: [{ id: documents[1].id, version: 1, digest: handbookDigest }],
      skills: []
    },
    resources: {
      mcpCapacity,
      ...(allAppMcp ? { appMcpScope: {
        authority: { mode: "invoking_user" as const }, mode: "all_visible_to_invoking_user" as const, requiresCurrentUserAuthorization: true as const
      } } : {}),
      ...(allFolderEdit ? { folderEditScope: {
        authority: { mode: "invoking_user" as const }, mode: "all_visible_to_invoking_user" as const, requiresCurrentUserAuthorization: true as const
      } } : {}),
      appMcpBindings,
      knowledgeServiceBindings,
      ...(allKnowledgeServices ? {
        knowledgeServiceScope: {
          allowedOperations: ["search", "read"],
          authority: { mode: "invoking_user" },
          mode: "all_visible_to_invoking_user",
          requiresCurrentUserAuthorization: true
        }
      } : {}),
      folderEditBindings,
      builtInToolBindings,
      skillDiscoveryPolicy: { discoverAndRecommend: true, autoInstall: false, installationRequests: false }
    },
    modelPolicy: {
      ...modelPolicy,
      multimodal: { imageInput: true, documentInput: true, audioInput: false }
    },
    channels: {
      standalone: { enabled: input.standaloneEnabled },
      embedded: { enabled: input.embeddedEnabled },
      inbox: {
        email: { inboxPrompt: mailContent, enabled: input.emailEnabled },
        mateCall: { enabled: input.mateCallEnabled, transport: "workspace_pass_mcp", tool: WORKSPACE_MATE_CALL_TOOL },
        schedule: { enabled: input.scheduleEnabled },
        webhook: { enabled: false }
      }
    },
    invocationPolicy: {
      visibility: input.visibility,
      ...(input.visibility === "targets" ? { targetIds: input.targetIds } : {}),
      requireAuthenticatedUser: true,
      allowedCallerKinds: [
        "user",
        ...(input.mateCallEnabled ? ["app" as const, "mate" as const] : []),
        ...(input.emailEnabled ? ["email_binding" as const] : [])
      ]
    },
    eligibilityPolicy: { denyIfRequirementUnknown: true, resourceRequirements: [] },
    preferenceSchema: {
      version: 1,
      fields: [
        { key: "language", type: "enum", sensitive: false, allowedValues: ["zh-CN", "en"] },
        { key: "responseDensity", type: "enum", sensitive: false, allowedValues: ["brief", "normal", "detailed"] }
      ]
    },
    taskPolicy: {
      requireUserOwnership: true,
      conclusionRequired: true,
      defaultTimezone: normalizeTimezone(input.defaultTimezone),
      scheduledJobs: input.scheduleEnabled ? normalizeScheduledJobs(input.scheduledJobs) : [],
      approvals: { writeRiskLevels: ["medium", "high", "critical"], singleUse: true, revalidateDelegation: true },
      mateCallLimits: { maxDepth: 3, maxChildrenPerTask: 8, maxTasksPerRoot: 24, maxRunSeconds: 1800 }
    },
    memoryPolicy: {
      conversationHistory: {
        enabled: input.standaloneEnabled || input.embeddedEnabled,
        preserveOriginals: true,
        compaction: {
          enabled: input.standaloneEnabled || input.embeddedEnabled,
          strategy: "non_destructive_overlay",
          triggerEstimatedTokens: 64_000,
          protectHeadMessages: 3,
          tailTokenBudget: 16_000,
          minTailMessages: 4,
          maxSummaryTokens: 4_000
        }
      },
      userMemory: {
        storage: "structured_runtime_api",
        automaticConversationExtraction: false,
        freeformFiles: false
      }
    },
    experiencePolicy: {
      automaticHandbookMutation: false,
      requiresSanitization: true,
      requiresReview: true,
      conversation: {
        enabled: input.standaloneEnabled || input.embeddedEnabled,
        channels: [
          ...(input.standaloneEnabled ? ["web" as const] : []),
          ...(input.embeddedEnabled ? ["sdk" as const] : [])
        ]
      },
      taskInbox: {
        enabled: input.mateCallEnabled || input.emailEnabled || input.scheduleEnabled,
        channels: [
          ...(input.mateCallEnabled ? ["mate_call" as const] : []),
          ...(input.emailEnabled ? ["email" as const] : []),
          ...(input.scheduleEnabled ? ["schedule" as const] : [])
        ]
      },
      ownerTesting: { enabled: true, candidateReleaseOnly: true, isolatedFromLiveData: true }
    }
  };
  await ensureMateMailDocument(manifest, documents);
  return { documents, manifest };
}

async function requireOwnedMate(db: D1Database, principal: Principal, mateId: string) {
  const row = await db.prepare("SELECT * FROM apps_mates WHERE id = ? AND org_id = ? LIMIT 1")
    .bind(mateId, principal.orgId).first<MateRow>();
  if (!row || !principalOwnsUserId(row.owner_user_id, principal)) throw new HttpError(404, "mate_not_found");
  return row;
}

async function requireRelease(db: D1Database, mateId: string, releaseId: string) {
  const row = await db.prepare("SELECT * FROM apps_mate_releases WHERE id = ? AND mate_id = ? LIMIT 1")
    .bind(releaseId, mateId).first<MateReleaseRow>();
  if (!row) throw new HttpError(404, "mate_release_not_found");
  return row;
}

function mateFromRow(row: MateRow, includeDraft: boolean): Mate {
  const draftManifest = asWorkspaceAgentRuntimeManifest(parseObject(row.draft_manifest_json));
  return {
    id: row.id,
    orgId: row.org_id,
    ownerUserId: row.owner_user_id,
    displayName: row.display_name,
    isDefault: row.is_default === 1,
    jobRole: row.job_role,
    description: row.description,
    workEmail: row.work_email || undefined,
    status: row.status === "deployed" || row.status === "published" || row.status === "archived" ? row.status : "draft",
    visibility: normalizeVisibility(row.visibility),
    draftRevision: Number(row.draft_revision) || 1,
    activeReleaseId: row.active_release_id || undefined,
    avatarUrl: draftManifest.mate.avatarRef || undefined,
    previewReleaseId: row.preview_release_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(includeDraft ? {
      draftManifest,
      draftDocuments: asMateDocuments(parseArray(row.draft_documents_json))
    } : {})
  };
}

function normalizeMateAvatarRef(value: unknown, env: Env) {
  const avatarRef = readString(value).trim();
  if (!avatarRef) return "";
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/]+=*$/i.test(avatarRef)) {
    if (avatarRef.length > 1_200_000) throw new HttpError(400, "mate_avatar_too_large");
    return avatarRef;
  }
  try {
    const url = new URL(avatarRef, env.PORTAL_URL || env.AUTH_PUBLIC_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported_protocol");
    if (avatarRef.length > 1_200) throw new HttpError(400, "mate_avatar_too_large");
    return url.toString();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "mate_avatar_invalid");
  }
}

async function releaseFromRow(env: Env, row: MateReleaseRow): Promise<MateRelease> {
  const definition = await loadReleaseDefinition(env, row.id, row);
  return {
    id: row.id,
    mateId: row.mate_id,
    version: Number(row.version),
    status: row.status === "candidate" || row.status === "revoked" || row.status === "retired" ? row.status : "published",
    manifestSha256: row.manifest_sha256,
    manifest: definition.manifest,
    documents: definition.documents,
    createdBy: row.created_by,
    createdAt: row.created_at,
    activatedAt: row.activated_at || undefined
  };
}

function normalizeVisibility(value: unknown): MateVisibility {
  const text = readString(value).trim();
  return text === "organization" || text === "targets" ? text : "private";
}

function normalizeInvocationTargets(value: unknown, visibility: MateVisibility) {
  if (visibility !== "targets") return [];
  const targets = Array.from(new Set(stringArray(value).map((target) => target.trim())));
  if (targets.length === 0) throw new HttpError(400, "mate_invocation_targets_required");
  if (targets.some((target) => !/^(?:user|department):[^\s:][^\s]*$/i.test(target))) {
    throw new HttpError(400, "mate_invocation_target_invalid");
  }
  return targets;
}

function normalizeEmail(value: unknown, env: Env) {
  const email = readString(value).trim().toLowerCase();
  const separator = email.lastIndexOf("@");
  const code = separator > 0 ? email.slice(0, separator) : "";
  const domain = separator > 0 ? email.slice(separator + 1) : "";
  if (
    domain !== installationHostname(env.WORKSPACE_MATE_EMAIL_DOMAIN)
    || !/^[a-z0-9](?:[a-z0-9._+-]{0,61}[a-z0-9])?$/.test(code)
  ) {
    throw new HttpError(400, "mate_work_email_invalid");
  }
  return `${code}@${installationHostname(env.WORKSPACE_MATE_EMAIL_DOMAIN)}`;
}

function normalizeTimezone(value: unknown) {
  const timezone = readString(value).trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
    return timezone;
  } catch {
    throw new HttpError(400, "mate_default_timezone_invalid");
  }
}

function normalizeScheduledJobs(value: unknown): MateScheduledJob[] {
  if (!Array.isArray(value)) return [];
  const jobs = value.slice(0, 32).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, "mate_scheduled_job_invalid", { index });
    }
    const source = item as Record<string, unknown>;
    const cadenceSource = source.cadence && typeof source.cadence === "object" && !Array.isArray(source.cadence)
      ? source.cadence as Record<string, unknown> : {};
    const deliverySource = source.delivery && typeof source.delivery === "object" && !Array.isArray(source.delivery)
      ? source.delivery as Record<string, unknown> : undefined;
    const id = readString(source.id).trim();
    const at = readString(cadenceSource.at).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{7,127}$/.test(id)) throw new HttpError(400, "mate_scheduled_job_id_invalid", { index });
    if (cadenceSource.kind !== "daily" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at)) {
      throw new HttpError(400, "mate_scheduled_job_cadence_invalid", { index });
    }
    const job: MateScheduledJob = {
      id,
      title: requireInputText(source.title, "mate_scheduled_job_title_required", 240),
      instruction: requireInputText(source.instruction, "mate_scheduled_job_instruction_required", 12_000),
      cadence: { at, kind: "daily", timezone: normalizeTimezone(cadenceSource.timezone) }
    };
    if (deliverySource) {
      if (deliverySource.channel !== "email" || deliverySource.recipient !== "owner") {
        throw new HttpError(400, "mate_scheduled_job_delivery_invalid", { index });
      }
      job.delivery = { channel: "email", recipient: "owner" };
    }
    return job;
  });
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) throw new HttpError(400, "mate_scheduled_job_id_conflict");
  return jobs;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, code: string) {
  const output = Number(value);
  if (!Number.isInteger(output) || output < minimum || output > maximum) throw new HttpError(400, code);
  return output;
}

function requireInputText(value: unknown, code: string, maxLength: number) {
  const text = readString(value).trim();
  if (!text) throw new HttpError(400, code);
  return text.slice(0, maxLength);
}

function normalizeAppBindings(value: unknown): WorkspaceAgentRuntimeManifest["resources"]["appMcpBindings"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const appId = readString(source.appId).trim();
    if (!appId) return [];
    return [{
      appId,
      authority: { mode: "invoking_user" as const },
      manifestVersion: readString(source.manifestVersion).trim() || "workspace.app-mcp/v1",
      allowedToolNames: stringArray(source.allowedToolNames),
      requiresCurrentUserDelegation: true as const
    }];
  });
}

function normalizeModelPolicy(allowedValue: unknown, defaultValue: unknown) {
  const fallback = "cf-openai-gpt-6-luna";
  const requested = stringArray(allowedValue).filter((modelId) => (
    modelId.length <= 180 && !/[\u0000-\u001f\u007f]/.test(modelId)
  )).slice(0, 32);
  const requestedDefault = readString(defaultValue).trim();
  const selectedModels = requested.length ? requested : [fallback];
  const defaultModel = requestedDefault && selectedModels.includes(requestedDefault)
    ? requestedDefault
    : selectedModels[0];
  const allowedModels = [defaultModel, ...selectedModels.filter((modelId) => modelId !== defaultModel)];
  return { allowUserSelection: allowedModels.length > 1, allowedModels, defaultModel };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => readString(item).trim()).filter(Boolean)))
    : [];
}

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safePreviewOrigin(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return "";
    return url.origin;
  } catch {
    return "";
  }
}

async function provisionMateMail(env:Env,principal:Principal,mateId:string) {
  // Local fixtures without the deployed binding retain their existing behavior.
  if(!env.WORKSPACE_MAIL) { if(env.DEV_AUTH_BYPASS === "1") return; throw new HttpError(503,"workspace_mail_service_not_configured"); }
  const row=await requireOwnedMate(env.APPS_DB,principal,mateId);
  if(!row.work_email)return;
  const authority={userId:row.owner_user_id,orgId:row.org_id,mateId,scopes:["mail:provision"]};
  const client=new WorkspaceMailProvisioner((path,body)=>workspaceMailJson(env,authority,path,body));
  try{await client.assign({userId:row.owner_user_id,orgId:row.org_id,mateId,address:row.work_email,name:row.display_name,isDefault:row.is_default===1});}
  catch{throw new HttpError(503,"mate_mailbox_provisioning_failed",{mailboxStatus:"provisioning"});}
}

function requestedMailContent(input: { mail?: unknown; inboxPrompt?: unknown }): string | undefined {
  if (input.mail !== undefined && input.inboxPrompt !== undefined && input.mail !== input.inboxPrompt) throw new HttpError(400, "mate_mail_alias_conflict");
  const content = input.mail ?? input.inboxPrompt;
  if (content !== undefined && (typeof content !== "string" || content.length > 24_000)) throw new HttpError(400, "mate_mail_document_invalid");
  return content as string | undefined;
}
