import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hydrateSessionMate, isRuntimeSessionExpired, isRuntimeSessionInvalid, reuseRuntimeSession, shouldRefreshSession } from "./sessionRecovery.ts";

const base = {
  accessToken: "token",
  conversationId: "conversation",
  conversationState: "persisted",
  expiresAt: "2026-09-17T10:10:00.000Z",
  principalKey: "principal",
  mate: { id: "mate", displayName: "Mate", jobRole: "助手", description: "" }
};

describe("miniapp runtime session recovery", () => {
  it("keeps a session with more than one minute remaining", () => {
    assert.equal(shouldRefreshSession(base, Date.parse("2026-09-17T10:08:59.000Z")), false);
  });

  it("refreshes an expired or nearly expired session", () => {
    assert.equal(shouldRefreshSession(base, Date.parse("2026-09-17T10:09:00.000Z")), true);
    assert.equal(shouldRefreshSession({ ...base, expiresAt: "invalid" }, Date.now()), true);
  });

  it("recognizes runtime token rejection from API errors", () => {
    assert.equal(isRuntimeSessionInvalid({ status: 401, code: "runtime_token_invalid" }), true);
    assert.equal(isRuntimeSessionInvalid(new Error("runtime_token_invalid")), true);
  });

  it("does not retry unrelated failures as session expiry", () => {
    assert.equal(isRuntimeSessionInvalid({ status: 500, code: "runtime_unavailable" }), false);
    assert.equal(isRuntimeSessionInvalid(new Error("聊天连接失败")), false);
  });
});

describe("miniapp conversation switching", () => {
  it("hydrates mate details omitted by the sessions API", () => {
    const mate = { id: "mate", displayName: "Cortana", jobRole: "Assistant", description: "", avatarUrl: "/avatar.png" };
    const session = hydrateSessionMate({
      accessToken: "token",
      conversationId: "conversation-3",
      conversationState: "persisted",
      expiresAt: "2026-09-17T10:10:00.000Z",
      principalKey: "principal"
    }, mate);
    assert.deepEqual(session.mate, mate);
  });

  it("preserves selected mate fields when the API returns only a partial mate", () => {
    const mate = { id: "mate", displayName: "Cortana", jobRole: "Assistant", description: "", avatarUrl: "/avatar.png" };
    const session = hydrateSessionMate({
      accessToken: "token",
      conversationId: "conversation-3",
      conversationState: "persisted",
      expiresAt: "2026-09-17T10:10:00.000Z",
      principalKey: "principal",
      mate: { id: "mate", displayName: "Cortana AI" }
    }, mate);
    assert.deepEqual(session.mate, { ...mate, displayName: "Cortana AI" });
  });

  const now = Date.parse("2026-09-17T10:00:00.000Z");

  it("reuses a runtime session that still has more than the skew window left", () => {
    assert.equal(isRuntimeSessionExpired(base, now, 30_000), false);
  });

  it("treats a nearly expired or unparseable token as unusable", () => {
    assert.equal(isRuntimeSessionExpired({ ...base, expiresAt: "2026-09-17T10:00:30.000Z" }, now, 30_000), true);
    assert.equal(isRuntimeSessionExpired({ ...base, expiresAt: "invalid" }, now, 30_000), true);
  });

  it("moves only conversation identity when reusing a session", () => {
    const next = reuseRuntimeSession(base, { id: "conversation-2", title: "第二次对话" });
    assert.equal(next.conversationId, "conversation-2");
    assert.equal(next.conversationState, "persisted");
    // Runtime-level identity must survive untouched, otherwise the token cannot be reused.
    assert.equal(next.accessToken, base.accessToken);
    assert.equal(next.expiresAt, base.expiresAt);
    assert.equal(next.principalKey, base.principalKey);
    assert.equal(next.mate, base.mate);
  });

  it("does not mutate the session it is given", () => {
    reuseRuntimeSession(base, { id: "conversation-2", title: "第二次对话" });
    assert.equal(base.conversationId, "conversation");
  });
});
