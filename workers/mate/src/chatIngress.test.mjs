import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { claimChatIngress } from "./chatIngress.ts";

class D1Adapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database.prepare(sql)); }
  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const output = [];
      for (const statement of statements) output.push(await statement.run());
      this.database.exec("COMMIT");
      return output;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class Statement {
  constructor(statement, params = []) { this.statement = statement; this.params = params; }
  bind(...params) { return new Statement(this.statement, params); }
  async all() { return { results: this.statement.all(...this.params) }; }
  async first() { return this.statement.get(...this.params) ?? null; }
  async run() {
    const result = this.statement.run(...this.params);
    return { meta: { changes: Number(result.changes ?? 0) }, success: true };
  }
}

const baselineMigration = readFileSync(new URL("../db/migrations/0002_runtime_v1.sql", import.meta.url), "utf8");
const chatIngressMigration = readFileSync(new URL("../db/migrations/0006_chat_ingress.sql", import.meta.url), "utf8");
const initialTime = "2026-08-27T01:00:00.000Z";
const messageDigest = `sha256:${"1".repeat(64)}`;
const environmentDigest = `sha256:${"2".repeat(64)}`;

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(baselineMigration);
  sqlite.exec(chatIngressMigration);
  return { d1: new D1Adapter(sqlite), sqlite };
}

function addTask(sqlite, input = {}) {
  const mateId = input.mateId ?? "knowledge-mate";
  const userId = input.userId ?? "user-a";
  const mode = input.mode ?? "live";
  const conversationId = input.conversationId ?? "conversation-1001";
  const releaseId = input.releaseId ?? "knowledge-release-1";
  const taskId = input.taskId ?? "task-1001";
  const sessionId = input.sessionId ?? `session-${taskId}`;
  sqlite.prepare(`
    INSERT OR IGNORE INTO mate_conversations (
      mate_id, user_id, runtime_mode, id, title, channel, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'sdk', 'active', ?, ?)
  `).run(mateId, userId, mode, conversationId, initialTime, initialTime);
  sqlite.prepare(`
    INSERT INTO mate_sessions (
      mate_id, user_id, runtime_mode, id, kind, channel, conversation_id,
      release_id, context_json, status, created_at
    ) VALUES (?, ?, ?, ?, 'conversation_turn', 'sdk', ?, ?, '{}', 'open', ?)
  `).run(mateId, userId, mode, sessionId, conversationId, releaseId, initialTime);
  sqlite.prepare(`
    INSERT INTO mate_tasks (
      mate_id, user_id, runtime_mode, id, session_id, conversation_id,
      root_task_id, release_id, channel, status, instruction, context_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sdk', 'queued', ?, '{}', ?, ?)
  `).run(
    mateId,
    userId,
    mode,
    taskId,
    sessionId,
    conversationId,
    taskId,
    releaseId,
    `client-message-ref:${taskId}`,
    initialTime,
    initialTime
  );
  return { conversationId, mode, releaseId, taskId, mateId, userId };
}

function claim(task, overrides = {}) {
  return {
    agentInstanceName: "tm3-agent-instance-1",
    clientMessageId: "client-message-1",
    environmentDigest,
    messageDigest,
    ...task,
    ...overrides
  };
}

function at(value) {
  return { now: () => new Date(value) };
}

describe("Mate chat ingress projection", () => {
  it("uses a replay-safe metadata-only migration", () => {
    const { sqlite } = database();
    sqlite.exec(chatIngressMigration);
    const columns = sqlite.prepare("PRAGMA table_info(mate_chat_ingress)").all().map((row) => row.name);
    assert.deepEqual(columns, [
      "mate_id",
      "user_id",
      "runtime_mode",
      "conversation_id",
      "client_message_id",
      "release_id",
      "task_id",
      "agent_instance_name",
      "message_digest",
      "environment_digest",
      "created_at",
      "updated_at"
    ]);
    assert.equal(columns.some((name) => /body|content|instruction|payload|text/i.test(name)), false);
    const indexes = sqlite.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'mate_chat_ingress'
      ORDER BY name
    `).all().map((row) => row.name);
    assert.ok(indexes.includes("idx_mate_chat_ingress_task"));
    assert.ok(indexes.includes("idx_mate_chat_ingress_conversation_activity"));
    assert.ok(indexes.includes("idx_mate_chat_ingress_agent_activity"));
  });

  it("claims once and returns the original Task for an identical replay", async () => {
    const { d1, sqlite } = database();
    const task = addTask(sqlite);
    const input = claim(task, { transcriptBody: "must never be persisted" });
    const first = await claimChatIngress(d1, input, at("2026-08-27T02:00:00.000Z"));
    const replayed = await claimChatIngress(d1, input, at("2026-08-27T02:05:00.000Z"));

    assert.equal(first.disposition, "claimed");
    assert.equal(replayed.disposition, "replayed");
    assert.equal(replayed.taskId, first.taskId);
    assert.equal(replayed.createdAt, first.createdAt);
    assert.equal(replayed.updatedAt, "2026-08-27T02:05:00.000Z");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mate_chat_ingress").get().count, 1);
    assert.equal(
      sqlite.prepare("SELECT updated_at FROM mate_conversations WHERE id = ?").get(task.conversationId).updated_at,
      "2026-08-27T02:05:00.000Z"
    );
    assert.doesNotMatch(JSON.stringify(sqlite.prepare("SELECT * FROM mate_chat_ingress").get()), /must never be persisted/);
  });

  it("coalesces concurrent identical claims into one mapping", async () => {
    const { d1, sqlite } = database();
    const input = claim(addTask(sqlite));
    const results = await Promise.all([
      claimChatIngress(d1, input, at("2026-08-27T02:00:00.000Z")),
      claimChatIngress(d1, input, at("2026-08-27T02:00:01.000Z"))
    ]);

    assert.deepEqual(results.map((result) => result.disposition).sort(), ["claimed", "replayed"]);
    assert.deepEqual(new Set(results.map((result) => result.taskId)), new Set([input.taskId]));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mate_chat_ingress").get().count, 1);
    assert.equal(sqlite.prepare("SELECT updated_at FROM mate_chat_ingress").get().updated_at, "2026-08-27T02:00:01.000Z");
  });

  it("rejects a reused isolation key when its projection or input digests change", async () => {
    const { d1, sqlite } = database();
    const task = addTask(sqlite);
    addTask(sqlite, { ...task, taskId: "task-1002", sessionId: "session-task-1002" });
    const input = claim(task);
    await claimChatIngress(d1, input);

    for (const [field, value, expectedField] of [
      ["releaseId", "knowledge-release-2", "releaseId"],
      ["taskId", "task-1002", "taskId"],
      ["agentInstanceName", "tm3-agent-instance-2", "agentInstanceName"],
      ["messageDigest", `sha256:${"3".repeat(64)}`, "messageDigest"],
      ["environmentDigest", `sha256:${"4".repeat(64)}`, "environmentDigest"]
    ]) {
      await assert.rejects(
        () => claimChatIngress(d1, { ...input, [field]: value }),
        (error) => error?.status === 409
          && error?.code === "chat_ingress_claim_conflict"
          && error?.details?.conflictingFields?.includes(expectedField)
      );
    }
  });

  it("requires canonical SHA-256 digests without persisting their source values", async () => {
    const { d1, sqlite } = database();
    const input = claim(addTask(sqlite));
    for (const [field, value, code] of [
      ["messageDigest", "1".repeat(64), "chat_ingress_message_digest_invalid"],
      ["messageDigest", `sha256:${"A".repeat(64)}`, "chat_ingress_message_digest_invalid"],
      ["messageDigest", ` sha256:${"1".repeat(64)}`, "chat_ingress_message_digest_invalid"],
      ["environmentDigest", "sha256:short", "chat_ingress_environment_digest_invalid"]
    ]) {
      await assert.rejects(
        () => claimChatIngress(d1, { ...input, [field]: value }),
        (error) => error?.status === 422 && error?.code === code
      );
    }
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mate_chat_ingress").get().count, 0);
  });

  it("isolates the same client message across Mate, user, mode, and Conversation", async () => {
    const { d1, sqlite } = database();
    const tasks = [
      addTask(sqlite, { taskId: "task-a-live-1" }),
      addTask(sqlite, { taskId: "task-b-live-1", userId: "user-b" }),
      addTask(sqlite, { mode: "preview", taskId: "task-a-preview-1" }),
      addTask(sqlite, { conversationId: "conversation-2002", taskId: "task-a-live-2" }),
      addTask(sqlite, { taskId: "task-other-live-1", mateId: "other-mate" })
    ];

    for (const [index, task] of tasks.entries()) {
      const result = await claimChatIngress(d1, claim(task, {
        agentInstanceName: `tm3-agent-instance-${index + 1}`
      }));
      assert.equal(result.disposition, "claimed");
    }
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mate_chat_ingress").get().count, tasks.length);
  });

  it("preserves email and Unicode user IDs without colliding with their encoded spellings", async () => {
    const { d1, sqlite } = database();
    const ids = ["user+tag@example.test", "user%2Btag%40example.test", "用户/name"];
    for (const [index, userId] of ids.entries()) {
      const task = addTask(sqlite, { userId, taskId: `task-special-${index}` });
      const result = await claimChatIngress(d1, claim(task));
      assert.equal(result.disposition, "claimed");
    }
    assert.deepEqual(sqlite.prepare("SELECT user_id FROM mate_chat_ingress ORDER BY rowid").all().map((row) => row.user_id), ids);
  });

  it("requires the Task projection to match the claimed Conversation and Release", async () => {
    const { d1, sqlite } = database();
    const task = addTask(sqlite);
    await assert.rejects(
      () => claimChatIngress(d1, claim(task, { conversationId: "conversation-elsewhere" })),
      (error) => error?.status === 409
        && error?.code === "chat_ingress_task_projection_conflict"
        && error?.details?.conflictingFields?.includes("conversationId")
    );
    await assert.rejects(
      () => claimChatIngress(d1, claim(task, { releaseId: "knowledge-release-2" })),
      (error) => error?.status === 409
        && error?.code === "chat_ingress_task_projection_conflict"
        && error?.details?.conflictingFields?.includes("releaseId")
    );
  });
});
