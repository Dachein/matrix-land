import assert from "node:assert/strict";
import test from "node:test";
import { fetchReadWithRetry } from "./readRetry.ts";

test("file and approval reads recover from transient network and service errors", async () => {
  let calls = 0;
  const response = await fetchReadWithRetry(async (_url, init) => {
    assert.equal(init.method, "GET");
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return new Response(calls === 2 ? "Unavailable" : "File content", { status: calls === 2 ? 503 : 200 });
  }, "https://runtime.example.test/file", {}, async () => {});
  assert.equal(calls, 3);
  assert.equal(await response.text(), "File content");
});

test("denied access is not retried, writes are rejected, and outages remain bounded", async () => {
  for (const status of [401, 403, 404, 422, 503]) {
    let calls = 0;
    await fetchReadWithRetry(async () => { calls++; return new Response("", { status }); }, "https://runtime.example.test/file", {}, async () => {});
    assert.equal(calls, status === 503 ? 3 : 1);
  }
  await assert.rejects(fetchReadWithRetry(async () => { throw new Error("must not execute"); }, "https://runtime.example.test/decision", { method: "POST" }), /requires_get/);
});

test("an aborted read is not restarted", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchReadWithRetry(async () => { calls++; }, "https://runtime.example.test/file", { signal: controller.signal }));
  assert.equal(calls, 0);
});
