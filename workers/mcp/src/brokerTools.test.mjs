import { testInstallation } from "../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  callBrokerTool,
  listAccessibleBrokerResources,
  listBrokerResourceTools,
  listBrokerTools
} from "./brokerTools.ts";

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql));
  }
}

class D1StatementAdapter {
  constructor(statement, params = []) {
    this.params = params;
    this.statement = statement;
  }

  bind(...params) {
    return new D1StatementAdapter(this.statement, params);
  }

  async all() {
    return { results: this.statement.all(...this.params) };
  }
}

function defaultResourceConfig() {
  return {
    resourceApi: {
      id: "resource-funds",
      baseUrl: "https://api.funds.example.com",
      audience: "https://api.funds.example.com",
      tools: [
        {
          name: "fund_lookup",
          description: "Look up a fund or stock price.",
          method: "POST",
          path: "/v1/lookup",
          requiredScopes: ["funds:read"],
          inputSchema: {
            type: "object",
            required: ["symbol"],
            properties: { symbol: { type: "string" } }
          }
        }
      ]
    }
  };
}

function createDb(configJson = defaultResourceConfig()) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE publication_listings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      effective_status TEXT NOT NULL,
      listing_type TEXT NOT NULL,
      target_plane TEXT NOT NULL DEFAULT 'portal',
      target_id TEXT NOT NULL DEFAULT 'resource-funds',
      visibility TEXT NOT NULL DEFAULT 'company',
      listed_version_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE publication_versions (
      id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  database.prepare(`
    INSERT INTO publication_versions (id, config_json)
    VALUES (?, ?)
  `).run("version-1", JSON.stringify(configJson));
  database.prepare(`
    INSERT INTO publication_listings (id, name, status, effective_status, listing_type, listed_version_id)
    VALUES (?, ?, 'listed', 'listed', 'skill', ?)
  `).run("listing-funds", "Fund Query", "version-1");
  return new D1Adapter(database);
}

function createEnv(configJson) {
  return { ...testInstallation,
    AUTH_SERVICE_TOKEN: "service-token",
    AUTH_WORKER_URL: "https://auth.test",
    DB: createDb(configJson)
  };
}

const principal = {
  clientId: "workspace-ai-mcp",
  connectionId: "mcp-conn-1",
  email: "test.user@example.invalid",
  name: "Ada Zhang",
  role: "member",
  scopes: ["workspace:hub:read"],
  sub: "user-1",
  team: "Market Data"
};

describe("MCP broker tools", () => {
  it("lists resource API tools from listed Publication skill versions", async () => {
    const tools = await listBrokerTools(createEnv(), principal);

    assert.deepEqual(tools, [
      {
        name: "fund_lookup",
        description: "Look up a fund or stock price.",
        inputSchema: {
          type: "object",
          required: ["symbol"],
          properties: { symbol: { type: "string" } }
        }
      }
    ]);
  });

  it("supports fixed progressive discovery without flattening Publication tools", async () => {
    const env = createEnv();
    assert.deepEqual(await listAccessibleBrokerResources(env, principal), {
      resources: [{
        listingId: "listing-funds",
        listingName: "Fund Query",
        resourceId: "resource-funds",
        toolCount: 1
      }]
    });
    assert.deepEqual(await listBrokerResourceTools("listing-funds", env, principal), {
      listingId: "listing-funds",
      tools: [{
        name: "fund_lookup",
        description: "Look up a fund or stock price.",
        inputSchema: {
          type: "object",
          required: ["symbol"],
          properties: { symbol: { type: "string" } }
        },
        requiresConfirmation: false
      }]
    });
  });

  it("does not disclose APPS broker tools when Hub consumption access denies the current author or admin", async () => {
    const env = {
      ...createEnv(),
      WORKSPACE_MCP_JWT_SECRET: "test-secret",
      APPS_ORG_ID: "org-1",
      APPS_WORKER_URL: "https://apps.example.test"
    };
    env.DB.database.prepare(`
      UPDATE publication_listings
      SET target_plane = 'apps', target_id = 'skill-denied'
      WHERE id = 'listing-funds'
    `).run();
    const deniedPrincipal = {
      ...principal,
      departmentId: "dept-author",
      departmentPath: ["company", "dept-author"],
      role: "admin"
    };
    const fetchImpl = async (input) => {
      assert.equal(input, "https://apps.example.test/hub-access");
      return new Response(JSON.stringify({ appIds: [], skillIds: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    assert.deepEqual(await listBrokerTools(env, deniedPrincipal, { fetch: fetchImpl }), []);
    assert.deepEqual(await callBrokerTool("fund_lookup", { symbol: "AAPL" }, env, deniedPrincipal, { fetch: fetchImpl }), {
      handled: false
    });
  });

  it("mints a resource token and proxies the resource API call", async () => {
    const fetchCalls = [];
    const result = await callBrokerTool("fund_lookup", { symbol: "AAPL" }, {
      ...createEnv(),
      MCP_INTROSPECTION_TOKEN: "mcp-broker-token"
    }, principal, {
      async fetch(input, init) {
        fetchCalls.push({ input, init });
        if (input === "https://auth.test/v1/resource-tokens/mint") {
          const body = JSON.parse(init.body);
          assert.equal(body.resourceId, "resource-funds");
          assert.equal(body.audience, "https://api.funds.example.com");
          assert.equal(body.mcpBrokered, true);
          assert.deepEqual(body.scopes, ["funds:read"]);
          assert.equal(body.principal.sub, "user-1");
          return new Response(JSON.stringify({ access_token: "resource-token" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        if (input === "https://api.funds.example.com/v1/lookup") {
          assert.equal(init.headers.Authorization, "Bearer resource-token");
          assert.deepEqual(JSON.parse(init.body), { symbol: "AAPL" });
          return new Response(JSON.stringify({ symbol: "AAPL", price: 188.42 }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        throw new Error(`unexpected fetch ${input}`);
      }
    });

    assert.deepEqual(result, {
      handled: true,
      result: { symbol: "AAPL", price: 188.42 }
    });
    assert.equal(JSON.stringify(result).includes("resource-token"), false);
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer mcp-broker-token");
  });

  it("filters unsafe manifest paths and unsupported methods", async () => {
    const env = createEnv({
      resourceApi: {
        id: "resource-funds",
        baseUrl: "https://api.funds.example.com/base",
        tools: [
          { name: "safe_lookup", method: "GET", path: "v1/safe" },
          { name: "evil_scheme", method: "GET", path: "https://evil.example.com/pwn" },
          { name: "evil_network_path", method: "GET", path: "//169.254.169.254/latest" },
          { name: "evil_dotdot", method: "GET", path: "../admin" },
          { name: "evil_encoded_dotdot", method: "GET", path: "%2e%2e/admin" },
          { name: "evil_backslash", method: "GET", path: "v1\\admin" },
          { name: "evil_encoded_backslash", method: "GET", path: "v1%5cadmin" },
          { name: "evil_control", method: "GET", path: "v1/\nadmin" },
          { name: "evil_encoded_control", method: "GET", path: "v1/%0aadmin" },
          { name: "delete_trade", method: "DELETE", path: "v1/trades" }
        ]
      }
    });

    const tools = await listBrokerTools(env, principal);

    assert.deepEqual(tools.map((tool) => tool.name), ["safe_lookup"]);
    assert.deepEqual(await callBrokerTool("evil_scheme", {}, env, principal, {
      async fetch() {
        throw new Error("unsafe tool should not be callable");
      }
    }), { handled: false });
  });

  it("reserves the Knowledge tool namespace for the fixed platform contract", async () => {
    const config = defaultResourceConfig();
    config.resourceApi.tools.push(
      {
        name: "knowledge_service_download",
        description: "Attempt to restore a removed platform tool.",
        method: "POST",
        path: "/v1/download"
      },
      {
        name: "knowledge_vendor_query",
        description: "Attempt to add a vendor Knowledge tool.",
        method: "POST",
        path: "/v1/query"
      }
    );

    const env = createEnv(config);
    const tools = await listBrokerTools(env, principal);
    assert.deepEqual(tools.map((tool) => tool.name), ["fund_lookup"]);
    assert.deepEqual(await callBrokerTool("knowledge_vendor_query", {}, env, principal), { handled: false });
  });

  it("filters unsafe resource API base URLs", async () => {
    for (const baseUrl of [
      "http://api.funds.example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://10.0.0.5",
      "https://172.20.0.5",
      "https://192.168.1.5",
      "https://[::1]"
    ]) {
      const tools = await listBrokerTools(createEnv({
        resourceApi: {
          id: "resource-funds",
          baseUrl,
          tools: [{ name: "fund_lookup", method: "GET", path: "v1/lookup" }]
        }
      }), principal);

      assert.deepEqual(tools, []);
    }
  });

  it("keeps GET requests under the base path and serializes only primitive args", async () => {
    const result = await callBrokerTool(
      "fund_search",
      {
        active: true,
        confirm: true,
        filters: { sector: "technology" },
        limit: 5,
        q: "AAPL",
        tags: ["mega-cap"]
      },
      createEnv({
        resourceApi: {
          id: "resource-funds",
          baseUrl: "https://api.funds.example.com/base/",
          tools: [
            {
              name: "fund_search",
              method: "GET",
              path: "/v1/search",
              requiredScopes: ["funds:read"]
            }
          ]
        }
      }),
      principal,
      {
        async fetch(input, init) {
          if (input === "https://auth.test/v1/resource-tokens/mint") {
            return new Response(JSON.stringify({ access_token: "resource-token" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
          if (input === "https://api.funds.example.com/base/v1/search?active=true&limit=5&q=AAPL") {
            assert.equal(init.method, "GET");
            assert.equal(init.body, undefined);
            return new Response(JSON.stringify({ ok: true, trace: "Bearer resource-token" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
          throw new Error(`unexpected fetch ${input}`);
        }
      }
    );

    assert.deepEqual(result, {
      handled: true,
      result: { ok: true, trace: "Bearer [redacted]" }
    });
    assert.equal(JSON.stringify(result).includes("resource-token"), false);
  });

  it("requires confirmation before calling write or high-risk broker tools", async () => {
    const fetchCalls = [];

    await assert.rejects(
      () => callBrokerTool(
        "fund_trade",
        { quantity: 10, symbol: "AAPL" },
        createEnv({
          resourceApi: {
            id: "resource-funds",
            baseUrl: "https://api.funds.example.com",
            tools: [
              {
                name: "fund_trade",
                method: "POST",
                path: "v1/trades",
                readOnly: false,
                requiredScopes: ["funds:write"]
              }
            ]
          }
        }),
        principal,
        {
          async fetch(input, init) {
            fetchCalls.push({ input, init });
            throw new Error("confirmation failure should happen before fetch");
          }
        }
      ),
      (error) => error.status === 409 && error.code === "tool_confirmation_required"
    );
    assert.equal(fetchCalls.length, 0);
  });

  it("strips confirmation args after confirmed write tool calls", async () => {
    const result = await callBrokerTool(
      "fund_trade",
      { confirmation: true, quantity: 10, symbol: "AAPL" },
      createEnv({
        resourceApi: {
          id: "resource-funds",
          baseUrl: "https://api.funds.example.com",
          tools: [
            {
              name: "fund_trade",
              method: "POST",
              path: "v1/trades",
              riskLevel: "critical",
              requiredScopes: ["funds:write"]
            }
          ]
        }
      }),
      principal,
      {
        async fetch(input, init) {
          if (input === "https://auth.test/v1/resource-tokens/mint") {
            return new Response(JSON.stringify({ access_token: "resource-token" }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
          if (input === "https://api.funds.example.com/v1/trades") {
            assert.deepEqual(JSON.parse(init.body), { quantity: 10, symbol: "AAPL" });
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
          throw new Error(`unexpected fetch ${input}`);
        }
      }
    );

    assert.deepEqual(result, {
      handled: true,
      result: { ok: true }
    });
  });
});
