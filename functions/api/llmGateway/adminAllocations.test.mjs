import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLlmGatewayAdminAllocationsApi } from "./adminAllocations.ts";

const adminUser = {
  id: "admin-1",
  name: "Ada",
  email: "ada@example.com",
  team: "AI Adoption",
  role: "admin",
  identity: {
    provider: "microsoft_entra_id",
    objectId: "oid-1",
    tenantId: "tenant-1"
  }
};

function makeDeps(overrides = {}) {
  return {
    async adminJson() {
      return {};
    },
    baseUrl() {
      return "https://llm.example.com";
    },
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    json(body, init = {}) {
      return new Response(JSON.stringify(body), init);
    },
    optionalText(value, maxLength) {
      return String(value ?? "").trim().slice(0, maxLength);
    },
    async readBody(request) {
      return request.headers.get("content-type")?.includes("json") ? request.json() : {};
    },
    async requireAdminPortalUser() {
      return adminUser;
    },
    requireText(value, errorCode, maxLength) {
      const text = String(value ?? "").trim();
      if (!text) {
        throw Object.assign(new Error(errorCode), { status: 400 });
      }
      return text.slice(0, maxLength);
    },
    ...overrides
  };
}

describe("llm gateway admin allocations service", () => {
  it("maps LiteLLM users and keys into allocation data", async () => {
    const calls = [];
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });

        if (gatewayPath.startsWith("/user/list")) {
          return {
            users: [{
              user_id: "ada@example.com",
              max_budget: 100,
              models: ["tencent-hy3-preview"],
              rpm_limit: 60,
              tpm_limit: 120000
            }]
          };
        }

        if (gatewayPath.startsWith("/key/list")) {
          return {
            keys: [{
              token: "hash-1",
              key_alias: "Portal",
              user_id: "ada@example.com"
            }]
          };
        }

        if (gatewayPath.startsWith("/spend/logs")) {
          return [];
        }

        return { data: [] };
      }
    }));

    const response = await api.getAdminAllocations({
      request: new Request("https://portal.test/api/llm-gateway/admin/allocations"),
      env: {}
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("server-timing"), /^auth;dur=\d+, data;dur=\d+, total;dur=\d+$/);
    assert.equal(body.source.provider, "litellm");
    assert.equal(body.source.mode, "admin-api");
    assert.equal(body.gatewayUrl, "https://llm.example.com");
    assert.equal(body.tokens[0].id, "hash-1");
    assert.equal(body.userLimits[0].userId, "ada@example.com");
    assert.equal(body.userLimits[0].monthlyBudgetUsd, 100);
    assert.deepEqual(body.userLimits[0].allowedModels, ["tencent-hy3-preview"]);
    assert.deepEqual(body.usage, []);
    assert.equal(body.policies, undefined);
    assert.equal(body.overrides, undefined);
    assert.deepEqual(calls.map((call) => call.gatewayPath), [
      "/key/list?return_full_object=true&size=100",
      "/user/list?page=1&page_size=100",
      "/v1/model/info"
    ]);
  });

  it("does not allow legacy clients to re-enable the monthly spend query", async () => {
    const calls = [];
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        calls.push(gatewayPath);
        if (gatewayPath.startsWith("/key/list")) return { keys: [] };
        if (gatewayPath.startsWith("/user/list")) return { users: [] };
        return { data: [] };
      }
    }));

    const response = await api.getAdminAllocations({
      request: new Request("https://portal.test/api/llm-gateway/admin/allocations?includeUsage=true"),
      env: {}
    });
    const body = await response.json();

    assert.deepEqual(body.usage, []);
    assert.equal(body.source.endpoints.some((endpoint) => endpoint.startsWith("/spend/logs")), false);
    assert.deepEqual(calls, [
      "/key/list?return_full_object=true&size=100",
      "/user/list?page=1&page_size=100",
      "/v1/model/info"
    ]);
  });

  it("propagates LiteLLM inventory failures instead of returning partial data", async () => {
    const upstreamError = Object.assign(new Error("litellm_inventory_unavailable"), { status: 502 });
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, gatewayPath) {
        if (gatewayPath.startsWith("/key/list")) {
          throw upstreamError;
        }
        if (gatewayPath.startsWith("/user/list")) {
          return { users: [] };
        }
        return { data: [] };
      }
    }));

    await assert.rejects(
      () => api.getAdminAllocations({
        request: new Request("https://portal.test/api/llm-gateway/admin/allocations"),
        env: {}
      }),
      (error) => error === upstreamError
    );
  });

  it("updates a manual user allocation and synchronizes existing token budgets", async () => {
    const calls = [];
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          return { user_id: "ada@example.com", max_budget: 10, models: [] };
        }
        if (gatewayPath === "/user/update") {
          return {
            user_id: init.body.user_id,
            max_budget: init.body.max_budget,
            models: init.body.models,
            rpm_limit: init.body.rpm_limit,
            tpm_limit: init.body.tpm_limit
          };
        }
        if (gatewayPath.startsWith("/key/list")) {
          return {
            keys: [{
              token: "hash-half",
              user_id: "ada@example.com",
              max_budget: 5,
              metadata: {
                trace: "keep-token-metadata",
                workspace: { monthlyBudgetPercent: 50 }
              }
            }]
          };
        }
        if (gatewayPath === "/key/update") {
          return init.body;
        }
        return {};
      }
    }));

    const response = await api.upsertAdminUserLimit({
      request: new Request("https://portal.test/api/llm-gateway/admin/allocations/user-limits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetType: "user",
          targetId: "Ada@Example.com",
          allowedModels: ["tencent-hy3-preview", "aws-claude-opus-4.7"],
          monthlyBudgetUsd: 88,
          requestLimitPerMinute: 50,
          tokensPerMinute: 100000
        })
      }),
      env: {}
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(calls[0].gatewayPath, "/user/info?user_id=ada%40example.com");
    assert.equal(calls[1].gatewayPath, "/user/update");
    assert.equal(calls[1].init.body.user_id, "ada@example.com");
    assert.equal(calls[1].init.body.max_budget, 88);
    assert.deepEqual(calls[1].init.body.models, ["tencent-hy3-preview", "aws-claude-opus-4.7"]);
    assert.equal(calls[1].init.body.rpm_limit, 50);
    assert.equal(calls[1].init.body.tpm_limit, 100000);
    assert.equal(calls[1].init.body.budget_duration, "30d");
    assert.equal(calls[1].init.body.metadata.workspace.allocationUpdatedVia, "workspace-portal");
    assert.equal(calls[1].init.body.metadata.workspace.budgetManagedBy, "admin");
    assert.equal(calls[1].init.body.metadata.workspace.manualMonthlyBudgetUsd, 88);
    assert.equal(calls[1].init.body.metadata.workspace.rateLimitRepairVersion, 2);
    assert.equal(calls[2].gatewayPath, "/key/list?user_id=ada%40example.com&return_full_object=true&size=100");
    assert.equal(calls[3].gatewayPath, "/key/update");
    assert.equal(calls[3].init.body.key, "hash-half");
    assert.equal(calls[3].init.body.max_budget, 44);
    assert.equal(calls[3].init.body.tpm_limit, 2_000_000);
    assert.equal(calls[3].init.body.metadata.trace, "keep-token-metadata");
    assert.equal(calls[3].init.body.metadata.workspace.monthlyBudgetPercent, 50);
    assert.equal(calls[3].init.body.metadata.workspace.rateLimitRepairVersion, 2);
    assert.equal(body.userId, "ada@example.com");
    assert.equal(body.monthlyBudgetUsd, 88);
  });

  it("falls back to global defaults for blank or zero user rate limits", async () => {
    const calls = [];
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          return { user_id: "ada@example.com", max_budget: 100, models: ["gpt-5.5"] };
        }
        if (gatewayPath === "/user/update") {
          return init.body;
        }
        if (gatewayPath.startsWith("/key/list")) {
          return { keys: [] };
        }
        return {};
      }
    }));

    const response = await api.upsertAdminUserLimit({
      request: new Request("https://portal.test/api/llm-gateway/admin/allocations/user-limits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetType: "user",
          targetId: "ada@example.com",
          monthlyBudgetUsd: 100,
          requestLimitPerMinute: 0,
          tokensPerMinute: null
        })
      }),
      env: {}
    });

    assert.equal(response.status, 200);
    const updateBody = calls.find((call) => call.gatewayPath === "/user/update").init.body;
    assert.equal(updateBody.rpm_limit, 60);
    assert.equal(updateBody.tpm_limit, 2_000_000);
  });

  it("creates a manually managed user with the requested budget before the follow-up update", async () => {
    const calls = [];
    const updateError = Object.assign(new Error("update_failed"), { status: 502 });
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        if (gatewayPath.startsWith("/user/info")) {
          throw Object.assign(new Error("not_found"), { status: 404 });
        }
        if (gatewayPath === "/user/new") {
          return { user_info: init.body };
        }
        if (gatewayPath === "/user/update") {
          throw updateError;
        }
        return {};
      }
    }));

    await assert.rejects(
      () => api.upsertAdminUserLimit({
        request: new Request("https://portal.test/api/llm-gateway/admin/allocations/user-limits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetType: "user",
            targetId: "new@example.com",
            monthlyBudgetUsd: 72
          })
        }),
        env: {}
      }),
      (error) => error === updateError
    );

    const createUserCall = calls.find((call) => call.gatewayPath === "/user/new");
    assert.equal(createUserCall.init.body.max_budget, 72);
    assert.equal(createUserCall.init.body.rpm_limit, 60);
    assert.equal(createUserCall.init.body.tpm_limit, 2_000_000);
    assert.equal(createUserCall.init.body.budget_duration, "30d");
    assert.equal(createUserCall.init.body.metadata.workspace.budgetManagedBy, "admin");
    assert.equal(createUserCall.init.body.metadata.workspace.manualMonthlyBudgetUsd, 72);
    assert.equal(createUserCall.init.body.metadata.workspace.rateLimitRepairVersion, 2);
  });

  it("rejects an empty or zero manual user budget so admin changes cannot remove the cap", async () => {
    const calls = [];
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        return {};
      }
    }));

    for (const monthlyBudgetUsd of [undefined, 0, "not-a-number"]) {
      await assert.rejects(
        () => api.upsertAdminUserLimit({
          request: new Request("https://portal.test/api/llm-gateway/admin/allocations/user-limits", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              targetType: "user",
              targetId: "ada@example.com",
              ...(monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd })
            })
          }),
          env: {}
        }),
        (error) => error.status === 400 && error.message === "invalid_monthly_budget_usd"
      );
    }

    assert.equal(calls.length, 0);
  });

  it("only writes LiteLLM limits for user targets", async () => {
    const api = createLlmGatewayAdminAllocationsApi(makeDeps());

    await assert.rejects(
      () => api.upsertAdminUserLimit({
        request: new Request("https://portal.test/api/llm-gateway/admin/allocations/user-limits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetType: "team",
            targetId: "AI Adoption"
          })
        }),
        env: {}
      }),
      (error) => error.status === 400 && error.message === "litellm_user_allocation_only"
    );
  });

  it("manages tokens directly through LiteLLM admin endpoints", async () => {
    const calls = [];
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        return { ok: true };
      }
    }));
    const context = (request) => ({ request, env: {} });

    await api.updateAdminToken(context(new Request("https://portal.test/api/llm-gateway/admin/tokens/hash-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Production key",
        allowedModels: ["gpt-5.5"],
        monthlyBudgetUsd: 25,
        requestLimitPerMinute: 40,
        tokensPerMinute: 80000
      })
    })), "hash-1");
    await api.suspendAdminToken(context(new Request("https://portal.test")), "hash-1");
    await api.activateAdminToken(context(new Request("https://portal.test")), "hash-1");
    await api.deleteAdminToken(context(new Request("https://portal.test")), "hash-1");

    assert.deepEqual(calls.map((call) => call.gatewayPath), ["/key/update", "/key/block", "/key/unblock", "/key/delete"]);
    assert.deepEqual(calls[0].init.body, {
      key: "hash-1",
      key_alias: "Production key",
      models: ["gpt-5.5"],
      max_budget: 25,
      rpm_limit: 40,
      tpm_limit: 80000
    });
    assert.deepEqual(calls[1].init.body, { key: "hash-1" });
    assert.deepEqual(calls[2].init.body, { key: "hash-1" });
    assert.deepEqual(calls[3].init.body, { keys: ["hash-1"], reason: "admin_revoke" });
  });

  it("passes null token rate limits through to LiteLLM so existing zero limits are cleared", async () => {
    const calls = [];
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, gatewayPath, init = {}) {
        calls.push({ gatewayPath, init });
        return { ok: true };
      }
    }));

    const response = await api.updateAdminToken({
      request: new Request("https://portal.test/api/llm-gateway/admin/tokens/hash-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestLimitPerMinute: null,
          tokensPerMinute: null
        })
      }),
      env: {}
    }, "hash-1");

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{
      gatewayPath: "/key/update",
      init: {
        method: "POST",
        body: {
          key: "hash-1",
          rpm_limit: null,
          tpm_limit: null
        }
      }
    }]);
  });
});

describe("complete admin inventory", () => {
  it("loads every key and user page and removes repeated entries", async () => {
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, path) {
        const page = Number(new URL(path, "https://gateway.test").searchParams.get("page") || 1);
        if (path.startsWith("/key/list")) return { total_pages: 2, keys: page === 1 ? [{ token: "key-1", key_alias: "First" }] : [{ token: "key-1" }, { token: "key-2", key_alias: "Second" }] };
        if (path.startsWith("/user/list")) return { total_pages: 2, users: [{ user_id: `user-${page}@example.test`, max_budget: 10 }] };
        return { data: [] };
      }
    }));
    const response = await api.getAdminAllocations({ request: new Request("https://portal.test/api/llm-gateway/admin/allocations"), env: {} });
    const body = await response.json();
    assert.deepEqual(body.tokens.map((row) => row.id), ["key-1", "key-2"]);
    assert.deepEqual(body.userLimits.map((row) => row.userId), ["user-1@example.test", "user-2@example.test"]);
    assert.equal(body.source.endpoints.length, 5);
  });

  it("fails instead of presenting a repeating inventory page as complete", async () => {
    const api = createLlmGatewayAdminAllocationsApi(makeDeps({
      async adminJson(_context, path) {
        if (path.startsWith("/key/list")) return { has_more: true, keys: [{ token: "key-1" }] };
        return { users: [], data: [] };
      }
    }));
    await assert.rejects(api.getAdminAllocations({ request: new Request("https://portal.test/api/llm-gateway/admin/allocations"), env: {} }), { message: "litellm_keys_list_truncated", status: 502 });
  });
});

it("rejects missing inventory collections instead of showing an empty registry", async () => {
  const api = createLlmGatewayAdminAllocationsApi(makeDeps({
    async adminJson(_context, path) { return path.startsWith("/user/list") ? { users: [] } : {}; }
  }));
  await assert.rejects(api.getAdminAllocations({ request: new Request("https://portal.test/api/llm-gateway/admin/allocations"), env: {} }), { message: "litellm_keys_list_invalid_payload", status: 502 });
});
