import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failUsageRollupAndRethrow } from "./index.ts";

describe("token usage nightly rollup failure handling", () => {
  it("preserves the original rollup error when staging cleanup also fails", async () => {
    const originalError = new Error("source_collection_failed");
    const cleanupError = new Error("staging_cleanup_failed");
    const db = failingBatchDb(cleanupError);
    const originalConsoleError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);

    try {
      await assert.rejects(
        failUsageRollupAndRethrow(db, {
          id: "run-failed",
          completedAt: "2026-07-14T00:00:00.000Z",
          errorCode: "source_collection_failed"
        }, originalError),
        (error) => error === originalError
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(db.batchCalls, 1);
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "token_usage_rollup_error_record_failed");
    assert.equal(logged[0][1].runId, "run-failed");
  });
});

function failingBatchDb(error) {
  return {
    batchCalls: 0,
    prepare(sql) {
      const statement = {
        sql,
        bind() {
          return statement;
        }
      };
      return statement;
    },
    async batch() {
      this.batchCalls += 1;
      throw error;
    }
  };
}
