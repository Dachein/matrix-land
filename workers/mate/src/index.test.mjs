import { testInstallation } from "../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { taskModelStream } from "./taskAgentTestModel.mjs";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { zipSync, strToU8 } from "fflate";
import { mateChatInstanceName } from "./chatAddress.ts";
import { handleMateRuntimeRequest } from "./index.ts";
import { createConversationTools } from "./conversationAgent.ts";
import { MateTaskRunner } from "./taskRunner.ts";
import { startTask } from "./storage.ts";

function taskRunnerNamespace(bindings) {
  const runners = new Map();
  return {
    runners,
    idFromName(name) { return name; },
    get(name) {
      if (!runners.has(name)) {
        const values = new Map();
        let alarm = null;
        const storage = {
          async get(key) { return values.get(key); },
          async put(key, value) { values.set(key, structuredClone(value)); },
          async delete(key) { return values.delete(key); },
          async getAlarm() { return alarm; },
          async setAlarm(time) { alarm = time; },
          async deleteAlarm() { alarm = null; }
        };
        runners.set(name, { storage, runner: new MateTaskRunner({ storage, blockConcurrencyWhile: (fn) => fn() }, bindings) });
      }
      return runners.get(name).runner;
    },
    async fire() {
      for (const { storage, runner } of runners.values()) {
        await storage.deleteAlarm();
        await runner.alarm();
      }
    }
  };
}

class D1Adapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database.prepare(sql)); }
  async batch(statements) { const output = []; for (const statement of statements) output.push(await statement.run()); return output; }
}

class Statement {
  constructor(statement, params = []) { this.statement = statement; this.params = params; }
  bind(...params) { return new Statement(this.statement, params); }
  async all() { return { results: this.statement.all(...this.params) }; }
  async first() { return this.statement.get(...this.params) ?? null; }
  async run() {
    const result = this.statement.run(...this.params);
    return { meta: { changes: Number(result.changes ?? 0) }, success: true };
  }
}

function fakeChatAgentNamespace() {
  const calls = { destroySchedules: [], fetches: [], gets: [], idFromNames: [] };
  return {
    calls,
    namespace: {
      idFromName(name) {
        calls.idFromNames.push(name);
        return { name };
      },
      get(id, options) {
        calls.gets.push({ id, options });
        return {
          async _cf_scheduleDestroy() {
            calls.destroySchedules.push(id.name);
          },
          async fetch(request) {
            calls.fetches.push(request.clone());
            return Response.json({ agentInstanceName: id.name, forwarded: true }, {
              headers: new URL(request.url).pathname === "/workspace-chat-history" ? { "X-Workspace-Chat-Next-Cursor": "message-page-end" } : {}
            });
          }
        };
      }
    }
  };
}

function runtimeDefinition() {
  const manifest = JSON.parse(readFileSync(new URL("../../../schemas/workspace.agentruntime/examples/portfolio-banker-mate.candidate.json", import.meta.url), "utf8"));
  manifest.mate.mateId = "knowledge-mate";
  manifest.mate.ownerUserId = "owner-1";
  manifest.invocationPolicy.visibility = "organization";
  manifest.channels.embedded.enabled = true;
  manifest.taskPolicy.defaultExecutor = "knowledge_qa";
  manifest.release.releaseId = "knowledge-mate-r1";
  manifest.release.status = "published";
  return {
    mate: {
      id: "knowledge-mate",
      orgId: "org-1",
      ownerUserId: "owner-1",
      displayName: "Knowledge Mate",
      jobRole: "Answer from authorized knowledge",
      description: "Preview Knowledge Mate",
      visibility: "organization",
      updatedAt: "2026-08-20T00:00:00.000Z"
    },
    release: {
      id: "knowledge-mate-r1",
      mateId: "knowledge-mate",
      version: 1,
      status: "published",
      manifestSha256: `sha256:${"a".repeat(64)}`,
      manifest,
      documents: [
        { id: manifest.release.soul.id, kind: "soul", version: 1, digest: manifest.release.soul.digest, content: "# Knowledge Soul\n\nUse authorized evidence." },
        { id: manifest.release.handbooks[0].id, kind: "handbook", version: 1, digest: manifest.release.handbooks[0].digest, content: "# Knowledge Handbook\n\nSearch, read, and cite." }
      ],
      createdBy: "owner-1",
      createdAt: "2026-08-20T00:00:00.000Z"
    }
  };
}

function portfolioAppManifest() {
  return {
    schemaVersion: "workspace.app-mcp/v1",
    appId: "portfolio-tracker",
    name: "Portfolio Tracker",
    baseUrl: "https://portfolio-tracker.test",
    audience: "https://portfolio-tracker.test",
    resourceId: "app-mcp:portfolio-tracker",
    toolDefinitionVersion: "portfolio-tools-v1",
    authorization: {
      model: "app-rbac",
      defaultRole: "member",
      resourceTokenHeader: "authorization",
      systemRoleInheritance: { app_owner: ["member"], app_collaborator: ["member"] },
      toolsEndpoint: "/mcp/tools",
      toolsEndpointScope: "portfolio:tools:read",
      roles: [{ id: "member", name: "Member" }]
    },
    tools: [
      {
        name: "portfolio_client_read",
        description: "Read one client portfolio",
        method: "GET",
        path: "/mcp/clients/read",
        allowedRoles: ["member"],
        requiredScopes: ["portfolio:client:read"],
        readOnly: true,
        riskLevel: "low",
        requiresConfirmation: false,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["clientId"],
          properties: { clientId: { type: "string" } }
        }
      },
      {
        name: "portfolio_follow_up_list",
        description: "List current-user follow ups",
        method: "GET",
        path: "/mcp/follow-ups",
        allowedRoles: ["member"],
        requiredScopes: ["portfolio:follow-up:read"],
        readOnly: true,
        riskLevel: "low",
        requiresConfirmation: false,
        inputSchema: { type: "object", additionalProperties: false, properties: {} }
      },
      {
        name: "portfolio_client_update",
        description: "Update one client portfolio",
        method: "POST",
        path: "/mcp/clients/update",
        allowedRoles: ["member"],
        requiredScopes: ["portfolio:client:write"],
        readOnly: false,
        riskLevel: "medium",
        requiresConfirmation: true,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["clientId", "note"],
          properties: { clientId: { type: "string" }, note: { type: "string" } }
        }
      }
    ]
  };
}

function env({ definition = runtimeDefinition() } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../db/migrations/0002_runtime_v1.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../db/migrations/0003_cortana_inbox.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../db/migrations/0005_configured_schedules.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../db/migrations/0010_work_threads.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../db/migrations/0006_chat_ingress.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../db/migrations/0007_conversation_turn_projection.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../db/migrations/0008_conversation_lifecycle.sql", import.meta.url), "utf8"));
  const knowledgeCalls = [];
  const modelCalls = [];
  const appCalls = [];
  const appRegistryCalls = [];
  const authCalls = [];
  const chatAgent = fakeChatAgentNamespace();
  const deniedAppUsers = new Set();
  const appManifest = portfolioAppManifest();
  return { ...testInstallation,
    DEFAULT_MATE_ID: "knowledge-mate",
    DEV_AUTH_BYPASS: "1",
    RUNTIME_DB: new D1Adapter(database),
    MATE_CHAT_AGENT: chatAgent.namespace,
    MATE_CHAT_GRANT_SECRET: "test-mate-chat-grant-secret-with-at-least-32-characters",
    MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token",
    APPS_CONTROL_PLANE: {
      async fetch(request) {
        assert.equal(request.headers.get("authorization"), "Bearer runtime-service-token");
        const url = new URL(request.url);
        if (url.pathname === "/internal/runtime/default-mailbox") return Response.json({ mailbox: null });
        if (url.pathname === "/internal/runtime/app-mcp/portfolio-tracker") {
          const userId = request.headers.get("x-workspace-runtime-user-id");
          appRegistryCalls.push({ userId, request: request.clone() });
          if (deniedAppUsers.has(userId)) return Response.json({ error: "app_mcp_not_accessible" }, { status: 404 });
          return Response.json({
            deploymentId: "portfolio-deployment-1",
            manifest: appManifest,
            manifestSha256: `sha256:${"b".repeat(64)}`
          });
        }
        return Response.json(definition);
      }
    },
    AUTH_SERVICE: {
      async fetch(request) {
        assert.equal(request.headers.get("authorization"), "Bearer mate-auth-service-token");
        const body = await request.json();
        authCalls.push(body);
        const userId = body.principal?.sub;
        if (deniedAppUsers.has(userId)) return Response.json({ error: "app_access_denied" }, { status: 403 });
        return Response.json({ access_token: `resource:${userId}:${body.toolName || "tools"}:${authCalls.length}` });
      }
    },
    APP_MCP_SERVICE: {
      async fetch(request) {
        const url = new URL(request.url);
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
        const userId = token.split(":")[1];
        appCalls.push({ method: request.method, request: request.clone(), token, url, userId });
        if (deniedAppUsers.has(userId)) return Response.json({ error: "revoked" }, { status: 403 });
        if (url.pathname === "/mcp/tools") {
          return Response.json({
            policyVersion: `policy-${userId}-1`,
            tools: appManifest.tools.map((tool) => ({ name: tool.name }))
          });
        }
        if (url.pathname === "/mcp/clients/read" && request.method === "GET") {
          return Response.json({ clientId: url.searchParams.get("clientId"), subjectUserId: userId });
        }
        if (url.pathname === "/mcp/clients/update" && request.method === "POST") {
          return Response.json({ ...(await request.json()), subjectUserId: userId, updated: true });
        }
        return Response.json({ error: "unexpected_app_call" }, { status: 404 });
      }
    },
    AUTH_WORKER_URL: "https://auth.example.invalid",
    MATE_AUTH_SERVICE_TOKEN: "mate-auth-service-token",
    KNOWLEDGE_SERVICE: {
      async fetch(request) {
        knowledgeCalls.push(request.clone());
        if (request.headers.has("authorization")) {
          assert.match(request.headers.get("authorization"), /^Bearer resource:[^:]+:workspace_mate_knowledge_read:/);
        } else assert.equal(request.headers.get("x-workspace-scopes"), "workspace:knowledge:read");
        const url = new URL(request.url);
        if (url.pathname === "/api/knowledge-services") return Response.json({ services: [
          { name: "Portfolio Policies", serviceId: "portfolio-policies" },
          { name: "Unconfigured Private Base", serviceId: "private-extra" }
        ] });
        if (url.pathname === "/api/knowledge-services/portfolio-policies/query") {
          const body = await request.json();
          if (body.action === "search") return Response.json({ results: [{ objectId: "policy-1", relativePath: "policies/kyc.md", snippet: "KYC must be reviewed annually." }] });
          if (body.action === "read") return Response.json({
            file: { fileName: "kyc.md", objectId: "policy-1", relativePath: "policies/kyc.md" },
            content: { encoding: "text", text: "KYC must be reviewed annually." }
          });
        }
        throw new Error(`unexpected knowledge request: ${request.url}`);
      }
    },
    LITELLM_SERVICE: {
      async fetch(request) {
        modelCalls.push(request.clone());
        assert.equal(request.headers.get("authorization"), "Bearer preview-llm-token");
        const body = await request.json();
        assert.match(body.messages[0].content, /Knowledge Soul/);
        const toolNames = (body.tools ?? []).map(tool => tool.function.name);
        if (!toolNames.includes("knowledge_base_search")) return taskModelStream({ text: "No selected Knowledge tools are available." });
        const results = body.messages.filter(message => message.role === "tool");
        if (!results.length) return taskModelStream({ tool: "knowledge_base_search", args: { query: "KYC", limitPerService: 5 } }, "search");
        if (results.length === 1) return taskModelStream({ tool: "knowledge_file_read", args: { serviceId: "portfolio-policies", objectId: "policy-1" } }, "read");
        return taskModelStream({ text: "KYC 需要每年复核。[Portfolio Policies · policies/kyc.md]" });
      }
    },
    MATE_LLM_KEY: "preview-llm-token",
    appCalls,
    appRegistryCalls,
    authCalls,
    chatAgentCalls: chatAgent.calls,
    definition,
    deniedAppUsers,
    knowledgeCalls,
    modelCalls
  };
}

function request(path, { body, departmentId, departmentPath, method = "GET", scopes, userId = "user-a" } = {}) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      "x-workspace-org-id": "org-1",
      "x-workspace-scopes": scopes ?? "mate:invoke,mate:preferences,mate:owner_test",
      "x-workspace-user-id": userId,
      ...(departmentId ? { "x-workspace-department-id": departmentId } : {}),
      ...(departmentPath ? { "x-workspace-department-path": departmentPath.join(",") } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

describe("shared Mate Runtime", () => {
  it("converts Office previews through authorized Workspace reads and preserves original downloads", async () => {
    const bindings = env();
    let reads = 0;
    let conversions = 0;
    let denied = false;
    bindings.KNOWLEDGE_SERVICE = { async fetch(req) {
      reads++;
      assert.match(req.headers.get("authorization"), /^Bearer resource:user-a:/);
      assert.match(new URL(req.url).pathname, /^\/api\/files\/report-1\/(raw|download)$/);
      return new Response(denied ? "denied" : "original office bytes", { status: denied ? 403 : 200, headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
    } };
    bindings.AI = { async toMarkdown(document) {
      conversions++;
      assert.equal(document.name, "report.docx");
      assert.equal(await document.blob.text(), "original office bytes");
      return { data: "# Report\n\nVerified content", format: "markdown" };
    } };
    const path = "/v1/mates/knowledge-mate/workspace-files/report-1/download";
    const preview = await handleMateRuntimeRequest(request(`${path}?preview=markdown&fileName=report.docx`), bindings);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type"), /^text\/markdown/);
    assert.equal(await preview.text(), "# Report\n\nVerified content");
    const original = await handleMateRuntimeRequest(request(path), bindings);
    assert.equal(original.status, 200);
    assert.equal(await original.text(), "original office bytes");
    denied = true;
    const inaccessible = await handleMateRuntimeRequest(request(`${path}?preview=markdown&fileName=report.docx`), bindings);
    assert.equal(inaccessible.status, 403);
    assert.equal(conversions, 1);
    const invalid = await handleMateRuntimeRequest(request(`${path}?preview=markdown&fileName=../report.docx`), bindings);
    assert.equal(invalid.status, 400);
    assert.equal(reads, 3);
    bindings.definition.release.manifest.resources.builtInToolBindings = [{ toolId: "artifact_create", requiresCurrentUserContext: true }];
    const unavailable = await handleMateRuntimeRequest(request(`${path}?preview=markdown&fileName=report.docx`), bindings);
    assert.equal(unavailable.status, 403);
    assert.equal(reads, 3);
  });
  it("redirects legacy Runtime HTML routes to the canonical authenticated Web Host", async () => {
    const bindings = env();
    bindings.MATE_WEB_HOST_URL = "https://ai.example.invalid";

    const standalone = await handleMateRuntimeRequest(request("/mates/knowledge-mate"), bindings);
    assert.equal(standalone.status, 302);
    assert.equal(standalone.headers.get("location"), "https://ai.example.invalid/mates/knowledge-mate");

    const embedded = await handleMateRuntimeRequest(request("/mates/knowledge-mate/embed"), bindings);
    assert.equal(embedded.status, 302);
    assert.equal(embedded.headers.get("location"), "https://ai.example.invalid/mates/knowledge-mate/embed");

    const preview = await handleMateRuntimeRequest(request("/owner/mates/knowledge-mate/test?release=knowledge-mate-r1&surface=embed"), bindings);
    assert.equal(preview.status, 302);
    assert.equal(
      preview.headers.get("location"),
      "https://ai.example.invalid/mates/knowledge-mate/preview?release=knowledge-mate-r1&presentation=embedded"
    );
  });

  it("keeps Workspace attachment writes out of Preview and gates Live upload by Release capability", async () => {
    const previewBindings = env();
    const previewUpload = await handleMateRuntimeRequest(request("/v1/owner-test/mates/knowledge-mate/workspace-attachments", {
      method: "POST",
      userId: "owner-1"
    }), previewBindings);
    assert.equal(previewUpload.status, 405);
    assert.equal((await previewUpload.json()).error, "owner_test_workspace_write_forbidden");

    const definition = runtimeDefinition();
    definition.release.manifest.resources.builtInToolBindings = definition.release.manifest.resources.builtInToolBindings
      .filter((binding) => binding.toolId !== "document_read");
    const bindings = env({ definition });
    const form = new FormData();
    form.set("file", new File(["hello"], "brief.txt", { type: "text/plain" }));
    const liveUpload = await handleMateRuntimeRequest(new Request(
      "http://localhost/v1/mates/knowledge-mate/workspace-attachments",
      {
        body: form,
        headers: {
          "x-workspace-org-id": "org-1",
          "x-workspace-scopes": "mate:invoke",
          "x-workspace-user-id": "user-a"
        },
        method: "POST"
      }
    ), bindings);
    assert.equal(liveUpload.status, 403);
    assert.equal((await liveUpload.json()).error, "runtime_builtin_capability_not_bound");

    definition.release.manifest.modelPolicy.multimodal.imageInput = false;
    const imageForm = new FormData();
    imageForm.set("file", new File([new Uint8Array([137, 80, 78, 71])], "chart.png", { type: "image/png" }));
    const disabledImageUpload = await handleMateRuntimeRequest(new Request(
      "http://localhost/v1/mates/knowledge-mate/workspace-attachments",
      {
        body: imageForm,
        headers: {
          "x-workspace-org-id": "org-1",
          "x-workspace-scopes": "mate:invoke",
          "x-workspace-user-id": "user-a"
        },
        method: "POST"
      }
    ), bindings);
    assert.equal(disabledImageUpload.status, 403);
    assert.equal((await disabledImageUpload.json()).error, "runtime_image_input_not_enabled");
  });

  it("uploads bounded Skill ZIPs for the live Owner and reads them through the dedicated package tool", async () => {
    const definition = runtimeDefinition();
    definition.release.manifest.resources.builtInToolBindings = [];
    const bindings = env({ definition });
    const objects = new Map();
    bindings.MATE_ARTIFACTS = {
      async put(key, bytes, options) {
        const value = { bytes: new Uint8Array(bytes), size: bytes.byteLength, ...options };
        objects.set(key, value); return value;
      },
      async get(key) {
        const value = objects.get(key);
        return value ? { ...value, arrayBuffer: async () => value.bytes.buffer } : null;
      }
    };
    const markdown = '---\nname: meeting-archive\ndescription: Archive selected meetings.\n---\nRead authorized meeting notes.';
    const bytes = zipSync({ 'meeting-archive/SKILL.md': strToU8(markdown) });
    const upload = async (userId, content = bytes) => {
      const form = new FormData();
      form.set('file', new File([content], 'meeting-archive.zip', { type: 'application/zip' }));
      return handleMateRuntimeRequest(new Request('http://localhost/v1/mates/knowledge-mate/workspace-attachments', {
        method: 'POST', body: form, headers: { 'x-workspace-org-id': 'org-1', 'x-workspace-scopes': 'mate:invoke', 'x-workspace-user-id': userId }
      }), bindings);
    };
    const shared = await upload('user-a');
    assert.equal(shared.status, 403);
    assert.equal((await shared.json()).error, 'mate_skill_package_owner_required');
    assert.equal(objects.size, 0);
    const oversized = await upload('owner-1', new Uint8Array(400_001));
    assert.equal(oversized.status, 413);
    assert.equal(objects.size, 0);
    const response = await upload('owner-1');
    assert.equal(response.status, 201);
    const stored = (await response.json()).file;
    const tools = await createConversationTools(bindings, definition, {
      userId: 'owner-1', orgId: 'org-1', callerKind: 'user'
    }, { appIds: [], knowledgeServiceIds: [], attachments: new Map(), mode: 'live', turnId: 'skill-upload' }, []);
    const parsed = await tools.mate_skill_package_read.execute({ objectId: stored.objectId });
    assert.equal(parsed.skillMarkdown, markdown);
    assert.equal(parsed.scriptsExecuted, false);
    assert.equal(objects.size, 1);
  });

  it("enforces targeted invocation for selected users and department descendants", async () => {
    const definition = runtimeDefinition();
    definition.release.manifest.invocationPolicy.visibility = "targets";
    definition.release.manifest.invocationPolicy.targetIds = ["user:user-a", "department:wealth/portfolio"];
    const bindings = env({ definition });

    const selectedUser = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/runtime"), bindings);
    assert.equal(selectedUser.status, 200);

    const departmentMember = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/runtime", {
      departmentId: "advisory",
      departmentPath: ["wealth", "wealth/portfolio", "wealth/portfolio/advisory"],
      userId: "user-b"
    }), bindings);
    assert.equal(departmentMember.status, 200);

    const outsider = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/runtime", {
      departmentId: "technology",
      departmentPath: ["technology/platform"],
      userId: "user-c"
    }), bindings);
    assert.equal(outsider.status, 403);
    assert.equal((await outsider.json()).error, "mate_invocation_denied");
  });

  it("resolves one published identity and exposes a Preview Web entry", async () => {
    const definition = runtimeDefinition();
    definition.release.manifest.resources.folderEditBindings = [{
      folderObjectId: "pb-root", authority: { mode: "invoking_user" }, requiresCurrentUserAuthorization: true
    }];
    definition.release.manifest.mate.avatarRef = "https://assets.example.com/knowledge-mate.png";
    definition.release.manifest.resources.builtInToolBindings = [
      "public_web_read", "public_web_search", "ocr", "document_read", "artifact_create",
      "workspace_knowledge_maintain", "workspace_forum_read", "workspace_forum_post", "todo_manage", "reminder_manage"
    ].map((toolId) => ({ requiresCurrentUserContext: true, toolId }));
    const bindings = env({ definition });
    delete bindings.MATE_WEB_HOST_URL; // Exercise the standalone HTML renderer; configured Portal redirects have their own test.
    bindings.WORKSPACE_MCP_SERVICE = { async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/internal/runtime/workspace-pass/tools/models_list");
      return Response.json({ models: [
        { id: "tencent-deepseek-v4-flash", displayName: "DeepSeek-V4-Flash" },
        { id: "unbound-model", displayName: "Unbound Model" }
      ] });
    } };
    const runtime = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/runtime"), bindings);
    assert.equal(runtime.status, 200);
    const payload = await runtime.json();
    assert.equal(payload.mate.id, "knowledge-mate");
    assert.equal(payload.mate.avatarUrl, "https://assets.example.com/knowledge-mate.png");
    assert.equal(payload.release.id, "knowledge-mate-r1");
    assert.deepEqual(payload.capabilities.knowledge.map((item) => item.id), ["portfolio-policies"]);
    assert.deepEqual(payload.capabilities.appMcp.map((item) => item.id), ["portfolio-tracker"]);
    assert.equal(payload.capabilities.appMcp[0].authorization, "invoking_user");
    assert.equal(payload.capabilities.knowledge[0].authorization, "invoking_user");
    assert.equal(payload.capabilities.models.defaultModel, "tencent-deepseek-v4-flash");
    assert.equal(payload.capabilities.models.allowed.find((model) => model.id === "tencent-deepseek-v4-flash").name, "DeepSeek-V4-Flash");
    assert.equal(payload.capabilities.models.allowed.some((model) => model.id === "unbound-model"), false);
    assert.deepEqual(payload.capabilities.models.multimodal, {
      audioInput: false,
      documentInput: true,
      imageInput: true
    });
    assert.equal(payload.capabilities.tools.length, 8);
    assert.equal(payload.capabilities.tools.every((tool) => tool.status === "ready"), true);
    assert.deepEqual(
      payload.capabilities.tools.find((tool) => tool.id === "public_web_read"),
      {
        authorization: "current_user_context",
        engine: "kitesurf",
        id: "public_web_read",
        kind: "built_in_tool",
        provider: "cloudflare_browser_run",
        status: "ready",
        surfaces: ["conversation", "task"]
      }
    );
    assert.equal(payload.capabilities.tools.some((tool) => tool.id === "workspace_forum_post" || tool.id === "workspace_forum_read"), false);
    assert.deepEqual(payload.capabilities.tools.find((tool) => tool.id === "workspace_knowledge_maintain"), {
      authorization: "current_user_context",
      id: "workspace_knowledge_maintain",
      kind: "built_in_tool",
      provider: "workspace_mcp",
      status: "ready",
      surfaces: ["conversation", "task_approval"],
      writeRequiresApproval: true
    });
    assert.equal(payload.capabilities.executors, undefined);

    const web = await handleMateRuntimeRequest(request("/mates/knowledge-mate"), bindings);
    assert.equal(web.status, 200);
    const webHtml = await web.text();
    assert.match(webHtml, /Knowledge Mate/);
    assert.match(webHtml, /src="https:\/\/assets\.example\.com\/knowledge-mate\.png"/);
    assert.match(webHtml, /class="identity-mark"><img/);

    const root = await handleMateRuntimeRequest(request("/?knowledgeBaseId=portfolio-policies"), bindings);
    assert.equal(root.status, 200);
    const rootHtml = await root.text();
    assert.match(rootHtml, /Workspace Agent Runtime/);
    assert.match(rootHtml, /"knowledgeServiceIds":\["portfolio-policies"\]/);

    const unboundRoot = await handleMateRuntimeRequest(request("/?knowledgeBaseId=private-extra"), bindings);
    assert.match(await unboundRoot.text(), /"knowledgeServiceIds":\[\]/);
  });

  it("rejects Release integrity mismatches and every non-user resource authority before execution", async () => {
    const cases = [
      {
        reason: "runtime_release_integrity_invalid",
        mutate(definition) { definition.release.manifest.release.releaseId = "different-release"; }
      },
      {
        reason: "runtime_user_authority_policy_invalid",
        mutate(definition) { definition.release.manifest.resources.appMcpBindings[0].requiresCurrentUserDelegation = false; }
      },
      {
        reason: "runtime_user_authority_policy_invalid",
        mutate(definition) { definition.release.manifest.resources.knowledgeServiceBindings[0].requiresCurrentUserAuthorization = false; }
      },
      {
        reason: "runtime_user_authority_policy_invalid",
        mutate(definition) { definition.release.manifest.resources.appMcpBindings[0].authority = { mode: "owner_delegated", grantId: "grant-1" }; }
      },
      {
        reason: "runtime_user_authority_policy_invalid",
        mutate(definition) {
          definition.release.manifest.resources.knowledgeServiceBindings = [];
          definition.release.manifest.resources.knowledgeServiceScope = {
            allowedOperations: ["search", "read"],
            authority: { mode: "owner_delegated", grantId: "grant-1" },
            mode: "all_visible_to_invoking_user",
            requiresCurrentUserAuthorization: true
          };
        }
      },
      {
        reason: "runtime_user_authority_policy_invalid",
        mutate(definition) {
          definition.release.manifest.resources.knowledgeServiceScope = {
            allowedOperations: ["search", "read"],
            mode: "all_visible_to_invoking_user",
            requiresCurrentUserAuthorization: true
          };
        }
      },
      {
        reason: "runtime_user_authority_policy_invalid",
        mutate(definition) {
          definition.release.manifest.resources.appMcpBindings = [];
          definition.release.manifest.resources.knowledgeServiceBindings = [];
          definition.release.manifest.resources.workspacePassMcpScope = {
            authority: { mode: "owner_delegated", grantId: "grant-1" },
            domains: ["apps", "knowledge"],
            mode: "all_authorized_for_invoking_user",
            requiresCurrentUserAuthorization: true
          };
        }
      },
      {
        reason: "runtime_user_authority_policy_invalid",
        mutate(definition) {
          definition.release.manifest.resources.appMcpBindings = [];
          definition.release.manifest.resources.knowledgeServiceBindings = [];
          definition.release.manifest.resources.workspacePassMcpScope = {
            authority: { mode: "invoking_user" },
            domains: ["knowledge", "apps"],
            mode: "all_authorized_for_invoking_user",
            requiresCurrentUserAuthorization: true
          };
        }
      },
      {
        reason: "runtime_user_authority_policy_invalid",
        mutate(definition) {
          definition.release.manifest.resources.appMcpBindings = [];
          definition.release.manifest.resources.knowledgeServiceBindings = [];
          definition.release.manifest.resources.folderEditBindings = [{
            authority: { mode: "invoking_user" },
            folderObjectId: "portfolio-root",
            requiresCurrentUserAuthorization: true
          }];
          definition.release.manifest.resources.workspacePassMcpScope = {
            authority: { mode: "invoking_user" },
            domains: ["apps", "knowledge"],
            mode: "all_authorized_for_invoking_user",
            requiresCurrentUserAuthorization: true
          };
        }
      }
    ];

    for (const testCase of cases) {
      const definition = runtimeDefinition();
      testCase.mutate(definition);
      const response = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/runtime"), env({ definition }));
      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.equal(payload.error, "runtime_definition_invalid");
      assert.equal(payload.reason, testCase.reason);
    }
  });

  it("derives user identity from auth and isolates Conversations and Tasks by mateId × userId", async () => {
    const bindings = env();
    const forbidden = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: { channel: "web", instruction: "Find the policy", userId: "user-b" }
    }), bindings);
    assert.equal(forbidden.status, 400);
    assert.equal((await forbidden.json()).error, "caller_identity_is_server_derived");

    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: { channel: "web", context: { route: "/clients/1", secretToken: "drop-me" }, instruction: "Find the policy" }
    }), bindings);
    assert.equal(created.status, 202);
    const task = (await created.json()).task;
    assert.equal(task.status, "queued");
    assert.deepEqual(task.context, { route: "/clients/1" });

    const ownList = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks"), bindings);
    const ownTasks = (await ownList.json()).tasks;
    assert.equal(ownTasks.length, 1);
    assert.equal(ownTasks[0].title, "Find the policy");
    const otherList = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", { userId: "user-b" }), bindings);
    assert.deepEqual((await otherList.json()).tasks, []);
    const otherRead = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}`, { userId: "user-b" }), bindings);
    assert.equal(otherRead.status, 404);
  });

  it("issues a Live Chat Grant only for the current user's Conversation on the exact POST endpoint", async () => {
    const bindings = env();
    const conversationId = "conv_chat_http_01";
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/conversations", {
      method: "POST",
      body: { channel: "sdk", conversationId, title: "HTTP chat integration" }
    }), bindings);
    assert.equal(created.status, 201);
    assert.equal((await created.json()).conversation.id, conversationId);

    const grantPath = `/v1/mates/knowledge-mate/conversations/${conversationId}/chat-grants`;
    const wrongMethod = await handleMateRuntimeRequest(request(grantPath), bindings);
    assert.equal(wrongMethod.status, 405);
    assert.equal((await wrongMethod.json()).error, "mate_chat_grant_method_not_allowed");

    for (const suffix of ["/", "/framework-subpath"]) {
      const nonExact = await handleMateRuntimeRequest(request(`${grantPath}${suffix}`, { method: "POST" }), bindings);
      assert.equal(nonExact.status, 404);
      assert.equal((await nonExact.json()).error, "runtime_route_not_found");
    }

    const otherUser = await handleMateRuntimeRequest(request(grantPath, {
      method: "POST",
      userId: "user-b"
    }), bindings);
    assert.equal(otherUser.status, 404);
    assert.equal((await otherUser.json()).error, "conversation_not_found");

    const webConversationId = "conv_chat_http_web";
    await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/conversations", {
      method: "POST",
      body: { channel: "web", conversationId: webConversationId, title: "Legacy web conversation" }
    }), bindings);
    const webConversationGrant = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/conversations/${webConversationId}/chat-grants`,
      { method: "POST" }
    ), bindings);
    assert.equal(webConversationGrant.status, 409);
    assert.equal((await webConversationGrant.json()).error, "mate_chat_conversation_channel_invalid");

    const issued = await handleMateRuntimeRequest(request(grantPath, { method: "POST" }), bindings);
    assert.equal(issued.status, 201);
    const payload = await issued.json();
    assert.equal(payload.mode, "live");
    assert.equal(payload.releaseId, "knowledge-mate-r1");
    assert.equal(payload.grant.split(".").length, 3);
    assert.equal(Number.isNaN(Date.parse(payload.expiresAt)), false);
    assert.deepEqual(bindings.chatAgentCalls.idFromNames, []);
  });

  it("renames, pins, archives, and permanently deletes only the current user's Conversation and Agent DO", async () => {
    const bindings = env();
    const conversationId = "conv_lifecycle_01";
    const collectionPath = "/v1/mates/knowledge-mate/conversations";
    const itemPath = `${collectionPath}/${conversationId}`;
    const created = await handleMateRuntimeRequest(request(collectionPath, {
      method: "POST",
      body: { channel: "sdk", conversationId, title: "Original title" }
    }), bindings);
    assert.equal(created.status, 201);

    const renamed = await handleMateRuntimeRequest(request(itemPath, {
      method: "PATCH",
      body: { title: "  Updated   title  " }
    }), bindings);
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).conversation.title, "Updated title");
    const pinned = await handleMateRuntimeRequest(request(itemPath, {
      method: "PATCH",
      body: { pinned: true }
    }), bindings);
    assert.ok((await pinned.json()).conversation.pinnedAt);
    const archived = await handleMateRuntimeRequest(request(itemPath, {
      method: "PATCH",
      body: { status: "archived" }
    }), bindings);
    const archivedConversation = (await archived.json()).conversation;
    assert.equal(archivedConversation.status, "archived");
    assert.equal(archivedConversation.pinnedAt, null);

    const otherUserDelete = await handleMateRuntimeRequest(request(itemPath, {
      method: "DELETE",
      userId: "user-b"
    }), bindings);
    assert.equal(otherUserDelete.status, 404);
    assert.deepEqual(bindings.chatAgentCalls.destroySchedules, []);

    const deleted = await handleMateRuntimeRequest(request(itemPath, { method: "DELETE" }), bindings);
    assert.equal(deleted.status, 200);
    assert.deepEqual((await deleted.json()).conversation, {
      deleted: true,
      id: conversationId,
      scheduledAgentInstances: 1
    });
    const expectedName = await mateChatInstanceName({
      conversationId,
      mode: "live",
      mateId: "knowledge-mate",
      userId: "user-a"
    });
    assert.deepEqual(bindings.chatAgentCalls.destroySchedules, [expectedName]);
    assert.equal(bindings.RUNTIME_DB.database.prepare(
      "SELECT COUNT(*) AS count FROM mate_conversations WHERE id = ?"
    ).get(conversationId).count, 0);
  });

  it("does not mint an SDK Chat Grant when every interactive Release surface is disabled", async () => {
    const definition = runtimeDefinition();
    definition.release.manifest.channels.embedded.enabled = false;
    definition.release.manifest.channels.standalone.enabled = false;
    const bindings = env({ definition });
    const conversationId = "conv_chat_disabled";
    await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/conversations", {
      method: "POST",
      body: { channel: "sdk", conversationId, title: "Disabled SDK surface" }
    }), bindings);

    const response = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/conversations/${conversationId}/chat-grants`,
      { method: "POST" }
    ), bindings);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "mate_chat_channel_disabled");
    assert.deepEqual(bindings.chatAgentCalls.idFromNames, []);
  });

  it("paginates active and archived SDK conversations independently without gaps after archiving", async () => {
    const bindings = env();
    const insert = bindings.RUNTIME_DB.database.prepare(`INSERT INTO mate_conversations
      (mate_id, user_id, runtime_mode, id, title, channel, status, created_at, updated_at)
      VALUES ('knowledge-mate', ?, 'live', ?, 'Conversation', ?, ?, '2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z')`);
    for (const status of ["active", "archived"]) {
      for (let index = 0; index < 125; index++) insert.run("user-a", `${status}_${String(index).padStart(3, "0")}`, "sdk", status);
    }
    insert.run("other-user", "private", "sdk", "active");
    insert.run("user-a", "web-conversation", "web", "active");
    for (const status of ["active", "archived"]) {
      const ids = [];
      let cursor;
      for (const count of [50, 50, 25]) {
        const query = new URLSearchParams({ status });
        if (cursor) query.set("cursor", cursor);
        const response = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/conversations?${query}`), bindings);
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.equal(page.conversations.length, count);
        assert.ok(page.conversations.every((item) => item.status === status && item.channel === "sdk"));
        ids.push(...page.conversations.map((item) => item.id));
        cursor = page.nextCursor;
        if (count === 50 && ids.length === 50 && status === "active") {
          bindings.RUNTIME_DB.database.prepare("UPDATE mate_conversations SET status = 'archived' WHERE id = ?").run(ids[0]);
        }
      }
      assert.equal(new Set(ids).size, 125);
      assert.equal(cursor, null);
      // Restore the changed row before paging archived conversations.
      bindings.RUNTIME_DB.database.prepare("UPDATE mate_conversations SET status = 'active' WHERE id = 'active_124'").run();
    }
    for (const query of ["status=unknown", "status=active&cursor=invalid"]) {
      const response = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/conversations?${query}`), bindings);
      assert.equal(response.status, 400);
    }
  });

  it("commits one owner-only Preview draft idempotently before any Agent DO is addressed", async () => {
    const bindings = env();
    const release = "knowledge-mate-r1";
    const conversationId = "conv_preview_first_send_01";
    const path = `/v1/owner-test/mates/knowledge-mate/conversations?release=${release}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handleMateRuntimeRequest(request(path, {
        body: { channel: "sdk", conversationId, title: "Review portfolio concentration" },
        method: "POST",
        userId: "owner-1"
      }), bindings);
      assert.equal(response.status, 201);
      const conversation = (await response.json()).conversation;
      assert.equal(conversation.channel, "sdk");
      assert.equal(conversation.id, conversationId);
      assert.equal(conversation.status, "active");
      assert.equal(conversation.title, "Review portfolio concentration");
    }
    const stored = bindings.RUNTIME_DB.database.prepare(`
      SELECT COUNT(*) AS count, MAX(title) AS title FROM mate_conversations
      WHERE mate_id = 'knowledge-mate' AND user_id = 'owner-1'
        AND runtime_mode = 'preview' AND id = ? AND channel = 'sdk'
    `).get(conversationId);
    assert.equal(stored.count, 1);
    assert.equal(stored.title, "Review portfolio concentration");
    assert.deepEqual(bindings.chatAgentCalls.idFromNames, []);
  });

  it("mints owner-only Preview Chat Grants, repairs the directory idempotently, and rejects cross-mode replay", async () => {
    const bindings = env();
    const conversationId = "conv_preview_chat_01";
    const release = "knowledge-mate-r1";
    const grantPath = `/v1/owner-test/mates/knowledge-mate/conversations/${conversationId}/chat-grants`;

    const missingOwnerScope = await handleMateRuntimeRequest(request(`${grantPath}?release=${release}`, {
      method: "POST",
      scopes: "mate:invoke",
      userId: "owner-1"
    }), bindings);
    assert.equal(missingOwnerScope.status, 403);
    assert.equal((await missingOwnerScope.json()).error, "runtime_scope_insufficient");

    const missingInvokeScope = await handleMateRuntimeRequest(request(`${grantPath}?release=${release}`, {
      method: "POST",
      scopes: "mate:owner_test",
      userId: "owner-1"
    }), bindings);
    assert.equal(missingInvokeScope.status, 403);
    assert.equal((await missingInvokeScope.json()).error, "runtime_scope_insufficient");

    const missingReleaseGrant = await handleMateRuntimeRequest(request(grantPath, {
      method: "POST",
      userId: "owner-1"
    }), bindings);
    assert.equal(missingReleaseGrant.status, 403);
    assert.equal((await missingReleaseGrant.json()).error, "mate_owner_test_grant_required");

    const nonOwnerGrant = await handleMateRuntimeRequest(request(`${grantPath}?release=${release}`, {
      method: "POST",
      userId: "user-a"
    }), bindings);
    assert.equal(nonOwnerGrant.status, 404);
    assert.equal((await nonOwnerGrant.json()).error, "mate_owner_test_not_found");

    const mismatchedRelease = await handleMateRuntimeRequest(request(`${grantPath}?release=another-candidate`, {
      method: "POST",
      userId: "owner-1"
    }), bindings);
    assert.equal(mismatchedRelease.status, 502);
    assert.equal((await mismatchedRelease.json()).reason, "runtime_preview_release_binding_invalid");

    const issued = await handleMateRuntimeRequest(request(`${grantPath}?release=${release}`, {
      method: "POST",
      userId: "owner-1"
    }), bindings);
    assert.equal(issued.status, 201);
    const payload = await issued.json();
    assert.equal(payload.mode, "preview");
    assert.equal(payload.releaseId, release);

    const repeated = await handleMateRuntimeRequest(request(`${grantPath}?release=${release}`, {
      method: "POST",
      userId: "owner-1"
    }), bindings);
    assert.equal(repeated.status, 201);
    assert.equal(bindings.RUNTIME_DB.database.prepare(`
      SELECT COUNT(*) AS count FROM mate_conversations
      WHERE mate_id = 'knowledge-mate' AND user_id = 'owner-1'
        AND runtime_mode = 'preview' AND id = ? AND channel = 'sdk'
    `).get(conversationId).count, 1);
    assert.equal(bindings.RUNTIME_DB.database.prepare(`
      SELECT COUNT(*) AS count FROM mate_conversations
      WHERE mate_id = 'knowledge-mate' AND user_id = 'owner-1'
        AND runtime_mode = 'live' AND id = ?
    `).get(conversationId).count, 0);

    const history = await handleMateRuntimeRequest(request(
      `/v1/owner-test/mates/knowledge-mate/conversations/${conversationId}/chat/get-messages?grant=${encodeURIComponent(payload.grant)}`
    ), bindings);
    assert.equal(history.status, 200);
    const expectedInstanceName = await mateChatInstanceName({
      conversationId,
      mode: "preview",
      releaseId: release,
      mateId: "knowledge-mate",
      userId: "owner-1"
    });
    assert.deepEqual(await history.json(), { agentInstanceName: expectedInstanceName, forwarded: true });

    const liveReplay = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/conversations/${conversationId}/chat/get-messages?grant=${encodeURIComponent(payload.grant)}`
    ), bindings);
    assert.equal(liveReplay.status, 401);
    assert.equal((await liveReplay.json()).error, "mate_chat_grant_invalid");
  });

  it("clears only the current owner's Preview records and durably schedules their Agent DOs for destruction", async () => {
    const bindings = env();
    const release = "knowledge-mate-r1";
    const conversationIds = ["conv_preview_clear_01", "conv_preview_clear_02"];
    for (const conversationId of conversationIds) {
      const grant = await handleMateRuntimeRequest(request(
        `/v1/owner-test/mates/knowledge-mate/conversations/${conversationId}/chat-grants?release=${release}`,
        { method: "POST", userId: "owner-1" }
      ), bindings);
      assert.equal(grant.status, 201);
    }

    const previewTask = await handleMateRuntimeRequest(request(
      `/v1/owner-test/mates/knowledge-mate/tasks?release=${release}`,
      {
        body: { channel: "mate_call", instruction: "Preview-only task" },
        method: "POST",
        userId: "owner-1"
      }
    ), bindings);
    assert.equal(previewTask.status, 202);

    const liveConversation = await handleMateRuntimeRequest(request(
      "/v1/mates/knowledge-mate/conversations",
      {
        body: { channel: "sdk", conversationId: "conv_live_keep_01", title: "Keep Live" },
        method: "POST",
        userId: "owner-1"
      }
    ), bindings);
    assert.equal(liveConversation.status, 201);
    bindings.RUNTIME_DB.database.prepare(`
      INSERT INTO mate_conversations (
        mate_id, user_id, runtime_mode, id, title, channel, status, created_at, updated_at
      ) VALUES ('knowledge-mate', 'another-owner', 'preview', 'conv_other_keep_01', '', 'sdk', 'active', ?, ?)
    `).run("2026-08-29T00:00:00.000Z", "2026-08-29T00:00:00.000Z");

    const cleared = await handleMateRuntimeRequest(request(
      `/v1/owner-test/mates/knowledge-mate/conversations?release=${release}`,
      { method: "DELETE", userId: "owner-1" }
    ), bindings);
    assert.equal(cleared.status, 200);
    assert.match(cleared.headers.get("access-control-allow-methods") || "", /DELETE/);
    assert.deepEqual((await cleared.json()).cleared, {
      deletedConversations: 2,
      deletedSessions: 1,
      scheduledAgentInstances: 2
    });
    const expectedNames = await Promise.all(conversationIds.map((conversationId) => (
      mateChatInstanceName({
        conversationId,
        mode: "preview",
        releaseId: release,
        mateId: "knowledge-mate",
        userId: "owner-1"
      })
    )));
    assert.deepEqual(new Set(bindings.chatAgentCalls.destroySchedules), new Set(expectedNames));
    assert.equal(bindings.RUNTIME_DB.database.prepare(`
      SELECT COUNT(*) AS count FROM mate_conversations
      WHERE mate_id = 'knowledge-mate' AND user_id = 'owner-1' AND runtime_mode = 'preview'
    `).get().count, 0);
    assert.equal(bindings.RUNTIME_DB.database.prepare(`
      SELECT COUNT(*) AS count FROM mate_sessions
      WHERE mate_id = 'knowledge-mate' AND user_id = 'owner-1' AND runtime_mode = 'preview'
    `).get().count, 0);
    assert.equal(bindings.RUNTIME_DB.database.prepare(`
      SELECT COUNT(*) AS count FROM mate_conversations
      WHERE id IN ('conv_live_keep_01', 'conv_other_keep_01')
    `).get().count, 2);

    const repeated = await handleMateRuntimeRequest(request(
      `/v1/owner-test/mates/knowledge-mate/conversations?release=${release}`,
      { method: "DELETE", userId: "owner-1" }
    ), bindings);
    assert.deepEqual((await repeated.json()).cleared, {
      deletedConversations: 0,
      deletedSessions: 0,
      scheduledAgentInstances: 0
    });

    const liveDelete = await handleMateRuntimeRequest(request(
      "/v1/mates/knowledge-mate/conversations",
      { method: "DELETE", userId: "owner-1" }
    ), bindings);
    assert.equal(liveDelete.status, 405);
    assert.equal((await liveDelete.json()).error, "runtime_method_not_allowed");
  });

  it("fails Preview Chat closed when owner testing is disabled", async () => {
    for (const field of ["enabled", "candidateReleaseOnly", "isolatedFromLiveData"]) {
      const definition = runtimeDefinition();
      definition.release.manifest.experiencePolicy.ownerTesting[field] = false;
      const bindings = env({ definition });
      const response = await handleMateRuntimeRequest(request(
        `/v1/owner-test/mates/knowledge-mate/conversations/conv_preview_disabled_${field}/chat-grants?release=knowledge-mate-r1`,
        { method: "POST", userId: "owner-1" }
      ), bindings);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, "mate_chat_channel_disabled");
      assert.equal(bindings.RUNTIME_DB.database.prepare(
        "SELECT COUNT(*) AS count FROM mate_conversations WHERE runtime_mode = 'preview'"
      ).get().count, 0);
    }
  });

  it("verifies the Chat Grant before deriving the DO and exposes only the exact socket and history paths", async () => {
    const bindings = env();
    const conversationId = "conv_chat_http_02";
    await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/conversations", {
      method: "POST",
      body: { channel: "sdk", conversationId, title: "DO routing" }
    }), bindings);
    const issued = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/conversations/${conversationId}/chat-grants`,
      { method: "POST" }
    ), bindings);
    const { grant } = await issued.json();

    const missingGrant = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/conversations/${conversationId}/chat/get-messages`
    ), bindings);
    assert.equal(missingGrant.status, 401);
    assert.equal((await missingGrant.json()).error, "mate_chat_grant_invalid");

    const tamperedGrant = `${grant.slice(0, -1)}${grant.endsWith("A") ? "B" : "A"}`;
    const tampered = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/conversations/${conversationId}/chat?grant=${encodeURIComponent(tamperedGrant)}`
    ), bindings);
    assert.equal(tampered.status, 401);
    assert.equal((await tampered.json()).error, "mate_chat_grant_invalid");

    const wrongRoute = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/conversations/conv_chat_http_other/chat?grant=${encodeURIComponent(grant)}`
    ), bindings);
    assert.equal(wrongRoute.status, 401);
    assert.equal((await wrongRoute.json()).error, "mate_chat_grant_invalid");
    assert.deepEqual(bindings.chatAgentCalls.idFromNames, []);

    for (const tail of ["/", "/framework-subpath", "/sub/mate-chat-agent/attacker/get-messages"]) {
      const response = await handleMateRuntimeRequest(request(
        `/v1/mates/knowledge-mate/conversations/${conversationId}/chat${tail}?grant=${encodeURIComponent(grant)}`
      ), bindings);
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, "runtime_route_not_found");
    }
    assert.deepEqual(bindings.chatAgentCalls.idFromNames, []);

    const wrongHistoryMethod = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/conversations/${conversationId}/chat/get-messages?grant=${encodeURIComponent(grant)}`,
      { method: "POST" }
    ), bindings);
    assert.equal(wrongHistoryMethod.status, 405);
    assert.equal((await wrongHistoryMethod.json()).error, "mate_chat_messages_method_not_allowed");
    assert.deepEqual(bindings.chatAgentCalls.idFromNames, []);

    const plainSocketRequest = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/conversations/${conversationId}/chat?grant=${encodeURIComponent(grant)}`
    ), bindings);
    assert.equal(plainSocketRequest.status, 426);
    assert.equal((await plainSocketRequest.json()).error, "mate_chat_websocket_upgrade_required");
    assert.deepEqual(bindings.chatAgentCalls.idFromNames, []);

    const query = new URLSearchParams({
      grant,
      instanceName: "client-selected-instance",
      name: "client-selected-name"
    });
    const transported = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/conversations/${conversationId}/chat/get-messages?${query}`
    ), bindings);
    assert.equal(transported.status, 200);
    const expectedInstanceName = await mateChatInstanceName({
      conversationId,
      mode: "live",
      mateId: "knowledge-mate",
      userId: "user-a"
    });
    assert.deepEqual(await transported.json(), { agentInstanceName: expectedInstanceName, forwarded: true });
    assert.deepEqual(bindings.chatAgentCalls.idFromNames, [expectedInstanceName]);
    assert.equal(bindings.chatAgentCalls.idFromNames.includes("client-selected-instance"), false);
    assert.equal(bindings.chatAgentCalls.gets[0].id.name, expectedInstanceName);
    assert.deepEqual(bindings.chatAgentCalls.gets[0].options, { locationHint: "apac" });
    assert.equal(bindings.chatAgentCalls.fetches.length, 1);
    const forwardedUrl = new URL(bindings.chatAgentCalls.fetches[0].url);
    assert.equal(forwardedUrl.pathname, "/workspace-chat-history");
    assert.equal(transported.headers.get("X-Workspace-Chat-Next-Cursor"), "message-page-end");
    assert.match(transported.headers.get("access-control-expose-headers"), /X-Workspace-Chat-Next-Cursor/);
    assert.equal(forwardedUrl.searchParams.get("instanceName"), "client-selected-instance");
  });

  it("stores structured Preferences independently for each user", async () => {
    const bindings = env();
    const first = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/preferences", {
      method: "PUT",
      body: { data: { language: "zh-CN", responseDensity: "brief" } }
    }), bindings);
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()).preferences.data, { language: "zh-CN", responseDensity: "brief" });

    const second = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/preferences", {
      method: "PUT",
      userId: "user-b",
      body: { data: { language: "en", responseDensity: "detailed" } }
    }), bindings);
    assert.equal(second.status, 200);

    const firstRead = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/preferences"), bindings);
    assert.equal((await firstRead.json()).preferences.data.language, "zh-CN");
    const secondRead = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/preferences", { userId: "user-b" }), bindings);
    assert.equal((await secondRead.json()).preferences.data.language, "en");
  });

  it("does not run Agent DO-owned SDK chat projections through the public Task runner", async () => {
    const bindings = env();
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: {
        channel: "sdk",
        instruction: `agent-do-message:msg_12345678:sha256:${"b".repeat(64)}`,
        context: {
          schemaVersion: "workspace.mate-environment/v1",
          revision: 1,
          host: { appId: "portfolio-app", surface: "embedded", instanceId: "chat-test" },
          location: { kind: "portfolio.portfolio", ref: "pf_123" },
          summary: { label: "Chat task projection test" }
        }
      }
    }), bindings);
    assert.equal(created.status, 202);
    const task = (await created.json()).task;

    const run = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/tasks/${task.id}/run`,
      { method: "POST" }
    ), bindings);
    assert.equal(run.status, 409);
    assert.equal((await run.json()).error, "mate_chat_task_agent_owned");
    assert.deepEqual(bindings.knowledgeCalls, []);
    assert.deepEqual(bindings.modelCalls, []);

    const unchanged = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/tasks/${task.id}`
    ), bindings);
    const storedTask = (await unchanged.json()).task;
    assert.equal(storedTask.status, "queued");
    assert.equal(storedTask.attemptCount, 0);

    const runs = await handleMateRuntimeRequest(request(
      `/v1/mates/knowledge-mate/tasks/${task.id}/runs`
    ), bindings);
    assert.deepEqual((await runs.json()).runs, []);
  });

  it("durably admits a Task, completes it after the response, and does not replay an alarm", async () => {
    const bindings = env();
    const namespace = taskRunnerNamespace(bindings);
    bindings.MATE_TASK_RUNNER = namespace;
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST", body: { channel: "web", instruction: "KYC 多久复核一次？" }
    }), bindings);
    const task = (await created.json()).task;
    const path = `/v1/mates/knowledge-mate/tasks/${task.id}`;
    const run = await handleMateRuntimeRequest(request(`${path}/run`, { method: "POST", body: { background: true } }), bindings);
    assert.equal(run.status, 202);
    assert.equal((await run.json()).task.status, "queued");
    assert.equal(bindings.modelCalls.length, 0);
    assert.equal(namespace.runners.size, 1);
    const stored = [...namespace.runners.values()][0];
    assert.ok(await stored.storage.getAlarm());
    // Duplicate admission does not create a second runner or overwrite its alarm.
    const alarm = await stored.storage.getAlarm();
    assert.equal((await handleMateRuntimeRequest(request(`${path}/run`, { method: "POST", body: { background: true } }), bindings)).status, 202);
    assert.equal(await stored.storage.getAlarm(), alarm);
    await namespace.fire();
    const completed = (await (await handleMateRuntimeRequest(request(path), bindings)).json()).task;
    assert.equal(completed.status, "completed");
    assert.equal(completed.attemptCount, 1);
    assert.match(completed.conclusion.summary, /Portfolio Policies/);
    assert.equal(await stored.storage.getAlarm(), null);
    const calls = bindings.modelCalls.length;
    await namespace.fire();
    assert.equal(bindings.modelCalls.length, calls);
    assert.equal((await handleMateRuntimeRequest(request(`${path}/run`, { method: "POST", body: { background: true } }), bindings)).status, 409);
    const other = await handleMateRuntimeRequest(request(`${path}/run`, { method: "POST", userId: "user-b", body: { background: true } }), bindings);
    assert.equal(other.status, 404);
  });

  it("records a background execution failure and removes its alarm", async () => {
    const bindings = env();
    bindings.MATE_LLM_KEY = undefined;
    const namespace = taskRunnerNamespace(bindings);
    bindings.MATE_TASK_RUNNER = namespace;
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST", body: { channel: "web", instruction: "Read policy" }
    }), bindings);
    const task = (await created.json()).task;
    const path = `/v1/mates/knowledge-mate/tasks/${task.id}`;
    assert.equal((await handleMateRuntimeRequest(request(`${path}/run`, { method: "POST", body: { background: true } }), bindings)).status, 202);
    await namespace.fire();
    const failed = (await (await handleMateRuntimeRequest(request(path), bindings)).json()).task;
    assert.equal(failed.status, "failed");
    assert.equal(failed.conclusion.failures[0].code, "mate_model_not_configured");
    assert.equal(await [...namespace.runners.values()][0].storage.getAlarm(), null);
  });

  it("fails an interrupted alarm after restart without repeating tools", async () => {
    const bindings = env();
    const namespace = taskRunnerNamespace(bindings);
    bindings.MATE_TASK_RUNNER = namespace;
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST", body: { channel: "web", instruction: "Read policy" }
    }), bindings);
    const task = (await created.json()).task;
    const path = `/v1/mates/knowledge-mate/tasks/${task.id}`;
    await handleMateRuntimeRequest(request(`${path}/run`, { method: "POST", body: { background: true } }), bindings);
    const { storage } = [...namespace.runners.values()][0];
    const job = await storage.get("task");
    await startTask(bindings.RUNTIME_DB, job.mateId, job.principal, job.mode, job.taskId, task.releaseId);
    await storage.put("task", { ...job, started: true });
    // A new instance has no in-memory execution state, only the persisted job.
    const restarted = new MateTaskRunner({ storage }, bindings);
    await restarted.alarm();
    const failed = (await (await handleMateRuntimeRequest(request(path), bindings)).json()).task;
    assert.equal(failed.status, "failed");
    assert.equal(failed.conclusion.failures[0].code, "background_task_interrupted");
    assert.equal(failed.attemptCount, 1);
    assert.equal(bindings.modelCalls.length, 0);
    assert.equal(await storage.getAlarm(), null);
  });

  it("rechecks the active Release when a queued alarm executes", async () => {
    const bindings = env();
    const namespace = taskRunnerNamespace(bindings);
    bindings.MATE_TASK_RUNNER = namespace;
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST", body: { channel: "web", instruction: "Read policy" }
    }), bindings);
    const task = (await created.json()).task;
    const path = `/v1/mates/knowledge-mate/tasks/${task.id}`;
    await handleMateRuntimeRequest(request(`${path}/run`, { method: "POST", body: { background: true } }), bindings);
    bindings.definition.release.id = "knowledge-mate-r2";
    bindings.definition.release.manifest.release.releaseId = "knowledge-mate-r2";
    await namespace.fire();
    const failed = (await (await handleMateRuntimeRequest(request(path), bindings)).json()).task;
    assert.equal(failed.status, "failed");
    assert.equal(failed.conclusion.failures[0].code, "task_release_changed");
    assert.equal(bindings.modelCalls.length, 0);
  });

  it("rejects background execution when its durable runner is missing", async () => {
    const bindings = env();
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST", body: { channel: "web", instruction: "Read policy" }
    }), bindings);
    const task = (await created.json()).task;
    const run = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST", body: { background: true }
    }), bindings);
    assert.equal(run.status, 503);
    assert.equal((await run.json()).error, "background_task_runner_not_configured");
    assert.equal(bindings.modelCalls.length, 0);
  });

  it("lets the unified Agent search and read Knowledge with current-user ACL and a cited conclusion", async () => {
    const bindings = env();
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: { channel: "web", instruction: "KYC 多久复核一次？" }
    }), bindings);
    const task = (await created.json()).task;

    const otherUserRun = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST",
      userId: "user-b"
    }), bindings);
    assert.equal(otherUserRun.status, 404);

    const run = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, { method: "POST" }), bindings);
    assert.equal(run.status, 200);
    const completed = (await run.json()).task;
    assert.equal(completed.status, "completed");
    assert.match(completed.sessionId, /^session_/);
    assert.match(completed.activeRunId, /^run_/);
    assert.equal(completed.attemptCount, 1);
    assert.match(completed.conclusion.summary, /Portfolio Policies · policies\/kyc\.md/);
    assert.equal(completed.conclusion.artifacts[0].serviceId, "portfolio-policies");
    assert.equal(bindings.knowledgeCalls.every((call) => call.headers.get("authorization")?.startsWith("Bearer resource:user-a:")), true);
    assert.equal(bindings.knowledgeCalls.some((call) => call.url.includes("private-extra/query")), false);
    assert.equal(bindings.modelCalls.length, 3);

    const runs = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/runs`), bindings);
    const runList = (await runs.json()).runs;
    assert.equal(runList.length, 1);
    assert.equal(runList[0].id, completed.activeRunId);
    assert.equal(runList[0].status, "completed");
  });

  it("combines App reads, write approvals and private Todos without an executor category", async () => {
    const bindings = env();
    const steps = [
      { tool: "app_portfolio-tracker_portfolio_client_read", args: { clientId: "client-1" } },
      { tool: "app_portfolio-tracker_portfolio_client_update", args: { clientId: "client-1", note: "Follow up" } },
      { tool: "todo_create", args: { title: "Review client follow-up" } },
      { text: "Read the client and created a private Todo. The App update awaits approval." }
    ];
    bindings.LITELLM_SERVICE = { async fetch(request) {
      const body = await request.json();
      const names = body.tools.map(tool => tool.function.name);
      assert.ok(names.includes("knowledge_base_search"));
      assert.ok(names.includes("todo_create"));
      assert.ok(names.includes("app_portfolio-tracker_portfolio_client_update"));
      return taskModelStream(steps.shift(), `step-${steps.length}`);
    } };
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST", body: { channel: "mate_call", instruction: "Review the client, propose an update and make a follow-up Todo." }
    }), bindings);
    const task = (await created.json()).task;
    const run = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST", body: { executor: "knowledge_qa" }
    }), bindings);
    assert.equal(run.status, 200);
    const result = (await run.json()).task;
    assert.equal(result.conclusion.pendingApprovals.length, 1);
    assert.ok(result.threadId);
    const work=await (await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/threads/${result.threadId}`),bindings)).json();
    assert.equal(work.tasks.length,1);
    assert.equal(result.conclusion.actions.length, 3);
    assert.equal(bindings.appCalls.filter(call => call.method === "POST").length, 0);
    const approvalId = result.conclusion.pendingApprovals[0].approvalId;
    const approved = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${approvalId}/decision`, {
      method: "POST", body: { decision: "approve" }
    }), bindings);
    assert.equal(approved.status, 200);
    assert.equal(bindings.appCalls.filter(call => call.method === "POST").length, 1);
    assert.ok(bindings.appCalls.every(call => call.userId === "user-a"));
    const settled=await (await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/threads/${result.threadId}`),bindings)).json();
    assert.equal(settled.tasks[0].conclusion.pendingApprovals.length,0);
  });

  it("fails a Task when a tool fails even if the model claims completion", async () => {
    const bindings = env();
    let turn = 0;
    bindings.LITELLM_SERVICE = { async fetch() {
      return taskModelStream(turn++ === 0
        ? { tool: "todo_update", args: { id: "missing-todo", status: "completed" } }
        : { text: "Everything is complete." });
    } };
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST", body: { instruction: "Complete the Todo." }
    }), bindings);
    const task = (await created.json()).task;
    const run = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, { method: "POST" }), bindings);
    const result = (await run.json()).task;
    assert.equal(result.status, "failed");
    assert.ok(result.conclusion.failures.length > 0);
  });

  it("does not synthesize successful Tasks or Todos without a configured model", async () => {
    const bindings = env();
    delete bindings.MATE_LLM_KEY;
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST", body: { instruction: "Create a follow-up Todo." }
    }), bindings);
    const task = (await created.json()).task;
    const run = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, { method: "POST" }), bindings);
    assert.equal(run.status, 503);
    const reread = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}`), bindings);
    assert.equal((await reread.json()).task.status, "failed");
    assert.equal(bindings.modelCalls.length, 0);
  });

  it("fails closed before creating a Run when the active Release changed after Task creation", async () => {
    const bindings = env();
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: { channel: "web", instruction: "Find the policy under the pinned Release" }
    }), bindings);
    const task = (await created.json()).task;
    assert.equal(task.releaseId, "knowledge-mate-r1");

    bindings.definition.release.id = "knowledge-mate-r2";
    bindings.definition.release.version = 2;
    bindings.definition.release.manifest.release.releaseId = "knowledge-mate-r2";
    bindings.definition.release.manifest.release.version = 2;

    const run = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST"
    }), bindings);
    assert.equal(run.status, 409);
    const failure = await run.json();
    assert.equal(failure.error, "task_release_changed");
    assert.equal(failure.expectedReleaseId, "knowledge-mate-r1");

    const taskAfterConflict = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}`), bindings);
    const queued = (await taskAfterConflict.json()).task;
    assert.equal(queued.status, "queued");
    assert.equal(queued.activeRunId, undefined);
    assert.equal(queued.attemptCount, 0);

    const runs = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/runs`), bindings);
    assert.deepEqual((await runs.json()).runs, []);
    assert.equal(bindings.knowledgeCalls.length, 0);
    assert.equal(bindings.modelCalls.length, 0);
    assert.equal(bindings.appRegistryCalls.length, 0);
    assert.equal(bindings.authCalls.length, 0);
    assert.equal(bindings.appCalls.length, 0);
  });

  it("executes App MCP reads only with the current user's live authorization", async () => {
    const bindings = env();
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: {
        channel: "web",
        context: { capabilitySelection: { appIds: ["portfolio-tracker"], knowledgeServiceIds: [] } },
        instruction: "Read client c-1"
      }
    }), bindings);
    const task = (await created.json()).task;

    const run = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST",
      body: {
        executor: "app_mcp",
        operation: { appId: "portfolio-tracker", toolName: "portfolio_client_read", arguments: { clientId: "c-1" } }
      }
    }), bindings);
    assert.equal(run.status, 200);
    const payload = await run.json();
    assert.equal(payload.task.status, "completed");
    assert.deepEqual(payload.output, { clientId: "c-1", subjectUserId: "user-a" });
    assert.equal(bindings.appRegistryCalls.at(-1).userId, "user-a");
    assert.equal(bindings.authCalls.every((call) => call.principal.sub === "user-a"), true);
    assert.equal(bindings.appCalls.filter((call) => call.url.pathname === "/mcp/clients/read").length, 1);

    const otherUser = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST",
      userId: "user-b",
      body: {
        executor: "app_mcp",
        operation: { appId: "portfolio-tracker", toolName: "portfolio_client_read", arguments: { clientId: "c-1" } }
      }
    }), bindings);
    assert.equal(otherUser.status, 404);

    bindings.deniedAppUsers.add("user-b");
    const deniedCreated = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      userId: "user-b",
      body: { channel: "web", instruction: "Read client c-2" }
    }), bindings);
    const deniedTask = (await deniedCreated.json()).task;
    const deniedRun = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${deniedTask.id}/run`, {
      method: "POST",
      userId: "user-b",
      body: {
        executor: "app_mcp",
        operation: { appId: "portfolio-tracker", toolName: "portfolio_client_read", arguments: { clientId: "c-2" } }
      }
    }), bindings);
    assert.equal((await deniedRun.json()).task.status, "failed");
    assert.equal(bindings.appCalls.some((call) => call.userId === "user-b" && call.url.pathname === "/mcp/clients/read"), false);
  });

  it("requires an exact-action single-use Approval for App MCP writes and revalidates access", async () => {
    const bindings = env();
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: { channel: "web", instruction: "Update client c-1" }
    }), bindings);
    const task = (await created.json()).task;
    const proposal = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST",
      body: {
        executor: "app_mcp",
        operation: {
          appId: "portfolio-tracker",
          toolName: "portfolio_client_update",
          arguments: { clientId: "c-1", note: "Reviewed" }
        }
      }
    }), bindings);
    assert.equal(proposal.status, 202);
    const proposed = await proposal.json();
    assert.equal(proposed.task.status, "waiting_for_approval");
    assert.equal(proposed.approval.status, "pending");
    assert.match(proposed.approval.actionDigest, /^sha256:/);
    assert.deepEqual(proposed.approval.operation.arguments, { clientId: "c-1", note: "Reviewed" });
    assert.equal(bindings.appCalls.some((call) => call.url.pathname === "/mcp/clients/update"), false);
    assert.equal(bindings.authCalls.some((call) => call.toolName === "portfolio_client_update"), false);

    const otherApprovals = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/approvals", { userId: "user-b" }), bindings);
    assert.deepEqual((await otherApprovals.json()).approvals, []);
    const otherDecision = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${proposed.approval.id}/decision`, {
      method: "POST",
      userId: "user-b",
      body: { decision: "approve" }
    }), bindings);
    assert.equal(otherDecision.status, 404);

    const approved = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${proposed.approval.id}/decision`, {
      method: "POST",
      body: { decision: "approve", operation: { arguments: { clientId: "c-999", note: "Tampered" } } }
    }), bindings);
    assert.equal(approved.status, 200);
    const executed = await approved.json();
    assert.equal(executed.approval.status, "consumed");
    assert.equal(executed.task.status, "completed");
    assert.deepEqual(executed.output, { clientId: "c-1", note: "Reviewed", subjectUserId: "user-a", updated: true });
    assert.equal(bindings.appCalls.filter((call) => call.url.pathname === "/mcp/clients/update").length, 1);

    const repeated = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${proposed.approval.id}/decision`, {
      method: "POST",
      body: { decision: "approve" }
    }), bindings);
    assert.equal(repeated.status, 409);
    assert.equal(bindings.appCalls.filter((call) => call.url.pathname === "/mcp/clients/update").length, 1);

    const revokedCreated = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: { channel: "web", instruction: "Update client c-2" }
    }), bindings);
    const revokedTask = (await revokedCreated.json()).task;
    const revokedProposal = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${revokedTask.id}/run`, {
      method: "POST",
      body: {
        executor: "app_mcp",
        operation: {
          appId: "portfolio-tracker",
          toolName: "portfolio_client_update",
          arguments: { clientId: "c-2", note: "Should not execute" }
        }
      }
    }), bindings);
    const revokedApproval = (await revokedProposal.json()).approval;
    bindings.deniedAppUsers.add("user-a");
    const revokedDecision = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${revokedApproval.id}/decision`, {
      method: "POST",
      body: { decision: "approve" }
    }), bindings);
    const revoked = await revokedDecision.json();
    assert.equal(revoked.task.status, "failed");
    assert.equal(revoked.approval.status, "consumed");
    assert.equal(bindings.appCalls.filter((call) => call.url.pathname === "/mcp/clients/update").length, 1);
  });

  it("publishes a Release-bound Forum topic only after current-user single-use Approval", async () => {
    const definition = runtimeDefinition();
    if (!definition.release.manifest.resources.builtInToolBindings.some((binding) => binding.toolId === "workspace_forum_post")) {
      definition.release.manifest.resources.builtInToolBindings.push({
        requiresCurrentUserContext: true,
        toolId: "workspace_forum_post"
      });
    }
    const bindings = env({ definition });
    const forumCalls = [];
    bindings.WORKSPACE_MCP_SERVICE = {
      async fetch(request) {
        forumCalls.push(request.clone());
        assert.equal(new URL(request.url).pathname, "/internal/runtime/workspace-pass/tools/forum_write");
        assert.equal(request.headers.get("x-workspace-runtime-approval"), "single-use-approved");
        const body = await request.json();
        assert.equal(body.action, "create_topic");
        return Response.json({ topic: { id: "topic-runtime-1", title: body.title } }, { status: 201 });
      }
    };

    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: { channel: "web", instruction: "Publish the approved release note" }
    }), bindings);
    const task = (await created.json()).task;
    const proposal = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST",
      body: {
        operation: {
          bodyMarkdown: "Cortana Runtime is ready for staged validation.",
          categorySlug: "platform-help",
          tags: ["mate", "runtime"],
          title: "Cortana Runtime validation",
          topicType: "release",
          type: "workspace_forum_create_topic"
        }
      }
    }), bindings);
    assert.equal(proposal.status, 202);
    const proposed = await proposal.json();
    assert.equal(proposed.approval.status, "pending");
    assert.equal(proposed.approval.riskLevel, "medium");
    assert.equal(proposed.task.status, "waiting_for_approval");
    assert.equal(forumCalls.length, 0);

    const approved = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${proposed.approval.id}/decision`, {
      method: "POST",
      body: { decision: "approve" }
    }), bindings);
    assert.equal(approved.status, 200, await approved.clone().text());
    const executed = await approved.json();
    assert.equal(executed.approval.status, "consumed");
    assert.equal(executed.task.status, "completed");
    assert.equal(executed.topic.id, "topic-runtime-1");
    assert.equal(forumCalls.length, 1);
    assert.equal(forumCalls[0].method, "POST");
    assert.equal(forumCalls[0].headers.get("x-workspace-runtime-user-id"), "user-a");
    assert.equal((await forumCalls[0].json()).idempotencyKey.startsWith(`mate:${task.id}:`), true);

    const repeated = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${proposed.approval.id}/decision`, {
      method: "POST",
      body: { decision: "approve" }
    }), bindings);
    assert.equal(repeated.status, 409);
    assert.equal(forumCalls.length, 1);
  });

  it("executes Release-bound Knowledge maintenance only after current-user single-use Approval", async () => {
    const definition = runtimeDefinition();
    definition.release.manifest.resources.folderEditBindings = [{
      folderObjectId: "pb-root", authority: { mode: "invoking_user" }, requiresCurrentUserAuthorization: true
    }];
    definition.release.manifest.resources.builtInToolBindings.push({
      requiresCurrentUserContext: true,
      toolId: "workspace_knowledge_maintain"
    });
    const bindings = env({ definition });
    const knowledgeMaintenanceCalls = [];
    bindings.WORKSPACE_MCP_SERVICE = {
      async fetch(request) {
        knowledgeMaintenanceCalls.push(request.clone());
        return Response.json({ deleted: true, objectId: "file-1" });
      }
    };

    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: { channel: "web", instruction: "Delete obsolete policy draft" }
    }), bindings);
    const task = (await created.json()).task;
    const proposal = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST",
      body: {
        operation: {
          arguments: { objectId: "file-1" },
          toolName: "knowledge_library_delete",
          type: "workspace_knowledge_maintenance"
        }
      }
    }), bindings);
    assert.equal(proposal.status, 202, await proposal.clone().text());
    const proposed = await proposal.json();
    assert.equal(proposed.approval.status, "pending");
    assert.equal(proposed.approval.riskLevel, "high");
    assert.equal(proposed.task.status, "waiting_for_approval");
    assert.equal(knowledgeMaintenanceCalls.length, 0);

    const approved = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${proposed.approval.id}/decision`, {
      method: "POST",
      body: { decision: "approve" }
    }), bindings);
    assert.equal(approved.status, 200, await approved.clone().text());
    const executed = await approved.json();
    assert.equal(executed.approval.status, "consumed");
    assert.equal(executed.task.status, "completed");
    assert.equal(executed.result.deleted, true);
    assert.equal(knowledgeMaintenanceCalls.length, 1);
    assert.equal(knowledgeMaintenanceCalls[0].headers.get("x-workspace-runtime-user-id"), "user-a");
    assert.deepEqual(JSON.parse(knowledgeMaintenanceCalls[0].headers.get("x-workspace-folder-edit-scope")), ["pb-root"]);
    assert.equal(
      new URL(knowledgeMaintenanceCalls[0].url).pathname,
      "/internal/runtime/knowledge/tools/knowledge_library_delete"
    );
    const body = await knowledgeMaintenanceCalls[0].json();
    assert.equal(body.confirm, true);
    assert.equal(body.idempotencyKey.startsWith(`mate:${task.id}:`), true);

    const repeated = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${proposed.approval.id}/decision`, {
      method: "POST",
      body: { decision: "approve" }
    }), bindings);
    assert.equal(repeated.status, 409);
    assert.equal(knowledgeMaintenanceCalls.length, 1);
  });

  it("conversation text edits create stored approvals and cannot write before confirmation", async () => {
    const definition = runtimeDefinition();
    definition.release.manifest.resources.knowledgeServiceBindings = [];
    definition.release.manifest.resources.folderEditBindings = [{ folderObjectId: "pb-root", authority: { mode: "invoking_user" }, requiresCurrentUserAuthorization: true }];
    definition.release.manifest.resources.builtInToolBindings = [{ toolId: "workspace_knowledge_maintain", requiresCurrentUserContext: true }];
    const bindings = env({ definition });
    const calls = [];
    bindings.WORKSPACE_MCP_SERVICE = { async fetch(req) {
      calls.push(req.clone());
      if (req.method === "GET") return Response.json({ catalogVersion: "1.5.0", domains: ["apps", "knowledge"], tools: [] });
      return Response.json({ item: { id: "file-1", currentVersionId: "v1" } });
    } };
    const knowledgeCalls = () => calls.filter((request) => request.method === "POST");
    const conversationId = "conv_approval_scope_01";
    const conversation = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/conversations", {
      method: "POST", body: { channel: "sdk", conversationId, title: "Approval scope" }
    }), bindings);
    assert.equal(conversation.status, 201);
    const tools = await createConversationTools(bindings, definition, { userId: "user-a", callerKind: "user" }, {
      appIds: [], knowledgeServiceIds: [], attachments: new Map(), mode: "live", turnId: "edit-turn", conversationId
    }, []);
    const proposed = await tools.knowledge_folder_edit_propose.execute({
      objectId: "file-1", expectedCurrentVersionId: "v1", operation: "append_text", text: "Approved content"
    }, {});
    assert.equal(proposed.approval.status, "pending");
    assert.equal(knowledgeCalls().length, 1);
    assert.match(knowledgeCalls()[0].url, /knowledge_file_read$/);
    const listed = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/approvals"), bindings);
    const approvals = (await listed.json()).approvals;
    assert.equal(approvals[0].operation.arguments.text, "Approved content");
    assert.equal(approvals[0].conversationId, conversationId);
    const approved = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${proposed.approval.id}/decision`, {
      method: "POST", body: { decision: "approve" }
    }), bindings);
    assert.equal((await approved.json()).task.status, "completed");
    assert.equal(knowledgeCalls().length, 2);
    assert.match(knowledgeCalls()[1].url, /knowledge_library_write$/);
    assert.equal(knowledgeCalls()[1].headers.get("x-workspace-folder-edit-scope"), '["pb-root"]');
  });

  it("rejects malformed patches before approval and persists specific execution failures", async () => {
    const definition = runtimeDefinition();
    definition.release.manifest.resources.folderEditBindings = [{ folderObjectId: "pb-root", authority: { mode: "invoking_user" }, requiresCurrentUserAuthorization: true }];
    definition.release.manifest.resources.builtInToolBindings = [{ toolId: "workspace_knowledge_maintain", requiresCurrentUserContext: true }];
    const bindings = env({ definition });
    let writes = 0;
    let reads = 0;
    let writeStatus = 400;
    let writeCode = "knowledge_edit_patch_invalid";
    bindings.WORKSPACE_MCP_SERVICE = { async fetch(req) {
      if (req.method === "GET") return Response.json({ catalogVersion: "1.5.0", domains: ["knowledge"], tools: [] });
      if (new URL(req.url).pathname.endsWith("knowledge_file_read")) {
        reads++;
        return Response.json({ item: { id: "file-1", currentVersionId: "v1" } });
      }
      writes++;
      if (writeStatus === 200) return Response.json({ versionAfterId: "v2" });
      return Response.json({ error: "knowledge_worker_request_failed", requestId: "mcp-test-request", message: JSON.stringify({ error: writeCode, requestId: "knowledge-test-request", message: "private upstream data" }) }, { status: writeStatus });
    } };
    const tools = await createConversationTools(bindings, definition, { userId: "user-a", callerKind: "user" }, {
      appIds: [], knowledgeServiceIds: [], attachments: new Map(), mode: "live", turnId: "patch-validation"
    }, []);
    const args = { objectId: "file-1", expectedCurrentVersionId: "v1", operation: "apply_patch", patch: "*** Begin Patch\n*** Update File: example.md\n@@\n-old\n+new\n*** End Patch" };
    const rejected = await tools.knowledge_folder_edit_propose.execute(args, {});
    assert.equal(rejected.error, "knowledge_edit_patch_invalid");
    assert.equal(rejected.approvalCreated, false);
    assert.match(rejected.guidance, /unified diff/);
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST", body: { channel: "web", instruction: "Validate patch" }
    }), bindings);
    const task = (await created.json()).task;
    const direct = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST", body: { operation: { type: "workspace_knowledge_maintenance", toolName: "knowledge_library_write", arguments: { ...args, action: "edit" } } }
    }), bindings);
    const failed = await direct.json();
    assert.equal(failed.task.status, "failed");
    assert.equal(failed.task.conclusion.failures[0].code, "knowledge_edit_patch_invalid");
    assert.equal(failed.approval, undefined);
    const listed = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/approvals"), bindings);
    assert.deepEqual((await listed.json()).approvals, []);
    args.patch = "@@ -1 +1 @@\n-old\n+new";
    for (const [status, code] of [[400, "knowledge_edit_patch_invalid"], [409, "knowledge_object_version_conflict"], [403, "folder_edit_access_denied"], [503, "knowledge_service_unavailable"], [200, ""]]) {
      writeStatus = status; writeCode = code;
      const proposed = await tools.knowledge_folder_edit_propose.execute(args, {});
      assert.equal(proposed.approval.status, "pending");
      const approved = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${proposed.approval.id}/decision`, {
        method: "POST", body: { decision: "approve" }
      }), bindings);
      const executed = await approved.json();
      assert.equal(executed.approval.status, "consumed");
      assert.equal(executed.task.status, status === 200 ? "completed" : "failed");
      if (status !== 200) {
        assert.deepEqual(executed.task.conclusion.failures[0], { approvalId: proposed.approval.id, code, upstreamStatus: status, upstreamCode: "knowledge_worker_request_failed", requestId: "mcp-test-request", causeRequestId: "knowledge-test-request" });
        assert.match(executed.task.conclusion.summary, new RegExp(code));
        assert.doesNotMatch(JSON.stringify(executed.task), /private upstream data/);
        const reloaded = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${proposed.task.id}`), bindings);
        assert.deepEqual((await reloaded.json()).task.conclusion, executed.task.conclusion);
      }
    }
    assert.equal(writes, 5);
    // Simulate a pending approval stored by the old Runtime. Revalidation must
    // stop it before a write even though it predates proposal-time validation.
    const legacy = await tools.knowledge_folder_edit_propose.execute(args, {});
    const legacyOperation = { ...legacy.approval.operation, arguments: { ...legacy.approval.operation.arguments, patch: "@@\n-old\n+new" } };
    await bindings.RUNTIME_DB.prepare("UPDATE mate_approvals SET operation_json = ? WHERE id = ?")
      .bind(JSON.stringify(legacyOperation), legacy.approval.id).run();
    const legacyResult = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${legacy.approval.id}/decision`, {
      method: "POST", body: { decision: "approve" }
    }), bindings);
    const legacyFailed = await legacyResult.json();
    assert.equal(legacyFailed.task.conclusion.failures[0].code, "knowledge_edit_patch_invalid");
    assert.equal(legacyFailed.approval.status, "consumed");
    assert.equal(writes, 5);
    await bindings.RUNTIME_DB.prepare("UPDATE mate_tasks SET created_at = '1900-01-01T00:00:00Z' WHERE id = ?").bind(legacyFailed.task.id).run();
    for (let i = 0; i < 101; i++) {
      const later = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
        method: "POST", body: { channel: "web", instruction: `Later task ${i}` }
      }), bindings);
      assert.equal(later.status, 202);
    }
    const recent = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks"), bindings);
    assert.equal((await recent.json()).tasks.some(task => task.id === legacyFailed.task.id), false);
    const storedApprovals = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/approvals"), bindings);
    const old = (await storedApprovals.json()).approvals.find(item => item.id === legacy.approval.id);
    assert.equal(old.task.status, "failed");
    assert.equal(old.task.conclusion.failures[0].code, "knowledge_edit_patch_invalid");
  });

  it("confirms only one of multiple knowledge proposals and binds its readable target", async () => {
    const definition = runtimeDefinition();
    definition.release.manifest.resources.folderEditBindings = [{ folderObjectId: "pb-root", authority: { mode: "invoking_user" }, requiresCurrentUserAuthorization: true }];
    definition.release.manifest.resources.builtInToolBindings = [{ toolId: "workspace_knowledge_maintain", requiresCurrentUserContext: true }];
    const bindings = env({ definition });
    const writes = [];
    bindings.WORKSPACE_MCP_SERVICE = { async fetch(req) {
      if (req.method === "GET") return Response.json({ catalogVersion: "1.5.0", domains: ["knowledge"], tools: [] });
      const args = await req.json();
      if (new URL(req.url).pathname.endsWith("knowledge_file_read")) {
        return Response.json({ item: { id: args.objectId, name: `${args.objectId}.md`, path: `/Research/${args.objectId}.md`, currentVersionId: "v1" } });
      }
      writes.push(args);
      return Response.json({ objectId: args.objectId, versionAfterId: "v2" });
    } };
    const tools = await createConversationTools(bindings, definition, { userId: "user-a", callerKind: "user" }, {
      appIds: [], knowledgeServiceIds: [], attachments: new Map(), mode: "live", turnId: "multiple-proposals"
    }, []);
    const a = await tools.knowledge_folder_edit_propose.execute({ objectId: "file-a", expectedCurrentVersionId: "v1", operation: "append_text", text: "A" }, {});
    const b = await tools.knowledge_folder_edit_propose.execute({ objectId: "file-b", expectedCurrentVersionId: "v1", operation: "append_text", text: "B" }, {});
    assert.equal(writes.length, 0);
    assert.notEqual(a.approval.id, b.approval.id);
    assert.deepEqual(a.approval.operation.display, { fileName: "file-a.md", path: "/Research/file-a.md" });
    const decided = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${a.approval.id}/decision`, {
      method: "POST", body: { decision: "approve" }
    }), bindings);
    assert.equal(decided.status, 200);
    assert.equal((await decided.json()).task.status, "completed");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].objectId, "file-a");
    assert.equal(writes[0].display, undefined);
    const listed = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/approvals"), bindings);
    const approvals = (await listed.json()).approvals;
    assert.equal(approvals.find(item => item.id === a.approval.id).status, "consumed");
    assert.equal(approvals.find(item => item.id === b.approval.id).status, "pending");
    const repeated = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${a.approval.id}/decision`, {
      method: "POST", body: { decision: "approve" }
    }), bindings);
    assert.equal(repeated.status, 409);
    assert.equal(writes.length, 1);
    const denied = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${b.approval.id}/decision`, {
      method: "POST", body: { decision: "deny" }
    }), bindings);
    assert.equal((await denied.json()).task.status, "cancelled");
    assert.equal(writes.length, 1);
  });

  it("archives conversation folders and text through scoped, single-use Knowledge approvals", async () => {
    const definition = runtimeDefinition();
    definition.release.manifest.resources.knowledgeServiceBindings = [];
    definition.release.manifest.resources.folderEditBindings = [{ folderObjectId: 'pb-root', authority: { mode: 'invoking_user' }, requiresCurrentUserAuthorization: true }];
    definition.release.manifest.resources.builtInToolBindings = [{ toolId: 'workspace_knowledge_maintain', requiresCurrentUserContext: true }];
    const bindings = env({ definition });
    const writes = [];
    bindings.WORKSPACE_MCP_SERVICE = { async fetch(req) {
      if (req.method === 'GET') return Response.json({ tools: [] });
      writes.push(req.clone());
      return Response.json({ item: { id: `saved-${writes.length}`, currentVersionId: 'v1' } });
    } };
    const tools = await createConversationTools(bindings, definition, { userId: 'user-a', orgId: 'org-1', callerKind: 'user' }, {
      appIds: [], knowledgeServiceIds: [], attachments: new Map(), mode: 'live', turnId: 'archive-turn'
    }, []);
    const operations = [
      { action: 'create_folder', parentObjectId: 'pb-root', name: 'Meetings' },
      { action: 'upload', parentObjectId: 'pb-root', fileName: 'minutes.md', mimeType: 'text/markdown', contentText: '# Meeting\nConfirmed decision.' }
    ];
    for (const [index, operation] of operations.entries()) {
      const proposed = await tools.knowledge_library_write.execute(operation);
      assert.equal(proposed.approval.status, 'pending');
      assert.equal(writes.length, index);
      const path = `/v1/mates/knowledge-mate/approvals/${proposed.approval.id}/decision`;
      const result = await handleMateRuntimeRequest(request(path, { method: 'POST', body: { decision: 'approve' } }), bindings);
      assert.equal((await result.json()).task.status, 'completed');
      assert.equal(writes.length, index + 1);
      assert.equal(writes[index].headers.get('x-workspace-runtime-user-id'), 'user-a');
      assert.equal(writes[index].headers.get('x-workspace-folder-edit-scope'), '["pb-root"]');
      const sent = await writes[index].json();
      assert.equal(sent.action, operation.action);
      assert.equal(sent.parentObjectId, 'pb-root');
      assert.ok(sent.idempotencyKey);
      const repeated = await handleMateRuntimeRequest(request(path, { method: 'POST', body: { decision: 'approve' } }), bindings);
      assert.equal(repeated.status, 409);
      assert.equal(writes.length, index + 1);
    }
  });

  it("rejects Knowledge maintenance when the capability is not bound to the exact Release", async () => {
    const bindings = env();
    let maintenanceCalls = 0;
    bindings.WORKSPACE_MCP_SERVICE = {
      async fetch() {
        maintenanceCalls += 1;
        return Response.json({ updated: true });
      }
    };
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: { channel: "web", instruction: "Rename a knowledge folder" }
    }), bindings);
    const task = (await created.json()).task;
    const response = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
      method: "POST",
      body: {
        operation: {
          arguments: { action: "rename", name: "New Name", objectId: "folder-1" },
          toolName: "knowledge_library_write",
          type: "workspace_knowledge_maintenance"
        }
      }
    }), bindings);
    assert.equal(response.status, 200, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.task.status, "failed");
    assert.equal(payload.task.conclusion.failures[0].code, "knowledge_maintenance_not_bound_to_release");
    assert.equal(maintenanceCalls, 0);
  });

  it("concludes denied and expired Approvals without calling the App", async () => {
    const bindings = env();
    const propose = async (clientId) => {
      const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
        method: "POST",
        body: { channel: "web", instruction: `Update ${clientId}` }
      }), bindings);
      const task = (await created.json()).task;
      const response = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, {
        method: "POST",
        body: {
          executor: "app_mcp",
          operation: {
            appId: "portfolio-tracker",
            toolName: "portfolio_client_update",
            arguments: { clientId, note: "Review" }
          }
        }
      }), bindings);
      return { approval: (await response.json()).approval, task };
    };

    const denied = await propose("c-denied");
    const deniedDecision = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${denied.approval.id}/decision`, {
      method: "POST",
      body: { decision: "deny" }
    }), bindings);
    const deniedPayload = await deniedDecision.json();
    assert.equal(deniedPayload.approval.status, "denied");
    assert.equal(deniedPayload.task.status, "cancelled");

    const expired = await propose("c-expired");
    bindings.RUNTIME_DB.database.prepare("UPDATE mate_approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(expired.approval.id);
    const expiredDecision = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/approvals/${expired.approval.id}/decision`, {
      method: "POST",
      body: { decision: "approve" }
    }), bindings);
    assert.equal(expiredDecision.status, 409);
    assert.equal((await expiredDecision.json()).error, "approval_expired");
    const expiredTask = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${expired.task.id}`), bindings);
    assert.equal((await expiredTask.json()).task.status, "failed");
    assert.equal(bindings.appCalls.filter((call) => call.url.pathname === "/mcp/clients/update").length, 0);
  });

  it("keeps Owner Task Test Sessions in a preview namespace separate from Live Conversations", async () => {
    const bindings = env();
    delete bindings.MATE_WEB_HOST_URL;
    const release = "knowledge-mate-r1";
    const ownerPage = await handleMateRuntimeRequest(request(`/owner/mates/knowledge-mate/test?release=${release}`, {
      userId: "owner-1"
    }), bindings);
    assert.equal(ownerPage.status, 200);
    const html = await ownerPage.text();
    assert.match(html, /Owner Task Test Console/);
    assert.match(html, /Preview namespace/);

    const previewCreated = await handleMateRuntimeRequest(request(`/v1/owner-test/mates/knowledge-mate/tasks?release=${release}`, {
      method: "POST",
      userId: "owner-1",
      body: { channel: "web", instruction: "Test the candidate release" }
    }), bindings);
    assert.equal(previewCreated.status, 202);
    const previewTask = (await previewCreated.json()).task;
    assert.equal(previewTask.mode, "preview");
    assert.equal(previewTask.conversationId, undefined);
    assert.match(previewTask.sessionId, /^session_/);

    const previewRun = await handleMateRuntimeRequest(request(`/v1/owner-test/mates/knowledge-mate/tasks/${previewTask.id}/run?release=${release}`, {
      method: "POST",
      userId: "owner-1"
    }), bindings);
    assert.equal(previewRun.status, 200);
    assert.match((await previewRun.json()).task.activeRunId, /^run_/);

    const previewList = await handleMateRuntimeRequest(request(`/v1/owner-test/mates/knowledge-mate/tasks?release=${release}`, {
      userId: "owner-1"
    }), bindings);
    assert.equal((await previewList.json()).tasks.length, 1);
    const liveList = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", { userId: "owner-1" }), bindings);
    assert.deepEqual((await liveList.json()).tasks, []);

    const previewConversations = await handleMateRuntimeRequest(request(`/v1/owner-test/mates/knowledge-mate/conversations?release=${release}`, {
      userId: "owner-1"
    }), bindings);
    assert.equal(previewConversations.status, 200);
    assert.deepEqual((await previewConversations.json()).conversations, []);

    for (const resource of ["todos", "reminders"]) {
      const previewInbox = await handleMateRuntimeRequest(request(
        `/v1/owner-test/mates/knowledge-mate/${resource}?release=${release}`,
        { userId: "owner-1" }
      ), bindings);
      assert.equal(previewInbox.status, 405);
      assert.equal((await previewInbox.json()).error, "owner_test_inbox_data_not_persisted");
    }

    const nonOwner = await handleMateRuntimeRequest(request(`/owner/mates/knowledge-mate/test?release=${release}`, {
      userId: "user-a"
    }), bindings);
    assert.equal(nonOwner.status, 404);
  });

  it("manages private Todos and Reminders only inside the invoking user's Release-bound inbox", async () => {
    const definition = runtimeDefinition();
    definition.release.manifest.resources.builtInToolBindings = definition.release.manifest.resources.builtInToolBindings
      .filter((binding) => binding.toolId !== "todo_manage" && binding.toolId !== "reminder_manage");
    const bindings = env({ definition });
    const todoResponse = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/todos", {
      body: { priority: "high", title: "Review release" },
      method: "POST"
    }), bindings);
    assert.equal(todoResponse.status, 201);
    const todo = (await todoResponse.json()).todo;
    const completedTodo = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/todos/${todo.id}`, {
      body: { status: "completed" },
      method: "PATCH"
    }), bindings);
    assert.equal((await completedTodo.json()).todo.status, "completed");

    const reminderResponse = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/reminders", {
      body: {
        instruction: "Send the validation summary",
        nextDueAt: "2026-09-01T09:00:00.000Z",
        title: "Validation summary",
        timezone: "Asia/Shanghai"
      },
      method: "POST"
    }), bindings);
    assert.equal(reminderResponse.status, 201);
    const reminder = (await reminderResponse.json()).reminder;
    const pausedReminder = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/reminders/${reminder.id}`, {
      body: { status: "paused" },
      method: "PATCH"
    }), bindings);
    assert.equal((await pausedReminder.json()).reminder.status, "paused");

    const otherUserTodos = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/todos", { userId: "user-b" }), bindings);
    assert.deepEqual((await otherUserTodos.json()).todos, []);
    const otherUserReminder = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/reminders/${reminder.id}`, {
      body: { status: "cancelled" },
      method: "PATCH",
      userId: "user-b"
    }), bindings);
    assert.equal(otherUserReminder.status, 404);
  });

  it("treats Web capability selection as a narrowing filter that cannot add an unbound Knowledge service", async () => {
    const bindings = env();
    const created = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: {
        channel: "web",
        instruction: "Read the private extra base",
        context: {
          capabilitySelection: {
            appIds: ["unbound-app"],
            knowledgeServiceIds: ["private-extra"]
          }
        }
      }
    }), bindings);
    const task = (await created.json()).task;
    assert.deepEqual(task.context.capabilitySelection, {
      appIds: ["unbound-app"],
      knowledgeServiceIds: ["private-extra"]
    });

    const run = await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`, { method: "POST" }), bindings);
    const completed = (await run.json()).task;
    assert.equal(completed.status, "completed");
    assert.match(completed.conclusion.summary, /No selected Knowledge tools/);
    assert.equal(bindings.knowledgeCalls.length, 0);
    assert.equal(bindings.modelCalls.length, 1);
  });

  it("accepts legacy Host Context and pins a normalized Mate 3.0 Environment snapshot", async () => {
    const bindings = env();
    const invalid = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: { channel: "sdk", instruction: "Find policy", context: { route: "/clients/1", userId: "other" } }
    }), bindings);
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error, "mate_host_sensitive_field_forbidden");

    const valid = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: {
        channel: "sdk",
        instruction: "Find policy",
        context: {
          schemaVersion: "workspace.mate-host/v1",
          appId: "portfolio-app",
          page: { route: "/clients/1" },
          resources: [{ type: "client", id: "1" }],
          allowedActions: ["client.read"]
        }
      }
    }), bindings);
    assert.equal(valid.status, 202);
    assert.equal((await valid.json()).task.context.appId, "portfolio-app");

    const environment = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: {
        channel: "sdk",
        instruction: "Review this portfolio",
        context: {
          schemaVersion: "workspace.mate-environment/v1",
          revision: 3,
          host: { appId: "portfolio-app", surface: "embedded", instanceId: "main" },
          location: { kind: "portfolio.portfolio", ref: "pf_123", route: "/portfolios/pf_123" },
          summary: { label: "Primary portfolio", facets: { tab: "allocation" } },
          resolutionHints: [{ capability: "app_mcp", bindingId: "portfolio-read" }]
        }
      }
    }), bindings);
    assert.equal(environment.status, 202);
    const environmentTask = (await environment.json()).task;
    assert.equal(environmentTask.context.schemaVersion, "workspace.mate-environment-accepted/v1");
    assert.equal(environmentTask.context.context.revision, 3);
    assert.equal(environmentTask.context.context.location.ref, "pf_123");
    assert.equal(environmentTask.context.trust, "host_asserted");
    assert.match(environmentTask.context.digest, /^sha256:[a-f0-9]{64}$/);

    const rejectedEnvironment = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST",
      body: {
        channel: "sdk",
        instruction: "Attempt authority injection",
        context: { ...environmentTask.context.context, userId: "other-user" }
      }
    }), bindings);
    assert.equal(rejectedEnvironment.status, 422);
    assert.equal((await rejectedEnvironment.json()).error, "mate_environment_sensitive_field_forbidden");
  });
});

describe("persistent work Threads across inbox channels", () => {
  function inboxEnv() {
    const definition=runtimeDefinition();
    definition.mate.workEmail="knowledge-mate@example.invalid";
    definition.release.manifest.channels.inbox.email.enabled=true;
    definition.release.manifest.channels.inbox.mateCall.enabled=true;
    const bindings=env({definition});
    const messages=[];
    bindings.LITELLM_SERVICE={async fetch(req) { messages.push(await req.json()); return taskModelStream({text:`Receipt ${messages.length}: portfolio A contains 12 positions.`}); }};
    bindings.MATE_AUTH_SERVICE_TOKEN="email-test-token";
    bindings.AUTH_SERVICE={async fetch(req) {
      const body=await req.json();
      return Response.json({orgId:"org-1",user:{id:body.email.startsWith("other") ? "user-b" : "user-a",email:body.email,status:"active"}});
    }};
    return {bindings,messages};
  }
  async function create(bindings,body,userId="user-a") {
    const response=await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks",{method:"POST",body:{channel:"mate_call",...body},userId}),bindings);
    assert.equal(response.status,202,JSON.stringify(await response.clone().json()));
    return (await response.json()).task;
  }
  async function run(bindings,task) {
    const response=await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`,{method:"POST",body:{}}),bindings);
    assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
    return (await response.json()).task;
  }
  function email(subject,body,id,extra="",sender="owner@example.invalid") {
    const raw=`From: ${sender}\r\nTo: knowledge-mate@example.invalid\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.com>\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
    return {from:sender,to:"knowledge-mate@example.invalid",headers:new Headers(),raw:new Response(raw).body,rawSize:new TextEncoder().encode(raw).length,setReject(reason){throw Error(reason);}};
  }
  it("returns reusable IDs, inherits prior exchanges and isolates the current user",async()=>{
    const {bindings,messages}=inboxEnv();
    const first=await create(bindings,{title:"Portfolio review",instruction:"Review portfolio A with 12 positions."});
    assert.match(first.threadId,/^thread_/); assert.match(first.mateCallId,/^KNOWLEDGE-MATE-[A-Z0-9]{4}$/);
    await run(bindings,first);
    const second=await create(bindings,{mateCallId:first.mateCallId,instruction:"Add a risk note to the earlier report."});
    assert.equal(second.threadId,first.threadId); await run(bindings,second);
    assert.ok(messages[1].messages.some(message=>message.role==="user" && message.content.includes("12 positions")));
    assert.ok(messages[1].messages.some(message=>message.role==="assistant" && message.content.includes("Receipt 1")));
    const response=await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/threads/${first.mateCallId}`),bindings);
    const page=await response.json(); assert.equal(page.tasks.length,2); assert.equal(page.thread.title,"Portfolio review");
    const forbidden=await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/threads/${first.threadId}`,{userId:"user-b"}),bindings);
    assert.equal(forbidden.status,404);
    const missing=await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks",{method:"POST",body:{channel:"mate_call",mateCallId:"WRONG-ABCD",instruction:"Try unknown thread"}}),bindings);
    assert.equal(missing.status,404);
    const listed=await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/threads?kind=task"),bindings);
    const threads=(await listed.json()).threads; assert.equal(threads.length,1); assert.equal(threads[0].taskCount,2);
  });
  it("distinguishes instruction-derived titles from subjects after follow-ups and receipts",async()=>{
    const {bindings}=inboxEnv();
    const instruction="Review the meeting notes.\n" + "Include each owner and action item. ".repeat(8);
    const first=await create(bindings,{instruction});
    await run(bindings,first);
    await create(bindings,{threadId:first.threadId,instruction:"Add a deadline."});
    const named=await create(bindings,{title:"Meeting review",instruction:"Review the notes."});
    const {handleMateEmail}=await import("./emailIngress.fixture.ts");
    await handleMateEmail(email("Review the notes.","Review the notes.","subject-same-as-body"),bindings,{},
      {async reply(message,definition,input) { return {subject:input.subject,messageId:"<subject-receipt@example.com>"}; }});
    const list=await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/threads"),bindings);
    const threads=(await list.json()).threads;
    const generated=threads.find(thread=>thread.id===first.threadId);
    assert.equal(generated.titleIsInstruction,true);
    assert.equal(generated.initialInstruction,instruction.trim());
    assert.equal(generated.initialChannel,"mate_call");
    assert.equal(threads.find(thread=>thread.id===named.threadId).titleIsInstruction,false);
    const emailThread=threads.find(thread=>thread.initialChannel==="email");
    assert.equal(emailThread.title,"Review the notes.");
    assert.equal(emailThread.titleIsInstruction,false);
    await create(bindings,{threadId:emailThread.id,instruction:"Continue through Mate Call."});
    const updated=await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/threads"),bindings);
    const continued=(await updated.json()).threads.find(thread=>thread.id===emailThread.id);
    assert.equal(continued.initialChannel,"email");
    assert.equal(continued.channel,"mate_call");
    assert.equal(continued.titleIsInstruction,false);
  });
  it("serializes executions so the next reply can use the previous conclusion",async()=>{
    const {bindings}=inboxEnv(); const a=await create(bindings,{instruction:"First assignment"});
    const b=await create(bindings,{threadId:a.threadId,instruction:"Next assignment"});
    const busy=await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${b.id}/run`,{method:"POST",body:{}}),bindings);
    assert.equal(busy.status,409); assert.equal((await busy.json()).error,"thread_busy");
    await run(bindings,a); await run(bindings,b);
  });
  it("binds real email reply headers and a stable subject to the same Call Thread",async()=>{
    const {handleMateEmail}=await import("./emailIngress.fixture.ts");
    const {buildThreadReply}=await import("./emailDelivery.ts");
    const {default:PostalMime}=await import("postal-mime");
    const {bindings,messages}=inboxEnv(); const first=await create(bindings,{title:"Portfolio review",instruction:"Review portfolio A."}); await run(bindings,first);
    const replies=[];
    const delivery={async reply(message,definition,input) { const built=buildThreadReply(definition,{...input,to:message.from}); replies.push(await PostalMime.parse(built.raw)); return built; }};
    await handleMateEmail(email(`[${first.mateCallId}] Portfolio review`,"Please add the risk note.","inbound-1"),bindings,{},delivery);
    assert.equal(replies.length,1); assert.equal(replies[0].subject,`[${first.mateCallId}] Portfolio review`);
    assert.equal(replies[0].inReplyTo,"<inbound-1@example.com>"); assert.match(replies[0].references,/inbound-1@example.com/);
    await handleMateEmail(email("Re: Changed title without a code","Confirm the earlier risk note.","inbound-2",`In-Reply-To: ${replies[0].messageId}\r\nReferences: <inbound-1@example.com> ${replies[0].messageId}\r\n`),bindings,{},delivery);
    assert.equal(replies.length,2); assert.equal(replies[1].subject,replies[0].subject);
    const page=await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/threads/${first.threadId}`),bindings);
    const result=await page.json(); assert.equal(result.tasks.length,3); assert.equal(result.deliveries.filter(item=>item.direction==="outbound").length,2);
    const inbound=result.deliveries.filter(item=>item.direction==="inbound");
    assert.equal(inbound.length,2);
    assert.ok(inbound.every(item=>item.fromEmail==="owner@example.invalid" && item.toEmail==="knowledge-mate@example.invalid"));
    assert.ok(messages[2].messages.some(message=>message.content.includes("risk note")));
  });
  it("retries delivery without executing a completed assignment again",async()=>{
    const {handleMateEmail}=await import("./emailIngress.fixture.ts");
    const {bindings,messages}=inboxEnv(); let attempts=0;
    const delivery={async reply(message,definition,input) { attempts++; if(attempts===1) throw Error("provider unavailable"); return {subject:`[KNOWLEDGE-MATE-${input.threadCode}] ${input.subject}`,messageId:"<outbound-retry@example.com>"}; }};
    await assert.rejects(handleMateEmail(email("Retry test","Perform the work once.","retry"),bindings,{},delivery),/provider unavailable/);
    await handleMateEmail(email("Retry test","Perform the work once.","retry"),bindings,{},delivery);
    assert.equal(messages.length,1); assert.equal(attempts,2);
    await handleMateEmail(email("Retry test","Perform the work once.","retry"),bindings,{},delivery);
    assert.equal(attempts,2);
    const list=await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/threads"),bindings);
    assert.equal((await list.json()).threads.length,1);
  });
  it("sends a failure receipt instead of claiming that execution completed",async()=>{
    const {handleMateEmail}=await import("./emailIngress.fixture.ts");
    const {bindings}=inboxEnv(); bindings.MATE_LLM_KEY="";
    const receipts=[]; const delivery={async reply(message,definition,input) { receipts.push(input.body); return {subject:input.subject,messageId:"<failure@example.com>"}; }};
    await handleMateEmail(email("Failure test","Work that cannot run.","failed"),bindings,{},delivery);
    assert.equal(receipts.length,1); assert.match(receipts[0],/Task failed/);
  });
  it("aggregates scheduled executions by plan and preserves prior results",async()=>{
    const {bindings,messages}=inboxEnv();
    const {createTask}=await import("./storage.ts");
    const principal={userId:"user-a",orgId:"org-1",callerKind:"user",scopes:["mate:invoke"]};
    const first=await createTask(bindings.RUNTIME_DB,bindings.definition,principal,"live",{channel:"schedule",title:"Morning report",instruction:"Morning run one",context:{reminderId:"reminder_plan_1"}},{allowInternalSchedule:true}); await run(bindings,first);
    const next=await createTask(bindings.RUNTIME_DB,bindings.definition,principal,"live",{channel:"schedule",title:"Morning report",instruction:"Morning run two",context:{reminderId:"reminder_plan_1"}},{allowInternalSchedule:true}); await run(bindings,next);
    assert.equal(first.threadId,next.threadId); assert.ok(messages[1].messages.some(message=>message.content.includes("Morning run one")));
    const listed=await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/threads?kind=schedule"),bindings);
    assert.equal((await listed.json()).threads[0].taskCount,2);
  });
});

it("migrates legacy email and Call chains, including a schedule's first execution without a code",async()=>{
  const db=new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../db/migrations/0002_runtime_v1.sql",import.meta.url),"utf8"));
  db.exec(readFileSync(new URL("../db/migrations/0003_cortana_inbox.sql",import.meta.url),"utf8"));
  const now="2026-10-01T00:00:00Z";
  db.prepare(`INSERT INTO mate_email_threads(mate_id,user_id,thread_code,subject,status,created_at,updated_at) VALUES('mate','u','ABCD','Daily report','open',?,?)`).run(now,now);
  db.prepare(`INSERT INTO mate_reminders(mate_id,user_id,id,title,instruction,schedule_kind,next_due_at,interval_seconds,status,thread_code,timezone,created_at,updated_at) VALUES('mate','u','plan','Daily report','Review','interval',?,86400,'active','ABCD','Asia/Shanghai',?,?)`).run(now,now,now);
  for(const [id,channel,context,root] of [["first","schedule",{reminderId:"plan"},"first"],["next","schedule",{reminderId:"plan",threadCode:"ABCD"},"first"],["call","mate_call",{},"call"],["call-next","mate_call",{},"call"]]) {
    db.prepare(`INSERT INTO mate_sessions(mate_id,user_id,runtime_mode,id,kind,channel,release_id,status,created_at) VALUES('mate','u','live',?,'task_ingress',?,'r1','closed',?)`).run(id,channel,now);
    db.prepare(`INSERT INTO mate_tasks(mate_id,user_id,runtime_mode,id,session_id,root_task_id,release_id,channel,status,instruction,context_json,created_at,updated_at) VALUES('mate','u','live',?,?,?,'r1',?,'completed','Review',?,?,?)`).run(id,id,root,channel,JSON.stringify(context),now,now);
  }
  db.exec(readFileSync(new URL("../db/migrations/0010_work_threads.sql",import.meta.url),"utf8"));
  const rows=db.prepare("SELECT id,thread_id FROM mate_tasks").all();
  assert.ok(rows.every(row=>row.thread_id));
  assert.equal(rows[0].thread_id,rows[1].thread_id); assert.equal(rows[2].thread_id,rows[3].thread_id); assert.notEqual(rows[0].thread_id,rows[2].thread_id);
});

it("delivers a saved receipt idempotently and retries email failure without executing tools",async()=>{
  const definition=runtimeDefinition(); definition.mate.workEmail="knowledge-mate@example.invalid"; definition.release.manifest.channels.inbox.mateCall.enabled=true;
  const bindings=env({definition});
  const {createTask,concludeTask}=await import("./storage.ts");
  const principal={userId:"user-a",orgId:"org-1",callerKind:"user",email:"user-a@example.invalid",scopes:[]};
  const task=await createTask(bindings.RUNTIME_DB,definition,principal,"live",{channel:"mate_call",instruction:"Deliver saved work"});
  await concludeTask(bindings.RUNTIME_DB,definition.mate.id,"user-a","live",task.id,{outcome:"completed",summary:"The report is ready."});
  let sends=0; const sent=[];
  bindings.WORKSPACE_MAIL_SECRET="test-workspace-mail-service-secret-at-least-32-characters";
  bindings.WORKSPACE_MAIL={async fetch(request){const mail=await request.json();sends++;sent.push(mail);if(sends===1)return Response.json({error:"temporarily_unavailable"},{status:503});return Response.json({status:"sent",messageId:"<provider-1@example.com>"});}};
  const call=async()=>{const req=request(`/v1/mates/knowledge-mate/tasks/${task.id}/receipt`,{method:"POST",body:{}});req.headers.set("x-workspace-user-email",principal.email);return handleMateRuntimeRequest(req,bindings);};
  assert.equal((await call()).status,502);assert.equal((await call()).status,200);assert.equal((await call()).status,200);
  assert.equal(sends,2);assert.equal(bindings.modelCalls.length,0);assert.equal(sent[1].to,principal.email);assert.match(sent[1].subject,new RegExp(task.threadCode));
});

it("pages through all work receipts without mixing another user's records",async()=>{
  const bindings=env(); const {createTask,concludeTask}=await import("./storage.ts");
  const principal={userId:"user-a",orgId:"org-1",callerKind:"user",scopes:[]}; let threadId;
  for(let i=0;i<55;i++) {
    const task=await createTask(bindings.RUNTIME_DB,bindings.definition,principal,"live",{channel:"mate_call",instruction:`Request ${i}`,...(threadId ? {threadId} : {})}); threadId=task.threadId;
    await concludeTask(bindings.RUNTIME_DB,bindings.definition.mate.id,principal.userId,"live",task.id,{outcome:"completed",summary:`Receipt ${i}`});
  }
  const first=await (await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/threads/${threadId}`),bindings)).json();
  assert.equal(first.tasks.length,50); assert.ok(first.nextCursor); assert.equal(first.tasks[0].instruction,"Request 54");
  const second=await (await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/threads/${threadId}?cursor=${first.nextCursor}`),bindings)).json();
  assert.equal(second.tasks.length,5); assert.equal(second.nextCursor,null); assert.equal(new Set([...first.tasks,...second.tasks].map(task=>task.id)).size,55);
});

it("queues a busy synchronous Thread call durably and resumes after the earlier receipt",async()=>{
  const bindings=env(); bindings.MATE_TASK_RUNNER=taskRunnerNamespace(bindings);
  bindings.LITELLM_SERVICE={async fetch(){return taskModelStream({text:"Saved receipt"});}};
  const {createTask}=await import("./storage.ts");const principal={userId:"user-a",orgId:"org-1",callerKind:"user",scopes:[]};
  const first=await createTask(bindings.RUNTIME_DB,bindings.definition,principal,"live",{channel:"mate_call",instruction:"First request"});
  const next=await createTask(bindings.RUNTIME_DB,bindings.definition,principal,"live",{channel:"mate_call",threadId:first.threadId,instruction:"Continue"});
  const queued=await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${next.id}/run`,{method:"POST",body:{}}),bindings);
  assert.equal(queued.status,202);await bindings.MATE_TASK_RUNNER.fire();
  const slot=[...bindings.MATE_TASK_RUNNER.runners.values()][0];assert.ok(await slot.storage.getAlarm());
  assert.equal((await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${first.id}/run`,{method:"POST",body:{}}),bindings)).status,200);
  await bindings.MATE_TASK_RUNNER.fire();
  const result=await (await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${next.id}`),bindings)).json();assert.equal(result.task.status,"completed");
});

it("paginates the complete schedule directory beyond the former display cap",async()=>{
  const bindings=env(); const {createReminder}=await import("./inboxStorage.ts");
  for(let i=0;i<60;i++) await createReminder(bindings.RUNTIME_DB,"knowledge-mate","user-a",{title:`Plan ${i}`,instruction:"Review work",scheduleKind:"once",nextDueAt:"2027-01-01T01:00:00Z",timezone:"Asia/Shanghai"});
  const first=await (await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/reminders"),bindings)).json();
  assert.equal(first.reminders.length,50);assert.ok(first.nextCursor);
  const next=await (await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/reminders?cursor=${first.nextCursor}`),bindings)).json();
  assert.equal(next.reminders.length,10);assert.equal(next.nextCursor,null);
});

it("keeps a completed scheduled result when email delivery is not configured",async()=>{
  const bindings=env();bindings.LITELLM_SERVICE={async fetch(){return taskModelStream({text:"Scheduled report saved."});}};
  const {createTask}=await import("./storage.ts");const {executeReminderTask}=await import("./reminderTask.ts");
  const principal={userId:"user-a",orgId:"org-1",callerKind:"user",email:"user-a@example.invalid",scopes:[]};
  const task=await createTask(bindings.RUNTIME_DB,bindings.definition,principal,"live",{channel:"schedule",instruction:"Prepare report",title:"Daily report",context:{reminderId:"daily_report"}},{allowInternalSchedule:true});
  const result=await executeReminderTask(bindings,bindings.definition,principal,task.id,{id:"daily_report",title:"Daily report",deliverEmail:true});
  assert.equal(result.task.status,"completed");assert.equal(result.delivery.status,"failed");
  const page=await (await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/threads/${task.threadId}`),bindings)).json();
  assert.equal(page.tasks[0].status,"completed");assert.ok(page.deliveries.some(delivery=>delivery.status==="failed"));
});

it("persists generated deliverable descriptors in Thread receipts and authorizes downloads",async()=>{
  const bindings=env();bindings.definition.release.manifest.resources.builtInToolBindings.push({toolId:"artifact_create",requiresCurrentUserContext:true});
  const objects=new Map();bindings.MATE_ARTIFACTS={async put(key,bytes,options){const value={bytes:new Uint8Array(bytes),size:bytes.byteLength,...options};objects.set(key,value);return value;},async get(key){const value=objects.get(key);return value ? {...value,body:new Response(value.bytes).body} : null;}};
  const steps=[{tool:"workspace_file_create",args:{fileName:"report.md",format:"markdown",content:"# Deliverable\n\nPortfolio review complete."}},{text:"The report has been generated."}];
  bindings.LITELLM_SERVICE={async fetch(){return taskModelStream(steps.shift());}};
  const created=await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks",{method:"POST",body:{channel:"mate_call",instruction:"Create a report"}}),bindings);
  const task=(await created.json()).task;
  const ran=await handleMateRuntimeRequest(request(`/v1/mates/knowledge-mate/tasks/${task.id}/run`,{method:"POST",body:{}}),bindings);assert.equal(ran.status,200);
  const artifact=(await ran.json()).task.conclusion.artifacts.find(artifact=>artifact.type==="workspace_file");
  assert.equal(artifact.fileName,"report.md");assert.ok(artifact.objectId);assert.ok(artifact.expiresAt);
  const path=`/v1/mates/knowledge-mate/workspace-files/${artifact.objectId}/download`;
  const downloaded=await handleMateRuntimeRequest(request(path),bindings);assert.equal(downloaded.status,200);assert.match(await downloaded.text(),/Portfolio review complete/);
  const forbidden=await handleMateRuntimeRequest(request(path,{userId:"user-b"}),bindings);assert.equal(forbidden.status,404);
});


it("routes authenticated knowledge thumbnails through Images and preserves upstream denials", async () => {
  const bindings = env(); let denied = false; let transformed = 0;
  bindings.KNOWLEDGE_SERVICE = { async fetch(req) {
    assert.match(req.headers.get("authorization"), /^Bearer resource:user-a:/);
    assert.equal(new URL(req.url).pathname, "/api/files/image-1/download");
    assert.equal(req.headers.get("range"), null);
    return new Response(denied ? "denied" : "private image", {status: denied ? 403 : 200,headers:{"content-type":"image/png"}});
  }};
  bindings.IMAGES = { input(stream) { return { transform(options) {
    assert.equal(options.width,640); return this;
  }, async output() { transformed++; assert.equal(await new Response(stream).text(),"private image"); return {response:()=>new Response("thumbnail")}; } }; } };
  const path = "/v1/mates/knowledge-mate/workspace-files/image-1/thumbnail";
  const req = request(path); req.headers.set("range","bytes=0-3");
  const result = await handleMateRuntimeRequest(req,bindings);
  assert.equal(result.status,200); assert.equal(await result.text(),"thumbnail");
  assert.equal(result.headers.get("content-type"),"image/jpeg");
  denied = true;
  assert.equal((await handleMateRuntimeRequest(request(path),bindings)).status,403);
  assert.equal(transformed,1);
  assert.equal((await handleMateRuntimeRequest(request(path,{method:"POST"}),bindings)).status,405);
});

it("preserves MCP task model selection and rejects models outside the Release allowlist", async () => {
  const definition = runtimeDefinition();
  definition.release.manifest.modelPolicy.allowedModels = [definition.release.manifest.modelPolicy.defaultModel, "cf-anthropic-claude-haiku-5.5", "tencent-deepseek-v4.1-flash"];
  const bindings = env({ definition });
  for (const modelId of ["cf-anthropic-claude-haiku-5.5", "tencent-deepseek-v4.1-flash"]) {
    const response = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
      method: "POST", body: { channel: "mate_call", instruction: "Read-only model routing probe", context: { capabilitySelection: { modelId, appIds: [], knowledgeServiceIds: [] } } }
    }), bindings);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).task.context.capabilitySelection.modelId, modelId);
  }
  const invalid = await handleMateRuntimeRequest(request("/v1/mates/knowledge-mate/tasks", {
    method: "POST", body: { channel: "mate_call", instruction: "Invalid route", context: { capabilitySelection: { modelId: "not-in-release" } } }
  }), bindings);
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error, "mate_model_not_allowed");
  assert.equal(bindings.modelCalls.length, 0);
});
