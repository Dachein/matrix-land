import { testInstallation } from "../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  claimDueReminders,
  claimInboundEmail,
  completeInboundEmail,
  createReminder,
  createTodo,
  findOrCreateEmailThread,
  listReminders,
  listTodos,
  subjectWithThreadCode,
  threadCodeFromSubject
} from "./inboxStorage.ts";
import { executeConfiguredTask } from "./taskExecutor.ts";
import {
  decideAndExecuteWorkspacePassMcpApproval,
  executeWorkspacePassMcpWriteTask
} from "./workspacePassMcpExecutor.ts";
import { kitesurfTestBinding } from "./kitesurfTestBinding.mjs";
import { resolveRoleConversation } from "./roleConversation.ts";
import { runMateScheduleNow } from "./scheduler.ts";
import { createTask } from "./storage.ts";
import { decideAndExecuteSelfDefinitionApproval, proposeSelfDefinitionTask } from "./selfDefinitionExecutor.ts";
import { decideAndExecutePluginApproval, proposePluginTask } from './pluginExecutor.ts';
import { toolDigest } from '../../auth/src/remoteMcp/routes.ts';

class D1Adapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database.prepare(sql)); }
  async batch(statements) {
    const output = [];
    for (const statement of statements) output.push(await statement.run());
    return output;
  }
}

class Statement {
  constructor(statement, params = []) { this.statement = statement; this.params = params; }
  bind(...params) { return new Statement(this.statement, params); }
  async all() { return { results: this.statement.all(...this.params) }; }
  async first() { return this.statement.get(...this.params) ?? null; }
  async run() { this.statement.run(...this.params); return { success: true }; }
}

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../db/migrations/0002_runtime_v1.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../db/migrations/0003_cortana_inbox.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../db/migrations/0005_configured_schedules.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../db/migrations/0010_work_threads.sql", import.meta.url), "utf8"));
  return { d1: new D1Adapter(sqlite), sqlite };
}

function principal(userId, email = `${userId}@example.invalid`) {
  return {
    callerKind: "user",
    email,
    orgId: "example-org",
    orgSlug: "workspace-wealth",
    scopes: ["mate:invoke", "mate:preferences"],
    userId
  };
}

function configuredOperationsDefinition() {
  const manifest = JSON.parse(readFileSync(new URL("../../../schemas/workspace.agentruntime/examples/knowledge-assistant.candidate.json", import.meta.url), "utf8"));
  manifest.mate = {
    addresses: [
      { type: "email", address: "cortana@example.invalid" },
      { type: "pass_mcp", tool: "mate_call" }
    ],
    description: "AI Adoption platform operations",
    displayName: "Cortana",
    jobRole: "Review Forum changes and manage adoption work",
    ownerUserId: "owner-1",
    mateId: "cortana"
  };
  manifest.release.releaseId = "cortana-r1";
  manifest.release.status = "published";
  manifest.resources.appMcpBindings = [];
  manifest.resources.knowledgeServiceBindings = [];
  delete manifest.resources.knowledgeServiceScope;
  manifest.resources.builtInToolBindings = ["public_web_read", "workspace_forum_read", "todo_manage", "reminder_manage"].map((toolId) => ({
    requiresCurrentUserContext: true,
    toolId
  }));
  manifest.channels = {
    embedded: { enabled: false },
    inbox: {
      email: { enabled: true },
      schedule: { enabled: true },
      mateCall: { enabled: true, tool: "mate_call", transport: "workspace_pass_mcp" },
      webhook: { enabled: false }
    },
    standalone: { enabled: false }
  };
  manifest.experiencePolicy.conversation = { enabled: false, channels: [] };
  manifest.experiencePolicy.taskInbox = { enabled: true, channels: ["email", "mate_call", "schedule"] };
  manifest.invocationPolicy.visibility = "organization";
  manifest.taskPolicy = {
    ...manifest.taskPolicy,
    defaultExecutor: "operations",
    defaultTimezone: "Asia/Shanghai",
    scheduledJobs: [{
      cadence: { at: "09:00", kind: "daily", timezone: "Asia/Shanghai" },
      delivery: { channel: "email", recipient: "owner" },
      executor: "forum_review",
      forumReview: { cursorKey: "cortana.forum.last_successful_review_at", lookbackHours: 24, maxTopics: 40 },
      id: "reminder_cortana_forum_daily",
      instruction: "Review Workspace Forum updates and organize action items for AI Adoption.",
      title: "Workspace Forum daily review"
    }]
  };
  return {
    mate: {
      description: manifest.mate.description,
      displayName: "Cortana",
      id: "cortana",
      jobRole: manifest.mate.jobRole,
      orgId: "example-org",
      ownerUserId: "owner-1",
      updatedAt: "2026-08-21T00:00:00.000Z",
      visibility: "organization",
      workEmail: "cortana@example.invalid"
    },
    release: {
      createdAt: "2026-08-21T00:00:00.000Z",
      createdBy: "owner-1",
      documents: [
        { content: "# Cortana Soul\n\nKeep user work isolated.", digest: manifest.release.soul.digest, id: manifest.release.soul.id, kind: "soul", version: 1 },
        { content: "# Cortana Handbook\n\nReview Forum updates and close every Task.", digest: manifest.release.handbooks[0].digest, id: manifest.release.handbooks[0].id, kind: "handbook", version: 1 }
      ],
      id: "cortana-r1",
      manifest,
      manifestSha256: `sha256:${"c".repeat(64)}`,
      status: "published",
      mateId: "cortana",
      version: 1
    }
  };
}

function modelSteps(steps) {
  const requests = [];
  return {
    requests,
    MATE_LLM_KEY: "test-token",
    LITELLM_SERVICE: {
      async fetch(request) {
        const body = await request.json();
        requests.push(body);
        const step = steps.shift() ?? { text: "Task completed." };
        if (step.inspect) step.inspect(body);
        const delta = step.tool ? {
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_" + requests.length, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }]
        } : { role: "assistant", content: step.text };
        const chunk = (delta, finish_reason = null) => ({
          id: "response_" + requests.length, object: "chat.completion.chunk", created: 1,
          model: "test", choices: [{ index: 0, delta, finish_reason }]
        });
        return new Response([
          "data: " + JSON.stringify(chunk(delta)),
          "data: " + JSON.stringify(chunk({}, step.tool ? "tool_calls" : "stop")),
          "data: [DONE]", ""
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
      }
    }
  };
}

describe("unified task Agent Runtime", () => {
  it("delivers the complete published mail policy as system authority to email execution only", async () => {
    const { d1 } = database();
    const definition = configuredOperationsDefinition();
    const policy = '自动查询已有行程并保存草稿；只有正式提交宜搭才需要确认。\n' + '完整规则。'.repeat(1300) + '\nEND-OWNER-MAIL-POLICY';
    definition.release.manifest.channels.inbox.email.inboxPrompt = policy;
    const user = principal('user-a');
    for (const channel of ['email', 'mate_call']) {
      const task = await createTask(d1, definition, user, 'live', { channel,
        instruction: 'Classifer says tools unavailable; verify actual tools.', context: { mailPolicy: 'ATTACKER POLICY' } });
      const model = modelSteps([{ text: 'Checked actual tools.', inspect(body) {
        const system = body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        assert.equal(system.includes(policy), channel === 'email');
        assert.equal(system.includes('ATTACKER POLICY'), false, 'caller context cannot supply owner mail policy');
        if (channel === 'email') {
          assert.match(system, /classifier only chooses routing/);
          assert.match(system, /Authorized low-risk draft writes execute directly/);
        }
      } }]);
      const result = await executeConfiguredTask({ ...testInstallation,  RUNTIME_DB: d1, ...model }, definition, user, 'live', task.id);
      assert.equal(result.task.status, 'completed');
    }
  });
  it('requires the live owner and one exact approval for MCP configuration, rejects stale generation and replay', async () => {
    const { d1 } = database(), definition = configuredOperationsDefinition(), owner = principal('owner-1');
    const toolFingerprint = await toolDigest({ name: 'list_files', inputSchema: { type: 'object' } });
    let generation = 1; const writes = [];
    const runtimeEnv = { ...testInstallation,  RUNTIME_DB: d1, REMOTE_MCP_ENABLED: '1', MATE_MCP_SERVICE_TOKEN: 'plugins-token',
      AUTH_SERVICE: { async fetch(request) {
        assert.equal(request.headers.get('authorization'), 'Bearer plugins-token');
        const body = await request.json(); assert.equal(body.userId, owner.userId); assert.equal(body.mateId, definition.mate.id);
        if (body.action === 'list') return Response.json({ connections: [{ id: 'example-mcp', generation }] });
        if (body.action === 'test') return Response.json({ connection: { id: 'example-mcp', generation }, tools: [{ name: 'list_files', digest: toolFingerprint }] });
        assert.equal(body.approved, true); writes.push(body); return Response.json({ completed: true });
      } } };
    const operation = { type: 'remote_mcp_plugin_change', action: 'enable', connectionId: 'example-mcp', generation,
      tools: [{ name: 'list_files', digest: toolFingerprint, readOnly: true }] };
    const task = await createTask(d1, definition, owner, 'live', { channel: 'email', instruction: 'Connect my MCP' });
    const pending = await proposePluginTask(runtimeEnv, definition, owner, 'live', task.id, operation);
    assert.equal(pending.approval.status, 'pending'); assert.equal(writes.length, 0);
    await assert.rejects(decideAndExecutePluginApproval(runtimeEnv, definition, principal('shared-user'), 'live', pending.approval.id, 'approve'));
    const completed = await decideAndExecutePluginApproval(runtimeEnv, definition, owner, 'live', pending.approval.id, 'approve');
    assert.equal(completed.task.status, 'completed'); assert.equal(writes.length, 1);
    assert.equal(writes[0].tools[0].digest, toolFingerprint);
    await assert.rejects(decideAndExecutePluginApproval(runtimeEnv, definition, owner, 'live', pending.approval.id, 'approve'));
    const changedToolTask = await createTask(d1, definition, owner, 'live', { channel: 'email', instruction: 'Enable changed tool' });
    const changedTool = await proposePluginTask(runtimeEnv, definition, owner, 'live', changedToolTask.id,
      { ...operation, tools: [{ ...operation.tools[0], digest: await toolDigest({ name: 'list_files', inputSchema: { type: 'object', required: ['page'] } }) }] });
    assert.equal(changedTool.task.status, 'failed');
    assert.equal(changedTool.task.conclusion.failures[0].code, 'remote_mcp_tool_changed');
    assert.equal(writes.length, 1);
    const staleTask = await createTask(d1, definition, owner, 'live', { channel: 'email', instruction: 'Remove MCP' });
    const stale = await proposePluginTask(runtimeEnv, definition, owner, 'live', staleTask.id, { ...operation, action: 'remove' });
    generation++;
    const failed = await decideAndExecutePluginApproval(runtimeEnv, definition, owner, 'live', stale.approval.id, 'approve');
    assert.equal(failed.task.status, 'failed'); assert.equal(writes.length, 1);
    const shared = principal('shared-user');
    const sharedTask = await createTask(d1, definition, shared, 'live', { channel: 'email', instruction: 'Edit plugin' });
    const denied = await proposePluginTask(runtimeEnv, definition, shared, 'live', sharedTask.id, { ...operation, generation });
    assert.equal(denied.task.status, 'failed'); assert.equal(denied.task.conclusion.failures[0].code, 'mate_owner_required');
  });
  it("publishes a Mate self update only after its owner's exact single-use approval", async () => {
    const { d1 } = database();
    const definition = configuredOperationsDefinition();
    const owner = principal("owner-1");
    let draftRevision = 2;
    const calls = [];
    const runtimeEnv = { ...testInstallation,
      RUNTIME_DB: d1,
      MATE_RUNTIME_SERVICE_TOKEN: "runtime-token",
      APPS_CONTROL_PLANE: { async fetch(request) {
        calls.push(request.clone());
        assert.equal(request.headers.get("x-workspace-runtime-user-id"), owner.userId);
        if (request.method === "GET") {
          return Response.json({ activeReleaseId: definition.release.id, draftRevision });
        }
        const change = await request.json();
        assert.equal(change.expectedReleaseId, definition.release.id);
        assert.equal(change.soul, "# New Soul");
        draftRevision += 1;
        return Response.json({ release: { id: "cortana-r2" }, draftRevision });
      } }
    };
    const task = await createTask(d1, definition, owner, "live", {
      channel: "email", instruction: "Update my Mate Soul"
    });
    const change = {
      expectedDraftRevision: draftRevision, expectedReleaseId: definition.release.id,
      soul: "# New Soul"
    };
    const pending = await proposeSelfDefinitionTask(runtimeEnv, definition, owner, "live", task.id, change);
    assert.equal(pending.approval.status, "pending");
    assert.equal(calls.filter((request) => request.method === "POST").length, 0);
    const completed = await decideAndExecuteSelfDefinitionApproval(
      runtimeEnv, definition, owner, "live", pending.approval.id, "approve"
    );
    assert.equal(completed.task.status, "completed");
    assert.equal(completed.result.release.id, "cortana-r2");
    assert.equal(calls.filter((request) => request.method === "POST").length, 1);
    await assert.rejects(
      decideAndExecuteSelfDefinitionApproval(runtimeEnv, definition, owner, "live", pending.approval.id, "approve")
    );
    assert.equal(calls.filter((request) => request.method === "POST").length, 1);

    const secondTask = await createTask(d1, definition, owner, "live", {
      channel: "email", instruction: "Update my Mate again"
    });
    const staleProposal = await proposeSelfDefinitionTask(runtimeEnv, definition, owner, "live", secondTask.id, {
      ...change, expectedDraftRevision: draftRevision
    });
    assert.equal(staleProposal.approval.status, "pending");
    draftRevision += 1;
    const staleResult = await decideAndExecuteSelfDefinitionApproval(
      runtimeEnv, definition, owner, "live", staleProposal.approval.id, "approve"
    );
    assert.equal(staleResult.task.status, "failed");
    assert.equal(calls.filter((request) => request.method === "POST").length, 1);
  });
  it("requires a current-user single-use approval before a dynamic Workspace MCP write", async () => {
    const { d1 } = database();
    const definition = configuredOperationsDefinition();
    definition.release.manifest.resources.mcpCapacity = {
      ai_capacity: { mode: "none" }, forum_hub: { mode: "selected", children: ["forum_write"] }
    };
    const user = principal("user-a");
    const requests = [];
    const runtimeEnv = { ...testInstallation,
      WORKSPACE_MCP_SERVICE: {
        async fetch(request) {
          requests.push(request.clone());
          if (request.method === "GET") {
            return Response.json({
              catalogVersion: "1.5.0",
              domains: ["apps", "knowledge"],
              tools: [{
                capacity: { group: "forum_hub", child: "forum_write" },
                description: "Create a Forum topic.",
                inputSchema: { type: "object", properties: { action: { type: "string" } } },
                name: "forum_write",
                runtimePolicy: { authorization: "invoking_user", writeMode: "always", writeRisk: "high" }
              }]
            });
          }
          assert.equal(request.headers.get("x-workspace-runtime-approval"), "single-use-approved");
          return Response.json({ topic: { id: "topic-1", title: "Approved" } });
        }
      },
      RUNTIME_DB: d1,
      MATE_RUNTIME_SERVICE_TOKEN: "runtime-token"
    };
    const task = await createTask(d1, definition, user, "live", {
      channel: "email",
      instruction: "Create a Forum topic"
    });
    const pending = await executeWorkspacePassMcpWriteTask(runtimeEnv, definition, user, "live", task.id, {
      operation: {
        arguments: { action: "create_topic", title: "Approved" },
        toolName: "forum_write",
        type: "workspace_pass_mcp_tool_call"
      }
    });
    assert.equal(pending.approval.status, "pending");
    assert.equal(pending.approval.riskLevel, "high");
    assert.equal(requests.filter((request) => request.method === "POST").length, 0);

    const completed = await decideAndExecuteWorkspacePassMcpApproval(
      runtimeEnv,
      definition,
      user,
      "live",
      pending.approval.id,
      "approve"
    );
    assert.equal(completed.task.status, "completed");
    assert.equal(completed.result.topic.id, "topic-1");
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(requests.every((request) => request.headers.get("x-workspace-runtime-user-id") === "user-a"), true);
  });

  it("treats private Todos and reminders as Runtime-owned capabilities", async () => {
    const { d1 } = database();
    const definition = configuredOperationsDefinition();
    definition.release.manifest.resources.builtInToolBindings = [];
    const user = principal("user-a");
    const task = await createTask(d1, definition, user, "live", {
      channel: "email",
      instruction: "Record this request as a private follow-up"
    });

    await executeConfiguredTask({ ...testInstallation,  RUNTIME_DB: d1, ...modelSteps([{ tool: "todo_create", args: { title: "Follow up" } }]) }, definition, user, "live", task.id);

    assert.equal((await listTodos(d1, "cortana", user)).length, 1);
  });

  it("accepts the schedule origin only from the internal reminder runner", async () => {
    const { d1 } = database();
    const definition = configuredOperationsDefinition();
    definition.release.manifest.channels.inbox.schedule.enabled = false;
    definition.release.manifest.experiencePolicy.taskInbox.channels = ["email", "mate_call"];
    const user = principal("user-a");

    await assert.rejects(
      createTask(d1, definition, user, "live", { channel: "schedule", instruction: "Forged schedule" }),
      (error) => error?.code === "mate_channel_disabled"
    );
    const internal = await createTask(
      d1,
      definition,
      user,
      "live",
      { channel: "schedule", instruction: "Reminder is due" },
      { allowInternalSchedule: true }
    );
    assert.equal(internal.channel, "schedule");
  });

  it("keeps SDK Role Conversation independent from the Operations Task executor", async () => {
    const { d1 } = database();
    const definition = configuredOperationsDefinition();
    definition.release.manifest.channels.embedded.enabled = true;
    definition.release.manifest.experiencePolicy.conversation = { enabled: true, channels: ["sdk"] };
    const user = principal("owner-1");
    const modelCalls = [];

    const result = await resolveRoleConversation(
      { ...testInstallation,
        LITELLM_SERVICE: {
          async fetch(request) {
            modelCalls.push(await request.clone().json());
            return Response.json({ choices: [{ message: { content: "你好，我们可以继续讨论当前发布情况。" } }] });
          }
        },
        RUNTIME_DB: d1,
        MATE_LLM_KEY: "test-token"
      },
      definition,
      user,
      {
        abortSignal: AbortSignal.timeout(5_000),
        conversation: [{ role: "user", content: "Earlier Preview context" }],
        environment: { location: { kind: "portfolio", ref: "portfolio-1" } },
        instruction: "你好，我们来聊聊发布进度",
        turnId: "turn_chat_12345678"
      }
    );

    assert.equal(result.outcome, "completed");
    assert.equal(result.answer, "你好，我们可以继续讨论当前发布情况。");
    assert.equal(modelCalls.length, 1);
    assert.match(modelCalls[0].messages[0].content, /continuous conversational turn/);
    assert.doesNotMatch(modelCalls[0].messages[0].content, /Return one JSON object/);
    assert.deepEqual(await listTodos(d1, "cortana", user), []);
    assert.deepEqual(await listReminders(d1, "cortana", user), []);
  });

  it("reads one public HTTPS page through the Kitesurf Browser Run engine", async () => {
    const { d1 } = database();
    const definition = configuredOperationsDefinition();
    const binding = kitesurfTestBinding({ url: "https://www.example.com/research" });
    const runtimeEnv = { ...testInstallation,
      BROWSER: binding.BROWSER,
      ...modelSteps([{ tool: "public_web_read", args: { url: "https://www.example.com/research" } }, { tool: "todo_create", args: { title: "Follow up research" } }, { text: "Kitesurf rendered this evidence" }]),
      RUNTIME_DB: d1
    };
    const user = principal("user-a");
    const task = await createTask(d1, definition, user, "live", {
      channel: "email",
      instruction: "请阅读 https://www.example.com/research 并总结"
    });

    const result = await executeConfiguredTask(runtimeEnv, definition, user, "live", task.id);

    assert.equal(binding.calls.length, 1);
    const requestUrl = new URL(binding.calls[0].url);
    assert.equal(requestUrl.pathname, "/v1/devtools/browser");
    assert.equal(requestUrl.searchParams.get("browser"), "kitesurf");
    assert.equal(binding.commands.find((command) => command.method === "Page.navigate").params.url, "https://www.example.com/research");
    assert.match(result.task.conclusion.summary, /Kitesurf rendered this evidence/);
    assert.deepEqual(result.task.conclusion.actions.map(action => action.toolName), ["public_web_read", "todo_create"]);
    assert.equal((await listTodos(d1, "cortana", user)).length, 1);
  });

  it("keeps Preview Todo and Reminder proposals out of the Live inbox tables", async () => {
    const { d1 } = database();
    const definition = configuredOperationsDefinition();
    const user = principal("owner-1");
    const runtimeEnv = { ...testInstallation,  RUNTIME_DB: d1, ...modelSteps([{ tool: "todo_create", args: { title: "Preview proposal" } }, { tool: "reminder_create", args: { title: "Later", instruction: "Review later", nextDueAt: "2027-01-01T00:00:00Z", scheduleKind: "once" } }]) };
    const task = await createTask(d1, definition, user, "preview", {
      channel: "mate_call",
      context: {
        schemaVersion: "workspace.mate-environment/v1",
        revision: 1,
        host: { appId: "workspace-mate-preview", surface: "debug" },
        location: { kind: "mate.release", ref: "mate/cortana/release/cortana-r1" },
        summary: { label: "Cortana", state: "candidate" }
      },
      instruction: "Review this Preview request"
    });

    const result = await executeConfiguredTask(runtimeEnv, definition, user, "preview", task.id);

    assert.equal(result.task.status, "completed");
    assert.equal((await listTodos(d1, "cortana", user)).length, 0);
    assert.equal((await listReminders(d1, "cortana", user)).length, 0);
    assert.ok(result.task.conclusion.actions.every((action) => action.writesApplied === false));
  });

  it("isolates Todos, Reminders, and Thread Codes by the authenticated user", async () => {
    const { d1 } = database();
    const userA = principal("user-a");
    const userB = principal("user-b");

    const todo = await createTodo(d1, "cortana", userA.userId, { title: "Review feedback", priority: "high" });
    await createTodo(d1, "cortana", userB.userId, { title: "Private B requirement" });
    await createReminder(d1, "cortana", userA.userId, {
      instruction: "Follow up with AI Adoption",
      nextDueAt: "2026-08-22T02:00:00.000Z",
      title: "Follow up",
      timezone: "Asia/Shanghai"
    });

    assert.deepEqual((await listTodos(d1, "cortana", userA)).map((item) => item.title), ["Review feedback"]);
    assert.deepEqual((await listTodos(d1, "cortana", userB)).map((item) => item.title), ["Private B requirement"]);
    assert.equal((await listReminders(d1, "cortana", userA)).length, 1);
    assert.deepEqual(await listReminders(d1, "cortana", userB), []);
    assert.match(todo.id, /^todo_/);

    const first = await findOrCreateEmailThread(d1, { subject: "First request", mateId: "cortana", userId: userA.userId });
    assert.match(first.threadCode, /^[A-HJ-NP-Z2-9]{4}$/);
    const sameUser = await findOrCreateEmailThread(d1, { requestedCode: first.threadCode, subject: "Re: First request", mateId: "cortana", userId: userA.userId });
    assert.equal(sameUser.threadCode, first.threadCode);
    const otherUser = await findOrCreateEmailThread(d1, { requestedCode: first.threadCode, subject: "Attempted crossover", mateId: "cortana", userId: userB.userId });
    assert.notEqual(otherUser.threadCode, first.threadCode);
    assert.equal(
      threadCodeFromSubject(subjectWithThreadCode("Re: First request", first.threadCode, "cortana"), "cortana"),
      first.threadCode
    );
    assert.match(subjectWithThreadCode("Review", first.threadCode, "research-analyst"), /^\[RESEARCH-ANALYST-/);
  });

  it("deduplicates inbound messages and scheduled executions", async () => {
    const { d1 } = database();
    const thread = await findOrCreateEmailThread(d1, { subject: "Requirement", mateId: "cortana", userId: "user-a" });
    const input = {
      envelopeFrom: "user-a@example.invalid",
      envelopeTo: "cortana@example.invalid",
      messageDigest: `sha256:${"d".repeat(64)}`,
      subject: "Requirement",
      mateId: "cortana",
      threadCode: thread.threadCode,
      userId: "user-a"
    };
    assert.equal(await claimInboundEmail(d1, input), true);
    assert.equal(await claimInboundEmail(d1, input), false);
    await completeInboundEmail(d1, "cortana", input.messageDigest, "task-1", "failed");
    assert.equal(await claimInboundEmail(d1, input), true);

    await createReminder(d1, "cortana", "user-a", {
      instruction: "Run once",
      nextDueAt: "2026-08-21T01:00:00.000Z",
      reminderId: "reminder_once_1",
      title: "Run once"
    });
    const now = new Date("2026-08-21T01:05:00.000Z");
    assert.equal((await claimDueReminders(d1, now)).length, 1);
    assert.equal((await claimDueReminders(d1, now)).length, 0);
    const reclaimed = await claimDueReminders(d1, new Date("2026-08-21T01:41:00.000Z"));
    assert.equal(reclaimed.length, 1);
    assert.notEqual(reclaimed[0].executionKey, "cortana:user-a:reminder_once_1:2026-08-21T01:00:00.000Z");
  });

  it("runs the first Forum review as the configured owner and emails one coded digest", async () => {
    const { d1, sqlite } = database();
    const definition = configuredOperationsDefinition();
    const forumCalls = [];
    const emails = [];
    await createReminder(d1, "cortana", "legacy-owner", {
      instruction: "Legacy owner schedule",
      intervalSeconds: 86400,
      nextDueAt: "2026-08-21T01:00:00.000Z",
      reminderId: "reminder_cortana_forum_daily",
      scheduleKind: "interval",
      timezone: "Asia/Shanghai",
      title: "Legacy owner schedule"
    });
    const env = { ...testInstallation,
      ...modelSteps([{ tool: "forum_read", args: { action: "search_topics", query: "", limit: 10 } }, { tool: "forum_read", args: { action: "get_topic", topicId: "topic-1" } }, { tool: "todo_create", args: { title: "Improve onboarding" } }, { text: "Reviewed onboarding feedback." }]),
      AUTH_SERVICE: {
        async fetch(request) {
          assert.equal(request.headers.get("authorization"), "Bearer auth-runtime-token");
          const body = await request.json();
          assert.equal(body.userId, "owner-1");
          return Response.json({
            orgId: "example-org",
            orgSlug: "workspace-wealth",
            user: { email: "ai-adoption@example.invalid", id: "owner-1", name: "AI Adoption", status: "active" }
          });
        }
      },
      AUTH_WORKER_URL: "https://auth.example.invalid",
      WORKSPACE_MCP_SERVICE: {
        async fetch(request) {
          assert.equal(request.headers.get("authorization"), "Bearer runtime-service-token");
          assert.equal(request.headers.get("x-workspace-runtime-user-id"), "owner-1");
          forumCalls.push(request.clone());
          const url = new URL(request.url);
          if (request.method === "GET") return Response.json({
            catalogVersion: "1.5.0",
            domains: ["apps", "knowledge"],
            tools: [{
              capacity: { group: "forum_hub", child: "forum_read" },
              description: "Read Forum topics.",
              inputSchema: { type: "object", properties: { action: { type: "string" } } },
              name: "forum_read",
              runtimePolicy: { authorization: "invoking_user", writeMode: "never" }
            }]
          });
          assert.equal(url.pathname, "/internal/runtime/workspace-pass/tools/forum_read");
          const input = await request.json();
          if (input.action === "search_topics") return Response.json({ topics: [{
            author: "Forum User",
            category: "platform-help",
            createdAt: "2026-08-21T00:30:00.000Z",
            excerpt: "Please improve onboarding",
            id: "topic-1",
            lastActiveAt: "2026-08-21T00:45:00.000Z",
            replyCount: 0,
            tags: ["adoption"],
            title: "Onboarding feedback"
          }] });
          if (input.action === "get_topic") return Response.json({ topic: {
            id: "topic-1",
            title: "Onboarding feedback",
            category: "platform-help",
            lastActiveAt: "2026-08-21T00:45:00.000Z",
            posts: [{ author: "Forum User", bodyMarkdown: "Please improve onboarding", createdAt: "2026-08-21T00:30:00.000Z" }]
          } });
          return Response.json({ error: "not_found" }, { status: 404 });
        }
      },
      APPS_CONTROL_PLANE: {
        async fetch(request) {
          assert.equal(request.headers.get("authorization"), "Bearer runtime-service-token");
          const pathname = new URL(request.url).pathname;
          if (pathname === "/internal/runtime/mates") return Response.json({ mates: [{ activeReleaseId: "cortana-r1", id: "cortana", orgId: "example-org", ownerUserId: "owner-1" }] });
          assert.equal(pathname, "/internal/runtime/mates/cortana");
          return Response.json(definition);
        }
      },
      WORKSPACE_MAIL_SECRET:"test-workspace-mail-service-secret-at-least-32-characters",
      WORKSPACE_MAIL:{async fetch(request){const message=await request.json();emails.push(message);return Response.json({status:"sent",messageId:"<provider-message-1@example.com>"});}},
      RUNTIME_DB: d1,
      MATE_AUTH_SERVICE_TOKEN: "auth-runtime-token",
      MATE_RUNTIME_SERVICE_TOKEN: "runtime-service-token"
    };

    const result = await runMateScheduleNow(env, "cortana", "reminder_cortana_forum_daily", new Date("2026-08-21T01:00:00.000Z"));
    assert.equal(result.task.status, "completed");
    assert.equal(forumCalls.length, 3);
    assert.equal(emails.length, 1);
    assert.equal(emails[0].to, "ai-adoption@example.invalid");
    assert.match(emails[0].subject, /^\[CORTANA-[A-HJ-NP-Z2-9]{4}\]/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mate_tasks WHERE mate_id = 'cortana' AND user_id = 'owner-1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mate_todos WHERE mate_id = 'cortana' AND user_id = 'owner-1'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mate_runtime_cursors").get().count, 0);
    assert.equal(sqlite.prepare("SELECT status FROM mate_reminders WHERE mate_id = 'cortana' AND user_id = 'legacy-owner' AND id = 'reminder_cortana_forum_daily'").get().status, "paused");
  });
});

it('executes a remote MCP write only after approval for the exact current user, connection and tool version', async () => {
  const { d1, sqlite } = database();
  try {
    const definition = configuredOperationsDefinition(), user = principal('user-a');
    const { executeRemoteMcpWriteTask, decideAndExecuteRemoteMcpApproval } = await import('./remoteMcpExecutor.ts');
    let digest = 'digest-1', calls = 0;
    const env = { ...testInstallation,  RUNTIME_DB: d1, REMOTE_MCP_ENABLED: '1', MATE_MCP_SERVICE_TOKEN: 'private-service', AUTH_SERVICE: { async fetch(request) {
      assert.equal(request.headers.get('authorization'), 'Bearer private-service');
      const body = await request.json(); assert.equal(body.userId, 'user-a'); assert.equal(body.mateId, definition.mate.id);
      if (request.url.endsWith('/tools')) return Response.json({ connections: [{ id: 'conn', name: 'Service', generation: 1,
        tools: [{ name: 'write', inputSchema: { type: 'object' }, digest, readOnly: false }] }] });
      assert.equal(body.approved, true); calls++; return Response.json({ result: { content: [{ type: 'text', text: 'saved' }] } });
    } } };
    const operation = { type: 'remote_mcp_tool_call', connectionId: 'conn', generation: 1, toolName: 'write', digest, arguments: { title: 'Meeting' } };
    const task = await createTask(d1, definition, user, 'live', { channel: 'email', instruction: 'Save meeting' });
    const pending = await executeRemoteMcpWriteTask(env, definition, user, 'live', task.id, { operation });
    assert.equal(pending.approval.status, 'pending'); assert.equal(calls, 0);
    await assert.rejects(decideAndExecuteRemoteMcpApproval(env, definition, principal('user-b'), 'live', pending.approval.id, 'approve'));
    const completed = await decideAndExecuteRemoteMcpApproval(env, definition, user, 'live', pending.approval.id, 'approve');
    assert.equal(completed.task.status, 'completed'); assert.equal(calls, 1);
    await assert.rejects(decideAndExecuteRemoteMcpApproval(env, definition, user, 'live', pending.approval.id, 'approve'));
    const changedTask = await createTask(d1, definition, user, 'live', { channel: 'email', instruction: 'Save another meeting' });
    const stale = await executeRemoteMcpWriteTask(env, definition, user, 'live', changedTask.id, { operation });
    digest = 'digest-2';
    const rejected = await decideAndExecuteRemoteMcpApproval(env, definition, user, 'live', stale.approval.id, 'approve');
    assert.equal(rejected.task.status, 'failed'); assert.equal(calls, 1);
  } finally { sqlite.close(); }
});
