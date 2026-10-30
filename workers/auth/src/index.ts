import { instanceOwnership, claimInstanceOwnership, transferInstanceOwnership } from "./login/ownership.ts";
import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { handleAppsOwnershipRequest } from './apps/ownership.ts';
import { withDefaultAgent } from "./identity/defaultAgent.ts";
import { handleRemoteMcpRequest } from './remoteMcp/routes.ts';
import {
  auditDecision,
  authorizeFromApp,
  createDirectJump,
  evaluateDecision,
  exchangeAppLaunchCode,
  inspectAppAccessResult,
  verifyDirectJump
} from "./apps/authorization.ts";
import { authPublicUrl, configuredMcpIdleTtlSeconds, issuer, mcpOAuthAccessTokenTtlSeconds } from "./configuration.ts";
import { directoryPerson, eligibleAppDirectoryPeople, requireDirectoryApp } from "./directory/access.ts";
import { normalizeUser, readUserSnapshotInputFromBody, requireAuthoritativeSessionUser, resolveUserFromHeaders } from "./identity/users.ts";
import { completeEmailOtpLogin, requestEmailOtpLogin } from "./login/email.ts";
import { completeEntraLogin, startEntraLogin } from "./login/entra.ts";
import { finishConfirmedLogin, finishLogout, readAuthSession } from "./login/session.ts";
import { authorizeMcpOAuthClient } from "./mcp/authorization.ts";
import { mcpOAuthAuthorizationServerMetadata, registerMcpOAuthPublicClient } from "./mcp/clientRegistration.ts";
import {
  getMcpConnectionStatus,
  introspectMcpToken,
  normalizeAdminMcpConnectionStatus,
  revokeMcpConnectionRequest
} from "./mcp/connections.ts";
import { createMcpDeviceAuthorization, isMcpDeviceFlowPath, mcpDeviceFlowRetired, verifyMcpDeviceAuthorization } from "./mcp/device.ts";
import { exchangeMcpOAuthToken } from "./mcp/tokens.ts";
import { sendPortalNotificationEmail } from "./notifications/email.ts";
import { introspectResourceToken, mintResourceToken, requireResourceIntrospectionAccess } from "./resources/tokens.ts";
import { readLimit, readOptionalString, readRecord, readString, readStringList, requireText } from "./values.ts";
export { mcpOAuthConsentPage } from "./mcp/authorization.ts";
import {
  requireServiceToken,
  requireMokaSyncToken,
  requireAppRegistrationToken,
  requireResourceRegistrationToken,
  requireResourceMintToken,
  requireMateRuntimeAuthToken,
  requireMcpIntrospectionToken,
  safeEqual
} from "./serviceAuthorization.ts";
import { bearerToken, corsPreflightResponse, errorResponse, json, readJson, withCorsResponse } from "./http.ts";
import { deliverUserInvitations, queueUserInvitation } from "./invitationEmail.ts";

import { evaluateAppAccess, resolveAppSystemRoles } from "./policy.ts";
import { disableAdminMcpConnection, listAdminMcpConnections } from "./repositories/mcp/connections.ts";
import { ensureMcpClient } from "./repositories/mcp/clients.ts";
import { listAuthDepartments, upsertAuthDepartment } from "./repositories/departments.ts";
import { listAuthUsers, readEmailOtpAuthUser } from "./repositories/users/reads.ts";
import { listAppUsers, registerAppClient } from "./repositories/apps.ts";
import { readGrantStatus, updateGrantStatus, upsertGrant } from "./repositories/grants.ts";
import { recordAuditEvent } from "./repositories/audit.ts";
import { registerResourceClient } from "./repositories/resources.ts";
import { resolveAuthoritativeAuthUserSnapshot } from "./repositories/users/login.ts";
import { updateAuthUserRole, upsertAuthUserSnapshot } from "./repositories/users/writes.ts";

import {
  createMiniappLoginTicket,
  exchangeMiniappLoginTicket,
  prepareMiniappLoginTicket,
  readMiniappLoginTicketStatus
} from "./miniappAuth.ts";
import { HttpError, type Env, type McpAgentType, type MokaDirectoryEvent } from "./types.ts";
import {
  normalizeEmailDomains,
  readAuthEmailPolicy,
  updateAuthEmailPolicy,
  type AuthEmailPolicyMode
} from "../../../src/shared/authEmailPolicy.ts";
import {
  listMokaEmployeeSyncExclusions,
  listMokaValidationExemptions,
  processMokaDirectoryEvent,
  runScheduledMokaDirectorySync,
  setMokaEmployeeSyncExclusion,
  setMokaValidationExemption,
  syncMokaDepartments,
  syncMokaEmployees
} from "./mokaSync.ts";

type MiniappScanExchangeBody = { ticket?: string };

const authWorker = {
  async fetch(
    request: Request,
    env: Env,
    executionContext?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    const requestId = request.headers.get("Idempotency-Key") ?? request.headers.get("x-request-id") ?? crypto.randomUUID();

    if (request.method === "OPTIONS") {
      return corsPreflightResponse(request, env);
    }

    try {
      const url = new URL(request.url);
      const isRead = request.method === "GET" || request.method === "HEAD";


      const remoteMcpResponse = await handleRemoteMcpRequest(request, env, requestId);
      if (remoteMcpResponse) return withCorsResponse(remoteMcpResponse, request, env);

      if (isRead && url.pathname === "/health") {
        return json({ ok: true, service: "workspace-auth-worker", requestId });
      }

      if (isRead && url.pathname === "/.well-known/workspace-auth") {
        return json({
          issuer: issuer(env),
          jwksUri: `${issuer(env)}/jwks.json`,
          authPublicUrl: authPublicUrl(env),
          loginEndpoint: `${authPublicUrl(env)}/auth/login`,
          emailLoginEndpoint: `${authPublicUrl(env)}/auth/email/login`,
          sessionEndpoint: `${authPublicUrl(env)}/auth/session`,
          logoutEndpoint: `${authPublicUrl(env)}/auth/logout`,
          directJumpEndpoint: `${issuer(env)}/v1/app-login/direct-jump`,
          exchangeEndpoint: `${issuer(env)}/v1/app-login/exchange`,
          directoryDepartmentsEndpoint: `${issuer(env)}/v1/app-directory/departments`,
          directoryPeopleEndpoint: `${issuer(env)}/v1/app-directory/people`,
          directoryAccessCheckEndpoint: `${issuer(env)}/v1/app-directory/access/check`,
          verifyEndpoint: `${issuer(env)}/v1/app-login/verify`,
          mcpTokenIntrospectionEndpoint: `${issuer(env)}/v1/mcp/tokens/introspect`,
          mcpOAuthAccessTokenTtlSeconds: mcpOAuthAccessTokenTtlSeconds(env),
          mcpIdleTtlSeconds: configuredMcpIdleTtlSeconds(env),
          mcpCredentialMode: "oauth_refresh_rotation",
          mcpTokenValidation: "local_jwt",
          appRegistrationEndpoint: `${issuer(env)}/v1/admin/apps`
        });
      }

      if (isRead && (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")) {
        return json(mcpOAuthAuthorizationServerMetadata(env));
      }

      if (isRead && url.pathname === "/jwks.json") {
        return json({ keys: [] });
      }

      if (isRead && url.pathname === "/v1/session") {
        requireServiceToken(request, env);
        return json({ user: await withDefaultAgent(env, resolveUserFromHeaders(request)), requestId }, { headers: { "Cache-Control": "private, no-store" } });
      }

      if (request.method === "POST" && url.pathname === "/v1/notifications/email") {
        const appsToken = env.APPS_AUTH_SERVICE_TOKEN?.trim();
        if (!appsToken || !safeEqual(bearerToken(request), appsToken)) {
          requireServiceToken(request, env);
        }
        return await sendPortalNotificationEmail(request, env, requestId);
      }

      if (isRead && url.pathname === "/auth/setup/ownership") return await instanceOwnership(request, env);
      if (request.method === "POST" && url.pathname === "/auth/setup/claim") return await claimInstanceOwnership(request, env);
      if (request.method === "POST" && url.pathname === "/auth/setup/transfer") return await transferInstanceOwnership(request, env);

      if (isRead && url.pathname === "/auth/session") {
        return json(await readAuthSession(request, env, requestId));
      }

      if (request.method === "POST" && url.pathname === "/auth/miniapp/login-tickets") {
        const user = await requireAuthoritativeSessionUser(request, env);
        return json(await createMiniappLoginTicket(env, user), { headers: { "Cache-Control": "no-store" } });
      }

      const miniappLoginStatus = isRead
        ? url.pathname.match(/^\/auth\/miniapp\/login-tickets\/([^/]+)\/status$/)
        : undefined;
      if (miniappLoginStatus?.[1]) {
        const user = await requireAuthoritativeSessionUser(request, env);
        return json(await readMiniappLoginTicketStatus(env, user.id, decodeURIComponent(miniappLoginStatus[1])));
      }

      if (request.method === "POST" && url.pathname === "/auth/miniapp/scan/prepare") {
        const prepared = await prepareMiniappLoginTicket(env, (await readJson<MiniappScanExchangeBody>(request)).ticket);
        const user = await resolveAuthoritativeAuthUserSnapshot(env, { id: prepared.userId });
        if (!user || user.status !== "active") throw new HttpError(403, "auth_user_inactive");
        return json({ expiresAt: prepared.expiresAt, user: { email: user.email ?? "", name: user.name ?? "Workspace 用户" } }, {
          headers: { "Cache-Control": "no-store" }
        });
      }

      if (request.method === "POST" && url.pathname === "/auth/miniapp/scan/exchange") {
        const exchanged = await exchangeMiniappLoginTicket(env, (await readJson<MiniappScanExchangeBody>(request)).ticket);
        const sessionUser = await resolveAuthoritativeAuthUserSnapshot(env, { id: exchanged.userId });
        if (!sessionUser || sessionUser.status !== "active") throw new HttpError(403, "auth_user_inactive");
        return finishConfirmedLogin(request, env, {
          authenticationMethod: "miniapp_scan",
          authenticationSubject: `miniapp-scan:${exchanged.ticketHash}`,
          identity: {
            avatarUrl: "",
            objectId: sessionUser.providerSubject ?? sessionUser.id,
            principalName: sessionUser.email ?? "",
            provider: sessionUser.identityProvider ?? "generic_oidc",
            tenantId: sessionUser.identityProvider === "microsoft_entra_id"
              ? env.ENTRA_TENANT_ID ?? ""
              : env.WORKSPACE_ORG_ID ?? missingConfiguration("WORKSPACE_ORG_ID")
          },
          requestId,
          responseMode: "json",
          runtimeUser: sessionUser,
          sessionUser
        });
      }

      if (isRead && url.pathname === "/auth/access/result") {
        return await inspectAppAccessResult(env, url);
      }

      if (isRead && url.pathname === "/auth/entra/start") {
        return await startEntraLogin(request, env);
      }

      if (request.method === "POST" && url.pathname === "/auth/email/login") {
        return await requestEmailOtpLogin(request, env, requestId);
      }

      if (request.method === "POST" && url.pathname === "/auth/email/login/verify") {
        return await completeEmailOtpLogin(request, env, requestId);
      }

      if (isRead && url.pathname === "/auth/entra/callback") {
        return await completeEntraLogin(request, env, requestId);
      }


      if (isRead && url.pathname === "/auth/logout") {
        return finishLogout(request);
      }

      if (isRead && (url.pathname === "/v1/authorize" || url.pathname === "/auth/v1/authorize")) {
        return await authorizeFromApp(request, env, url, requestId);
      }

      if (request.method === "POST" && url.pathname === "/v1/decisions/evaluate") {
        return await evaluateDecision(request, env, requestId);
      }

      if (request.method === "POST" && url.pathname === "/v1/app-login/direct-jump") {
        return await createDirectJump(request, env, requestId);
      }

      if (request.method === "POST" && url.pathname === "/v1/app-login/verify") {
        return await verifyDirectJump(request, env, requestId);
      }

      if (request.method === "POST" && url.pathname === "/v1/app-login/exchange") {
        return await exchangeAppLaunchCode(request, env, requestId);
      }

      if (request.method === "POST" && url.pathname === "/v1/mcp/oauth/device_authorization") {
        return await createMcpDeviceAuthorization(request, env, requestId);
      }

      if ((isRead || request.method === "POST") && url.pathname === "/auth/mcp/device/verify") {
        return await verifyMcpDeviceAuthorization(request, env, requestId);
      }

      if (isMcpDeviceFlowPath(url.pathname)) {
        return mcpDeviceFlowRetired(env, requestId);
      }

      if (request.method === "POST" && (url.pathname === "/v1/mcp/oauth/register" || url.pathname === "/auth/mcp/oauth/register")) {
        return await registerMcpOAuthPublicClient(request, env, requestId);
      }

      if ((isRead || request.method === "POST") && (url.pathname === "/v1/mcp/oauth/authorize" || url.pathname === "/auth/mcp/oauth/authorize")) {
        return await authorizeMcpOAuthClient(request, env, requestId);
      }

      if (request.method === "POST" && (url.pathname === "/v1/mcp/oauth/token" || url.pathname === "/auth/mcp/oauth/token")) {
        return await exchangeMcpOAuthToken(request, env, requestId);
      }

      if (request.method === "POST" && (url.pathname === "/v1/mcp/tokens/introspect" || url.pathname === "/auth/mcp/tokens/introspect" || url.pathname === "/auth/v1/mcp/tokens/introspect")) {
        requireMcpIntrospectionToken(request, env);
        return await introspectMcpToken(request, env, requestId);
      }

      if (request.method === "POST" && url.pathname === "/v1/resource-tokens/mint") {
        const mintAuth = requireResourceMintToken(request, env);
        return await mintResourceToken(request, env, requestId, mintAuth);
      }

      if (request.method === "POST" && url.pathname === "/v1/internal/mate/email-principal") {
        requireMateRuntimeAuthToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const email = readString(body.email).trim().toLowerCase();
        const user = email ? await readEmailOtpAuthUser(env, email) : undefined;
        if (!user || user.status !== "active") throw new HttpError(403, "email_sender_not_active_workspace_user");
        return json({
          orgId: env.WORKSPACE_ORG_ID || env.ENTRA_TENANT_ID,
          user: normalizeUser(user),
          requestId
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/internal/mate/user-principal") {
        requireMateRuntimeAuthToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const userId = readString(body.userId).trim();
        if (!userId) throw new HttpError(400, "mate_user_id_required");
        const user = await resolveAuthoritativeAuthUserSnapshot(env, { id: userId });
        if (user.status !== "active") throw new HttpError(403, "mate_user_not_active");
        return json({
          orgId: env.WORKSPACE_ORG_ID || env.ENTRA_TENANT_ID,
          user: normalizeUser(user),
          requestId
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/tokens/introspect") {
        const appId = await requireResourceIntrospectionAccess(request, env);
        return await introspectResourceToken(request, env, requestId, appId);
      }

      if (request.method === "POST" && (url.pathname === "/v1/mcp/connections/status" || url.pathname === "/auth/mcp/connections/status" || url.pathname === "/auth/v1/mcp/connections/status")) {
        return await getMcpConnectionStatus(request, env, requestId);
      }

      if (request.method === "POST" && (url.pathname === "/v1/mcp/connections/revoke" || url.pathname === "/auth/mcp/connections/revoke" || url.pathname === "/auth/v1/mcp/connections/revoke")) {
        return await revokeMcpConnectionRequest(request, env, requestId);
      }

      if (request.method === "POST" && url.pathname === "/v1/audit/events") {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const audit = await recordAuditEvent(env, {
          action: readString(body.action) || "custom",
          actorUserId: readOptionalString(body.actorUserId),
          clientAppId: readOptionalString(body.clientAppId),
          decision: body.decision === "allow" || body.decision === "deny" ? body.decision : undefined,
          metadata: readRecord(body.metadata),
          reason: readOptionalString(body.reason),
          requestId,
          resourceId: readOptionalString(body.resourceId),
          resourceType: readOptionalString(body.resourceType)
        });
        return json({ id: audit.id, audit, requestId }, { status: 201 });
      }

      if (isRead && url.pathname === "/v1/app-directory/departments") {
        const app = await requireDirectoryApp(request, env);
        const limit = readLimit(url.searchParams.get("limit"), 500);
        const query = readOptionalString(url.searchParams.get("q"))?.toLocaleLowerCase();
        const people = await eligibleAppDirectoryPeople(env, app, { limit: 1000 });
        const visibleDepartmentIds = new Set<string>(people.flatMap((person) => [
          person.departmentId,
          ...(person.departmentPath ?? [])
        ]).filter((departmentId): departmentId is string => Boolean(departmentId)));
        if (app.directoryReadScope !== "company") {
          for (const target of app.accessTargets ?? []) {
            if (target.toLowerCase().startsWith("department:")) {
              visibleDepartmentIds.add(target.slice("department:".length));
            }
          }
        }
        const allDepartments = await listAuthDepartments(env, {
          limit: 1000,
          statuses: ["active"]
        });
        const departmentsById = new Map(allDepartments.map((department) => [department.id, department]));
        for (const departmentId of [...visibleDepartmentIds]) {
          let parentId = departmentsById.get(departmentId)?.parentId;
          while (parentId && !visibleDepartmentIds.has(parentId)) {
            visibleDepartmentIds.add(parentId);
            parentId = departmentsById.get(parentId)?.parentId;
          }
        }
        const matchingDepartments = allDepartments.filter((department) => (
          (app.directoryReadScope === "company" || visibleDepartmentIds.has(department.id))
          && (!query || department.name.toLocaleLowerCase().includes(query) || department.externalId?.toLocaleLowerCase().includes(query))
        ));
        return json({
          appId: app.id,
          count: Math.min(matchingDepartments.length, limit),
          directoryReadScope: app.directoryReadScope ?? "app",
          departments: matchingDepartments.slice(0, limit),
          hasMore: matchingDepartments.length > limit,
          policyFiltered: app.directoryReadScope !== "company",
          requestId
        }, { headers: { "Cache-Control": "private, no-store" } });
      }

      if (isRead && url.pathname === "/v1/app-directory/people") {
        const app = await requireDirectoryApp(request, env);
        const limit = readLimit(url.searchParams.get("limit"), 100);
        const people = await eligibleAppDirectoryPeople(env, app, {
          departmentId: readOptionalString(url.searchParams.get("departmentId")),
          includeDescendants: url.searchParams.get("includeDescendants") !== "false",
          limit: 1000,
          q: readOptionalString(url.searchParams.get("q"))
        });
        return json({
          appId: app.id,
          count: Math.min(people.length, limit),
          directoryReadScope: app.directoryReadScope ?? "app",
          hasMore: people.length > limit || people.length === 1000,
          people: people.slice(0, limit).map(directoryPerson),
          policyFiltered: app.directoryReadScope !== "company",
          requestId
        }, { headers: { "Cache-Control": "private, no-store" } });
      }

      const directoryPersonMatch = url.pathname.match(/^\/v1\/app-directory\/people\/([^/]+)$/);
      if (isRead && directoryPersonMatch) {
        const app = await requireDirectoryApp(request, env);
        const userId = requireText(decodeURIComponent(directoryPersonMatch[1]), "missing_user_id", 180);
        const user = await resolveAuthoritativeAuthUserSnapshot(env, { id: userId });
        if (user.status !== "active") {
          throw new HttpError(404, "directory_person_not_found");
        }
        if (app.directoryReadScope !== "company") {
          const access = evaluateAppAccess({
            action: "launch",
            app,
            grantStatus: app.accessMode === "request" ? await readGrantStatus(env, app.id, user.id) : undefined,
            user
          });
          if (access.decision !== "allow") {
            throw new HttpError(404, "directory_person_not_found");
          }
        }
        return json({
          appId: app.id,
          directoryReadScope: app.directoryReadScope ?? "app",
          person: directoryPerson(user),
          policyFiltered: app.directoryReadScope !== "company",
          requestId
        }, { headers: { "Cache-Control": "private, no-store" } });
      }

      if (request.method === "POST" && url.pathname === "/v1/app-directory/access/check") {
        const app = await requireDirectoryApp(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const userId = requireText(body.userId ?? body.user_id, "missing_user_id", 180);
        const user = await resolveAuthoritativeAuthUserSnapshot(env, { id: userId });
        const access = evaluateAppAccess({
          action: "launch",
          app,
          grantStatus: app.accessMode === "request" ? await readGrantStatus(env, app.id, user.id) : undefined,
          requestId,
          user
        });
        const systemRoles = resolveAppSystemRoles(app, user);
        await auditDecision(env, access, user, requestId);
        return json({
          allowed: access.decision === "allow",
          appId: app.id,
          decision: access.decision,
          policyVersion: access.policyVersion,
          reason: access.reason,
          requestId,
          systemRolePolicyVersion: app.systemRolePolicyVersion,
          systemRoles,
          user: directoryPerson(user)
        }, { headers: { "Cache-Control": "private, no-store" } });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/apps") {
        requireAppRegistrationToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const app = await registerAppClient(env, body);
        return json({ app, requestId }, { status: 201 });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/departments") {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const department = await upsertAuthDepartment(env, {
          externalId: readOptionalString(body.externalId ?? body.external_id),
          id: readOptionalString(body.id),
          name: readOptionalString(body.name),
          parentId: readOptionalString(body.parentId ?? body.parent_id),
          path: body.path,
          source: readOptionalString(body.source),
          status: readOptionalString(body.status)
        });
        return json({ department, requestId }, { status: 201 });
      }

      if (isRead && url.pathname === "/v1/admin/login-email-policy") {
        requireServiceToken(request, env);
        const policy = await readAuthEmailPolicy(env.AUTH_DB);
        return json({ policy, requestId }, { headers: { "Cache-Control": "no-store" } });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/login-email-policy") {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const mode = body.mode;
        if (mode !== "open" && mode !== "company_email_only") throw new HttpError(400, "invalid_login_email_policy_mode");
        if (!Array.isArray(body.allowedDomains) || body.allowedDomains.length > 100) {
          throw new HttpError(400, "invalid_login_email_policy_domains");
        }
        const rawDomains = body.allowedDomains.map((item) => String(item ?? "").trim()).filter(Boolean);
        const allowedDomains = normalizeEmailDomains(rawDomains);
        if (allowedDomains.length !== rawDomains.length) throw new HttpError(400, "invalid_login_email_policy_domains");
        if (mode === "company_email_only" && allowedDomains.length === 0) {
          throw new HttpError(400, "login_email_policy_domains_required");
        }
        const updatedByUserId = requireText(body.updatedByUserId, "missing_updated_by_user_id", 180);
        const policy = await updateAuthEmailPolicy(env.AUTH_DB, {
          allowedDomains,
          mode: mode as AuthEmailPolicyMode,
          updatedByUserId
        });
        await recordAuditEvent(env, {
          action: "auth_login_email_policy_updated",
          actorUserId: updatedByUserId,
          requestId,
          resourceType: "auth_login_email_policy",
          resourceId: "1",
          metadata: { allowedDomains: policy.allowedDomains, mode: policy.mode }
        });
        return json({ policy, requestId }, { headers: { "Cache-Control": "no-store" } });
      }

      if (isRead && url.pathname === "/v1/admin/departments") {
        requireServiceToken(request, env);
        const departments = await listAuthDepartments(env, { limit: 1000, statuses: ["active"] });
        return json({ departments, requestId }, { headers: { "Cache-Control": "private, no-store" } });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/users/invitations") {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        if (!Array.isArray(body.userIds) || body.userIds.length < 1 || body.userIds.length > 50 || body.userIds.some(id => typeof id !== "string" || !id.trim() || id.length > 180)) {
          throw new HttpError(400, "invalid_invitation_user_ids");
        }
        const userIds = [...new Set(body.userIds as string[])];
        for (const id of userIds) await queueUserInvitation(env, id);
        return json({ invitations: await deliverUserInvitations(env, userIds), requestId }, { headers: { "Cache-Control": "no-store" } });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/directory/moka/sync") {
        requireMokaSyncToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const scope = readOptionalString(body.scope) ?? "directory";
        if (!new Set(["departments", "employees", "directory"]).has(scope)) {
          throw new HttpError(400, "invalid_moka_sync_scope");
        }
        const departments = scope === "employees" ? undefined : await syncMokaDepartments(env, "manual");
        const employees = scope === "departments" ? undefined : await syncMokaEmployees(env, "manual");
        return json({ departments, employees, requestId, scope });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/directory/moka/validation-exemptions") {
        requireMokaSyncToken(request, env);
        return json({ exemptions: await listMokaValidationExemptions(env), requestId });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/directory/moka/validation-exemptions") {
        requireMokaSyncToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        if (typeof body.skipValidation !== "boolean") throw new HttpError(400, "invalid_moka_validation_skip_option");
        const exemption = await setMokaValidationExemption(env, {
          email: requireText(body.email, "missing_email", 320),
          reason: requireText(body.reason, "missing_reason", 500),
          skipValidation: body.skipValidation
        });
        return json({ exemption, requestId });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/directory/moka/sync-exclusions") {
        requireMokaSyncToken(request, env);
        return json({ exclusions: await listMokaEmployeeSyncExclusions(env), requestId });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/directory/moka/sync-exclusions") {
        requireMokaSyncToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        if (typeof body.excluded !== "boolean") throw new HttpError(400, "invalid_moka_sync_exclusion_option");
        const exclusion = await setMokaEmployeeSyncExclusion(env, {
          email: readOptionalString(body.email),
          employeeId: requireText(body.employeeId ?? body.externalId, "missing_moka_employee_id", 120),
          excluded: body.excluded,
          name: readOptionalString(body.name),
          reason: requireText(body.reason, "missing_reason", 500)
        });
        return json({ exclusion, requestId });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/users") {
        requireServiceToken(request, env);
        const users = await listAuthUsers(env, {
          limit: Number(url.searchParams.get("limit") || 500),
          q: readOptionalString(url.searchParams.get("q")),
          statuses: url.searchParams.getAll("status")
        });
        return json({ requestId, users });
      }

      const appsOwnershipResponse = await handleAppsOwnershipRequest(request, env, requestId);
      if (appsOwnershipResponse) return appsOwnershipResponse;

      if (request.method === "POST" && url.pathname === "/v1/admin/users") {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const user = await upsertAuthUserSnapshot(env, readUserSnapshotInputFromBody(body));
        return json({ requestId, user }, { status: 201 });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/users/batch") {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const rows = Array.isArray(body.users) ? body.users : [];
        const users = [];

        for (const row of rows.slice(0, 1000)) {
          if (!row || typeof row !== "object" || Array.isArray(row)) {
            continue;
          }

          users.push(await upsertAuthUserSnapshot(env, readUserSnapshotInputFromBody(row as Record<string, unknown>, "invited")));
        }

        return json({ count: users.length, requestId, users }, { status: 201 });
      }

      const adminUserRoleMatch = url.pathname.match(/^\/v1\/admin\/users\/([^/]+)\/role$/);
      if (request.method === "PATCH" && adminUserRoleMatch?.[1]) {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const user = await updateAuthUserRole(env, decodeURIComponent(adminUserRoleMatch[1]), readString(body.role));
        return json({ requestId, user });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/mcp-clients") {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const client = await ensureMcpClient(env, {
          allowedScopes: readStringList(body.allowedScopes),
          id: readOptionalString(body.id),
          name: readOptionalString(body.name),
          resourceUrl: readOptionalString(body.resourceUrl),
          status: readOptionalString(body.status),
          supportedAgents: readStringList(body.supportedAgents).filter(isMcpAgentType)
        });
        return json({ client, requestId }, { status: 201 });
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/mcp/connections") {
        requireServiceToken(request, env);
        const status = normalizeAdminMcpConnectionStatus(url.searchParams.get("status"));
        const result = await listAdminMcpConnections(env, {
          limit: Number(url.searchParams.get("limit") || 1000),
          q: readOptionalString(url.searchParams.get("q")),
          status
        });
        return json({ ...result, requestId });
      }

      const adminMcpConnectionDisableMatch = url.pathname.match(/^\/v1\/admin\/mcp\/connections\/([^/]+)\/disable$/);
      if (request.method === "POST" && adminMcpConnectionDisableMatch?.[1]) {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const connection = await disableAdminMcpConnection(env, decodeURIComponent(adminMcpConnectionDisableMatch[1]));
        await recordAuditEvent(env, {
          action: "mcp_connection_disabled_by_admin",
          actorUserId: readOptionalString(body.actorUserId ?? body.actor_user_id),
          clientAppId: connection.clientId,
          decision: "allow",
          metadata: {
            agentType: connection.agentType,
            connectionUserId: connection.userId,
            displayName: connection.displayName
          },
          reason: "admin_disabled_connection",
          requestId,
          resourceId: connection.id,
          resourceType: "mcp_connection"
        });
        return json({ connection: { ...connection, status: "inactive" }, requestId });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/resources") {
        requireResourceRegistrationToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const resource = await registerResourceClient(env, {
          accessMode: readOptionalString(body.accessMode ?? body.access_mode),
          accessTargets: body.accessTargets ?? body.access_targets,
          allowedScopes: body.allowedScopes ?? body.allowed_scopes,
          audience: readOptionalString(body.audience),
          businessOwnerUserId: readOptionalString(body.businessOwnerUserId ?? body.business_owner_user_id),
          collaboratorUserIds: body.collaboratorUserIds ?? body.collaborator_user_ids,
          id: readOptionalString(body.id),
          name: readOptionalString(body.name),
          publisherUserId: readOptionalString(body.publisherUserId ?? body.publisher_user_id),
          status: readOptionalString(body.status),
          systemRolePolicyVersion: readOptionalString(
            body.systemRolePolicyVersion ?? body.system_role_policy_version
          )
        });
        return json({ requestId, resource }, { status: 201 });
      }

      const appClientPatch = url.pathname.match(/^\/v1\/admin\/apps\/([^/]+)\/(?:client|access-policy)$/);
      if (request.method === "PATCH" && appClientPatch?.[1]) {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const app = await registerAppClient(env, { ...body, id: decodeURIComponent(appClientPatch[1]) });
        return json({ app, requestId });
      }

      const appUsersMatch = url.pathname.match(/^\/v1\/admin\/apps\/([^/]+)\/users$/);
      if (isRead && appUsersMatch?.[1]) {
        requireServiceToken(request, env);
        return json({
          appId: decodeURIComponent(appUsersMatch[1]),
          requestId,
          users: await listAppUsers(env, decodeURIComponent(appUsersMatch[1]), readLimit(url.searchParams.get("limit"), 100))
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/grants") {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const grant = await upsertGrant(env, body);
        await recordAuditEvent(env, {
          action: "upserted_app_grant",
          actorUserId: readOptionalString(body.approvedByUserId) ?? readOptionalString(body.requestedByUserId),
          clientAppId: grant.appId,
          metadata: { status: grant.status },
          reason: grant.reason,
          requestId,
          resourceId: grant.id,
          resourceType: "app_grant"
        });
        return json({ grant, requestId }, { status: 201 });
      }

      const grantPatch = url.pathname.match(/^\/v1\/admin\/grants\/([^/]+)$/);
      if (request.method === "PATCH" && grantPatch?.[1]) {
        requireServiceToken(request, env);
        const body = await readJson<Record<string, unknown>>(request);
        const grant = await updateGrantStatus(env, decodeURIComponent(grantPatch[1]), body);
        await recordAuditEvent(env, {
          action: "updated_app_grant",
          actorUserId: grant.approvedByUserId,
          metadata: { status: grant.status },
          reason: grant.reason,
          requestId,
          resourceId: grant.id,
          resourceType: "app_grant"
        });
        return json({ grant, requestId });
      }

      return json({ error: "not_found", requestId }, { status: 404 });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }
};

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext?: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> {
    const response = withCorsResponse(await authWorker.fetch(request, env, executionContext), request, env);
    if (new URL(request.url).pathname.startsWith("/auth/email/")) {
      response.headers.set("Cache-Control", "no-store");
    }
    return response;
  },

  async queue(batch: MessageBatch<MokaDirectoryEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMokaDirectoryEvent(env, message.body);
        message.ack();
      } catch {
        const delaySeconds = Math.min(30 * (2 ** Math.max(message.attempts - 1, 0)), 3600);
        message.retry({ delaySeconds });
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledMokaDirectorySync(env).finally(() => deliverUserInvitations(env).then(() => undefined)));
  }
};

function isMcpAgentType(value: string): value is McpAgentType {
  return value === "claude-code" || value === "codex" || value === "cursor" || value === "workbuddy";
}
