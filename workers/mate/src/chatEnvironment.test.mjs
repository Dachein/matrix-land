import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pinChatEnvironment, verifyPinnedChatEnvironment } from "./chatEnvironment.ts";

function environment(revision, ref = "pf_123", instanceId) {
  return {
    schemaVersion: "workspace.mate-environment/v1",
    revision,
    host: { appId: "portfolio", surface: "embedded", ...(instanceId ? { instanceId } : {}) },
    location: { kind: "portfolio.portfolio", ref }
  };
}

describe("Mate Chat Environment pin", () => {
  it("accepts a complete host snapshot and makes same-revision replay idempotent", async () => {
    const first = await pinChatEnvironment(environment(7));
    assert.equal(first.idempotent, false);
    assert.equal(first.pin.envelope.trust, "host_asserted");
    assert.match(first.pin.digest, /^sha256:[a-f0-9]{64}$/);

    const replay = await pinChatEnvironment(environment(7), first.pin);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.pin.digest, first.pin.digest);
  });

  it("rejects stale and conflicting revisions", async () => {
    const current = (await pinChatEnvironment(environment(7))).pin;
    await assert.rejects(
      pinChatEnvironment(environment(6), current),
      (error) => error?.code === "mate_chat_environment_stale"
    );
    await assert.rejects(
      pinChatEnvironment(environment(7, "pf_other"), current),
      (error) => error?.code === "mate_chat_environment_revision_conflict"
    );
  });

  it("allows a new SDK Host mount to restart its own revision sequence", async () => {
    const previousMount = (await pinChatEnvironment(environment(19, "pf_123", "mount-a"))).pin;
    const nextMount = await pinChatEnvironment(environment(1, "pf_123", "mount-b"), previousMount);
    assert.equal(nextMount.idempotent, false);
    assert.equal(nextMount.pin.revision, 1);
    assert.notEqual(nextMount.pin.sourceKey, previousMount.sourceKey);
  });

  it("does not let the client submit an accepted envelope or trust label", async () => {
    const accepted = (await pinChatEnvironment(environment(1))).pin.envelope;
    await assert.rejects(
      pinChatEnvironment(accepted),
      (error) => error?.code === "mate_chat_environment_required"
    );
    assert.deepEqual(await verifyPinnedChatEnvironment(accepted), accepted);
    await assert.rejects(
      verifyPinnedChatEnvironment({ ...accepted, digest: `sha256:${"a".repeat(64)}` }),
      (error) => error?.code === "mate_chat_recovery_context_invalid"
    );
  });
});
