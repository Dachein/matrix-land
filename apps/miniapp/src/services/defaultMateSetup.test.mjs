import assert from "node:assert/strict";
import { test } from "node:test";
import { provisionDefaultMate } from "./defaultMateSetup.ts";
import { AuthRequiredError } from "./auth.ts";

const input = { displayName: "测试 Mate", avatarUrl: "https://example.com/mate.webp" };
const mate = (status) => ({ id: "mate-1", isDefault: true, displayName: input.displayName, status });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness(activate, read) {
  const steps = [];
  let poll, cancelled = false;
  const result = provisionDefaultMate(input, {
    activate, read, onProgress: (step) => steps.push(step),
    schedule: (fn) => { poll = fn; return 123; },
    cancel: (timer) => { assert.equal(timer, 123); cancelled = true; }
  });
  return { result, steps, poll: () => poll(), cancelled: () => cancelled };
}

test("uses saved provisioning states, never regresses or opens chat before confirmation", async () => {
  const activation = deferred();
  let current = null;
  const h = harness(() => activation.promise, async () => current);
  for (const status of [null, "draft", "deployed", "draft", "published"]) {
    current = status ? mate(status) : null;
    h.poll(); await settle();
  }
  assert.deepEqual(h.steps, ["create", "configure", "publish"]);
  activation.resolve(mate("published"));
  assert.equal((await h.result).id, "mate-1");
  assert.equal(h.steps.at(-1), "open");
  assert.equal(h.cancelled(), true);
});

test("a late poll cannot overwrite success or start more requests", async () => {
  const activation = deferred(), reading = deferred();
  let reads = 0;
  const h = harness(() => activation.promise, () => { reads++; return reading.promise; });
  h.poll(); h.poll();
  assert.equal(reads, 1);
  activation.resolve(mate("published")); await h.result;
  reading.resolve(mate("draft")); await settle();
  h.poll();
  assert.deepEqual(h.steps, ["create", "open"]);
  assert.equal(reads, 1);
});

test("recovers a published Mate after request timeout without creating a second one", async () => {
  let activations = 0;
  const h = harness(async () => { activations++; throw new Error("request:fail timeout"); }, async () => mate("published"));
  assert.equal((await h.result).id, "mate-1");
  assert.equal(activations, 1);
  assert.deepEqual(h.steps, ["create", "open"]);
  assert.equal(h.cancelled(), true);
});

test("an incomplete Mate is never allowed to enter chat", async () => {
  const h = harness(async () => mate("deployed"), async () => mate("deployed"));
  await assert.rejects(h.result, /default_mate_not_published/);
  assert.deepEqual(h.steps, ["create"]);
  assert.equal(h.cancelled(), true);
});

test("keeps activation failures when recovery finds an unfinished Mate", async () => {
  const failure = new Error("mate_definition_invalid");
  const h = harness(async () => { throw failure; }, async () => mate("draft"));
  await assert.rejects(h.result, (error) => error === failure);
  assert.equal(h.cancelled(), true);
});

test("authentication errors propagate from activation and recovery", async () => {
  const auth = new AuthRequiredError();
  let reads = 0;
  const direct = harness(async () => { throw auth; }, async () => { reads++; return mate("published"); });
  await assert.rejects(direct.result, (error) => error === auth);
  assert.equal(reads, 0);
  const recovery = harness(async () => { throw new Error("timeout"); }, async () => { throw auth; });
  await assert.rejects(recovery.result, (error) => error === auth);
  assert.equal(direct.cancelled(), true);
  assert.equal(recovery.cancelled(), true);
});

test("a failed progress read does not interrupt successful activation", async () => {
  const activation = deferred();
  const h = harness(() => activation.promise, async () => { throw new Error("network failed"); });
  h.poll(); await settle();
  activation.resolve(mate("published")); await h.result;
  assert.deepEqual(h.steps, ["create", "open"]);
});
