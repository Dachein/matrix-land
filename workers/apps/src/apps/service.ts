import { installationHostname } from "../../../../src/shared/installationDomains.ts";
import { syncAppMail, revokeAppMail } from "./mailService";
import type { AppsApp, AppsProvisioningJob, AppsResource } from "../../../../src/shared/types";
import {
  APPS_HYPERDRIVE_PASSWORD_SECRET_NAME,
  APPS_HYPERDRIVE_RESOURCE_TYPE
} from "../../../../src/shared/appsHyperdrive";
import {
  APPS_RESOURCE_CATALOG,
  isAppsAppMcpRequiredType,
  isAppsAppMcpSupportedType,
  appsAppendableResourceTypes,
  type AppsProvisionedResourceDefinition
} from "../../../../src/shared/appsResourceCatalog";
import { audit } from "../core/audit";
import { deleteR2ArtifactKeys } from "../core/artifacts";
import { decryptSecretValue, encryptSecretValue } from "../core/auth";
import { normalizeCollaboratorUserIds, normalizeUserIdentifier, principalOwnsUserId, principalUserIdentifiers } from "../core/collaborators";
import { readJson } from "../core/http";
import { isSupportedAppType, normalizeAppType, normalizeVisibility } from "../core/normalizers";
import { HttpError, type Env, type Principal } from "../core/types";
import { hostnameFromUrl, normalizeAppCode, optionalText, parseStringArray, randomToken, readString, requireText, slugify } from "../core/utils";
import { ensureAndMarkAppDomains, ensurePublishedAppDomain } from "../domains/cloudflare";
import type { AppsAppSecretRow, AppsDomainRow, AppsResourceRow } from "../db/rows";
import { issueLlmAppToken, LLM_APP_SECRET_NAME, revokeLlmAppToken } from "../llm-gateway/client";
import { provisionResourceTypes } from "../provisioning/cloudflareResources";
import { runProvisioningJob } from "../provisioning/runner";
import { readProvisioningJob } from "../provisioning/service";
import { CREATE_APP_STEPS } from "../provisioning/steps";
import { fallbackRuntimeUrls, runtimeUrls } from "../runtime/urls";
import { syncAppsAppAuthClient } from "./authSync";
import { sendAppCreationEmail } from "./creationEmail";
import {
  delistPublishedAppMcpResource,
  relistPublishedAppMcpResource,
  resyncPublishedAppMcpResource
} from "./appMcpRegistry";
import { deleteAppExternalResources } from "./deleteResources";
import { syncReadyAppEmailRuntimeConfig, syncReadyAppStreamRuntimeConfig } from "./cloudflareDeploy";
import { appCodeFromRow, hydrateApp, readApp, requireWritableApp } from "./queries";
import { resourceName, selectedResourceTemplates, uniqueAppCode } from "./resources";

export type CreateAppInput = {
  emailEnabled?: boolean;
  emailPrefix?: string;
  emailTriggerEnabled?: boolean;
  accessMode?: string;
  accessTargets?: string[];
  code?: string;
  description?: string;
  directoryReadScope?: string;
  agentMcpEnabled?: boolean;
  loginRequired?: boolean;
  llmEnabled?: boolean;
  name?: string;
  resourceTypes?: string[];
  type?: string;
  visibility?: string;
};

const EMAIL_FROM_ENV = "WORKSPACE_EMAIL_FROM";
const LEGACY_EMAIL_SEND_ENDPOINT_ENV = "WORKSPACE_EMAIL_SEND_ENDPOINT";
const LEGACY_EMAIL_SEND_TOKEN_ENV = "WORKSPACE_EMAIL_SEND_TOKEN";
const LEGACY_EMAIL_SEND_TOKEN_NAME_ENV = "WORKSPACE_EMAIL_SEND_TOKEN_NAME";
const EMAIL_INBOUND_ADDRESS_ENV = "WORKSPACE_EMAIL_INBOUND_ADDRESS";
const EMAIL_ROUTER_WORKER_ENV = "WORKSPACE_EMAIL_ROUTER_WORKER";
const EMAIL_ROUTING_MODE_ENV = "WORKSPACE_EMAIL_ROUTING_MODE";
const RESERVED_EMAIL_ROUTING_PREFIXES = new Set(["abuse", "admin", "mailer-daemon", "postmaster", "root", "security", "support"]);
const HYPERDRIVE_PASSWORD_SECRET_DESCRIPTION = "Platform-only password used to create the App Hyperdrive connection during MCP deployment.";

export type CreateAppResult = {
  app: AppsApp;
  provisioningJob: AppsProvisioningJob;
};

export async function createApp(request: Request, env: Env, principal: Principal, ctx: ExecutionContext): Promise<CreateAppResult> {
  const body = await readJson<CreateAppInput>(request);
  const result = await createAppFromInput(body, env, principal, ctx);
  ctx.waitUntil(runProvisioningJob(env, result.provisioningJob.id));
  return result;
}

export async function deleteApp(request: Request, env: Env, principal: Principal, appId: string) {
  const app = await requireWritableApp(env.APPS_DB, principal, appId);
  const body = await readJson<{ appCode?: string }>(request);
  const expectedAppCode = appCodeFromRow(app);
  if (!expectedAppCode || readString(body.appCode).trim() !== expectedAppCode) {
    throw new HttpError(400, "delete_confirmation_mismatch");
  }

  let cleanupStage = "inventory";
  try {
    const [resourcesResult, domainsResult, sourceVersionsResult, sourceSnapshotsResult, deployArtifactsResult, llmSecret] = await Promise.all([
      env.APPS_DB
        .prepare("SELECT * FROM apps_app_resources WHERE app_id = ? ORDER BY environment, type")
        .bind(appId)
        .all<AppsResourceRow>(),
      env.APPS_DB
        .prepare("SELECT * FROM apps_domains WHERE app_id = ? ORDER BY environment, type")
        .bind(appId)
        .all<AppsDomainRow>(),
      env.APPS_DB
        .prepare("SELECT artifact_key AS artifactKey FROM apps_app_source_versions WHERE app_id = ?")
        .bind(appId)
        .all<{ artifactKey: string }>(),
      env.APPS_DB
        .prepare("SELECT archive_key AS archiveKey FROM apps_app_source_snapshots WHERE app_id = ?")
        .bind(appId)
        .all<{ archiveKey: string }>(),
      env.APPS_DB
        .prepare("SELECT archive_key AS archiveKey FROM apps_app_deploy_artifacts WHERE app_id = ?")
        .bind(appId)
        .all<{ archiveKey: string }>(),
      env.APPS_DB
        .prepare("SELECT * FROM apps_app_secrets WHERE app_id = ? AND environment = 'production' AND name = ? LIMIT 1")
        .bind(appId, LLM_APP_SECRET_NAME)
        .first<AppsAppSecretRow>()
    ]);
    cleanupStage = "mail_revocation";
    await revokeAppMail(env,app);
    const resources = resourcesResult.results ?? [];
    const domains = domainsResult.results ?? [];
    const sourceVersions = sourceVersionsResult.results ?? [];
    const sourceSnapshots = sourceSnapshotsResult.results ?? [];
    const deployArtifacts = deployArtifactsResult.results ?? [];

    cleanupStage = "access_revocation";
    if (app.status === "published") {
      await delistPublishedAppMcpResource(env, app);
      await syncAppsAppAuthClient(env, app, {
        loginRequired: app.login_required === 1,
        sdkStatus: "connected",
        status: "draft",
        visibility: normalizeVisibility(app.visibility, "private")
      });
    }
    await env.APPS_DB
      .prepare("UPDATE apps_apps SET status = 'archived', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), appId)
      .run();

    cleanupStage = "llm_revocation";
    const llmToken = await configuredSecretValue(env, llmSecret);
    const llmRevocation = llmToken ? await revokeLlmAppToken(env, llmToken) : undefined;

    cleanupStage = "external_resources";
    await audit(env.APPS_DB, principal, "app deletion progress", "apps_app", appId, { cleanupStage });
    const externalCleanup = await deleteAppExternalResources(env, app, resources, domains);
    if (llmRevocation) {
      externalCleanup.deletedExternalResources.unshift(`litellm-key:${llmRevocation.tokenId}`);
    }
    cleanupStage = "artifacts";
    await audit(env.APPS_DB, principal, "app deletion progress", "apps_app", appId, { cleanupStage });
    const deletedArtifactKeys = await deleteR2ArtifactKeys(env, [
      ...sourceVersions.map((version) => version.artifactKey),
      ...sourceSnapshots.map((snapshot) => snapshot.archiveKey),
      ...deployArtifacts.map((artifact) => artifact.archiveKey)
    ]);

    cleanupStage = "records";
    await env.APPS_DB.batch([
      env.APPS_DB.prepare("DELETE FROM apps_handoff_links WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_provisioning_steps WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_provisioning_jobs WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_migration_registry WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_domains WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_app_source_versions WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_app_source_snapshots WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_deployments WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_app_deploy_artifacts WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_app_env_vars WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_app_secrets WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_app_resources WHERE app_id = ?").bind(appId),
      env.APPS_DB.prepare("DELETE FROM apps_apps WHERE id = ?").bind(appId)
    ]);

    cleanupStage = "completion_audit";
    await audit(env.APPS_DB, principal, "deleted app", "apps_app", appId, {
      appCode: expectedAppCode,
      artifactKeys: deletedArtifactKeys,
      externalResources: externalCleanup.deletedExternalResources
    });

    return {
      appId,
      deleted: true,
      cleanup: {
        artifactKeys: deletedArtifactKeys,
        externalResources: externalCleanup.deletedExternalResources
      }
    };
  } catch (error) {
    await audit(env.APPS_DB, principal, "failed app deletion", "apps_app", appId, {
      appCode: expectedAppCode,
      cleanupStage,
      errorCode: error instanceof HttpError ? error.code : "apps_app_cleanup_failed",
      errorName: error instanceof Error ? error.name : "NonErrorThrown",
      ...(error instanceof HttpError ? { status: error.status, details: error.details } : {}),
      ...((cleanupStage === "artifacts" || cleanupStage === "records") && error instanceof Error
        ? { errorMessage: error.message.slice(0, 400) }
        : {})
    }).catch(() => {
      console.error("apps_app_delete_failure_audit_unavailable", { appId, cleanupStage });
    });
    throw error;
  }
}

export async function createAppFromInput(body: CreateAppInput, env: Env, principal: Principal, ctx?: ExecutionContext): Promise<CreateAppResult> {
  const name = requireText(body.name, "missing_app_name", 120);
  const description = optionalText(body.description, 1200);
  if (body.type !== undefined && !isSupportedAppType(body.type)) {
    throw new HttpError(400, "invalid_app_type");
  }
  const type = normalizeAppType(body.type);
  const visibility = normalizeVisibility(body.visibility, type === "static_page" ? "public" : "private");
  const loginRequired = body.loginRequired === true;
  const accessTargets = normalizeAccessTargets(body.accessTargets);
  const directoryReadScope = normalizeDirectoryReadScope(body.directoryReadScope);
  if (directoryReadScope === "company" && !loginRequired) {
    throw new HttpError(400, "company_directory_scope_requires_workspace_auth");
  }
  if (type === "static_page" && (visibility === "private" || visibility === "team" || accessTargets.length > 0) && !loginRequired) {
    throw new HttpError(400, "static_page_private_auth_required");
  }
  const agentMcpEnabled = isAppsAppMcpRequiredType(type)
    || (isAppsAppMcpSupportedType(type) && body.agentMcpEnabled === true);
  const llmEnabled = type !== "static_page" && body.llmEnabled === true;
  const orgSlug = slugify(principal.orgSlug) || principal.orgSlug || "org";
  // App codes back the public canonical hostname, so they must be unique
  // across organizations rather than only inside an organization.
  const code = await uniqueAppCode(env.APPS_DB, principal.orgId, body.code || name, undefined, true);
  if (body.emailEnabled) normalizeSenderMailbox(body.emailPrefix, code, env);
  if (body.emailTriggerEnabled && !body.emailEnabled) throw new HttpError(400,"mail_trigger_requires_mailbox");
  const appId = `app_${randomToken(12)}`;
  const dataServiceId = `ds_${randomToken(12)}`;
  const now = new Date().toISOString();
  const templates = selectedResourceTemplates(type, body.resourceTypes, agentMcpEnabled);
  const resourceTypes = templates.map((template) => template.type);
  const resources = templates.map((template) => ({
    id: `res_${randomToken(12)}`,
    appId,
    dataServiceId,
    type: template.type,
    provider: template.provider,
    resourceName: resourceName(code, template.nameToken),
    resourceId: undefined,
    bindingName: template.bindingName,
    environment: template.environment,
    status: template.status ?? "ready",
    createdAt: now
  } satisfies AppsResource));
  const runtime = runtimeUrls(env, code);
  const fallbackRuntime = fallbackRuntimeUrls(env, code);
  const jobId = `job_${randomToken(12)}`;
  const provisioningSteps = CREATE_APP_STEPS;
  const mailStatements = body.emailEnabled === true ? await unifiedMailStatements(env,principal,{id:appId,data_service_id:dataServiceId},code,body,now) : [];
  const llmToken = llmEnabled
    ? await issueLlmAppToken(env, principal, {
      appCode: code,
      appId,
      appName: name
    })
    : undefined;
  const llmSecret = llmToken
    ? {
      ...await encryptSecretValue(env, llmToken.token),
      id: `sec_${randomToken(12)}`,
      name: LLM_APP_SECRET_NAME,
      description: "LLM Gateway App Key"
    }
    : undefined;

  await env.APPS_DB.batch([
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_apps (
          id,
          org_id,
          org_slug,
          owner_user_id,
          name,
          code,
          slug,
          description,
          type,
          status,
          visibility,
          login_required,
          agent_mcp_enabled,
          llm_enabled,
          llm_default_model,
          llm_endpoint,
          access_targets_json,
          directory_read_scope,
          data_service_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(appId, principal.orgId, orgSlug, principal.sub, name, code, code, description, type, visibility, loginRequired ? 1 : 0, agentMcpEnabled ? 1 : 0, llmEnabled ? 1 : 0, null, null, JSON.stringify(accessTargets), directoryReadScope, dataServiceId, now, now),
    ...(llmSecret ? [env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_app_secrets (
          id,
          app_id,
          org_id,
          name,
          environment,
          description,
          required,
          status,
          cipher_text,
          cipher_iv,
          algorithm,
          configured_by,
          configured_at,
          declared_by,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'production', ?, 1, 'configured', ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        llmSecret.id,
        appId,
        principal.orgId,
        llmSecret.name,
        llmSecret.description,
        llmSecret.cipherText,
        llmSecret.cipherIv,
        llmSecret.algorithm,
        "workspace-apps",
        now,
        principal.sub,
        now,
        now
      )] : []),
    ...(resourceTypes.includes(APPS_HYPERDRIVE_RESOURCE_TYPE) ? [hyperdrivePasswordSecretStatement(env, {
      appId,
      declaredBy: principal.sub,
      now,
      orgId: principal.orgId
    })] : []),
    ...resources.map((resource) => env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_app_resources (
          id,
          app_id,
          data_service_id,
          type,
          provider,
          resource_name,
          resource_id,
          binding_name,
          environment,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        resource.id,
        resource.appId,
        resource.dataServiceId,
        resource.type,
        resource.provider,
        resource.resourceName,
        resource.resourceId ?? "",
        resource.bindingName ?? "",
        resource.environment,
        resource.status === "placeholder" ? "placeholder" : "queued",
        resource.createdAt
      )),
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_domains (id, app_id, hostname, type, environment, status, fallback_url, created_at)
        VALUES (?, ?, ?, 'production', 'production', 'reserved', ?, ?)
        `
      )
      .bind(`dom_${randomToken(12)}`, appId, hostnameFromUrl(runtime.productionUrl), fallbackRuntime.productionUrl, now),
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_provisioning_jobs (
          id,
          app_id,
          org_id,
          type,
          status,
          progress,
          current_step,
          requested_by,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, 'create_app', 'queued', 0, ?, ?, ?, ?)
        `
      )
      .bind(jobId, appId, principal.orgId, provisioningSteps[0]?.key ?? "queued", principal.sub, now, now),
    ...provisioningSteps.map((step, index) => {
      const selectedStepResourceTypes = (step.resourceTypes ?? []).filter((resourceType) => resourceTypes.includes(resourceType));
      const skipped = Array.isArray(step.resourceTypes) && selectedStepResourceTypes.length === 0;
      return env.APPS_DB
        .prepare(
          `
          INSERT INTO apps_provisioning_steps (
            id,
            job_id,
            app_id,
            step_order,
            step_key,
            label,
            status,
            progress,
            resource_type,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .bind(
          `step_${randomToken(12)}`,
          jobId,
          appId,
          index + 1,
          step.key,
          step.label,
          skipped ? "skipped" : "queued",
          step.progress,
          selectedStepResourceTypes.join(","),
          now,
          now
        );
    }),
    ...mailStatements
  ]);

  if (body.emailEnabled === true) await syncAppMail(env,principal,{id:appId,org_id:principal.orgId,name,owner_user_id:principal.sub});

  await audit(env.APPS_DB, principal, "created apps app", "apps_app", appId, {
    accessMode: readString(body.accessMode).trim(),
    accessTargets,
    directoryReadScope,
    agentMcpEnabled,
    llmEnabled,
    requestedResourceTypes: Array.isArray(body.resourceTypes) ? body.resourceTypes : [],
    resourceTypes,
    type,
    visibility
  });

  const result = {
    app: await readApp(env.APPS_DB, env, principal, appId),
    provisioningJob: await readProvisioningJob(env.APPS_DB, principal, jobId)
  };
  const notification = sendAppCreationEmail(env, principal, result.app);
  if (ctx) ctx.waitUntil(notification);
  else await notification;
  return result;
}

export async function patchApp(request: Request, env: Env, principal: Principal, appId: string): Promise<AppsApp> {
  const row = await requireWritableApp(env.APPS_DB, principal, appId);
  const body = await readJson<{
    addResourceTypes?: unknown;
    agentMcpEnabled?: boolean;
    code?: string;
    description?: string;
    directoryReadScope?: string;
    emailEnabled?: boolean;
    emailPrefix?: string;
    emailTriggerEnabled?: boolean;
    emailSenderMailbox?: string;
    emailRoutingEnabled?: boolean;
    emailRoutingPrefix?: string;
    emailSendingEnabled?: boolean;
    llmEnabled?: boolean;
    name?: string;
    removeResourceTypes?: unknown;
    resourceTypes?: unknown;
    type?: string;
  }>(request);
  const name = optionalText(body.name, 120) || row.name;
  const description = body.description === undefined ? row.description : optionalText(body.description, 1200);
  const currentCode = appCodeFromRow(row);
  if (body.code !== undefined && normalizeAppCode(body.code) !== currentCode) {
    throw new HttpError(409, "apps_app_code_immutable");
  }
  if (body.type !== undefined && readString(body.type).trim() !== row.type) {
    throw new HttpError(409, "apps_app_type_immutable");
  }
  if (body.removeResourceTypes !== undefined) {
    throw new HttpError(409, "app_resource_removal_not_supported");
  }
  if (body.resourceTypes !== undefined) {
    throw new HttpError(400, "app_resource_replacement_not_supported");
  }
  const code = currentCode;
  const requestedResourceTypes = normalizeAppendableResourceTypes(row.type, body.addResourceTypes);
  const runtime = runtimeUrls(env, code);
  const fallbackRuntime = fallbackRuntimeUrls(env, code);
  const now = new Date().toISOString();
  const currentDirectoryReadScope = normalizeDirectoryReadScope(row.directory_read_scope);
  const nextDirectoryReadScope = body.directoryReadScope === undefined
    ? currentDirectoryReadScope
    : normalizeDirectoryReadScope(body.directoryReadScope);
  if (nextDirectoryReadScope === "company" && row.login_required !== 1) {
    throw new HttpError(400, "company_directory_scope_requires_workspace_auth");
  }
  const currentAgentMcpEnabled = row.agent_mcp_enabled === 1;
  const agentMcpRequired = isAppsAppMcpRequiredType(row.type);
  if (agentMcpRequired && body.agentMcpEnabled === false) {
    throw new HttpError(409, "agent_app_mcp_required");
  }
  if (body.agentMcpEnabled === true && !isAppsAppMcpSupportedType(row.type)) {
    throw new HttpError(400, "app_mcp_capability_not_supported");
  }
  const nextAgentMcpEnabled = agentMcpRequired
    || (body.agentMcpEnabled === undefined ? currentAgentMcpEnabled : body.agentMcpEnabled === true);
  let agentMcpRegistrationRequired = false;
  if (nextAgentMcpEnabled && !currentAgentMcpEnabled) {
    await requireReadyAppMcpRuntime(env.APPS_DB, appId);
    agentMcpRegistrationRequired = !(await relistPublishedAppMcpResource(env, row));
  }
  if (currentAgentMcpEnabled && !nextAgentMcpEnabled) {
    await delistPublishedAppMcpResource(env, row);
  }
  const supportsLlm = row.type !== "static_page";
  const nextLlmEnabled = supportsLlm && (body.llmEnabled === undefined ? row.llm_enabled === 1 : body.llmEnabled === true);
  if (body.llmEnabled === true && !supportsLlm) {
    throw new HttpError(400, "static_page_llm_not_supported");
  }

  const statements = [
    env.APPS_DB
      .prepare(
        `
        UPDATE apps_apps
        SET name = ?, description = ?, agent_mcp_enabled = ?, llm_enabled = ?, directory_read_scope = ?, updated_at = ?
        WHERE id = ?
        `
      )
      .bind(name, description, nextAgentMcpEnabled ? 1 : 0, nextLlmEnabled ? 1 : 0, nextDirectoryReadScope, now, appId)
  ];
  if (nextAgentMcpEnabled) {
    const schemaResourceName = resourceName(code, APPS_RESOURCE_CATALOG.schema_registry.nameToken);
    statements.push(env.APPS_DB.prepare(`
      INSERT INTO apps_app_resources (
        id, app_id, data_service_id, type, provider, resource_name, resource_id,
        binding_name, environment, status, created_at
      )
      SELECT ?, ?, ?, 'schema_registry', ?, ?, ?, '', 'prod', 'ready', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM apps_app_resources WHERE app_id = ? AND type = 'schema_registry'
      )
    `).bind(
      `res_${randomToken(12)}`,
      appId,
      row.data_service_id,
      APPS_RESOURCE_CATALOG.schema_registry.provider,
      schemaResourceName,
      schemaResourceName,
      now,
      appId
    ));
  }
  for (const resourceType of requestedResourceTypes) {
    const definition: AppsProvisionedResourceDefinition = APPS_RESOURCE_CATALOG[resourceType];
    const appendedResourceName = resourceName(code, definition.nameToken);
    statements.push(env.APPS_DB.prepare(`
      INSERT INTO apps_app_resources (
        id, app_id, data_service_id, type, provider, resource_name, resource_id,
        binding_name, environment, status, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1
        FROM apps_app_resources
        WHERE app_id = ? AND environment = ? AND type = ?
      )
    `).bind(
      `res_${randomToken(12)}`,
      appId,
      row.data_service_id,
      resourceType,
      definition.provider,
      appendedResourceName,
      definition.bindingName ?? "",
      definition.environment,
      resourceType === "cron_trigger" || resourceType === APPS_HYPERDRIVE_RESOURCE_TYPE ? "placeholder" : "queued",
      now,
      appId,
      definition.environment,
      resourceType
    ));
  }
  if (requestedResourceTypes.includes(APPS_HYPERDRIVE_RESOURCE_TYPE)) {
    statements.push(hyperdrivePasswordSecretStatement(env, {
      appId,
      declaredBy: principal.sub,
      now,
      orgId: principal.orgId
    }));
  }
  statements.push(env.APPS_DB
    .prepare("UPDATE apps_domains SET hostname = ?, status = 'reserved', fallback_url = ?, last_checked_at = NULL, error_code = NULL, error_message = NULL WHERE app_id = ? AND type = 'production'")
    .bind(hostnameFromUrl(runtime.productionUrl), fallbackRuntime.productionUrl, appId));

  if (body.llmEnabled === true && row.llm_enabled !== 1) {
    const llmToken = await issueLlmAppToken(env, principal, {
      appCode: code,
      appId,
      appName: name
    });
    const llmSecret = await encryptSecretValue(env, llmToken.token);
    statements.push(env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_app_secrets (
          id,
          app_id,
          org_id,
          name,
          environment,
          description,
          required,
          status,
          cipher_text,
          cipher_iv,
          algorithm,
          configured_by,
          configured_at,
          declared_by,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'production', 'LLM Gateway App Key', 1, 'configured', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, environment, name) DO UPDATE SET
          description = excluded.description,
          required = 1,
          status = 'configured',
          cipher_text = excluded.cipher_text,
          cipher_iv = excluded.cipher_iv,
          algorithm = excluded.algorithm,
          configured_by = excluded.configured_by,
          configured_at = excluded.configured_at,
          updated_at = excluded.updated_at
        `
      )
      .bind(
        `sec_${randomToken(12)}`,
        appId,
        principal.orgId,
        LLM_APP_SECRET_NAME,
        llmSecret.cipherText,
        llmSecret.cipherIv,
        llmSecret.algorithm,
        "workspace-apps",
        now,
        principal.sub,
        now,
        now
      ));
  }
  if (body.llmEnabled === false && row.llm_enabled === 1) {
    const llmSecret = await env.APPS_DB
      .prepare("SELECT * FROM apps_app_secrets WHERE app_id = ? AND environment = 'production' AND name = ? LIMIT 1")
      .bind(appId, LLM_APP_SECRET_NAME)
      .first<AppsAppSecretRow>();
    const llmToken = await configuredSecretValue(env, llmSecret);
    if (llmToken) {
      await revokeLlmAppToken(env, llmToken, "apps_app_llm_disable");
    }
    statements.push(env.APPS_DB
      .prepare("DELETE FROM apps_app_secrets WHERE app_id = ? AND environment = 'production' AND name = ?")
      .bind(appId, LLM_APP_SECRET_NAME));
  }

  const unifiedEmailChange = body.emailEnabled !== undefined || body.emailPrefix !== undefined || body.emailTriggerEnabled !== undefined;
  if (unifiedEmailChange && (body.emailSendingEnabled !== undefined || body.emailRoutingEnabled !== undefined)) throw new HttpError(400,"mixed_email_configuration");
  if (unifiedEmailChange) {
    statements.push(...await unifiedMailStatements(env,principal,row,code,body,now));
  }
  if (!unifiedEmailChange && body.emailSendingEnabled === true) {
    statements.push(...emailSendingStatements(env, principal, row, code, body.emailSenderMailbox, now));
  } else if (!unifiedEmailChange && body.emailSendingEnabled === false) {
    statements.push(...disableEmailSendingStatements(env, row));
  }

  if (!unifiedEmailChange && body.emailRoutingEnabled === true) {
    const emailRoutingConfigStatements = await emailRoutingStatements(env, principal, row, body.emailRoutingPrefix, now);
    statements.push(...emailRoutingConfigStatements);
  } else if (!unifiedEmailChange && body.emailRoutingEnabled === false) {
    statements.push(...disableEmailRoutingStatements(env, row));
  }

  if (nextDirectoryReadScope !== currentDirectoryReadScope && row.login_required === 1) {
    const connectedDeployment = row.status === "published" || Boolean(await env.APPS_DB
      .prepare(
        `
        SELECT 1 AS connected
        FROM apps_deployments
        WHERE app_id = ? AND status IN ('ready', 'published')
        LIMIT 1
        `
      )
      .bind(appId)
      .first<{ connected: number }>());
    if (connectedDeployment) {
      await syncAppsAppAuthClient(env, {
        ...row,
        directory_read_scope: nextDirectoryReadScope,
        name,
        updated_at: now
      }, {
        directoryReadScope: nextDirectoryReadScope,
        loginRequired: true,
        requestId: request.headers.get("x-request-id") ?? undefined,
        status: row.status === "published" ? "listed" : "draft",
        visibility: normalizeVisibility(row.visibility, "private")
      });
    }
  }

  await env.APPS_DB.batch(statements);
  if (requestedResourceTypes.length > 0) {
    await provisionResourceTypes(env, row, requestedResourceTypes, now, { requireRegistered: true });
  }
  if (requestedResourceTypes.includes("media")) {
    await syncReadyAppStreamRuntimeConfig(env, row);
  }
  if (unifiedEmailChange || body.emailSendingEnabled !== undefined || body.emailRoutingEnabled !== undefined) {
    await syncAppMail(env,principal,{...row,name});
    await syncReadyAppEmailRuntimeConfig(env, {
      ...row,
      name,
      agent_mcp_enabled: nextAgentMcpEnabled ? 1 : 0,
      llm_enabled: nextLlmEnabled ? 1 : 0,
      updated_at: now
    });
  }
  await audit(env.APPS_DB, principal, "updated apps app", "apps_app", appId, {
    addedResourceTypes: requestedResourceTypes,
    agentMcpEnabled: nextAgentMcpEnabled,
    agentMcpRegistrationRequired,
    emailRoutingEnabled: body.emailRoutingEnabled === true,
    emailSendingEnabled: body.emailSendingEnabled === true,
    directoryReadScope: nextDirectoryReadScope,
    llmEnabled: nextLlmEnabled,
    name,
    code
  });

  return readApp(env.APPS_DB, env, principal, appId);
}

function normalizeAppendableResourceTypes(appType: string, value: unknown) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_resource_selection");
  }

  const requested = [...new Set(value.map((item) => readString(item).trim()).filter(Boolean))];
  const allowed = new Set<string>(appsAppendableResourceTypes(appType));
  if (requested.some((resourceType) => !allowed.has(resourceType))) {
    throw new HttpError(400, "invalid_resource_selection");
  }
  return requested as Array<keyof typeof APPS_RESOURCE_CATALOG>;
}

function normalizeDirectoryReadScope(value: unknown): "app" | "company" {
  const scope = readString(value).trim();
  if (!scope || scope === "app") return "app";
  if (scope === "company") return "company";
  throw new HttpError(400, "invalid_directory_read_scope");
}

function hyperdrivePasswordSecretStatement(env: Env, input: {
  appId: string;
  declaredBy: string;
  now: string;
  orgId: string;
}) {
  return env.APPS_DB.prepare(`
    INSERT INTO apps_app_secrets (
      id, app_id, org_id, name, environment, description, required, status,
      declared_by, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 'production', ?, 1, 'declared', ?, ?, ?)
    ON CONFLICT(app_id, environment, name) DO UPDATE SET
      description = excluded.description,
      required = 1,
      updated_at = excluded.updated_at
  `).bind(
    `sec_${randomToken(12)}`,
    input.appId,
    input.orgId,
    APPS_HYPERDRIVE_PASSWORD_SECRET_NAME,
    HYPERDRIVE_PASSWORD_SECRET_DESCRIPTION,
    input.declaredBy,
    input.now,
    input.now
  );
}

async function requireReadyAppMcpRuntime(db: D1Database, appId: string) {
  const runtime = await db.prepare(`
    SELECT id
    FROM apps_app_resources
    WHERE app_id = ?
      AND type IN ('worker', 'pages_function')
      AND status = 'ready'
    LIMIT 1
  `).bind(appId).first<{ id: string }>();
  if (!runtime) {
    throw new HttpError(409, "app_mcp_server_runtime_required");
  }
}

export async function upgradeAppMailResource(env: Env, principal: Principal, app: {id:string;code?:string;slug:string;data_service_id:string}) {
  const resources=(await env.APPS_DB.prepare("SELECT type FROM apps_app_resources WHERE app_id=? AND type IN ('email_sending','email_routing')").bind(app.id).all<{type:string}>()).results;
  if (!resources.length) return;
  await env.APPS_DB.batch(await unifiedMailStatements(env,principal,app,app.code || app.slug,{emailEnabled:true},new Date().toISOString()));
}

async function unifiedMailStatements(env: Env, principal: Principal, row:{id:string;data_service_id:string}, code:string, input:{emailEnabled?:boolean;emailPrefix?:string;emailTriggerEnabled?:boolean}, now:string) {
  if ((input.emailEnabled !== undefined && typeof input.emailEnabled !== 'boolean') || (input.emailTriggerEnabled !== undefined && typeof input.emailTriggerEnabled !== 'boolean')) throw new HttpError(400,"invalid_mail_configuration");
  if (input.emailPrefix !== undefined && (typeof input.emailPrefix !== 'string' || input.emailPrefix.trim().length>64 || input.emailPrefix.includes('@'))) throw new HttpError(400,"invalid_email_sender_prefix");
  const current=await env.APPS_DB.prepare("SELECT value FROM apps_app_env_vars WHERE app_id=? AND name='WORKSPACE_EMAIL_FROM' AND environment='production' AND target='runtime'").bind(row.id).first<{value:string}>();
  const inbox=await env.APPS_DB.prepare("SELECT resource_name FROM apps_app_resources WHERE app_id=? AND type='email_routing'").bind(row.id).first<{resource_name:string}>();
  const enabled=input.emailEnabled ?? !!(current || inbox);
  if (input.emailTriggerEnabled && !enabled) throw new HttpError(400,"mail_trigger_requires_mailbox");
  const statements: D1PreparedStatement[]=[];
  if (enabled) {
    const address=normalizeSenderMailbox(input.emailPrefix || current?.value || inbox?.resource_name, code, env);
    // Reserve receive and send together; another app's send-only address also counts as occupied.
    const occupied=await env.APPS_DB.prepare("SELECT app_id FROM apps_app_env_vars WHERE name='WORKSPACE_EMAIL_FROM' AND lower(value)=? AND app_id<>? LIMIT 1").bind(address,row.id).first();
    if(occupied) throw new HttpError(409,"email_routing_address_taken");
    statements.push(...emailSendingStatements(env,principal,row,code,address,now),...await emailRoutingStatements(env,principal,row,address.split('@')[0],now));
  } else statements.push(...disableEmailSendingStatements(env,row),...disableEmailRoutingStatements(env,row));
  if(input.emailTriggerEnabled!==undefined || !enabled) statements.push(env.APPS_DB.prepare(`INSERT INTO apps_app_env_vars(id,app_id,org_id,name,target,environment,value,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'WORKSPACE_MAIL_TRIGGER_ENABLED','runtime','production',?,?,?,?,?) ON CONFLICT(app_id,environment,target,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(`env_${randomToken(12)}`,row.id,principal.orgId,enabled && input.emailTriggerEnabled?'1':'0',principal.sub,principal.sub,now,now));
  return statements;
}

async function emailRoutingStatements(
  env: Env,
  principal: Principal,
  row: { data_service_id: string; id: string },
  inboundPrefix: unknown,
  now: string
) {
  const prefix = normalizeEmailRoutingPrefix(inboundPrefix);
  const domain = emailRoutingDomain(env);
  const address = `${prefix}@${domain}`;
  const routerWorker = readString(env.WORKSPACE_EMAIL_ROUTER_WORKER).trim();
  const definition = APPS_RESOURCE_CATALOG.email_routing;
  const existing = await env.APPS_DB
    .prepare(
      `
      SELECT id
      FROM apps_app_resources
      WHERE type = ?
        AND resource_name = ?
        AND app_id != ?
      LIMIT 1
      `
    )
    .bind(definition.type, address, row.id)
    .first<{ id: string }>();
  if (existing) {
    throw new HttpError(409, "email_routing_address_taken");
  }

  return [
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_app_resources (
          id,
          app_id,
          data_service_id,
          type,
          provider,
          resource_name,
          resource_id,
          binding_name,
          environment,
          status,
          created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, '', ?, 'ready', ?
        WHERE NOT EXISTS (
          SELECT 1
          FROM apps_app_resources
          WHERE app_id = ?
            AND environment = ?
            AND type = ?
        )
        `
      )
      .bind(
        `res_${randomToken(12)}`,
        row.id,
        row.data_service_id,
        definition.type,
        definition.provider,
        address,
        prefix,
        definition.environment,
        now,
        row.id,
        definition.environment,
        definition.type
      ),
    env.APPS_DB
      .prepare(
        `
        UPDATE apps_app_resources
        SET provider = ?,
            resource_name = ?,
            resource_id = ?,
            binding_name = '',
            status = 'ready'
        WHERE app_id = ?
          AND environment = ?
          AND type = ?
        `
      )
      .bind(definition.provider, address, prefix, row.id, definition.environment, definition.type),
    ...[
      [EMAIL_INBOUND_ADDRESS_ENV, address],
      [EMAIL_ROUTER_WORKER_ENV, routerWorker],
      [EMAIL_ROUTING_MODE_ENV, "process"]
    ].map(([name, value]) => env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_app_env_vars (
          id,
          app_id,
          org_id,
          name,
          target,
          environment,
          value,
          created_by,
          updated_by,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'runtime', 'production', ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, environment, target, name) DO UPDATE SET
          value = excluded.value,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
        `
      )
      .bind(`env_${randomToken(12)}`, row.id, principal.orgId, name, value, principal.sub, principal.sub, now, now))
  ];
}

function disableEmailRoutingStatements(env: Env, row: { id: string }) {
  const definition = APPS_RESOURCE_CATALOG.email_routing;

  return [
    env.APPS_DB
      .prepare("DELETE FROM apps_app_resources WHERE app_id = ? AND environment = ? AND type = ?")
      .bind(row.id, definition.environment, definition.type),
    env.APPS_DB
      .prepare("DELETE FROM apps_app_env_vars WHERE app_id = ? AND environment = 'production' AND target = 'runtime' AND name IN (?, ?, ?)")
      .bind(row.id, EMAIL_INBOUND_ADDRESS_ENV, EMAIL_ROUTER_WORKER_ENV, EMAIL_ROUTING_MODE_ENV)
  ];
}

function emailSendingStatements(
  env: Env,
  principal: Principal,
  row: { data_service_id: string; id: string },
  appCode: string,
  senderMailbox: unknown,
  now: string
) {
  const sender = normalizeSenderMailbox(senderMailbox, appCode, env);
  const definition = APPS_RESOURCE_CATALOG.email_sending;

  return [
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_app_resources (
          id,
          app_id,
          data_service_id,
          type,
          provider,
          resource_name,
          resource_id,
          binding_name,
          environment,
          status,
          created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?
        WHERE NOT EXISTS (
          SELECT 1
          FROM apps_app_resources
          WHERE app_id = ?
            AND environment = ?
            AND type = ?
        )
        `
      )
      .bind(
        `res_${randomToken(12)}`,
        row.id,
        row.data_service_id,
        definition.type,
        definition.provider,
        resourceName(appCode, definition.nameToken),
        `${definition.nameToken}_${randomToken(10)}`,
        definition.bindingName ?? "",
        definition.environment,
        now,
        row.id,
        definition.environment,
        definition.type
      ),
    env.APPS_DB
      .prepare(
        `
        UPDATE apps_app_resources
        SET provider = ?,
            resource_name = ?,
            binding_name = ?,
            status = 'ready'
        WHERE app_id = ?
          AND environment = ?
          AND type = ?
        `
      )
      .bind(
        definition.provider,
        resourceName(appCode, definition.nameToken),
        definition.bindingName ?? "",
        row.id,
        definition.environment,
        definition.type
      ),
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_app_env_vars (
          id,
          app_id,
          org_id,
          name,
          target,
          environment,
          value,
          created_by,
          updated_by,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'runtime', 'production', ?, ?, ?, ?, ?)
        ON CONFLICT(app_id, environment, target, name) DO UPDATE SET
          value = excluded.value,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
        `
      )
      .bind(`env_${randomToken(12)}`, row.id, principal.orgId, EMAIL_FROM_ENV, sender, principal.sub, principal.sub, now, now),
    env.APPS_DB
      .prepare("DELETE FROM apps_app_env_vars WHERE app_id = ? AND environment = 'production' AND target = 'runtime' AND name IN (?, ?)")
      .bind(row.id, LEGACY_EMAIL_SEND_ENDPOINT_ENV, LEGACY_EMAIL_SEND_TOKEN_NAME_ENV),
    env.APPS_DB
      .prepare("DELETE FROM apps_app_secrets WHERE app_id = ? AND environment = 'production' AND name = ?")
      .bind(row.id, LEGACY_EMAIL_SEND_TOKEN_ENV)
  ];
}

function disableEmailSendingStatements(env: Env, row: { id: string }) {
  const definition = APPS_RESOURCE_CATALOG.email_sending;

  return [
    env.APPS_DB
      .prepare("DELETE FROM apps_app_resources WHERE app_id = ? AND environment = ? AND type = ?")
      .bind(row.id, definition.environment, definition.type),
    env.APPS_DB
      .prepare("DELETE FROM apps_app_env_vars WHERE app_id = ? AND environment = 'production' AND target = 'runtime' AND name IN (?, ?, ?)")
      .bind(row.id, EMAIL_FROM_ENV, LEGACY_EMAIL_SEND_ENDPOINT_ENV, LEGACY_EMAIL_SEND_TOKEN_NAME_ENV),
    env.APPS_DB
      .prepare("DELETE FROM apps_app_secrets WHERE app_id = ? AND environment = 'production' AND name = ?")
      .bind(row.id, LEGACY_EMAIL_SEND_TOKEN_ENV)
  ];
}

function normalizeSenderMailbox(value: unknown, appCode: string, env: Env) {
  const domain = emailRoutingDomain(env);
  const raw = readString(value).trim().toLowerCase().slice(0, 320);
  let prefix = raw || appCode;
  if (prefix.includes("@")) {
    const [localPart, domainPart, extra] = prefix.split("@");
    if (extra !== undefined || domainPart !== domain) {
      throw new HttpError(400, "invalid_email_sender_mailbox");
    }
    prefix = localPart;
  }
  prefix = prefix.slice(0, 64);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(prefix) || prefix.includes("..")) {
    throw new HttpError(400, "invalid_email_sender_prefix");
  }
  if (RESERVED_EMAIL_ROUTING_PREFIXES.has(prefix)) {
    throw new HttpError(400, "reserved_email_sender_prefix");
  }
  return `${prefix}@${domain}`;
}

function normalizeEmailRoutingPrefix(value: unknown) {
  const prefix = readString(value).trim().toLowerCase().slice(0, 64);
  if (!prefix) {
    throw new HttpError(400, "missing_email_routing_prefix");
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(prefix) || prefix.includes("..")) {
    throw new HttpError(400, "invalid_email_routing_prefix");
  }
  if (RESERVED_EMAIL_ROUTING_PREFIXES.has(prefix)) {
    throw new HttpError(400, "reserved_email_routing_prefix");
  }
  return prefix;
}

function emailRoutingDomain(env: Env) {
  return installationHostname(env.WORKSPACE_EMAIL_ROUTING_DOMAIN);
}

function normalizeAccessTargets(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((target) => readString(target).trim()).filter(Boolean))].slice(0, 200);
}

async function configuredSecretValue(env: Env, secret: AppsAppSecretRow | null | undefined) {
  if (!secret || secret.status !== "configured" || !secret.cipher_text || !secret.cipher_iv) {
    return "";
  }
  return decryptSecretValue(env, {
    algorithm: secret.algorithm,
    cipherIv: secret.cipher_iv,
    cipherText: secret.cipher_text
  });
}

export async function publishProduction(request: Request, env: Env, principal: Principal, appId: string): Promise<AppsApp> {
  const row = await requireWritableApp(env.APPS_DB, principal, appId);
  const body = await readJson<{ loginRequired?: boolean; visibility?: string }>(request);
  const visibility = normalizeVisibility(body.visibility, normalizeVisibility(row.visibility, "private"));
  const loginRequired = body.loginRequired === undefined ? row.login_required === 1 : body.loginRequired !== false;
  if (row.type === "static_page" && (visibility === "private" || visibility === "team" || parseStringArray(row.access_targets_json).length > 0) && !loginRequired) {
    throw new HttpError(400, "static_page_private_auth_required");
  }
  if (row.status === "published" && loginRequired !== (row.login_required === 1)) {
    throw new HttpError(409, "auth_policy_change_requires_redeployment");
  }
  const now = new Date().toISOString();
  const url = runtimeUrls(env, appCodeFromRow(row)).productionUrl;
  await ensurePublishedAppDomain(env, appId);
  await syncAppsAppAuthClient(env, row, {
    loginRequired,
    requestId: request.headers.get("x-request-id") ?? undefined,
    visibility
  });

  await env.APPS_DB.batch([
    env.APPS_DB
      .prepare(
        `
        INSERT INTO apps_deployments (id, app_id, environment, version, status, url, created_by, created_at)
        VALUES (?, ?, 'production', ?, 'published', ?, ?, ?)
        `
      )
      .bind(`dep_${randomToken(12)}`, appId, `prod-${Date.now()}`, url, principal.sub, now),
    env.APPS_DB
      .prepare(
        `
        UPDATE apps_apps
        SET status = 'published', visibility = ?, login_required = ?, updated_at = ?
        WHERE id = ?
        `
      )
      .bind(visibility, loginRequired ? 1 : 0, now, appId),
  ]);

  await audit(env.APPS_DB, principal, "published production", "apps_app", appId, { url, visibility, loginRequired });
  return readApp(env.APPS_DB, env, principal, appId);
}

export async function updateVisibility(request: Request, env: Env, principal: Principal, appId: string): Promise<AppsApp> {
  const row = await requireWritableApp(env.APPS_DB, principal, appId);
  const body = await readJson<{ accessTargets?: string[]; loginRequired?: boolean; visibility?: string }>(request);
  const visibility = normalizeVisibility(body.visibility, "private");
  const loginRequired = body.loginRequired === undefined ? row.login_required === 1 : body.loginRequired !== false;
  if (row.status === "published" && loginRequired !== (row.login_required === 1)) {
    throw new HttpError(409, "auth_policy_change_requires_redeployment");
  }
  const accessTargets = normalizeAccessTargets(body.accessTargets);
  if (row.type === "static_page" && (visibility === "private" || visibility === "team" || accessTargets.length > 0) && !loginRequired) {
    throw new HttpError(400, "static_page_private_auth_required");
  }

  if (row.status === "published") {
    await syncAppsAppAuthClient(env, row, {
      accessTargets,
      loginRequired,
      requestId: request.headers.get("x-request-id") ?? undefined,
      visibility
    });
    await resyncPublishedAppMcpResource(env, row, { accessTargets, visibility });
  }

  await env.APPS_DB
    .prepare("UPDATE apps_apps SET visibility = ?, login_required = ?, access_targets_json = ?, updated_at = ? WHERE id = ?")
    .bind(visibility, loginRequired ? 1 : 0, JSON.stringify(accessTargets), new Date().toISOString(), appId)
    .run();
  await audit(env.APPS_DB, principal, "updated visibility", "apps_app", appId, { accessTargets, loginRequired, visibility });

  return readApp(env.APPS_DB, env, principal, appId);
}

export async function updateAppCollaborators(request: Request, env: Env, principal: Principal, appId: string): Promise<AppsApp> {
  const existing = await requireWritableApp(env.APPS_DB, principal, appId);

  const body = await readJson<{ collaboratorUserIds?: unknown }>(request);
  const ownerIdentifiers = new Set([
    existing.owner_user_id,
    ...(principalOwnsUserId(existing.owner_user_id, principal) ? principalUserIdentifiers(principal) : [])
  ].map(normalizeUserIdentifier).filter(Boolean));
  const collaboratorUserIds = normalizeCollaboratorUserIds(body.collaboratorUserIds)
    .filter((userId) => !ownerIdentifiers.has(userId));
  const now = new Date().toISOString();

  const updated = {
    ...existing,
    collaborator_user_ids_json: JSON.stringify(collaboratorUserIds),
    updated_at: now
  };

  if (existing.login_required === 1) {
    const connectedDeployment = existing.status === "published" || Boolean(await env.APPS_DB
      .prepare(
        `
        SELECT 1
        FROM apps_deployments
        WHERE app_id = ?
          AND environment = 'production'
          AND status IN ('ready', 'published', 'superseded')
        LIMIT 1
        `
      )
      .bind(appId)
      .first());
    await syncAppsAppAuthClient(env, updated, {
      loginRequired: true,
      sdkStatus: connectedDeployment ? "connected" : "pending",
      status: existing.status === "published" ? "listed" : "draft",
      visibility: normalizeVisibility(existing.visibility, "private")
    });
  }
  await resyncPublishedAppMcpResource(env, updated);

  const savedCollaborators = await env.APPS_DB
    .prepare("UPDATE apps_apps SET collaborator_user_ids_json = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND ownership_sync_pending = 0 RETURNING id")
    .bind(JSON.stringify(collaboratorUserIds), now, appId, existing.owner_user_id)
    .first();
  if (!savedCollaborators) throw new HttpError(409, "apps_owner_transfer_owner_changed");

  await audit(env.APPS_DB, principal, "updated app collaborators", "apps_app", appId, {
    collaboratorUserIds
  });

  return hydrateApp(env.APPS_DB, env, updated);
}

export async function updateAuthPolicy(request: Request, env: Env, principal: Principal, appId: string): Promise<AppsApp> {
  const row = await requireWritableApp(env.APPS_DB, principal, appId);
  const body = await readJson<{ loginRequired?: boolean }>(request);
  const loginRequired = body.loginRequired === undefined ? row.login_required === 1 : body.loginRequired !== false;

  if (row.type === "static_page" && (row.visibility === "private" || row.visibility === "team" || parseStringArray(row.access_targets_json).length > 0) && !loginRequired) {
    throw new HttpError(400, "static_page_private_auth_required");
  }

  if (row.status === "published" && loginRequired !== (row.login_required === 1)) {
    throw new HttpError(409, "auth_policy_change_requires_redeployment");
  }

  if (row.status === "published") {
    await syncAppsAppAuthClient(env, row, {
      loginRequired,
      visibility: normalizeVisibility(row.visibility, "private")
    });
  }

  await env.APPS_DB
    .prepare("UPDATE apps_apps SET login_required = ?, updated_at = ? WHERE id = ?")
    .bind(loginRequired ? 1 : 0, new Date().toISOString(), appId)
    .run();
  await audit(env.APPS_DB, principal, "updated auth policy", "apps_app", appId, { loginRequired });

  return readApp(env.APPS_DB, env, principal, appId);
}
