import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ACTIVITY_EVENT_LIMIT,
  MAX_ACTIVITY_EVENT_LIMIT,
  normalizeActivityActionType,
  normalizeActivityLimit,
  normalizeActivityScenario,
  normalizeActivityTargetType,
  normalizeActivityVisibility
} from "./normalizers.ts";

describe("activity normalizers", () => {
  it("keeps supported scenarios and drops unknown values", () => {
    assert.equal(normalizeActivityScenario("agent"), "agent");
    assert.equal(normalizeActivityScenario("community"), "community");
    assert.equal(normalizeActivityScenario("apps"), "apps");
    assert.equal(normalizeActivityScenario("forum"), undefined);
  });

  it("normalizes action, target, and visibility fallbacks", () => {
    assert.equal(normalizeActivityActionType("apps.app.published"), "apps.app.published");
    assert.equal(normalizeActivityActionType("agent.run.completed"), "agent.run.completed");
    assert.equal(normalizeActivityActionType("agent."), "forum.topic.created");
    assert.equal(normalizeActivityActionType("journey.badge.awarded"), "journey.badge.awarded");
    assert.equal(normalizeActivityActionType("forum.contribution.awarded"), "forum.contribution.awarded");
    assert.equal(normalizeActivityActionType("unexpected"), "forum.topic.created");
    assert.equal(normalizeActivityTargetType("journey_level"), "journey_level");
    assert.equal(normalizeActivityTargetType("agent"), "agent");
    assert.equal(normalizeActivityTargetType("knowledge_file"), "knowledge_file");
    assert.equal(normalizeActivityTargetType("apps_deployment"), "apps_deployment");
    assert.equal(normalizeActivityTargetType("other"), "community");
    assert.equal(normalizeActivityVisibility("private"), "private");
    assert.equal(normalizeActivityVisibility("public"), "org");
  });

  it("caps and defaults activity limits", () => {
    assert.equal(normalizeActivityLimit("12"), 12);
    assert.equal(normalizeActivityLimit(999), MAX_ACTIVITY_EVENT_LIMIT);
    assert.equal(normalizeActivityLimit("0"), DEFAULT_ACTIVITY_EVENT_LIMIT);
    assert.equal(normalizeActivityLimit("nope"), DEFAULT_ACTIVITY_EVENT_LIMIT);
  });
});
