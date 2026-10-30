import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkspaceMateClient } from "./client.ts";
import { normalizeWorkspaceMateHostContext } from "./context.ts";
import {
  acceptWorkspaceMateEnvironment,
  digestWorkspaceMateEnvironment,
  normalizeWorkspaceMateEnvironmentContext
} from "./environment.ts";
import { WorkspaceMateEnvironmentController } from "./environmentController.ts";

function context(route = "/clients/123") {
  return {
    schemaVersion: "workspace.mate-host/v1",
    appId: "portfolio-app",
    page: { route, title: "Client 123" },
    resources: [{ type: "client", id: "123" }],
    allowedActions: ["client.read"]
  };
}

function environment(revision = 1) {
  return {
    schemaVersion: "workspace.mate-environment/v1",
    revision,
    host: { appId: "portfolio-app", surface: "embedded", instanceId: "main" },
    location: { kind: "portfolio.portfolio", ref: "pf_123", route: "/portfolios/pf_123" },
    ancestry: [{ kind: "crm.client", ref: "client_456" }],
    summary: { label: "Primary portfolio", facets: { tab: "allocation", currency: "USD" } },
    resolutionHints: [{ capability: "app_mcp", bindingId: "portfolio-read", purpose: "Resolve current portfolio" }]
  };
}

describe("Workspace Mate Embedded SDK", () => {
  it("strictly normalizes and digests a bounded coordinate without treating it as authority", async () => {
    const normalized = normalizeWorkspaceMateEnvironmentContext(environment());
    assert.equal(normalized.location.ref, "pf_123");
    assert.equal(normalized.resolutionHints[0].bindingId, "portfolio-read");

    const first = await digestWorkspaceMateEnvironment(normalized);
    const second = await digestWorkspaceMateEnvironment({
      ...normalized,
      host: { surface: "embedded", instanceId: "main", appId: "portfolio-app" }
    });
    assert.equal(first, second);
    assert.match(first, /^sha256:[a-f0-9]{64}$/);

    const accepted = await acceptWorkspaceMateEnvironment(normalized);
    assert.equal(accepted.trust, "host_asserted");
    assert.equal(accepted.digest, first);
    assert.throws(() => normalizeWorkspaceMateEnvironmentContext({ ...environment(), ownerUserId: "owner" }), /sensitive_field_forbidden/);
    assert.throws(() => normalizeWorkspaceMateEnvironmentContext({ ...environment(), summary: { facets: { apiKey: "secret" } } }), /sensitive_field_forbidden/);
    assert.throws(() => normalizeWorkspaceMateEnvironmentContext({ ...environment(), rawRecord: { balance: 10 } }), /field_unknown/);
    assert.throws(() => normalizeWorkspaceMateEnvironmentContext({ ...environment(), ancestry: Array.from({ length: 9 }, (_, index) => ({ kind: "crm.client", ref: `client_${index}` })) }), /ancestry_too_many/);
    assert.throws(() => normalizeWorkspaceMateEnvironmentContext({ ...environment(), summary: { facets: { portfolio: { balance: 10 } } } }), /facet_value_invalid/);
    assert.throws(() => normalizeWorkspaceMateEnvironmentContext({ ...environment(), summary: { description: "x".repeat(1_001) } }), /summary_description_invalid/);
  });

  it("replaces complete snapshots with monotonic revisions, including after clear", () => {
    const controller = new WorkspaceMateEnvironmentController(environment());
    const changes = [];
    controller.onChange((value) => changes.push(value?.revision));
    const next = controller.replace({
      host: environment().host,
      location: { kind: "portfolio.portfolio", ref: "pf_789" },
      summary: { label: "Secondary portfolio" }
    });
    assert.equal(next.revision, 2);
    assert.equal(next.location.ref, "pf_789");
    assert.deepEqual(changes, [2]);
    assert.deepEqual(controller.accept(next), next);
    assert.deepEqual(changes, [2]);
    assert.throws(() => controller.accept({ ...next, location: { ...next.location, ref: "pf_conflict" } }), /revision_conflict/);
    controller.clear();
    const afterClear = controller.replace({ host: environment().host, location: environment().location });
    assert.equal(afterClear.revision, 3);
    assert.deepEqual(changes, [2, undefined, 3]);
  });

  it("sends the current Environment snapshot instead of the legacy Host Context", async () => {
    let taskBody;
    const client = new WorkspaceMateClient({
      accessToken: "token",
      environment: environment(),
      mateId: "portfolio-mate",
      runtimeOrigin: "https://runtime-preview.example.com",
      fetch: async (url, init) => {
        if (String(url).endsWith("/tasks")) {
          taskBody = JSON.parse(init.body);
          return Response.json({ task: { id: "task_12345678", mateId: "portfolio-mate", conversationId: "conv_12345678", status: "queued", instruction: taskBody.instruction } });
        }
        return Response.json({ task: { id: "task_12345678", mateId: "portfolio-mate", conversationId: "conv_12345678", status: "completed", instruction: "Review" } });
      }
    });
    await client.ask("Review");
    assert.equal(taskBody.context.schemaVersion, "workspace.mate-environment/v1");
    assert.equal(taskBody.context.location.ref, "pf_123");
    assert.equal(Object.hasOwn(taskBody.context, "allowedActions"), false);
  });

  it("requires exactly one initial context contract", () => {
    const base = {
      accessToken: "token",
      mateId: "portfolio-mate",
      runtimeOrigin: "https://runtime-preview.example.com"
    };
    assert.throws(() => new WorkspaceMateClient(base), /context_or_environment_required/);
    assert.throws(() => new WorkspaceMateClient({ ...base, context: context(), environment: environment() }), /context_and_environment_conflict/);
  });

  it("creates and runs an SDK Task without accepting browser-supplied user identity", async () => {
    const calls = [];
    const events = [];
    const client = new WorkspaceMateClient({
      accessToken: async () => "short-lived-user-token",
      context: context(),
      mateId: "knowledge-mate",
      runtimeOrigin: "https://runtime-preview.example.com",
      onEvent: (event) => events.push(event),
      fetch: async (url, init) => {
        calls.push({ url, init });
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer short-lived-user-token");
        if (String(url).endsWith("/tasks")) {
          const body = JSON.parse(init.body);
          assert.equal(body.channel, "sdk");
          assert.equal(body.context.page.route, "/clients/123");
          assert.equal(Object.hasOwn(body, "userId"), false);
          return Response.json({ task: { id: "task_12345678", mateId: "knowledge-mate", conversationId: "conv_12345678", status: "queued", instruction: body.instruction } }, { status: 202 });
        }
        return Response.json({ task: { id: "task_12345678", mateId: "knowledge-mate", conversationId: "conv_12345678", status: "completed", instruction: "Find policy", conclusion: { outcome: "completed", summary: "Answer [KB · policy.md]", artifacts: [], followUps: [] } } });
      }
    });

    const task = await client.ask("Find policy");
    assert.equal(task.status, "completed");
    assert.equal(calls.length, 2);
    assert.deepEqual(events.map((event) => event.status), ["queued", "completed"]);
  });

  it("runs a release-pinned Preview Task Inbox channel without using the Live route", async () => {
    const calls = [];
    const client = new WorkspaceMateClient({
      accessToken: async () => "preview-owner-token",
      environment: environment(),
      mode: "preview",
      releaseId: "cortana-r7",
      mateId: "cortana",
      runtimeOrigin: "https://runtime-preview.example.com",
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
        if (init.method === "POST" && String(url).includes("/tasks?")) {
          return Response.json({ task: { id: "task_preview_123", mateId: "cortana", releaseId: "cortana-r7", status: "queued", instruction: "Review", channel: "mate_call" } }, { status: 202 });
        }
        return Response.json({ task: { id: "task_preview_123", mateId: "cortana", releaseId: "cortana-r7", status: "completed", instruction: "Review", channel: "mate_call" } });
      }
    });

    const task = await client.ask("Review", { channel: "mate_call" });

    assert.equal(task.status, "completed");
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.url.startsWith("https://runtime-preview.example.com/v1/owner-test/mates/cortana/")));
    assert.ok(calls.every((call) => call.url.endsWith("release=cortana-r7")));
    assert.equal(calls[0].body.channel, "mate_call");
    assert.equal(calls[0].body.context.schemaVersion, "workspace.mate-environment/v1");
    assert.equal(calls[0].body.conversationId, undefined);
  });

  it("binds the browser-native fetch implementation to globalThis", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function (url) {
      assert.equal(this, globalThis);
      assert.match(String(url), /\/v1\/owner-test\/mates\/cortana\/tasks\?release=cortana-r7$/);
      return Response.json({ tasks: [] });
    };
    try {
      const client = new WorkspaceMateClient({
        accessToken: "preview-owner-token",
        environment: environment(),
        mode: "preview",
        releaseId: "cortana-r7",
        mateId: "cortana",
        runtimeOrigin: "https://runtime-preview.example.com"
      });
      assert.deepEqual(await client.listTasks(), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when Preview mode is missing an immutable Release", () => {
    assert.throws(() => new WorkspaceMateClient({
      accessToken: "token",
      environment: environment(),
      mode: "preview",
      mateId: "cortana",
      runtimeOrigin: "https://runtime-preview.example.com"
    }), /preview_release_id_required/);
  });

  it("replaces context and rejects identity or credential material", () => {
    const client = new WorkspaceMateClient({
      accessToken: "token",
      context: context(),
      mateId: "knowledge-mate",
      runtimeOrigin: "http://localhost:8801"
    });
    client.updateContext(context("/clients/456"));
    assert.equal(client.currentContext().page.route, "/clients/456");
    assert.equal(client.currentContext().resources[0].id, "123");

    assert.throws(() => normalizeWorkspaceMateHostContext({ ...context(), userId: "other-user" }), /sensitive_field_forbidden/);
    assert.throws(() => normalizeWorkspaceMateHostContext({ ...context(), resources: [{ type: "client", id: "123", cookie: "secret" }] }), /sensitive_field_forbidden/);
  });

  it("surfaces App MCP Approval without accepting caller-selected authority", async () => {
    const calls = [];
    const events = [];
    const client = new WorkspaceMateClient({
      accessToken: "user-token",
      context: context(),
      mateId: "portfolio-banker-mate",
      runtimeOrigin: "https://runtime-preview.example.com",
      onEvent: (event) => events.push(event),
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ body, url: String(url) });
        if (String(url).includes("/tasks/")) {
          assert.equal(body.executor, undefined);
          assert.equal(body.operation.appId, "portfolio-tracker");
          return Response.json({
            approval: {
              actionDigest: "sha256:abc",
              expiresAt: "2026-08-21T10:10:00.000Z",
              id: "approval_12345678",
              operation: body.operation,
              riskLevel: "medium",
              status: "pending",
              taskId: "task_12345678"
            },
            task: { id: "task_12345678", mateId: "portfolio-banker-mate", conversationId: "conv_12345678", status: "waiting_for_approval", instruction: "Update client" }
          }, { status: 202 });
        }
        assert.deepEqual(body, { decision: "approve" });
        return Response.json({
          approval: { id: "approval_12345678", status: "consumed" },
          output: { updated: true },
          task: { id: "task_12345678", mateId: "portfolio-banker-mate", conversationId: "conv_12345678", status: "completed", instruction: "Update client" }
        });
      }
    });

    const proposal = await client.runAppMcpTask("task_12345678", {
      appId: "portfolio-tracker",
      toolName: "portfolio_client_update",
      arguments: { clientId: "123", note: "Reviewed" }
    });
    assert.equal(proposal.approval.status, "pending");
    assert.deepEqual(events.map((event) => event.type), ["task.updated", "approval.requested"]);

    const executed = await client.decideApproval("approval_12345678", "approve");
    assert.deepEqual(executed.output, { updated: true });
    assert.equal(calls.length, 2);
    await assert.rejects(() => client.runAppMcpTask("task_12345678", {
      appId: "portfolio-tracker",
      toolName: "portfolio_client_update",
      arguments: { clientId: "123", userId: "other-user" }
    }), /caller_authority_field_forbidden/);
  });
});
