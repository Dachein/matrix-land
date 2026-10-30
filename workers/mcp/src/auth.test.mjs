import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signMcpAccessToken } from "../../auth/src/token.ts";
import { resolvePrincipal } from "./auth.ts";
import { errorResponse } from "./http.ts";
import { HttpError } from "./types.ts";
import { handleWorkspaceMcpWorkerRequest } from "./worker.ts";

const tokenEnv = {
  AUTH_ISSUER: "https://auth.example.invalid",
  AUTH_PUBLIC_URL: "https://ai.example.invalid",
  AUTH_WORKER_URL: "https://auth.example.test",
  MCP_ACCESS_JWT_SECRET: "mcp-access-test-secret",
  MCP_INTROSPECTION_TOKEN: "mcp-introspection-token",
  MCP_RESOURCE_URL: "https://mcp.example.invalid"
};

async function mcpToken(overrides = {}, env = tokenEnv) {
  return signMcpAccessToken(env, {
    typ: "mcp_access",
    iss: "https://auth.example.invalid",
    aud: "workspace-mcp",
    sub: "user-1",
    org_id: "org-workspace",
    client_id: "workspace-ai-mcp",
    connection_id: "conn-1",
    agent_type: "codex",
    resource: "https://mcp.example.invalid",
    department_id: "dept-research",
    department_path: ["company", "dept-investment", "dept-research"],
    team_id: "team-market-data",
    team_path: ["company", "dept-investment", "team-market-data"],
    scopes: ["workspace:knowledge:read"],
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides
  });
}

function mcpRequest(token) {
  return new Request("https://mcp.example.invalid/mcp", {
    headers: { authorization: `Bearer ${token}` }
  });
}

describe("frontier-workspace mcp worker authentication", () => {
  it("publishes only the canonical Hub scope for new OAuth connections", async () => {
    const response = await handleWorkspaceMcpWorkerRequest(new Request(
      "https://mcp.example.invalid/.well-known/oauth-protected-resource"
    ), tokenEnv);
    const metadata = await response.json();

    assert.equal(response.status, 200);
    assert.ok(metadata.scopes_supported.includes("workspace:hub:read"));
    assert.equal(metadata.scopes_supported.includes("workspace:market:read"), false);
  });

  it("allows DEV_AUTH_BYPASS only for localhost worker URLs", async () => {
    const principal = await resolvePrincipal(new Request("http://127.0.0.1:8793/mcp", {
      headers: {
        "x-workspace-department-id": "dept-research",
        "x-workspace-department-path": '["company","dept-investment","dept-research"]',
        "x-workspace-org-id": "org-workspace",
        "x-workspace-scopes": "workspace:forum:read",
        "x-workspace-team-id": "team-market-data",
        "x-workspace-team-path": "company,dept-investment,team-market-data",
        "x-workspace-user-id": "user-1"
      }
    }), {
      DEV_AUTH_BYPASS: "1"
    });

    assert.equal(principal.sub, "user-1");
    assert.deepEqual(principal.scopes, ["workspace:forum:read"]);
    assert.equal(principal.orgId, "org-workspace");
    assert.equal(principal.departmentId, "dept-research");
    assert.deepEqual(principal.departmentPath, ["company", "dept-investment", "dept-research"]);
    assert.equal(principal.teamId, "team-market-data");
    assert.deepEqual(principal.teamPath, ["company", "dept-investment", "team-market-data"]);
  });

  it("validates JWT bindings and uses current directory identity instead of stale local claims", async () => {
    const token = await mcpToken();
    let introspectionCalls = 0;
    const principal = await resolvePrincipal(new Request("https://mcp.example.invalid/mcp", {
      headers: { authorization: `Bearer ${token}` }
    }), tokenEnv, async (input, init) => {
      introspectionCalls += 1;
      assert.equal(String(input), "https://auth.example.test/v1/mcp/tokens/introspect");
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer mcp-introspection-token");
      assert.deepEqual(JSON.parse(String(init.body)), { token });
      return Response.json({
        active: true,
        authenticatedAt: "2026-08-04 15:09:00",
        clientId: "workspace-ai-mcp",
        connectionId: "conn-1",
        principal: {
          clientId: "workspace-ai-mcp",
          connectionId: "conn-1",
          defaultAgent: { id: "finance-assistant", name: "小鲸", email: "receipts-assistant@example.invalid" },
          department: "Current team",
          departmentId: "dept-current",
          departmentPath: ["company", "dept-current"],
          email: "current@example.com",
          name: "Current User",
          role: "member",
          sub: "user-1"
        }
      });
    });

    assert.equal(introspectionCalls, 1);
    assert.equal(principal.sub, "user-1");
    assert.equal(principal.connectionId, "conn-1");
    assert.equal(principal.authenticatedAt, "2026-08-04 15:09:00");
    assert.deepEqual(principal.scopes, ["workspace:knowledge:read"]);
    assert.equal(principal.orgId, "org-workspace");
    assert.equal(principal.departmentId, "dept-current");
    assert.deepEqual(principal.departmentPath, ["company", "dept-current"]);
    assert.equal(principal.email, "current@example.com");
    assert.deepEqual(principal.defaultAgent, { id: "finance-assistant", name: "小鲸", email: "receipts-assistant@example.invalid" });
    assert.equal(principal.role, "member");
    assert.equal(principal.teamId, undefined);
    assert.deepEqual(principal.teamPath, []);
  });

  it("unifies revoked, missing, and binding-mismatched connections as mcp_connection_revoked", async () => {
    const token = await mcpToken();
    const inactiveResponses = [
      {
        active: false,
        error: "mcp_connection_revoked",
        reason: "revoked",
        reauthorize: true
      },
      {
        active: false,
        error: "mcp_connection_reauthorization_required",
        reason: "connection_not_found",
        reauthorize: true
      },
      {
        active: false,
        error: "mcp_connection_binding_mismatch",
        reason: "subject_mismatch",
        reauthorize: true
      }
    ];

    for (const payload of inactiveResponses) {
      await assert.rejects(
        () => resolvePrincipal(mcpRequest(token), tokenEnv, async () => Response.json(payload)),
        (error) => error.status === 401 && error.code === "mcp_connection_revoked"
      );
    }

    await assert.rejects(
      () => resolvePrincipal(mcpRequest(token), tokenEnv, async () => Response.json(inactiveResponses[0], { status: 403 })),
      (error) => error.status === 401 && error.code === "mcp_connection_revoked"
    );
  });

  it("rejects an active introspection response whose connection binding differs from the local JWT", async () => {
    const token = await mcpToken();
    await assert.rejects(
      () => resolvePrincipal(mcpRequest(token), tokenEnv, async () => Response.json({
        active: true,
        clientId: "workspace-ai-mcp",
        connectionId: "another-connection",
        principal: {
          clientId: "workspace-ai-mcp",
          connectionId: "another-connection",
          sub: "user-1"
        }
      })),
      (error) => error.status === 401 && error.code === "mcp_connection_revoked"
    );
  });

  it("preserves safe token errors from Auth when signing keys diverge", async () => {
    const token = await mcpToken();
    await assert.rejects(
      () => resolvePrincipal(mcpRequest(token), tokenEnv, async () => Response.json({
        error: "invalid_token_signature"
      }, { status: 401 })),
      (error) => error.status === 401 && error.code === "invalid_mcp_token_signature"
    );
  });

  it("fails closed when introspection is unavailable, malformed, or not configured", async () => {
    const token = await mcpToken();

    await assert.rejects(
      () => resolvePrincipal(mcpRequest(token), tokenEnv, async () => {
        throw new Error("network failure");
      }),
      (error) => error.status === 503 && error.code === "mcp_introspection_unavailable"
    );

    await assert.rejects(
      () => resolvePrincipal(mcpRequest(token), tokenEnv, async () => new Response("not-json", { status: 200 })),
      (error) => error.status === 502 && error.code === "mcp_introspection_invalid_response"
    );

    const { AUTH_SERVICE_TOKEN: _serviceToken, MCP_INTROSPECTION_TOKEN: _introspectionToken, ...envWithoutIntrospectionToken } = tokenEnv;
    await assert.rejects(
      () => resolvePrincipal(mcpRequest(token), envWithoutIntrospectionToken),
      (error) => error.status === 503 && error.code === "mcp_introspection_token_not_configured"
    );
  });

  it("returns a stable reauthorization contract for HTTP and JSON-RPC 401 responses", async () => {
    const httpRequest = new Request("https://mcp.example.invalid/mcp");
    const httpResponse = errorResponse(
      new HttpError(401, "mcp_token_expired"),
      "request-http-1",
      tokenEnv,
      httpRequest
    );
    assert.equal(httpResponse.status, 401);
    assert.deepEqual(await httpResponse.json(), {
      error: "mcp_token_expired",
      message: "mcp_token_expired",
      requestId: "request-http-1",
      code: "mcp_token_expired",
      reauthorize: true,
      authorization_server: "https://auth.example.invalid",
      oauth_authorization_endpoint: "https://ai.example.invalid/auth/mcp/oauth/authorize",
      resource_metadata: "https://mcp.example.invalid/.well-known/oauth-protected-resource",
      instructions_url: "https://mcp.example.invalid/llms.txt"
    });
    assert.match(httpResponse.headers.get("www-authenticate"), /^Bearer error="invalid_token", error_description="mcp_token_expired",/);

    const token = await mcpToken();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
      active: false,
      error: "mcp_connection_revoked",
      reason: "revoked",
      reauthorize: true
    });

    try {
      const rpcResponse = await handleWorkspaceMcpWorkerRequest(new Request("https://mcp.example.invalid/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "notifications/initialized", params: {} })
      }), tokenEnv);
      const rpcBody = await rpcResponse.json();

      assert.equal(rpcResponse.status, 401);
      assert.equal(rpcResponse.headers.get("content-type"), "application/json");
      assert.match(rpcResponse.headers.get("www-authenticate"), /^Bearer error="invalid_token", error_description="mcp_connection_revoked",/);
      assert.equal(rpcBody.error.message, "mcp_connection_revoked");
      assert.deepEqual(rpcBody.error.data, {
        code: "mcp_connection_revoked",
        reauthorize: true,
        authorization_server: "https://auth.example.invalid",
        oauth_authorization_endpoint: "https://ai.example.invalid/auth/mcp/oauth/authorize",
        resource_metadata: "https://mcp.example.invalid/.well-known/oauth-protected-resource",
        instructions_url: "https://mcp.example.invalid/llms.txt"
      });
      assert.equal(JSON.stringify(rpcBody).includes(token), false);
      assert.equal(rpcResponse.headers.get("www-authenticate").includes(token), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects expired, incorrectly signed, and invalid-claim MCP tokens", async () => {
    const cases = [
      {
        token: await mcpToken({ exp: Math.floor(Date.now() / 1000) - 1 }),
        code: "mcp_token_expired"
      },
      {
        token: await mcpToken({}, { ...tokenEnv, MCP_ACCESS_JWT_SECRET: "wrong-secret" }),
        code: "invalid_mcp_token_signature"
      },
      {
        token: await mcpToken({ aud: "another-service" }),
        code: "invalid_mcp_token_audience"
      },
      {
        token: await mcpToken({ typ: "resource_access" }),
        code: "invalid_mcp_token_type"
      },
      {
        token: await mcpToken({ iss: "https://untrusted.example" }),
        code: "invalid_mcp_token_issuer"
      },
      {
        token: await mcpToken({ resource: "https://another-mcp.example" }),
        code: "invalid_mcp_token_resource"
      },
      {
        token: await mcpToken({ connection_id: "" }),
        code: "invalid_mcp_token_connection"
      }
    ];

    for (const testCase of cases) {
      await assert.rejects(
        () => resolvePrincipal(new Request("https://mcp.example.invalid/mcp", {
          headers: { authorization: `Bearer ${testCase.token}` }
        }), tokenEnv),
        (error) => error.status === 401 && error.code === testCase.code
      );
    }
  });

  it("requires the dedicated MCP access signing secret", async () => {
    const token = await mcpToken();
    await assert.rejects(
      () => resolvePrincipal(new Request("https://mcp.example.invalid/mcp", {
        headers: { authorization: `Bearer ${token}` }
      }), {}),
      (error) => error.status === 503 && error.code === "mcp_access_jwt_secret_not_configured"
    );
  });

  it("publishes the canonical agent names in product priority order", async () => {
    const metadataResponse = await handleWorkspaceMcpWorkerRequest(
      new Request("https://mcp.example.invalid/.well-known/workspace-mcp"),
      tokenEnv
    );
    const metadata = await metadataResponse.json();
    const codex = metadata.agents.find((agent) => agent.id === "codex");

    assert.equal(metadataResponse.status, 200);
    assert.deepEqual(metadata.agents.map((agent) => agent.id), ["workbuddy", "claude-code", "codex", "cursor"]);
    assert.deepEqual(metadata.agents.map((agent) => agent.label), ["WorkBuddy", "Claude Code", "Codex", "Cursor"]);
    assert.ok(codex);
    assert.match(codex.installPrompt, /remote MCP/);
    assert.match(codex.installPrompt, /OAuth/);
    assert.match(codex.installPrompt, /ping_who_am_i/);
    assert.doesNotMatch(codex.installPrompt, /llms\.txt/);
    assert.equal(codex.llmsTxt, "https://mcp.example.invalid/llms.txt?for=codex");

    const codexResponse = await handleWorkspaceMcpWorkerRequest(
      new Request("https://mcp.example.invalid/llms.txt?for=codex&lang=en"),
      tokenEnv
    );
    const codexPrompt = await codexResponse.text();
    assert.match(codexPrompt, /Codex/);
    assert.match(codexPrompt, /OAuth/);
    assert.match(codexPrompt, /Streamable HTTP/);
    assert.doesNotMatch(codexPrompt, /WORKSPACE_AI_MCP_TOKEN|bearer_token_env_var\s*=/);
  });

  it("renders one-command Codex CLI install prompts", async () => {
    const cases = [
      {
        language: "zh-CN",
        task: "为 Codex 连接当前企业的 MCP",
        handoff: "确认授权页面属于当前企业"
      },
      {
        language: "en",
        task: "Connect Codex to this workspace",
        handoff: "Verify that the approval page belongs to this workspace"
      }
    ];

    for (const testCase of cases) {
      const response = await handleWorkspaceMcpWorkerRequest(
        new Request(`https://mcp.example.invalid/llms.txt?for=codex&lang=${testCase.language}`),
        tokenEnv
      );
      const prompt = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /^text\/plain/);
      assert.match(prompt, new RegExp(testCase.task));
      assert.match(prompt, /OAuth/);
      assert.match(prompt, /ping_who_am_i/);
      assert.match(prompt, new RegExp(testCase.handoff));
      assert.doesNotMatch(prompt, /codex mcp add|codex mcp login|https:\/\/mcp\.example-org\.app\/mcp/);
      assert.doesNotMatch(prompt, /access_token from STEP|WORKSPACE_AI_MCP_TOKEN/);
    }
  });

  it("publishes one-command CLI setup for every supported client", async () => {
    for (const agent of ["workbuddy", "claude-code", "codex", "cursor"]) {
      const response = await handleWorkspaceMcpWorkerRequest(
        new Request(`https://mcp.example.invalid/llms.txt?for=${agent}&lang=en`),
        tokenEnv
      );
      const prompt = await response.text();
      assert.equal(response.status, 200);
      assert.match(prompt, /OAuth/);
      assert.match(prompt, /https:\/\/mcp\.example\.invalid\/mcp/);
      if (agent === "workbuddy") {
        assert.match(prompt, /WorkBuddy/);
      }
      assert.match(prompt, /ping_who_am_i/);
      assert.doesNotMatch(prompt, /mcp add|mcp login|Settings → MCP|Customize → MCP/);
      assert.doesNotMatch(prompt, /\/mcp\/device\/|device_code|access_token from STEP|Authorization: Bearer|WORKSPACE_AI_MCP_TOKEN/);
    }
  });

  it("negotiates Workspace MCP identity and guides older Workspace CLI clients to the matching workspace release", async () => {
    for (const [version, upgradeRequired] of [["0.0.0", true], ["0.1.0", false]]) {
      const response = await handleWorkspaceMcpWorkerRequest(new Request("http://127.0.0.1:8793/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `workspace-cli/${version}`,
          "x-workspace-scopes": "workspace:knowledge:read",
          "x-workspace-user-id": "user-1"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 19,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" }
        })
      }), { DEV_AUTH_BYPASS: "1" });
      const rpc = await response.json();

      assert.equal(rpc.result.serverInfo.name, "workspace-pass");
      assert.equal(rpc.result.workspaceCompatibility.currentVersion, version);
      assert.equal(rpc.result.workspaceCompatibility.minimumVersion, "0.1.0");
      assert.equal(rpc.result.workspaceCompatibility.upgradeRequired, upgradeRequired);
      assert.match(rpc.result.workspaceCompatibility.upgradeCommand, /frontier-workspace-cli-0.1.0.tgz/);
      assert.equal(rpc.result.instructions.includes("Call ping_who_am_i first after setup"), true);
      assert.equal(rpc.result.instructions.includes("guided usage behaves unexpectedly"), true);
      assert.equal(rpc.result.instructions.includes("old first-level tool names are not public aliases"), true);
    }

    const pingCases = [
      {
        userAgent: "workspace-cli/0.0.0",
        expectedStatus: "action_required",
        expectedCliStatus: "upgrade_required",
        expectedAction: "upgrade_cli_and_reinstall_connector",
        expectedBlocking: true
      },
      {
        userAgent: "workspace-cli/0.1.0",
        expectedStatus: "ready",
        expectedCliStatus: "ok",
        expectedAction: null,
        expectedBlocking: null
      },
      {
        userAgent: "codex-mcp-client/1.0.0",
        expectedStatus: "attention_required",
        expectedCliStatus: "unverified",
        expectedAction: "reinstall_connector",
        expectedBlocking: false
      }
    ];

    for (const [index, testCase] of pingCases.entries()) {
      const pingResponse = await handleWorkspaceMcpWorkerRequest(new Request("http://127.0.0.1:8793/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": testCase.userAgent,
          "x-workspace-agent-type": "codex",
          "x-workspace-user-id": "user-1"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 30 + index,
          method: "tools/call",
          params: { name: "ping_who_am_i", arguments: {} }
        })
      }), { DEV_AUTH_BYPASS: "1" });
      const pingRpc = await pingResponse.json();
      const ping = JSON.parse(pingRpc.result.content[0].text);

      assert.equal(ping.status, testCase.expectedStatus);
      assert.equal(ping.checks.authentication.status, "ok");
      assert.equal(ping.checks.cli.status, testCase.expectedCliStatus);
      assert.equal(ping.requiredAction?.type ?? null, testCase.expectedAction);
      assert.equal(ping.requiredAction?.blocking ?? null, testCase.expectedBlocking);
      if (ping.requiredAction) {
        assert.match(ping.requiredAction.command, /frontier-workspace-cli-0.1.0.tgz/);
        assert.equal(ping.requiredAction.then, "reload_connector_and_call_ping_who_am_i");
      }
    }

    const blockedResponse = await handleWorkspaceMcpWorkerRequest(new Request("http://127.0.0.1:8793/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "workspace-cli/0.0.0",
        "x-workspace-scopes": "workspace:hub:read",
        "x-workspace-user-id": "user-1"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: { name: "hub_search", arguments: {} }
      })
    }), { DEV_AUTH_BYPASS: "1" });
    const blocked = await blockedResponse.json();
    assert.equal(blocked.result.isError, true);
    assert.equal(blocked.result.structuredContent.error.code, "workspace_cli_upgrade_required");
    assert.match(blocked.result.structuredContent.error.summary, /frontier-workspace-cli-0.1.0.tgz/);
  });

  it("rejects DEV_AUTH_BYPASS on non-local worker URLs", async () => {
    await assert.rejects(
      () => resolvePrincipal(new Request("https://mcp.example.invalid/mcp"), {
        DEV_AUTH_BYPASS: "1"
      }),
      (error) => error.status === 503 && error.code === "dev_auth_bypass_forbidden"
    );
  });
});

describe("frontier-workspace mcp tool error handoff", () => {
  it("returns downstream APPS errors as a single unmodified MCP tool result", async () => {
    const originalFetch = globalThis.fetch;
    const how = `Use the official @frontier-workspace/auth runtime. ${"This complete remediation text must survive the MCP proxy. ".repeat(8)}`;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://apps.example.test/mcp");
      const requestId = new Headers(init.headers).get("x-request-id");
      const body = JSON.parse(String(init.body));
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
              requestId,
              details: { security: { auth: { findings: [{ how }] } } },
              handoff: {
                nextAction: {
                  kind: "tool_call",
                  tool: "apps_app_read",
                  arguments: { action: "get", appId: "app-1" }
                }
              }
            }
          }
        }
      });
    };

    try {
      const response = await handleWorkspaceMcpWorkerRequest(new Request("http://127.0.0.1:8793/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workspace-org-id": "org-1",
          "x-workspace-scopes": "workspace:apps:read,workspace:apps:write",
          "x-workspace-user-id": "user-1",
          "x-request-id": "outer-request-1"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 26,
          method: "tools/call",
          params: {
            name: "apps_deploy_prepare",
            arguments: { action: "worker", appId: "app-1", files: [{ path: "index.js", content: "source-not-returned" }] }
          }
        })
      }), {
        DEV_AUTH_BYPASS: "1",
        AUTH_ISSUER: "https://auth.example.test",
        APPS_ORG_ID: "org-1",
        WORKSPACE_MCP_JWT_SECRET: "test-secret",
        APPS_WORKER_URL: "https://apps.example.test",
        MCP_RESOURCE_URL: "https://mcp.example.test"
      });
      const rpc = await response.json();

      assert.equal(rpc.error, undefined);
      assert.equal(rpc.result.isError, true);
      assert.equal(rpc.result.structuredContent.error.code, "auth_security_preflight_failed");
      assert.equal(rpc.result.structuredContent.error.requestId, "outer-request-1");
      assert.equal(rpc.result.structuredContent.error.details.security.auth.findings[0].how, how);
      assert.equal(rpc.result.structuredContent.error.handoff.nextAction.tool, "apps_app_read");
      assert.equal(rpc.result.content[0].text.includes(how), true);
      assert.equal(JSON.stringify(rpc.result).includes("source-not-returned"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
