import {
  WORKSPACE_AGENT_RUNTIME_SCHEMA_VERSION,
  WORKSPACE_MATE_CALL_TOOL,
  isMateAllResourceScope,
  type WorkspaceAgentRuntimeManifest,
  type MateDocument,
  type MateValidationIssue,
  type MateValidationResult
} from "../../../../src/shared/mate.ts";
import { validFolderEditBindings } from "../../../../src/shared/mateFolderEditing.ts";
import { isMateMcpCapacity, mateCapacityIncludes, mateForumMcpSelection } from "../../../../src/shared/mateMcpCapacity.ts";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MATE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Historical releases may still contain Forum bindings; new drafts normalize them to MCP capacity.
const BUILT_IN_TOOLS = new Set([
  "public_web_read",
  "public_web_search",
  "ocr",
  "document_read",
  "artifact_create",
  "workspace_knowledge_maintain",
  "workspace_forum_read",
  "workspace_forum_post",
  "todo_manage",
  "reminder_manage"
]);

export async function validateMateDefinition(input: {
  documents: unknown;
  manifest: unknown;
  ownerUserId: string;
  mateId: string;
  workEmail?: string;
}): Promise<MateValidationResult> {
  const errors: MateValidationIssue[] = [];
  const warnings: MateValidationIssue[] = [];
  const manifest = record(input.manifest);
  const mate = record(manifest.mate);
  const release = record(manifest.release);
  const resources = record(manifest.resources);
  const channels = record(manifest.channels);
  const inbox = record(channels.inbox);
  const inboxPrompt = record(inbox.email).inboxPrompt;
  if(inboxPrompt !== undefined && (typeof inboxPrompt !== "string" || inboxPrompt.length>24000)) issue(errors,"/channels/inbox/email/inboxPrompt","invalid_inbox_prompt","Inbox Prompt must be text up to 24000 characters.");
  const email = record(inbox.email);
  if (email.taskAuthority !== undefined && !["owner", "verified_sender"].includes(string(email.taskAuthority))) issue(errors, "/channels/inbox/email/taskAuthority", "invalid_mail_task_authority", "Mail task authority must be owner or verified_sender.");
  if (release.mail !== undefined && inboxPrompt !== undefined) issue(errors, "/channels/inbox/email/inboxPrompt", "duplicate_mail_policy", "Use mail.md as the only policy source.");
  const mateCall = record(inbox.mateCall);
  const schedule = record(inbox.schedule);
  const webhook = record(inbox.webhook);
  const invocation = record(manifest.invocationPolicy);
  const taskPolicy = record(manifest.taskPolicy);
  const modelPolicy = record(manifest.modelPolicy);
  const approvals = record(taskPolicy.approvals);
  const scheduledJobs = array(taskPolicy.scheduledJobs);
  const memory = record(manifest.memoryPolicy);
  const conversationMemory = record(memory.conversationHistory);
  const compaction = record(conversationMemory.compaction);
  const userMemory = record(memory.userMemory);
  const experience = record(manifest.experiencePolicy);
  const skillDiscovery = record(resources.skillDiscoveryPolicy);

  requiredEqual(errors, "/schemaVersion", manifest.schemaVersion, WORKSPACE_AGENT_RUNTIME_SCHEMA_VERSION);
  requiredText(errors, "/mate/displayName", mate.displayName, 120);
  requiredText(errors, "/mate/jobRole", mate.jobRole, 200);
  requiredEqual(errors, "/mate/mateId", mate.mateId, input.mateId);
  requiredEqual(errors, "/mate/ownerUserId", mate.ownerUserId, input.ownerUserId);
  validateAvatarRef(errors, mate.avatarRef);
  if (!MATE_ID_PATTERN.test(string(mate.mateId))) {
    issue(errors, "/mate/mateId", "invalid_mate_id", "mateId must be a lowercase URL-safe slug.");
  }

  const addresses = array(mate.addresses);
  if (input.workEmail) {
    const emailAddress = addresses.find((address) => record(address).type === "email");
    requiredEqual(errors, "/mate/addresses/email", record(emailAddress).address, input.workEmail);
  }
  if (!addresses.some((address) => record(address).type === "pass_mcp" && record(address).tool === WORKSPACE_MATE_CALL_TOOL)) {
    issue(errors, "/mate/addresses", "mate_call_address_required", "PassMCP address must use mate_call.");
  }

  requiredText(errors, "/release/releaseId", release.releaseId, 128);
  requiredInteger(errors, "/release/version", release.version, 1);
  if (!["draft", "candidate", "published"].includes(string(release.status))) {
    issue(errors, "/release/status", "invalid_release_status", "A publishable draft must use draft, candidate, or published status.");
  }
  validateRevisionRef(errors, "/release/soul", release.soul);
  if (release.mail !== undefined) validateRevisionRef(errors, "/release/mail", release.mail);
  const handbooks = array(release.handbooks);
  if (handbooks.length < 1 || handbooks.length > 32) {
    issue(errors, "/release/handbooks", "invalid_handbook_count", "At least one and no more than 32 Handbooks are required.");
  }
  handbooks.forEach((value, index) => validateRevisionRef(errors, `/release/handbooks/${index}`, value));

  const appBindings = array(resources.appMcpBindings);
  if (resources.appMcpScope !== undefined && (!isMateAllResourceScope(resources.appMcpScope) || appBindings.length)) {
    issue(errors, "/resources/appMcpScope", "invalid_app_mcp_scope", "All App MCP scope cannot be combined with fixed App bindings.");
  }
  if (resources.folderEditScope !== undefined && (!isMateAllResourceScope(resources.folderEditScope) || array(resources.folderEditBindings).length)) {
    issue(errors, "/resources/folderEditScope", "invalid_folder_edit_scope", "All writable folders scope cannot be combined with fixed folder bindings.");
  }
  if (resources.mcpCapacity !== undefined && !isMateMcpCapacity(resources.mcpCapacity)) {
    issue(errors, "/resources/mcpCapacity", "invalid_mcp_capacity", "MCP capacity groups must have valid all, none, or selected child settings.");
  }
  appBindings.forEach((value, index) => {
    const binding = record(value);
    requiredText(errors, `/resources/appMcpBindings/${index}/appId`, binding.appId, 128);
    requiredText(errors, `/resources/appMcpBindings/${index}/manifestVersion`, binding.manifestVersion, 64);
    requiredEqual(errors, `/resources/appMcpBindings/${index}/requiresCurrentUserDelegation`, binding.requiresCurrentUserDelegation, true);
    validateInvokingUserAuthority(errors, `/resources/appMcpBindings/${index}/authority`, binding.authority);
  });

  const workspacePassMcpScope = record(resources.workspacePassMcpScope);
  if (resources.workspacePassMcpScope !== undefined) {
    requiredEqual(
      errors,
      "/resources/workspacePassMcpScope/mode",
      workspacePassMcpScope.mode,
      "all_authorized_for_invoking_user"
    );
    requiredEqual(
      errors,
      "/resources/workspacePassMcpScope/requiresCurrentUserAuthorization",
      workspacePassMcpScope.requiresCurrentUserAuthorization,
      true
    );
    requiredEqual(
      errors,
      "/resources/workspacePassMcpScope/authority/mode",
      record(workspacePassMcpScope.authority).mode,
      "invoking_user"
    );
    validateInvokingUserAuthority(errors, "/resources/workspacePassMcpScope/authority", workspacePassMcpScope.authority);
    const domains = array(workspacePassMcpScope.domains).map(string);
    if (domains.length !== 2 || domains[0] !== "apps" || domains[1] !== "knowledge") {
      issue(
        errors,
        "/resources/workspacePassMcpScope/domains",
        "invalid_workspace_pass_domains",
        "Dynamic Workspace MCP scope must contain exactly the APPS and Knowledge domains."
      );
    }
    if (
      appBindings.length > 0
      || array(resources.knowledgeServiceBindings).length > 0
      || array(resources.folderEditBindings).length > 0
      || resources.appMcpScope !== undefined
      || resources.folderEditScope !== undefined
    ) {
      issue(
        errors,
        "/resources/workspacePassMcpScope",
        "ambiguous_workspace_pass_scope",
        "Dynamic Workspace MCP scope cannot be combined with fixed App MCP, Knowledge Service, or folder bindings."
      );
    }
  }

  const knowledgeBindings = array(resources.knowledgeServiceBindings);
  if (resources.folderEditBindings !== undefined && !validFolderEditBindings(resources.folderEditBindings)) {
    issue(errors, "/resources/folderEditBindings", "invalid_folder_edit_bindings", "Select up to 64 distinct folders using current-user authorization only.");
  }
  if ((array(resources.folderEditBindings).length > 0 || resources.folderEditScope !== undefined) && !array(resources.builtInToolBindings).some((value) => record(value).toolId === "workspace_knowledge_maintain")) {
    issue(errors, "/resources/folderEditBindings", "folder_edit_tool_required", "Folder editing requires the content maintenance tool.");
  }
  knowledgeBindings.forEach((value, index) => {
    const binding = record(value);
    requiredText(errors, `/resources/knowledgeServiceBindings/${index}/serviceId`, binding.serviceId, 180);
    requiredEqual(errors, `/resources/knowledgeServiceBindings/${index}/requiresCurrentUserAuthorization`, binding.requiresCurrentUserAuthorization, true);
    validateInvokingUserAuthority(errors, `/resources/knowledgeServiceBindings/${index}/authority`, binding.authority);
    const operations = array(binding.allowedOperations).map(string);
    if (operations.length < 1 || operations.some((operation) => operation !== "search" && operation !== "read")) {
      issue(errors, `/resources/knowledgeServiceBindings/${index}/allowedOperations`, "invalid_knowledge_operations", "Knowledge access is read-only in Runtime V1.");
    }
  });
  const knowledgeScope = record(resources.knowledgeServiceScope);
  if (resources.knowledgeServiceScope !== undefined) {
    requiredEqual(
      errors,
      "/resources/knowledgeServiceScope/mode",
      knowledgeScope.mode,
      "all_visible_to_invoking_user"
    );
    requiredEqual(
      errors,
      "/resources/knowledgeServiceScope/requiresCurrentUserAuthorization",
      knowledgeScope.requiresCurrentUserAuthorization,
      true
    );
    validateInvokingUserAuthority(errors, "/resources/knowledgeServiceScope/authority", knowledgeScope.authority);
    const operations = array(knowledgeScope.allowedOperations).map(string);
    if (operations.length !== 2 || !operations.includes("search") || !operations.includes("read")) {
      issue(
        errors,
        "/resources/knowledgeServiceScope/allowedOperations",
        "invalid_knowledge_operations",
        "Platform-wide Knowledge Q&A requires both read and search operations."
      );
    }
    if (knowledgeBindings.length > 0) {
      issue(
        errors,
        "/resources/knowledgeServiceScope",
        "ambiguous_knowledge_scope",
        "All-visible Knowledge scope cannot be combined with fixed Knowledge Service bindings."
      );
    }
  }

  array(resources.builtInToolBindings).forEach((value, index) => {
    const binding = record(value);
    if (!BUILT_IN_TOOLS.has(string(binding.toolId))) {
      issue(errors, `/resources/builtInToolBindings/${index}/toolId`, "unsupported_builtin_tool", "The built-in tool is not available in Runtime V1.");
    }
    requiredEqual(errors, `/resources/builtInToolBindings/${index}/requiresCurrentUserContext`, binding.requiresCurrentUserContext, true);
  });
  requiredEqual(errors, "/resources/skillDiscoveryPolicy/autoInstall", skillDiscovery.autoInstall, false);
  requiredEqual(errors, "/resources/skillDiscoveryPolicy/installationRequests", skillDiscovery.installationRequests, false);

  const allowedModels = array(modelPolicy.allowedModels).map(string);
  requiredText(errors, "/modelPolicy/defaultModel", modelPolicy.defaultModel, 180);
  if (allowedModels.length < 1 || allowedModels.length > 32 || new Set(allowedModels).size !== allowedModels.length) {
    issue(errors, "/modelPolicy/allowedModels", "invalid_model_whitelist", "Model whitelist must contain 1-32 unique model IDs.");
  }
  allowedModels.forEach((model, index) => requiredText(errors, `/modelPolicy/allowedModels/${index}`, model, 180));
  if (!allowedModels.includes(string(modelPolicy.defaultModel))) {
    issue(errors, "/modelPolicy/defaultModel", "default_model_not_allowed", "Default model must be included in the Release whitelist.");
  }
  if (typeof modelPolicy.allowUserSelection !== "boolean") {
    issue(errors, "/modelPolicy/allowUserSelection", "required_boolean", "Model selection requires an explicit boolean policy.");
  }

  requiredEqual(errors, "/channels/inbox/mateCall/transport", mateCall.transport, "workspace_pass_mcp");
  requiredEqual(errors, "/channels/inbox/mateCall/tool", mateCall.tool, WORKSPACE_MATE_CALL_TOOL);
  if (typeof schedule.enabled !== "boolean") issue(errors, "/channels/inbox/schedule/enabled", "required_boolean", "Schedule requires an explicit enabled flag.");
  requiredEqual(errors, "/channels/inbox/webhook/enabled", webhook.enabled, false);
  requiredEqual(errors, "/invocationPolicy/requireAuthenticatedUser", invocation.requireAuthenticatedUser, true);
  if (!["private", "targets", "organization"].includes(string(invocation.visibility))) {
    issue(errors, "/invocationPolicy/visibility", "invalid_invocation_visibility", "Invocation visibility is invalid.");
  }
  if (invocation.visibility === "targets" && array(invocation.targetIds).length === 0) {
    issue(errors, "/invocationPolicy/targetIds", "invocation_targets_required", "Target visibility requires at least one target.");
  }
  array(invocation.targetIds).forEach((target, index) => {
    if (!/^(?:user|department):[^\s:][^\s]*$/i.test(string(target))) {
      issue(errors, `/invocationPolicy/targetIds/${index}`, "invalid_invocation_target", "Invocation targets must use user:<id> or department:<id-or-path>.");
    }
  });

  requiredEqual(errors, "/taskPolicy/requireUserOwnership", taskPolicy.requireUserOwnership, true);
  requiredEqual(errors, "/taskPolicy/conclusionRequired", taskPolicy.conclusionRequired, true);
  validateTimezone(errors, "/taskPolicy/defaultTimezone", taskPolicy.defaultTimezone);
  validateScheduledJobs(errors, scheduledJobs, {
    emailEnabled: record(inbox.email).enabled === true,
    forumReadEnabled: mateCapacityIncludes(mateForumMcpSelection({
      builtInToolBindings: array(resources.builtInToolBindings).map((binding) => ({ toolId: string(record(binding).toolId) })),
      ...(isMateMcpCapacity(resources.mcpCapacity) ? { mcpCapacity: resources.mcpCapacity } : {})
    }), "forum_read"),
    scheduleEnabled: schedule.enabled === true
  });
  requiredEqual(errors, "/taskPolicy/approvals/singleUse", approvals.singleUse, true);
  requiredEqual(errors, "/taskPolicy/approvals/revalidateDelegation", approvals.revalidateDelegation, true);
  requiredEqual(errors, "/experiencePolicy/automaticHandbookMutation", experience.automaticHandbookMutation, false);
  requiredEqual(errors, "/experiencePolicy/requiresSanitization", experience.requiresSanitization, true);
  requiredEqual(errors, "/experiencePolicy/requiresReview", experience.requiresReview, true);
  const conversationExperience = record(experience.conversation);
  const taskInboxExperience = record(experience.taskInbox);
  const ownerTesting = record(experience.ownerTesting);
  requiredEqual(errors, "/experiencePolicy/ownerTesting/candidateReleaseOnly", ownerTesting.candidateReleaseOnly, true);
  requiredEqual(errors, "/experiencePolicy/ownerTesting/isolatedFromLiveData", ownerTesting.isolatedFromLiveData, true);
  validateExperienceChannels(errors, conversationExperience, "/experiencePolicy/conversation", ["web", "sdk"]);
  validateExperienceChannels(errors, taskInboxExperience, "/experiencePolicy/taskInbox", ["mate_call", "email", "schedule"]);
  requiredEqual(errors, "/channels/standalone/enabled", record(channels.standalone).enabled, true);
  requiredEqual(errors, "/channels/embedded/enabled", record(channels.embedded).enabled, true);
  requiredEqual(errors, "/experiencePolicy/conversation/enabled", conversationExperience.enabled, true);
  const conversationChannels = array(conversationExperience.channels).map(string);
  if (conversationChannels.length !== 2 || !conversationChannels.includes("web") || !conversationChannels.includes("sdk")) {
    issue(errors, "/experiencePolicy/conversation/channels", "conversation_surfaces_required", "Conversation collaboration requires both web and sdk surfaces.");
  }
  const taskChannels = array(taskInboxExperience.channels).map(string);
  if (taskInboxExperience.enabled === true && !taskChannels.includes("mate_call") && !taskChannels.includes("email")) {
    issue(errors, "/experiencePolicy/taskInbox/channels", "task_entry_required", "Task mode requires mate_call or email.");
  }
  const expectedTaskChannels = [
    ...(mateCall.enabled === true ? ["mate_call"] : []),
    ...(email.enabled === true ? ["email"] : []),
    ...(schedule.enabled === true ? ["schedule"] : [])
  ];
  if (taskInboxExperience.enabled !== (expectedTaskChannels.length > 0)
    || taskChannels.length !== expectedTaskChannels.length
    || expectedTaskChannels.some((channel) => !taskChannels.includes(channel))) {
    issue(errors, "/experiencePolicy/taskInbox", "task_channel_mismatch", "Task experience channels must match the enabled Task ingress channels.");
  }
  const allowedCallerKinds = array(invocation.allowedCallerKinds).map(string);
  const expectedCallerKinds = [
    "user",
    ...(mateCall.enabled === true ? ["app", "mate"] : []),
    ...(email.enabled === true ? ["email_binding"] : [])
  ];
  if (allowedCallerKinds.length !== expectedCallerKinds.length
    || expectedCallerKinds.some((kind) => !allowedCallerKinds.includes(kind))) {
    issue(errors, "/invocationPolicy/allowedCallerKinds", "caller_kind_channel_mismatch", "Caller kinds must match Conversation and enabled Task ingress modes.");
  }

  if (isRecord(manifest.memoryPolicy)) {
    requiredEqual(errors, "/memoryPolicy/conversationHistory/preserveOriginals", conversationMemory.preserveOriginals, true);
    requiredEqual(errors, "/memoryPolicy/conversationHistory/compaction/strategy", compaction.strategy, "non_destructive_overlay");
    requiredEqual(errors, "/memoryPolicy/userMemory/storage", userMemory.storage, "structured_runtime_api");
    requiredEqual(errors, "/memoryPolicy/userMemory/automaticConversationExtraction", userMemory.automaticConversationExtraction, false);
    requiredEqual(errors, "/memoryPolicy/userMemory/freeformFiles", userMemory.freeformFiles, false);
    if (typeof conversationMemory.enabled !== "boolean") {
      issue(errors, "/memoryPolicy/conversationHistory/enabled", "required_boolean", "Conversation memory requires an explicit enabled flag.");
    }
    if (typeof compaction.enabled !== "boolean") {
      issue(errors, "/memoryPolicy/conversationHistory/compaction/enabled", "required_boolean", "Memory compaction requires an explicit enabled flag.");
    }
    if (compaction.enabled === true && conversationMemory.enabled !== true) {
      issue(errors, "/memoryPolicy/conversationHistory/compaction/enabled", "memory_compaction_without_history", "Compaction cannot run when conversation history is disabled.");
    }
    if (conversationMemory.enabled !== conversationExperience.enabled) {
      issue(errors, "/memoryPolicy/conversationHistory/enabled", "memory_conversation_experience_mismatch", "Conversation memory must match the published Conversation experience.");
    }
    requiredInteger(errors, "/memoryPolicy/conversationHistory/compaction/triggerEstimatedTokens", compaction.triggerEstimatedTokens, 8_000);
    requiredInteger(errors, "/memoryPolicy/conversationHistory/compaction/protectHeadMessages", compaction.protectHeadMessages, 1);
    requiredInteger(errors, "/memoryPolicy/conversationHistory/compaction/tailTokenBudget", compaction.tailTokenBudget, 1_000);
    requiredInteger(errors, "/memoryPolicy/conversationHistory/compaction/minTailMessages", compaction.minTailMessages, 1);
    requiredInteger(errors, "/memoryPolicy/conversationHistory/compaction/maxSummaryTokens", compaction.maxSummaryTokens, 256);
    if (Number(compaction.tailTokenBudget || 0) + Number(compaction.maxSummaryTokens || 0) >= Number(compaction.triggerEstimatedTokens || 0)) {
      issue(errors, "/memoryPolicy/conversationHistory/compaction", "memory_compaction_budget_invalid", "Tail and summary budgets must leave room below the compaction trigger.");
    }
  } else {
    issue(warnings, "/memoryPolicy", "legacy_memory_policy_defaulted", "Legacy Releases use structured user state and no automatic conversation compaction until republished with memoryPolicy.");
  }

  for (const topLevel of ["modelPolicy", "eligibilityPolicy", "preferenceSchema", "taskPolicy", "experiencePolicy"]) {
    if (!isRecord(manifest[topLevel])) {
      issue(errors, `/${topLevel}`, "required_object", `${topLevel} must be an object.`);
    }
  }

  findForbiddenDefinitionKeys(manifest, "", errors);
  await validateDocuments(errors, input.documents, release, handbooks);

  if (knowledgeBindings.length > 0 || resources.knowledgeServiceScope !== undefined || resources.workspacePassMcpScope !== undefined) {
    issue(warnings, "/resources", "knowledge_access_checked_at_runtime", "Each knowledge request will be re-authorized as the calling user.");
  }

  return { errors, valid: errors.length === 0, warnings };
}

function validateAvatarRef(errors: MateValidationIssue[], value: unknown) {
  if (value === undefined) return;
  const avatarRef = string(value).trim();
  if (!avatarRef || avatarRef.length > 1_200_000) {
    issue(errors, "/mate/avatarRef", "invalid_mate_avatar", "Avatar must be a supported image reference no larger than 1,200,000 characters.");
    return;
  }
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/]+=*$/i.test(avatarRef)) return;
  try {
    const url = new URL(avatarRef);
    if ((url.protocol === "https:" || url.protocol === "http:") && avatarRef.length <= 1_200) return;
  } catch {
    // Report the stable validation issue below.
  }
  issue(errors, "/mate/avatarRef", "invalid_mate_avatar", "Avatar must use HTTPS, HTTP, or a supported image data URL.");
}

function validateInvokingUserAuthority(errors: MateValidationIssue[], path: string, value: unknown) {
  // Legacy candidate Releases used the requiresCurrentUser* booleans only.
  if (value === undefined) return;
  const authority = record(value);
  if (authority.mode !== "invoking_user" || Object.keys(authority).some((key) => key !== "mode")) {
    issue(errors, path, "unsupported_resource_authority", "Runtime V1 supports invoking-user resource authority only.");
  }
}

function validateScheduledJobs(
  errors: MateValidationIssue[],
  jobs: unknown[],
  capabilities: { emailEnabled: boolean; forumReadEnabled: boolean; scheduleEnabled: boolean }
) {
  if (jobs.length > 32) issue(errors, "/taskPolicy/scheduledJobs", "scheduled_job_limit_exceeded", "At most 32 scheduled jobs are allowed.");
  if (capabilities.scheduleEnabled && jobs.length === 0) {
    issue(errors, "/taskPolicy/scheduledJobs", "scheduled_job_required", "An enabled Schedule channel requires at least one configured job.");
  }
  if (!capabilities.scheduleEnabled && jobs.length > 0) {
    issue(errors, "/taskPolicy/scheduledJobs", "schedule_channel_required", "Scheduled jobs require the Schedule channel.");
  }
  const ids = new Set<string>();
  jobs.forEach((value, index) => {
    const job = record(value);
    const path = `/taskPolicy/scheduledJobs/${index}`;
    const id = string(job.id);
    if (!/^[A-Za-z][A-Za-z0-9_-]{7,127}$/.test(id)) issue(errors, `${path}/id`, "invalid_scheduled_job_id", "Scheduled job ids must be stable URL-safe identifiers.");
    if (ids.has(id)) issue(errors, `${path}/id`, "duplicate_scheduled_job_id", "Scheduled job ids must be unique in one Release.");
    ids.add(id);
    requiredText(errors, `${path}/title`, job.title, 240);
    requiredText(errors, `${path}/instruction`, job.instruction, 12_000);
    const cadence = record(job.cadence);
    requiredEqual(errors, `${path}/cadence/kind`, cadence.kind, "daily");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(string(cadence.at))) {
      issue(errors, `${path}/cadence/at`, "invalid_daily_schedule_time", "Daily schedule time must use HH:MM.");
    }
    validateTimezone(errors, `${path}/cadence/timezone`, cadence.timezone);
    const delivery = record(job.delivery);
    if (Object.keys(delivery).length > 0) {
      requiredEqual(errors, `${path}/delivery/channel`, delivery.channel, "email");
      requiredEqual(errors, `${path}/delivery/recipient`, delivery.recipient, "owner");
      if (!capabilities.emailEnabled) issue(errors, `${path}/delivery`, "scheduled_email_channel_required", "Email delivery requires the Email channel.");
    }
  });
}

function validateTimezone(errors: MateValidationIssue[], path: string, value: unknown) {
  const timezone = string(value);
  if (!timezone || timezone.length > 80) {
    issue(errors, path, "invalid_timezone", "An IANA timezone is required.");
    return;
  }
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0)); }
  catch { issue(errors, path, "invalid_timezone", "An IANA timezone is required."); }
}

export function asWorkspaceAgentRuntimeManifest(value: unknown) {
  return value as WorkspaceAgentRuntimeManifest;
}

export function asMateDocuments(value: unknown) {
  return array(value) as MateDocument[];
}

async function validateDocuments(
  errors: MateValidationIssue[],
  input: unknown,
  release: Record<string, unknown>,
  handbookRefs: unknown[]
) {
  const documents = array(input).map(record);
  const refs = [{ kind: "soul", ref: record(release.soul) }, ...handbookRefs.map(ref => ({kind: "handbook", ref: record(ref)})), ...(release.mail === undefined ? [] : [{kind: "mail", ref: record(release.mail)}])];
  for (const [index, {kind, ref}] of refs.entries()) {
    const document = documents.find((candidate) => candidate.kind === kind && candidate.id === ref.id && candidate.version === ref.version);
    if (!document) {
      issue(errors, `/documents/${index}`, "release_document_missing", `${kind} content is required for every release reference.`);
      continue;
    }
    const content = string(document.content);
    if (kind !== "mail" && !content.trim()) {
      issue(errors, `/documents/${index}/content`, "release_document_empty", `${kind} content cannot be empty.`);
      continue;
    }
    if (kind === "mail" && (typeof document.content !== "string" || content.length > 24_000)) issue(errors, `/documents/${index}/content`, "invalid_mail_document", "mail.md must be text up to 24000 characters; empty means store only.");
    const digest = await sha256Digest(content);
    if (digest !== ref.digest || document.digest !== ref.digest) {
      issue(errors, `/documents/${index}/digest`, "release_document_digest_mismatch", `${kind} content does not match its immutable digest.`);
    }
  }
  for (const [index, document] of documents.entries()) {
    if (documents.filter(other => other.kind === document.kind && other.id === document.id && other.version === document.version).length !== 1 || !refs.some(({kind, ref}) => kind === document.kind && ref.id === document.id && ref.version === document.version)) issue(errors, `/documents/${index}`, "unbound_or_duplicate_document", "Every document must have exactly one release reference.");
  }
  if (documents.filter(document => document.kind === "mail").length > 1) issue(errors, "/documents", "duplicate_mail_document", "A release has exactly one mail.md.");
}

function validateRevisionRef(errors: MateValidationIssue[], path: string, value: unknown) {
  const ref = record(value);
  requiredText(errors, `${path}/id`, ref.id, 128);
  requiredInteger(errors, `${path}/version`, ref.version, 1);
  if (!DIGEST_PATTERN.test(string(ref.digest))) {
    issue(errors, `${path}/digest`, "invalid_sha256_digest", "Revision digest must use sha256:<64 lowercase hex characters>.");
  }
}

function findForbiddenDefinitionKeys(value: unknown, path: string, errors: MateValidationIssue[]) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenDefinitionKeys(item, `${path}/${index}`, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if (key !== "ownerUserId" && /^(userId|credentials?|password|cookies?|cookieJar|accessToken|refreshToken)$/i.test(key)) {
      issue(errors, childPath, "forbidden_identity_or_credential_field", "Definitions cannot persist caller identities, credentials, passwords, cookies, or tokens.");
    }
    findForbiddenDefinitionKeys(child, childPath, errors);
  }
}

function requiredText(errors: MateValidationIssue[], path: string, value: unknown, maxLength: number) {
  const text = string(value).trim();
  if (!text || text.length > maxLength) issue(errors, path, "invalid_text", `A value between 1 and ${maxLength} characters is required.`);
}

function requiredInteger(errors: MateValidationIssue[], path: string, value: unknown, minimum: number) {
  if (!Number.isInteger(value) || Number(value) < minimum) issue(errors, path, "invalid_integer", `An integer greater than or equal to ${minimum} is required.`);
}

function requiredEqual(errors: MateValidationIssue[], path: string, actual: unknown, expected: unknown) {
  if (actual !== expected) issue(errors, path, "fixed_contract_value_required", `Expected ${JSON.stringify(expected)}.`);
}

function validateExperienceChannels(
  errors: MateValidationIssue[],
  policy: Record<string, unknown>,
  path: string,
  allowed: string[]
) {
  if (typeof policy.enabled !== "boolean") issue(errors, `${path}/enabled`, "required_boolean", "An explicit enabled flag is required.");
  const channels = array(policy.channels).map(string);
  if (channels.some((channel) => !allowed.includes(channel))) {
    issue(errors, `${path}/channels`, "invalid_experience_channel", `Allowed channels: ${allowed.join(", ")}.`);
  }
  if (policy.enabled === true && channels.length === 0) {
    issue(errors, `${path}/channels`, "experience_channel_required", "An enabled product experience requires at least one channel.");
  }
}

function issue(target: MateValidationIssue[], path: string, code: string, message: string) {
  target.push({ code, message, path: path || "/" });
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

export async function sha256Digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
