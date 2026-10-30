import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadUtilsModule(entryPoint = "./utils.ts") {
  const outdir = await mkdtemp(join(tmpdir(), "apps-utils-test-"));
  const outfile = join(outdir, "utils.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL(entryPoint, import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

async function loadMateModule() {
  const outdir = await mkdtemp(join(tmpdir(), "mate-model-test-"));
  const outfile = join(outdir, "mate.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("../../shared/mate.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

async function loadProductDetailModelsModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-product-detail-test-"));
  const outfile = join(outdir, "productDetailModels.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./productDetailModels.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

async function loadProductModelsModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-product-models-test-"));
  const outfile = join(outdir, "productModels.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./productModels.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

async function loadAccessTargetPickerModule() {
  const outdir = await mkdtemp(join(tmpdir(), "access-target-picker-test-"));
  const outfile = join(outdir, "AccessTargetPicker.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("../components/AccessTargetPicker.tsx", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "node"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function createInput(overrides = {}) {
  return {
    accessMode: "company",
    accessTargets: [],
    agentMcpEnabled: false,
    appCode: "",
    description: "",
    loginRequired: true,
    llmEnabled: false,
    name: "",
    resourceTypes: ["worker", "d1_database"],
    type: "web",
    ...overrides
  };
}

function catalog() {
  return {
    currentUser: {
      email: "ada@example.com",
      id: "user-ada",
      name: "Ada",
      team: "Product"
    },
    portal: { name: "Workspace" }
  };
}

describe("apps frontend domain utils", () => {
  it("shows a created Preview link only to the Mate owner", async () => {
    const { canOpenMateOwnerPreview } = await loadUtilsModule();
    const mate = { ownerUserId: "user-owner", previewReleaseId: "cortana-r8" };

    assert.equal(canOpenMateOwnerPreview(mate, { id: "user-owner", email: "owner@example.com" }), true);
    assert.equal(canOpenMateOwnerPreview(
      { ...mate, ownerUserId: "OWNER@EXAMPLE.COM" },
      { id: "user-owner-alias", email: "owner@example.com" }
    ), true);
    assert.equal(canOpenMateOwnerPreview(mate, { id: "user-other", email: "other@example.com" }), false);
    assert.equal(canOpenMateOwnerPreview(
      { ...mate, previewReleaseId: undefined },
      { id: "user-owner", email: "owner@example.com" }
    ), false);
  });

  it("preserves a trailing separator while a Mate Code is being typed", async () => {
    const { normalizeMateCode, normalizeMateCodeDraft, mateWorkEmail } = await loadMateModule();

    assert.equal(normalizeMateCodeDraft("Cortana "), "cortana-");
    assert.equal(normalizeMateCodeDraft("cortana-A"), "cortana-a");
    assert.equal(normalizeMateCode("Cortana AI"), "cortana-ai");
    assert.equal(mateWorkEmail("Cortana AI", "mate.example.invalid"), "cortana-ai@mate.example.invalid");
  });

  it("keeps an auto-generated Mate Code linked to the name until the user edits it", async () => {
    const { nextMateIdentityName } = await loadUtilsModule();

    const generated = nextMateIdentityName({ displayName: "", workEmail: "" }, "Cortana AI", false, "mate.example.invalid");
    assert.deepEqual(generated, {
      displayName: "Cortana AI",
      workEmail: "cortana-ai@mate.example.invalid"
    });

    const customized = nextMateIdentityName({
      displayName: "Cortana AI",
      workEmail: "cortana-ops@mate.example.invalid"
    }, "Cortana Wealth");
    assert.equal(customized.workEmail, "cortana-ops@mate.example.invalid");

    const editing = nextMateIdentityName({
      displayName: "Cortana AI",
      workEmail: "cortana-ai@mate.example.invalid"
    }, "Cortana Wealth", true);
    assert.equal(editing.workEmail, "cortana-ai@mate.example.invalid");
  });

  it("normalizes and validates app codes with reserved names blocked", async () => {
    const { appCodeDomainPreview, isReservedAppCode, isValidAppCode, normalizeAppCode, parseCommaList } = await loadUtilsModule();

    assert.equal(normalizeAppCode(" Semiconductor Workbench! "), "semiconductor-workbench");
    assert.equal(appCodeDomainPreview("Semiconductor Workbench", { appBaseDomain: "example.com", appHostPrefix: "app-" }), "https://app-semiconductor-workbench.example.com");
    assert.equal(isValidAppCode("semiconductor-workbench"), true);
    for (const code of [
      "ai",
      "api",
      "auth",
      "auth-service",
      "cf",
      "cf-tools",
      "d1",
      "d1-admin",
      "workspace",
      "workspace-academy",
      "k",
      "knowledge",
      "apps",
      "apps-builder",
      "live",
      "mcp",
      "sqlite",
      "sqlite-browser",
      "token",
      "users",
      "users-admin"
    ]) {
      assert.equal(isValidAppCode(code), false);
      assert.equal(isReservedAppCode(code), true);
    }
    assert.equal(isValidAppCode("-bad"), false);
    assert.equal(isReservedAppCode("portfolio-workbench"), false);
    assert.deepEqual(parseCommaList("alpha, beta\ngamma，delta"), ["alpha", "beta", "gamma", "delta"]);
  });

  it("copies apps_get_app as the canonical MCP handoff with the signed URL as fallback", async () => {
    const { appAgentHandoffClipboardText } = await loadUtilsModule();
    const translations = {
      "apps.handoff.ttlText": ({ minutes }) => `, ttl ${minutes}`,
      "apps.handoff.clipboardIntro": () => "Canonical developer context",
      "apps.handoff.clipboardApp": ({ appId, name }) => `App: ${name} (${appId})`,
      "apps.handoff.clipboardMcp": ({ appId }) => `apps_get_app({ appId: \"${appId}\" }) then apps_get_auth_sdk from nextActions`,
      "apps.handoff.clipboardFallback": () => "Signed URL fallback",
      "apps.handoff.clipboardUrl": ({ ttl, url }) => `Handoff URL${ttl}: ${url}`
    };
    const t = (key, values = {}) => translations[key](values);
    const text = appAgentHandoffClipboardText(
      { id: "app-context", name: "Context App" },
      "https://apps.example.test/apps/app-context/handoff.md?h=token",
      Math.ceil(Date.now() / 1000) + 300,
      t
    );

    assert.match(text, /apps_get_app\(\{ appId: "app-context" \}\)/);
    assert.match(text, /apps_get_auth_sdk from nextActions/);
    assert.match(text, /Signed URL fallback/);
    assert.match(text, /handoff\.md\?h=token/);
    assert.doesNotMatch(text, /apps_get_app_handoff|apps_get_service_context/);
  });

  it("copies app-specific mail instructions that discover the SDK and resources at execution time", async () => {
    const { appHasMailResource, appMailDevelopmentPrompt } = await loadUtilsModule("./mailDevelopmentPrompt.ts");
    const app = {
      id: "app-mail-first", name: "Mail App", resources: [{ type: "email_sending" }],
      manifest: { email: { sending: { senderMailbox: "first@mail.example.invalid" }, routing: { triggerEnabled: true } } },
      secrets: [{ name: "WORKSPACE_MAIL_TOKEN", value: "private-value-never-copy" }]
    };
    assert.equal(appHasMailResource(app), true);
    assert.equal(appHasMailResource({ ...app, resources: [{ type: "email_routing" }] }), true);
    assert.equal(appHasMailResource({ ...app, resources: [] }), false);
    for (const locale of ["zh-CN", "en"]) {
      const text = appMailDevelopmentPrompt(app, locale);
      assert.match(text, /action: "get", appId: "app-mail-first"/);
      assert.match(text, /action: "mail_sdk", appId: "app-mail-first"/);
      assert.match(text, /first@mail\.example\.invalid/);
      assert.match(text, /ping_who_am_i/);
      assert.match(text, /emailEnabled=true/);
      assert.match(text, /verifyWorkspaceMailEvent/);
      assert.match(text, /acknowledgeWorkspaceMailEvent/);
      assert.match(text, /idempotencyKey/);
      assert.match(text, /nextBodyOffset/);
      assert.match(text, /保留 MCP 返回的地址和 Trigger 状态|preserve the address and Trigger state/);
      assert.doesNotMatch(text, /private-value-never-copy|\/sdk\/workspace-mail\/v|\d+\.\d+\.\d+\.tgz/);
      const other = appMailDevelopmentPrompt({ ...app, id: "app-mail-second" }, locale);
      assert.match(other, /app-mail-second/);
      assert.doesNotMatch(other, /app-mail-first/);
    }
  });

  it("includes the mail development Prompt in the environment clipboard handoff", async () => {
    const { appAgentHandoffClipboardText } = await loadUtilsModule();
    const text = appAgentHandoffClipboardText(
      { id: "app-mail", name: "Mail App" }, "https://apps.example.test/handoff.md", undefined,
      (key) => key, "Read latest mail SDK and resources through MCP for app-mail"
    );
    assert.match(text, /Read latest mail SDK and resources through MCP for app-mail$/);
  });

  it("copies Stream access and authorization instructions whenever the App selected Stream", async () => {
    const { appAgentHandoffClipboardText } = await loadUtilsModule();
    const app = { id: "app-stream", name: "Stream App", resources: [{ type: "media" }],
      secrets: [{ name: "WORKSPACE_STREAM_TOKEN", value: "private-runtime-value" }] };
    const text = appAgentHandoffClipboardText(app, "https://apps.example.test/handoff.md", undefined, key => key);
    assert.match(text, /App ID: app-stream/);
    assert.match(text, /WORKSPACE_STREAM_TOKEN/);
    assert.match(text, /\/v1\/uploads/);
    assert.match(text, /\/playback/);
    assert.match(text, /workspace upload/);
    assert.doesNotMatch(text, /private-runtime-value/);
    const noStream = appAgentHandoffClipboardText({ ...app, resources: [] }, "https://apps.example.test/handoff.md", undefined, key => key);
    assert.doesNotMatch(noStream, /WORKSPACE_STREAM_TOKEN/);
  });

  it("builds a latest-source collaboration handoff with folder confirmation and release verification", async () => {
    const { appAgentSourceCollaborationClipboardText } = await loadUtilsModule();
    const translations = {
      "apps.handoff.ttlText": ({ minutes }) => `, ttl ${minutes}`,
      "apps.handoff.clipboardIntro": () => "Canonical developer context",
      "apps.handoff.clipboardApp": ({ appId, name }) => `App: ${name} (${appId})`,
      "apps.handoff.clipboardMcp": ({ appId }) => `get context ${appId}`,
      "apps.handoff.clipboardFallback": () => "Signed URL fallback",
      "apps.handoff.clipboardUrl": ({ ttl, url }) => `Handoff URL${ttl}: ${url}`,
      "apps.handoff.collaborationIntro": () => "Download the latest published source",
      "apps.handoff.collaborationAppInfo": ({ appCode, appId, name, productionUrl }) => `${name}|${appId}|${appCode}|${productionUrl}`,
      "apps.handoff.collaborationPublishedInfo": ({ snapshotId, version }) => `${version}|${snapshotId}`,
      "apps.handoff.collaborationDownload": ({ appId }) => `download_source ${appId} to temporary location`,
      "apps.handoff.collaborationFolder": () => "confirm the final local collaboration folder",
      "apps.handoff.collaborationVerify": () => "verify deploymentVersion sourceSnapshotId packageSha256",
      "apps.handoff.collaborationGuard": () => "do not edit, commit, or deploy"
    };
    const t = (key, values = {}) => translations[key](values);
    const text = appAgentSourceCollaborationClipboardText({
      appCode: "portfolio-tracker",
      deployments: [
        { createdAt: "2026-08-20T00:00:00Z", sourceSnapshotId: "snap-old", status: "published", version: "1.0.0" },
        { createdAt: "2026-08-24T00:00:00Z", sourceSnapshotId: "snap-current", status: "published", version: "1.2.0" }
      ],
      id: "app-context",
      name: "Portfolio Tracker",
      productionUrl: "https://portfolio-tracker.example.test",
      slug: "portfolio-tracker"
    }, "https://apps.example.test/handoff.md?h=token", undefined, t);

    assert.match(text, /download_source app-context/);
    assert.match(text, /1\.2\.0\|snap-current/);
    assert.doesNotMatch(text, /1\.0\.0\|snap-old/);
    assert.match(text, /confirm the final local collaboration folder/);
    assert.match(text, /packageSha256/);
    assert.match(text, /do not edit, commit, or deploy/);
  });

  it("only submits editable App metadata", async () => {
    const { appsAppInfoUpdatePayload } = await loadUtilsModule();
    const input = {
      appCode: "pb-supply-chain",
      name: "PB Supply Chain Agent",
      note: "Updated note"
    };

    assert.deepEqual(appsAppInfoUpdatePayload(input), {
      description: "Updated note",
      name: "PB Supply Chain Agent"
    });
  });

  it("switches create templates while preserving the explicit access policy", async () => {
    const { nextAgentMcpInput, nextCreateTypeInput, resourceTypesForCreate } = await loadUtilsModule();

    const staticPage = nextCreateTypeInput(createInput({
      accessMode: "targeted",
      accessTargets: ["department:finance"],
      agentMcpEnabled: true,
      llmEnabled: true
    }), "static_page");

    assert.equal(staticPage.accessMode, "targeted");
    assert.deepEqual(staticPage.accessTargets, ["department:finance"]);
    assert.equal(staticPage.agentMcpEnabled, false);
    assert.equal(staticPage.llmEnabled, false);
    assert.deepEqual(resourceTypesForCreate(staticPage), ["pages_project"]);

    const agentApp = nextCreateTypeInput(createInput({ type: "web" }), "agent_app");
    assert.equal(agentApp.agentMcpEnabled, true);
    assert.deepEqual(resourceTypesForCreate(agentApp), ["worker", "d1_database", "schema_registry"]);

    const web = nextAgentMcpInput(nextCreateTypeInput(createInput({ type: "static_page" }), "web"), true);
    assert.equal(web.agentMcpEnabled, true);
    assert.deepEqual(resourceTypesForCreate(web), ["worker", "d1_database", "schema_registry"]);

    const automation = nextAgentMcpInput(nextCreateTypeInput(createInput({ type: "web" }), "automation"), true);
    assert.equal(automation.agentMcpEnabled, true);
    assert.deepEqual(resourceTypesForCreate(automation), ["worker", "cron_trigger", "schema_registry"]);
  });

  it("hides access scope through the public login toggle and restores the collaborators default", async () => {
    const { nextLoginRequiredInput } = await loadUtilsModule();
    const publicInput = nextLoginRequiredInput(createInput({ accessMode: "company" }), false);
    assert.equal(publicInput.loginRequired, false);
    assert.equal(publicInput.accessMode, "public");
    assert.deepEqual(publicInput.accessTargets, []);

    const authenticatedInput = nextLoginRequiredInput(publicInput, true);
    assert.equal(authenticatedInput.loginRequired, true);
    assert.equal(authenticatedInput.accessMode, "private");
    assert.deepEqual(authenticatedInput.accessTargets, []);
  });

  it("keeps advanced apps on the worker runtime and adds schema registry for MCP", async () => {
    const {
      customRuntimeResourceTypesForCreate,
      nextAgentMcpInput,
      nextCreateTypeInput,
      resourceTypesForCreate,
      toggleCustomResourceType
    } = await loadUtilsModule();

    const custom = nextCreateTypeInput(createInput({ type: "web" }), "container");
    assert.deepEqual(customRuntimeResourceTypesForCreate(custom), ["worker"]);
    assert.deepEqual(resourceTypesForCreate(custom), ["worker"]);

    const withIgnoredPages = toggleCustomResourceType(custom, "pages_project");
    assert.deepEqual(resourceTypesForCreate(withIgnoredPages), ["worker"]);

    const withIgnoredEmail = toggleCustomResourceType(custom, "email_sending");
    assert.deepEqual(resourceTypesForCreate(withIgnoredEmail), ["worker"]);

    const withIgnoredSchema = toggleCustomResourceType(custom, "schema_registry");
    assert.deepEqual(resourceTypesForCreate(withIgnoredSchema), ["worker"]);

    const withIgnoredLogs = toggleCustomResourceType(custom, "logs_audit");
    assert.deepEqual(resourceTypesForCreate(withIgnoredLogs), ["worker"]);

    const withD1 = toggleCustomResourceType(custom, "d1_database");
    assert.deepEqual(resourceTypesForCreate(withD1), ["worker", "d1_database"]);

    const withMcp = nextAgentMcpInput(withD1, true);
    assert.equal(withMcp.agentMcpEnabled, true);
    assert.deepEqual(resourceTypesForCreate(withMcp), ["worker", "d1_database", "schema_registry"]);
  });

  it("derives access targets from the selected visibility mode", async () => {
    const { createAccessTargets, nextAccessModeInput, toggleCreateAccessTarget } = await loadUtilsModule();
    const portalCatalog = catalog();

    const privateInput = nextAccessModeInput(createInput(), "private", portalCatalog);
    assert.deepEqual(createAccessTargets(privateInput, portalCatalog), ["user:user-ada"]);

    const targeted = toggleCreateAccessTarget(nextAccessModeInput(createInput(), "targeted", portalCatalog), "department:finance");
    assert.deepEqual(createAccessTargets(targeted, portalCatalog), ["department:finance"]);

    const company = nextAccessModeInput(targeted, "company", portalCatalog);
    assert.deepEqual(createAccessTargets(company, portalCatalog), []);
  });

  it("keeps organization ancestors while filtering the shared access picker", async () => {
    const {
      accessTargetPickerNodesFromUsers,
      filterAccessTargetNodes,
      selectedAccessTargets
    } = await loadAccessTargetPickerModule();
    const nodes = accessTargetPickerNodesFromUsers({
      departmentDetail: "Department",
      unassignedDepartment: "Unassigned",
      users: [{
        department: "GH / Investment Research",
        departmentId: "dept-research",
        departmentPath: ["dept-gh", "dept-research"],
        email: "ada@example.com",
        id: "user-ada",
        name: "Ada"
      }, {
        department: "Gentleman / Trading",
        departmentId: "dept-trading",
        departmentPath: ["dept-gentleman", "dept-trading"],
        email: "bob@example.com",
        id: "user-bob",
        name: "Bob"
      }]
    });

    assert.deepEqual(nodes.map((node) => node.label), ["Gentleman", "GH"]);
    const filtered = filterAccessTargetNodes(nodes, "ada@example.com");
    assert.equal(filtered[0].label, "GH");
    assert.equal(filtered[0].children[0].label, "Investment Research");
    assert.equal(filtered[0].children[0].children[0].label, "Ada");
    assert.deepEqual(
      selectedAccessTargets(nodes, ["department:dept-gh", "user:missing"]).map(({ label, type }) => ({ label, type })),
      [{ label: "GH", type: "department" }, { label: "missing", type: "user" }]
    );
  });

  it("uses the same complete ID-based tree in Knowledge and APPS/Mate, including empty departments", async () => {
    const { appsAccessTargetTree } = await loadUtilsModule();
    const { accessTargetPickerNodesFromUsers, selectedAccessTargets } = await loadAccessTargetPickerModule();
    const departments = [
      { id: "org", name: "Organization" },
      { id: "group", name: "Group", parentId: "org" },
      { id: "am", name: "Account Manager", parentId: "group" },
      { id: "empty", name: "Empty team", parentId: "group" }
    ];
    const users = [{ id: "ada", name: "Ada", email: "ada@example.test", department: "Account Manager", departmentId: "am", departmentPath: ["org", "group", "am"] }];
    const knowledge = accessTargetPickerNodesFromUsers({ departments, departmentDetail: "Department", unassignedDepartment: "Unassigned", users });
    const apps = appsAccessTargetTree(catalog(), { department: "Department", unassignedDepartment: "Unassigned" }, users, departments);
    const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children ?? [])]);
    assert.deepEqual(flatten(apps).map(n => n.value).sort(), flatten(knowledge).map(n => n.value).sort());
    for (const nodes of [apps, knowledge]) {
      assert.equal(nodes[0].label, "Organization");
      assert.equal(flatten(nodes).find(n => n.value === "department:empty").label, "Empty team");
      assert.equal(flatten(nodes).find(n => n.value === "department:am").children[0].value, "user:ada");
      assert.equal(selectedAccessTargets(nodes, ["department:am"])[0].tagDetail, "Organization / Group / Account Manager");
    }
  });

  it("enables handoff for a provisioned app while its first Pages route initializes", async () => {
    const { appDevelopmentResourcesReady } = await loadProductDetailModelsModule();
    const readyApp = {
      status: "draft",
      resources: [
        { status: "ready" },
        { status: "ready" }
      ],
      domains: [
        { routeStatus: "active", status: "reserved" }
      ]
    };

    assert.equal(appDevelopmentResourcesReady({
      ...readyApp,
      status: "provisioning"
    }), false);
    assert.equal(appDevelopmentResourcesReady({
      ...readyApp,
      resources: [{ status: "queued" }]
    }), false);
    assert.equal(appDevelopmentResourcesReady({
      ...readyApp,
      domains: [{ routeStatus: "unknown", status: "reserved" }]
    }), false);
    assert.equal(appDevelopmentResourcesReady({
      ...readyApp,
      domains: [{ routeStatus: "initializing", status: "reserved" }]
    }), true);
    assert.equal(appDevelopmentResourcesReady(readyApp), true);
  });

  it("turns App and Skill lifecycle states into one sequential current step", async () => {
    const { appsProductProgressSteps } = await loadProductDetailModelsModule();
    const t = (key) => key;
    const readyApp = {
      status: "published",
      productionUrl: "https://risk-review.example.test",
      deployments: [],
      resources: [{ status: "ready" }],
      domains: [{ routeStatus: "active", status: "registered" }]
    };
    const appProduct = { id: "app-1", type: "app" };

    assert.deepEqual(
      appsProductProgressSteps({ app: readyApp, product: appProduct }, t).map((step) => step.state),
      ["ready", "ready", "pending", "idle"]
    );
    const previewSteps = appsProductProgressSteps({
      app: {
        ...readyApp,
        status: "draft",
        deployments: [{ status: "ready" }]
      },
      product: appProduct
    }, t);
    assert.deepEqual(previewSteps.map((step) => step.state), ["ready", "ready", "pending", "idle"]);
    assert.equal(previewSteps[1].detail, "apps.progress.appPreviewReady");

    const undeployedSteps = appsProductProgressSteps({
      app: {
        ...readyApp,
        status: "draft",
        deployments: []
      },
      product: appProduct
    }, t);
    assert.deepEqual(undeployedSteps.map((step) => step.state), ["ready", "pending", "idle", "idle"]);
    assert.equal(undeployedSteps[1].detail, "apps.progress.appWaitingProduction");

    assert.deepEqual(
      appsProductProgressSteps({
        app: readyApp,
        listing: { status: "listed" },
        product: appProduct
      }, t).map((step) => step.state),
      ["ready", "ready", "ready", "ready"]
    );

    assert.deepEqual(
      appsProductProgressSteps({
        product: { id: "skill-1", type: "skill" },
        skill: { currentVersion: "1.0.0", versions: [] }
      }, t).map((step) => step.state),
      ["ready", "pending", "idle"]
    );
  });

  it("assigns compact Basic info spans and readable value formats", async () => {
    const { appsProductBasicInfoRows } = await loadProductDetailModelsModule();
    const t = (key) => key;

    const appRows = appsProductBasicInfoRows({
      app: {
        appCode: "risk-review",
        description: "Review controlled contracts.",
        name: "Contract Risk Review",
        productionUrl: "https://risk-review.example.test",
        slug: "risk-review"
      },
      type: "app"
    }, undefined, t);
    assert.deepEqual(appRows.map(({ format, span }) => ({ format, span })), [
      { format: "primary", span: 7 },
      { format: "code", span: 5 },
      { format: undefined, span: 12 },
      { format: "prose", span: 12 }
    ]);

    const skillRows = appsProductBasicInfoRows({
      appsSkill: {
        capabilities: ["review", "risk"],
        currentVersion: "1.0.0",
        description: "Reusable risk review instructions.",
        name: "Risk Review Skill",
        slug: "risk-review-skill"
      },
      type: "skill"
    }, undefined, t);
    assert.equal(skillRows.at(-1).format, "tags");
    assert.deepEqual(skillRows.slice(0, 3).map((row) => row.span), [5, 4, 3]);
  });

  it("builds a compact resource inventory with separate status and environment labels", async () => {
    const { appsDevelopmentResourceItems } = await loadProductDetailModelsModule();
    const t = (key) => key;
    const items = appsDevelopmentResourceItems({
      domains: [{
        environment: "production",
        hostname: "risk-review.example.test",
        status: "registered",
        type: "production"
      }],
      resources: [{
        environment: "production",
        provider: "cloudflare",
        resourceName: "apps-risk-review-email",
        status: "ready",
        type: "email_sending"
      }, {
        environment: "production",
        provider: "cloudflare",
        resourceName: "apps-risk-review-worker",
        status: "ready",
        type: "worker"
      }, {
        environment: "production",
        provider: "cloudflare",
        resourceName: "apps-risk-review-db",
        status: "ready",
        type: "d1_database"
      }]
    }, undefined, t);

    assert.deepEqual(items.map((item) => item.type), ["d1_database", "worker", "domain_production", "email_sending"]);
    assert.deepEqual(items.map((item) => item.state), ["ready", "ready", "ready", "ready"]);
    assert.ok(items.every((item) => item.environment === "apps.environment.production"));
    assert.ok(items.every((item) => !item.status.includes("/")));
  });

  it("treats same-organization collaborators as full APPS authors", async () => {
    const { isCurrentAppsAuthor, isCurrentAppsOwner } = await loadProductDetailModelsModule();
    const currentUser = {
      avatarUrl: "https://avatars.example.com/ada.png",
      email: "ada@example.com",
      id: "user-ada",
      identity: { objectId: "entra-ada", principalName: "ada@example.com" },
      name: "Ada",
      team: "Product"
    };

    assert.equal(isCurrentAppsOwner("owner-other", currentUser), false);
    assert.equal(isCurrentAppsAuthor("owner-other", ["user-ada"], currentUser), true);
    assert.equal(isCurrentAppsAuthor("owner-other", ["ENTRA-ADA"], currentUser), true);
    assert.equal(isCurrentAppsAuthor("owner-other", ["user-other"], currentUser), false);
  });

  it("resolves owner and collaborators into a stable, deduplicated author group", async () => {
    const { appsProductAuthors } = await loadProductModelsModule();
    const currentUser = {
      avatarUrl: "https://avatars.example.com/ada.png",
      email: "ada@example.com",
      id: "user-ada",
      identity: { objectId: "entra-ada", principalName: "ada@example.com" },
      name: "Ada",
      team: "Product"
    };
    const authors = appsProductAuthors({
      app: {
        collaboratorUserIds: ["user-ada", "ada@example.com"],
        ownerUserId: "owner-grace"
      },
      id: "app:coauthored",
      name: "Coauthored App",
      owner: "Product",
      type: "app"
    }, currentUser, [{
      email: "grace@example.com",
      id: "owner-grace",
      name: "Grace"
    }, {
      email: "ada@example.com",
      id: "user-ada",
      name: "Ada"
    }]);

    assert.deepEqual(authors, [{ avatarUrl: undefined, id: "owner-grace", name: "Grace" }, {
      avatarUrl: "https://avatars.example.com/ada.png",
      id: "user-ada",
      name: "Ada"
    }]);
  });

  it("matches APPS owners and collaborators across current-user identity aliases", async () => {
    const { buildAppsProductItems, isCurrentAppsAssetAuthor } = await loadProductModelsModule();
    const currentUser = {
      email: "sample.user@example.invalid",
      id: "user-current",
      identity: {
        objectId: "entra-current",
        principalName: "sample.user@example.invalid"
      },
      team: "Product"
    };

    const ownedApp = {
      id: "app-owned",
      ownerUserId: "user-current",
      collaboratorUserIds: [],
      name: "Owned App",
      ownerTeamId: "Product",
      status: "draft",
      description: "Owned app",
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    const collaboratedSkill = {
      id: "skill-collaborated",
      ownerUserId: "user-other",
      collaboratorUserIds: ["ENTRA-CURRENT"],
      name: "Collaborated Skill",
      kind: "vanilla",
      status: "private",
      description: "Collaborated skill",
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    const unrelatedSkill = {
      ...collaboratedSkill,
      id: "skill-unrelated",
      collaboratorUserIds: ["user-someone-else"],
      name: "Unrelated Skill",
      visibility: "org"
    };

    assert.equal(isCurrentAppsAssetAuthor(ownedApp, currentUser), true);
    assert.equal(isCurrentAppsAssetAuthor(collaboratedSkill, currentUser), true);
    assert.equal(isCurrentAppsAssetAuthor(unrelatedSkill, currentUser), false);
    assert.deepEqual(buildAppsProductItems({
      apps: [ownedApp],
      marketByTarget: new Map(),
      skills: [collaboratedSkill]
    }).map((product) => product.id), ["app:app-owned", "skill:skill-collaborated"]);
  });

  it("uses Publication only to decorate targets already present in My APPS inventory", async () => {
    const { buildAppsProductItems, appsPublicationByTarget } = await loadProductModelsModule();
    const inventoryListing = {
      id: "listing-inventory-skill",
      targetPlane: "apps",
      targetId: "skill-inventory",
      type: "skill",
      name: "Inventory Skill",
      status: "listed",
      summary: "Listed inventory skill",
      description: "Listed inventory skill",
      tags: [],
      updatedAt: "2026-07-01T00:00:00.000Z"
    };
    const staleListing = {
      ...inventoryListing,
      id: "listing-stale",
      targetId: "skill-stale",
      name: "Stale Publication Skill",
      ownerProfiles: [{ id: "user-current", name: "Current User", email: "current@example.com" }],
      submittedByProfile: { id: "user-current", email: "current@example.com" }
    };
    const marketByTarget = appsPublicationByTarget(
      [inventoryListing, staleListing],
      new Set(["skill-inventory"])
    );
    assert.deepEqual([...marketByTarget.keys()], ["skill-inventory"]);

    const products = buildAppsProductItems({
      apps: [],
      marketByTarget,
      skills: [{
        id: "skill-inventory",
        ownerUserId: "user-current",
        collaboratorUserIds: [],
        name: "Inventory Skill",
        kind: "vanilla",
        status: "private",
        description: "Inventory Skill",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }]
    });

    assert.deepEqual(products.map((product) => product.id), ["skill:skill-inventory"]);
    assert.equal(products[0].marketListing?.id, "listing-inventory-skill");
  });
});
