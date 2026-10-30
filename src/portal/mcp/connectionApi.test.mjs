import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  McpConnectionApiError,
  classifyMcpConnectionRevokeError,
  revokeMcpConnection
} from "./connectionApi.ts";
import { directMcpInstallPrompt } from "./installPrompt.ts";

describe("Portal MCP connection API", () => {
  it("revokes the encoded connection id with DELETE", async () => {
    const requests = [];

    await revokeMcpConnection("mcp-conn/ivy refresh", async (input, init) => {
      requests.push({ input: String(input), method: init?.method });
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    });

    assert.deepEqual(requests, [{
      input: "/api/mcp/connections/mcp-conn%2Fivy%20refresh",
      method: "DELETE"
    }]);
  });

  it("preserves a structured 403 response for a clear authorization error", async () => {
    let caught;

    try {
      await revokeMcpConnection("mcp-conn-1", async () => new Response(
        JSON.stringify({ error: "mcp_connection_forbidden" }),
        { status: 403 }
      ));
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof McpConnectionApiError);
    assert.equal(caught.status, 403);
    assert.equal(caught.message, "mcp_connection_forbidden");
    assert.equal(classifyMcpConnectionRevokeError(caught), "mcp.revokeSessionRejected");
  });

  it("distinguishes an expired Portal session from a generic failure", () => {
    assert.equal(
      classifyMcpConnectionRevokeError(new McpConnectionApiError(401, "not_authenticated")),
      "mcp.revokeSignInRequired"
    );
    assert.equal(
      classifyMcpConnectionRevokeError(new McpConnectionApiError(502, "mcp_connection_revoke_failed")),
      "mcp.revokeFailed"
    );
  });

  it("requires an explicit enterprise MCP URL and includes only that target", () => {
    assert.throws(() => directMcpInstallPrompt("codex", "en", ""), /mcp_resource_not_configured/);
    for (const agent of ["workbuddy", "claude-code", "codex", "cursor"]) {
      const prompt = directMcpInstallPrompt(agent, "en", "https://mcp.enterprise.example/mcp");
      assert.match(prompt, /https:\/\/mcp\.enterprise\.example\/mcp/);
      assert.match(prompt, /OAuth|oauth/);
      assert.match(prompt, /ping_who_am_i/);
      assert.doesNotMatch(prompt, /example\.invalid/);
    }
  });
});
