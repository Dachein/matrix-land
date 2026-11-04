import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let modulePromise;
const originalFetch = globalThis.fetch;

async function loadModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-litellm-client-test-"));
  const outfile = join(outdir, "client.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./client.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function clientModule() {
  modulePromise ??= loadModule();
  return modulePromise;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const env = {
  LITELLM_PROVISIONING_KEY: "sk-provisioning",
  LITELLM_URL: "https://token.example.test/"
};

const principal = {
  email: "Owner@Example.Invalid",
  orgId: "org-1",
  orgSlug: "workspace",
  scopes: ["apps:apps:write"],
  sub: "user-1"
};

describe("APPS LiteLLM client", () => {
  it("lists models from LiteLLM model info with the provisioning key", async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ init, url: String(url) });
      return jsonResponse({
        data: [
          {
            litellm_params: {
              custom_llm_provider: "bedrock",
              model: "bedrock/anthropic.claude-sonnet-5"
            },
            model_info: {
              display_name: "Claude Sonnet 5",
              max_input_tokens: 200000,
              mode: "chat",
              supports_function_calling: true
            },
            model_name: "claude-sonnet-5"
          },
          {
            blocked: true,
            model_info: { mode: "chat" },
            model_name: "hidden-model"
          }
        ]
      });
    };

    const { listLlmModels } = await clientModule();
    const catalog = await listLlmModels(env);

    assert.equal(requests[0].url, "https://token.example.test/v1/model/info");
    assert.equal(requests[0].init.headers.Authorization, "Bearer sk-provisioning");
    assert.equal(catalog.source, "litellm");
    assert.deepEqual(catalog.endpoints, ["/v1/chat/completions"]);
    assert.deepEqual(catalog.models.map((model) => model.id), ["claude-sonnet-5"]);
    assert.equal(catalog.models[0].displayName, "Claude Sonnet 5");
    assert.equal(catalog.models[0].provider, "bedrock");
    assert.equal(catalog.models[0].contextWindow, 200000);
    assert.ok(catalog.models[0].capabilities.includes("tool_calling"));
  });

  it("creates the LiteLLM user on first app key issue and generates a user-bound virtual key", async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const request = {
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        init,
        url: String(url)
      };
      requests.push(request);

      if (request.url === "https://token.example.test/user/info?user_id=owner%40example.invalid") {
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }

      if (request.url === "https://token.example.test/user/new") {
        return jsonResponse({
          user_info: {
            budget_duration: "30d",
            models: ["deepseek-v4-pro", "claude-sonnet-5"],
            user_id: "owner@example.invalid"
          }
        });
      }

      if (request.url === "https://token.example.test/key/generate") {
        return jsonResponse({
          key: "sk-generated-app-key",
          key_alias: request.body.key_alias,
          user_id: request.body.user_id
        });
      }

      return new Response("unexpected request", { status: 500 });
    };

    const { issueLlmAppToken } = await clientModule();
    const result = await issueLlmAppToken(env, principal, {
      appCode: "portfolio-agent",
      appId: "app-1",
      appName: "Portfolio Agent"
    });

    assert.equal(result.token, "sk-generated-app-key");
    assert.deepEqual(requests.map((request) => request.url), [
      "https://token.example.test/user/info?user_id=owner%40example.invalid",
      "https://token.example.test/user/new",
      "https://token.example.test/key/generate"
    ]);
    assert.equal(requests[1].body.user_id, "owner@example.invalid");
    assert.equal(requests[1].body.user_email, "Owner@Example.Invalid");
    assert.equal(requests[1].body.max_budget, 10);
    assert.equal(requests[1].body.budget_duration, "30d");
    assert.equal(requests[1].body.rpm_limit, 60);
    assert.equal(requests[1].body.tpm_limit, 2_000_000);
    assert.equal(requests[1].body.metadata.workspace.journeyLevelKey, "newcomer");
    assert.equal(requests[1].body.metadata.workspace.baseMonthlyBudgetUsd, 10);
    assert.equal(requests[1].body.metadata.workspace.budgetManagedBy, "journey-level");
    assert.equal(requests[2].body.user_id, "owner@example.invalid");
    assert.equal(requests[2].body.max_budget, 10);
    assert.equal(requests[2].body.metadata.workspace.monthlyBudgetPercent, 100);
    assert.deepEqual(requests[2].body.models, ["deepseek-v4-pro", "claude-sonnet-5"]);
    assert.equal(requests[2].body.key_alias, "Portfolio Agent LLM App Key");
    assert.equal(requests[2].body.rpm_limit, 60);
    assert.equal(requests[2].body.tpm_limit, 2_000_000);
    assert.equal(requests[2].body.metadata.workspace.appId, "app-1");
    assert.equal(requests[2].init.headers.Authorization, "Bearer sk-provisioning");
  });

  it("repairs only invalid user rate limits while preserving positive custom limits and budget metadata", async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const request = {
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        init,
        url: String(url)
      };
      requests.push(request);

      if (request.url === "https://token.example.test/user/info?user_id=owner%40example.invalid") {
        return jsonResponse({
          user_info: {
            budget_duration: "90d",
            max_budget: 75,
            metadata: {
              workspace: {
                budgetManagedBy: "admin-allocation",
                allocationId: "allocation-1"
              }
            },
            models: ["claude-sonnet-5"],
            rpm_limit: 23,
            tpm_limit: "invalid",
            user_id: "owner@example.invalid"
          }
        });
      }

      if (request.url === "https://token.example.test/user/update") {
        return jsonResponse({ user_info: { tpm_limit: request.body.tpm_limit } });
      }

      if (request.url === "https://token.example.test/key/generate") {
        return jsonResponse({ key: "sk-repaired-user-app-key" });
      }

      return new Response("unexpected request", { status: 500 });
    };

    const { issueLlmAppToken } = await clientModule();
    const result = await issueLlmAppToken(env, principal, {
      appCode: "portfolio-agent",
      appId: "app-1",
      appName: "Portfolio Agent"
    });

    assert.equal(result.token, "sk-repaired-user-app-key");
    assert.deepEqual(requests.map((request) => request.url), [
      "https://token.example.test/user/info?user_id=owner%40example.invalid",
      "https://token.example.test/user/update",
      "https://token.example.test/key/generate"
    ]);
    assert.deepEqual(requests[1].body, {
      metadata: {
        workspace: {
          allocationId: "allocation-1",
          budgetManagedBy: "admin-allocation",
          rateLimitRepairVersion: 2
        }
      },
      tpm_limit: 2_000_000,
      user_id: "owner@example.invalid"
    });
    assert.equal(requests[2].body.max_budget, 75);
    assert.deepEqual(requests[2].body.models, ["claude-sonnet-5"]);
    assert.equal(requests[2].body.rpm_limit, 60);
    assert.equal(requests[2].body.tpm_limit, 2_000_000);
  });

  it("requires a LiteLLM provisioning key before issuing app keys", async () => {
    const { issueLlmAppToken } = await clientModule();

    await assert.rejects(
      () => issueLlmAppToken({ LITELLM_URL: "https://token.example.test" }, principal, {
        appCode: "demo",
        appId: "app-1",
        appName: "Demo"
      }),
      (error) => error.status === 503 && error.code === "litellm_provisioning_key_not_configured"
    );
  });

  it("revokes an App key by its LiteLLM token hash", async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ body: JSON.parse(String(init.body)), url: String(url) });
      return jsonResponse({ deleted_keys: 1 });
    };

    const { revokeLlmAppToken } = await clientModule();
    const result = await revokeLlmAppToken(env, "sk-app-key", "apps_app_delete");

    assert.equal(requests[0].url, "https://token.example.test/key/delete");
    assert.deepEqual(requests[0].body, {
      keys: [result.tokenId],
      reason: "apps_app_delete"
    });
    assert.match(result.tokenId, /^[a-f0-9]{64}$/);
    assert.equal(result.revoked, true);
  });
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
