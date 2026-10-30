import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMateEntry } from "./mateEntry.ts";
import { AuthRequiredError } from "./auth.ts";
const mate = { id: "mine", isDefault: true, status: "published" };
test("enters a published default Mate without depending on inventory", async () => {
  const result = await loadMateEntry({ readDefault: async () => mate, list: async () => { throw new Error("inventory unavailable"); } });
  assert.equal(result.mate, mate);
});
test("an authoritative missing default is a valid first-setup state", async () => {
  assert.equal((await loadMateEntry({ readDefault: async () => null, list: async () => { throw new Error("must not list"); } })).mate, null);
});
test("uses a confirmed default from the list after a default-read transport failure", async () => {
  const result = await loadMateEntry({ readDefault: async () => { throw new Error("timeout"); }, list: async () => [mate] });
  assert.equal(result.mate, mate);
});
test("never mistakes an unconfirmed default for a new user", async () => {
  await assert.rejects(loadMateEntry({ readDefault: async () => { throw new Error("timeout"); }, list: async () => [] }), /timeout/);
});
test("authentication failure goes to login rather than using stale identity", async () => {
  await assert.rejects(loadMateEntry({ readDefault: async () => { throw new AuthRequiredError(); }, list: async () => [mate] }), AuthRequiredError);
});
