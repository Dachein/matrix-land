import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { acceptWorkspaceMateEnvironment } from "../../../sdk/mate/environment.ts";
import { mateConversationTitle } from "../../../src/shared/mateConversation.ts";
import { chatProjectionIds, digestChatMessage } from "./chatTaskStorage.ts";
import {
  concludeChatTurnProjection,
  createChatTurnProjection,
  startChatTurnProjection
} from "./chatTurnStorage.ts";

class D1Adapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new Statement(this.database.prepare(sql)); }
}

class Statement {
  constructor(statement, params = []) { this.statement = statement; this.params = params; }
  bind(...params) { return new Statement(this.statement, params); }
  async first() { return this.statement.get(...this.params) ?? null; }
  async run() {
    const result = this.statement.run(...this.params);
    return { meta: { changes: Number(result.changes ?? 0) }, success: true };
  }
}

async function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../db/migrations/0002_runtime_v1.sql", import.meta.url), "utf8"));
  database.exec(readFileSync(new URL("../db/migrations/0007_conversation_turn_projection.sql", import.meta.url), "utf8"));
  for (const mode of ["live", "preview"]) {
    database.prepare(`
      INSERT INTO mate_conversations (
        mate_id, user_id, runtime_mode, id, title, channel, status, created_at, updated_at
      ) VALUES ('knowledge-mate', 'user-a', ?, 'conv_12345678', '', 'sdk', 'active', ?, ?)
    `).run(mode, "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z");
  }
  const environment = await acceptWorkspaceMateEnvironment({
    schemaVersion: "workspace.mate-environment/v1",
    revision: 1,
    host: { appId: "portfolio", surface: "embedded" },
    location: { kind: "portfolio.portfolio", ref: "pf_123" }
  });
  return { database, db: new D1Adapter(database), environment };
}

async function input(environment, messageDigest, mode = "live", releaseId = "knowledge-mate-r1") {
  const ids = await chatProjectionIds({
    clientMessageId: "msg_12345678",
    conversationId: "conv_12345678",
    mode,
    releaseId,
    mateId: "knowledge-mate",
    userId: "user-a"
  });
  return {
    agentInstanceName: `mate-chat-${"a".repeat(43)}`,
    clientMessageId: "msg_12345678",
    conversationId: "conv_12345678",
    conversationTitle: "  Show the private portfolio policy  ",
    environment,
    messageDigest,
    mode,
    releaseId,
    mateId: "knowledge-mate",
    turnId: ids.taskId.replace(/^task_chat_/, "turn_chat_"),
    userId: "user-a"
  };
}

describe("Mate Conversation Turn projection", () => {
  it("derives one bounded deterministic title from text or attachment names", () => {
    assert.equal(mateConversationTitle({ text: "  ##  Review   portfolio risk  " }), "Review portfolio risk");
    assert.equal(mateConversationTitle({ attachmentNames: ["allocation.xlsx"] }), "附件：allocation.xlsx");
    assert.equal(mateConversationTitle({ maxLength: 10, text: "123456789012345" }), "123456789…");
  });

  it("writes metadata only, never a business Task, and replays deterministically", async () => {
    const { database, db, environment } = await fixture();
    const question = "Show the private portfolio policy";
    const turn = await input(environment, await digestChatMessage(question));
    const first = await createChatTurnProjection(db, turn);
    const replay = await createChatTurnProjection(db, turn);
    assert.equal(first.disposition, "claimed");
    assert.equal(replay.disposition, "replayed");
    assert.equal(first.turnId, replay.turnId);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM mate_tasks").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM mate_sessions").get().count, 0);
    assert.equal(
      database.prepare("SELECT title FROM mate_conversations WHERE runtime_mode = 'live'").get().title,
      question
    );
    const stored = database.prepare(`
      SELECT message_digest AS messageDigest, environment_digest AS environmentDigest
      FROM mate_conversation_turns WHERE turn_id = ?
    `).get(first.turnId);
    assert.doesNotMatch(JSON.stringify(stored), /Show the private portfolio policy/);
    assert.equal(stored.messageDigest, turn.messageDigest);
    assert.equal(stored.environmentDigest, environment.digest);
  });

  it("keeps the first bounded Conversation title when later turns replay or append", async () => {
    const { database, db, environment } = await fixture();
    const first = await input(environment, await digestChatMessage("first"));
    first.conversationTitle = "  First   customer question  ";
    await createChatTurnProjection(db, first);
    await createChatTurnProjection(db, { ...first, conversationTitle: "Replacement title" });
    assert.equal(
      database.prepare("SELECT title FROM mate_conversations WHERE runtime_mode = 'live'").get().title,
      "First customer question"
    );
  });

  it("enforces the accepted-running-completed lifecycle without storing response text", async () => {
    const { database, db, environment } = await fixture();
    const turn = await input(environment, await digestChatMessage("hello"));
    await createChatTurnProjection(db, turn);
    await startChatTurnProjection(db, turn);
    await concludeChatTurnProjection(db, {
      ...turn,
      assistantMessageId: "assistant-12345678",
      outcome: "completed",
      responseDigest: `sha256:${"a".repeat(64)}`
    });
    const stored = database.prepare(`
      SELECT status, assistant_message_id AS assistantMessageId, response_digest AS responseDigest
      FROM mate_conversation_turns WHERE turn_id = ?
    `).get(turn.turnId);
    assert.deepEqual({ ...stored }, {
      assistantMessageId: "assistant-12345678",
      responseDigest: `sha256:${"a".repeat(64)}`,
      status: "completed"
    });
  });

  it("resumes a connection-cancelled turn and preserves terminal failure codes on replay", async () => {
    const { database, db, environment } = await fixture();
    const cancelled = await input(environment, await digestChatMessage("resume me"));
    await createChatTurnProjection(db, cancelled);
    await startChatTurnProjection(db, cancelled);
    await concludeChatTurnProjection(db, { ...cancelled, outcome: "cancelled" });
    const cancelledReplay = await createChatTurnProjection(db, cancelled);
    assert.equal(cancelledReplay.status, "cancelled");
    await startChatTurnProjection(db, cancelled);
    assert.equal(
      database.prepare("SELECT status FROM mate_conversation_turns WHERE turn_id = ?").get(cancelled.turnId).status,
      "running"
    );

    const failed = await input(environment, await digestChatMessage("fail me"), "preview");
    await createChatTurnProjection(db, failed);
    await startChatTurnProjection(db, failed);
    await concludeChatTurnProjection(db, {
      ...failed,
      errorCode: "mate_model_request_failed",
      outcome: "failed"
    });
    const failedReplay = await createChatTurnProjection(db, failed);
    assert.equal(failedReplay.status, "failed");
    assert.equal(failedReplay.errorCode, "mate_model_request_failed");
  });

  it("rejects client-message reuse with different message or Environment digests", async () => {
    const { db, environment } = await fixture();
    const first = await input(environment, await digestChatMessage("first"));
    await createChatTurnProjection(db, first);
    await assert.rejects(
      createChatTurnProjection(db, { ...first, messageDigest: await digestChatMessage("changed") }),
      (error) => error?.code === "mate_chat_turn_projection_conflict"
    );
    await assert.rejects(
      createChatTurnProjection(db, {
        ...first,
        environment: { ...environment, digest: `sha256:${"b".repeat(64)}` }
      }),
      (error) => error?.code === "mate_chat_turn_projection_conflict"
    );
  });

  it("isolates Live and Preview and includes Release only in Preview ids", async () => {
    const { database, db, environment } = await fixture();
    const digest = await digestChatMessage("same turn");
    const live = await input(environment, digest, "live");
    const preview = await input(environment, digest, "preview");
    await createChatTurnProjection(db, live);
    await createChatTurnProjection(db, preview);
    assert.notEqual(live.turnId, preview.turnId);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM mate_conversation_turns").get().count, 2);

    const liveRollover = await input(environment, digest, "live", "knowledge-mate-r2");
    const previewRollover = await input(environment, digest, "preview", "knowledge-mate-r2");
    assert.equal(live.turnId, liveRollover.turnId);
    assert.notEqual(preview.turnId, previewRollover.turnId);
  });
});
