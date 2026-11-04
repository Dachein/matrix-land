import type {
  AppsAppSecret,
  AppsDeployment,
  AppsDomain,
  AppsResource,
  AppsRuntimeManifest
} from "../../../../src/shared/types";
import {
  WORKSPACE_AGENT_INSTALL_COMMANDS,
  WORKSPACE_CLI_INSTALL_COMMAND,
  WORKSPACE_CLI_SERVE_COMMAND,
  WORKSPACE_WORKBUDDY_INSTALL_COMMAND,
  workspaceAppsCliManifest,
  type WorkspaceAppsDeployTarget
} from "../../../../src/shared/workspaceCli.ts";
import { normalizeAppType, normalizeSecretEnvironment, normalizeSecretStatus } from "../core/normalizers";
import type { Env } from "../core/types";
import { normalizeAppCode, readOptionalString } from "../core/utils";
import type { AppsAppEnvVarRow, AppsAppRow, AppsAppSecretRow, AppsDeploymentRow, AppsDomainRow, AppsResourceRow } from "../db/rows";
import { llmGatewayUrl, LLM_APP_SECRET_NAME } from "../llm-gateway/client";
import { authIssuer, fallbackRuntimeUrls, platformMcpUrl, runtimeUrls } from "../runtime/urls";

const EMAIL_FROM_ENV = "WORKSPACE_EMAIL_FROM";
const EMAIL_INBOUND_ADDRESS_ENV = "WORKSPACE_EMAIL_INBOUND_ADDRESS";
const EMAIL_ROUTER_WORKER_ENV = "WORKSPACE_EMAIL_ROUTER_WORKER";
const EMAIL_ROUTING_MODE_ENV = "WORKSPACE_EMAIL_ROUTING_MODE";

export function resourceFromRow(row: AppsResourceRow): AppsResource {
  return {
    id: row.id,
    appId: row.app_id,
    dataServiceId: row.data_service_id,
    type: row.type,
    provider: row.provider,
    resourceName: row.resource_name,
    resourceId: readOptionalString(row.resource_id),
    bindingName: readOptionalString(row.binding_name),
    environment: row.environment,
    status: row.status,
    createdAt: row.created_at
  };
}

export function deploymentFromRow(row: AppsDeploymentRow): AppsDeployment {
  return {
    id: row.id,
    appId: row.app_id,
    deployArtifactId: readOptionalString(row.deploy_artifact_id),
    sourceSnapshotId: readOptionalString(row.source_snapshot_id),
    environment: "production",
    version: row.version,
    versionName: readOptionalString(row.version_name),
    releaseNotes: readOptionalString(row.release_notes),
    status: row.status,
    url: readOptionalString(row.url),
    createdBy: row.created_by,
    createdByName: readOptionalString(row.created_by_name),
    createdAt: row.created_at
  };
}

export function domainFromRow(row: AppsDomainRow): AppsDomain {
  const type = row.type === "custom" ? row.type : "production";

  return {
    id: row.id,
    appId: row.app_id,
    hostname: row.hostname,
    type,
    environment: "production",
    status: row.status,
    provider: readOptionalString(row.provider),
    dnsRecordId: readOptionalString(row.dns_record_id),
    routeId: readOptionalString(row.route_id),
    certificateStatus: readOptionalString(row.certificate_status),
    routeStatus: readOptionalString(row.route_status),
    fallbackUrl: readOptionalString(row.fallback_url),
    lastCheckedAt: readOptionalString(row.last_checked_at),
    errorCode: readOptionalString(row.error_code),
    errorMessage: readOptionalString(row.error_message),
    createdAt: row.created_at
  };
}

export function secretFromRow(row: AppsAppSecretRow): AppsAppSecret {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    environment: normalizeSecretEnvironment(row.environment),
    description: row.description,
    required: row.required !== 0,
    status: normalizeSecretStatus(row.status),
    configuredBy: readOptionalString(row.configured_by),
    configuredAt: readOptionalString(row.configured_at),
    declaredBy: row.declared_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function runtimeManifest(env: Env, row: AppsAppRow, resources: AppsResource[], secrets: AppsAppSecret[], envVars: AppsAppEnvVarRow[] = []): AppsRuntimeManifest {
  const runtime = runtimeUrls(env, appCodeFromRow(row));
  const fallbackRuntime = fallbackRuntimeUrls(env, appCodeFromRow(row));
  const issuer = authIssuer(env);
  const platformUrl = platformMcpUrl(env);
  const auth = runtimeAuthContract(env, row, runtime, fallbackRuntime, issuer);
  const emailSendingResource = resources.find((resource) => resource.type === "email_sending");
  const emailRoutingResource = resources.find((resource) => resource.type === "email_routing");
  const deployTargets = [
    resources.some((resource) => resource.type === "pages_project" || resource.type === "pages_function") ? "pages" : undefined,
    resources.some((resource) => resource.type === "worker") ? "worker" : undefined
  ].filter((target): target is WorkspaceAppsDeployTarget => Boolean(target));
  const runtimeEnvVars = new Map(envVars
    .filter((item) => item.environment === "production" && item.target === "runtime")
    .map((item) => [item.name, item.value]));

  return {
    appId: row.id,
    dataServiceId: row.data_service_id,
    type: normalizeAppType(row.type),
    auth,
    runtime: {
      ...runtime,
      fallbackProductionUrl: fallbackRuntime.productionUrl
    },
    bindings: {
      d1: resourceBinding(resources, "d1_database"),
      hyperdrive: resourceBinding(resources, "hyperdrive_config"),
      r2: resourceBinding(resources, "r2_bucket"),
      kv: resourceBinding(resources, "kv_namespace")
    },
    cli: workspaceAppsCliManifest(row.id, deployTargets),
    mcp: {
      registered: row.agent_mcp_enabled === 1,
      schemaRequired: row.agent_mcp_enabled === 1,
      platformUrl,
      installCommand: WORKSPACE_CLI_INSTALL_COMMAND,
      serveCommand: WORKSPACE_CLI_SERVE_COMMAND,
      agentInstallCommands: WORKSPACE_AGENT_INSTALL_COMMANDS,
      workBuddyInstallCommand: WORKSPACE_WORKBUDDY_INSTALL_COMMAND
    },
    llm: {
      enabled: row.llm_enabled === 1,
      defaultModel: readOptionalString(row.llm_default_model),
      endpoint: readOptionalString(row.llm_endpoint),
      gatewayUrl: llmGatewayUrl(env),
      secretName: row.llm_enabled === 1 ? LLM_APP_SECRET_NAME : undefined
    },
    email: {
      sending: {
        bindingName: emailSendingResource?.bindingName,
        enabled: Boolean(emailSendingResource),
        fromEnv: EMAIL_FROM_ENV,
        senderMailbox: readOptionalString(runtimeEnvVars.get(EMAIL_FROM_ENV))
      },
      routing: {
        address: emailRoutingResource?.resourceName,
        enabled: Boolean(emailRoutingResource),
        triggerEnabled: Boolean(emailRoutingResource) && envVars.some(item => item.name === "WORKSPACE_MAIL_TRIGGER_ENABLED" && item.value === "1"),
        handler: "email",
        mode: "process",
        routerWorker: readOptionalString(env.WORKSPACE_EMAIL_ROUTER_WORKER) ?? "",
        env: {
          WORKSPACE_EMAIL_INBOUND_ADDRESS: EMAIL_INBOUND_ADDRESS_ENV,
          WORKSPACE_EMAIL_ROUTER_WORKER: EMAIL_ROUTER_WORKER_ENV,
          WORKSPACE_EMAIL_ROUTING_MODE: EMAIL_ROUTING_MODE_ENV
        }
      }
    },
    secrets: secrets.map((secret) => ({
      configured: secret.status === "configured",
      description: secret.description,
      environment: secret.environment,
      name: secret.name,
      required: secret.required
    }))
  };
}

function runtimeAuthContract(
  env: Env,
  row: AppsAppRow,
  runtime: ReturnType<typeof runtimeUrls>,
  fallbackRuntime: ReturnType<typeof fallbackRuntimeUrls>,
  issuer: string
): AppsRuntimeManifest["auth"] {
  const origin = issuer.replace(/\/$/, "");
  const publicOrigin = (env.AUTH_PUBLIC_URL || origin).replace(/\/$/, "");
  const callbackPath = "/auth/workspace/callback";
  const loginStartPath = "/auth/workspace/start";
  const sessionEndpoint = "/api/auth/session";
  const logoutEndpoint = "/auth/workspace/logout";
  const fallbackAuthRuntime = row.login_required === 1 ? runtime : fallbackRuntime;
  const callbackUrls = {
    production: runtime.productionUrl ? `${runtime.productionUrl}${callbackPath}` : "",
    fallbackProduction: fallbackAuthRuntime.productionUrl ? `${fallbackAuthRuntime.productionUrl}${callbackPath}` : ""
  };
  const loginUrls = {
    production: runtime.productionUrl ? `${runtime.productionUrl}${loginStartPath}` : "",
    fallbackProduction: fallbackAuthRuntime.productionUrl ? `${fallbackAuthRuntime.productionUrl}${loginStartPath}` : ""
  };

  return {
    issuer: origin,
    origin,
    publicOrigin,
    clientId: row.id,
    audience: row.id,
    required: row.login_required === 1,
    registration: {
      strategy: "first_login",
      separateSignup: false,
      appUserObjectName: "appUser",
      appUserTableRecommendation: "app_users",
      profileUpsert: true
    },
    loginStartPath,
    callbackPath,
    sessionEndpoint,
    logoutEndpoint,
    authorizeEndpoint: `${publicOrigin}/auth/v1/authorize`,
    tokenExchangeEndpoint: `${origin}/v1/app-login/exchange`,
    secrets: {
      appClient: "WORKSPACE_AUTH_APP_SECRET",
      appSession: "WORKSPACE_APP_SESSION_SECRET"
    },
    callbackUrls,
    loginUrls,
    env: {
      WORKSPACE_AUTH_AUTHORIZE_ORIGIN: publicOrigin,
      WORKSPACE_AUTH_ORIGIN: origin,
      WORKSPACE_AUTH_CLIENT_ID: row.id,
      WORKSPACE_AUTH_AUDIENCE: row.id,
      WORKSPACE_AUTH_CALLBACK_PATH: callbackPath,
      WORKSPACE_AUTH_SESSION_ENDPOINT: sessionEndpoint,
      WORKSPACE_AUTH_FALLBACK_PRODUCTION_URL: fallbackRuntime.productionUrl
    },
    user: {
      objectName: "workspaceUser",
      requestContextName: "workspaceUser",
      source: "verified_app_session",
      claims: {
        id: "id",
        email: "email",
        name: "name",
        department: "department",
        departmentId: "departmentId",
        departmentPath: "departmentPath",
        identityProvider: "identity.provider",
        tenantId: "identity.tenantId",
        objectId: "identity.objectId",
        principalName: "identity.principalName"
      }
    }
  };
}

function resourceBinding(resources: AppsResource[], type: string) {
  return resources.find((resource) => resource.type === type)?.bindingName;
}

function appCodeFromRow(row: AppsAppRow) {
  return normalizeAppCode(row.code) || normalizeAppCode(row.slug);
}
