import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forumAgentHandoffText } from "./agentHandoff.ts";

describe("forumAgentHandoffText", () => {
  it("hands off a topic using the MCP read tool and a canonical id", () => {
    const text = forumAgentHandoffText({
      title: "Quarterly planning",
      topicId: "topic-123",
      url: "https://portal.example/#/posts/topic-123"
    }, "en");

    assert.match(text, /forum_read/);
    assert.match(text, /action="get_topic"/);
    assert.match(text, /topicId="topic-123"/);
    assert.match(text, /explicit approval/);
    assert.doesNotMatch(text, /Target Post ID/);
    assert.match(text, /^Take over this Forum Post through Workspace MCP\./);
    assert.doesNotMatch(text, /请通过 Workspace MCP/);
  });

  it("targets one reply without copying its private body into the clipboard", () => {
    const text = forumAgentHandoffText({
      postId: "reply-9",
      title: "季度规划",
      topicId: "topic-123",
      url: "https://portal.example/#/posts/topic-123"
    }, "zh-CN");

    assert.match(text, /目标 Post ID：reply-9/);
    assert.match(text, /优先处理 Post ID "reply-9"/);
    assert.match(text, /写入动作/);
    assert.match(text, /^请通过 Workspace MCP 接手这个 Forum Post。/);
    assert.doesNotMatch(text, /Take over this Forum Post/);
  });
});
