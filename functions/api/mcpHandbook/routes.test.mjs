import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { mcpTools } from "../../../workers/mcp/src/tools.ts";
import { dispatchMcpHandbookRoutes } from "./routes.ts";
import { WORKSPACE_MCP_VERSION, WORKSPACE_MCP_RELEASED_AT, WORKSPACE_MCP_PROTOCOL_VERSION, WORKSPACE_MCP_RELEASES } from "../../../src/shared/mcpHandbook.ts";
import { WORKSPACE_AI_CLI_VERSION, WORKSPACE_AUTH_SDK_VERSION } from "../../../src/shared/workspaceProductFamily.ts";

function context(method = "GET") {
  return {
    env: {},
    request: new Request("https://ai.example.test/api/mcp/handbook", { method })
  };
}

describe("MCP Handbook API", () => {
  it("keeps the displayed developer product family versions aligned with their packages", async () => {
    const authPackage = JSON.parse(await readFile(new URL("../../../sdk/auth/package.json", import.meta.url), "utf8"));
    const cliPackage = JSON.parse(await readFile(new URL("../../../packages/cli/package.json", import.meta.url), "utf8"));

    assert.equal(WORKSPACE_AUTH_SDK_VERSION, authPackage.version);
    assert.equal(WORKSPACE_AI_CLI_VERSION, cliPackage.version);
  });

  it("returns the standard authenticated MCP tool catalog", async () => {
    let resolvedUsers = 0;
    const response = await dispatchMcpHandbookRoutes(context(), {
      async resolveCurrentUser() {
        resolvedUsers += 1;
        return { id: "user-1" };
      }
    }, "mcp/handbook");
    const payload = await response.json();
    const canonicalNames = (await mcpTools()).map((tool) => tool.name).sort();

    assert.ok(canonicalNames.includes("ping_who_am_i"));
    assert.equal(resolvedUsers, 1);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, max-age=300");
    assert.deepEqual(payload.server, {
      name: "workspace-pass",
      protocol: "Model Context Protocol",
      protocolVersion: WORKSPACE_MCP_PROTOCOL_VERSION,
      releasedAt: WORKSPACE_MCP_RELEASED_AT,
      version: WORKSPACE_MCP_VERSION
    });
    assert.deepEqual(
      payload.releases.slice(0, 25).map((release) => release.version),
      WORKSPACE_MCP_RELEASES.slice(0, 25).map((release) => release.version)
    );
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "knowledge-list-discovery"));
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "personal-mate-creation-profile"));
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "gateway-model-catalog"));
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "same-zone-app-mcp-routing"));
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "release-safe-apps-build-guidance"));
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "configurable-app-resource-token-header"));
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "capability-based-app-mcp"));
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "current-deployed-source-code"));
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "app-mcp-rbac"));
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "connection-verification"));
    assert.ok(payload.latestFeatures.some((feature) => feature.id === "oauth-only-clients"));
    assert.equal(payload.summary.toolCount, 50);
    assert.equal(payload.groups.some((group) => group.id === "system"), false);
    assert.equal(payload.groups.find((group) => group.id === "forum-hub").count, 5);
    assert.equal(payload.groups.find((group) => group.id === "knowledge").count, 12);
    assert.equal(payload.groups.find((group) => group.id === "apps").count, 25);
    assert.equal(payload.groups.find((group) => group.id === "tools").count, 8);
    assert.deepEqual(payload.tools.map((tool) => tool.name).sort(), canonicalNames.filter((name) => name !== "ping_who_am_i"));
    assert.equal(payload.tools.some((tool) => tool.name === "ping_who_am_i"), false);
    assert.equal(payload.tools.some((tool) => tool.name === "apps_publish_production"), false);
    const operationFor = (name) => payload.tools.find((tool) => tool.name === name)?.operation;
    assert.equal(operationFor("apps_deploy_prepare"), "write");
    assert.equal(operationFor("apps_deployment_release"), "approval");
    assert.equal(operationFor("app_mcp_tool_call"), "approval");
    assert.equal(operationFor("knowledge_service_update"), "write");
    assert.equal(operationFor("apps_config"), "write");
    assert.equal(payload.tools.some((tool) => tool.name.startsWith("knowledge_audit_")), false);
    assert.equal(payload.tools.some((tool) => tool.name.startsWith("knowledge_owner_transfer_")), false);
    assert.deepEqual(
      payload.capabilityPacks.flatMap((pack) => pack.toolNames).sort(),
      canonicalNames.filter((name) => name !== "ping_who_am_i")
    );
    assert.equal(new Set(payload.capabilityPacks.flatMap((pack) => pack.toolNames)).size, 50);
    assert.deepEqual(
      payload.capabilityPacks.find((pack) => pack.id === "models")?.toolNames,
      ["models_list"]
    );
    assert.equal(payload.capabilityPacks.some((pack) => pack.id === "system-connection"), false);
    assert.equal(payload.capabilityPacks.find((pack) => pack.id === "knowledge-query").count, 7);
    assert.equal(payload.capabilityPacks.find((pack) => pack.id === "knowledge-authoring").count, 5);
    assert.deepEqual(
      payload.capabilityPacks.filter((pack) => pack.group === "tools").map(({ namespace, toolNames }) => ({ namespace, toolNames })),
      [
        { namespace: "models", toolNames: ["models_list"] },
        { namespace: "tools/audio", toolNames: ["tools_audio_asr", "tools_audio_tts"] },
        { namespace: "tools/image", toolNames: ["tools_image_generation"] },
        { namespace: "tools/web", toolNames: ["tools_web_search", "tools_web_reader"] },
        { namespace: "tools/video", toolNames: ["tools_video_generation"] },
        { namespace: "tools/jev", toolNames: ["tools_jev"] }
      ]
    );
    assert.equal(payload.tools.some((tool) => tool.name === "tools_audio_tts"), true);
  });

  it("requires a registered Portal user before returning documentation", async () => {
    await assert.rejects(
      () => dispatchMcpHandbookRoutes(context(), {
        async resolveCurrentUser() {
          throw Object.assign(new Error("portal_auth_required"), { status: 401 });
        }
      }, "mcp/handbook"),
      (error) => error.status === 401 && error.message === "portal_auth_required"
    );
  });

  it("ignores unrelated routes and non-GET requests", async () => {
    const services = { resolveCurrentUser() { throw new Error("should_not_run"); } };
    assert.equal(await dispatchMcpHandbookRoutes(context(), services, "mcp/other"), undefined);
    assert.equal(await dispatchMcpHandbookRoutes(context("POST"), services, "mcp/handbook"), undefined);
  });
});
