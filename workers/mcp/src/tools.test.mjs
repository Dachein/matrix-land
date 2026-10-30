import { testInstallation } from "../../../tests/helpers/installation.mjs";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cacheableCatalogImageUrl } from "../../../src/shared/catalogImageReference.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Ajv from "ajv";
import { WORKSPACE_MCP_RELEASED_AT, WORKSPACE_MCP_VERSION } from "../../../src/shared/mcpHandbook.ts";
import { ensureMcpLiteLlmUser } from "./llmGateway.ts";
import { callMcpTool, callPublicMcpTool, mcpTools } from "./tools.ts";
import { resolvePublicToolCall } from "./publicTools.ts";
import { callJev, generateImage, generateSpeech, generateVideo, searchWeb, transcribeAudio } from "./publicCapabilityTools.ts";
import { handleWorkspaceMcpWorkerRequest } from "./worker.ts";

const env = {
  AUTH_ISSUER: "https://auth.example.test",
  AUTH_SERVICE_TOKEN: "service-token",
  AUTH_WORKER_URL: "https://auth.example.test",
  WORKSPACE_MCP_JWT_SECRET: "test-secret",
  KNOWLEDGE_PUBLIC_URL: "https://knowledge.example.test",
  KNOWLEDGE_RESOURCE_ID: "workspace-knowledge",
  KNOWLEDGE_WORKER_URL: "https://knowledge.example.test",
  APPS_ORG_ID: "org-1",
  APPS_ORG_SLUG: "workspace",
  APPS_WORKER_URL: "https://apps.example.test"
};

const principal = {
  email: "ada@example.invalid",
  name: "Ada",
  scopes: ["workspace:hub:read", "workspace:apps:read", "workspace:apps:write"],
  sub: "user-1"
};

const skillPrincipal = {
  ...principal,
  scopes: ["workspace:apps:read", "workspace:apps:write"]
};

const knowledgePrincipal = {
  ...principal,
  connectionId: "mcp-conn-1",
  department: "Research",
  departmentId: "dept-research",
  departmentPath: ["company", "dept-investment", "dept-research"],
  orgId: "org-workspace",
  scopes: ["workspace:knowledge:read", "workspace:knowledge:write", "workspace:knowledge:share"],
  team: "Market Data",
  teamId: "team-market-data",
  teamPath: ["company", "dept-investment", "team-market-data"]
};

function actionBranch(tool, action) {
  return tool?.inputSchema.properties?.action?.enum?.includes(action)
    ? tool.inputSchema
    : undefined;
}

describe("Workspace MCP connection verification", () => {
  it("publishes a scope-independent ping_who_am_i tool", async () => {
    const tools = await mcpTools();
    const ping = tools.find((tool) => tool.name === "ping_who_am_i");

    assert.ok(ping);
    assert.equal(tools[0].name, "ping_who_am_i");
    assert.match(ping.description, /Always call this first/);
    assert.match(ping.description, /authentication/);
    assert.match(ping.description, /CLI upgrade or reinstall/);
    assert.match(ping.description, /guided-use issues/);
    assert.match(ping.description, /reauthentication details in the 401 response/);
    assert.deepEqual(ping.inputSchema, {
      type: "object",
      properties: {},
      additionalProperties: false
    });
  });

  it("returns the current account, OAuth connection, and MCP release metadata", async () => {
    const result = await callMcpTool("ping_who_am_i", {}, env, {
      agentType: "workbuddy",
      defaultAgent: { id: "finance-assistant", name: "小鲸", email: "receipts-assistant@example.invalid" },
      authenticatedAt: "2026-08-04 15:09:00",
      clientId: "mcp-oauth-workbuddy",
      connectionId: "mcp-conn-workbuddy",
      department: "AI Adoption",
      departmentId: "dept-ai",
      email: "ada@example.invalid",
      name: "Ada",
      orgId: "example-org",
      role: "member",
      scopes: [],
      sub: "user-1",
      team: "Platform",
      teamId: "team-platform"
    });

    assert.equal(result.authenticated, true);
    assert.equal(result.authenticatedAt, "2026-08-04T15:09:00.000Z");
    assert.equal(result.account.name, "Ada");
    assert.equal(result.account.email, "ada@example.invalid");
    assert.deepEqual(result.account.defaultAgent, { id: "finance-assistant", name: "小鲸", email: "receipts-assistant@example.invalid" });
    assert.equal(result.connection.agentType, "workbuddy");
    assert.equal(result.connection.authentication, "oauth");
    assert.deepEqual(result.server, {
      name: "workspace-pass",
      version: WORKSPACE_MCP_VERSION,
      releasedAt: WORKSPACE_MCP_RELEASED_AT,
      protocolVersion: "2025-06-18",
      supportedProtocolVersions: ["2025-06-18", "2025-03-26"]
    });
    assert.equal(Object.hasOwn(result, "accessToken"), false);
    assert.equal(Object.hasOwn(result, "refreshToken"), false);
  });

  it("does not expose pre-1.0 tool names as public aliases", async () => {
    await assert.rejects(
      () => callPublicMcpTool("forum_get_topic", { topicId: "topic-1" }, env, principal),
      (error) => error.status === 404 && error.code === "unknown_mcp_tool"
    );
  });

  it("publishes models_list as a scope-independent catalog tool", async () => {
    const tools = await mcpTools();
    const models = tools.find((tool) => tool.name === "models_list");

    assert.ok(models);
    assert.match(models.description, /unknown/);
    assert.deepEqual(models.inputSchema, {
      type: "object",
      properties: {},
      additionalProperties: false
    });
  });

  it("keeps undeclared model capabilities unknown instead of unsupported", async () => {
    const calls = [];
    const result = await callPublicMcpTool("models_list", {}, {
      LLM_GATEWAY_WORKER: {
        fetch: async (input) => {
          calls.push(String(input));
          return Response.json({
            source: { importedFrom: "/v1/model/info", modelCount: 2 },
            models: [
              { id: "tencent-glm-5.3-flash", capabilities: { webSearch: { state: "unknown", source: "declared" } }, endpoints: { responsesApi: "unknown", messagesApi: "unknown" }, context: { maxInputTokens: 1_000_000, maxOutputTokens: 128_000 }, pricing: { inputPerMillionTokens: 0.15, outputPerMillionTokens: 0.5 } },
              { id: "tencent-hy4-preview", capabilities: { webSearch: { state: "supported" } }, endpoints: { responsesApi: "supported", messagesApi: "unsupported", chatCompletions: "unsupported" } }
            ],
            summary: { undeclaredCapabilityCount: 1 }
          });
        }
      },
      LITELLM_URL: "https://llm.example.test"
    }, principal);

    assert.equal(calls.length, 1);
    assert.equal(calls[0], "https://llm-gateway-worker.internal/internal/models");
    assert.equal(result.source.importedFrom, "/v1/model/info");
    assert.equal(result.source.modelCount, 2);

    const glm = result.models.find((model) => model.id === "tencent-glm-5.3-flash");
    assert.equal(glm.capabilities.webSearch.state, "unknown");
    assert.equal(glm.capabilities.webSearch.source, "declared");
    assert.equal(glm.endpoints.responsesApi, "unknown");
    assert.equal(glm.endpoints.messagesApi, "unknown");
    assert.equal(glm.context.maxInputTokens, 1_000_000);
    assert.equal(glm.context.maxOutputTokens, 128_000);
    assert.equal(glm.pricing.inputPerMillionTokens, 0.15);
    assert.equal(glm.pricing.outputPerMillionTokens, 0.5);

    const hunyuan = result.models.find((model) => model.id === "tencent-hy4-preview");
    assert.equal(hunyuan.capabilities.webSearch.state, "supported");
    assert.equal(hunyuan.endpoints.responsesApi, "supported");
    assert.equal(hunyuan.endpoints.messagesApi, "unsupported");
    assert.equal(hunyuan.endpoints.chatCompletions, "unsupported");

    assert.ok(result.summary.undeclaredCapabilityCount > 0);
    assert.ok(result.notes.some((note) => note.includes("/model_group/info")));
  });

  it("publishes the Workspace MCP catalog with independent public capability tools and resolves action routes", async () => {
    const tools = await mcpTools();
    const names = tools.map((tool) => tool.name);
    assert.equal(names.length, 51);
    for (const name of ["models_list", "tools_image_generation", "tools_video_generation", "tools_web_search", "tools_web_reader", "tools_audio_asr", "tools_audio_tts", "tools_jev"]) {
      assert.ok(names.includes(name), `${name} should be public`);
    }
    for (const oldName of ["image_generation", "video_generation", "web_search", "web_reader", "whisper_asr", "jev"]) {
      assert.equal(names.includes(oldName), false);
    }
    assert.equal(tools.find((tool) => tool.name === "tools_audio_asr")?.title, "AI Resources · Audio · ASR");
    assert.equal(tools.find((tool) => tool.name === "tools_audio_tts")?.title, "AI Resources · Audio · TTS");
    assert.equal(tools.find((tool) => tool.name === "tools_web_search")?.title, "AI Resources · Web · Search");
    assert.equal(names.includes("forum_get_topic"), false);
    assert.equal(names.includes("knowledge_service_search"), false);
    assert.equal(names.includes("apps_pages_deploy"), false);
    assert.equal(names.includes("publication_mcp_accessible_list"), false);
    assert.equal(names.includes("publication_mcp_tools_list"), false);
    assert.equal(names.includes("publication_mcp_tool_call"), false);
    assert.ok(names.includes("mate_call"));
    assert.ok(names.includes("mate_builder_read"));
    assert.ok(names.includes("mate_builder_write"));
    assert.deepEqual(resolvePublicToolCall("apps_database", {
      action: "migration_apply",
      appId: "app-1",
      sql: "SELECT 1",
      version: "001"
    }), {
      kind: "internal",
      internalName: "apps_d1_migrations_apply",
      args: { appId: "app-1", sql: "SELECT 1", version: "001" }
    });
  });

  it("publishes one client-compatible root object schema for every public tool", async () => {
    const tools = await mcpTools();
    const ajv = new Ajv({ allErrors: true, strict: false });

    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.ok(tool.inputSchema.properties, tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
      assert.equal(Object.hasOwn(tool.inputSchema, "oneOf"), false, tool.name);
      assert.equal(Object.hasOwn(tool.inputSchema, "anyOf"), false, tool.name);
      assert.equal(Object.hasOwn(tool.inputSchema, "allOf"), false, tool.name);
      assert.equal(ajv.validateSchema(tool.inputSchema), true, `${tool.name}: ${ajv.errorsText()}`);
    }

    const forumRead = tools.find((tool) => tool.name === "forum_read");
    assert.deepEqual(forumRead.inputSchema.required, ["action"]);
    assert.deepEqual(forumRead.inputSchema.properties.action.enum, [
      "categories",
      "search_topics",
      "get_topic"
    ]);
    const validateForumRead = ajv.compile(forumRead.inputSchema);
    assert.equal(validateForumRead({ action: "categories" }), true);
    assert.equal(validateForumRead({ action: "search_topics", q: "DeepSeek" }), true);
    assert.equal(validateForumRead({ action: "get_topic", topicId: "topic-1" }), true);
    assert.equal(validateForumRead({ action: "unknown" }), false);
  });

  it("advertises mail.md updates on the public builder schema with bounded content", async () => {
    const tools=await mcpTools();
    const builder=tools.find(tool=>tool.name==='mate_builder_write');
    assert.equal(builder.inputSchema.properties.mail.maxLength,24000);
    const ajv=new Ajv({strict:false});const validate=ajv.compile(builder.inputSchema);
    assert.equal(validate({action:'core_update',mateId:'ai-adoption',expectedRevision:10,mail:''}),true);
    assert.equal(validate({action:'core_update',mateId:'ai-adoption',expectedRevision:10,mail:'x'.repeat(24001)}),false);
  });

  it("enforces the selected operation's original schema on the server", async () => {
    const forumPrincipal = { ...principal, scopes: ["workspace:forum:read"] };
    const knowledgeReadPrincipal = { ...principal, scopes: ["workspace:knowledge:read"] };

    await assert.rejects(
      () => callPublicMcpTool("forum_read", {}, env, forumPrincipal),
      (error) => error.status === 400 && error.code === "invalid_mcp_tool_action"
    );
    await assert.rejects(
      () => callPublicMcpTool("forum_read", { action: "get_topic" }, env, forumPrincipal),
      (error) => error.status === 400
        && error.code === "invalid_mcp_tool_arguments"
        && /topicId/.test(error.message)
    );
    await assert.rejects(
      () => callPublicMcpTool("forum_read", { action: "categories", topicId: "topic-1" }, env, forumPrincipal),
      (error) => error.status === 400
        && error.code === "invalid_mcp_tool_arguments"
        && /does not support topicId/.test(error.message)
    );
    await assert.rejects(
      () => callPublicMcpTool("knowledge_file_read", {
        serviceId: "service-1"
      }, env, knowledgeReadPrincipal),
      (error) => error.status === 400 && error.code === "invalid_mcp_tool_arguments"
    );
    await assert.rejects(
      () => callPublicMcpTool("knowledge_feedback_submit", {
        idempotencyKey: "feedback-1",
        kind: "issue",
        message: "Missing target"
      }, env, knowledgeReadPrincipal),
      (error) => error.status === 400 && error.code === "invalid_mcp_tool_arguments"
    );
    await assert.rejects(
      () => callPublicMcpTool("apps_deploy_prepare", {
        action: "pages",
        appId: "app-1"
      }, env, principal),
      (error) => error.status === 400 && error.code === "invalid_mcp_tool_arguments"
    );
  });

  it("returns and records a diagnosable MCP result for invalid action arguments", async () => {
    const writes = [];
    const response = await handleWorkspaceMcpWorkerRequest(new Request("http://127.0.0.1:8793/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workspace-scopes": "workspace:forum:read",
        "x-workspace-user-id": "user-1",
        "x-request-id": "request-invalid-schema-1"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "forum_read",
          arguments: { action: "get_topic" }
        }
      })
    }), { ...testInstallation,
      DEV_AUTH_BYPASS: "1",
      DB: {
        prepare(sql) {
          return {
            bind(...bindings) {
              return {
                async run() {
                  writes.push({ bindings, sql });
                }
              };
            }
          };
        }
      }
    });
    const rpc = await response.json();

    assert.equal(rpc.error, undefined);
    assert.equal(rpc.result.isError, true);
    assert.equal(rpc.result.structuredContent.error.code, "invalid_mcp_tool_arguments");
    assert.match(rpc.result.content[0].text, /topicId/);
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /INSERT OR IGNORE INTO activity_events/);
    assert.equal(writes[0].bindings[1], "agent.tool.blocked");
    const metadata = JSON.parse(writes[0].bindings[11]);
    assert.equal(metadata.errorCode, "invalid_mcp_tool_arguments");
    assert.equal(metadata.toolName, "forum_read");
  });
});

describe("Workspace MCP LiteLLM user provisioning", () => {
  it("creates a missing MCP user with the default L1 monthly budget", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ input: String(input), init });
      if (String(input).includes("/user/info?")) {
        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ user_info: JSON.parse(init.body) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      await ensureMcpLiteLlmUser({
        LITELLM_PROVISIONING_KEY: "sk-provisioning",
        LITELLM_URL: "https://llm.example.test/"
      }, principal, "Ada@Example.invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(calls.map((call) => call.input), [
      "https://llm.example.test/user/info?user_id=ada%40example.invalid",
      "https://llm.example.test/user/new"
    ]);
    const createBody = JSON.parse(calls[1].init.body);
    assert.equal(createBody.user_id, "ada@example.invalid");
    assert.equal(createBody.max_budget, 10);
    assert.equal(createBody.rpm_limit, 60);
    assert.equal(createBody.tpm_limit, 2_000_000);
    assert.equal(createBody.budget_duration, "30d");
    assert.equal(createBody.metadata.workspace.journeyLevelKey, "newcomer");
    assert.equal(createBody.metadata.workspace.budgetManagedBy, "journey-level");
    assert.equal(createBody.metadata.workspace.issuedVia, "workspace-mcp");
    assert.equal(createBody.metadata.workspace.rateLimitRepairVersion, 2);
  });

  it("repairs an existing unlimited MCP user before Portal insertion", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ input: String(input), init });
      if (String(input).includes("/user/info?")) {
        return new Response(JSON.stringify({
          user_id: "ada@example.invalid",
          max_budget: 0,
          metadata: { trace: "keep" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(JSON.parse(init.body)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      await ensureMcpLiteLlmUser({
        LITELLM_PROVISIONING_KEY: "sk-provisioning",
        LITELLM_URL: "https://llm.example.test"
      }, principal, "ada@example.invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls[1].input, "https://llm.example.test/user/update");
    const updateBody = JSON.parse(calls[1].init.body);
    assert.equal(updateBody.max_budget, 10);
    assert.equal(updateBody.rpm_limit, 60);
    assert.equal(updateBody.tpm_limit, 2_000_000);
    assert.equal(updateBody.budget_duration, "30d");
    assert.equal(updateBody.metadata.trace, "keep");
  });

  it("repairs zero and missing rate limits without overwriting budget metadata", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ input: String(input), init });
      if (String(input).includes("/user/info?")) {
        return new Response(JSON.stringify({
          user_info: {
            user_id: "ada@example.invalid",
            user_email: "ada@example.invalid",
            user_alias: "Existing Ada",
            max_budget: 75,
            budget_duration: "30d",
            rpm_limit: 0,
            metadata: {
              trace: "keep",
              workspace: { budgetManagedBy: "admin", allocationId: "allocation-1" }
            }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(JSON.parse(init.body)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    try {
      await ensureMcpLiteLlmUser({
        LITELLM_PROVISIONING_KEY: "sk-provisioning",
        LITELLM_URL: "https://llm.example.test"
      }, principal, "ada@example.invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 2);
    assert.equal(calls[1].input, "https://llm.example.test/user/update");
    const updateBody = JSON.parse(calls[1].init.body);
    assert.equal(updateBody.rpm_limit, 60);
    assert.equal(updateBody.tpm_limit, 2_000_000);
    assert.equal(Object.hasOwn(updateBody, "max_budget"), false);
    assert.equal(Object.hasOwn(updateBody, "budget_duration"), false);
    assert.equal(updateBody.metadata.trace, "keep");
    assert.equal(updateBody.metadata.workspace.budgetManagedBy, "admin");
    assert.equal(updateBody.metadata.workspace.allocationId, "allocation-1");
    assert.equal(updateBody.metadata.workspace.rateLimitRepairVersion, 2);
  });

  it("preserves explicit positive custom rate limits", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const existing = {
      user_info: {
        user_id: "ada@example.invalid",
        max_budget: 75,
        rpm_limit: 17,
        tpm_limit: 34_567,
        metadata: { trace: "keep" }
      }
    };
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify(existing), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    let result;
    try {
      result = await ensureMcpLiteLlmUser({
        LITELLM_PROVISIONING_KEY: "sk-provisioning",
        LITELLM_URL: "https://llm.example.test"
      }, principal, "ada@example.invalid");
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 1);
    assert.deepEqual(result, existing);
  });
});

describe("Workspace MCP forum tools", () => {
  const forumPrincipal = {
    ...principal,
    scopes: ["workspace:forum:write"]
  };

  it("lists the forum reply tool with explicit Markdown input", async () => {
    const tools = await mcpTools();
    const replyTool = actionBranch(tools.find((tool) => tool.name === "forum_write"), "create_reply");

    assert.ok(replyTool);
    assert.deepEqual(replyTool.required, ["action"]);
    assert.equal(replyTool.properties.bodyMarkdown.maxLength, 8000);
  });

  it("lists a stable idempotency key for forum topic publishing", async () => {
    const tools = await mcpTools();
    const topicTool = actionBranch(tools.find((tool) => tool.name === "forum_write"), "create_topic");

    assert.ok(topicTool);
    assert.equal(topicTool.properties.idempotencyKey.maxLength, 128);
  });

  it("lists an owner-bound forum topic update tool", async () => {
    const tools = await mcpTools();
    const topicTool = actionBranch(tools.find((tool) => tool.name === "forum_write"), "update_topic");

    assert.ok(topicTool);
    assert.deepEqual(topicTool.required, ["action"]);
    assert.equal(topicTool.properties.bodyMarkdown.maxLength, 8000);
    assert.equal(topicTool.properties.title.maxLength, 140);
    assert.equal(topicTool.properties.attachments.maxItems, 16);
    assert.deepEqual(topicTool.properties.attachments.items.required, ["storageKey"]);
    assert.match(topicTool.properties.attachments.description, /forum_media/);
    assert.equal(topicTool.properties.retainedAttachmentIds.maxItems, 16);
    assert.match(topicTool.properties.retainedAttachmentIds.description, /replace/);
  });

  it("lists the direct binary upload tools (upload_begin / upload_finalize)", async () => {
    const tools = await mcpTools();
    const mediaTool = tools.find((tool) => tool.name === "forum_media");
    const begin = actionBranch(mediaTool, "begin");
    const finish = actionBranch(mediaTool, "finalize");

    assert.ok(begin);
    assert.ok(finish);
    assert.deepEqual(begin.required, ["action"]);
    assert.deepEqual(finish.required, ["action"]);
    assert.equal(begin.properties.size.maximum, 50 * 1024 * 1024);
  });

  it("exposes a service-authenticated, current-user Forum read adapter for Mate Runtime", async () => {
    const calls = [];
    const database = {
      prepare(sql) {
        return {
          bind(...bindings) {
            calls.push({ bindings, sql });
            return {
              async all() {
                return { results: [{
                  author: "Ada",
                  category: "Platform Help",
                  createdAt: "2026-08-21T00:00:00.000Z",
                  excerpt: "Adoption request",
                  id: "topic-1",
                  lastActiveAt: "2026-08-21T01:00:00.000Z",
                  replyCount: 0,
                  tags: "adoption",
                  title: "Improve onboarding"
                }] };
              }
            };
          }
        };
      }
    };
    const response = await handleWorkspaceMcpWorkerRequest(new Request(
      "https://mcp.example.test/internal/runtime/forum/topics?updatedAfter=2026-08-20T00%3A00%3A00Z&limit=20",
      { headers: {
        authorization: "Bearer runtime-service-token",
        "x-workspace-runtime-org-id": "org-workspace",
        "x-workspace-runtime-user-email": "ada@example.invalid",
        "x-workspace-runtime-user-id": "user-1"
      } }
    ), { ...testInstallation,  ...env, DB: database, MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token" });
    assert.equal(response.status, 200, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.topics[0].id, "topic-1");
    assert.deepEqual(payload.topics[0].tags, ["adoption"]);
    assert.match(calls[0].sql, /last_active_at > \?/);
    assert.equal(calls[0].bindings[0], "2026-08-20T00:00:00.000Z");

    const denied = await handleWorkspaceMcpWorkerRequest(new Request(
      "https://mcp.example.test/internal/runtime/forum/topics",
      { headers: {
        authorization: "Bearer wrong-token",
        "x-workspace-runtime-org-id": "org-workspace",
        "x-workspace-runtime-user-id": "user-1"
      } }
    ), { ...testInstallation,  ...env, DB: database, MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token" });
    assert.equal(denied.status, 401);
  });

  it("exposes AI, Forum & Hub, and Knowledge without cloud APPS management", async () => {
    const headers = {
      authorization: "Bearer runtime-service-token",
      "content-type": "application/json",
      "x-workspace-runtime-org-id": "org-workspace",
      "x-workspace-runtime-user-email": "ada@example.invalid",
      "x-workspace-runtime-user-id": "user-1"
    };
    const bindings = { ...testInstallation,  ...env, MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token" };
    const catalogResponse = await handleWorkspaceMcpWorkerRequest(new Request(
      "https://mcp.example.test/internal/runtime/workspace-pass/tools",
      { headers }
    ), bindings);
    assert.equal(catalogResponse.status, 200, await catalogResponse.clone().text());
    const catalog = await catalogResponse.json();
    assert.deepEqual(catalog.domains, ["apps", "knowledge"]);
    assert.ok(catalog.tools.some((tool) => tool.name === "tools_image_generation" && tool.capacity.child === "image"));
    assert.ok(catalog.tools.some((tool) => tool.name === "knowledge_query" && tool.runtimePolicy.writeMode === "never"));
    assert.ok(catalog.tools.some((tool) => tool.name === "knowledge_list" && tool.runtimePolicy.writeMode === "never"));
    assert.ok(catalog.tools.some((tool) => tool.name === "forum_write" && tool.capacity.child === "forum_write"));
    assert.ok(catalog.tools.some((tool) => tool.name === "hub_search" && tool.capacity.child === "hub_discovery"));
    assert.equal(catalog.tools.some((tool) => tool.name.startsWith("apps_")), false);
    assert.equal(catalog.tools.some((tool) => tool.name === "hub_submit_listing"), false);
    assert.equal(catalog.tools.some((tool) => tool.name.startsWith("publication_")), false);

    const deniedWrite = await handleWorkspaceMcpWorkerRequest(new Request(
      "https://mcp.example.test/internal/runtime/workspace-pass/tools/forum_write",
      { body: JSON.stringify({ action: "create_topic", title: "No approval" }), headers, method: "POST" }
    ), bindings);
    assert.equal(deniedWrite.status, 403);
    assert.equal((await deniedWrite.json()).error, "runtime_workspace_pass_approval_required");

    const deniedUnknownAction = await handleWorkspaceMcpWorkerRequest(new Request(
      "https://mcp.example.test/internal/runtime/workspace-pass/tools/forum_write",
      { body: JSON.stringify({ action: "future_mutation" }), headers, method: "POST" }
    ), bindings);
    assert.equal(deniedUnknownAction.status, 403);
    assert.equal((await deniedUnknownAction.json()).error, "runtime_workspace_pass_approval_required");

    const spoofedIdentity = await handleWorkspaceMcpWorkerRequest(new Request(
      "https://mcp.example.test/internal/runtime/workspace-pass/tools/forum_read",
      { body: JSON.stringify({ action: "categories", userId: "owner-1" }), headers, method: "POST" }
    ), bindings);
    assert.equal(spoofedIdentity.status, 400);
    assert.equal((await spoofedIdentity.json()).error, "runtime_authority_field_forbidden");
  });

  it("mints Mate Knowledge reads as the current user without an OAuth connection", async () => {
    const originalFetch = globalThis.fetch;
    const mints = [];
    const { AUTH_SERVICE_TOKEN: _authServiceToken, ...runtimeEnv } = env;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        mints.push({ authorization: init.headers.Authorization, body: JSON.parse(init.body) });
        return Response.json({ access_token: "current-user-knowledge-token" });
      }
      assert.equal(init.headers.Authorization, "Bearer current-user-knowledge-token");
      if (url.endsWith("/api/tree")) return Response.json({ items: [{ id: "viewer-root", capabilities: { canRead: true } }] });
      if (url.endsWith("/api/shared-with-me")) return Response.json({ items: [] });
      if (url.endsWith("/api/knowledge-services?view=card")) return Response.json({ services: [] });
      throw new Error(`Unexpected Knowledge request: ${url}`);
    };

    try {
      const response = await handleWorkspaceMcpWorkerRequest(new Request(
        "https://mcp.example.test/internal/runtime/workspace-pass/tools/knowledge_list",
        {
          body: "{}",
          headers: {
            authorization: "Bearer runtime-service-token",
            "content-type": "application/json",
            "x-workspace-runtime-auth-service-token": "mate-auth-service-token",
            "x-workspace-runtime-org-id": "org-workspace",
            "x-workspace-runtime-user-id": "user-1"
          },
          method: "POST"
        }
      ), { ...testInstallation,  ...runtimeEnv, MCP_INTROSPECTION_TOKEN: "mcp-broker-token", MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token" });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual((await response.json()).items.map((item) => item.id), ["viewer-root"]);
      assert.equal(mints.length, 3);
      assert.equal(mints.every((mint) => mint.authorization === "Bearer mate-auth-service-token"), true);
      assert.equal(mints.every((mint) => mint.body.mcpBrokered === false
        && mint.body.clientId === "workspace-mate-runtime"
        && mint.body.principal.sub === "user-1"
        && mint.body.connectionId === undefined), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes a service-authenticated current-user Forum post adapter", async () => {
    const db = forumTopicCreateDb();
    const response = await handleWorkspaceMcpWorkerRequest(new Request(
      "https://mcp.example.test/internal/runtime/forum/topics",
      {
        body: JSON.stringify({
          bodyMarkdown: "Runtime release evidence.",
          categorySlug: "platform-help",
          idempotencyKey: "runtime-task-1",
          title: "Runtime release",
          topicType: "release"
        }),
        headers: {
          authorization: "Bearer runtime-service-token",
          "content-type": "application/json",
          "x-workspace-runtime-org-id": "org-workspace",
          "x-workspace-runtime-user-email": "ada@example.invalid",
          "x-workspace-runtime-user-id": "user-1"
        },
        method: "POST"
      }
    ), { ...testInstallation,  ...env, DB: db, MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token" });
    assert.equal(response.status, 201, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.topic.title, "Runtime release");
  });

  it("exposes only editable Knowledge roots through the Mate Runtime maintenance bridge", async () => {
    const originalFetch = globalThis.fetch;
    const mintPrincipals = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        mintPrincipals.push(body.principal);
        return Response.json({ access_token: `knowledge-token-${mintPrincipals.length}` });
      }
      if (url === "https://knowledge.example.test/api/tree") {
        const scope = JSON.parse(new Headers(init.headers).get("x-workspace-folder-edit-scope"));
        assert.equal(scope === "all" || JSON.stringify(scope) === '["owner-root","collaborator-root"]', true);
        return Response.json({ items: [
          { capabilities: { canRead: true, canEdit: true }, effectiveRole: "owner", id: "owner-root" }
        ] });
      }
      if (url === "https://knowledge.example.test/api/shared-with-me") {
        return Response.json({ items: [
          { capabilities: { canRead: true, canEdit: true }, effectiveRole: "collaborator", id: "collaborator-root" },
          { capabilities: { canRead: true, canEdit: false }, effectiveRole: "viewer", id: "viewer-root" }
        ] });
      }
      if (url === "https://knowledge.example.test/api/knowledge-services?view=card") {
        return Response.json({ services: [] });
      }
      if (url === "https://knowledge.example.test/api/files/viewer-file") {
        return Response.json({ item: {
          capabilities: { canEdit: false },
          effectiveRole: "viewer",
          id: "viewer-file"
        } });
      }
      throw new Error(`unexpected fetch ${input}`);
    };
    const headers = {
      authorization: "Bearer runtime-service-token",
      "content-type": "application/json",
      "x-workspace-runtime-department-id": "dept-ai",
      "x-workspace-runtime-org-id": "org-workspace",
      "x-workspace-runtime-user-email": "ada@example.invalid",
      "x-workspace-runtime-user-id": "user-1",
      "x-workspace-folder-edit-scope": JSON.stringify(["owner-root", "collaborator-root"])
    };

    try {
      const response = await handleWorkspaceMcpWorkerRequest(new Request(
        "https://mcp.example.test/internal/runtime/knowledge/tools/knowledge_list",
        { body: JSON.stringify({}), headers, method: "POST" }
      ), { ...testInstallation,  ...env, MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token" });
      assert.equal(response.status, 200, await response.clone().text());
      const payload = await response.json();
      assert.deepEqual(payload.items.map((item) => item.id), ["owner-root", "collaborator-root"]);
      assert.equal(mintPrincipals.length, 2);
      assert.equal(mintPrincipals.every((item) => item.sub === "user-1" && item.orgId === "org-workspace"), true);

      const allScope = await handleWorkspaceMcpWorkerRequest(new Request(
        "https://mcp.example.test/internal/runtime/knowledge/tools/knowledge_list",
        { body: JSON.stringify({}), headers: { ...headers, "x-workspace-folder-edit-scope": '"all"' }, method: "POST" }
      ), { ...testInstallation,  ...env, MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token" });
      assert.equal(allScope.status, 200, await allScope.clone().text());

      const viewerRead = await handleWorkspaceMcpWorkerRequest(new Request(
        "https://mcp.example.test/internal/runtime/knowledge/tools/knowledge_file_read",
        { body: JSON.stringify({ objectId: "viewer-file", includeContent: false }), headers, method: "POST" }
      ), { ...testInstallation,  ...env, MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token" });
      assert.equal(viewerRead.status, 403);
      assert.equal((await viewerRead.json()).error, "knowledge_maintenance_edit_access_required");

      const disallowed = await handleWorkspaceMcpWorkerRequest(new Request(
        "https://mcp.example.test/internal/runtime/knowledge/tools/knowledge_share",
        { body: JSON.stringify({ action: "get", objectId: "file-1" }), headers, method: "POST" }
      ), { ...testInstallation,  ...env, MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token" });
      assert.equal(disallowed.status, 404);
      assert.equal((await disallowed.json()).error, "runtime_knowledge_tool_not_allowed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns the original topic when an idempotency key is retried", async () => {
    const db = forumTopicCreateDb();
    const args = {
      bodyMarkdown: "Tencent quota is exhausted.",
      categorySlug: "platform-help",
      idempotencyKey: "gateway-quota-20260719",
      title: "Gateway quota exhausted",
      topicType: "help"
    };

    const first = await callMcpTool("forum_create_topic", args, { ...testInstallation,  ...env, DB: db }, forumPrincipal);
    const retried = await callMcpTool("forum_create_topic", args, { ...testInstallation,  ...env, DB: db }, forumPrincipal);

    assert.equal(retried.topic.id, first.topic.id);
    assert.equal(db.state.topics.length, 1);
    assert.equal(db.state.batches.length, 1);
    assert.equal(db.state.runs.filter((write) => write.sql.includes("INSERT OR IGNORE INTO activity_events")).length, 1);
  });

  it("publishes an MCP-created topic as an org-visible Community activity", async () => {
    const db = forumTopicCreateDb();
    const result = await callMcpTool("forum_create_topic", {
      bodyMarkdown: "Tencent quota is exhausted.",
      categorySlug: "platform-help",
      idempotencyKey: "community-activity-1",
      tags: ["gateway"],
      title: "Gateway quota exhausted",
      topicType: "help"
    }, { ...testInstallation,  ...env, DB: db }, forumPrincipal);

    const write = db.state.runs.find((candidate) => candidate.sql.includes("INSERT OR IGNORE INTO activity_events"));
    assert.ok(write);
    assert.match(write.sql, /'community'/);
    assert.match(write.sql, /'org'/);
    assert.match(write.sql, /'mcp'/);
    assert.equal(write.bindings[1], "forum.topic.created");
    assert.equal(write.bindings[2], "user-1");
    assert.equal(write.bindings[5], "forum_topic");
    assert.equal(write.bindings[6], result.topic.id);
    assert.equal(write.bindings[12], `#/community/${result.topic.id}`);
    assert.equal(write.bindings[15], `forum.topic.created:${result.topic.id}`);
    assert.deepEqual(JSON.parse(write.bindings[14]).tags, ["gateway"]);
  });

  it("deduplicates matching topic content even when retry keys differ", async () => {
    const db = forumTopicCreateDb();
    const args = {
      bodyMarkdown: "Tencent quota is exhausted.",
      categorySlug: "platform-help",
      title: "Gateway quota exhausted",
      topicType: "help"
    };

    const first = await callMcpTool("forum_create_topic", { ...args, idempotencyKey: "publish-attempt-1" }, { ...testInstallation,  ...env, DB: db }, forumPrincipal);
    const duplicate = await callMcpTool("forum_create_topic", { ...args, idempotencyKey: "publish-attempt-2" }, { ...testInstallation,  ...env, DB: db }, forumPrincipal);

    assert.equal(duplicate.topic.id, first.topic.id);
    assert.equal(db.state.topics.length, 1);
  });

  it("rejects reuse of an idempotency key for different topic content", async () => {
    const db = forumTopicCreateDb();
    const args = {
      bodyMarkdown: "Tencent quota is exhausted.",
      categorySlug: "platform-help",
      idempotencyKey: "gateway-quota-20260719",
      title: "Gateway quota exhausted",
      topicType: "help"
    };

    await callMcpTool("forum_create_topic", args, { ...testInstallation,  ...env, DB: db }, forumPrincipal);
    await assert.rejects(
      () => callMcpTool("forum_create_topic", { ...args, bodyMarkdown: "A different incident." }, { ...testInstallation,  ...env, DB: db }, forumPrincipal),
      (error) => error.status === 409 && error.code === "forum_idempotency_key_conflict"
    );
    assert.equal(db.state.topics.length, 1);
  });

  it("updates an owned topic through MCP and records an audit event", async () => {
    const db = forumUpdateDb();
    const result = await callMcpTool("forum_update_topic", {
      topicId: "topic-1",
      title: "What is Frontier Workspace MCP?",
      bodyMarkdown: "Skill explains how. MCP provides authorized tools."
    }, { ...testInstallation,  ...env, DB: db }, forumPrincipal);

    assert.equal(result.topic.title, "What is Frontier Workspace MCP?");
    assert.equal(result.topic.posts[0].bodyMarkdown, "Skill explains how. MCP provides authorized tools.");
    assert.equal(db.state.batches.length, 1);
    assert.match(db.state.batches[0][0].sql, /UPDATE forum_topics/);
    assert.match(db.state.batches[0][1].sql, /UPDATE forum_posts/);
    assert.match(db.state.batches[0][2].sql, /updated forum topic from MCP/);
  });

  it("appends a finalized Forum media object as a standalone topic attachment", async () => {
    const storageKey = "forum/2026/09/cover.png";
    const db = forumUpdateDb();
    const result = await callMcpTool("forum_update_topic", {
      topicId: "topic-1",
      title: "What is Frontier Workspace MCP?",
      bodyMarkdown: "Skill explains how. MCP provides authorized tools.",
      attachments: [{
        fileName: "cover.png",
        fileSize: 1024,
        mimeType: "image/png",
        publicUrl: `/api/forum/media/${storageKey}`,
        storageKey,
        url: `https://ai.example.test/api/forum/media/${storageKey}`
      }]
    }, { ...testInstallation,
      ...env,
      DB: db,
      FORUM_MEDIA: forumAttachmentBucket({ storageKey })
    }, forumPrincipal);

    assert.equal(result.topic.attachments.length, 1);
    assert.equal(result.topic.attachments[0].storageKey, storageKey);
    assert.equal(result.topic.attachments[0].postId, "root-post-1");
    assert.equal(db.state.attachments.length, 1);
    assert.match(db.state.batches[0][3].sql, /INSERT INTO forum_attachments/);
    const audit = JSON.parse(db.state.batches[0][2].bindings[3]);
    assert.equal(audit.addedAttachmentCount, 1);
  });

  it("treats retrying an existing topic attachment storageKey as idempotent", async () => {
    const storageKey = "forum/2026/09/cover.png";
    const db = forumUpdateDb({ attachments: [{ storageKey }] });
    const result = await callMcpTool("forum_update_topic", {
      topicId: "topic-1",
      title: "Original title",
      bodyMarkdown: "Original post",
      attachments: [{ storageKey }]
    }, { ...testInstallation,  ...env, DB: db }, forumPrincipal);

    assert.equal(result.topic.attachments.length, 1);
    assert.equal(db.state.attachments.length, 1);
    assert.equal(db.state.batches[0].length, 3);
  });

  it("replaces existing topic attachments and removes superseded media", async () => {
    const oldStorageKey = "forum/2026/09/old-cover.png";
    const newStorageKey = "forum/2026/09/new-cover.png";
    const db = forumUpdateDb({ attachments: [{ storageKey: oldStorageKey }] });
    const bucket = forumAttachmentBucket({ storageKey: newStorageKey });
    const result = await callMcpTool("forum_update_topic", {
      topicId: "topic-1",
      title: "Original title",
      bodyMarkdown: "Original post",
      retainedAttachmentIds: [],
      attachments: [{ storageKey: newStorageKey }]
    }, { ...testInstallation,  ...env, DB: db, FORUM_MEDIA: bucket }, forumPrincipal);

    assert.deepEqual(result.topic.attachments.map((attachment) => attachment.storageKey), [newStorageKey]);
    assert.deepEqual(db.state.attachments.map((attachment) => attachment.storageKey), [newStorageKey]);
    assert.deepEqual(bucket.state.deletedKeys, [oldStorageKey]);
    assert.match(db.state.batches[0][3].sql, /DELETE FROM forum_attachments/);
    assert.match(db.state.batches[0][4].sql, /INSERT INTO forum_attachments/);
    const audit = JSON.parse(db.state.batches[0][2].bindings[3]);
    assert.equal(audit.addedAttachmentCount, 1);
    assert.equal(audit.removedAttachmentCount, 1);
  });

  it("keeps replacement retries idempotent by retaining an existing requested storageKey", async () => {
    const storageKey = "forum/2026/09/new-cover.png";
    const db = forumUpdateDb({ attachments: [{ storageKey }] });
    const bucket = forumAttachmentBucket({ storageKey });
    const result = await callMcpTool("forum_update_topic", {
      topicId: "topic-1",
      title: "Original title",
      bodyMarkdown: "Original post",
      retainedAttachmentIds: [],
      attachments: [{ storageKey }]
    }, { ...testInstallation,  ...env, DB: db, FORUM_MEDIA: bucket }, forumPrincipal);

    assert.deepEqual(result.topic.attachments.map((attachment) => attachment.storageKey), [storageKey]);
    assert.equal(db.state.batches[0].length, 3);
    assert.deepEqual(bucket.state.deletedKeys, []);
  });

  it("rejects an unknown retained Forum attachment token", async () => {
    await assert.rejects(
      () => callMcpTool("forum_update_topic", {
        topicId: "topic-1",
        title: "Original title",
        bodyMarkdown: "Original post",
        retainedAttachmentIds: ["unknown-attachment"]
      }, { ...testInstallation,  ...env, DB: forumUpdateDb() }, forumPrincipal),
      (error) => error.status === 400 && error.code === "invalid_forum_topic_attachment_selection"
    );
  });

  it("rejects attaching Forum media owned by another user", async () => {
    const storageKey = "forum/2026/09/other-user.png";
    await assert.rejects(
      () => callMcpTool("forum_update_topic", {
        topicId: "topic-1",
        title: "Original title",
        bodyMarkdown: "Original post",
        attachments: [{ storageKey }]
      }, { ...testInstallation,
        ...env,
        DB: forumUpdateDb(),
        FORUM_MEDIA: forumAttachmentBucket({ ownerUserId: "user-ivy", storageKey })
      }, forumPrincipal),
      (error) => error.status === 403 && error.code === "forum_media_attach_forbidden"
    );
  });

  it("does not let an MCP connection update another user's topic", async () => {
    await assert.rejects(
      () => callMcpTool("forum_update_topic", {
        topicId: "topic-1",
        title: "Unauthorized edit",
        bodyMarkdown: "Should not be written."
      }, { ...testInstallation,  ...env, DB: forumUpdateDb({ authorUserId: "user-ivy" }) }, forumPrincipal),
      (error) => error.status === 403 && error.code === "forum_topic_update_forbidden"
    );
  });

  it("begins a direct upload ticket and finalizes it into a public media URL", async () => {
    const upload = uploadFlowEnv();
    const begun = await callMcpTool("upload_begin", {
      fileName: "skill-vs-mcp.png",
      mimeType: "image/png",
      size: 8
    }, { ...env, ...upload.env }, forumPrincipal);

    assert.match(begun.uploadId, /^[0-9a-f-]{36}$/);
    assert.match(begun.r2Key, /^forum\/\d{4}\/\d{2}\/.+-skill-vs-mcp\.png$/);
    assert.equal(begun.uploadUrl, `https://mcp.example.test/api/media-upload/${begun.uploadId}`);
    assert.equal(begun.maxBytes, 50 * 1024 * 1024);
    assert.ok(begun.expiresAt > Date.now());

    upload.setSession({
      upload_id: begun.uploadId,
      r2_key: begun.r2Key,
      file_name: "skill-vs-mcp.png",
      mime_type: "image/png",
      expires_at: Date.now() + 60_000,
      status: "pending",
      owner_user_id: "user-1"
    });
    upload.objects.set(begun.r2Key, 8);

    const result = await callMcpTool("upload_finalize", {
      uploadId: begun.uploadId,
      r2Key: begun.r2Key,
      fileName: "skill-vs-mcp.png",
      mimeType: "image/png"
    }, { ...env, ...upload.env }, forumPrincipal);

    assert.equal(result.file.fileName, "skill-vs-mcp.png");
    assert.equal(result.file.fileSize, 8);
    assert.equal(result.file.mimeType, "image/png");
    assert.equal(result.file.url, `https://ai.example.test/api/forum/media/${begun.r2Key}`);
    assert.equal(upload.audits.length, 1);
    assert.match(upload.audits[0].sql, /uploaded forum media from MCP/);
  });

  it("rejects finalize for an expired upload session", async () => {
    const upload = uploadFlowEnv();
    upload.setSession({
      upload_id: "expired-upload",
      r2_key: "forum/2026/08/expired.png",
      file_name: "expired.png",
      mime_type: "image/png",
      expires_at: Date.now() - 1000,
      status: "pending",
      owner_user_id: "user-1"
    });
    await assert.rejects(
      () => callMcpTool("upload_finalize", {
        uploadId: "expired-upload",
        r2Key: "forum/2026/08/expired.png",
        fileName: "expired.png",
        mimeType: "image/png"
      }, { ...env, ...upload.env }, forumPrincipal),
      (error) => error.status === 410 && error.code === "upload_session_expired"
    );
  });

  it("rejects a declared upload size above 50 MB", async () => {
    const upload = uploadFlowEnv();
    await assert.rejects(
      () => callMcpTool("upload_begin", {
        fileName: "huge.bin",
        mimeType: "application/octet-stream",
        size: 50 * 1024 * 1024 + 1
      }, { ...env, ...upload.env }, forumPrincipal),
      (error) => error.status === 400 && error.code === "upload_too_large"
    );
  });

  it("rejects an unsupported upload MIME type", async () => {
    const upload = uploadFlowEnv();
    await assert.rejects(
      () => callMcpTool("upload_begin", {
        fileName: "odd.bin",
        mimeType: "not a mime"
      }, { ...env, ...upload.env }, forumPrincipal),
      (error) => error.status === 400 && error.code === "unsupported_forum_media_type"
    );
  });

  it("uploads an image from an https url through forum_upload_media", async () => {
    const upload = uploadFlowEnv();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(pngBytes, { status: 200, headers: { "content-type": "image/png" } });
    try {
      const result = await callMcpTool("forum_upload_media", {
        url: "https://cdn.example.test/skill-vs-mcp.png"
      }, { ...env, ...upload.env }, forumPrincipal);

      assert.equal(result.image.fileName, "skill-vs-mcp.png");
      assert.equal(result.image.fileSize, 8);
      assert.equal(result.image.mimeType, "image/png");
      assert.match(result.image.storageKey, /^forum\/\d{4}\/\d{2}\/.+-skill-vs-mcp\.png$/);
      assert.equal(upload.puts.length, 1);
      assert.equal(upload.puts[0].options.customMetadata.ownerUserId, "user-1");
      assert.equal(upload.puts[0].options.customMetadata.uploadedVia, "workspace-mcp");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a non-https url for forum_upload_media", async () => {
    const upload = uploadFlowEnv();
    await assert.rejects(
      () => callMcpTool("forum_upload_media", {
        url: "http://cdn.example.test/skill-vs-mcp.png"
      }, { ...env, ...upload.env }, forumPrincipal),
      (error) => error.status === 400 && error.code === "forum_media_url_must_be_https"
    );
    assert.equal(upload.puts.length, 0);
  });

  it("rejects an oversized image via forum_upload_media url path", async () => {
    const upload = uploadFlowEnv();
    const oversized = new Uint8Array(50 * 1024 * 1024 + 1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(oversized, { status: 200, headers: { "content-type": "image/png" } });
    try {
      await assert.rejects(
        () => callMcpTool("forum_upload_media", {
          url: "https://cdn.example.test/huge.png"
        }, { ...env, ...upload.env }, forumPrincipal),
        (error) => error.status === 400 && error.code === "forum_media_too_large"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(upload.puts.length, 0);
  });

  it("accepts a direct binary PUT to the media-upload route", async () => {
    const upload = uploadFlowEnv();
    upload.setSession({
      upload_id: "put-upload",
      r2_key: "forum/2026/08/put.png",
      file_name: "put.png",
      mime_type: "image/png",
      expires_at: Date.now() + 60_000,
      status: "pending",
      owner_user_id: "user-1"
    });
    const request = new Request("https://mcp.example.test/api/media-upload/put-upload", {
      method: "PUT",
      headers: { "content-length": "8" },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    });

    const response = await handleWorkspaceMcpWorkerRequest(request, upload.env);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.r2Key, "forum/2026/08/put.png");
    assert.equal(payload.mimeType, "image/png");
    assert.equal(upload.puts.length, 1);
    assert.equal(upload.puts[0].key, "forum/2026/08/put.png");
    assert.match(upload.puts[0].options.httpMetadata.contentDisposition, /^inline;/);
  });

  it("rejects a direct binary PUT for an unknown upload session", async () => {
    const upload = uploadFlowEnv();
    const request = new Request("https://mcp.example.test/api/media-upload/unknown", {
      method: "PUT",
      body: Buffer.from("x")
    });
    const response = await handleWorkspaceMcpWorkerRequest(request, upload.env);
    assert.equal(response.status, 404);
    assert.equal(upload.puts.length, 0);
  });

  it("requires forum write scope before creating a reply", async () => {
    await assert.rejects(
      () => callMcpTool("forum_create_reply", {
        topicId: "topic-1",
        bodyMarkdown: "Fixed."
      }, env, { ...principal, scopes: ["workspace:forum:read"] }),
      (error) => error.status === 403 && error.code === "insufficient_mcp_scope"
    );
  });

  it("creates a reply and returns only the newly created post", async () => {
    const db = forumDb();
    const result = await callMcpTool("forum_create_reply", {
      topicId: "topic-1",
      bodyMarkdown: "  Fixed through Workspace MCP.  "
    }, { ...testInstallation,  ...env, DB: db }, forumPrincipal);

    assert.equal(result.reply.topicId, "topic-1");
    assert.equal(result.reply.bodyMarkdown, "Fixed through Workspace MCP.");
    assert.equal(result.reply.author, "Ada");
    assert.equal(result.reply.source, "mcp");
    assert.deepEqual(Object.keys(result), ["reply"]);
    assert.equal(db.state.replyCount, 1);
    assert.equal(db.state.batches.length, 1);
    assert.match(db.state.batches[0][0].sql, /INSERT INTO forum_posts/);
    assert.match(db.state.batches[0][0].sql, /forum_topics\.status = 'open'/);
    assert.match(db.state.batches[0][1].sql, /reply_count = reply_count \+ 1/);
    assert.match(db.state.batches[0][1].sql, /status = 'open'/);

    const write = db.state.runs.find((candidate) => candidate.sql.includes("INSERT OR IGNORE INTO activity_events"));
    assert.ok(write);
    assert.match(write.sql, /'community'/);
    assert.match(write.sql, /'org'/);
    assert.match(write.sql, /'mcp'/);
    assert.equal(write.bindings[1], "forum.reply.created");
    assert.equal(write.bindings[5], "forum_post");
    assert.equal(write.bindings[6], result.reply.id);
    assert.equal(write.bindings[8], "forum_topic");
    assert.equal(write.bindings[9], "topic-1");
    assert.equal(write.bindings[12], "#/community/topic-1");
    assert.equal(write.bindings[15], `forum.reply.created:${result.reply.id}`);
  });

  it("publishes MCP reply activity and recipient notifications through Live", async () => {
    const db = forumDb();
    const originalFetch = globalThis.fetch;
    const published = [];
    const deferred = [];
    globalThis.fetch = async (_input, init) => {
      published.push(JSON.parse(init.body));
      return new Response(null, { status: 202 });
    };

    try {
      const result = await callMcpTool("forum_create_reply", {
        topicId: "topic-1",
        bodyMarkdown: "Fixed through Workspace MCP."
      }, { ...testInstallation,
        ...env,
        DB: db,
        PORTAL_LIVE_WORKSPACE_ID: "test-workspace", LIVE_PUBLISH_TOKEN: "live-secret",
        LIVE_WORKER_URL: "https://live.example.test"
      }, forumPrincipal, "request-forum-live-1", {
        waitUntil(promise) {
          deferred.push(promise);
        }
      });
      await Promise.all(deferred);

      assert.ok(published.some((body) => body.activityEventId === db.state.runs.find((write) => (
        write.sql.includes("INSERT OR IGNORE INTO activity_events")
      )).bindings[0]));
      assert.ok(published.some((body) => typeof body.notificationId === "string"));
      assert.ok(published.every((body) => body.workspaceId === "test-workspace"));
      assert.equal(result.reply.topicId, "topic-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("creates one mention notification when an MCP reply mentions the topic author", async () => {
    const db = forumDb();
    await callMcpTool("forum_create_reply", {
      topicId: "topic-1",
      bodyMarkdown: "Thanks @ivy"
    }, { ...testInstallation,  ...env, DB: db }, forumPrincipal);

    const notifications = db.state.batches[0].filter((statement) => statement.sql.includes("INSERT OR IGNORE INTO notifications"));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].bindings[1], "user-ivy");
    assert.match(notifications[0].sql, /'forum\.mention'/);
  });

  it("rejects empty replies and unknown topics", async () => {
    await assert.rejects(
      () => callMcpTool("forum_create_reply", {
        topicId: "topic-1",
        bodyMarkdown: "   "
      }, { ...testInstallation,  ...env, DB: forumDb() }, forumPrincipal),
      (error) => error.status === 400 && error.code === "missing_forum_reply_body"
    );

    await assert.rejects(
      () => callMcpTool("forum_create_reply", {
        topicId: "missing-topic",
        bodyMarkdown: "Fixed."
      }, { ...testInstallation,  ...env, DB: forumDb({ topicExists: false }) }, forumPrincipal),
      (error) => error.status === 404 && error.code === "forum_topic_not_found"
    );
  });

  it("does not write when the topic is archived between validation and the batch", async () => {
    const db = forumDb({ acceptWrite: false });

    await assert.rejects(
      () => callMcpTool("forum_create_reply", {
        topicId: "topic-1",
        bodyMarkdown: "Fixed."
      }, { ...testInstallation,  ...env, DB: db }, forumPrincipal),
      (error) => error.status === 409 && error.code === "forum_topic_not_open"
    );

    assert.equal(db.state.replyCount, 0);
    assert.equal(db.state.posts.length, 1);
  });
});

describe("Workspace MCP APPS tool proxy", () => {
  it("lists Pages and D1 migration build tools", async () => {
    const tools = await mcpTools();
    const names = tools.map((tool) => tool.name);
    const appsNames = names.filter((name) => name.startsWith("apps_"));

    assert.equal(appsNames.length, 13);
    assert.deepEqual(appsNames, [
      "apps_deployment_submit_listing",
      "apps_inventory",
      "apps_app_read",
      "apps_app_write",
      "apps_provisioning",
      "apps_deploy_prepare",
      "apps_deployment_read",
      "apps_deployment_release",
      "apps_database",
      "apps_config",
      "apps_storage",
      "apps_skill_read",
      "apps_skill_write"
    ]);
    const publish = actionBranch(tools.find((tool) => tool.name === "apps_deployment_release"), "publish");
    assert.ok(Object.hasOwn(publish.properties, "accessTargets"));
    assert.ok(Object.hasOwn(publish.properties, "harnessReportUrl"));
    assert.ok(Object.hasOwn(publish.properties, "harnessSelfCheckConfirmed"));
    assert.deepEqual(publish.required, ["action"]);
    const migration = actionBranch(tools.find((tool) => tool.name === "apps_database"), "migration_apply");
    assert.ok(Object.hasOwn(migration.properties, "allowDataMigrations"));
    const authSdk = actionBranch(tools.find((tool) => tool.name === "apps_app_read"), "auth_sdk");
    assert.deepEqual(authSdk.required, ["action"]);
    const mailSdk = actionBranch(tools.find((tool) => tool.name === "apps_app_read"), "mail_sdk");
    assert.ok(mailSdk.properties.appId);
    const updateMail = actionBranch(tools.find((tool) => tool.name === "apps_app_write"), "update_config");
    for (const name of ["emailEnabled","emailPrefix","emailTriggerEnabled"]) assert.ok(updateMail.properties[name]);
    const create = actionBranch(tools.find((tool) => tool.name === "apps_app_write"), "create");
    assert.deepEqual(create.required, ["action"]);
    const downloadSource = actionBranch(tools.find((tool) => tool.name === "apps_app_read"), "download_source");
    assert.deepEqual(downloadSource.required, ["action"]);
    assert.deepEqual(actionBranch(tools.find((tool) => tool.name === "mate_builder_read"), "core_review").required, ["action"]);
    const mateCreate = actionBranch(tools.find((tool) => tool.name === "mate_builder_write"), "create");
    const mateUpdate = actionBranch(tools.find((tool) => tool.name === "mate_builder_write"), "update");
    assert.ok(Object.hasOwn(mateCreate.properties, "avatarUrl"));
    assert.ok(Object.hasOwn(mateUpdate.properties, "avatarUrl"));
    assert.deepEqual(actionBranch(tools.find((tool) => tool.name === "mate_builder_write"), "deploy_preview").required, ["action"]);
    assert.deepEqual(actionBranch(tools.find((tool) => tool.name === "mate_builder_write"), "publish").required, ["action"]);
  });

  it("routes the Mail SDK handoff through managed App read authorization", async () => {
    const originalFetch=globalThis.fetch;let calls=0;
    globalThis.fetch=async(input,init)=>{calls++;assert.equal(input,"https://apps.example.test/apps/app-1/mail-sdk");assert.equal(init.method,"GET");const jwt=JSON.parse(Buffer.from(init.headers.Authorization.slice(7).split(".")[1],"base64url").toString("utf8"));assert.deepEqual(jwt.scopes,["apps:apps:read"]);return Response.json({schemaVersion:"workspace.apps.mail-sdk-handoff.v1",appId:"app-1",sdk:{version:"0.2.0"}});};
    try {const result=await callPublicMcpTool("apps_app_read",{action:"mail_sdk",appId:"app-1"},env,principal);assert.equal(result.schemaVersion,"workspace.apps.mail-sdk-handoff.v1");assert.equal(calls,1);await assert.rejects(callPublicMcpTool("apps_app_read",{action:"mail_sdk",appId:"app-1"},env,{...principal,scopes:[]}),error=>error.status===403);assert.equal(calls,1);}finally{globalThis.fetch=originalFetch;}
  });

  it("downloads only the source snapshot linked to the currently published deployment", async () => {
    const originalFetch = globalThis.fetch;
    const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "https://apps.example.test/apps/app-1/current-source/download");
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Accept, "application/zip");
      assert.equal(init.headers["x-workspace-scopes"], "apps:apps:read");
      const token = init.headers.Authorization.replace(/^Bearer\s+/i, "");
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      assert.deepEqual(payload.scopes, ["apps:apps:read"]);
      return new Response(archive, {
        headers: {
          "content-disposition": "attachment; filename=\"app-1-v2.zip\"",
          "content-type": "application/zip",
          "x-workspace-deployment-id": "dep-current",
          "x-workspace-deployment-version": "v2",
          "x-workspace-source-archive-sha256": "a".repeat(64),
          "x-workspace-source-content-sha256": "b".repeat(64),
          "x-workspace-source-snapshot-id": "snap-current"
        }
      });
    };

    try {
      const result = await callMcpTool("apps_download_current_source_code", { appId: "app-1" }, env, principal);
      assert.deepEqual(result.deployment, { id: "dep-current", status: "published", version: "v2" });
      assert.deepEqual(result.sourceSnapshot, {
        id: "snap-current",
        archiveSha256: "a".repeat(64),
        contentSha256: "b".repeat(64)
      });
      assert.equal(result.package.filename, "app-1-v2.zip");
      assert.equal(result.package.sizeBytes, archive.byteLength);
      assert.equal(result.package.encoding, "base64");
      assert.deepEqual(Buffer.from(result.package.zipBase64, "base64"), archive);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not fall back when the published deployment has no linked source snapshot", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(
      { error: "published_deployment_source_snapshot_not_found" },
      { status: 409 }
    );

    try {
      await assert.rejects(
        () => callMcpTool("apps_download_current_source_code", { appId: "app-1" }, env, principal),
        (error) => error.status === 409 && error.code === "published_deployment_source_snapshot_not_found"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("publishes only the three progressive App MCP broker tools", async () => {
    const tools = await mcpTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("app_mcp_accessible_list"));
    assert.ok(names.includes("app_mcp_tools_list"));
    assert.ok(names.includes("app_mcp_tool_call"));
    assert.equal(names.includes("app_capabilities_list"), false);
    assert.equal(names.includes("app_list_accessible"), false);
    const updateAppConfig = actionBranch(tools.find((tool) => tool.name === "apps_app_write"), "update_config");
    assert.ok(Object.hasOwn(updateAppConfig.properties, "agentMcpEnabled"));
    assert.deepEqual(updateAppConfig.properties.directoryReadScope.enum, ["app", "company"]);
    assert.ok(Object.hasOwn(updateAppConfig.properties, "addResourceTypes"));
    assert.ok(updateAppConfig.properties.addResourceTypes.items.enum.includes("hyperdrive_config"));
    const deployPrepare = actionBranch(tools.find((tool) => tool.name === "apps_deploy_prepare"), "worker");
    assert.ok(Object.hasOwn(deployPrepare.properties, "hyperdrive"));
    assert.ok(Object.hasOwn(deployPrepare.properties, "cronSchedules"));
    assert.ok(Object.hasOwn(deployPrepare.properties, "queueConsumer"));
    assert.equal(Object.hasOwn(deployPrepare.properties.hyperdrive.properties, "password"), false);
  });

  it("proxies App creation and provisioning lifecycle through APPS MCP", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "https://apps.example.test/mcp");
      const body = JSON.parse(init.body);
      calls.push({ body, headers: init.headers });
      const payload = body.params.name === "apps_create_app"
        ? { app: { id: "app-auth-e2e" }, provisioningJob: { id: "job-auth-e2e", status: "queued" } }
        : body.params.name === "apps_get_provisioning_status"
          ? { provisioningJob: { id: "job-auth-e2e", status: "ready" } }
          : { provisioningJob: { id: "job-auth-e2e", status: "queued" } };
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
      });
    };

    try {
      await callMcpTool("apps_create_app", {
        name: "MCP Auth E2E",
        code: "mcp-auth-e2e",
        type: "container",
        loginRequired: true
      }, env, principal, "request-auth-e2e-create");
      await callMcpTool("apps_get_provisioning_status", { jobId: "job-auth-e2e" }, env, principal, "request-auth-e2e-status");
      await callMcpTool("apps_retry_provisioning_job", { jobId: "job-auth-e2e" }, env, principal, "request-auth-e2e-retry");

      assert.deepEqual(calls.map((call) => call.body.params.name), [
        "apps_create_app",
        "apps_get_provisioning_status",
        "apps_retry_provisioning_job"
      ]);
      assert.equal(calls[0].body.params.arguments.loginRequired, true);
      assert.equal(calls[0].headers["x-request-id"], "request-auth-e2e-create");
      assert.match(calls[0].headers["x-workspace-scopes"], /apps:apps:write/);
      assert.equal(calls[1].headers["x-request-id"], "request-auth-e2e-status");
      assert.equal(calls[1].headers["x-workspace-scopes"], "apps:apps:read");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("queries the unified owner-or-collaborator APPS inventory", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "https://apps.example.test/inventory");
      assert.equal(init.method, "GET");
      assert.equal(init.headers["x-workspace-scopes"], "apps:apps:read,apps:skills:read,apps:mates:read");
      const token = init.headers.Authorization.replace(/^Bearer\s+/i, "");
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      assert.equal(payload.department_id, "dept-research");
      assert.deepEqual(payload.department_path, ["company", "dept-research"]);
      return new Response(JSON.stringify({
        apps: [{ id: "app-owned" }],
        skills: [{ id: "skill-collaborated" }]
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    try {
      assert.deepEqual(await callMcpTool("apps_list_inventory", {}, env, {
        ...principal,
        departmentId: "dept-research",
        departmentPath: ["company", "dept-research"]
      }), {
        apps: [{ id: "app-owned" }],
        skills: [{ id: "skill-collaborated" }]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("starts and follows a current-user Mate Task through the public mate_call tool", async () => {
    const calls = [];
    const runtimeEnv = {
      ...env,
      MATE_RUNTIME_JWT_SECRET: "runtime-preview-secret-at-least-32-characters",
      MATE_RUNTIME: {
        async fetch(request) {
          calls.push(request.clone());
          const token = request.headers.get("authorization").replace(/^Bearer\s+/i, "");
          const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
          assert.equal(claims.sub, "user-1");
          assert.equal(claims.org_id, "org-1");
          assert.equal(claims.caller_kind, "user");
          assert.deepEqual(claims.scopes, ["mate:invoke", "mate:preferences"]);
          const url = new URL(request.url);
          if (url.pathname.endsWith("/tasks")) {
            const body = await request.json();
            assert.equal(body.channel, "mate_call");
            assert.equal(body.instruction, "Review the policy");
            assert.equal(Object.hasOwn(body, "userId"), false);
            return Response.json({ task: { id: "task_12345678", status: "queued" } }, { status: 202 });
          }
          assert.match(url.pathname, /\/tasks\/task_12345678\/run$/);
          return Response.json({ task: { id: "task_12345678", status: "completed", conclusion: { summary: "Done" } } });
        }
      }
    };
    const result = await callPublicMcpTool("mate_call", {
      action: "start",
      mateId: "knowledge-mate",
      instruction: "Review the policy"
    }, runtimeEnv, { ...principal, orgId: "org-1" });
    assert.equal(result.task.status, "completed");
    assert.equal(calls.length, 2);
  });

  it("preserves a full 12000-character Task instruction including its final constraint", async () => {
    const tail = "TAIL_CONSTRAINT_863!!";
    const instruction = "请按要求完成任务。".repeat(1500).slice(0, 12000 - tail.length).padEnd(12000 - tail.length, "字") + tail;
    assert.equal(instruction.length, 12000);
    const calls = [];
    const result = await callPublicMcpTool("mate_call", {
      action: "start", mateId: "knowledge-mate", instruction
    }, {
      ...env, MATE_RUNTIME_JWT_SECRET: "runtime-preview-secret-at-least-32-characters",
      MATE_RUNTIME: { async fetch(request) {
        calls.push(new URL(request.url).pathname);
        if (calls.length === 1) {
          assert.equal((await request.json()).instruction, instruction);
          return Response.json({ task: { id: "task_12345678", status: "queued" } }, { status: 202 });
        }
        return Response.json({ task: { id: "task_12345678", status: "completed" } });
      } }
    }, { ...principal, orgId: "org-1" });
    assert.equal(result.task.status, "completed");
    assert.equal(calls.length, 2);
  });

  it("dispatches non-blocking Tasks to the durable Runtime runner before returning", async () => {
    const calls = [];
    const result = await callPublicMcpTool("mate_call", {
      action: "start", mateId: "knowledge-mate", instruction: "Read policy", waitForConclusion: false
    }, {
      ...env, MATE_RUNTIME_JWT_SECRET: "runtime-preview-secret-at-least-32-characters",
      MATE_RUNTIME: { async fetch(request) {
        calls.push(request.clone());
        if (calls.length === 1) return Response.json({ task: { id: "task_12345678", status: "queued" } }, { status: 202 });
        assert.match(new URL(request.url).pathname, /\/tasks\/task_12345678\/run$/);
        assert.deepEqual(await request.json(), { background: true });
        return Response.json({ task: { id: "task_12345678", status: "queued", dispatched: true } }, { status: 202 });
      } }
    }, { ...principal, orgId: "org-1" });
    assert.equal(result.task.dispatched, true);
    assert.equal(calls.length, 2);
  });

  it("reports failed background admission instead of returning a falsely started Task", async () => {
    let calls = 0;
    await assert.rejects(callPublicMcpTool("mate_call", {
      action: "start", mateId: "knowledge-mate", instruction: "Read policy", waitForConclusion: false
    }, {
      ...env, MATE_RUNTIME_JWT_SECRET: "runtime-preview-secret-at-least-32-characters",
      MATE_RUNTIME: { async fetch() {
        if (++calls === 1) return Response.json({ task: { id: "task_12345678", status: "queued" } }, { status: 202 });
        return Response.json({ error: "background_task_runner_not_configured" }, { status: 503 });
      } }
    }, { ...principal, orgId: "org-1" }), { code: "background_task_runner_not_configured", status: 503 });
  });

  it("lists Hub consumption tools and hides legacy Market names", async () => {
    const tools = await mcpTools();
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes("hub_search"));
    assert.equal(names.includes("hub_skills_list"), false);
    assert.ok(names.includes("hub_skill_download"));
    assert.ok(names.includes("apps_deployment_submit_listing"));
    assert.equal(names.includes("hub_submit_listing"), false);
    assert.equal(names.includes("hub_search_listings"), false);
    assert.equal(names.includes("hub_get_listing"), false);
    assert.equal(names.includes("hub_list_skills"), false);
    assert.equal(names.includes("hub_list_apps"), false);
    assert.equal(names.includes("hub_download_skill_package"), false);
    assert.equal(names.includes("market_search_listings"), false);
    assert.equal(names.includes("market_get_listing"), false);
    const downloadTool = tools.find((tool) => tool.name === "hub_skill_download");
    assert.equal(Object.hasOwn(downloadTool.inputSchema.properties, "version"), false);
  });

  it("lists APPS Skill lifecycle tools", async () => {
    const tools = await mcpTools();
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes("apps_skill_read"));
    assert.ok(names.includes("apps_skill_write"));
    assert.ok(actionBranch(tools.find((tool) => tool.name === "apps_skill_read"), "list"));
    assert.ok(actionBranch(tools.find((tool) => tool.name === "apps_skill_read"), "get"));
    assert.ok(actionBranch(tools.find((tool) => tool.name === "apps_skill_write"), "validate"));
    assert.ok(actionBranch(tools.find((tool) => tool.name === "apps_skill_write"), "submit"));
    assert.ok(actionBranch(tools.find((tool) => tool.name === "apps_skill_write"), "update"));
    assert.equal(names.includes("apps_validate_skill_package"), false);
    assert.equal(names.includes("apps_publish_skill"), false);
    assert.equal(names.includes("apps_update_skill"), false);
    assert.equal(names.includes("apps_publish_skill_private"), false);
    assert.equal(names.includes("apps_download_skill_package"), false);
  });

  it("forwards only canonical APPS Skill lifecycle names", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.params.name);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "{}" }] }
      });
    };

    try {
      for (const name of ["apps_skill_validate", "apps_skill_submit", "apps_skill_update"]) {
        await callMcpTool(name, {}, env, skillPrincipal);
      }
      assert.deepEqual(calls, ["apps_skill_validate", "apps_skill_submit", "apps_skill_update"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lists only the final Knowledge edit, public-share, and service tools", async () => {
    const tools = await mcpTools();
    const names = tools.map((tool) => tool.name);
    const expected = [
      "knowledge_list",
      "knowledge_service_handbook",
      "knowledge_query",
      "knowledge_file_read",
      "knowledge_file_versions",
      "knowledge_library_write",
      "knowledge_library_delete",
      "knowledge_service_update",
      "knowledge_share",
      "knowledge_feedback_submit",
      "knowledge_feedback_read",
      "knowledge_feedback_manage"
    ];
    const removed = [
      "knowledge_tree",
      "knowledge_file_get",
      "knowledge_folder_create",
      "knowledge_file_upload",
      "knowledge_file_update",
      "knowledge_public_share_create",
      "knowledge_service_publish",
      "knowledge_services_list",
      "knowledge_service_get",
      "knowledge_service_download",
      "knowledge_skill_publish",
      "knowledge_skills_list",
      "knowledge_skill_get",
      "knowledge_skill_download",
      "knowledge_audit_change_list",
      "knowledge_audit_change_get",
      "knowledge_audit_diff_read",
      "knowledge_owner_transfer_list",
      "knowledge_owner_transfer_initiate",
      "knowledge_owner_transfer_decide"
    ];

    for (const name of expected) {
      assert.ok(names.includes(name), `${name} should be advertised`);
    }
    for (const name of removed) {
      assert.equal(names.includes(name), false, `${name} should be hidden`);
    }
    assert.deepEqual(names.filter((name) => name.startsWith("knowledge_")), expected);
    assert.deepEqual(tools.find((tool) => tool.name === "knowledge_list")?.inputSchema, {
      type: "object",
      properties: {
        folderObjectId: { type: "string", description: "Folder object id to list. Omit for My Library root." }
      },
      additionalProperties: false
    });
    assert.deepEqual(tools.find((tool) => tool.name === "knowledge_service_handbook")?.inputSchema.required, ["serviceId"]);
    assert.equal(actionBranch(tools.find((tool) => tool.name === "knowledge_query"), "read"), undefined);

    const createShare = actionBranch(tools.find((tool) => tool.name === "knowledge_share"), "create");
    assert.deepEqual(createShare.required, ["action"]);
    assert.deepEqual(createShare.properties.expiry.enum, ["24h", "permanent"]);
    assert.equal(createShare.properties.expiry.default, "24h");

    const fileRead = tools.find((tool) => tool.name === "knowledge_file_read");
    assert.equal(Object.hasOwn(fileRead.inputSchema, "anyOf"), false);
    assert.ok(fileRead.inputSchema.properties.objectId);
    assert.equal(fileRead.inputSchema.properties.includeContent.type, "boolean");
    assert.deepEqual(tools.find((tool) => tool.name === "knowledge_file_versions")?.inputSchema.required, ["objectId"]);
    const fileEdit = actionBranch(tools.find((tool) => tool.name === "knowledge_library_write"), "edit");
    assert.deepEqual(
      fileEdit.required,
      ["action"]
    );
    const fileUpdate = actionBranch(tools.find((tool) => tool.name === "knowledge_library_write"), "update");
    assert.deepEqual(fileUpdate.required, ["action"]);
    assert.deepEqual(fileEdit.properties.operation.enum, [
      "replace_text",
      "append_text",
      "replace_content",
      "apply_patch"
    ]);
    const search = actionBranch(tools.find((tool) => tool.name === "knowledge_query"), "search");
    assert.equal(search.properties.queryContext.properties.storeOriginalQuestion.default, false);
    assert.ok(actionBranch(tools.find((tool) => tool.name === "knowledge_query"), "grep"));
  });

  it("advertises a compact read-only Knowledge surface to read-only MCP connections", async () => {
    const tools = await mcpTools({ ...testInstallation,
      ...env,
      DB: {
        prepare() {
          return {
            async all() {
              return { results: [] };
            }
          };
        }
      }
    }, {
      ...knowledgePrincipal,
      scopes: ["workspace:knowledge:read"]
    });
    const names = tools.map((tool) => tool.name).filter((name) => name.startsWith("knowledge_"));

    assert.deepEqual(names, [
      "knowledge_list",
      "knowledge_service_handbook",
      "knowledge_query",
      "knowledge_file_read",
      "knowledge_file_versions",
      "knowledge_feedback_submit",
      "knowledge_feedback_read"
    ]);
  });

  it("keeps Knowledge read, write, and share scopes strictly separated", async () => {
    await assert.rejects(
      () => callPublicMcpTool("knowledge_list", {}, env, { ...knowledgePrincipal, scopes: ["workspace:knowledge:write"] }),
      (error) => error.status === 403 && error.code === "insufficient_mcp_scope"
    );
    await assert.rejects(
      () => callMcpTool("knowledge_service_list", {}, env, { ...knowledgePrincipal, scopes: ["workspace:knowledge:write"] }),
      (error) => error.status === 403 && error.code === "insufficient_mcp_scope"
    );
    await assert.rejects(
      () => callMcpTool("knowledge_edit_folder_create", { name: "Denied" }, env, { ...knowledgePrincipal, scopes: ["workspace:knowledge:read"] }),
      (error) => error.status === 403 && error.code === "insufficient_mcp_scope"
    );
    await assert.rejects(
      () => callMcpTool("knowledge_file_public_share_get", { fileId: "file-1" }, env, { ...knowledgePrincipal, scopes: ["workspace:knowledge:read", "workspace:knowledge:write"] }),
      (error) => error.status === 403 && error.code === "insufficient_mcp_scope"
    );
  });

  it("updates only Knowledge Service routing info through the dedicated edit tool", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        return Response.json({ access_token: "knowledge-write-token" });
      }
      assert.equal(url, "https://knowledge.example.test/api/knowledge-services/ksvc-1/info");
      assert.equal(init.method, "PATCH");
      assert.deepEqual(JSON.parse(init.body), {
        info: {
          bestFor: ["开户门槛"],
          description: "合作银行资料",
          keywords: ["UBS", "AUM"],
          notFor: ["产品操作"],
          role: "回答合作银行准入问题",
          searchHints: ["银行名称", "客户地区"]
        }
      });
      return Response.json({ service: { id: "ksvc-1" } });
    };

    try {
      const result = await callMcpTool("knowledge_edit_service_update", {
        bestFor: ["开户门槛"],
        description: "合作银行资料",
        keywords: ["UBS", "AUM"],
        notFor: ["产品操作"],
        role: "回答合作银行准入问题",
        searchHints: ["银行名称", "客户地区"],
        serviceId: "ksvc-1"
      }, { ...env, MCP_INTROSPECTION_TOKEN: "mcp-broker-token" }, knowledgePrincipal);
      assert.equal(result.service.id, "ksvc-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves a live broker scope denial instead of reporting an upstream failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://auth.example.test/v1/resource-tokens/mint");
      return Response.json({ error: "mcp_connection_scope_denied" }, { status: 403 });
    };

    try {
      await assert.rejects(
        () => callMcpTool("knowledge_service_list", {}, {
          ...env,
          MCP_INTROSPECTION_TOKEN: "mcp-broker-token"
        }, knowledgePrincipal),
        (error) => error.status === 403 && error.code === "knowledge_resource_token_mint_failed"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requires confirmation for destructive Knowledge and public-share actions", async () => {
    await assert.rejects(
      () => callMcpTool("knowledge_edit_object_delete", { objectId: "file-1" }, env, { ...knowledgePrincipal, scopes: ["workspace:knowledge:write"] }),
      (error) => error.status === 409 && error.code === "tool_confirmation_required"
    );
    await assert.rejects(
      () => callMcpTool("knowledge_file_public_share_create", { fileId: "file-1" }, env, { ...knowledgePrincipal, scopes: ["workspace:knowledge:share"] }),
      (error) => error.status === 409 && error.code === "tool_confirmation_required"
    );
    await assert.rejects(
      () => callMcpTool("knowledge_file_public_share_revoke", { fileId: "file-1" }, env, { ...knowledgePrincipal, scopes: ["workspace:knowledge:share"] }),
      (error) => error.status === 409 && error.code === "tool_confirmation_required"
    );
  });

  it("validates Knowledge upload names and service read selectors at runtime", async () => {
    await assert.rejects(
      () => callMcpTool("knowledge_edit_file_upload", { contentText: "content" }, env, knowledgePrincipal),
      (error) => error.status === 400 && error.code === "missing_knowledge_file_name"
    );
    await assert.rejects(
      () => callMcpTool("knowledge_service_read", { serviceId: "ksvc-1" }, env, knowledgePrincipal),
      (error) => error.status === 400 && error.code === "missing_knowledge_service_read_target"
    );
  });

  it("returns explicit migration errors for removed Knowledge Service management and packages", async () => {
    await assert.rejects(
      () => callMcpTool("knowledge_service_publish", { folderObjectId: "folder-1" }, env, knowledgePrincipal),
      (error) => error.status === 410 && error.code === "knowledge_service_management_portal_only"
    );
    await assert.rejects(
      () => callMcpTool("knowledge_service_download", { serviceId: "ksvc-1" }, env, knowledgePrincipal),
      (error) => error.status === 410 && error.code === "knowledge_service_package_removed"
    );
    await assert.rejects(
      () => callMcpTool("knowledge_service_get", { serviceId: "ksvc-1" }, env, knowledgePrincipal),
      (error) => error.status === 410 && error.code === "knowledge_service_get_removed"
    );
  });

  it("proxies Knowledge Service list, handbook, and unified queries with read-only tokens", async () => {
    const originalFetch = globalThis.fetch;
    const workerCalls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        assert.equal(init.headers.Authorization, "Bearer mcp-broker-token");
        assert.equal(body.resourceId, "workspace-knowledge");
        assert.equal(body.mcpBrokered, true);
        assert.equal(body.principal.sub, "user-1");
        assert.equal(body.principal.orgId, "org-workspace");
        assert.equal(body.principal.departmentId, "dept-research");
        assert.deepEqual(body.principal.departmentPath, ["company", "dept-investment", "dept-research"]);
        assert.equal(body.principal.teamId, "team-market-data");
        assert.deepEqual(body.principal.teamPath, ["company", "dept-investment", "team-market-data"]);
        assert.deepEqual(body.scopes, ["workspace:knowledge:read"]);
        return new Response(JSON.stringify({ access_token: `token-${body.toolName}` }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }
      if (url === "https://knowledge.example.test/api/knowledge-services?view=card") {
        workerCalls.push("list");
        assert.equal(init.headers.Authorization, "Bearer token-knowledge_service_list");
        return Response.json({ services: [{ serviceId: "ksvc-1", name: "PB Partner" }] });
      }
      if (url === "https://knowledge.example.test/api/tree") {
        workerCalls.push("personal");
        assert.equal(init.headers.Authorization, "Bearer token-knowledge_edit_list");
        return Response.json({ items: [
          { id: "root-draft", kind: "folder", name: "My Draft", capabilities: { canRead: true, canEdit: true } },
          { id: "root-hidden", kind: "folder", name: "Hidden", capabilities: { canRead: false, canEdit: false } }
        ] });
      }
      if (url === "https://knowledge.example.test/api/shared-with-me") {
        workerCalls.push("shared");
        assert.equal(init.headers.Authorization, "Bearer token-knowledge_edit_list");
        return Response.json({ items: [] });
      }
      if (url === "https://knowledge.example.test/api/knowledge-services/ksvc-1/handbook") {
        workerCalls.push("handbook");
        assert.equal(init.headers.Authorization, "Bearer token-knowledge_service_handbook");
        return Response.json({ content: "# Handbook" });
      }
      if (url === "https://knowledge.example.test/api/knowledge-services/ksvc-1/query") {
        const body = JSON.parse(init.body);
        workerCalls.push(body.action);
        assert.equal(init.method, "POST");
        assert.equal(init.headers.Authorization, `Bearer token-knowledge_service_${body.action}`);
        if (body.action === "search") {
          assert.deepEqual(body, {
            action: "search",
            limit: 5,
            query: "alpha",
            queryContext: {
              clientSessionId: "session-1",
              clientTurnId: "turn-1",
              originalQuestion: "Where is Alpha?"
            }
          });
          return Response.json({
            queryLedger: { queryId: "kquery-1", queryStepId: "kstep-1" },
            results: [{ relativePath: "guide.md" }]
          });
        }
        if (body.action === "grep") {
          assert.deepEqual(body, { action: "grep", caseSensitive: true, limit: 3, pattern: "Beta" });
          return Response.json({ results: [{ lineNumber: 7 }] });
        }
        if (body.action === "tree") {
          assert.deepEqual(body, { action: "tree", depth: 2, relativePath: "entities" });
          return Response.json({ items: [{ relativePath: "entities/example.md" }] });
        }
        if (body.action === "glob") {
          assert.deepEqual(body, { action: "glob", pattern: "**/*.md" });
          return Response.json({ items: [{ relativePath: "guide.md" }] });
        }
        assert.deepEqual(body, { action: "read", relativePath: "guide.md" });
        return Response.json({ content: { encoding: "text", text: "Alpha Beta" } });
      }
      throw new Error(`unexpected fetch ${input}`);
    };

    try {
      const brokerEnv = { ...env, MCP_INTROSPECTION_TOKEN: "mcp-broker-token" };
      const publicListed = await callPublicMcpTool("knowledge_list", {}, brokerEnv, knowledgePrincipal);
      const listed = await callMcpTool("knowledge_service_list", {}, brokerEnv, knowledgePrincipal);
      const handbook = await callPublicMcpTool("knowledge_service_handbook", { serviceId: "ksvc-1" }, brokerEnv, knowledgePrincipal);
      const search = await callMcpTool("knowledge_service_search", {
        limit: 5,
        query: "alpha",
        queryContext: {
          clientSessionId: "session-1",
          clientTurnId: "turn-1",
          originalQuestion: "Where is Alpha?"
        },
        serviceId: "ksvc-1"
      }, brokerEnv, knowledgePrincipal);
      const grep = await callMcpTool("knowledge_service_grep", { caseSensitive: true, limit: 3, pattern: "Beta", serviceId: "ksvc-1" }, brokerEnv, knowledgePrincipal);
      const read = await callPublicMcpTool("knowledge_file_read", { relativePath: "guide.md", serviceId: "ksvc-1" }, brokerEnv, knowledgePrincipal);
      const tree = await callMcpTool("knowledge_service_tree", { depth: 2, relativePath: "entities", serviceId: "ksvc-1" }, brokerEnv, knowledgePrincipal);
      const glob = await callMcpTool("knowledge_service_glob", { pattern: "**/*.md", serviceId: "ksvc-1" }, brokerEnv, knowledgePrincipal);

      assert.equal(publicListed.services[0].serviceId, "ksvc-1");
      assert.deepEqual(publicListed.items.map((item) => item.id), ["root-draft"]);
      assert.equal(listed.services[0].serviceId, "ksvc-1");
      assert.equal(handbook.content, "# Handbook");
      assert.equal(search.results[0].relativePath, "guide.md");
      assert.equal(search.queryLedger.queryId, "kquery-1");
      assert.equal(grep.results[0].lineNumber, 7);
      assert.equal(read.content.text, "Alpha Beta");
      assert.equal(tree.items[0].relativePath, "entities/example.md");
      assert.equal(glob.items[0].relativePath, "guide.md");
      assert.deepEqual(workerCalls.slice().sort(), ["personal", "shared", "list", "list", "handbook", "search", "grep", "read", "tree", "glob"].sort());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("discovers collaborator roots from the canonical Knowledge edit root listing", async () => {
    const originalFetch = globalThis.fetch;
    const workerCalls = [];
    let tokenMintCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        tokenMintCount += 1;
        assert.equal(body.toolName, "knowledge_edit_list");
        assert.deepEqual(body.scopes, ["workspace:knowledge:read"]);
        return Response.json({ access_token: `token-${tokenMintCount}` });
      }
      if (url === "https://knowledge.example.test/api/tree") {
        workerCalls.push("personal");
        return Response.json({
          items: [{ effectiveRole: "owner", id: "owner-root", name: "My Root" }],
          namespace: { id: "personal-namespace" },
          requestId: "personal-request"
        });
      }
      if (url === "https://knowledge.example.test/api/shared-with-me") {
        workerCalls.push("shared");
        return Response.json({
          items: [
            { effectiveRole: "collaborator", id: "shared-root", name: "Workspace Policy" },
            { effectiveRole: "viewer", id: "service-root", name: "Read-only Service" },
            { effectiveRole: "owner", id: "owner-root", name: "Duplicate Root" }
          ],
          requestId: "shared-request"
        });
      }
      throw new Error(`unexpected fetch ${input}`);
    };

    try {
      const listed = await callMcpTool("knowledge_edit_list", {}, env, knowledgePrincipal);

      assert.equal(tokenMintCount, 2);
      assert.deepEqual(workerCalls.sort(), ["personal", "shared"]);
      assert.equal(listed.namespace.id, "personal-namespace");
      assert.equal(listed.requestId, "personal-request");
      assert.deepEqual(listed.items.map((item) => [item.id, item.effectiveRole]), [
        ["owner-root", "owner"],
        ["shared-root", "collaborator"],
        ["service-root", "viewer"]
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("routes ACL-based Knowledge search, grep, and file read without a service id", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        return Response.json({ access_token: "knowledge-read-token" });
      }
      assert.equal(init.headers.Authorization, "Bearer knowledge-read-token");
      if (url === "https://knowledge.example.test/api/knowledge-folders/root-draft/query") {
        const body = JSON.parse(init.body);
        assert.ok(["search", "grep"].includes(body.action));
        return Response.json({ results: [{ objectId: "note-1" }] });
      }
      if (url === "https://knowledge.example.test/api/files/note-1") {
        return Response.json({ item: { id: "note-1" } });
      }
      if (url === "https://knowledge.example.test/api/files/note-1/raw") {
        return new Response("Alpha note", { headers: { "content-type": "text/markdown" } });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const brokerEnv = { ...env, MCP_INTROSPECTION_TOKEN: "mcp-broker-token" };
      const search = await callPublicMcpTool("knowledge_query", {
        action: "search", folderObjectId: "root-draft", query: "Alpha"
      }, brokerEnv, knowledgePrincipal);
      const grep = await callPublicMcpTool("knowledge_query", {
        action: "grep", folderObjectId: "root-draft", pattern: "Alpha"
      }, brokerEnv, knowledgePrincipal);
      const read = await callPublicMcpTool("knowledge_file_read", {
        objectId: "note-1"
      }, brokerEnv, knowledgePrincipal);
      assert.equal(search.results[0].objectId, "note-1");
      assert.equal(grep.results[0].objectId, "note-1");
      assert.equal(read.content.text, "Alpha note");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses object ids for shared-folder edits and records canonical tool names", async () => {
    const originalFetch = globalThis.fetch;
    const audit = [];
    const workerCalls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        audit.push({
          toolName: body.toolName,
          scopes: body.scopes,
          ...(body.toolAlias ? { toolAlias: body.toolAlias } : {})
        });
        return Response.json({ access_token: `token-${body.toolName}` });
      }
      if (url === "https://knowledge.example.test/api/tree?folderObjectId=shared-folder") {
        workerCalls.push("list");
        return Response.json({ items: [] });
      }
      if (url === "https://knowledge.example.test/api/folders") {
        workerCalls.push("create-folder");
        assert.deepEqual(JSON.parse(init.body), { name: "Research", parentObjectId: "shared-folder" });
        return Response.json({ item: { id: "folder-2" } }, { status: 201 });
      }
      if (url === "https://knowledge.example.test/api/files/upload") {
        workerCalls.push("upload");
        assert.equal(init.body.get("parentObjectId"), "shared-folder");
        assert.equal(await init.body.get("file").text(), "v1");
        return Response.json({ item: { id: "file-1" } }, { status: 201 });
      }
      if (url === "https://knowledge.example.test/api/files/file-1/versions") {
        workerCalls.push("update");
        assert.equal(await init.body.get("file").text(), "v2");
        return Response.json({ version: { version: 2 } }, { status: 201 });
      }
      if (url === "https://knowledge.example.test/api/objects/file-1/rename") {
        workerCalls.push("rename");
        assert.deepEqual(JSON.parse(init.body), { name: "renamed.md" });
        return Response.json({ item: { id: "file-1", name: "renamed.md" } });
      }
      if (url === "https://knowledge.example.test/api/objects/file-1") {
        workerCalls.push("delete");
        assert.equal(init.method, "DELETE");
        return Response.json({ deleted: true });
      }
      throw new Error(`unexpected fetch ${input}`);
    };

    try {
      await callMcpTool("knowledge_edit_list", { folderObjectId: "shared-folder" }, env, knowledgePrincipal);
      await callMcpTool("knowledge_edit_folder_create", { name: "Research", parentObjectId: "shared-folder" }, env, knowledgePrincipal);
      await callMcpTool("knowledge_edit_file_upload", { contentText: "v1", fileName: "note.md", parentObjectId: "shared-folder" }, env, knowledgePrincipal);
      await callMcpTool("knowledge_edit_file_update", { contentText: "v2", fileName: "note.md", objectId: "file-1" }, env, knowledgePrincipal);
      await callMcpTool("knowledge_edit_object_rename", { name: "renamed.md", objectId: "file-1" }, env, knowledgePrincipal);
      await callMcpTool("knowledge_edit_object_delete", { confirm: true, objectId: "file-1" }, env, knowledgePrincipal);

      assert.deepEqual(workerCalls, ["list", "create-folder", "upload", "update", "rename", "delete"]);
      assert.deepEqual(audit, [
        { toolName: "knowledge_edit_list", scopes: ["workspace:knowledge:read"] },
        { toolName: "knowledge_edit_folder_create", scopes: ["workspace:knowledge:write"] },
        { toolName: "knowledge_edit_file_upload", scopes: ["workspace:knowledge:write"] },
        { toolName: "knowledge_edit_file_update", scopes: ["workspace:knowledge:write"] },
        { toolName: "knowledge_edit_object_rename", scopes: ["workspace:knowledge:write"] },
        { toolName: "knowledge_edit_object_delete", scopes: ["workspace:knowledge:write"] }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("proxies CAS Edit with MCP provenance", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        return Response.json({ access_token: `token-${body.toolName}` });
      }
      calls.push(url);
      assert.equal(init.headers["x-workspace-source-channel"], "mcp");
      if (url === "https://knowledge.example.test/api/files/file-1/edit") {
        assert.equal(init.headers["Idempotency-Key"], "turn-1-edit-1");
        assert.deepEqual(JSON.parse(init.body), {
          expectedCurrentVersionId: "kov-1",
          expectedOccurrences: 1,
          newText: "Beta",
          oldText: "Alpha",
          operation: "replace_text"
        });
        return Response.json({ changeItemId: "item-1", changeSetId: "change-1" });
      }
      throw new Error(`unexpected fetch ${input}`);
    };
    try {
      const edited = await callMcpTool("knowledge_edit_file_edit", {
        expectedCurrentVersionId: "kov-1",
        expectedOccurrences: 1,
        idempotencyKey: "turn-1-edit-1",
        newText: "Beta",
        objectId: "file-1",
        oldText: "Alpha",
        operation: "replace_text"
      }, env, knowledgePrincipal);
      assert.equal(edited.changeSetId, "change-1");
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("proxies G1.5 move, soft-delete restore, and immutable version restore tools", async () => {
    const originalFetch = globalThis.fetch;
    const workerCalls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        return Response.json({ access_token: `token-${body.toolName}` });
      }
      workerCalls.push({ body: init.body ? JSON.parse(init.body) : undefined, method: init.method ?? "GET", url });
      assert.equal(init.headers["x-workspace-source-channel"], "mcp");
      if (url.endsWith("/api/objects/file-1/move")) {
        assert.equal(init.headers["Idempotency-Key"], "move-1");
        return Response.json({ item: { id: "file-1", path: "PB Partner/archive/note.md" } });
      }
      if (url.endsWith("/api/objects/file-1/restore")) {
        assert.equal(init.headers["Idempotency-Key"], "restore-1");
        return Response.json({ item: { id: "file-1" }, restoredCount: 1 });
      }
      if (url.endsWith("/api/files/file-1/versions")) {
        return Response.json({ versions: [{ id: "version-1", version: 1 }] });
      }
      if (url.endsWith("/api/files/file-1/versions/version-1/restore")) {
        assert.equal(init.headers["Idempotency-Key"], "version-restore-1");
        return Response.json({ version: { id: "version-3", version: 3 } });
      }
      throw new Error(`unexpected fetch ${input}`);
    };

    try {
      await callMcpTool("knowledge_edit_object_move", {
        expectedCurrentVersionId: "version-2",
        idempotencyKey: "move-1",
        objectId: "file-1",
        parentObjectId: "archive-folder"
      }, env, knowledgePrincipal);
      await callMcpTool("knowledge_edit_object_restore", {
        expectedCurrentVersionId: "version-2",
        idempotencyKey: "restore-1",
        objectId: "file-1"
      }, env, knowledgePrincipal);
      const versions = await callMcpTool("knowledge_edit_file_versions", {
        objectId: "file-1"
      }, env, knowledgePrincipal);
      await callMcpTool("knowledge_edit_file_version_restore", {
        expectedCurrentVersionId: "version-2",
        idempotencyKey: "version-restore-1",
        objectId: "file-1",
        versionId: "version-1"
      }, env, knowledgePrincipal);

      assert.equal(versions.versions[0].id, "version-1");
      assert.deepEqual(workerCalls.map((call) => call.url), [
        "https://knowledge.example.test/api/objects/file-1/move",
        "https://knowledge.example.test/api/objects/file-1/restore",
        "https://knowledge.example.test/api/files/file-1/versions",
        "https://knowledge.example.test/api/files/file-1/versions/version-1/restore"
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("submits idempotent Knowledge feedback with read scope and MCP provenance", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        assert.deepEqual(body.scopes, ["workspace:knowledge:read"]);
        assert.equal(body.toolName, "knowledge_feedback_submit");
        return Response.json({ access_token: "feedback-token" });
      }
      if (url === "https://knowledge.example.test/api/feedback") {
        calls.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) });
        return Response.json({
          feedback: { id: "kfeedback-1", kind: "correction", status: "open" }
        }, { status: 201 });
      }
      throw new Error(`unexpected fetch ${input}`);
    };
    try {
      const result = await callMcpTool("knowledge_feedback_submit", {
        context: { query: "supplier status" },
        idempotencyKey: "pb-feedback-1",
        kind: "correction",
        message: "The supplier status is stale.",
        objectId: "file-1",
        queryId: "kquery-1",
        queryStepId: "kstep-1",
        serviceId: "ksvc-1"
      }, env, knowledgePrincipal);
      assert.equal(result.feedback.id, "kfeedback-1");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].headers.get("idempotency-key"), "pb-feedback-1");
      assert.equal(calls[0].headers.get("x-workspace-source-channel"), "mcp");
      assert.equal(calls[0].body.serviceId, "ksvc-1");
      assert.equal(calls[0].body.queryId, "kquery-1");
      assert.equal(calls[0].body.queryStepId, "kstep-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lists and reads the current user's Knowledge feedback", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        return Response.json({ access_token: `token-${body.toolName}` });
      }
      calls.push(url);
      if (url === "https://knowledge.example.test/api/feedback/mine?serviceId=ksvc-1&limit=10&status=open") {
        return Response.json({ feedback: [{ id: "kfeedback-1", status: "open" }] });
      }
      if (url === "https://knowledge.example.test/api/feedback/kfeedback-1") {
        return Response.json({ feedback: { id: "kfeedback-1", queryId: "kquery-1" } });
      }
      throw new Error(`unexpected fetch ${input}`);
    };
    try {
      const listed = await callMcpTool("knowledge_feedback_list_mine", {
        limit: 10,
        serviceId: "ksvc-1",
        status: "open"
      }, env, knowledgePrincipal);
      const detail = await callMcpTool("knowledge_feedback_get", {
        feedbackId: "kfeedback-1"
      }, env, knowledgePrincipal);

      assert.equal(listed.feedback[0].id, "kfeedback-1");
      assert.equal(detail.feedback.queryId, "kquery-1");
      assert.deepEqual(calls, [
        "https://knowledge.example.test/api/feedback/mine?serviceId=ksvc-1&limit=10&status=open",
        "https://knowledge.example.test/api/feedback/kfeedback-1"
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("creates, gets, and revokes latest-file public links with share-only tokens", async () => {
    const originalFetch = globalThis.fetch;
    const methods = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://auth.example.test/v1/resource-tokens/mint") {
        const body = JSON.parse(init.body);
        assert.deepEqual(body.scopes, ["workspace:knowledge:share"]);
        return Response.json({ access_token: `token-${body.toolName}` });
      }
      if (url === "https://knowledge.example.test/api/objects/file-1/public-share") {
        methods.push(init.method);
        if (init.method === "POST") {
          assert.deepEqual(JSON.parse(init.body), { expiry: "24h" });
          return Response.json({ url: "https://knowledge.example.test/public/PreviewOne" }, { status: 201 });
        }
        if (init.method === "GET") {
          return Response.json({ active: true, expiry: "24h", url: "https://knowledge.example.test/public/PreviewOne" });
        }
        assert.equal(init.method, "DELETE");
        return Response.json({ active: false, revoked: true });
      }
      throw new Error(`unexpected fetch ${input}`);
    };

    try {
      const created = await callMcpTool("knowledge_file_public_share_create", { confirm: true, fileId: "file-1" }, env, knowledgePrincipal);
      const current = await callMcpTool("knowledge_file_public_share_get", { fileId: "file-1" }, env, knowledgePrincipal);
      const revoked = await callMcpTool("knowledge_file_public_share_revoke", { confirm: true, fileId: "file-1" }, env, knowledgePrincipal);

      assert.equal(created.rawUrl, "https://knowledge.example.test/public/PreviewOne/raw");
      assert.equal(current.active, true);
      assert.equal(revoked.revoked, true);
      assert.deepEqual(methods, ["POST", "GET", "DELETE"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requires APPS write scope for Pages deployments", async () => {
    await assert.rejects(
      () => callMcpTool("apps_pages_deploy", {
        appId: "app-1",
        files: [{ path: "index.html", content: "ok" }]
      }, env, { ...principal, scopes: ["workspace:apps:read"] }),
      (error) => error.status === 403 && error.code === "insufficient_mcp_scope"
    );
  });

  it("proxies Pages deployments to APPS MCP tools/call", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "https://apps.example.test/mcp");
      assert.equal(init.method, "POST");
      assert.match(init.headers["x-workspace-scopes"], /apps:deploy:production/);
      const body = JSON.parse(init.body);
      assert.equal(body.method, "tools/call");
      assert.equal(body.params.name, "apps_pages_deploy");
      assert.equal(body.params.arguments.appId, "app-1");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ deployment: { status: "ready" } })
            }
          ]
        }
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    try {
      const result = await callMcpTool("apps_pages_deploy", {
        appId: "app-1",
        files: [{ path: "index.html", content: "ok" }]
      }, env, principal);

      assert.equal(result.content[0].type, "text");
      assert.match(result.content[0].text, /ready/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves structured APPS tool errors without truncating Auth handoff details", async () => {
    const originalFetch = globalThis.fetch;
    const how = `Call apps_get_auth_sdk and integrate the official @frontier-workspace/auth runtime. ${"Keep the deployment fail-closed and inspectable. ".repeat(8)}`;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.method, "tools/call");
      assert.equal(body.params.name, "apps_pages_deploy");
      assert.match(init.headers["x-request-id"], /^workspace-mcp-/);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Deployment blocked.\n${how}` }],
          structuredContent: {
            error: {
              schemaVersion: "workspace.mcp.error.v1",
              code: "auth_security_preflight_failed",
              status: 422,
              details: { security: { auth: { findings: [{ code: "AUTH_STATIC_EDGE_ENFORCEMENT_UNVERIFIED", how }] } } },
              handoff: {
                state: "action_required",
                nextAction: { kind: "tool_call", tool: "apps_get_app", arguments: { appId: "app-1" } }
              }
            }
          }
        }
      });
    };

    try {
      const result = await callMcpTool("apps_pages_deploy", {
        appId: "app-1",
        files: [{ path: "index.html", content: "ok" }]
      }, env, principal);

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, "auth_security_preflight_failed");
      assert.equal(result.structuredContent.error.details.security.auth.findings[0].how, how);
      assert.equal(result.structuredContent.error.handoff.nextAction.tool, "apps_get_app");
      assert.equal(result.content[0].text.includes(how), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves actionable APPS Worker RPC error codes", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.method, "tools/call");
      assert.equal(body.params.name, "apps_d1_migrations_apply");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: {
          code: -32001,
          message: "cloudflare_api_auth_failed",
          data: {
            code: "cloudflare_api_auth_failed",
            status: 401
          }
        }
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    try {
      await assert.rejects(
        () => callMcpTool("apps_d1_migrations_apply", {
          appId: "app-1",
          version: "20260701_initial",
          tablePrefix: "app_",
          sql: "CREATE TABLE IF NOT EXISTS app_requests (id TEXT PRIMARY KEY);"
        }, env, principal),
        (error) => error.status === 502 && error.code === "cloudflare_api_auth_failed"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects removed public aliases and hidden tools", async () => {
    const removedNames = [
      "knowledge_audit_change_get",
      "knowledge_audit_change_list",
      "knowledge_audit_diff_read",
      "knowledge_owner_transfer_decide",
      "knowledge_owner_transfer_initiate",
      "knowledge_owner_transfer_list",
      "knowledge_file_get",
      "knowledge_file_update",
      "knowledge_file_upload",
      "knowledge_folder_create",
      "knowledge_public_share_create",
      "knowledge_services_list",
      "knowledge_tree",
      "apps_apply_app_migration",
      "apps_deploy_app_source",
      "apps_deploy_pages",
      "apps_download_skill_package",
      "apps_get_skill_install_prompt",
      "apps_publish_production",
      "apps_publish_skill",
      "apps_publish_skill_private",
      "apps_update_skill",
      "apps_update_skill_private",
      "apps_validate_skill",
      "apps_validate_skill_package"
    ];

    for (const name of removedNames) {
      await assert.rejects(
        () => callMcpTool(name, {}, env, principal),
        (error) => error.status === 404 && error.code === "unknown_mcp_tool"
      );
    }
  });

  it("proxies D1 migrations with APPS write scope", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "https://apps.example.test/mcp");
      assert.equal(init.method, "POST");
      assert.match(init.headers["x-workspace-scopes"], /apps:apps:write/);
      assert.match(init.headers["x-workspace-scopes"], /apps:deploy:production/);
      const body = JSON.parse(init.body);
      assert.equal(body.method, "tools/call");
      assert.equal(body.params.name, "apps_d1_migrations_apply");
      assert.equal(body.params.arguments.version, "20260701_initial");
      assert.equal(body.params.arguments.allowDataMigrations, true);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ migration: { status: "applied" } })
            }
          ]
        }
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    try {
      const result = await callMcpTool("apps_d1_migrations_apply", {
        allowDataMigrations: true,
        appId: "app-1",
        version: "20260701_initial",
        tablePrefix: "app_",
        sql: "UPDATE app_requests SET status = 'ready' WHERE id = 'request-1';"
      }, env, principal);

      assert.match(result.content[0].text, /applied/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("proxies env var writes with APPS write scope", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      assert.doesNotMatch(init.headers["x-workspace-scopes"], /apps:deploy:production/);
      const body = JSON.parse(init.body);
      assert.equal(body.params.name, "apps_env_vars_set");
      assert.equal(body.params.arguments.vars.FEATURE_FLAG, "on");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify({ envVars: [] }) }] }
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    try {
      await callMcpTool("apps_env_vars_set", {
        appId: "app-1",
        vars: { FEATURE_FLAG: "on" }
      }, env, { ...principal, scopes: ["workspace:apps:write"] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("downloads listed Skill Hub packages with publication-scoped APPS access", async () => {
    const originalFetch = globalThis.fetch;
    const db = hubDb();
    const hubEnv = { ...testInstallation,
      ...env,
      DB: db
    };
    globalThis.fetch = async (input, init) => {
      if (input === "https://apps.example.test/hub-access") {
        assert.equal(init.method, "GET");
        const token = init.headers.Authorization.replace(/^Bearer\s+/i, "");
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        assert.equal(payload.department_id, "dept-research");
        assert.deepEqual(payload.department_path, ["company", "dept-research"]);
        return new Response(JSON.stringify({ appIds: [], skillIds: ["skill-1"] }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }
      assert.equal(input, "https://apps.example.test/mcp");
      assert.equal(init.method, "POST");
      assert.equal(init.headers["x-workspace-scopes"], "apps:skills:read");
      const token = init.headers.Authorization.replace(/^Bearer\s+/i, "");
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      assert.equal(payload.typ, "publication_access");
      assert.equal(payload.skill_id, "skill-1");
      assert.equal(payload.listing_id, "listing-1");
      const body = JSON.parse(init.body);
      assert.equal(body.params.name, "apps_download_skill_package");
      assert.equal(body.params.arguments.skillId, "skill-1");
      assert.equal(body.params.arguments.version, "skv-1");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ install: { prompt: "Install it" }, package: { filename: "skill.zip", version: "1.0.0", zipBase64: "emlw" } })
            }
          ]
        }
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    try {
      const result = await callMcpTool("hub_skill_download", {
        client: "codex",
        listingId: "listing-1",
        version: "0.9.0"
      }, hubEnv, {
        ...principal,
        departmentId: "dept-research",
        departmentPath: ["company", "dept-research"],
        scopes: ["workspace:hub:read"]
      });

      assert.equal(result.package.filename, "skill.zip");
      assert.equal(result.hub.listingId, "listing-1");
      assert.equal(result.hub.latestVersion, "1.0.0");
      assert.equal(result.hub.publicationVersionId, "market-version-1");
      assert.equal(result.hub.versionId, "skv-1");
      assert.deepEqual(db.state.versionBindings, [["listing-1"]]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("hides denied APPS Hub search/get results and blocks download/install prompt before package access", async () => {
    const originalFetch = globalThis.fetch;
    const db = deniedHubDb();
    const hubEnv = { ...testInstallation,  ...env, DB: db };
    let packageCalls = 0;
    globalThis.fetch = async (input) => {
      if (input === "https://apps.example.test/hub-access") {
        return new Response(JSON.stringify({ appIds: [], skillIds: [] }), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }
      packageCalls += 1;
      throw new Error(`unauthorized Hub asset reached ${input}`);
    };
    const deniedAuthor = {
      ...principal,
      departmentId: "dept-author",
      departmentPath: ["company", "dept-author"],
      role: "admin",
      scopes: ["workspace:hub:read"]
    };

    try {
      assert.deepEqual(await callMcpTool("hub_search", {}, hubEnv, deniedAuthor), { listings: [] });
      assert.deepEqual(await callMcpTool("hub_skills_list", {}, hubEnv, deniedAuthor), { listings: [] });
      await assert.rejects(
        () => callMcpTool("hub_get_listing", { listingId: "listing-app-denied" }, hubEnv, deniedAuthor),
        (error) => error.status === 404 && error.code === "hub_listing_not_found"
      );
      await assert.rejects(
        () => callMcpTool("hub_skill_download", { listingId: "listing-skill-denied" }, hubEnv, deniedAuthor),
        (error) => error.status === 404 && error.code === "hub_skill_listing_not_found"
      );
      await assert.rejects(
        () => callMcpTool("hub_get_skill_install_prompt", { listingId: "listing-skill-denied" }, hubEnv, deniedAuthor),
        (error) => error.status === 404 && error.code === "hub_skill_listing_not_found"
      );
      assert.equal(packageCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed for restricted non-APPS Hub listings without a matching config access target", async () => {
    const db = deniedHubDb({
      rows: [{
        configJson: JSON.stringify({ reviewDraft: { accessTargets: ["department:dept-operations"] } }),
        id: "listing-portal-denied",
        name: "Targeted Portal App",
        status: "listed",
        targetId: "app-portal-denied",
        targetPlane: "portal",
        type: "app",
        visibility: "team"
      }]
    });
    const deniedAuthor = {
      ...principal,
      departmentId: "dept-author",
      departmentPath: ["company", "dept-author"],
      role: "admin",
      scopes: ["workspace:hub:read"]
    };

    assert.deepEqual(await callMcpTool("hub_search", {}, { ...testInstallation,  ...env, DB: db }, deniedAuthor), { listings: [] });
  });

  it("requires APPS write scope for Hub submissions", async () => {
    await assert.rejects(
      () => callMcpTool("hub_submit_listing", {
        coverImageUrl: "data:image/png;base64,aGVsbG8=",
        description: "Ready for review.",
        name: "Research App",
        targetId: "app-1",
        targetType: "app",
        version: "1.0.0"
      }, { ...testInstallation,  ...env, DB: hubSubmitDb() }, { ...principal, scopes: ["workspace:hub:read"] }),
      (error) => error.status === 403 && error.code === "insufficient_mcp_scope"
    );
  });

  it("rejects unknown requested Skill versions instead of publishing a fallback", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "https://apps.example.test/skills/skill-1");
      assert.equal(init.method, "GET");
      return new Response(JSON.stringify({
        skill: {
          id: "skill-1",
          ownerUserId: "user-1",
          currentVersionId: "skv-current",
          versions: [{ id: "skv-current", version: "1.2.0" }]
        }
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    try {
      await assert.rejects(
        () => callMcpTool("hub_submit_listing", {
          description: "Ready for review.",
          name: "Research Skill",
          targetId: "skill-1",
          targetType: "skill",
          version: "9.9.9"
        }, { ...testInstallation,  ...env, DB: hubSubmitDb() }, principal),
        (error) => error.status === 404 && error.code === "apps_skill_version_not_found"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not let an organization reader submit another author's APPS through MCP", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      app: {
        id: "app-1",
        ownerUserId: "asset-owner-1",
        collaboratorUserIds: ["different-user"]
      }
    }), {
      headers: { "content-type": "application/json" },
      status: 200
    });

    try {
      await assert.rejects(
        () => callMcpTool("hub_submit_listing", {
          coverImageUrl: "data:image/png;base64,aGVsbG8=",
          description: "Should not publish.",
          name: "Someone else's App",
          targetId: "app-1",
          targetType: "app"
        }, { ...testInstallation,  ...env, DB: hubSubmitDb() }, principal),
        (error) => error.status === 404 && error.code === "apps_app_not_found"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves covers through the public MCP submission tool and writes org visibility to real SQLite", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const skill = String(input).includes("/skills/");
      const source = { id: skill ? "skill-1" : "app-1", ownerUserId: "user-1", name: "Existing", description: "Description", visibility: "org",
        versions: [{id:"skv-1",version:"1.0.0"}], currentVersionId:"skv-1" };
      return new Response(JSON.stringify(skill ? {skill:source} : {app:source}), {headers:{"content-type":"application/json"}});
    };
    const image = "data:image/png;base64,SGVsbG8=";
    try {
      for (const targetType of ["app", "skill"]) {
        const targetId = `${targetType}-1`;
        const url = cacheableCatalogImageUrl(targetType,targetId,image);
        for (const visibility of [undefined, "company", "org", "team", "private"]) {
          for (const coverImageUrl of [undefined, url, `https://portal.test${url}`]) {
            const database = new DatabaseSync(":memory:");
            try {
              database.exec(readFileSync(new URL("../../../db/schema.sql", import.meta.url), "utf8"));
              database.exec(`INSERT INTO teams(id,name,slug) VALUES('team-ai-adoption','Builders','builders');
                INSERT INTO users(id,team_id,name,email) VALUES('user-1','team-ai-adoption','Ada','ada@example.test');
                INSERT INTO skill_categories(id,name,slug) VALUES('category-workflow','Workflow','workflow');`);
              database.prepare("INSERT INTO publication_listings(id,listing_type,target_id,created_by_user_id,name,slug,cover_image_url) VALUES('listing-existing',?,?,'user-1','Existing','existing',?)").run(targetType,targetId,image);
              const db=hubSubmitDb({existingListing:{id:"listing-existing",slug:"existing",coverImageUrl:image},database});
              await callPublicMcpTool("apps_deployment_submit_listing",JSON.parse(JSON.stringify({targetType,targetId,category:"Workflow",coverImageUrl,visibility})), { ...testInstallation, ...env,DB:db,PORTAL_URL:"https://portal.test"},principal);
              const row=database.prepare("SELECT cover_image_url,visibility FROM publication_listings WHERE id='listing-existing'").get();
              assert.equal(row.cover_image_url,image);
              assert.equal(row.visibility, visibility === "team" || visibility === "private" ? visibility : "org");
            } finally {database.close();}
          }
        }
        for (const reference of [cacheableCatalogImageUrl(targetType,"other",image),cacheableCatalogImageUrl(targetType,targetId,"data:image/png;base64,V29ybGQ=")]) {
          const db=hubSubmitDb({existingListing:{id:"listing-existing",slug:"existing",coverImageUrl:image}});
          await assert.rejects(callPublicMcpTool("apps_deployment_submit_listing",{targetType,targetId,coverImageUrl:`https://portal.test${reference}`}, { ...testInstallation, ...env,DB:db,PORTAL_URL:"https://portal.test"},principal),e=>e.code==="invalid_cover_image_url");
          assert.equal(db.state.batches.length,0);
        }
      }
    } finally {globalThis.fetch=originalFetch;}
  });

  it("lets a APPS App collaborator submit it to Skill Hub review through MCP", async () => {
    const originalFetch = globalThis.fetch;
    const db = hubSubmitDb();
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "https://apps.example.test/apps/app-1");
      assert.equal(init.method, "GET");
      assert.equal(init.headers["x-workspace-scopes"], "apps:apps:read");
      return new Response(JSON.stringify({
        app: {
          id: "app-1",
          ownerUserId: "asset-owner-1",
          collaboratorUserIds: ["user-1"],
          name: "Research App",
          description: "Summarizes research briefings.",
          manifest: { appCode: "research-app" },
          status: "published",
          type: "static_page",
          updatedAt: "2026-07-02T00:00:00.000Z",
          visibility: "org"
        }
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    try {
      const result = await callMcpTool("hub_submit_listing", {
        category: "内部流程",
        coverImageUrl: "data:image/png;base64,aGVsbG8=",
        description: "Ready for review.",
        name: "Research App",
        riskLevel: "medium",
        tags: ["apps", "app", "research"],
        targetId: "app-1",
        targetType: "app",
        version: "1.0.0"
      }, { ...testInstallation,  ...env, DB: db }, principal);

      assert.equal(result.status, "pending_review");
      assert.equal(result.targetType, "app");
      assert.equal(result.targetId, "app-1");
      assert.equal(db.state.batches.length, 1);
      assert.equal(db.state.batches[0].length, 3);

      const listing = db.state.batches[0][0];
      assert.match(listing.sql, /INSERT INTO publication_listings/);
      assert.equal(listing.bindings[1], "app");
      assert.equal(listing.bindings[2], "app-1");
      assert.equal(listing.bindings[5], "Research App");
      assert.equal(listing.bindings[9], "data:image/png;base64,aGVsbG8=");
      assert.equal(listing.bindings[10], "category-workflow");
      assert.equal(listing.bindings[13], "medium");

      const version = db.state.batches[0][1];
      assert.equal(version.bindings[2], "1.0.0");
      assert.equal(version.bindings[3], "app_config");
      const config = JSON.parse(version.bindings[6]);
      assert.equal(config.source, "workspace-mcp");
      assert.equal(config.appsVerification.targetId, "app-1");
      assert.equal(config.builderSnapshot.appsVerified.app.id, "app-1");
      assert.ok(db.state.runs.some((run) => /INSERT INTO audit_logs/.test(run.sql)));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requires Skill write scope for private publishes", async () => {
    await assert.rejects(
      () => callMcpTool("apps_skill_submit", {
        skillMarkdown: "---\nname: Test\ndescription: Test\n---\n"
      }, env, { ...skillPrincipal, scopes: ["workspace:apps:read"] }),
      (error) => error.status === 403 && error.code === "insufficient_mcp_scope"
    );
  });

  it("proxies app-owned R2 writes with APPS write scope", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      assert.doesNotMatch(init.headers["x-workspace-scopes"], /apps:deploy:production/);
      const body = JSON.parse(init.body);
      assert.equal(body.params.name, "apps_r2_object_put");
      assert.equal(body.params.arguments.key, "reports/intro.md");
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify({ object: { key: "reports/intro.md" } }) }] }
      }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    };

    try {
      await callMcpTool("apps_r2_object_put", {
        appId: "app-1",
        key: "reports/intro.md",
        content: "# Hello"
      }, env, { ...principal, scopes: ["workspace:apps:write"] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function hubDb() {
  const state = {
    versionBindings: []
  };

  return {
    state,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async first() {
              if (sql.includes("FROM publication_listings")) {
                return {
                  configJson: "{}",
                  id: "listing-1",
                  listedVersionId: "skv-1",
                  name: "Listed Skill",
                  skillId: "skill-1",
                  targetId: "skill-1",
                  targetPlane: "apps",
                  type: "skill",
                  visibility: "private"
                };
              }
              if (sql.includes("FROM publication_versions")) {
                assert.match(sql, /ORDER BY created_at DESC/);
                state.versionBindings.push(bindings);
                return {
                  configJson: JSON.stringify({
                    appsVerification: { versionId: "skv-verification-fallback" },
                    versionId: "skv-1"
                  }),
                  id: "market-version-1",
                  version: "1.0.0-resubmitted"
                };
              }
              return null;
            }
          };
        }
      };
    }
  };
}

function deniedHubDb(options = {}) {
  const rows = options.rows ?? [
    {
      configJson: "{}",
      id: "listing-app-denied",
      name: "Denied App",
      status: "listed",
      targetId: "app-denied",
      targetPlane: "apps",
      type: "app",
      visibility: "team"
    },
    {
      configJson: "{}",
      id: "listing-skill-denied",
      name: "Denied Skill",
      skillId: "skill-denied",
      status: "listed",
      targetId: "skill-denied",
      targetPlane: "apps",
      type: "skill",
      visibility: "private"
    }
  ];

  return {
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async all() {
              if (!sql.includes("FROM publication_listings")) {
                return { results: [] };
              }
              if (sql.includes("listing_type IN") || sql.includes("listing_type = ?")) {
                const requestedType = bindings.find((binding) => binding === "app" || binding === "skill");
                return { results: requestedType ? rows.filter((row) => row.type === requestedType) : rows };
              }
              return { results: rows };
            },
            async first() {
              if (!sql.includes("FROM publication_listings")) {
                return null;
              }
              const requestedId = bindings.find((binding) => rows.some((row) => row.id === binding));
              const requestedTargetId = bindings.find((binding) => rows.some((row) => row.targetId === binding));
              return rows.find((row) => row.id === requestedId || row.targetId === requestedTargetId) ?? null;
            }
          };
        }
      };
    }
  };
}

function hubSubmitDb({ existingListing, database } = {}) {
  const state = {
    batches: [],
    firstCalls: [],
    runs: []
  };

  return {
    state,
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = {
            sql,
            bindings,
            async first() {
              state.firstCalls.push({ sql, bindings });
              if (sql.includes("FROM users")) {
                return { id: "user-1", teamId: "team-ai-adoption" };
              }
              if (sql.includes("FROM publication_listings")) return existingListing ?? null;
              if (sql.includes("FROM skill_categories")) {
                return bindings[0] === "category-workflow" ? { id: "category-workflow" } : null;
              }
              return null;
            },
            async run() {
              state.runs.push({ sql, bindings });
              return { success: true };
            }
          };
          return statement;
        }
      };
    },
    async batch(statements) {
      state.batches.push(statements);
      if (database) {
        for (const statement of statements) database.prepare(statement.sql).run(...statement.bindings);
      }
      return statements.map(() => ({ success: true }));
    }
  };
}

function forumDb({ acceptWrite = true, topicExists = true } = {}) {
  const state = {
    batches: [],
    replyCount: 0,
    runs: [],
    posts: [
      {
        id: "root-post-1",
        parentPostId: null,
        bodyMarkdown: "Original post",
        source: "portal",
        createdAt: "2026-07-13 09:00:00",
        updatedAt: "2026-07-13 09:00:00",
        author: "Ivy",
        authorEmail: "ivy@example.invalid"
      }
    ]
  };

  function statement(sql, bindings = []) {
    return {
      sql,
      bindings,
      bind(...nextBindings) {
        return statement(sql, nextBindings);
      },
      async first() {
        if (sql.includes("SELECT id FROM forum_topics WHERE id = ? AND status = 'open'")) {
          return topicExists && bindings[0] === "topic-1" ? { id: "topic-1" } : null;
        }
        if (sql.includes("SELECT title, author_user_id AS authorUserId FROM forum_topics")) {
          return topicExists && bindings[0] === "topic-1"
            ? { authorUserId: "user-ivy", title: "Skill Hub download issue" }
            : null;
        }
        if (sql.includes("FROM forum_posts") && sql.includes("JOIN users")) {
          return state.posts.find((post) => post.id === bindings[1] && bindings[0] === "topic-1") ?? null;
        }
        if (sql.includes("FROM users") && sql.includes("WHERE id = ? OR lower(email)")) {
          return { id: "user-1", teamId: "team-ai-adoption" };
        }
        if (sql.includes("FROM forum_topics") && sql.includes("JOIN forum_categories")) {
          return topicExists && bindings[0] === "topic-1"
            ? {
                id: "topic-1",
                title: "Skill Hub download issue",
                excerpt: "Package download returned 404.",
                topicType: "help",
                source: "portal",
                status: "open",
                replyCount: state.replyCount,
                viewCount: 1,
                lastActiveAt: "2026-07-13 10:00:00",
                createdAt: "2026-07-13 09:00:00",
                category: "公告与建议",
                categorySlug: "platform-help",
                author: "Ivy",
                authorUserId: "user-ivy",
                authorEmail: "ivy@example.invalid",
                tags: ""
              }
            : null;
        }
        return null;
      },
      async all() {
        if (sql.includes("FROM users") && sql.includes("lower(substr(email")) {
          return { results: bindings[0] === "ivy" ? [{ id: "user-ivy" }] : [] };
        }
        if (sql.includes("FROM forum_posts")) {
          return { results: [...state.posts] };
        }
        return { results: [] };
      },
      async run() {
        state.runs.push({ sql, bindings });
        return { success: true };
      }
    };
  }

  return {
    state,
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      state.batches.push(statements);
      for (const prepared of statements) {
        if (prepared.sql.includes("INSERT INTO forum_posts")) {
          if (!acceptWrite) {
            continue;
          }
          const [id, authorUserId, bodyMarkdown, topicId] = prepared.bindings;
          assert.equal(topicId, "topic-1");
          assert.equal(authorUserId, "user-1");
          state.posts.push({
            id,
            parentPostId: null,
            bodyMarkdown,
            source: "mcp",
            createdAt: "2026-07-13 10:00:00",
            updatedAt: "2026-07-13 10:00:00",
            author: "Ada",
            authorEmail: "ada@example.invalid"
          });
        }
        if (prepared.sql.includes("UPDATE forum_topics")) {
          if (!acceptWrite) {
            continue;
          }
          assert.equal(prepared.bindings[0], "topic-1");
          state.replyCount += 1;
        }
      }
      return statements.map(() => ({ success: true }));
    }
  };
}

function forumUpdateDb({ authorUserId = "user-1", topicExists = true, attachments = [] } = {}) {
  const state = {
    attachments: attachments.map((attachment, index) => ({
      createdAt: "2026-07-13 09:00:00",
      displayOrder: index + 1,
      fileName: attachment.fileName ?? `attachment-${index + 1}.png`,
      fileSize: attachment.fileSize ?? 100,
      id: attachment.id ?? `attachment-${index + 1}`,
      mimeType: attachment.mimeType ?? "image/png",
      ownerUserId: attachment.ownerUserId ?? authorUserId,
      postId: "root-post-1",
      publicUrl: attachment.publicUrl ?? `/api/forum/media/${attachment.storageKey}`,
      storageKey: attachment.storageKey,
      storageProvider: "r2",
      topicId: "topic-1"
    })),
    batches: [],
    topic: {
      authorUserId,
      excerpt: "Original post",
      id: "topic-1",
      rootPostId: "root-post-1",
      title: "Original title"
    },
    posts: [{
      author: "Ada",
      authorEmail: "ada@example.invalid",
      bodyMarkdown: "Original post",
      createdAt: "2026-07-13 09:00:00",
      id: "root-post-1",
      parentPostId: null,
      source: "portal",
      updatedAt: "2026-07-13 09:00:00"
    }]
  };

  function statement(sql, bindings = []) {
    return {
      sql,
      bindings,
      bind(...nextBindings) {
        return statement(sql, nextBindings);
      },
      async first() {
        if (sql.includes("FROM users") && sql.includes("WHERE id = ? OR lower(email)")) {
          return { id: "user-1", teamId: "team-ai-adoption" };
        }
        if (sql.includes("root_post_lookup") && sql.includes("forum_topics.author_user_id AS authorUserId")) {
          return topicExists && bindings[0] === "topic-1"
            ? { authorUserId: state.topic.authorUserId, rootPostId: state.topic.rootPostId }
            : null;
        }
        if (sql.includes("FROM forum_topics") && sql.includes("JOIN forum_categories")) {
          return topicExists && bindings[0] === "topic-1" ? {
            id: "topic-1",
            title: state.topic.title,
            excerpt: state.topic.excerpt,
            topicType: "official",
            source: "portal",
            status: "open",
            replyCount: 0,
            viewCount: 1,
            lastActiveAt: "2026-07-13 10:00:00",
            createdAt: "2026-07-13 09:00:00",
            category: "公告与建议",
            categorySlug: "platform-help",
            author: "Ada",
            authorEmail: "ada@example.invalid",
            tags: "mcp"
          } : null;
        }
        if (sql.includes("SELECT id FROM forum_attachments WHERE storage_key = ?")) {
          const attachment = state.attachments.find((candidate) => candidate.storageKey === bindings[0]);
          return attachment ? { id: attachment.id } : null;
        }
        return null;
      },
      async all() {
        if (sql.includes("FROM forum_posts")) {
          return { results: [...state.posts] };
        }
        if (sql.includes("FROM forum_attachments")) {
          return { results: state.attachments.map((attachment) => ({ ...attachment })) };
        }
        return { results: [] };
      },
      async run() {
        return { success: true };
      }
    };
  }

  return {
    state,
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      state.batches.push(statements);
      for (const prepared of statements) {
        if (prepared.sql.includes("UPDATE forum_topics")) {
          const [title, excerpt] = prepared.bindings;
          state.topic.title = title;
          state.topic.excerpt = excerpt;
        }
        if (prepared.sql.includes("UPDATE forum_posts")) {
          state.posts[0].bodyMarkdown = prepared.bindings[0];
          state.posts[0].updatedAt = "2026-07-13 10:00:00";
        }
        if (prepared.sql.includes("DELETE FROM forum_attachments")) {
          const [attachmentId, topicId, postId] = prepared.bindings;
          state.attachments = state.attachments.filter(
            (attachment) => attachment.id !== attachmentId || attachment.topicId !== topicId || attachment.postId !== postId
          );
        }
        if (prepared.sql.includes("INSERT INTO forum_attachments")) {
          const [id, topicId, postId, ownerUserId, storageKey, publicUrl, mimeType, fileName, fileSize, displayOrder] = prepared.bindings;
          state.attachments.push({
            createdAt: "2026-07-13 10:00:00",
            displayOrder,
            fileName,
            fileSize,
            id,
            mimeType,
            ownerUserId,
            postId,
            publicUrl,
            storageKey,
            storageProvider: "r2",
            topicId
          });
        }
      }
      return statements.map(() => ({ success: true }));
    }
  };
}

function forumAttachmentBucket({
  fileName = "cover.png",
  mimeType = "image/png",
  ownerUserId = "user-1",
  size = 1024,
  storageKey = "forum/2026/09/cover.png"
} = {}) {
  const state = { deletedKeys: [] };
  return {
    state,
    async delete(key) {
      state.deletedKeys.push(key);
    },
    async head(key) {
      if (key !== storageKey) return null;
      return {
        customMetadata: { originalFileName: fileName, ownerUserId, uploadedVia: "workspace-mcp" },
        httpMetadata: { contentType: mimeType },
        size
      };
    }
  };
}

function uploadFlowEnv() {
  const audits = [];
  const deletes = [];
  const puts = [];
  const objects = new Map();
  let session = null;
  const DB = {
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            sql,
            bindings,
            async first() {
              if (sql.includes("FROM users") && sql.includes("WHERE id = ? OR lower(email)")) {
                return { id: "user-1", teamId: "team-ai-adoption" };
              }
              if (sql.includes("FROM media_upload_sessions")) {
                return session;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO audit_logs")) {
                audits.push({ bindings, sql });
              }
              return { success: true };
            }
          };
        }
      };
    }
  };
  const FORUM_MEDIA = {
    async delete(key) {
      deletes.push(key);
      objects.delete(key);
    },
    async put(key, value, options) {
      let size = 0;
      if (value && typeof value.getReader === "function") {
        size = (await new Response(value).arrayBuffer()).byteLength;
      } else if (value && value.byteLength !== undefined) {
        size = value.byteLength;
      }
      objects.set(key, size);
      puts.push({ key, options, value });
    },
    async get(key) {
      const size = objects.get(key);
      return size ? { size } : null;
    }
  };

  return {
    audits,
    deletes,
    env: { ...testInstallation,  DB, FORUM_MEDIA, MCP_RESOURCE_URL: "https://mcp.example.test", PORTAL_URL: "https://ai.example.test" },
    objects,
    puts,
    setSession(value) {
      session = value;
    }
  };
}

function forumTopicCreateDb() {
  const state = {
    batches: [],
    posts: [],
    runs: [],
    topics: []
  };

  function statement(sql, bindings = []) {
    return {
      sql,
      bindings,
      bind(...nextBindings) {
        return statement(sql, nextBindings);
      },
      async first() {
        if (sql.includes("SELECT id FROM forum_categories WHERE slug = ?")) {
          return { id: "forum-platform-help" };
        }
        if (sql.includes("FROM users") && sql.includes("WHERE id = ? OR lower(email)")) {
          return { id: "user-1", teamId: "team-ai-adoption" };
        }
        if (sql.includes("content_hash AS contentHash") && sql.includes("idempotency_key = ?")) {
          const [authorUserId, idempotencyKey] = bindings;
          const topic = state.topics.find((candidate) => candidate.authorUserId === authorUserId && candidate.idempotencyKey === idempotencyKey);
          return topic ? { id: topic.id, contentHash: topic.contentHash, status: topic.status } : null;
        }
        if (sql.includes("content_hash = ?") && sql.includes("datetime('now', '-5 minutes')")) {
          const [authorUserId, contentHash] = bindings;
          const topic = state.topics.find((candidate) => candidate.authorUserId === authorUserId && candidate.contentHash === contentHash && candidate.status === "open");
          return topic ? { id: topic.id } : null;
        }
        if (sql.includes("FROM forum_topics") && sql.includes("JOIN forum_categories")) {
          const topic = state.topics.find((candidate) => candidate.id === bindings[0] && candidate.status === "open");
          return topic ? {
            id: topic.id,
            title: topic.title,
            excerpt: topic.excerpt,
            topicType: topic.topicType,
            source: "mcp",
            status: topic.status,
            replyCount: 0,
            viewCount: 0,
            lastActiveAt: "2026-07-20 00:00:00",
            createdAt: "2026-07-20 00:00:00",
            category: "公告与建议",
            categorySlug: "platform-help",
            author: "Ada",
            authorEmail: "ada@example.invalid",
            tags: ""
          } : null;
        }
        return null;
      },
      async all() {
        if (sql.includes("FROM forum_posts")) {
          return { results: state.posts.filter((post) => post.topicId === bindings[0]) };
        }
        return { results: [] };
      },
      async run() {
        state.runs.push({ sql, bindings });
        return { success: true };
      }
    };
  }

  return {
    state,
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      state.batches.push(statements);
      for (const prepared of statements) {
        if (prepared.sql.includes("INSERT INTO forum_topics")) {
          const [id, categoryId, authorUserId, title, topicType, teamId, excerpt, idempotencyKey, contentHash] = prepared.bindings;
          state.topics.push({ id, categoryId, authorUserId, title, topicType, teamId, excerpt, idempotencyKey, contentHash, status: "open" });
        }
        if (prepared.sql.includes("INSERT INTO forum_posts")) {
          const [id, topicId, authorUserId, bodyMarkdown] = prepared.bindings;
          state.posts.push({ id, topicId, authorUserId, bodyMarkdown, source: "mcp" });
        }
      }
      return statements.map(() => ({ success: true }));
    }
  };
}

function storage() {
  return { put: async (_key, _body, _options) => ({ size: 3 }) };
}

describe("public MCP capabilities", () => {
  it("serves generated media URLs for email, percent, Unicode and path punctuation identities", async () => {
    const originalFetch = globalThis.fetch;
    const objects = new Map();
    const mediaEnv = {
      MATE_ARTIFACTS: {
        async put(key, body, options) {
          const bytes = new Uint8Array(await new Response(body).arrayBuffer());
          objects.set(key, { bytes, ...options });
          return { size: bytes.byteLength };
        },
        async get(key) {
          const object = objects.get(key);
          return object ? { ...object, body: new Response(object.bytes).body, size: object.bytes.byteLength } : null;
        }
      },
      MCP_RESOURCE_URL: "https://mcp.example.test",
      AI: { run: async () => ({ result: { audio: "https://media.example.test/speech.mp3" } }) }
    };
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    try {
      for (const userId of ["legacy-user-1", "user+tag@example.test", "user%40example.test", "用户/name?#%!"]) {
        const result = await generateSpeech(mediaEnv, { text: "Synthetic speech." }, { sub: userId, orgId: "org-1" });
        const preview = new URL(result.audioUrl);
        assert.equal(decodeURIComponent(preview.pathname.split("/")[3]), userId);
        const response = await handleWorkspaceMcpWorkerRequest(new Request(preview), mediaEnv);
        assert.equal(response.status, 200);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
        preview.searchParams.set("token", "wrong-token");
        assert.equal((await handleWorkspaceMcpWorkerRequest(new Request(preview), mediaEnv)).status, 404);
      }
      const malformed = await handleWorkspaceMcpWorkerRequest(new Request("https://mcp.example.test/artifacts/org-1/bad%ZZ/direct/art_00000000-0000-4000-8000-000000000000"), mediaEnv);
      assert.equal(malformed.status, 400);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("transcribes exact audio bytes with Turbo and optional language/context through the public tool", async () => {
    const originalFetch = globalThis.fetch;
    const bytes = Uint8Array.from({ length: 20_001 }, (_, i) => i % 256);
    const calls = [];
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.redirect, "manual");
      return new Response(bytes);
    };
    try {
      const result = await callPublicMcpTool("tools_audio_asr", {
        audioUrl: "https://audio.example.test/fixture.mp3", language: "ZH", initialPrompt: "Workspace, 净值"
      }, { AI: { run: async (model, input) => {
        calls.push({ model, input });
        return { text: "净值十二", transcription_info: { language: "zh" }, segments: [{ text: "净值十二" }] };
      } } }, principal);
      assert.equal(calls[0].model, "@cf/openai/whisper-large-v3-turbo");
      assert.deepEqual(new Uint8Array(Buffer.from(calls[0].input.audio, "base64")), bytes);
      assert.equal(calls[0].input.language, "zh");
      assert.equal(calls[0].input.initial_prompt, "Workspace, 净值");
      assert.equal(calls[0].input.task, "transcribe");
      assert.equal(result.language, "zh");
      assert.equal(result.text, "净值十二");
      const schema = (await mcpTools()).find(t => t.name === "tools_audio_asr").inputSchema;
      assert.equal(new Ajv().validate(schema, { audioUrl: "https://audio.example.test/a.mp3", language: "zh", initialPrompt: "净值" }), true);
      assert.equal(new Ajv().validate(schema, { audioUrl: "https://audio.example.test/a.mp3", language: "Chinese" }), false);
      assert.equal(new Ajv().validate(schema, { audioUrl: "https://audio.example.test/a.mp3", initialPrompt: "x".repeat(2001) }), false);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("retains automatic language detection for audioUrl-only calls", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([0, 128, 255]));
    try {
      const result = await transcribeAudio({ AI: { run: async (_model, input) => {
        assert.deepEqual(input, { audio: "AID/", task: "transcribe" });
        return { text: "hello", transcription_info: { language: "en" } };
      } } }, { audioUrl: "https://audio.example.test/a.mp3" });
      assert.equal(result.language, "en");
    } finally { globalThis.fetch = originalFetch; }
  });

  it("rejects invalid language before fetching and does not mask failed audio downloads", async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    let invoked = false;
    globalThis.fetch = async () => { fetched = true; return new Response("bad", { status: 503 }); };
    const asrEnv = { AI: { run: async () => { invoked = true; return {}; } } };
    try {
      await assert.rejects(transcribeAudio(asrEnv, { audioUrl: "https://audio.example.test/a.mp3", language: "中文" }), /audio_language_invalid/);
      assert.equal(fetched, false);
      await assert.rejects(transcribeAudio(asrEnv, { audioUrl: "https://audio.example.test/a.mp3" }), /audio_fetch_failed/);
      assert.equal(invoked, false);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("generates MiniMax speech through Workers AI and stores an inline audio file", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const writes = [];
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    try {
      const result = await generateSpeech({
        MATE_ARTIFACTS: { put: async (...args) => { writes.push(args); return { size: 3 }; } },
        MCP_RESOURCE_URL: "https://mcp.example",
        AI: { run: async (model, input) => {
          calls.push({ model, input });
          return { result: { audio: "https://media.example/speech.mp3" }, usage: { total_tokens: 7 } };
        } }
      }, { text: "Hello from Workspace." }, { sub: "user-1", orgId: "org-1" });
      assert.equal(calls[0].model, "minimax/speech-2.8-turbo");
      assert.deepEqual(calls[0].input, {
        text: "Hello from Workspace.", voice_id: "English_expressive_narrator", speed: 1, volume: 1, pitch: 0, format: "mp3"
      });
      assert.match(result.audioUrl, /^https:\/\/mcp\.example\/artifacts\/org-1\/user-1\/direct\/art_/);
      assert.equal(result.contentType, "audio/mpeg");
      assert.equal(result.usage.total_tokens, 7);
      assert.equal(writes.length, 1);
      assert.equal(writes[0][2].httpMetadata.contentType, "audio/mpeg");
      assert.equal(writes[0][2].customMetadata.kind, "audio");
    } finally { globalThis.fetch = originalFetch; }
  });

  it("generates images directly through the AI binding", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { headers: { "content-type": "image/png" } });
    const calls = [];
    try {
      const result = await generateImage({
        MATE_ARTIFACTS: storage(),
        MCP_RESOURCE_URL: "https://mcp.example",
        AI: {
          run: async (model, input) => {
            calls.push({ model, input });
            return { state: "Completed", result: { image: "https://media.example/image.png" }, usage: { total_tokens: 12 } };
          }
        }
      }, { prompt: "A red circle", quality: "high", size: "1024x1024" }, { sub: "user-1", orgId: "org-1" });
      assert.equal(calls[0].model, "openai/gpt-image-2.5-flare");
      assert.match(result.imageUrl, /^https:\/\/mcp\.example\/artifacts\/org-1\/user-1\/direct\/art_/);
      assert.equal(result.usage.total_tokens, 12);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("generates videos directly through the AI binding", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
    try {
      const result = await generateVideo({
        MATE_ARTIFACTS: storage(),
        MCP_RESOURCE_URL: "https://mcp.example",
        AI: {
          run: async () => ({
            task: {
              id: "task-1",
              status: "succeeded",
              content: { url: "https://media.example/video.mp4" },
              duration: 5,
              resolution: "768P",
              ratio: "16:9"
            }
          })
        }
      }, { prompt: "Clouds moving", duration: 5 }, { sub: "user-1", orgId: "org-1" });
      assert.equal(result.status, "completed");
      assert.match(result.videoUrl, /^https:\/\/mcp\.example\/artifacts\/org-1\/user-1\/direct\/art_/);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("searches through Cloudflare Exa while retaining the public result fields", async () => {
    const result = await searchWeb({
      AI: {
        websearch: async ({ query, provider, gatewayId, limit }) => {
          assert.equal(provider, "exa");
          assert.equal(gatewayId, "default");
          assert.equal(limit, 3);
          return Response.json({
            metadata: { query, requestId: "request-1" },
            items: [{ title: "Cloudflare", url: "https://developers.cloudflare.com/", description: "Docs" }]
          });
        }
      }
    }, { query: "Cloudflare docs", limit: 3 });
    assert.equal(result.count, 1);
    assert.equal(result.provider, "cloudflare_web_search");
    assert.equal(result.searchProvider, "exa");
    assert.equal(result.requestId, "request-1");
    assert.equal(result.results[0].title, "Cloudflare");
  });

  it("reports Exa upstream failure without falling back to the unavailable OpenAI billing route", async () => {
    await assert.rejects(searchWeb({ AI: {
      websearch: async () => new Response("Unavailable", { status: 503 }),
      run: async () => { throw Error("Must not use an OpenAI fallback"); }
    } }, { query: "MAS regulations" }), (error) => error.status === 502 && error.code === "cloudflare_web_search_upstream_failed");
  });

  it("evaluates state with JEV directly through the AI binding", async () => {
    const calls = [];
    const result = await callJev({
      AI: {
        run: async (model, input) => {
          calls.push({ model, input });
          return { model: "jev-1.13.0", answers: { is_urgent: { answer: true } }, usage: { input_tokens: 24 } };
        }
      }
    }, {
      state: "Payments are unavailable.",
      questions: {
        is_urgent: {
          type: "noul",
          instructions: "Does this require urgent attention?",
          criteria: { true: "Active customer impact", false: "No active impact" }
        }
      }
    });
    assert.equal(calls[0].model, "typesafe/jev");
    assert.equal(calls[0].input.state, "Payments are unavailable.");
    assert.equal(result.provider, "cloudflare_ai");
    assert.equal(result.model, "jev-1.13.0");
    assert.equal(result.answers.is_urgent.answer, true);
  });

  it("normalizes a raw HTTP response returned by a third-party AI model", async () => {
    const result = await callJev({
      AI: {
        run: async () => new Response(JSON.stringify({
          result: { model: "jev-1.13.0", answers: { urgent: { type: "noul", noul: 0.98 } }, usage: { output_tokens: 8 } }
        }), { headers: { "content-type": "application/json" } })
      }
    }, {
      state: { outage: true },
      questions: { urgent: { type: "noul", instructions: "Is this urgent?" } }
    });
    assert.equal(result.answers.urgent.noul, 0.98);
    assert.equal(result.usage.output_tokens, 8);
  });
});

describe("Mate Call work Thread contract", () => {
  function threadedEnv(calls) {
    return {...env,MATE_RUNTIME_JWT_SECRET:"runtime-preview-secret-at-least-32-characters",MATE_RUNTIME:{async fetch(request) {
      const url=new URL(request.url); const body=request.method==="POST" ? await request.json().catch(()=>({})) : undefined;
      calls.push({url,body,method:request.method});
      if(url.pathname.endsWith("/tasks")) return Response.json({task:{id:"task_12345678",threadId:"thread_abcdefgh",mateCallId:"MATE-ABCD",status:"queued"}},{status:202});
      if(url.pathname.endsWith("/run")) return Response.json({task:{id:"task_12345678",threadId:"thread_abcdefgh",mateCallId:"MATE-ABCD",status:"completed"}});
      return Response.json({thread:{id:"thread_abcdefgh",mateCallId:"MATE-ABCD"},tasks:[],threads:[]});
    }}};
  }
  it("returns distinct execution and work IDs and forwards the continuation ID",async()=>{
    const calls=[]; const result=await callPublicMcpTool("mate_call",{action:"start",mateId:"mate-1",title:"Review",mateCallId:"MATE-ABCD",instruction:"Add a risk note"},threadedEnv(calls),{...principal,orgId:"org-1"});
    assert.equal(result.taskId,"task_12345678"); assert.equal(result.threadId,"thread_abcdefgh"); assert.equal(result.mateCallId,"MATE-ABCD");
    assert.equal(calls[0].body.mateCallId,"MATE-ABCD"); assert.equal(calls[0].body.title,"Review");
  });
  it("reads a Thread by human ID and forwards history pagination",async()=>{
    const calls=[]; await callPublicMcpTool("mate_call",{action:"follow",mateId:"mate-1",mateCallId:"MATE-ABCD",cursor:"31"},threadedEnv(calls),{...principal,orgId:"org-1"});
    assert.equal(calls[0].url.pathname,"/v1/mates/mate-1/threads/MATE-ABCD"); assert.equal(calls[0].url.searchParams.get("cursor"),"31");
  });
  it("rejects missing or conflicting follow selectors",async()=>{
    for(const args of [{},{taskId:"task_12345678",threadId:"thread_abcdefgh"}]) await assert.rejects(callPublicMcpTool("mate_call",{action:"follow",mateId:"mate-1",...args},threadedEnv([]),{...principal,orgId:"org-1"}),/mate_call_identifier_required/);
  });
  it("lists task Threads by default and schedules on request",async()=>{
    const calls=[]; await callPublicMcpTool("mate_call",{action:"list",mateId:"mate-1"},threadedEnv(calls),{...principal,orgId:"org-1"});
    await callPublicMcpTool("mate_call",{action:"list",mateId:"mate-1",kind:"schedule"},threadedEnv(calls),{...principal,orgId:"org-1"});
    assert.ok(calls.every(call=>call.url.pathname.endsWith("/threads"))); assert.equal(calls[0].url.searchParams.get("kind"),"task"); assert.equal(calls[1].url.searchParams.get("kind"),"schedule");
  });
  it("receipt action sends saved output without creating or running a Task",async()=>{
    const calls=[]; await callPublicMcpTool("mate_call",{action:"receipt",mateId:"mate-1",taskId:"task_12345678"},threadedEnv(calls),{...principal,orgId:"org-1"});
    assert.equal(calls.length,1); assert.ok(calls[0].url.pathname.endsWith("/tasks/task_12345678/receipt")); assert.equal(calls[0].method,"POST");
  });
});
