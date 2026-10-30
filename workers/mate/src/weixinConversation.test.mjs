import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptWorkspaceMateEnvironment } from "../../../sdk/mate/environment.ts";
import {
  formatWeixinConversationResponse,
  weixinConversationInstruction
} from "./weixinConversation.ts";

async function environment(surface) {
  return acceptWorkspaceMateEnvironment({
    host: { appId: `workspace-${surface}`, surface },
    location: { kind: "mate.conversation", ref: "conversation-1" },
    revision: 1,
    schemaVersion: "workspace.mate-environment/v1"
  });
}

describe("Mate Weixin conversation policy", () => {
  it("loads plain-text and concise-response rules only for Weixin sessions", async () => {
    assert.match(weixinConversationInstruction(await environment("weixin")), /plain text only/);
    assert.match(weixinConversationInstruction({ environment: await environment("weixin") }), /800 Chinese characters/);
    assert.equal(weixinConversationInstruction(await environment("embedded")), "");
  });

  it("removes Markdown and exposes HTTPS links as plain text", () => {
    const output = formatWeixinConversationResponse([
      "## 结果",
      "- **说明**",
      "[官方资料](https://example.com/guide)",
      "```text",
      "完成",
      "```"
    ].join("\n"), {
      conversationId: "conv-1",
      mateId: "knowledge-mate",
      webHostUrl: "https://ai.example.invalid"
    });
    assert.equal(output, "结果\n说明\n官方资料：https://example.com/guide\n\n完成");
    assert.doesNotMatch(output, /[#*`]|\[[^\]]+\]\(/);
  });

  it("converts workspace file references to the authenticated Conversation download entry", () => {
    const output = formatWeixinConversationResponse(
      "[下载报告](/api/workspace-files/file_123/download)",
      {
        conversationId: "conv 1",
        mateId: "knowledge-mate",
        webHostUrl: "https://ai.example.invalid"
      }
    );
    assert.equal(
      output,
      "下载报告：https://ai.example.invalid/mates/knowledge-mate?conversation=conv+1"
    );
  });
});
