import { appMailSdkHandoff } from "./apps/mailSdk";
import { decideOwnerTransfer, initiateOwnerTransfer, listOwnerTransfers, listOwnershipAssets } from "./ownership/service.ts";
import { deliverAppMailEvent } from "./apps/mailTrigger";
import { upgradeAppMailResource } from "./apps/service";
import { verifyMailToken } from "../../../src/shared/workspaceMailClient.ts";
import { syncAppMail } from "./apps/mailService";
import { mailSdkPackageResponse } from "./apps/mailSdkPackage";
import { readDefaultMailbox } from "./mates/mailbox.ts";
import type { AppsApp } from "../../../src/shared/types";
import { MATE_PET_OPTIONS } from "../../../src/shared/matePet.ts";
import {
  WORKSPACE_AGENT_INSTALL_COMMANDS,
  WORKSPACE_CLI_INSTALL_COMMAND,
  WORKSPACE_CLI_SERVE_COMMAND,
  WORKSPACE_WORKBUDDY_INSTALL_COMMAND
} from "../../../src/shared/workspaceCli.ts";
import { appAgentResourceContext, buildAppDeveloperContext } from "../../../src/shared/appsAgentHandoff";
import { appSourceRuntimeResponse } from "./apps/deployments";
import { appAuthSdkHandoff, WORKSPACE_AUTH_SDK_VERSION } from "./apps/authSdk";
import { authSdkPackageResponse } from "./apps/authSdkPackage";
import { issueHandoffLink, resolveHandoffLinkPrincipal } from "./apps/handoffLinks";
import { hydrateApp, listApps, listPublicApps, readApp, requireWritableApp } from "./apps/queries";
import { configureAppSecretValue, declareAppSecretRequirements, deleteAppSecretValue } from "./apps/secrets";
import { createApp, deleteApp, patchApp, publishProduction, updateAppCollaborators, updateAuthPolicy, updateVisibility } from "./apps/service";
import { downloadCurrentPublishedSourceSnapshot, downloadSourceSnapshot, listSourceSnapshots, uploadSourceSnapshot } from "./apps/sourceSnapshots";
import { downloadDeployArtifact, listDeployArtifacts, uploadDeployArtifact } from "./apps/deployArtifacts";
import { listAccessibleMcpApps, readAccessibleMcpApp } from "./apps/appMcpRegistry";
import { CLOUDFLARE_WORKER_UPLOAD_MODE } from "./apps/cloudflareDeploy";
import { assertScope, resolvePrincipal } from "./core/auth";
import { JSON_HEADERS, errorResponse, json, normalizePath, readJson } from "./core/http";
import { APP_READ_SCOPES, APP_WRITE_SCOPES, READ_SCOPES, SECRETS_WRITE_SCOPES, SKILL_READ_SCOPES, SKILL_WRITE_SCOPES, MATE_READ_SCOPES, MATE_WRITE_SCOPES, WRITE_SCOPES } from "./core/scopes";
import { HttpError, type Env, type Principal } from "./core/types";
import type { AppsAppRow } from "./db/rows";
import { listHubConsumptionAccess } from "./hubAccess";
import { listManagedInventory } from "./inventory";
import { listLlmModels } from "./llm-gateway/client";
import { readPublicationAuthorProjection } from "./publicationAuthors";
import { handleMcpRequest } from "./mcp/handler";
import { readLatestProvisioningJob, readProvisioningJob, retryProvisioningJob } from "./provisioning/service";
import { appRuntimeHtml, htmlResponse, runtimeErrorHtml, runtimeHost } from "./runtime/html";
import { platformMcpUrl } from "./runtime/urls";
import type { PublishSkillInput } from "./skills/package";
import { readRuntimeSkillFile } from './mates/service';
import { deleteSkill, listSkills, patchSkillMetadata, publishSkillPrivate, readSkill, skillInstallPrompt, skillZipResponse, syncPublicationSkillVisibility, updateSkillCollaborators, updateSkillVisibility } from "./skills/service";
import { activateDefaultMate, activateMateRelease, archiveMate, createMate, deployMatePreview, listPublishedMateRuntimeIdentities, listMateReleases, listMates, patchMate, publishMateRelease, readActiveMateRuntimeRelease, readActiveMateRuntimeReleaseByEmail, readDefaultMate, readOwnerTestRuntimeRelease, readMate, readMateRelease, reviewOwnedMateDefinition, mateAdoptionPreview, updateOwnedMateDefinition, updateMateDraft, validateMateDraft } from "./mates/service";

export async function handleAppsWorkerRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: JSON_HEADERS
    });
  }

  try {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const runtimeResponse = await appRuntimeResponse(request, env, url);

      if (runtimeResponse) {
        return runtimeResponse;
      }

      if (request.method === "GET" && path === "/health") {
        return json({
          ok: true,
          service: "workspace-apps-worker",
          capabilities: ["source-snapshots-v1", "deploy-artifacts-v1", "source-history-v2", "mate-control-plane-v1", "worker-version-upload-v1", CLOUDFLARE_WORKER_UPLOAD_MODE],
          requestId
        }, { headers: { "Cache-Control": "no-store" } });
      }

      if (path === '/admin/ownership' && request.method === 'GET') {
        const principal = await resolvePrincipal(request, env);
        return json({ assets: await listOwnershipAssets(env, principal) }, { headers: { 'Cache-Control': 'no-store' } });
      }
      const ownerTransferStart = path.match(/^\/(apps|skills)\/([^/]+)\/owner-transfer$/);
      const adminOwnerTransfer = path.match(/^\/admin\/ownership\/(apps|skills)\/([^/]+)$/);
      if (request.method === 'POST' && (ownerTransferStart || adminOwnerTransfer)) {
        const match = (ownerTransferStart || adminOwnerTransfer)!;
        const principal = await resolvePrincipal(request, env);
        if (!adminOwnerTransfer) assertScope(principal, match[1] === 'apps' ? APP_WRITE_SCOPES : SKILL_WRITE_SCOPES);
        return json(await initiateOwnerTransfer(env, principal, match[1] === 'apps' ? 'app' : 'skill', decodeURIComponent(match[2]), await readJson<Record<string, unknown>>(request), Boolean(adminOwnerTransfer)));
      }
      if (path === '/owner-transfers' && request.method === 'GET') {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, READ_SCOPES);
        return json({ transfers: await listOwnerTransfers(env, principal) }, { headers: { 'Cache-Control': 'no-store' } });
      }
      const ownerTransferDecision = path.match(/^\/owner-transfers\/([^/]+)\/(accept|reject|cancel)$/);
      if (ownerTransferDecision && request.method === 'POST') {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, WRITE_SCOPES);
        return json(await decideOwnerTransfer(env, principal, decodeURIComponent(ownerTransferDecision[1]), ownerTransferDecision[2] as 'accept' | 'reject' | 'cancel'));
      }

      const mailSdkDownload = path.match(/^\/sdk\/workspace-mail\/v(\d+\.\d+\.\d+)\.tgz$/);
      if (request.method === 'GET' && mailSdkDownload) return mailSdkPackageResponse(mailSdkDownload[1]);
      if(path==='/internal/mail/apps/received') {
        let authority;
        try {authority=await verifyMailToken(env.WORKSPACE_MAIL_SECRET||'',request.headers.get('authorization')?.replace(/^Bearer /,'')||'');}catch{throw new HttpError(401,'mail_service_unauthorized');}
        if(request.method!=='POST')throw new HttpError(405,'method_not_allowed');
        return json(await deliverAppMailEvent(env,authority,await request.json()));
      }
      if(path==='/internal/mail/apps/sync') {
        let authority;
        try{authority=await verifyMailToken(env.WORKSPACE_MAIL_SECRET||'',request.headers.get('authorization')?.replace(/^Bearer /,'')||'');}catch{throw new HttpError(401,'mail_service_unauthorized');}
        if(request.method!=='POST'||!authority.appId||!authority.scopes.includes('mail:app-provision'))throw new HttpError(403,'mail_app_provision_denied');
        const app=await env.APPS_DB.prepare("SELECT * FROM apps_apps WHERE id=? AND org_id=? AND owner_user_id=? AND status<>'archived'").bind(authority.appId,authority.orgId,authority.userId).first<AppsAppRow>();
        if(!app)throw new HttpError(404,'apps_app_not_found');
        await upgradeAppMailResource(env,{sub:app.owner_user_id,orgId:app.org_id,orgSlug:app.org_slug,scopes:[]},app);
        await syncAppMail(env,{sub:app.owner_user_id,orgId:app.org_id,orgSlug:app.org_slug,scopes:[]},app);
        return json({status:'ready'});
      }
      if (request.method === "GET" && path === `/sdk/workspace-auth/v${WORKSPACE_AUTH_SDK_VERSION}.tgz`) {
        return authSdkPackageResponse();
      }

      if (request.method === "POST" && path === "/mcp") {
        return handleMcpRequest(request, env, ctx);
      }

      if (request.method === "GET" && path === "/mcp/install-guide") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, READ_SCOPES);
        return json({ guide: platformMcpGuide(env, principal) });
      }

      if (request.method === "GET" && path === "/inventory") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, APP_READ_SCOPES);
        assertScope(principal, SKILL_READ_SCOPES);
        return json(await listManagedInventory(env, principal));
      }

      if (request.method === "GET" && path === "/internal/runtime/mates") {
        assertRuntimeServiceRequest(request, env);
        return json({ mates: await listPublishedMateRuntimeIdentities(env) }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      if (request.method === "GET" && path === "/internal/auth/default-agent") {
        if (!env.MATE_MCP_SERVICE_TOKEN || request.headers.get("authorization") !== `Bearer ${env.MATE_MCP_SERVICE_TOKEN}`) {
          throw new HttpError(401, "default_agent_service_token_invalid");
        }
        const { mailbox } = await readDefaultMailbox(env, { principal: runtimeUserPrincipal(request) });
        return json({ defaultAgent: mailbox ? { id: mailbox.mateId, name: mailbox.name, email: mailbox.address } : null },
          { headers: { "Cache-Control": "private, no-store" } });
      }

      const pluginOwnerMatch = path.match(/^\/internal\/mate-plugins\/([^/]+)\/owner$/);
      if (pluginOwnerMatch && request.method === "GET") {
        if (!env.MATE_MCP_SERVICE_TOKEN || request.headers.get("authorization") !== `Bearer ${env.MATE_MCP_SERVICE_TOKEN}`) {
          throw new HttpError(401, "mate_plugin_service_token_invalid");
        }
        const principal = runtimeUserPrincipal(request);
        const mate = await readMate(env.APPS_DB, principal, decodeURIComponent(pluginOwnerMatch[1]), false);
        return json({ owner: true, mateId: mate.id }, { headers: { "Cache-Control": "no-store" } });
      }

      const internalMateRuntimeMatch = path.match(/^\/internal\/runtime\/mates\/([^/]+)$/);
      if (request.method === "GET" && internalMateRuntimeMatch?.[1]) {
        assertRuntimeServiceRequest(request, env);
        return json(await readActiveMateRuntimeRelease(env, decodeURIComponent(internalMateRuntimeMatch[1]), optionalRuntimeUserPrincipal(request)), {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      const selfDefinitionMatch = path.match(/^\/internal\/runtime\/mates\/([^/]+)\/self-definition$/);
      if (selfDefinitionMatch?.[1] && (request.method === "GET" || request.method === "POST")) {
        assertRuntimeServiceRequest(request, env);
        const principal = runtimeUserPrincipal(request);
        const mateId = decodeURIComponent(selfDefinitionMatch[1]);
        if (request.method === "GET") {
          return json(await reviewOwnedMateDefinition(env, principal, mateId), {
            headers: { "Cache-Control": "private, no-store" }
          });
        }
        const body = await readJson<import("./mates/service").OwnerMateDefinitionChange>(request);
        const updated = await updateOwnedMateDefinition(env, principal, mateId, body);
        const release = await deployMatePreview(env, principal, mateId);
        const published = await publishMateRelease(env, principal, mateId, release.id);
        return json({ draftRevision: updated.mate.draftRevision, release: published, skill: updated.skill }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      const skillInspectMatch = path.match(/^\/internal\/runtime\/mates\/([^/]+)\/skill-inspect$/);
      if (skillInspectMatch && request.method === 'GET') {
        assertRuntimeServiceRequest(request, env);
        const principal = runtimeUserPrincipal(request);
        await readMate(env.APPS_DB, principal, decodeURIComponent(skillInspectMatch[1]), false);
        const skill = await readSkill(env.APPS_DB, principal, url.searchParams.get('skillId') || '');
        return json({ skillId: skill.id, name: skill.name, description: skill.description,
          versions: skill.versions.map(version => ({ version: version.version, digest: `sha256:${version.artifactSha256}` })) },
          { headers: { 'Cache-Control': 'no-store' } });
      }
      const skillFileMatch = path.match(/^\/internal\/runtime\/mates\/([^/]+)\/skill-file$/);
      if (skillFileMatch && request.method === 'GET') {
        assertRuntimeServiceRequest(request, env);
        return json(await readRuntimeSkillFile(env, runtimeUserPrincipal(request), decodeURIComponent(skillFileMatch[1]),
          url.searchParams.get('releaseId') || '', url.searchParams.get('skillId') || '', url.searchParams.get('path') || ''),
          { headers: { 'Cache-Control': 'no-store' } });
      }

      if (request.method === "GET" && path === "/internal/runtime/default-mailbox") {
        assertRuntimeServiceRequest(request, env);
        const address = url.searchParams.get("address");
        if (address !== null && (!address || address.length > 254)) throw new HttpError(400, "mail_address_invalid");
        return json(await readDefaultMailbox(env, address !== null
          ? { address } : { principal: runtimeUserPrincipal(request) }),
          { headers: { "Cache-Control": "private, no-store" } });
      }

      if (request.method === "GET" && path === "/internal/runtime/mate-by-email") {
        assertRuntimeServiceRequest(request, env);
        const address = url.searchParams.get("address")?.trim() || "";
        if (!address || address.length > 254) throw new HttpError(400, "runtime_mate_email_required");
        return json(await readActiveMateRuntimeReleaseByEmail(env, address, optionalRuntimeUserPrincipal(request)), {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      const internalOwnerTestMatch = path.match(/^\/internal\/runtime\/mates\/([^/]+)\/releases\/([^/]+)$/);
      if (request.method === "GET" && internalOwnerTestMatch?.[1] && internalOwnerTestMatch[2]) {
        assertRuntimeServiceRequest(request, env);
        const ownerUserId = request.headers.get("x-workspace-runtime-owner-user-id")?.trim() || "";
        if (!ownerUserId) throw new HttpError(400, "runtime_owner_user_required");
        return json(await readOwnerTestRuntimeRelease(
          env,
          decodeURIComponent(internalOwnerTestMatch[1]),
          decodeURIComponent(internalOwnerTestMatch[2]),
          ownerUserId,
          optionalRuntimeUserPrincipal(request)
        ), { headers: { "Cache-Control": "private, no-store" } });
      }

      if (request.method === "GET" && path === "/internal/runtime/app-mcp") {
        assertRuntimeServiceRequest(request, env);
        return json({ apps: await listAccessibleMcpApps(env, runtimeUserPrincipal(request)) }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      const internalRuntimeAppMcpMatch = path.match(/^\/internal\/runtime\/app-mcp\/([^/]+)$/);
      if (request.method === "GET" && internalRuntimeAppMcpMatch?.[1]) {
        assertRuntimeServiceRequest(request, env);
        const principal = runtimeUserPrincipal(request);
        return json(await readAccessibleMcpApp(
          env,
          principal,
          decodeURIComponent(internalRuntimeAppMcpMatch[1])
        ), { headers: { "Cache-Control": "private, no-store" } });
      }

      if (request.method === "GET" && path === "/hub-access") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, APP_READ_SCOPES);
        assertScope(principal, SKILL_READ_SCOPES);
        const url = new URL(request.url);
        return json(await listHubConsumptionAccess(env.APPS_DB, principal, {
          targetIds: url.searchParams.getAll("ids")
            .flatMap((value) => value.split(",")),
          type: url.searchParams.get("type") === "app"
            ? "app"
            : url.searchParams.get("type") === "skill"
              ? "skill"
              : undefined
        }));
      }

      if (request.method === "GET" && path === "/apps") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, READ_SCOPES);
        return json({ apps: await listApps(env.APPS_DB, env, principal) });
      }

      if (request.method === "GET" && path === "/mcp-apps") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, APP_READ_SCOPES);
        return json({ apps: await listAccessibleMcpApps(env, principal) }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      const mcpAppMatch = path.match(/^\/mcp-apps\/([^/]+)$/);
      if (request.method === "GET" && mcpAppMatch?.[1]) {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, APP_READ_SCOPES);
        return json(await readAccessibleMcpApp(env, principal, decodeURIComponent(mcpAppMatch[1])), {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      if (request.method === "GET" && path === "/skills") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, READ_SCOPES);
        return json({ skills: await listSkills(env.APPS_DB, principal) });
      }

      if (request.method === "GET" && path === "/mates") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, MATE_READ_SCOPES);
        return json({ mates: await listMates(env.APPS_DB, principal) }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      if (path === "/mates/default") {
        const principal = await resolvePrincipal(request, env);
        if (request.method === "GET") {
          assertScope(principal, MATE_READ_SCOPES);
          return json({ mate: await readDefaultMate(env.APPS_DB, principal) }, { headers: { "Cache-Control": "private, no-store" } });
        }
        if (request.method === "POST") {
          assertScope(principal, MATE_WRITE_SCOPES);
          return json({ mate: await activateDefaultMate(await readJson(request), env, principal) }, { headers: { "Cache-Control": "private, no-store" } });
        }
      }

      if (request.method === "GET" && path === "/mates/avatar-options") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, MATE_READ_SCOPES);
        return json({ avatars: MATE_PET_OPTIONS }, { headers: { "Cache-Control": "private, max-age=300" } });
      }

      if (request.method === "GET" && path === "/mate-templates") {
        return json({
          error: "mate_templates_removed",
          migration: "Create a custom Mate identity and configure its resources, channels, Soul, and Handbook directly."
        }, {
          headers: { "Cache-Control": "private, no-store" },
          status: 410
        });
      }

      if (request.method === "POST" && path === "/apps") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, APP_WRITE_SCOPES);
        return json(await createApp(request, env, principal, ctx), { status: 201 });
      }

      if (request.method === "POST" && path === "/skills") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, SKILL_WRITE_SCOPES);
        return json({ skill: await publishSkillPrivate(await readJson<PublishSkillInput>(request), env, principal) }, { status: 201 });
      }

      if (request.method === "POST" && path === "/mates") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, MATE_WRITE_SCOPES);
        return json({ mate: await createMate(await readJson(request), env, principal) }, { status: 201 });
      }

      if (request.method === "GET" && path === "/public-apps") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, READ_SCOPES);
        return json({ apps: await listPublicApps(env.APPS_DB, env, principal) });
      }

      if (request.method === "GET" && path === "/llm/models") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, READ_SCOPES);
        return json(await listLlmModels(env));
      }

      const publicationVisibilityMatch = path.match(/^\/publication-review\/skills\/([^/]+)\/visibility$/);
      if (request.method === "PATCH" && publicationVisibilityMatch?.[1]) {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, ["apps:skills:write"]);
        await syncPublicationSkillVisibility(request, env, principal, decodeURIComponent(publicationVisibilityMatch[1]));
        return json({ synced: true });
      }

      const publicationAuthorMatch = path.match(/^\/publication-review\/(apps|skills)\/([^/]+)\/authors$/);
      if (request.method === "GET" && publicationAuthorMatch?.[1] && publicationAuthorMatch[2]) {
        const principal = await resolvePrincipal(request, env);
        const targetType = publicationAuthorMatch[1] === "apps" ? "app" : "skill";
        assertScope(principal, targetType === "app" ? APP_READ_SCOPES : SKILL_READ_SCOPES);
        return json({
          authors: await readPublicationAuthorProjection(
            env.APPS_DB,
            principal,
            targetType,
            decodeURIComponent(publicationAuthorMatch[2])
          )
        });
      }

      const appMatch = path.match(/^\/apps\/([^/]+)$/);
      if (appMatch?.[1]) {
        const appId = decodeURIComponent(appMatch[1]);
        if (request.method === "GET") {
          const principal = await resolvePrincipal(request, env);
          assertScope(principal, READ_SCOPES);
          const app = await readApp(env.APPS_DB, env, principal, appId);
          return json({ app, developerContext: buildAppDeveloperContext(app) });
        }

        if (request.method === "PATCH") {
          const principal = await resolvePrincipal(request, env);
          assertScope(principal, APP_WRITE_SCOPES);
          return json({ app: await patchApp(request, env, principal, appId) });
        }

        if (request.method === "DELETE") {
          const principal = await resolvePrincipal(request, env);
          assertScope(principal, APP_WRITE_SCOPES);
          return json(await deleteApp(request, env, principal, appId));
        }
      }

      const sourceSnapshotDownloadMatch = path.match(/^\/apps\/([^/]+)\/source-snapshots\/([^/]+)\/download$/);
      if (request.method === "GET" && sourceSnapshotDownloadMatch?.[1] && sourceSnapshotDownloadMatch[2]) {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, APP_READ_SCOPES);
        return downloadSourceSnapshot(
          env,
          principal,
          decodeURIComponent(sourceSnapshotDownloadMatch[1]),
          decodeURIComponent(sourceSnapshotDownloadMatch[2])
        );
      }

      const currentSourceDownloadMatch = path.match(/^\/apps\/([^/]+)\/current-source\/download$/);
      if (request.method === "GET" && currentSourceDownloadMatch?.[1]) {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, APP_READ_SCOPES);
        return downloadCurrentPublishedSourceSnapshot(
          env,
          principal,
          decodeURIComponent(currentSourceDownloadMatch[1])
        );
      }

      const sourceSnapshotMatch = path.match(/^\/apps\/([^/]+)\/source-snapshots$/);
      if (sourceSnapshotMatch?.[1]) {
        const principal = await resolvePrincipal(request, env);
        const appId = decodeURIComponent(sourceSnapshotMatch[1]);
        if (request.method === "GET") {
          assertScope(principal, APP_READ_SCOPES);
          return json(await listSourceSnapshots(env, principal, appId), {
            headers: { "Cache-Control": "private, no-store" }
          });
        }
        if (request.method === "POST") {
          assertScope(principal, APP_WRITE_SCOPES);
          return json(await uploadSourceSnapshot(request, env, principal, appId), {
            status: 201,
            headers: { "Cache-Control": "private, no-store" }
          });
        }
      }

      const deployArtifactDownloadMatch = path.match(/^\/apps\/([^/]+)\/deploy-artifacts\/([^/]+)\/download$/);
      if (request.method === "GET" && deployArtifactDownloadMatch?.[1] && deployArtifactDownloadMatch[2]) {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, APP_READ_SCOPES);
        return downloadDeployArtifact(
          env,
          principal,
          decodeURIComponent(deployArtifactDownloadMatch[1]),
          decodeURIComponent(deployArtifactDownloadMatch[2])
        );
      }

      const deployArtifactMatch = path.match(/^\/apps\/([^/]+)\/deploy-artifacts$/);
      if (deployArtifactMatch?.[1]) {
        const principal = await resolvePrincipal(request, env);
        const appId = decodeURIComponent(deployArtifactMatch[1]);
        if (request.method === "GET") {
          assertScope(principal, APP_READ_SCOPES);
          return json(await listDeployArtifacts(env, principal, appId), {
            headers: { "Cache-Control": "private, no-store" }
          });
        }
        if (request.method === "POST") {
          assertScope(principal, APP_WRITE_SCOPES);
          return json(await uploadDeployArtifact(request, env, principal, appId), {
            status: 201,
            headers: { "Cache-Control": "private, no-store" }
          });
        }
      }

      const skillMatch = path.match(/^\/skills\/([^/]+)$/);
      if (skillMatch?.[1]) {
        const skillId = decodeURIComponent(skillMatch[1]);
        if (request.method === "GET") {
          const principal = await resolvePrincipal(request, env);
          assertScope(principal, READ_SCOPES);
          return json({ skill: await readSkill(env.APPS_DB, principal, skillId) });
        }

        if (request.method === "PATCH") {
          const principal = await resolvePrincipal(request, env);
          assertScope(principal, SKILL_WRITE_SCOPES);
          return json({ skill: await patchSkillMetadata(await readJson<Record<string, unknown>>(request), env, principal, skillId) });
        }

        if (request.method === "DELETE") {
          const principal = await resolvePrincipal(request, env);
          assertScope(principal, SKILL_WRITE_SCOPES);
          return json(await deleteSkill(request, env, principal, skillId));
        }
      }

      const matePluginsMatch = path.match(/^\/mates\/([^/]+)\/plugins$/);
      if (matePluginsMatch && (request.method === 'GET' || request.method === 'POST')) {
        const principal = await resolvePrincipal(request, env);
        const mateId = decodeURIComponent(matePluginsMatch[1]);
        assertScope(principal, request.method === 'GET' ? MATE_READ_SCOPES : MATE_WRITE_SCOPES);
        if (request.method === 'GET') {
          const review = await reviewOwnedMateDefinition(env, principal, mateId);
          return json({ ...review, skills: review.installedSkills }, { headers: { 'Cache-Control': 'no-store' } });
        }
        const body = await readJson<import('./mates/service').OwnerMateDefinitionChange>(request);
        // This settings endpoint can only uninstall optional installed Skills.
        if (Object.keys(body).some(key => !['expectedReleaseId', 'expectedDraftRevision', 'removeSkillIds'].includes(key)))
          throw new HttpError(400, 'mate_plugin_change_invalid');
        if (!body.removeSkillIds?.length) throw new HttpError(400, 'mate_skill_uninstall_invalid');
        const updated = await updateOwnedMateDefinition(env, principal, mateId, body);
        const release = await deployMatePreview(env, principal, mateId);
        const published = await publishMateRelease(env, principal, mateId, release.id);
        return json({ draftRevision: updated.mate.draftRevision, release: published });
      }

      const mateMatch = path.match(/^\/mates\/([^/]+)$/);
      if (mateMatch?.[1]) {
        const mateId = decodeURIComponent(mateMatch[1]);
        const principal = await resolvePrincipal(request, env);
        if (request.method === "GET") {
          assertScope(principal, MATE_READ_SCOPES);
          return json({ mate: await readMate(env.APPS_DB, principal, mateId, true) }, {
            headers: { "Cache-Control": "private, no-store" }
          });
        }
        if (request.method === "PATCH") {
          assertScope(principal, MATE_WRITE_SCOPES);
          return json({ mate: await patchMate(await readJson<Record<string, unknown>>(request), env, principal, mateId) });
        }
        if (request.method === "DELETE") {
          assertScope(principal, MATE_WRITE_SCOPES);
          return json(await archiveMate(env, principal, mateId));
        }
      }

      const mateActionMatch = path.match(/^\/mates\/([^/]+)\/(draft|validate|deploy|releases)$/);
      if (mateActionMatch?.[1] && mateActionMatch[2]) {
        const mateId = decodeURIComponent(mateActionMatch[1]);
        const action = mateActionMatch[2];
        const principal = await resolvePrincipal(request, env);
        if (request.method === "PUT" && action === "draft") {
          assertScope(principal, MATE_WRITE_SCOPES);
          return json({ mate: await updateMateDraft(await readJson(request), env, principal, mateId) });
        }
        if (request.method === "POST" && action === "validate") {
          assertScope(principal, MATE_WRITE_SCOPES);
          return json({ validation: await validateMateDraft(env, principal, mateId) });
        }
        if (request.method === "POST" && action === "deploy") {
          assertScope(principal, MATE_WRITE_SCOPES);
          const release = await deployMatePreview(env, principal, mateId);
          return json({ adoptionPreview: mateAdoptionPreview(env, release), release }, { status: 201 });
        }
        if (request.method === "GET" && action === "releases") {
          assertScope(principal, MATE_READ_SCOPES);
          return json({ releases: await listMateReleases(env, principal, mateId) });
        }
      }

      const mateReleaseMatch = path.match(/^\/mates\/([^/]+)\/releases\/([^/]+)(?:\/(publish|activate))?$/);
      if (mateReleaseMatch?.[1] && mateReleaseMatch[2]) {
        const mateId = decodeURIComponent(mateReleaseMatch[1]);
        const releaseId = decodeURIComponent(mateReleaseMatch[2]);
        const action = mateReleaseMatch[3];
        const principal = await resolvePrincipal(request, env);
        if (request.method === "GET" && !action) {
          assertScope(principal, MATE_READ_SCOPES);
          return json({ release: await readMateRelease(env, principal, mateId, releaseId) });
        }
        if (request.method === "POST" && action === "publish") {
          assertScope(principal, MATE_WRITE_SCOPES);
          return json({ release: await publishMateRelease(env, principal, mateId, releaseId) });
        }
        if (request.method === "POST" && action === "activate") {
          assertScope(principal, MATE_WRITE_SCOPES);
          return json({ release: await activateMateRelease(env, principal, mateId, releaseId) });
        }
      }

      const skillActionMatch = path.match(/^\/skills\/([^/]+)\/(visibility|collaborators)$/);
      if (skillActionMatch?.[1] && skillActionMatch[2]) {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, SKILL_WRITE_SCOPES);
        const skillId = decodeURIComponent(skillActionMatch[1]);

        if (request.method === "PATCH" && skillActionMatch[2] === "visibility") {
          return json({ skill: await updateSkillVisibility(request, env, principal, skillId) });
        }

        if (request.method === "PATCH" && skillActionMatch[2] === "collaborators") {
          return json({ skill: await updateSkillCollaborators(request, env, principal, skillId) });
        }
      }

      const skillVersionMatch = path.match(/^\/skills\/([^/]+)\/versions\/([^/]+)\/(download\.zip|install-prompt)$/);
      if (skillVersionMatch?.[1] && skillVersionMatch[2] && skillVersionMatch[3]) {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, READ_SCOPES);
        const skillId = decodeURIComponent(skillVersionMatch[1]);
        const version = decodeURIComponent(skillVersionMatch[2]);
        const action = skillVersionMatch[3];

        if (request.method === "GET" && action === "download.zip") {
          return skillZipResponse(env, principal, skillId, version);
        }

        if (request.method === "GET" && action === "install-prompt") {
          return json({ prompt: await skillInstallPrompt(env.APPS_DB, principal, skillId, version, url.searchParams.get("client") ?? "codex") });
        }
      }

      const appSecretsMatch = path.match(/^\/apps\/([^/]+)\/secrets(?:\/(requirements|value))?$/);
      if (appSecretsMatch?.[1]) {
        const principal = await resolvePrincipal(request, env);
        const appId = decodeURIComponent(appSecretsMatch[1]);
        const action = appSecretsMatch[2];

        if (request.method === "GET" && !action) {
          assertScope(principal, READ_SCOPES);
          const app = await readApp(env.APPS_DB, env, principal, appId);
          return json({
            secrets: app.secrets,
            managedSecrets: buildAppDeveloperContext(app).auth.managedSecrets
          });
        }

        if (request.method === "POST" && action === "requirements") {
          assertScope(principal, APP_WRITE_SCOPES);
          return json({ app: await declareAppSecretRequirements(request, env, principal, appId) });
        }

        if (request.method === "POST" && action === "value") {
          assertScope(principal, SECRETS_WRITE_SCOPES);
          return json({ app: await configureAppSecretValue(request, env, principal, appId) });
        }

        if (request.method === "DELETE" && action === "value") {
          assertScope(principal, SECRETS_WRITE_SCOPES);
          return json({ app: await deleteAppSecretValue(request, env, principal, appId) });
        }
      }

      const appActionMatch = path.match(/^\/apps\/([^/]+)\/(resources|service-context|auth-sdk|mail-sdk|handoff(?:\.md)?|handoff-link|mcp-guide|publish|visibility|auth-policy|collaborators)$/);
      if (appActionMatch?.[1] && appActionMatch[2]) {
        const appId = decodeURIComponent(appActionMatch[1]);
        const action = appActionMatch[2];
        const principal = await resolveAppActionPrincipal(request, env, url, action);

        if (request.method === "GET" && action === "resources") {
          assertScope(principal, READ_SCOPES);
          const app = await readApp(env.APPS_DB, env, principal, appId);
          return json({ resources: app.resources, manifest: app.manifest });
        }

        if (request.method === "GET" && action === "service-context") {
          assertScope(principal, READ_SCOPES);
          const app = await readApp(env.APPS_DB, env, principal, appId);
          return json(app.manifest);
        }

        if (request.method === "GET" && action === "mail-sdk") {
          assertScope(principal, APP_READ_SCOPES);
          return json(appMailSdkHandoff(await readApp(env.APPS_DB,env,principal,appId)));
        }
        if (request.method === "GET" && action === "auth-sdk") {
          assertScope(principal, READ_SCOPES);
          const app = await readApp(env.APPS_DB, env, principal, appId);
          return json(appAuthSdkHandoff(app));
        }

        if (request.method === "POST" && action === "handoff-link") {
          assertScope(principal, READ_SCOPES);
          const app = await hydrateApp(env.APPS_DB, env, await requireWritableApp(env.APPS_DB, principal, appId));
          return json(await issueHandoffLink(env, principal, app));
        }

        if (request.method === "GET" && action.startsWith("handoff")) {
          assertScope(principal, [...READ_SCOPES, "apps:apps:handoff"]);
          assertHandoffTokenMatchesApp(principal, appId);
          const app = await readApp(env.APPS_DB, env, principal, appId);
          return new Response(appAgentResourceContext(app), {
            headers: {
              ...JSON_HEADERS,
              "Content-Disposition": `inline; filename="${app.slug || app.id}-handoff.md"`,
              "Content-Type": "text/markdown; charset=utf-8"
            }
          });
        }

        if (request.method === "GET" && action === "mcp-guide") {
          assertScope(principal, READ_SCOPES);
          const app = await readApp(env.APPS_DB, env, principal, appId);
          return json({ guide: appMcpGuide(env, principal, app) });
        }

        if (request.method === "POST" && action === "publish") {
          assertScope(principal, ["apps:deploy:production", "apps:apps:admin"]);
          return json({ app: await publishProduction(request, env, principal, appId) });
        }

        if (request.method === "PATCH" && action === "visibility") {
          assertScope(principal, APP_WRITE_SCOPES);
          return json({ app: await updateVisibility(request, env, principal, appId) });
        }

        if (request.method === "PATCH" && action === "collaborators") {
          assertScope(principal, APP_WRITE_SCOPES);
          return json({ app: await updateAppCollaborators(request, env, principal, appId) });
        }

        if (request.method === "PATCH" && action === "auth-policy") {
          assertScope(principal, APP_WRITE_SCOPES);
          return json({ app: await updateAuthPolicy(request, env, principal, appId) });
        }
      }

      const appProvisioningMatch = path.match(/^\/apps\/([^/]+)\/provisioning$/);
      if (appProvisioningMatch?.[1] && request.method === "GET") {
        const principal = await resolvePrincipal(request, env);
        assertScope(principal, READ_SCOPES);
        const appId = decodeURIComponent(appProvisioningMatch[1]);
        return json({ provisioningJob: await readLatestProvisioningJob(env.APPS_DB, principal, appId) });
      }

      const jobMatch = path.match(/^\/provisioning-jobs\/([^/]+)(?:\/(retry))?$/);
      if (jobMatch?.[1]) {
        const principal = await resolvePrincipal(request, env);
        const jobId = decodeURIComponent(jobMatch[1]);
        const action = jobMatch[2];

        if (request.method === "GET" && !action) {
          assertScope(principal, READ_SCOPES);
          return json({ provisioningJob: await readProvisioningJob(env.APPS_DB, principal, jobId) });
        }

        if (request.method === "POST" && action === "retry") {
          assertScope(principal, WRITE_SCOPES);
          const job = await retryProvisioningJob(env, principal, jobId, ctx);
          return json({ provisioningJob: job });
        }
      }

    return json({ error: "not_found", requestId }, { status: 404 });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

async function appRuntimeResponse(request: Request, env: Env, url: URL): Promise<Response | undefined> {
  const match = runtimeHost(url, env);
  if (!match) {
    return undefined;
  }

  const matchingRows = await env.APPS_DB
    .prepare(
      `
      SELECT
        apps_apps.*,
        (
          SELECT MAX(created_at)
          FROM apps_deployments
          WHERE apps_deployments.app_id = apps_apps.id
            AND apps_deployments.status IN ('ready', 'published')
        ) AS last_deployed_at
      FROM apps_apps
      WHERE code = ? OR slug = ?
      ORDER BY updated_at DESC
      LIMIT 2
      `
    )
    .bind(match.appCode, match.appCode)
    .all<AppsAppRow>();
  const rows = matchingRows.results ?? [];

  // The hostname contains only appCode. Existing cross-org duplicates must
  // fail closed instead of selecting the most recently updated tenant and
  // exposing another App's host-only cookies or content to it.
  if (rows.length > 1) {
    return htmlResponse(runtimeErrorHtml(match.appCode, "App runtime hostname is ambiguous."), { status: 503, method: request.method });
  }
  const row = rows[0];

  if (!row) {
    return htmlResponse(runtimeErrorHtml(match.appCode, "App runtime not found."), { status: 404, method: request.method });
  }

  const app = await hydrateApp(env.APPS_DB, env, row);

  if (match.environment === "production" && app.status !== "published") {
    return htmlResponse(runtimeErrorHtml(app.name, "Production is not published yet."), { status: 404, method: request.method });
  }

  if (match.sharedOrigin && app.loginRequired) {
    return independentAppOriginResponse(request, app);
  }

  const sourceResponse = await appSourceRuntimeResponse(request, env, app, match.appPath);
  if (sourceResponse) {
    return sourceResponse;
  }

  return htmlResponse(appRuntimeHtml(app, match.environment), { method: request.method });
}

function independentAppOriginResponse(request: Request, app: AppsApp) {
  const requestUrl = new URL(request.url);
  let canonical: URL | undefined;
  try {
    canonical = new URL(app.productionUrl);
  } catch {
    // Fail closed below when no independent production origin is configured.
  }
  if (!canonical || canonical.protocol !== "https:" || canonical.origin === requestUrl.origin) {
    return json({ error: "independent_app_origin_required" }, { status: 503 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "canonical_app_origin_required", location: canonical.origin }, { status: 421 });
  }
  canonical.pathname = "/";
  canonical.search = "";
  canonical.hash = "";
  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: canonical.toString()
    }
  });
}

async function resolveAppActionPrincipal(request: Request, env: Env, url: URL, action: string) {
  if (isHandoffReadAction(action) && !request.headers.has("authorization")) {
    const token = handoffQueryToken(url);
    if (token.startsWith("lh_")) {
      return resolveHandoffLinkPrincipal(env, token);
    }
  }

  return resolvePrincipal(handoffAuthorizedRequest(request, url, action), env);
}

function handoffAuthorizedRequest(request: Request, url: URL, action: string) {
  if (!isHandoffReadAction(action) || request.headers.has("authorization")) {
    return request;
  }

  const token = handoffQueryToken(url);
  if (!token) {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(request, { headers });
}

function handoffQueryToken(url: URL) {
  return (url.searchParams.get("h") || url.searchParams.get("handoff_token") || "").trim();
}

function isHandoffReadAction(action: string) {
  return action === "handoff" || action === "handoff.md";
}

function assertHandoffTokenMatchesApp(principal: Principal, appId: string) {
  if (principal.tokenType !== "apps_handoff") {
    return;
  }

  if (principal.appId !== appId) {
    throw new HttpError(403, "handoff_token_app_mismatch");
  }
}

function assertRuntimeServiceRequest(request: Request, env: Env) {
  const expected = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!expected) throw new HttpError(503, "mate_runtime_service_token_not_configured");
  if (!provided || provided.length !== expected.length) throw new HttpError(401, "invalid_mate_runtime_service_token");
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  if (mismatch !== 0) throw new HttpError(401, "invalid_mate_runtime_service_token");
}

function runtimeUserPrincipal(request: Request): Principal {
  const sub = request.headers.get("x-workspace-runtime-user-id")?.trim() || "";
  const orgId = request.headers.get("x-workspace-runtime-org-id")?.trim() || "";
  if (!sub) throw new HttpError(400, "runtime_user_required");
  if (!orgId) throw new HttpError(400, "runtime_org_required");
  return {
    departmentId: request.headers.get("x-workspace-runtime-department-id")?.trim() || undefined,
    departmentPath: runtimeStringList(request.headers.get("x-workspace-runtime-department-path")),
    email: request.headers.get("x-workspace-runtime-user-email")?.trim() || undefined,
    name: request.headers.get("x-workspace-runtime-user-name")?.trim() || undefined,
    orgId,
    orgSlug: request.headers.get("x-workspace-runtime-org-slug")?.trim() || orgId,
    scopes: ["apps:apps:read"],
    sub
  };
}

function optionalRuntimeUserPrincipal(request: Request): Principal | undefined {
  return request.headers.has("x-workspace-runtime-user-id") ? runtimeUserPrincipal(request) : undefined;
}

function runtimeStringList(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 64);
  } catch {
    return undefined;
  }
}

function platformMcpGuide(env: Env, principal: Principal) {
  const url = platformMcpUrl(env);

  return {
    title: "Workspace Apps Platform MCP",
    platformUrl: url,
    installCommand: WORKSPACE_CLI_INSTALL_COMMAND,
    serveCommand: WORKSPACE_CLI_SERVE_COMMAND,
    scopes: [
      "apps:apps:read",
      "apps:apps:write",
      "apps:apps:admin",
      "apps:skills:read",
      "apps:skills:write",
      "apps:skills:admin",
      "apps:mates:read",
      "apps:mates:write",
      "apps:mates:admin",
      "apps:secrets:write",
      "apps:deploy:production"
    ],
    temporaryLocalInstall: {
      account: "local.apps@example.invalid",
      note: "Use DEV_AUTH_BYPASS=1 only when the APPS Worker is running on localhost.",
      headers: {
        "X-Workspace-User-Id": "local.apps@example.invalid",
        "X-Workspace-Org-Id": "example-org",
        "X-Workspace-Org-Slug": "workspace-wealth",
        "X-Workspace-Scopes": "apps:apps:read,apps:apps:write,apps:apps:admin,apps:skills:read,apps:skills:write,apps:skills:admin,apps:mates:read,apps:mates:write,apps:mates:admin,apps:secrets:write,apps:deploy:production"
      }
    },
    cloudCode: {
      command: "cloudcode mcp add workspace-apps",
      config: {
        name: "workspace-apps",
        url,
        headers: {
          Authorization: "Bearer ${WORKSPACE_APPS_MCP_TOKEN}"
        }
      }
    },
    agents: {
      workbuddy: WORKSPACE_AGENT_INSTALL_COMMANDS.workbuddy,
      claudeCode: WORKSPACE_AGENT_INSTALL_COMMANDS.claudeCode,
      codex: WORKSPACE_AGENT_INSTALL_COMMANDS.codex,
      cursor: WORKSPACE_AGENT_INSTALL_COMMANDS.cursor
    },
    principal: {
      userId: principal.sub,
      orgId: principal.orgId
    }
  };
}

function appMcpGuide(env: Env, principal: Principal, app: AppsApp) {
  const platformUrl = platformMcpUrl(env);
  return {
    title: `${app.name} Workspace MCP Registration`,
    appId: app.id,
    platformUrl,
    installCommand: WORKSPACE_CLI_INSTALL_COMMAND,
    serveCommand: WORKSPACE_CLI_SERVE_COMMAND,
    agentInstallCommands: WORKSPACE_AGENT_INSTALL_COMMANDS,
    workBuddyInstallCommand: WORKSPACE_WORKBUDDY_INSTALL_COMMAND,
    registrationMode: "central_workspace_ai_mcp_bridge",
    auth: app.manifest.auth,
    isolation: {
      orgId: principal.orgId,
      audience: app.id,
      rule: "Resource API tokens minted through Workspace MCP must match the target app audience and cannot cross app boundaries."
    }
  };
}
