import { WORKSPACE_AI_CLI_VERSION } from "./workspaceProductFamily";
import { APPS_RESOURCE_CATALOG } from "./appsResourceCatalog";
import workspaceMailPackage from "../../sdk/mail/package.json";
import workspaceMailGuide from "../../sdk/mail/developer-guide.json";
import {
  APPS_HYPERDRIVE_BINDING_NAME,
  APPS_HYPERDRIVE_PASSWORD_SECRET_NAME,
  APPS_HYPERDRIVE_RESOURCE_TYPE
} from "./appsHyperdrive";
import { appStreamDevelopmentPrompt } from "./appsStreamGuidance";
import type {
  AppsApp,
  AppsAppStatus,
  AppsAppType,
  AppsDeveloperContext,
  AppsDeveloperReadinessState,
  AppsVisibility
} from "./types";

export const APPS_APP_CONTEXT_SCHEMA_VERSION = "workspace.apps.app-context.v2" as const;
export const APPS_DEVELOPER_CONTRACT_VERSION = "apps-dev-v2" as const;
export const WORKSPACE_APP_SESSION_CONTRACT_VERSION = "app-session-v1" as const;

function appTypeLabel(type: AppsAppType) {
  const labels: Record<AppsAppType, string> = {
    agent_app: "Agent app",
    automation: "Automation",
    container: "Advanced",
    static_page: "Static page",
    web: "Web app"
  };
  return labels[type] ?? type;
}

function appStatusLabel(status: AppsAppStatus) {
  const labels: Record<AppsAppStatus, string> = {
    archived: "Archived",
    draft: "Created",
    provisioning: "Provisioning resources",
    published: "Deployed"
  };
  return labels[status] ?? status;
}

function visibilityLabel(value: AppsVisibility) {
  const labels: Record<AppsVisibility, string> = {
    org: "Organization visible",
    private: "Private",
    public: "Public",
    team: "Selected members"
  };
  return labels[value] ?? value;
}

function resourceFriendlyLabel(type: string) {
  const resourceDefinition = APPS_RESOURCE_CATALOG[type as keyof typeof APPS_RESOURCE_CATALOG];
  if (resourceDefinition) {
    return resourceDefinition.label;
  }
  return type.replace(/_/g, " ");
}

function appTablePrefix(app: AppsApp) {
  return `${(app.appCode || app.slug || app.id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_`;
}

function managedAuthSecret(
  app: AppsApp,
  name: "WORKSPACE_APP_SESSION_SECRET" | "WORKSPACE_AUTH_APP_SECRET",
  description: string
) {
  const configured = app.secrets.some((secret) => secret.name === name && secret.status === "configured");
  return {
    creationStage: "after_auth_preflight_before_runtime_deploy" as const,
    description,
    management: "platform" as const,
    manualConfigurationRequired: false as const,
    name,
    status: configured ? "configured" as const : "pending_auto_creation" as const
  };
}

function overallReadiness(build: AppsDeveloperReadinessState, deploy: AppsDeveloperReadinessState): AppsDeveloperReadinessState {
  if (build === "blocked" || deploy === "blocked") return "blocked";
  if (build === "pending" || deploy === "pending") return "pending";
  if (build === "unsafe" || deploy === "unsafe") return "unsafe";
  if (build === "unknown" || deploy === "unknown") return "unknown";
  return "ready";
}

export function buildAppDeveloperContext(app: AppsApp, generatedAt = new Date().toISOString()): AppsDeveloperContext {
  const sdkOrigin = new URL(app.manifest.mcp.platformUrl).origin;
  const hasD1 = Boolean(app.manifest.bindings.d1 || app.resources.some((resource) => resource.type === "d1_database"));
  const hasEmailSending = app.resources.some((resource) => resource.type === "email_sending");
  const hasEmailRouting = app.resources.some((resource) => resource.type === "email_routing");
  const hyperdriveResource = app.resources.find((resource) => resource.type === APPS_HYPERDRIVE_RESOURCE_TYPE);
  const hyperdriveNeedsConfiguration = Boolean(hyperdriveResource && (
    hyperdriveResource.status !== "ready" || !hyperdriveResource.resourceId
  ));
  const runtimeResources = app.resources.filter((resource) => (
    resource.type === "worker" || resource.type === "pages_project" || resource.type === "pages_function"
  ));
  const resourcesFailed = app.resources.filter((resource) => resource.status === "failed");
  const resourcesPending = app.resources.filter((resource) => (
    resource.type !== APPS_HYPERDRIVE_RESOURCE_TYPE
    && resource.status !== "ready"
    && resource.status !== "failed"
  ));
  const resourcesNotReady = [...resourcesFailed, ...resourcesPending];
  const archived = app.status === "archived";
  const provisioning = app.status === "provisioning" || resourcesPending.length > 0;
  const runtimeMissing = runtimeResources.length === 0;
  const buildReadiness: AppsDeveloperReadinessState = archived ? "blocked" : "ready";
  const deployReadiness: AppsDeveloperReadinessState = archived || runtimeMissing || resourcesFailed.length > 0
    ? "blocked"
    : provisioning || hyperdriveNeedsConfiguration ? "pending" : "ready";
  const latest = app.deployments[0];
  const latestReady = app.deployments.find((deployment) => deployment.status === "ready");
  const latestPublished = app.deployments.find((deployment) => deployment.status === "published");
  const rollbackCandidates = app.deployments.filter((deployment) => deployment.status === "superseded");
  const previewReadiness: AppsDeveloperReadinessState = app.deployments.some((deployment) => (
    deployment.status === "ready" || deployment.status === "published"
  )) ? "ready" : "pending";
  const publishReadiness: AppsDeveloperReadinessState = !archived && latestReady ? "ready" : "blocked";
  const rollbackReadiness: AppsDeveloperReadinessState = archived
    ? "blocked"
    : rollbackCandidates.length > 0 ? "unknown" : "blocked";
  const blockers: AppsDeveloperContext["blockers"] = [];

  if (archived) {
    blockers.push({ code: "APP_ARCHIVED", gate: "build", message: "The App is archived and cannot enter a new development or deployment cycle." });
    blockers.push({ code: "APP_ARCHIVED", gate: "deploy", message: "Restore the App before preparing another deployment." });
  }
  if (app.status === "provisioning" && resourcesFailed.length === 0) {
    blockers.push({ code: "APP_PROVISIONING", gate: "deploy", message: "The App resource package is still provisioning." });
  }
  for (const resource of resourcesNotReady) {
    blockers.push({
      code: resource.status === "failed" ? "RESOURCE_PROVISIONING_FAILED" : "RESOURCE_NOT_READY",
      gate: "deploy",
      message: `${resourceFriendlyLabel(resource.type)} is ${resource.status || "not ready"}.`,
      resourceType: resource.type
    });
  }
  if (hyperdriveNeedsConfiguration) {
    blockers.push({
      code: "HYPERDRIVE_CONFIGURATION_REQUIRED",
      gate: "deploy",
      message: `Supply scheme, host, optional port, database, and user through the MCP deployment hyperdrive input after configuring the ${APPS_HYPERDRIVE_PASSWORD_SECRET_NAME} App Secret.`,
      resourceType: APPS_HYPERDRIVE_RESOURCE_TYPE
    });
  }
  if (runtimeMissing) {
    blockers.push({ code: "RUNTIME_RESOURCE_MISSING", gate: "deploy", message: "No Worker or Pages runtime resource is available for this App." });
  }
  if (!latestReady) {
    blockers.push({ code: "READY_DEPLOYMENT_MISSING", gate: "publish", message: "Create and verify a ready deployment before publication." });
  }
  if (rollbackCandidates.length === 0) {
    blockers.push({ code: "ROLLBACK_CANDIDATE_MISSING", gate: "rollback", message: "No superseded APPS deployment is recorded as a rollback candidate." });
  }

  const nextActions: AppsDeveloperContext["nextActions"] = [];
  if (provisioning || resourcesFailed.length > 0) {
    nextActions.push({
      arguments: { action: "status", appId: app.id },
      kind: "tool_call",
      reason: "Inspect resource provisioning state before packaging or deploying; source development may continue against the declared manifest.",
      requiresUserApproval: false,
      tool: "apps_provisioning"
    });
  }
  if (hasEmailSending || hasEmailRouting) nextActions.push({arguments:{action:"mail_sdk",appId:app.id},kind:"tool_call",reason:"Load the official Mail SDK, unified mailbox resources and signed new-mail Trigger implementation guide.",requiresUserApproval:false,tool:"apps_app_read"});
  if (app.loginRequired) {
    nextActions.push({
      arguments: { action: "auth_sdk", appId: app.id },
      kind: "tool_call",
      reason: "Load the versioned official authentication, organization-directory, people-query, and department-authorization implementation material after reading this App context.",
      requiresUserApproval: false,
      tool: "apps_app_read"
    });
  }
  if (!archived) {
    nextActions.push({
      kind: "local_action",
      reason: "Implement against the declared manifest, then run the project build and focused local tests.",
      requiresUserApproval: false
    });
  }
  if (hyperdriveNeedsConfiguration) {
    nextActions.push({
      kind: "local_action",
      reason: `Configure the platform-only ${APPS_HYPERDRIVE_PASSWORD_SECRET_NAME} App Secret, then include hyperdrive={ scheme, host, port?, database, user, originConnectionLimit? } in the first apps_deploy_prepare call. Never put the database password in MCP arguments, source, env vars, or handoff text.`,
      requiresUserApproval: false
    });
  }
  if (app.agentMcpEnabled && !app.manifest.mcp.registered) {
    nextActions.push({
      kind: "local_action",
      reason: "App MCP is configured but the current published deployment is not registered. Include .well-known/workspace-mcp-manifest.json in the next deployment artifact; deployment preflight will validate and snapshot it before publication lists the Auth Resource.",
      requiresUserApproval: false
    });
  }
  if (deployReadiness === "ready") {
    nextActions.push({
      kind: "local_action",
      reason: "Before deploying, compare frontier-workspace version with this workspace release; install the matching local CLI archive when needed, verify the versions match, then validate the deployment package with --dry-run and request approval before creating a ready deployment.",
      requiresUserApproval: false
    });
  }
  if (latestReady) {
    nextActions.push({
      arguments: { action: "publish", appId: app.id, deploymentId: latestReady.id },
      kind: "tool_call",
      reason: "Publish the verified ready deployment only after explicit user approval.",
      requiresUserApproval: true,
      tool: "apps_deployment_release"
    });
  }

  const tablePrefix = appTablePrefix(app);
  return {
    schemaVersion: APPS_APP_CONTEXT_SCHEMA_VERSION,
    contractVersion: APPS_DEVELOPER_CONTRACT_VERSION,
    generatedAt,
    instruction: "Treat apps_app_read(action=get) as the canonical developer context. Use its readiness, guidance, blockers, and nextActions before editing or deploying; call apps_app_read(action=auth_sdk) only when Auth implementation material is required.",
    app: {
      id: app.id,
      appCode: app.appCode,
      slug: app.slug,
      name: app.name,
      type: app.type,
      status: app.status,
      visibility: app.visibility,
      loginRequired: app.loginRequired,
      dataServiceId: app.dataServiceId
    },
    readiness: {
      overall: overallReadiness(buildReadiness, deployReadiness),
      gates: {
        build: buildReadiness,
        deploy: deployReadiness,
        preview: previewReadiness,
        publish: publishReadiness,
        rollback: rollbackReadiness
      },
      sourceAssessment: {
        status: "not_supplied",
        reason: "Workspace MCP cannot inspect local source. Auth/source verification runs against the uploaded deployment artifact before any Cloudflare write."
      }
    },
    auth: {
      ...app.manifest.auth,
      contractVersion: WORKSPACE_APP_SESSION_CONTRACT_VERSION,
      implementationTool: "apps_app_read",
      implementationAction: "auth_sdk",
      migrationAssessment: app.loginRequired ? "source_check_required" : "not_required",
      managedSecrets: app.loginRequired ? [
        managedAuthSecret(app, "WORKSPACE_AUTH_APP_SECRET", "Workspace Auth confidential App client secret"),
        managedAuthSecret(app, "WORKSPACE_APP_SESSION_SECRET", "Workspace App local session signing secret")
      ] : []
    },
    deployment: {
      latest,
      latestPublished,
      latestReady,
      readyCount: app.deployments.filter((deployment) => deployment.status === "ready").length,
      rollbackCandidateCount: rollbackCandidates.length,
      liveConsistency: {
        status: "not_checked",
        reason: "The App context reports APPS records only. A privileged runtime reconciliation check is required before claiming that the live Cloudflare version matches deployment history."
      }
    },
    guidance: {
      implementationContract: [
        "Keep the provisioned App code, domains, resource names, IDs, and bindings unchanged unless the user explicitly asks.",
        "Use verified Workspace identity for server-side authorization and never trust caller-supplied identity headers.",
        "Use the official server-only WorkspaceAuthDirectory client for organization/people data and immutable departmentId/departmentPath values for department authorization.",
        "Do not ask for platform credentials or App secret values."
      ],
      deploymentContract: [
        "Run the project build locally before packaging deployment output.",
        "For Node.js ESM build scripts, convert import.meta.url with fileURLToPath before passing paths to dirname, resolve, or join; never use URL.pathname as a filesystem path because Windows drive-letter paths can be duplicated.",
        "Use one release version source and verify package metadata, runtime APP_VERSION, Wrangler APP_VERSION, and the top release-notes entry agree before deployment.",
        "Keep release notes to one version and at most 4000 characters; use a concise per-release file instead of an entire multi-version changelog.",
        `Before every APPS App deploy, run frontier-workspace version and use the CLI bundled with this workspace release (${WORKSPACE_AI_CLI_VERSION}). Install the matching local archive with npm install -g ./frontier-workspace-cli-${WORKSPACE_AI_CLI_VERSION}.tgz.`,
        "Use frontier-workspace apps deploy for local source/build output; source backup is the default and --skip-source requires an explicit user decision.",
        "Set the target company-account sign-in policy during deployment with --login-required yes|no when the user requests a change; no means public access, while yes defaults a previously public App to Collaborators and Owner only.",
        "Creating a ready deployment and publishing it are separate production writes, and each requires the appropriate explicit approval."
      ],
      dataContract: [
        hasD1
          ? `Use the provisioned D1 binding ${app.manifest.bindings.d1 || "DB"} and App-owned table prefix ${tablePrefix}.`
          : "Do not add persistent storage unless the App resource package enables it.",
        hyperdriveResource
          ? `Use the existing database only through the ${hyperdriveResource.bindingName || APPS_HYPERDRIVE_BINDING_NAME} Hyperdrive binding; do not embed the origin connection string or password in source.`
          : "Do not connect an external database unless the App resource package enables Custom database (Hyperdrive).",
        "Use frontier-workspace apps d1 migrate plan/apply for migration files; do not bypass App-owned validation for normal business data writes.",
        "Keep every migration file under version control. If migrations are generated, make generation explicit and make CI fail on drift instead of silently replacing a committed migration during a normal build."
      ]
    },
    mcpBuild: {
      tablePrefix,
      tools: {
        getApp: "apps_app_read",
        getAuthSdk: "apps_app_read",
        applyD1Migration: "apps_database",
        deployPages: "apps_deploy_prepare",
        deployWorker: "apps_deploy_prepare",
        updateAppConfig: "apps_app_write",
        listDeployments: "apps_deployment_read",
        publishDeployment: "apps_deployment_release",
        rollbackDeployment: "apps_deployment_release",
        setEnvVars: "apps_config",
        declareSecrets: "apps_config",
        listKvKeys: "apps_storage",
        getKvValue: "apps_storage",
        putKvValue: "apps_storage",
        listR2Objects: "apps_storage",
        getR2Object: "apps_storage",
        putR2Object: "apps_storage"
      },
      actions: {
        getApp: "get",
        getAuthSdk: "auth_sdk",
        getMailSdk: "mail_sdk",
        applyD1Migration: "migration_apply",
        deployPages: "pages",
        deployWorker: "worker",
        updateAppConfig: "update_config",
        listDeployments: "list",
        publishDeployment: "publish",
        rollbackDeployment: "rollback",
        setEnvVars: "env_set",
        declareSecrets: "secrets_declare",
        listKvKeys: "kv_list",
        getKvValue: "kv_get",
        putKvValue: "kv_put",
        listR2Objects: "r2_list",
        getR2Object: "r2_get",
        putR2Object: "r2_put"
      }
    },
    stream: {
      enabled: app.resources.some(resource => resource.type === "media"),
      status: !app.resources.some(resource => resource.type === "media") ? "disabled"
        : app.resources.some(resource => resource.type === "media" && resource.provider === "workspace-stream" && resource.status === "ready")
          && app.secrets.some(secret => secret.name === "WORKSPACE_STREAM_TOKEN" && secret.status === "configured") ? "ready" : "provisioning",
      bindingName: "WORKSPACE_STREAM",
      secretName: "WORKSPACE_STREAM_TOKEN",
      developmentPrompt: app.resources.some(resource => resource.type === "media") ? appStreamDevelopmentPrompt(app.id) : undefined,
    },
    runtime: app.manifest.runtime,
    llm: app.manifest.llm,
    mail: {
      enabled: hasEmailSending || hasEmailRouting,
      unified: hasEmailSending && hasEmailRouting,
      status: !hasEmailSending && !hasEmailRouting ? "disabled" : app.resources.some(resource=>(resource.type==="email_sending"||resource.type==="email_routing")&&resource.status==="failed") ? "failed" : app.secrets.some(secret=>secret.name==="WORKSPACE_MAIL_TOKEN"&&secret.status==="configured")&&app.resources.filter(resource=>resource.type==="email_sending"||resource.type==="email_routing").every(resource=>resource.status==="ready") ? "ready" : "provisioning",
      address: app.manifest.email?.routing.address || app.manifest.email?.sending.senderMailbox,
      sdk: {package:workspaceMailPackage.name,version:workspaceMailPackage.version,packageUrl:`${sdkOrigin}/sdk/workspace-mail/v${workspaceMailPackage.version}.tgz`},
      implementationAction: "mail_sdk",
      trigger: {enabled: app.manifest.email?.routing.triggerEnabled === true,path:"/_workspace/mail/received",delivery:"at_least_once"},
      configuration: {tool:"apps_app_write",action:"update_config",fields:["emailEnabled","emailPrefix","emailTriggerEnabled"]},
    },
    emailSending: {
      sdk: {
      package:workspaceMailPackage.name,version:workspaceMailPackage.version,packageUrl:`${sdkOrigin}/sdk/workspace-mail/v${workspaceMailPackage.version}.tgz`,
      legacyNativeEmailSupportedThrough:workspaceMailGuide.legacyNativeEmailSupportedThrough,
      legacyNativeEmailTimeZone:workspaceMailGuide.legacyNativeEmailTimeZone,
      newApplicationPolicy:workspaceMailGuide.newApplicationPolicy,
      developmentPrompt:workspaceMailGuide.developmentPrompt.join("\n")
        .replaceAll("{{SDK_VERSION}}", workspaceMailPackage.version)
        .replaceAll("{{SDK_PACKAGE_URL}}", `${sdkOrigin}/sdk/workspace-mail/v${workspaceMailPackage.version}.tgz`),
      endpointEnv:"WORKSPACE_MAIL_ENDPOINT",tokenSecret:"WORKSPACE_MAIL_TOKEN",
      legacyCompatibilityEnv:"WORKSPACE_MAIL_LEGACY_NATIVE_EMAIL",
      migration:"Replace existing env.EMAIL.send calls with WorkspaceMail, then set WORKSPACE_MAIL_LEGACY_NATIVE_EMAIL=0. Existing published native-mail apps retain that binding until this explicit migration.",
      reads:"mailbox, list, get, getAttachment",writes:"update, send, reply",
      taskPolicy:"Only the Mate Runtime applies Inbox Prompt. Application receipt and SDK reads do not create Tasks."
    },
      enabled: hasEmailSending,
      bindingName: app.manifest.email?.sending.bindingName || "EMAIL",
      credentialPolicy: "Use Workspace Mail SDK with the server-only app-scoped WORKSPACE_MAIL_TOKEN. The platform signing key and provider credentials are never exposed.",
      fromEnv: "WORKSPACE_EMAIL_FROM",
      senderMailbox: app.manifest.email?.sending.senderMailbox,
      usage: hasEmailSending
        ? `const mail = new WorkspaceMail({endpoint:env.WORKSPACE_MAIL_ENDPOINT,token:env.WORKSPACE_MAIL_TOKEN}); await mail.send({to,subject,body:text,idempotencyKey:requestId})`
        : undefined
    },
    emailRouting: {
      address: app.manifest.email?.routing.address,
      enabled: hasEmailRouting,
      inboundAddressEnv: "WORKSPACE_EMAIL_INBOUND_ADDRESS",
      modeEnv: "WORKSPACE_EMAIL_ROUTING_MODE",
      routerWorker: app.manifest.email?.routing.routerWorker,
      routerWorkerEnv: "WORKSPACE_EMAIL_ROUTER_WORKER"
    },
    customDatabase: {
      bindingName: hyperdriveResource?.bindingName || (hyperdriveResource ? APPS_HYPERDRIVE_BINDING_NAME : undefined),
      enabled: Boolean(hyperdriveResource),
      passwordSecretName: APPS_HYPERDRIVE_PASSWORD_SECRET_NAME,
      requiredDeploymentFields: ["scheme", "host", "database", "user"],
      status: !hyperdriveResource ? "disabled" : hyperdriveNeedsConfiguration ? "configuration_required" : "ready",
      supportedSchemes: ["postgres", "postgresql", "mysql"]
    },
    bindings: app.manifest.bindings,
    secrets: app.secrets.map((secret) => ({
      name: secret.name,
      environment: secret.environment,
      status: secret.status,
      required: secret.required,
      description: secret.description
    })),
    resources: app.resources.map((resource) => ({
      label: resourceFriendlyLabel(resource.type),
      type: resource.type,
      provider: resource.provider,
      resourceName: resource.resourceName,
      resourceId: resource.resourceId,
      bindingName: resource.bindingName,
      environment: resource.environment,
      status: resource.status
    })),
    domains: app.domains.map((domain) => ({
      hostname: domain.hostname,
      type: domain.type,
      environment: domain.environment,
      status: domain.status,
      fallbackUrl: domain.fallbackUrl,
      certificateStatus: domain.certificateStatus,
      routeStatus: domain.routeStatus
    })),
    blockers,
    nextActions
  };
}

export function appAgentResourceContext(app: AppsApp) {
  const hasD1 = Boolean(app.manifest.bindings.d1 || app.resources.some((resource) => resource.type === "d1_database"));
  const hasWorker = app.resources.some((resource) => resource.type === "worker");
  const hasPages = app.resources.some((resource) => resource.type === "pages_project" || resource.type === "pages_function");
  const hasStorage = app.resources.some((resource) => resource.type === "r2_bucket" || resource.type === "kv_namespace");
  const hyperdriveResource = app.resources.find((resource) => resource.type === APPS_HYPERDRIVE_RESOURCE_TYPE);
  const hasAgentSchema = app.resources.some((resource) => resource.type === "schema_registry") || app.manifest.mcp.schemaRequired;
  const hasEmailSending = app.resources.some((resource) => resource.type === "email_sending");
  const hasEmailRouting = app.resources.some((resource) => resource.type === "email_routing");
  const hasMedia = app.resources.some((resource) => resource.type === "media");
  const tablePrefix = appTablePrefix(app);
  const context = buildAppDeveloperContext(app);

  return [
    "# Workspace APPS Agent Build Handoff",
    "",
    "This Markdown view is rendered from the same canonical developer context returned by apps_app_read(action=get). Use that context first, then call apps_app_read(action=auth_sdk) only when its nextActions require Auth implementation material.",
    "",
    "## Product Brief",
    `- App name: ${app.name}`,
    `- App code: ${app.appCode || app.slug}`,
    `- App type: ${appTypeLabel(app.type)}`,
    `- Current status: ${appStatusLabel(app.status)}`,
    `- Visibility: ${visibilityLabel(app.visibility)}`,
    `- Login required: ${app.loginRequired ? "yes, use Workspace Auth" : "no"}`,
    `- Description: ${app.description || "No extra product description was provided. Infer the smallest useful workflow from the app name and type."}`,
    "",
    "## Developer Readiness",
    `- Context schema: ${context.schemaVersion}`,
    `- Developer contract: ${context.contractVersion}`,
    `- Generated at: ${context.generatedAt}`,
    `- Overall: ${context.readiness.overall}`,
    `- Gates: build=${context.readiness.gates.build}, deploy=${context.readiness.gates.deploy}, preview=${context.readiness.gates.preview}, publish=${context.readiness.gates.publish}, rollback=${context.readiness.gates.rollback}`,
    `- Local source assessment: ${context.readiness.sourceAssessment.status} — ${context.readiness.sourceAssessment.reason}`,
    ...context.blockers.map((blocker) => `- Blocker ${blocker.code} (${blocker.gate}): ${blocker.message}`),
    "",
    "## Implementation Contract",
    `- Keep the app code \`${app.appCode || app.slug}\`; do not rename domains, resources, bindings, or provisioned IDs.`,
    "- Build the actual usable first screen, not a marketing landing page.",
    "- Work incrementally: implement, document the change, run a check, then continue.",
    "- There is no separate Preview environment in this APPS flow. Use local/build checks while developing, and use the production URL only after the user asks to deploy.",
    "- Treat every listed Cloudflare resource as a real per-app provisioned resource. Do not create replacement D1/KV/R2/Pages/Worker resources unless explicitly asked.",
    "- Do not ask the user for AUTH_SERVICE_TOKEN, LLM gateway tokens, Cloudflare credentials, or app secrets. Platform-managed Auth secrets are created automatically after source preflight and before runtime deployment; their values are never exposed.",
    "- If a custom domain route is still pending, use the fallback runtime URL for smoke testing.",
    "",
    "## Workspace Auth Requirements",
    `- Auth issuer: ${app.manifest.auth.issuer}`,
    `- Browser SSO authorize origin env: \`WORKSPACE_AUTH_AUTHORIZE_ORIGIN=${app.manifest.auth.env.WORKSPACE_AUTH_AUTHORIZE_ORIGIN}\``,
    `- Browser authorize endpoint: ${app.manifest.auth.authorizeEndpoint}`,
    `- Auth origin env: \`WORKSPACE_AUTH_ORIGIN=${app.manifest.auth.env.WORKSPACE_AUTH_ORIGIN}\``,
    `- Client id env: \`WORKSPACE_AUTH_CLIENT_ID=${app.manifest.auth.env.WORKSPACE_AUTH_CLIENT_ID}\``,
    `- Audience/client app id: ${app.manifest.auth.audience}`,
    `- Confidential App client secret: use platform-managed \`${app.manifest.auth.secrets.appClient}\`; it is created automatically after Auth preflight and must never appear in source or browser code.`,
    `- App session signing secret: use the separate platform-managed \`${app.manifest.auth.secrets.appSession}\`; it follows the same automatic lifecycle and the runtime must fail closed if it is missing or weak.`,
    app.loginRequired
      ? "- Require login for user-facing pages and protect any API that reads or writes user data."
      : "- The app is currently configured without mandatory login; still avoid exposing sensitive data publicly.",
    app.loginRequired
      ? `- Mandatory login entry: implement \`${app.manifest.auth.loginStartPath}\` and redirect unauthenticated users there before rendering the app.`
      : "",
    app.loginRequired
      ? "- Construct `WorkspaceBrowserAppSession` with the explicit browser `authorizeOrigin` above and `/auth/v1/authorize`; do not default browser SSO to the server-only issuer origin."
      : "",
    app.loginRequired
      ? `- Workspace callback path: implement \`${app.manifest.auth.callbackPath}\`; exchange the callback code server-side through \`${app.manifest.auth.tokenExchangeEndpoint}\`.`
      : "",
    app.loginRequired
      ? `- App session endpoint: expose \`${app.manifest.auth.sessionEndpoint}\` and return the verified user as \`${app.manifest.auth.user.objectName}\`; if an app-local profile exists, include it as \`${app.manifest.auth.registration.appUserObjectName}\`.`
      : "",
    app.loginRequired
      ? "- App logout must clear the App Session and pending state, then render `/auth/workspace/signed-out` without automatically starting SSO again. Treat global Workspace logout as a separate action."
      : "",
    app.loginRequired
      ? `- Registration policy: no separate signup flow. The first successful Workspace Auth login is the app registration event; create or upsert an app-local \`${app.manifest.auth.registration.appUserObjectName}\` profile from \`${app.manifest.auth.user.objectName}\`.`
      : "",
    app.loginRequired
      ? `- App user persistence: use a table like \`${app.manifest.auth.registration.appUserTableRecommendation}\`; key records by verified user id/email and update profile fields on each successful login.`
      : "",
    app.loginRequired
      ? `- Production login URL: ${app.manifest.auth.loginUrls.production}`
      : "",
    app.loginRequired
      ? `- Fallback production login URL: ${app.manifest.auth.loginUrls.fallbackProduction}`
      : "",
    app.loginRequired
      ? "- Authenticated Apps require an independent App origin. Never create a user session or register an Auth callback under the shared `/run/{app}` origin; that route may only redirect to the canonical App origin."
      : "",
    "- On successful login, use the verified Workspace user identity as the actor for records, audit fields, and ownership.",
    `- User identity naming: the standard verified user object is \`workspaceUser\`; use \`${app.manifest.auth.user.objectName}\` / request context \`${app.manifest.auth.user.requestContextName}\` with claims \`${Object.values(app.manifest.auth.user.claims).join("`, `")}\`.`,
    "- Identity source: create `workspaceUser` only from a successful server-side Workspace Auth one-time-code exchange or from the app's own verified session.",
    "- Never derive user identity or authorization from caller-supplied `x-workspace-*`, `cf-access-*`, name, email, or department text headers.",
    "- Never ask for or expose AUTH_SERVICE_TOKEN; it is deployment-managed and only platform/admin services may use it.",
    "- For organization and people features, use the server-only `WorkspaceAuthDirectory` returned by `apps_app_read(action=auth_sdk)`; never call Auth admin endpoints or expose the App client secret to browser code.",
    "- Department permissions must compare immutable `departmentId` / `departmentPath` from the verified session. Never authorize by department display name, email domain, browser input, or request headers.",
    "- Use `WorkspaceAuthDirectory.checkAccess(workspaceUser.id)` to re-evaluate central App access before privileged or high-impact writes; keep workflow roles explicit in App-owned policy.",
    "",
    app.loginRequired ? "## App User Bootstrap Contract" : "",
    app.loginRequired
      ? `- Treat the Auth callback exchange as the bootstrap point: after \`${app.manifest.auth.user.objectName}\` is verified, upsert \`${app.manifest.auth.registration.appUserObjectName}\` before completing the app session.`
      : "",
    app.loginRequired
      ? `- Session JSON should be stable: return \`{ authenticated: true, ${app.manifest.auth.user.objectName}, ${app.manifest.auth.registration.appUserObjectName} }\` for logged-in users and \`{ authenticated: false }\` for guests.`
      : "",
    app.loginRequired
      ? "- Never let the browser create or edit identity fields such as user id, email, department, tenant id, or object id. Copy them only from Workspace Auth claims."
      : "",
    app.loginRequired && hasD1
      ? `- Recommended D1 table for app-local users: \`${app.manifest.auth.registration.appUserTableRecommendation}\`. Keep it small and use it for app preferences, workflow state, and display metadata.`
      : "",
    app.loginRequired && hasD1 ? "```sql" : "",
    app.loginRequired && hasD1 ? `CREATE TABLE IF NOT EXISTS ${app.manifest.auth.registration.appUserTableRecommendation} (` : "",
    app.loginRequired && hasD1 ? "  user_id TEXT PRIMARY KEY," : "",
    app.loginRequired && hasD1 ? "  email TEXT NOT NULL," : "",
    app.loginRequired && hasD1 ? "  name TEXT NOT NULL DEFAULT ''," : "",
    app.loginRequired && hasD1 ? "  department TEXT NOT NULL DEFAULT ''," : "",
    app.loginRequired && hasD1 ? "  department_id TEXT NOT NULL DEFAULT ''," : "",
    app.loginRequired && hasD1 ? "  identity_provider TEXT NOT NULL DEFAULT ''," : "",
    app.loginRequired && hasD1 ? "  identity_object_id TEXT NOT NULL DEFAULT ''," : "",
    app.loginRequired && hasD1 ? "  first_login_at TEXT NOT NULL DEFAULT (datetime('now'))," : "",
    app.loginRequired && hasD1 ? "  last_login_at TEXT NOT NULL DEFAULT (datetime('now'))," : "",
    app.loginRequired && hasD1 ? "  profile_json TEXT NOT NULL DEFAULT '{}'" : "",
    app.loginRequired && hasD1 ? ");" : "",
    app.loginRequired && hasD1 ? `CREATE INDEX IF NOT EXISTS idx_${app.manifest.auth.registration.appUserTableRecommendation}_email ON ${app.manifest.auth.registration.appUserTableRecommendation}(email);` : "",
    app.loginRequired && hasD1 ? "```" : "",
    app.loginRequired ? "" : "",
    "## Runtime And Resource Guidance",
    `- Production URL: ${app.productionUrl}`,
    `- Fallback production URL: ${app.manifest.runtime.fallbackProductionUrl}`,
    `- Resource naming: use \`apps-${app.appCode || app.slug}-<resource>\`; do not add org or environment names into new resource display names.`,
    "- Use the listed bindings and resources as the single app resource package. Do not create split infrastructure unless the user explicitly asks for a future advanced setup.",
    hasPages ? "- Pages/Functions are available as this app's own Cloudflare Pages project. Deploying this app must not update other apps." : "",
    hasWorker ? "- Worker service is available as this app's own Cloudflare Worker script. Deploying this worker must not update other apps." : "",
    hasD1 ? `- D1 is available as this app's own Cloudflare D1 database through binding \`${app.manifest.bindings.d1 || "DB"}\`: create app-owned tables, migrations, and queries for persistent state.` : "",
    hasD1 ? `- App-owned D1 table prefix for MCP migrations: \`${tablePrefix}\`.` : "",
    hasStorage ? "- Storage/config resources are available as per-app Cloudflare resources: use this app's KV namespace for small config/cache values and this app's R2 bucket for files or generated artifacts." : "",
    hasMedia ? appStreamDevelopmentPrompt(app.id) : "",
    hyperdriveResource ? `- Custom database support is enabled through binding \`${hyperdriveResource.bindingName || APPS_HYPERDRIVE_BINDING_NAME}\`. If its status is not ready, configure the platform-only \`${APPS_HYPERDRIVE_PASSWORD_SECRET_NAME}\` App Secret, then pass \`hyperdrive: { scheme, host, port?, database, user, originConnectionLimit? }\` to the first \`apps_deploy_prepare\` call. Never include the password in this Handoff or MCP arguments.` : "",
    hasEmailSending || hasEmailRouting ? `- The unified app mailbox is \`${app.manifest.email?.routing.address || app.manifest.email?.sending.senderMailbox || "the assigned address returned by MCP"}\`. Call \`apps_app_read({ action: "mail_sdk", appId: "${app.id}" })\` for the current Workspace Mail SDK, checksum, complete development Prompt, bindings, runtime settings, sending, receiving, attachments and signed new-mail Trigger examples. Fetch this material again when upgrading the SDK or changing resources.` : "",
    hasEmailSending || hasEmailRouting ? "- Implement mail on the server with the platform-injected WORKSPACE_MAIL_ENDPOINT, WORKSPACE_MAIL_TOKEN and WORKSPACE_APP_ID. Use mail.send/mail.reply with persistent business idempotency keys; follow all body and attachment pagination fields when reading. Preserve the mailbox and Trigger state returned by MCP." : "",
    hasEmailRouting ? "- Store received mail by default. For new-mail automation, verify the signed /_workspace/mail/received callback, durably persist and deduplicate event.id, then acknowledge it with the SDK. Deploy and test the callback before enabling Trigger; activation does not replay history. App callbacks do not automatically create Mate Tasks." : "",
    hasAgentSchema ? "- Agent Schema is available: if this app exposes callable APIs, maintain a tool/schema manifest alongside the implementation." : "",
    app.manifest.llm.enabled
      ? "- LLM is enabled through the Workspace LLM gateway. Use the configured gateway URL and secret names; never hard-code model API keys."
      : "- LLM is not enabled for this app. Do not add model calls unless the user enables LLM first.",
    "",
    "## MCP Build Loop",
    `- Start with \`apps_app_read({ action: "get", appId: "${app.id}" })\`; it is the canonical resource, guidance, readiness, blocker, and next-action query.`,
    "- In Node.js ESM build scripts, convert `import.meta.url` with `fileURLToPath` before using `dirname`, `resolve`, or `join`; never pass `URL.pathname` to filesystem path APIs because Windows drive letters can be duplicated.",
    "- Use one release version source and verify package metadata, runtime `APP_VERSION`, Wrangler `APP_VERSION`, and the top release-notes entry agree before deployment.",
    "- Keep release notes to one version and at most 4,000 characters. Use a concise per-release file such as `RELEASE_NOTES.md`, not an entire multi-version changelog.",
    `Before every APPS App deploy, run frontier-workspace version and use the CLI bundled with this workspace release (${WORKSPACE_AI_CLI_VERSION}). Install the matching local archive with npm install -g ./frontier-workspace-cli-${WORKSPACE_AI_CLI_VERSION}.tgz.`,
    "- WorkBuddy, Claude Code, Codex, and Cursor use the Workspace CLI stdio bridge for their normal MCP connection. The CLI refreshes the shared credential automatically; rerun `frontier-workspace agent install --agent=<agent>` only to upgrade or repair the Agent configuration.",
    app.loginRequired ? "- Before implementing Auth, call `apps_app_read` with action=`auth_sdk` and this app ID. Install the returned versioned `@frontier-workspace/auth` package and start from its app-specific Worker example; do not guess SDK package names or preflight patterns." : "",
    hasD1 ? "- Keep migration files under version control. If a generator produces them, expose generation as an explicit command and make CI fail on drift instead of silently overwriting a committed migration during a normal build." : "",
    hasD1 ? "- For local migration files, use `frontier-workspace apps d1 migrate plan` and `frontier-workspace apps d1 migrate apply`; migration execution remains server-side." : "",
    hasPages ? "- Build locally, then use `frontier-workspace apps deploy --target pages` so source backup and binary deployment artifacts are preserved before the hosted deployment tool creates a ready deployment." : "",
    hasWorker ? "- Build locally, then use `frontier-workspace apps deploy --target worker` so source backup and binary deployment artifacts are preserved before the hosted deployment tool creates a ready deployment." : "",
    app.resources.some((resource) => resource.type === "kv_namespace")
      ? "- Use `apps_storage` actions `kv_list`, `kv_get`, `kv_put`, and `kv_delete` for app-owned KV maintenance. Do not store platform secrets there."
      : "",
    app.resources.some((resource) => resource.type === "r2_bucket")
      ? "- Use `apps_storage` actions `r2_list`, `r2_get`, `r2_put`, and `r2_delete` for app-owned file/object maintenance. Text and base64 payloads are supported."
      : "",
    "- Use `apps_config(action=env_set)` for non-secret app runtime configuration only. Never pass tokens, API keys, passwords, or secret values through env vars.",
    "- Use `apps_app_write(action=update_config)` for platform capabilities. One app mailbox enables sending and receiving together: configure emailEnabled and emailPrefix, then fetch `apps_app_read(action=mail_sdk)` for current SDK and resource guidance. New mailboxes start with emailTriggerEnabled=false; enable it after the callback is deployed and verified. Preserve existing mailbox and Trigger settings unless the business requirements call for a change.",
    "- Use `apps_config` actions `secrets_declare` / `secrets_status` only for custom app-scoped secrets. Do not declare or configure WORKSPACE_AUTH_APP_SECRET or WORKSPACE_APP_SESSION_SECRET; APPS manages them automatically.",
    "- Do not run local `wrangler` or ask the user for Cloudflare credentials. Use Workspace CLI for local packaging and the hosted Workspace MCP tools for online status, publication, and rollback.",
    "- Use `apps_provisioning(action=status)` after resource creation or retry flows.",
    "- Use `apps_deployment_release(action=publish)` only after the user explicitly approves the production deployment in APPS. Code deployment is handled by the Cloudflare-backed deploy tools.",
    "- If provisioning fails, use `apps_provisioning(action=retry)` once the cause is understood.",
    "",
    "## Data And API Update Contract",
    "- Do not use APPS MCP as a generic database mutation tool.",
    "- Use APPS MCP KV/R2 tools for controlled app resource maintenance, seed files, config, and development handoff data; do not bypass app-owned API validation for normal end-user business workflows.",
    "- For business data changes, implement app-owned API routes or Resource API tools that validate Workspace Auth identity and input server-side.",
    "- If the app should be callable through Workspace MCP, output a Resource API/tool manifest with audience, allowed scopes, base URL, tool names, methods, paths, input schemas, and risk/confirmation requirements.",
    "- Mark write tools as POST and set `readOnly: false` or an explicit risk level. High-risk or write tools must require user confirmation.",
    "",
    "## Suggested Build Plan",
    "1. Restate the product goal from the brief, then inspect the existing app files/resources before editing.",
    "2. Implement the core user workflow end to end: UI, validation, API/server handler, persistence, success/error states, and empty/loading states.",
    "3. Add a minimal data model and migration if D1 is available. For request/intake apps, include requester identity, submitted answers, status, timestamps, and admin notes.",
    "4. Add or update a short developer note/README describing routes, tables, bindings, auth behavior, and MCP deployment steps.",
    "5. Add focused tests or smoke checks for the main happy path and at least one validation/auth failure path.",
    "6. Ensure the latest Workspace CLI is installed, run a local/build verification and `frontier-workspace apps deploy --dry-run`; request explicit approval before creating the ready deployment, then request approval again before `apps_deployment_release(action=publish)`.",
    "7. Report what changed, how to verify it, and any remaining production/publish step.",
    "",
    "## Acceptance Checklist",
    "- After publish, the production route loads without a blank screen or console-breaking errors.",
    "- A first-time logged-in user can complete the primary workflow.",
    "- Server-side handlers validate inputs and never trust client-only identity claims.",
    "- App data is scoped to this app and uses the provided bindings/resources.",
    "- Copy, labels, and forms make sense for the target audience described above.",
    "- The app can be handed back with clear build, verification, and production publish instructions.",
    "",
    "## Local Build And Hosted Deployment",
    `Before every APPS App deploy, run frontier-workspace version and use the CLI bundled with this workspace release (${WORKSPACE_AI_CLI_VERSION}). Install the matching local archive with npm install -g ./frontier-workspace-cli-${WORKSPACE_AI_CLI_VERSION}.tgz.`,
    hasD1 ? `- Plan/apply local migrations with \`frontier-workspace apps d1 migrate plan|apply --app ${app.id} --dir <migration-dir>\`.` : "",
    `- Build the project, validate with \`frontier-workspace apps deploy --app ${app.id} --dry-run ...\`, then request approval before the real deploy.`,
    `- Publish after approval: \`apps_deployment_release({ action: "publish", appId: "${app.id}", deploymentId })\``,
    "- Workspace CLI owns local walking, packaging, hashing, and binary transfer; hosted Workspace MCP owns App state, authorization, publication, and rollback.",
    "",
    "## Machine-Readable Resource Context",
    "```json",
    JSON.stringify(context, null, 2),
    "```"
  ].filter(Boolean).join("\n");
}
