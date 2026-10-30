import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forumInlineImageUrls, forumInlineMediaUrls, forumStandaloneAttachments, renderForumMarkdown } from "./markdown.ts";

const graceMention = {
  email: "grace@example.test",
  emailPrefix: "grace",
  id: "mention-grace",
  name: "Grace Hopper",
  text: "@grace",
  userId: "user-grace"
};

describe("forum mention markdown", () => {
  it("renders a resolved person with the shared avatar and name chip", () => {
    const html = renderForumMarkdown("Please review @grace today", new Map([["grace", graceMention]]));

    assert.match(html, /class="peopleMentionTag readOnly inlineMentionTag"/);
    assert.match(html, /class="peopleMentionAvatar"/);
    assert.match(html, />GH<\/span>/);
    assert.match(html, /class="peopleMentionName">Grace Hopper<\/span>/);
    assert.match(html, /data-mention-prefix="grace"/);
  });

  it("keeps unresolved handles and email domains as plain text", () => {
    const unresolved = renderForumMarkdown("Ask @unknown for help");
    const email = renderForumMarkdown("Email ally@example.test");

    assert.match(unresolved, /Ask @unknown for help/);
    assert.doesNotMatch(unresolved, /inlineMentionTag/);
    assert.match(email, /ally@example\.test/);
    assert.doesNotMatch(email, /inlineMentionTag/);
  });

  it("keeps trailing mention punctuation outside the person chip", () => {
    const html = renderForumMarkdown("Thanks @grace.", new Map([["grace", graceMention]]));

    assert.match(html, /data-mention-prefix="grace"/);
    assert.match(html, /<\/button>\.<\/p>/);
  });

  it("escapes person data before adding it to the chip markup", () => {
    const html = renderForumMarkdown("Hello @grace", new Map([["grace", {
      ...graceMention,
      name: "Grace <Admin>"
    }]]));

    assert.match(html, /Grace &lt;Admin&gt;/);
    assert.doesNotMatch(html, /Grace <Admin>/);
  });

  it("wraps tables for constrained forum layouts", () => {
    const html = renderForumMarkdown("| 模型 | 状态 |\n| --- | --- |\n| GLM | 402 |");

    assert.match(html, /<div class="forumMarkdownTable"><table>/);
    assert.match(html, /<td>GLM<\/td>/);
  });
});

describe("forum task list markdown", () => {
  it("renders GFM task markers as disabled checkboxes", () => {
    const html = renderForumMarkdown("- [ ] open task\n- [x] done task");

    assert.match(html, /<ul class="containsTaskList">/);
    assert.match(html, /class="taskListItemCheckbox" disabled type="checkbox"> open task/);
    assert.match(html, /class="taskListItemCheckbox" disabled type="checkbox" checked> done task/);
    assert.doesNotMatch(html, /\[ \]| \[x\]/);
  });

  it("leaves non-task bullet items untouched", () => {
    const html = renderForumMarkdown("- plain bullet");

    assert.doesNotMatch(html, /taskListItem/);
    assert.match(html, /<li>plain bullet<\/li>/);
  });
});

describe("forum code block copy button", () => {
  it("wraps fenced code blocks with a copy button", () => {
    const html = renderForumMarkdown("```ts\nconst a = 1;\n```", undefined, { copyCodeLabel: "Copy code" });

    assert.match(html, /class="forumCodeBlock"/);
    assert.match(html, /class="forumCodeCopyButton"/);
    assert.match(html, /aria-label="Copy code"/);
    assert.match(html, /<pre><code class="language-ts">/);
  });

  it("uses the provided localized copy label", () => {
    const html = renderForumMarkdown("```\ncode\n```", undefined, { copyCodeLabel: "复制代码" });

    assert.match(html, /aria-label="复制代码"/);
  });

  it("does not add an inert copy button when no copy handler is requested", () => {
    const html = renderForumMarkdown("```\ncode\n```");

    assert.doesNotMatch(html, /forumCodeCopyButton/);
    assert.match(html, /<pre><code>code\n<\/code><\/pre>/);
  });
});

describe("forum inline images", () => {
  it("finds Markdown image URLs without treating ordinary links as images", () => {
    const urls = forumInlineImageUrls([
      "![diagram](/api/forum/media/forum/2026/08/diagram.png)",
      "[download](/api/forum/media/forum/2026/08/report.png)"
    ].join("\n"));

    assert.deepEqual([...urls], ["/api/forum/media/forum/2026/08/diagram.png"]);
  });

  it("tracks uploaded files represented as Markdown links", () => {
    const urls = forumInlineMediaUrls([
      "![diagram](/api/forum/media/forum/2026/08/diagram.png)",
      "[architecture.pdf](/api/forum/media/forum/2026/08/architecture.pdf)"
    ].join("\n"));

    assert.deepEqual([...urls], [
      "/api/forum/media/forum/2026/08/diagram.png",
      "/api/forum/media/forum/2026/08/architecture.pdf"
    ]);
  });

  it("hides inline images from the separate attachment gallery", () => {
    const inlineImage = {
      id: "inline",
      type: "image",
      url: "/api/forum/media/forum/2026/08/inline.png",
      fileName: "inline.png",
      fileSize: 10,
      mimeType: "image/png"
    };
    const galleryImage = { ...inlineImage, id: "gallery", url: "/api/forum/media/forum/2026/08/gallery.png" };
    const inlineFile = { ...inlineImage, id: "file", type: "file", url: "/api/forum/media/forum/2026/08/guide.pdf" };

    assert.deepEqual(
      forumStandaloneAttachments(`![inline](${inlineImage.url})\n\n[guide.pdf](${inlineFile.url})`, [inlineImage, galleryImage, inlineFile]),
      [galleryImage]
    );
  });
});


describe("forum media typography", () => {
  it("groups a standalone image with its immediate italic caption", () => {
    const html = renderForumMarkdown('![diagram](/diagram.png)\n\n*Source: webinar*\n\nNext paragraph.');
    assert.match(html, /<p class="forumMarkdownImage"><img/);
    assert.match(html, /<p class="forumMarkdownCaption"><em>Source: webinar<\/em><\/p>/);
    assert.match(html, /<p>Next paragraph\.<\/p>/);
  });

  it("recognizes a linked image without changing the link", () => {
    const html = renderForumMarkdown('[![diagram](/diagram.png)](https://example.com)');
    assert.match(html, /<p class="forumMarkdownImage"><a href="https:\/\/example\.com"/);
    assert.match(html, /target="_blank" rel="noreferrer"/);
  });

  it("keeps inline images and unrelated emphasis in the text flow", () => {
    const html = renderForumMarkdown('Text ![icon](/icon.png) here.\n\n*Emphasis*\n\n![diagram](/diagram.png)\n\nParagraph.\n\n*Unrelated emphasis*');
    assert.equal((html.match(/forumMarkdownImage/g) || []).length, 1);
    assert.doesNotMatch(html, /forumMarkdownCaption/);
  });
});
