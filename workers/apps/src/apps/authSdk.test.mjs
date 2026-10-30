import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function authSdkModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-auth-sdk-test-"));
  const outfile = join(outdir, "authSdk.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./authSdk.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

async function developerContextModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-developer-context-test-"));
  const outfile = join(outdir, "appsAgentHandoff.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("../../../../src/shared/appsAgentHandoff.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function appFixture(overrides = {}) {
  return {
    id: "app-test",
    orgId: "org-test",
    ownerUserId: "owner-test",
    ownerTeamId: "org-test",
    collaboratorUserIds: [],
    name: "App Test",
    appCode: "app-test",
    slug: "app-test",
    description: "Test app",
    type: "web",
    status: "draft",
    visibility: "private",
    accessTargets: [],
    loginRequired: true,
    agentMcpEnabled: false,
    llmEnabled: false,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    productionUrl: "https://app-test.example.invalid",
    dataServiceId: "data-app-test",
    resources: [{
      id: "res-worker",
      appId: "app-test",
      dataServiceId: "data-app-test",
      type: "worker",
      provider: "cloudflare-workers",
      resourceName: "apps-app-test-worker",
      resourceId: "apps-app-test-worker",
      environment: "prod",
      status: "ready",
      createdAt: "2026-08-10T00:00:00.000Z"
    }],
    secrets: [],
    deployments: [],
    domains: [],
    manifest: {
      appId: "app-test",
      dataServiceId: "data-app-test",
      type: "web",
      auth: {
        issuer: "https://auth.example.invalid",
        origin: "https://auth.example.invalid",
        publicOrigin: "https://ai.example.invalid",
        clientId: "app-test",
        audience: "app-test",
        required: true,
        registration: {
          strategy: "first_login",
          separateSignup: false,
          appUserObjectName: "appUser",
          appUserTableRecommendation: "app_users",
          profileUpsert: true
        },
        loginStartPath: "/auth/workspace/start",
        callbackPath: "/auth/workspace/callback",
        sessionEndpoint: "/api/auth/session",
        logoutEndpoint: "/auth/workspace/logout",
        authorizeEndpoint: "https://ai.example.invalid/auth/v1/authorize",
        tokenExchangeEndpoint: "https://auth.example.invalid/v1/app-login/exchange",
        secrets: {
          appClient: "WORKSPACE_AUTH_APP_SECRET",
          appSession: "WORKSPACE_APP_SESSION_SECRET"
        },
        callbackUrls: {
          production: "https://app-test.example.invalid/auth/workspace/callback",
          fallbackProduction: "https://app-test.example.invalid/auth/workspace/callback"
        },
        loginUrls: {
          production: "https://app-test.example.invalid/auth/workspace/start",
          fallbackProduction: "https://app-test.example.invalid/auth/workspace/start"
        },
        env: {
          WORKSPACE_AUTH_AUTHORIZE_ORIGIN: "https://ai.example.invalid",
          WORKSPACE_AUTH_ORIGIN: "https://auth.example.invalid",
          WORKSPACE_AUTH_CLIENT_ID: "app-test",
          WORKSPACE_AUTH_AUDIENCE: "app-test",
          WORKSPACE_AUTH_CALLBACK_PATH: "/auth/workspace/callback",
          WORKSPACE_AUTH_SESSION_ENDPOINT: "/api/auth/session",
          WORKSPACE_AUTH_FALLBACK_PRODUCTION_URL: "https://apps.example.invalid/run/app-test"
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
      },
      runtime: {
        productionUrl: "https://app-test.example.invalid",
        fallbackProductionUrl: "https://apps.example.invalid/run/app-test"
      },
      bindings: {},
      cli: { install: "", publish: "" },
      mcp: { registered: false, schemaRequired: false, platformUrl: "https://apps.example.invalid/mcp", installCommand: "" },
      llm: { enabled: false, gatewayUrl: "https://token.example.invalid" },
      email: {
        sending: { enabled: false, fromEnv: "WORKSPACE_EMAIL_FROM" },
        routing: {
          enabled: false,
          handler: "email",
          mode: "process",
          routerWorker: "workspace-email-router",
          env: {
            WORKSPACE_EMAIL_INBOUND_ADDRESS: "WORKSPACE_EMAIL_INBOUND_ADDRESS",
            WORKSPACE_EMAIL_ROUTER_WORKER: "WORKSPACE_EMAIL_ROUTER_WORKER",
            WORKSPACE_EMAIL_ROUTING_MODE: "WORKSPACE_EMAIL_ROUTING_MODE"
          }
        }
      },
      secrets: []
    },
    ...overrides
  };
}

describe("Auth SDK handoff", () => {
  it("includes Stream registration, backend authorization and CLI guidance without secret values", async () => {
    const { buildAppDeveloperContext, appAgentResourceContext } = await developerContextModule();
    const app = appFixture();
    app.resources.push({ id: "stream-test", appId: app.id, type: "media", provider: "workspace-stream",
      bindingName: "WORKSPACE_STREAM", resourceId: `workspace-stream-worker:${app.id}`, status: "ready", environment: "prod", createdAt: "2026-10-27" });
    app.secrets.push({ name: "WORKSPACE_STREAM_TOKEN", status: "configured", value: "must-never-be-copied" });
    const context = buildAppDeveloperContext(app);
    assert.equal(context.stream.status, "ready");
    for (const prompt of [context.stream.developmentPrompt, appAgentResourceContext(app)]) {
      assert.match(prompt, /WORKSPACE_STREAM_TOKEN/); assert.match(prompt, /\/v1\/uploads/);
      assert.match(prompt, /\/playback/); assert.match(prompt, /frontier-workspace upload/);
      assert.match(prompt, /verified session/); assert.match(prompt, /App-scoped grant/);
      assert.doesNotMatch(prompt, /must-never-be-copied|Stream:Write/);
    }
  });
  it("ships the same mail upgrade prompt and serves the current pinned SDK download", async () => {
    const { buildAppDeveloperContext } = await developerContextModule();
    const sdk = buildAppDeveloperContext(appFixture()).emailSending.sdk;
    const prompt = readFileSync(new URL("../../../../sdk/mail/DEVELOPMENT_PROMPT.md", import.meta.url), "utf8").trim();
    assert.equal(sdk.developmentPrompt, prompt);
    assert.equal(sdk.legacyNativeEmailSupportedThrough, "2026-12-31");
    assert.equal(sdk.legacyNativeEmailTimeZone, "Asia/Shanghai");
    assert.ok(prompt.includes(sdk.packageUrl));
    assert.doesNotMatch(prompt, /\{\{SDK_/);

    const outdir = await mkdtemp(join(tmpdir(), "apps-mail-sdk-package-test-"));
    try {
      const outfile = join(outdir, "mailSdkPackage.mjs");
      await build({ bundle: true, entryPoints: [new URL("./mailSdkPackage.ts", import.meta.url).pathname], format: "esm", logLevel: "silent", outfile, platform: "neutral" });
      const { mailSdkPackageResponse } = await import(pathToFileURL(outfile).href);
      for (const version of [sdk.version]) {
        const archive = JSON.parse(readFileSync(new URL(`../../../../sdk/mail/releases/${version}.json`, import.meta.url), "utf8"));
        const response = mailSdkPackageResponse(version);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-disposition"), `attachment; filename="workspace-mail-${version}.tgz"`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.equal(createHash("sha256").update(bytes).digest("hex"), archive.sha256);
        assert.equal(bytes.byteLength, archive.sizeBytes);
      }
      assert.equal(mailSdkPackageResponse("99.0.0").status, 404);
      assert.equal(mailSdkPackageResponse("constructor").status, 404);
    } finally {
      await rm(outdir, { recursive: true, force: true });
    }
  });

  it("redirects anonymous requests to the dedicated start route", async () => {
    const { appAuthSdkHandoff } = await authSdkModule();
    const handoff = appAuthSdkHandoff(appFixture({
      accessTargets: ["department:dept-investment"]
    }));

    assert.equal(handoff.schemaVersion, "workspace.apps.auth-sdk-handoff.v5");
    assert.equal(handoff.contractVersion, "app-session-v1");
    assert.equal(handoff.package.name, "@frontier-workspace/auth");
    assert.equal(handoff.package.version, "0.1.0");
    assert.equal(handoff.package.packageUrl, "https://apps.example.invalid/sdk/workspace-auth/v0.1.0.tgz");
    assert.ok(handoff.package.sizeBytes > 23059);
    assert.match(handoff.example, /new URL\("\/auth\/workspace\/start", url\.origin\)/);
    assert.match(handoff.example, /startUrl\.searchParams\.set\("return_to", request\.url\)/);
    assert.match(handoff.example, /Response\.redirect\(startUrl\.toString\(\), 302\)/);
    assert.match(handoff.example, /authenticated: true, workspaceUser: session\.user/);
    assert.match(handoff.example, /new WorkspaceAuthDirectory/);
    assert.match(handoff.example, /directory\.listPeople/);
    assert.match(handoff.example, /flat node list; rebuild the tree from parentId\/path/);
    assert.match(handoff.example, /people-only search does not need a preceding listDepartments call/);
    assert.match(handoff.example, /hasDepartmentAccess\(session\.user/);
    assert.doesNotMatch(handoff.example, /auth\.start\(request, \{ returnTo: request\.url \}\)/);
    assert.equal(handoff.configuration.authorizeOrigin, "https://ai.example.invalid");
    assert.equal(handoff.configuration.authOrigin, "https://auth.example.invalid");
    assert.equal(handoff.secretProvisioning.manualDeclarationRequired, false);
    assert.deepEqual(
      handoff.secretProvisioning.secrets.map((secret) => [secret.name, secret.status]),
      [
        ["WORKSPACE_AUTH_APP_SECRET", "pending_auto_creation"],
        ["WORKSPACE_APP_SESSION_SECRET", "pending_auto_creation"]
      ]
    );
    assert.match(handoff.migration.d1Impact, /does not require a D1 session table/);
    assert.match(handoff.deployment.worker, /frontier-workspace apps deploy --target worker/);
    assert.equal(handoff.capabilities.directory.serverOnly, true);
    assert.equal(handoff.capabilities.directory.policyFiltered, true);
    assert.equal(handoff.capabilities.directory.directoryReadScope, "app");
    assert.equal(handoff.capabilities.appMcpAuthorization.effectiveRoleResolver, "resolveEffectiveAppRoles");
    assert.match(handoff.capabilities.appMcpAuthorization.roleSources.system, /Never copy/);
    assert.match(handoff.capabilities.appMcpAuthorization.memberMapping, /identity, not an App role/);
    assert.match(handoff.capabilities.appMcpAuthorization.memberMapping, /normally member/);
    assert.match(handoff.capabilities.appMcpAuthorization.businessRoles, /banker/);
    assert.match(handoff.capabilities.appMcpAuthorization.mappingSemantics.noImplicitHierarchy, /owner does not imply admin/);
    assert.match(handoff.capabilities.appMcpAuthorization.mappingSemantics.ownerPrecedence, /returns app_owner/);
    assert.match(handoff.capabilities.appMcpAuthorization.mappingSemantics.omittedKey, /keeps its conventional default/);
    assert.deepEqual(handoff.capabilities.appMcpAuthorization.examples.independent.systemRoleInheritance, {
      app_owner: [],
      app_collaborator: [],
    });
    assert.deepEqual(handoff.capabilities.appMcpAuthorization.examples.custom.systemRoleInheritance, {
      app_owner: ["owner", "admin", "reviewer"],
      app_collaborator: ["admin"],
    });
    assert.equal(handoff.capabilities.appMcpAuthorization.runtimeFlow.length, 4);
    assert.match(handoff.capabilities.appMcpAuthorization.roleUi, /read-only/);
    assert.equal(handoff.capabilities.appMcpAuthorization.acceptanceChecks.length, 5);
    assert.deepEqual(handoff.capabilities.directory.returnedDepartmentFields, [
      "id",
      "name",
      "externalId",
      "parentId",
      "path",
      "status"
    ]);
    assert.ok(handoff.capabilities.directory.returnedPersonFields.includes("jobTitle"));
    assert.deepEqual(
      handoff.operationGuide.callSelection.map((operation) => operation.scenario),
      ["people_search", "organization_browse_or_department_selection", "people_in_department_scope", "department_authorization"]
    );
    assert.equal(handoff.operationGuide.organizationHierarchy.responseShape, "flat_nodes");
    assert.match(handoff.operationGuide.organizationHierarchy.displayInstruction, /path ids to names/);
    assert.match(handoff.operationGuide.organizationHierarchy.completenessInstruction, /hasMore=true/);
    assert.match(handoff.operationGuide.roleBoundary, /does not imply App membership or manager/);
    assert.ok(handoff.migration.checklist.some((item) => /smallest directory call/.test(item)));
    assert.ok(handoff.migration.checklist.some((item) => /multi-level tree/.test(item)));
    assert.ok(handoff.migration.checklist.some((item) => /no implicit hierarchy/.test(item)));
    assert.ok(handoff.migration.checklist.some((item) => /custom multi-role mappings/.test(item)));
    assert.deepEqual(handoff.capabilities.departmentAuthorization.helpers, [
      "hasDepartmentAccess",
      "requireDepartmentAccess"
    ]);
    assert.deepEqual(handoff.capabilities.departmentAuthorization.configuredDepartmentIds, ["dept-investment"]);
    assert.equal(handoff.capabilities.appMcpAuthorization.manifestSchema, "workspace.app-mcp/v1");
    assert.equal(handoff.capabilities.appMcpAuthorization.roleResolver, "WorkspaceAppRoleResolver");
  });

  it("describes company directory reads without widening App admission", async () => {
    const { appAuthSdkHandoff } = await authSdkModule();
    const handoff = appAuthSdkHandoff(appFixture({ directoryReadScope: "company" }));

    assert.equal(handoff.app.directoryReadScope, "company");
    assert.equal(handoff.capabilities.directory.directoryReadScope, "company");
    assert.equal(handoff.capabilities.directory.policyFiltered, false);
    assert.match(handoff.operationGuide.organizationHierarchy.completenessInstruction, /never grants App launch access/i);
  });

  it("reports development separately from resource and production gates", async () => {
    const { appAgentResourceContext, buildAppDeveloperContext } = await developerContextModule();
    const app = appFixture({
      status: "provisioning",
      resources: [{
        ...appFixture().resources[0],
        status: "failed"
      }]
    });
    const context = buildAppDeveloperContext(app, "2026-08-10T01:00:00.000Z");
    const mailPackage = JSON.parse(readFileSync(new URL("../../../../sdk/mail/package.json", import.meta.url), "utf8"));
    const mailSdkModule = await loadMailSdkModule();
    const mailHandoff = mailSdkModule.appMailSdkHandoff(appFixture());
    assert.equal(mailHandoff.sdk.version, mailPackage.version);
    assert.match(mailHandoff.sdk.sha256,/^[a-f0-9]{64}$/);
    assert.match(mailHandoff.examples.trigger,/verifyWorkspaceMailEvent/);
    assert.match(mailHandoff.examples.trigger,/enqueueMailEventOnce/);
    assert.equal(mailHandoff.configuration.arguments.emailEnabled,true);
    assert.equal(context.emailSending.sdk.version, mailPackage.version);
    assert.equal(context.emailSending.sdk.packageUrl, `https://apps.example.invalid/sdk/workspace-mail/v${mailPackage.version}.tgz`);
    const markdown = appAgentResourceContext(app);

    assert.equal(context.generatedAt, "2026-08-10T01:00:00.000Z");
    assert.equal(context.readiness.gates.build, "ready");
    assert.equal(context.readiness.gates.deploy, "blocked");
    assert.equal(context.readiness.gates.preview, "pending");
    assert.equal(context.readiness.gates.publish, "blocked");
    assert.equal(context.readiness.gates.rollback, "blocked");
    assert.equal(context.readiness.overall, "blocked");
    assert.ok(context.blockers.some((blocker) => blocker.code === "RESOURCE_PROVISIONING_FAILED"));
    assert.ok(context.nextActions.some((action) => action.tool === "apps_provisioning" && action.arguments?.action === "status"));
    assert.ok(context.nextActions.some((action) => action.tool === "apps_app_read" && action.arguments?.action === "auth_sdk"));
    assert.ok(context.nextActions.some((action) => action.kind === "local_action" && /project build/.test(action.reason)));
    assert.equal(context.nextActions.some((action) => /deployment package/.test(action.reason)), false);
    assert.ok(context.guidance.deploymentContract.some((item) => /fileURLToPath/.test(item)));
    assert.ok(context.guidance.deploymentContract.some((item) => /4000 characters/.test(item)));
    assert.ok(context.guidance.deploymentContract.some((item) => /runtime APP_VERSION/.test(item)));
    assert.ok(context.guidance.dataContract.some((item) => /migration file under version control/.test(item)));
    assert.match(markdown, /never pass `URL\.pathname`/);
    assert.match(markdown, /at most 4,000 characters/);
    assert.match(markdown, /make CI fail on drift/);
  });

  it("hands mailbox development to the current SDK through MCP instead of native sending instructions", async () => {
    const { appAgentResourceContext } = await developerContextModule();
    const base = appFixture();
    const app = appFixture({
      resources: [...base.resources, { type: "email_sending", status: "ready" }, { type: "email_routing", status: "ready" }],
      manifest: { ...base.manifest, email: {
        sending: { enabled: true, senderMailbox: "app-test@mail.example.invalid" },
        routing: { enabled: true, address: "app-test@mail.example.invalid", triggerEnabled: false }
      } }
    });
    const markdown = appAgentResourceContext(app);
    assert.match(markdown, /apps_app_read\(\{ action: "mail_sdk", appId: "app-test" \}\)/);
    assert.match(markdown, /checksum, complete development Prompt, bindings, runtime settings/);
    assert.match(markdown, /unified app mailbox/);
    assert.match(markdown, /emailEnabled and emailPrefix/);
    assert.match(markdown, /activation does not replay history/);
    assert.doesNotMatch(markdown, /Send transactional notifications with|available through the native Cloudflare/);
  });

  it("hands custom database parameters to MCP without exposing a password value", async () => {
    const { appAgentResourceContext, buildAppDeveloperContext } = await developerContextModule();
    const app = appFixture({
      resources: [
        ...appFixture().resources,
        {
          id: "res-hyperdrive",
          appId: "app-test",
          dataServiceId: "data-app-test",
          type: "hyperdrive_config",
          provider: "cloudflare-hyperdrive",
          resourceName: "apps-app-test-hyperdrive",
          bindingName: "HYPERDRIVE",
          environment: "prod",
          status: "placeholder",
          createdAt: "2026-08-10T00:00:00.000Z"
        }
      ],
      secrets: [{
        id: "sec-hyperdrive",
        appId: "app-test",
        name: "HYPERDRIVE_PASSWORD",
        environment: "production",
        description: "Platform-only Hyperdrive password",
        required: true,
        status: "declared",
        declaredBy: "owner-test",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z"
      }]
    });
    const context = buildAppDeveloperContext(app);
    const markdown = appAgentResourceContext(app);

    assert.equal(context.customDatabase.enabled, true);
    assert.equal(context.customDatabase.status, "configuration_required");
    assert.deepEqual(context.customDatabase.requiredDeploymentFields, ["scheme", "host", "database", "user"]);
    assert.ok(context.blockers.some((blocker) => blocker.code === "HYPERDRIVE_CONFIGURATION_REQUIRED"));
    assert.match(markdown, /hyperdrive: \{ scheme, host, port\?, database, user, originConnectionLimit\? \}/);
    assert.match(markdown, /HYPERDRIVE_PASSWORD/);
    assert.doesNotMatch(markdown, /database-password-value/);
  });
});

async function loadMailSdkModule() {
 const outdir=await mkdtemp(join(tmpdir(),"apps-mail-handoff-"));
 try {const outfile=join(outdir,"mail.mjs");await build({bundle:true,entryPoints:[new URL("./mailSdk.ts",import.meta.url).pathname],format:"esm",logLevel:"silent",outfile,platform:"neutral"});return await import(pathToFileURL(outfile).href);}finally{await rm(outdir,{recursive:true,force:true});}
}
