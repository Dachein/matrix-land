import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeEmbedType,
  normalizeForumReaction,
  normalizePluginTarget,
  normalizePluginType,
  sanitizeForumContentPlugins,
  normalizeTopicType
} from "./normalizers.ts";

describe("forum normalizers", () => {
  it("keeps supported topic types and maps legacy topic labels", () => {
    assert.equal(normalizeTopicType("question"), "question");
    assert.equal(normalizeTopicType("announcement"), "official");
    assert.equal(normalizeTopicType("support"), "help");
    assert.equal(normalizeTopicType("unknown"), undefined);
  });

  it("normalizes embeds, plugins, targets, and reactions", () => {
    assert.equal(normalizeEmbedType("video"), "video");
    assert.equal(normalizeEmbedType("social"), "social");
    assert.equal(normalizeEmbedType("other"), "link");
    assert.equal(normalizePluginType("app_launch"), "app_launch");
    assert.equal(normalizePluginType("bad"), "app_card");
    assert.equal(normalizePluginTarget("skill"), "skill");
    assert.equal(normalizePluginTarget("bad"), "app");
    assert.equal(normalizeForumReaction("heart"), "heart");
    assert.equal(normalizeForumReaction("bad"), "thumbsup");
  });

  it("drops data URL plugin icons instead of snapshotting them", () => {
    const [plugin] = sanitizeForumContentPlugins([{
      iconUrl: "DATA:image/png;base64,aGVsbG8=",
      targetId: "skill-1",
      targetType: "skill"
    }]);

    assert.equal(plugin.iconUrl, undefined);
  });

  it("keeps compact hosted plugin icons in snapshots", () => {
    const [plugin] = sanitizeForumContentPlugins([{
      iconUrl: "/assets/skill.png",
      targetId: "skill-1",
      targetType: "skill"
    }]);

    assert.equal(plugin.iconUrl, "/assets/skill.png");
  });
});
