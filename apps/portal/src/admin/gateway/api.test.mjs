import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadApi() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-portal-admin-api-"));
  const outfile = join(outdir, "api.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./api.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function response(json, status = 200) {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

describe("Admin Gateway API contract", () => {
  it("accepts only paired LiteLLM allocation and usage sources", async () => {
    const { loadAdminGatewayData } = await loadApi();
    const calls = [];
    const fetcher = async (input) => {
      calls.push(String(input));
      if (String(input).includes("allocations")) {
        return response({ source: { provider: "litellm" }, tokens: [], userLimits: [], usage: [], modelOptions: [] });
      }
      return response({ source: { provider: "litellm" }, usage: [], requests: [], requestTotal: 0, series: [], tokens: [] });
    };

    const data = await loadAdminGatewayData({ fetcher, from: "2026-07-01", to: "2026-07-12", groupBy: "model" });

    assert.equal(data.allocations.source.provider, "litellm");
    assert.equal(data.usage.source.provider, "litellm");
    assert.deepEqual(calls, [
      "/api/llm-gateway/admin/allocations",
      "/api/llm-gateway/admin/usage?from=2026-07-01&to=2026-07-12&groupBy=model"
    ]);
  });

  it("rejects legacy or anonymous statistic sources", async () => {
    const { loadAdminGatewayData } = await loadApi();
    const fetcher = async (input) => response(String(input).includes("allocations")
      ? { source: { provider: "portal-db" } }
      : { source: { provider: "litellm" } });

    await assert.rejects(
      () => loadAdminGatewayData({ fetcher, from: "2026-07-01", to: "2026-07-12", groupBy: "model" }),
      /admin_gateway_source_not_litellm/
    );
  });

  it("loads first-render inventory and usage independently", async () => {
    const { loadAdminGatewayAllocations, loadAdminGatewayUsage } = await loadApi();
    const calls = [];
    const fetcher = async (input) => {
      calls.push(String(input));
      return response(String(input).includes("allocations")
        ? { source: { provider: "litellm" }, tokens: [], userLimits: [], usage: [], modelOptions: [] }
        : { source: { provider: "litellm" }, usage: [], requests: [], requestTotal: 0, series: [], tokens: [] });
    };

    await loadAdminGatewayAllocations({ fetcher });
    await loadAdminGatewayUsage({ fetcher, from: "2026-07-01", to: "2026-07-12", groupBy: "token" });

    assert.deepEqual(calls, [
      "/api/llm-gateway/admin/allocations",
      "/api/llm-gateway/admin/usage?from=2026-07-01&to=2026-07-12&groupBy=token"
    ]);
  });

  it("writes token controls to the dedicated admin endpoint", async () => {
    const { updateAdminGatewayToken } = await loadApi();
    const calls = [];
    const fetcher = async (input, init) => {
      calls.push({ input: String(input), init });
      return response({ ok: true });
    };

    await updateAdminGatewayToken("hash/1", {
      name: "Production",
      monthlyBudgetUsd: "25",
      requestLimitPerMinute: "60",
      tokensPerMinute: "120000",
      allowedModels: "gpt-5.5\ngpt-5.4"
    }, fetcher);

    assert.equal(calls[0].input, "/api/llm-gateway/admin/tokens/hash%2F1");
    assert.equal(calls[0].init.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      name: "Production",
      monthlyBudgetUsd: 25,
      requestLimitPerMinute: 60,
      tokensPerMinute: 120000,
      allowedModels: ["gpt-5.5", "gpt-5.4"]
    });
  });

  it("clears empty token limits with null and omits empty user limits", async () => {
    const { updateAdminGatewayToken, updateAdminGatewayUserLimit } = await loadApi();
    const calls = [];
    const fetcher = async (input, init) => {
      calls.push({ input: String(input), init });
      return response({ ok: true });
    };

    await updateAdminGatewayToken("hash-1", {
      name: "Production",
      monthlyBudgetUsd: "25",
      requestLimitPerMinute: "",
      tokensPerMinute: "0",
      allowedModels: "gpt-5.5"
    }, fetcher);
    await updateAdminGatewayUserLimit("ada@example.com", {
      monthlyBudgetUsd: "100",
      requestLimitPerMinute: "",
      tokensPerMinute: "0",
      allowedModels: "gpt-5.5"
    }, fetcher);

    assert.deepEqual(JSON.parse(calls[0].init.body), {
      name: "Production",
      monthlyBudgetUsd: 25,
      requestLimitPerMinute: null,
      tokensPerMinute: null,
      allowedModels: ["gpt-5.5"]
    });
    const userBody = JSON.parse(calls[1].init.body);
    assert.deepEqual(userBody, {
      targetType: "user",
      targetId: "ada@example.com",
      monthlyBudgetUsd: 100,
      allowedModels: ["gpt-5.5"]
    });
    assert.equal("requestLimitPerMinute" in userBody, false);
    assert.equal("tokensPerMinute" in userBody, false);
  });
});
