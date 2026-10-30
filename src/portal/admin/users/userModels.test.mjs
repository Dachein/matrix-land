import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { userSummary } from "./userModels.ts";

const nowMs = Date.parse("2026-07-13T00:00:00.000Z");

function user(id, { lastSeenAt, status }) {
  return {
    email: `${id}@example.test`,
    id,
    lastSeenAt,
    name: id,
    role: "member",
    status,
    team: "Workspace"
  };
}

describe("admin user summary", () => {
  it("counts only active users as activated and all recent timestamps as recent logins", () => {
    const summary = userSummary([
      user("active-recent", { lastSeenAt: "2026-07-12T00:00:00.000Z", status: "active" }),
      user("active-old", { lastSeenAt: "2026-07-04T00:00:00.000Z", status: "active" }),
      user("invited-recent", { lastSeenAt: "2026-07-12T23:00:00.000Z", status: "invited" }),
      user("inactive-recent", { lastSeenAt: "2026-07-12T22:00:00.000Z", status: "inactive" }),
      user("suspended-recent", { lastSeenAt: "2026-07-12T21:00:00.000Z", status: "suspended" })
    ], nowMs);

    assert.equal(summary.total, 5);
    assert.equal(summary.activated, 2);
    assert.equal(summary.recent, 4);
  });

  it("excludes the seven-day boundary and future timestamps", () => {
    const summary = userSummary([
      user("inside-window", { lastSeenAt: "2026-07-06 00:00:01", status: "active" }),
      user("boundary", { lastSeenAt: "2026-07-06T00:00:00.000Z", status: "active" }),
      user("future", { lastSeenAt: "2026-07-13T00:00:01.000Z", status: "active" })
    ], nowMs);

    assert.equal(summary.activated, 3);
    assert.equal(summary.recent, 1);
  });
});
