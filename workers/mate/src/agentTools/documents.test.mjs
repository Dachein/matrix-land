import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  analyzeAgentImage,
  createWorkspaceDocumentTools,
  extractPptxMarkdown,
  extractSpreadsheetFormulas,
  isSupportedAttachment,
  prepareMessagesWithAttachments,
  readAgentAttachment
} from "./documents.ts";

test("native PDF tool output keeps original bytes out of UI metadata and reloads through ACL on recovery", async () => {
  const original = new TextEncoder().encode("%PDF-controlled-original");
  const attachments = new Map([["pdf-1", { id: "pdf-1", fileName: "receipt.pdf", mediaType: "application/pdf", objectId: "private-pdf" }]]);
  let reads = 0;
  const env = { DEV_AUTH_BYPASS: "1", KNOWLEDGE_WORKER_URL: "http://127.0.0.1:8794", KNOWLEDGE_SERVICE: {
    async fetch(request) {
      reads++; assert.equal(new URL(request.url).pathname, "/api/files/private-pdf/raw");
      return new Response(original, { headers: { "content-type": "application/pdf" } });
    }
  }, AI: { toMarkdown() { assert.fail("native PDF must bypass Markdown extraction"); } } };
  const tools = createWorkspaceDocumentTools(env, context, attachments, { nativePdf: true });
  const input = { attachmentId: "pdf-1" };
  const output = await tools.attachment_read.execute(input, {});
  assert.equal(output.format, "native_pdf");
  assert.ok(!JSON.stringify(output).includes(Buffer.from(original).toString("base64")));
  const first = await tools.attachment_read.toModelOutput({ toolCallId: "read-1", input, output });
  assert.equal(reads, 1);
  assert.equal(first.type, "content");
  assert.deepEqual(first.value.find(part => part.type === "file").data.data, original);
  const recovered = createWorkspaceDocumentTools(env, context, attachments, { nativePdf: true });
  const second = await recovered.attachment_read.toModelOutput({ toolCallId: "read-1", input, output });
  assert.equal(reads, 2);
  assert.deepEqual(second.value.find(part => part.type === "file").data.data, original);
  const denied = createWorkspaceDocumentTools({ ...env, KNOWLEDGE_SERVICE: { fetch: async () => Response.json({ error: "denied" }, { status: 403 }) } }, context, attachments, { nativePdf: true });
  await assert.rejects(denied.attachment_read.toModelOutput({ toolCallId: "read-1", input, output }), /workspace_attachment_read_failed/);
});

test("generic PDF fallback is used when native reading is off or the original exceeds its budget", async () => {
  for (const nativePdf of [false, true]) {
    const bytes = new Uint8Array(nativePdf ? 8 * 1024 * 1024 + 1 : 20);
    bytes.set(new TextEncoder().encode("%PDF-"));
    let conversions = 0;
    const attachments = new Map([["pdf-1", { id: "pdf-1", fileName: "receipt.pdf", mediaType: "application/pdf", dataUrl: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}` }]]);
    const tools = createWorkspaceDocumentTools({ AI: { async toMarkdown() { conversions++; return { format: "markdown", data: "verified extracted fields" }; } } }, context, attachments, { nativePdf });
    const input = { attachmentId: "pdf-1" };
    const output = await tools.attachment_read.execute(input, {});
    assert.equal(output.format, "markdown");
    assert.equal(conversions, 1);
    const model = await tools.attachment_read.toModelOutput({ toolCallId: "read-1", input, output });
    assert.equal(model.type, "text"); assert.match(model.value, /verified extracted fields/);
  }
});

const context = {
  appCode: "knowledge-access",
  appId: "knowledge-access-local",
  description: "Agent",
  displayName: "Knowledge Access Mate",
  exp: 2_000_000_000,
  iat: 1_900_000_000,
  user: { email: "user@example.test", id: "user-1", name: "User One" },
  version: 1
};

test("Excel keeps sheet names, stored formulas, and missing or saved results without recalculating", () => {
  const bytes = zipSync({
    "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Summary &amp; Risk" r:id="rId1" /></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Target="/xl/worksheets/sheet1.xml" Id="rId1" /></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8('<worksheet><c r="B4"><f>SUM(B2:B3)</f><v></v></c><c r="C4"><f>B4*2</f><v>86</v></c><c r="D4"><f t="shared" si="7"/></c></worksheet>')
  });
  const result = extractSpreadsheetFormulas(bytes);
  assert.match(result, /Summary & Risk!B4.*SUM\(B2:B3\).*not available/);
  assert.match(result, /C4.*B4\*2.*86/);
  assert.match(result, /D4.*shared formula reference 7/);
  assert.match(result, /not recalculated.*may be stale/);
});

test("Mate document reader accepts imported text, HTML, PDF, and images but rejects archives", () => {
  for (const [fileName, mediaType] of [
    ["notes.md", "text/markdown"], ["notes.txt", "text/plain"],
    ["page.html", "text/html"], ["report.pdf", "application/pdf"],
    ["photo.png", "image/png"], ["table.csv", "text/csv"],
    ["report.docx", "application/octet-stream"], ["budget.xlsx", "application/octet-stream"],
    ["budget.xls", "application/vnd.ms-excel"], ["notes.markdown", "application/octet-stream"]
  ]) assert.equal(isSupportedAttachment(fileName, mediaType), true, fileName);
  assert.equal(isSupportedAttachment("archive.zip", "application/zip"), false);
});

test("message files become opaque attachment references instead of direct model files", () => {
  const prepared = prepareMessagesWithAttachments([{
    id: "message-1",
    parts: [
      { text: "请阅读", type: "text" },
      {
        filename: "report.docx",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        type: "file",
        url: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEs="
      }
    ],
    role: "user"
  }]);

  assert.equal(prepared.attachments.size, 1);
  assert.equal(prepared.messages[0].parts.some((part) => part.type === "file"), false);
  assert.match(prepared.messages[0].parts[1].text, /attachmentId=attachment-message-1-2/);
});

test("Workspace file URLs become ACL-protected attachment references", () => {
  const prepared = prepareMessagesWithAttachments([{
    id: "message-2",
    parts: [{
      filename: "report.pdf",
      mediaType: "application/pdf",
      type: "file",
      url: "/api/workspace-files/kobj_report-1/raw"
    }],
    role: "user"
  }]);

  const attachment = prepared.attachments.get("attachment-message-2-1");
  assert.equal(attachment.objectId, "kobj_report-1");
  assert.equal(attachment.dataUrl, undefined);
});

test("PPTX slides are converted to platform Markdown inside the Worker", () => {
  const archive = zipSync({
    "ppt/slides/slide1.xml": strToU8("<p:sld><a:t>Quarterly Review</a:t><a:t>Revenue &amp; Risk</a:t></p:sld>"),
    "ppt/slides/slide2.xml": strToU8("<p:sld><a:t>Next Steps</a:t></p:sld>")
  });
  const markdown = extractPptxMarkdown(archive, "review.pptx");

  assert.match(markdown, /^# review\.pptx/);
  assert.match(markdown, /## Slide 1/);
  assert.match(markdown, /Revenue & Risk/);
  assert.match(markdown, /## Slide 2/);
});

test("Office files use Workers AI Markdown conversion", async () => {
  const attachment = {
    dataUrl: `data:application/pdf;base64,${btoa("%PDF-test")}`,
    fileName: "guide.pdf",
    id: "attachment-pdf",
    mediaType: "application/pdf"
  };
  const env = {
    AI: {
      toMarkdown: async (document, options) => {
        assert.equal(document.name, "guide.pdf");
        assert.equal(document.blob.type, "application/pdf");
        assert.equal(options.conversionOptions.pdf.metadata, false);
        return { data: "# Guide\n\nApproved content", format: "markdown" };
      }
    }
  };
  const result = await readAgentAttachment(env, context, new Map([[attachment.id, attachment]]), attachment.id);

  assert.equal(result.format, "markdown");
  assert.match(result.content, /Approved content/);
});

test("Markdown attachments are accepted and read as UTF-8 without Workers AI", async () => {
  const attachment = {
    dataUrl: `data:text/markdown;base64,${btoa("# Notes\n\nNext step")}`,
    fileName: "notes.md",
    id: "attachment-markdown",
    mediaType: "text/markdown"
  };
  const prepared = prepareMessagesWithAttachments([{
    id: "message-md", role: "user", parts: [{ type: "file", filename: attachment.fileName, mediaType: attachment.mediaType, url: attachment.dataUrl }]
  }]);
  assert.equal(prepared.attachments.size, 1);
  const result = await readAgentAttachment({}, context, new Map([[attachment.id, attachment]]), attachment.id);
  assert.equal(result.content, "# Notes\n\nNext step");
  assert.equal(result.format, "markdown");
});

test("image analysis uses the Workers AI vision model with the user's question", async () => {
  const attachment = {
    dataUrl: `data:image/png;base64,${btoa("png")}`,
    fileName: "chart.png",
    id: "attachment-image",
    mediaType: "image/png"
  };
  const env = {
    AI: {
      run: async (model, input) => {
        assert.equal(model, "@cf/google/gemma-4-26b-a4b-it");
        assert.equal(input.messages[0].content[0].text, "图表趋势是什么？");
        return { choices: [{ message: { content: "收入上升，风险下降。" } }] };
      }
    }
  };
  const result = await analyzeAgentImage(
    env,
    context,
    new Map([[attachment.id, attachment]]),
    attachment.id,
    "图表趋势是什么？"
  );

  assert.equal(result.analysis, "收入上升，风险下降。");
});
