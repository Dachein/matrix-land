import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  appendMemoryEntry,
  createMemoryCompaction,
  listOriginalMemoryEntries,
  readCompactedMemoryContext
} from "./memoryStorage.ts";

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
  async run() { this.statement.run(...this.params); return { success: true }; }
}

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../db/migrations/0002_runtime_v1.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../db/migrations/0004_memory_artifacts.sql", import.meta.url), "utf8"));
  return new D1Adapter(sqlite);
}

function principal(userId) {
  return {
    callerKind: "user",
    orgId: "org-1",
    scopes: ["mate:invoke"],
    userId
  };
}

const mateId = "knowledge-mate";
const scope = { id: "conversation-1001", kind: "conversation" };

describe("Mate conversation memory storage", () => {
  it("keeps originals while applying an iterative compaction overlay", async () => {
    const db = database();
    const user = principal("user-a");
    const messages = [
      ["user_message", { text: "Please review the portfolio." }],
      ["assistant_message", { text: "Which account?" }],
      ["user_message", { text: "Account 42." }],
      ["tool_result", { account: "42", status: "reviewed" }],
      ["assistant_message", { text: "The review is complete." }]
    ];
    for (const [entryKind, payload] of messages) {
      await appendMemoryEntry(db, mateId, user, "live", scope, { entryKind, payload });
    }

    const first = await createMemoryCompaction(db, mateId, user, "live", scope, {
      fromSequence: 2,
      modelId: "summary-model-v1",
      policyVersion: "memory-policy-v1",
      releaseId: "knowledge-mate-r1",
      summary: {
        decisions: ["Review account 42"],
        openItems: [],
        summary: "The user selected account 42 and it was reviewed."
      },
      toSequence: 4
    });
    assert.equal(first.fromSequence, 2);
    assert.equal(first.toSequence, 4);

    const compacted = await readCompactedMemoryContext(db, mateId, user, "live", scope);
    assert.equal(compacted.originalEntryCount, 5);
    assert.deepEqual(compacted.entries.map((entry) => entry.entryKind), [
      "user_message", "compaction_summary", "assistant_message"
    ]);
    assert.deepEqual(compacted.entries[1].sequenceRange, { from: 2, to: 4 });
    assert.equal((await listOriginalMemoryEntries(db, mateId, user, "live", scope)).length, 5);

    const second = await createMemoryCompaction(db, mateId, user, "live", scope, {
      fromSequence: 2,
      modelId: "summary-model-v1",
      policyVersion: "memory-policy-v1",
      releaseId: "knowledge-mate-r1",
      summary: {
        decisions: ["Review account 42"],
        openItems: [],
        summary: "Account 42 was selected, reviewed, and reported complete."
      },
      toSequence: 5
    });
    assert.equal(second.previousCompactionId, first.id);
    assert.equal(second.toSequence, 5);
    assert.equal((await listOriginalMemoryEntries(db, mateId, user, "live", scope)).length, 5);

    await assert.rejects(
      () => createMemoryCompaction(db, mateId, user, "live", scope, {
        fromSequence: 3,
        modelId: "summary-model-v1",
        policyVersion: "memory-policy-v1",
        releaseId: "knowledge-mate-r1",
        summary: { summary: "This would discard part of the active range." },
        toSequence: 5
      }),
      (error) => error?.code === "memory_compaction_must_expand_active_range"
    );
  });

  it("isolates memory by current user and runtime mode", async () => {
    const db = database();
    await appendMemoryEntry(db, mateId, principal("user-a"), "live", scope, {
      entryKind: "user_message",
      payload: { text: "live and private" }
    });
    await appendMemoryEntry(db, mateId, principal("user-a"), "preview", scope, {
      entryKind: "user_message",
      payload: { text: "preview and private" }
    });

    assert.equal((await listOriginalMemoryEntries(db, mateId, principal("user-a"), "live", scope)).length, 1);
    assert.equal((await listOriginalMemoryEntries(db, mateId, principal("user-a"), "preview", scope)).length, 1);
    assert.equal((await listOriginalMemoryEntries(db, mateId, principal("user-b"), "live", scope)).length, 0);
  });

  it("rejects authority and credential fields from memory payloads", async () => {
    const db = database();
    await assert.rejects(
      () => appendMemoryEntry(db, mateId, principal("user-a"), "live", scope, {
        entryKind: "tool_result",
        payload: { nested: { authorization: "Bearer should-not-be-stored" } }
      }),
      (error) => error?.code === "memory_authority_field_forbidden"
    );
    await assert.rejects(
      () => appendMemoryEntry(db, mateId, principal("user-a"), "live", scope, {
        entryKind: "tool_result",
        payload: { credentials: { password: "should-not-be-stored" } }
      }),
      (error) => error?.code === "memory_authority_field_forbidden"
    );
  });
});
