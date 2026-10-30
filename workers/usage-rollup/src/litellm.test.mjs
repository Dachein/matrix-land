import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLiteLlmSnapshotClient } from "./litellm.ts";

describe("LiteLLM snapshot pagination", () => {
  it("uses raw page occupancy so filtered users and keys do not truncate later pages", async () => {
    const requested = [];
    const client = createLiteLlmSnapshotClient({
      LITELLM_PROVISIONING_KEY: "test-provisioning-key",
      LITELLM_URL: "https://token.example.test"
    }, async (input) => {
      const url = new URL(String(input));
      requested.push(`${url.pathname}?${url.searchParams.toString()}`);

      if (url.pathname === "/user/list") {
        const page = Number(url.searchParams.get("page"));
        return jsonResponse(page === 1
          ? { users: [
            { user_id: "default_user_id", max_budget: 0 },
            ...Array.from({ length: 99 }, (_, index) => ({
              user_id: `user-${index}@example.com`,
              max_budget: index + 1
            }))
          ] }
          : { users: [{ user_id: "last-user@example.com", max_budget: 500 }] });
      }

      if (url.pathname === "/key/list") {
        const page = Number(url.searchParams.get("page"));
        return jsonResponse(page === 1
          ? { keys: [
            { token_hash: "unowned-token" },
            ...Array.from({ length: 99 }, (_, index) => ({
              token_hash: `hash-${index}`,
              user_id: `user-${index}@example.com`
            }))
          ] }
          : { keys: [{ token_hash: "hash-last", user_id: "last-user@example.com" }] });
      }

      return jsonResponse({}, 404);
    });

    const budgets = await client.listUserBudgets();
    const tokenUsers = await client.listTokenUsers();

    assert.equal(budgets.size, 100);
    assert.equal(budgets.get("last-user@example.com"), 500);
    assert.equal(tokenUsers.size, 100);
    assert.equal(tokenUsers.get("hash-last"), "last-user@example.com");
    assert.equal(requested.filter((path) => path.startsWith("/user/list?")).length, 2);
    assert.equal(requested.filter((path) => path.startsWith("/key/list?")).length, 2);
  });

  it("streams v2 spend logs page by page for one exact Shanghai day", async () => {
    const requested = [];
    const client = createLiteLlmSnapshotClient({
      LITELLM_PROVISIONING_KEY: "test-provisioning-key",
      LITELLM_URL: "https://token.example.test"
    }, async (input) => {
      const url = new URL(String(input));
      requested.push(`${url.pathname}?${url.searchParams.toString()}`);
      const page = Number(url.searchParams.get("page"));
      return jsonResponse({
        data: [{ request_id: `request-${page}` }],
        page,
        total_pages: 2
      });
    });

    const pages = [];
    for await (const page of client.spendLogPages("2026-08-19", "2026-08-19")) {
      pages.push(page);
    }

    assert.deepEqual(pages.flat().map((row) => row.request_id), ["request-1", "request-2"]);
    assert.equal(requested.length, 2);
    assert.match(requested[0], /^\/spend\/logs\/v2\?/);
    assert.match(requested[0], /start_date=2026-08-18\+16%3A00%3A00/);
    assert.match(requested[0], /end_date=2026-08-19\+16%3A00%3A00/);
    assert.match(requested[0], /page_size=100/);
    assert.match(requested[1], /page=2/);
  });

  it("rejects a single day that exceeds the bounded v2 page scan", async () => {
    const client = createLiteLlmSnapshotClient({
      LITELLM_PROVISIONING_KEY: "test-provisioning-key",
      LITELLM_URL: "https://token.example.test"
    }, async () => jsonResponse({ data: [], page: 1, total_pages: 501 }));

    await assert.rejects(async () => {
      for await (const _page of client.spendLogPages("2026-08-19", "2026-08-19")) {
        // Consume the generator so validation runs.
      }
    }, /litellm_spend_logs_truncated/);
  });
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
