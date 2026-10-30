import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveKnowledgeTask } from "./knowledgeExecutor.ts";
import { loadHandbookKnowledgeCatalog } from "./runtimeHandbook.ts";
import { resolveRuntimeCapabilityProfile } from "./profile.ts";

const principal = Object.freeze({
  callerKind: "user",
  orgId: "org-1",
  scopes: ["mate:invoke"],
  userId: "user-a"
});

describe("Knowledge Mate failure and recovery contract", () => {
  it("adds the scoped dynamic Handbook to fallback model requests without changing release documents", async () => {
    const calls = fixtureCalls(), value = definition();
    value.release.documents = [{ kind: "handbook", content: "Static operating guidance." }];
    const original = JSON.stringify(value.release);
    const result = await resolveKnowledgeTask(environment({ calls, knowledge: async request => {
      if (new URL(request.url).pathname === "/api/knowledge-services") return Response.json({ services: [
        { serviceId: "policies", name: "Policies", description: "KYC review policy." },
        { serviceId: "unselected", name: "Unselected", description: "Do not expose this metadata." }
      ] });
      return knowledgeSuccess(request);
    } }), value, principal, input());
    assert.equal(result.outcome, "completed");
    const body = await calls.model[0].json();
    assert.match(body.messages[0].content, /Static operating guidance/);
    assert.match(body.messages[0].content, /"name":"Policies","id":"policies","description":"KYC review policy\."/);
    assert.doesNotMatch(body.messages[0].content, /Do not expose this metadata/);
    assert.equal(JSON.stringify(value.release), original);
  });

  it("does not fetch a catalog without configured services and respects caller cancellation", async () => {
    const calls = fixtureCalls(), env = environment({ calls });
    const context = { user: { id: principal.userId } };
    env.KNOWLEDGE_WORKER_URL = "http://localhost:8798";
    assert.deepEqual(await loadHandbookKnowledgeCatalog(env, context, definition([])), { status: "available", services: [] });
    assert.equal(calls.knowledge.length, 0);
    const controller = new AbortController(); controller.abort();
    env.KNOWLEDGE_SERVICE.fetch = async request => { request.signal.throwIfAborted(); };
    await assert.rejects(loadHandbookKnowledgeCatalog(env, context, definition(), undefined, controller.signal), /mate_chat_request_aborted/);
  });

  it("turns Knowledge 5xx and malformed payloads into typed, non-leaking failed resolutions", async () => {
    for (const scenario of [
      {
        expectedCode: "knowledge_request_failed",
        knowledge: async () => Response.json({ privateDetail: "do-not-leak" }, { status: 503 })
      },
      {
        expectedCode: "knowledge_response_invalid",
        knowledge: async () => new Response("not-json", {
          headers: { "content-type": "text/plain" },
          status: 200
        })
      }
    ]) {
      const calls = fixtureCalls();
      const result = await resolveKnowledgeTask(
        environment({ calls, knowledge: scenario.knowledge }),
        definition(),
        principal,
        input()
      );

      assert.equal(result.outcome, "failed");
      assert.equal(result.errorCode, scenario.expectedCode);
      assert.deepEqual(result.artifacts, []);
      assert.equal(result.answer.includes("do-not-leak"), false);
      assert.deepEqual(calls.model, []);
    }
  });

  it("fails the whole resolution when one configured Knowledge service fails", async () => {
    const calls = fixtureCalls();
    const value = definition(["policies", "unavailable"]);
    const result = await resolveKnowledgeTask(
      environment({
        calls,
        knowledge: async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/api/knowledge-services") {
            return Response.json({ services: [
              { name: "Policies", serviceId: "policies" },
              { name: "Unavailable", serviceId: "unavailable" }
            ] });
          }
          if (url.pathname.includes("/unavailable/query")) {
            return Response.json({ error: "backend_down" }, { status: 503 });
          }
          return knowledgeSuccess(request);
        }
      }),
      value,
      principal,
      input()
    );

    assert.equal(result.outcome, "failed");
    assert.equal(result.errorCode, "knowledge_request_failed");
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(calls.model, []);
  });

  it("turns model 5xx, malformed JSON, and empty answers into typed failed resolutions", async () => {
    for (const scenario of [
      {
        expectedCode: "mate_model_request_failed",
        model: async () => Response.json({ privateDetail: "provider-secret" }, { status: 503 })
      },
      {
        expectedCode: "mate_model_response_invalid",
        model: async () => new Response("not-json", { status: 200 })
      },
      {
        expectedCode: "mate_model_response_invalid",
        model: async () => Response.json({ choices: [{ message: { content: "" } }] })
      }
    ]) {
      const calls = fixtureCalls();
      const result = await resolveKnowledgeTask(
        environment({ calls, model: scenario.model }),
        definition(),
        principal,
        input()
      );

      assert.equal(result.outcome, "failed");
      assert.equal(result.errorCode, scenario.expectedCode);
      assert.deepEqual(result.artifacts, []);
      assert.equal(result.answer.includes("provider-secret"), false);
      assert.equal(calls.model.length, 1);
    }
  });

  it("uses the cited extractive fallback when model credentials are deliberately absent", async () => {
    const calls = fixtureCalls();
    const result = await resolveKnowledgeTask(
      environment({ calls, modelKey: "" }),
      definition(),
      principal,
      input()
    );

    assert.equal(result.outcome, "completed");
    assert.equal(result.errorCode, undefined);
    assert.match(result.answer, /Annual review \[Policies · policies\/kyc\.md\]/);
    assert.deepEqual(result.artifacts, [{
      objectId: "policy-1",
      relativePath: "policies/kyc.md",
      serviceId: "policies",
      serviceName: "Policies",
      type: "knowledge_source"
    }]);
    assert.deepEqual(calls.model, []);
  });

  it("reads the current user's service handbook when strict search returns no valid result", async () => {
    const calls = fixtureCalls();
    const result = await resolveKnowledgeTask(
      environment({
        calls,
        knowledge: async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/api/knowledge-services") {
            return Response.json({ services: [{ name: "Policies", serviceId: "policies" }] });
          }
          if (url.pathname === "/api/knowledge-services/policies/query") {
            const body = await request.json();
            if (body.action === "search") return Response.json({ results: [] });
            assert.equal(body.action, "read");
            assert.equal(body.objectId, undefined);
            assert.equal(body.relativePath, "handbook.md");
            return Response.json({
              content: { encoding: "text", text: "Knowledge Services do not need Skill installation." },
              file: {
                fileName: "handbook.md",
                objectId: "policy-handbook",
                relativePath: "handbook.md"
              }
            });
          }
          return Response.json({ error: "unexpected_knowledge_request" }, { status: 404 });
        },
        model: async () => Response.json({ choices: [{ message: {
          content: "No installation is required. [Policies · handbook.md]"
        } }] })
      }),
      definition(),
      principal,
      input({ instruction: "Does a Knowledge Service need to be installed as a Skill?" })
    );

    assert.equal(result.outcome, "completed");
    assert.equal(result.errorCode, undefined);
    assert.match(result.answer, /No installation is required/);
    assert.deepEqual(result.artifacts, [{
      objectId: "policy-handbook",
      relativePath: "handbook.md",
      serviceId: "policies",
      serviceName: "Policies",
      type: "knowledge_source"
    }]);
    assert.equal(calls.knowledge.length, 3);
    assert.equal(calls.model.length, 1);
  });

  it("propagates an explicit caller cancellation instead of persisting it as a Knowledge failure", async () => {
    const calls = fixtureCalls();
    const controller = new AbortController();
    const started = Promise.withResolvers();
    const resolution = resolveKnowledgeTask(
      environment({
        calls,
        knowledge: async (request) => {
          started.resolve();
          await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
          throw request.signal.reason;
        }
      }),
      definition(),
      principal,
      input({ abortSignal: controller.signal, executionTimeoutMs: 100 })
    );

    await started.promise;
    controller.abort(new Error("user-stop"));
    await assert.rejects(
      resolution,
      (error) => error?.status === 499 && error?.code === "mate_chat_request_aborted"
    );
    assert.deepEqual(calls.model, []);
  });

  it("bounds deterministic Knowledge and model hangs as knowledge_execution_timeout", { timeout: 2_000 }, async () => {
    for (const dependency of ["knowledge", "model"]) {
      const calls = fixtureCalls();
      const hanging = async (request) => {
        const signal = request.signal;
        // AbortSignal.timeout() uses an unref'ed timer in Node. Keep the
        // request signal reachable until its deadline aborts this mock fetch.
        const keepAlive = setInterval(() => { void signal.aborted; }, 10);
        try {
          if (signal.aborted) throw signal.reason;
          await new Promise((resolve, reject) => signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true }
          ));
          throw new Error("unreachable");
        } finally {
          clearInterval(keepAlive);
        }
      };
      const result = await resolveKnowledgeTask(
        environment({
          calls,
          ...(dependency === "knowledge" ? { knowledge: hanging } : { model: hanging })
        }),
        definition(),
        principal,
        input({ executionTimeoutMs: 20 })
      );

      assert.equal(result.outcome, "failed");
      assert.equal(result.errorCode, "knowledge_execution_timeout");
      assert.deepEqual(result.artifacts, []);
      if (dependency === "knowledge") assert.deepEqual(calls.model, []);
      else assert.equal(calls.model.length, 1);
    }
  });

  it("keeps explicit caller abort ahead of the internal deadline and strictly bounds the test seam", async () => {
    for (const executionTimeoutMs of [0, 85_001, 1.5]) {
      await assert.rejects(
        resolveKnowledgeTask(
          environment({ calls: fixtureCalls() }),
          definition(),
          principal,
          input({ executionTimeoutMs })
        ),
        (error) => error?.status === 500 && error?.code === "knowledge_execution_timeout_invalid"
      );
    }

    const controller = new AbortController();
    controller.abort(new Error("caller-stop"));
    await assert.rejects(
      resolveKnowledgeTask(
        environment({ calls: fixtureCalls() }),
        definition(),
        principal,
        input({ abortSignal: controller.signal, executionTimeoutMs: 1 })
      ),
      (error) => error?.status === 499 && error?.code === "mate_chat_request_aborted"
    );
  });

  it("mints Knowledge access for the invoking user and fails closed when minting fails", async () => {
    const calls = fixtureCalls();
    const result = await resolveKnowledgeTask(
      environment({
        auth: async (request) => {
          calls.auth.push(request.clone());
          return Response.json({ error: "auth_down" }, { status: 503 });
        },
        calls,
        devAuthBypass: false
      }),
      definition(),
      principal,
      input()
    );

    assert.equal(result.outcome, "failed");
    assert.equal(result.errorCode, "knowledge_resource_token_mint_failed");
    assert.equal(calls.auth.length, 1);
    const body = await calls.auth[0].json();
    assert.equal(body.principal.sub, "user-a");
    assert.deepEqual(body.scopes, ["workspace:knowledge:read"]);
    assert.deepEqual(calls.knowledge, []);
    assert.deepEqual(calls.model, []);
  });

  it("intersects one published Release with each invoking user's visible Knowledge services", async () => {
    const release = definition(["policies", "owner-only"]);
    const selected = input({
      context: {
        capabilitySelection: { knowledgeServiceIds: ["policies", "owner-only"] },
        schemaVersion: "workspace.mate-environment-accepted/v1"
      }
    });

    const allowedCalls = fixtureCalls();
    const allowed = await resolveKnowledgeTask(
      environment({
        auth: async (request) => {
          allowedCalls.auth.push(request.clone());
          return Response.json({ access_token: "knowledge-user-a-token" });
        },
        calls: allowedCalls,
        devAuthBypass: false,
        knowledge: async (request) => {
          assert.equal(request.headers.get("authorization"), "Bearer knowledge-user-a-token");
          const url = new URL(request.url);
          if (url.pathname === "/api/knowledge-services") {
            return Response.json({ services: [{ name: "Policies", serviceId: "policies" }] });
          }
          return knowledgeSuccess(request);
        },
        modelKey: ""
      }),
      release,
      principal,
      selected
    );

    assert.equal(allowed.outcome, "completed");
    assert.deepEqual(allowed.artifacts.map((artifact) => artifact.serviceId), ["policies"]);
    assert.equal(allowedCalls.knowledge.some((request) => new URL(request.url).pathname.includes("owner-only")), false);
    assert.equal((await allowedCalls.auth[0].json()).principal.sub, "user-a");

    const deniedPrincipal = { ...principal, userId: "user-b" };
    const deniedCalls = fixtureCalls();
    const denied = await resolveKnowledgeTask(
      environment({
        auth: async (request) => {
          deniedCalls.auth.push(request.clone());
          return Response.json({ access_token: "knowledge-user-b-token" });
        },
        calls: deniedCalls,
        devAuthBypass: false,
        knowledge: async (request) => {
          assert.equal(request.headers.get("authorization"), "Bearer knowledge-user-b-token");
          const url = new URL(request.url);
          if (url.pathname === "/api/knowledge-services") return Response.json({ services: [] });
          return Response.json({ error: "must_not_query_hidden_service" }, { status: 500 });
        },
        modelKey: ""
      }),
      release,
      deniedPrincipal,
      selected
    );

    assert.equal(denied.outcome, "completed");
    assert.deepEqual(denied.artifacts, []);
    assert.match(denied.answer, /当前用户.*没有可用读取权限/);
    assert.equal(deniedCalls.knowledge.length, 1);
    assert.equal((await deniedCalls.auth[0].json()).principal.sub, "user-b");
    assert.deepEqual(deniedCalls.model, []);
  });

  it("discovers all Agent-enabled Knowledge for a platform Mate while keeping each user's ACL boundary", async () => {
    const release = platformKnowledgeDefinition();
    for (const scenario of [
      { serviceId: "user-a-policies", userId: "user-a" },
      { serviceId: "user-b-handbook", userId: "user-b" }
    ]) {
      const calls = fixtureCalls();
      const result = await resolveKnowledgeTask(
        environment({
          calls,
          knowledge: async (request) => platformKnowledgeSuccess(request, scenario.serviceId),
          modelKey: ""
        }),
        release,
        { ...principal, userId: scenario.userId },
        input({
          context: { schemaVersion: "workspace.mate-environment-accepted/v1" },
          taskId: `turn-${scenario.userId}`
        })
      );

      assert.equal(result.outcome, "completed");
      assert.deepEqual(result.artifacts.map((artifact) => artifact.serviceId), [scenario.serviceId]);
      assert.equal(calls.knowledge.some((request) => request.url.includes("owner-only")), false);
    }
  });

  it("returns a user-scoped empty result when the platform Mate caller has no visible Knowledge", async () => {
    const calls = fixtureCalls();
    const result = await resolveKnowledgeTask(
      environment({
        calls,
        knowledge: async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/api/knowledge-services") return Response.json({ services: [] });
          return Response.json({ error: "hidden_service_must_not_be_queried" }, { status: 500 });
        },
        modelKey: ""
      }),
      platformKnowledgeDefinition(),
      { ...principal, userId: "user-without-knowledge" },
      input({ context: { schemaVersion: "workspace.mate-environment-accepted/v1" } })
    );

    assert.equal(result.outcome, "completed");
    assert.deepEqual(result.artifacts, []);
    assert.match(result.answer, /当前用户暂时没有可供 Agent 查询的知识库/);
    assert.equal(calls.knowledge.length, 1);
    assert.deepEqual(calls.model, []);
  });

  it("projects the invoking user's entire visible Knowledge catalog into the Runtime profile", async () => {
    const calls = fixtureCalls();
    const profile = await resolveRuntimeCapabilityProfile(
      environment({
        calls,
        knowledge: async (request) => {
          const url = new URL(request.url);
          assert.equal(url.pathname, "/api/knowledge-services");
          return Response.json({ services: [
            { description: "User policy scope", name: "Policies", serviceId: "user-policies" },
            { description: "User project scope", name: "Projects", serviceId: "user-projects" }
          ] });
        }
      }),
      platformKnowledgeDefinition(),
      principal
    );

    assert.deepEqual(profile.knowledge.map((item) => item.id), ["user-policies", "user-projects"]);
    assert.equal(profile.knowledge.every((item) => item.authorization === "invoking_user"), true);
    assert.equal(profile.knowledgeScope.mode, "all_visible_to_invoking_user");
    assert.equal(profile.executors, undefined);
  });
});

function input(overrides = {}) {
  return {
    context: {
      schemaVersion: "workspace.mate-environment-accepted/v1",
      context: {
        capabilitySelection: { knowledgeServiceIds: ["policies"] }
      }
    },
    instruction: "How often is KYC reviewed?",
    taskId: "task-knowledge-fault-1",
    ...overrides
  };
}

function definition(serviceIds = ["policies"]) {
  return {
    mate: {
      id: "knowledge-mate",
      orgId: "org-1",
      ownerUserId: "owner-1"
    },
    release: {
      documents: [],
      id: "knowledge-release-1",
      manifest: {
        modelPolicy: {
          allowedModels: ["test-model"],
          allowUserSelection: false,
          defaultModel: "test-model"
        },
        release: { skills: [] },
        resources: {
          appMcpBindings: [],
          builtInToolBindings: [],
          knowledgeServiceBindings: serviceIds.map((serviceId) => ({
            allowedOperations: ["search", "read"],
            authority: { mode: "invoking_user" },
            serviceId
          }))
        }
      }
    }
  };
}

function platformKnowledgeDefinition() {
  const value = definition([]);
  value.release.manifest.resources.knowledgeServiceScope = {
    allowedOperations: ["search", "read"],
    authority: { mode: "invoking_user" },
    mode: "all_visible_to_invoking_user",
    requiresCurrentUserAuthorization: true
  };
  return value;
}

function environment({
  auth,
  calls,
  devAuthBypass = true,
  knowledge = knowledgeSuccess,
  model = modelSuccess,
  modelKey = "test-model-key"
}) {
  return {
    AUTH_SERVICE: {
      fetch: auth ?? (async (request) => {
        calls.auth.push(request.clone());
        return Response.json({ access_token: "knowledge-user-token" });
      })
    },
    AUTH_WORKER_URL: "https://auth.test",
    DEV_AUTH_BYPASS: devAuthBypass ? "1" : "0",
    KNOWLEDGE_PUBLIC_URL: "https://knowledge.test",
    KNOWLEDGE_RESOURCE_ID: "workspace-knowledge",
    KNOWLEDGE_SERVICE: {
      async fetch(request) {
        calls.knowledge.push(request.clone());
        return knowledge(request);
      }
    },
    KNOWLEDGE_WORKER_URL: "https://knowledge.test",
    LITELLM_SERVICE: {
      async fetch(request) {
        calls.model.push(request.clone());
        return model(request);
      }
    },
    LITELLM_URL: "https://model.test",
    RUNTIME_DB: preferencesDatabase(),
    MATE_AUTH_SERVICE_TOKEN: "runtime-auth-service-token",
    MATE_LLM_KEY: modelKey
  };
}

async function knowledgeSuccess(request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/knowledge-services") {
    return Response.json({ services: [{ name: "Policies", serviceId: "policies" }] });
  }
  if (url.pathname === "/api/knowledge-services/policies/query") {
    const body = await request.json();
    if (body.action === "search") {
      return Response.json({ results: [{
        objectId: "policy-1",
        relativePath: "policies/kyc.md",
        snippet: "Annual review"
      }] });
    }
    if (body.action === "read") {
      return Response.json({
        content: { encoding: "text", text: "Annual review" },
        file: {
          fileName: "kyc.md",
          objectId: "policy-1",
          relativePath: "policies/kyc.md"
        }
      });
    }
  }
  return Response.json({ error: "unexpected_knowledge_request" }, { status: 404 });
}

async function platformKnowledgeSuccess(request, serviceId) {
  const url = new URL(request.url);
  if (url.pathname === "/api/knowledge-services") {
    return Response.json({ services: [{ name: serviceId, serviceId }] });
  }
  if (url.pathname === `/api/knowledge-services/${serviceId}/query`) {
    const body = await request.json();
    if (body.action === "search") {
      return Response.json({ results: [{
        objectId: `${serviceId}-source`,
        relativePath: "handbook.md",
        snippet: `Authorized content for ${serviceId}`
      }] });
    }
    if (body.action === "read") {
      return Response.json({
        content: { encoding: "text", text: `Authorized content for ${serviceId}` },
        file: {
          fileName: "handbook.md",
          objectId: `${serviceId}-source`,
          relativePath: "handbook.md"
        }
      });
    }
  }
  return Response.json({ error: "unexpected_knowledge_request" }, { status: 404 });
}

async function modelSuccess() {
  return Response.json({ choices: [{ message: { content: "KYC is reviewed annually. [Policies · policies/kyc.md]" } }] });
}

function preferencesDatabase() {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() { return null; }
          };
        }
      };
    }
  };
}

function fixtureCalls() {
  return { auth: [], knowledge: [], model: [] };
}
