import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvedMediaType } from "./fileTypes.ts";

describe("WeChat file upload types", () => {
  it("recognizes chat files by extension because WeChat returns file, image, or video rather than a MIME type", () => {
    for (const [name, kind, expected] of [
      ["page.html", "file", "text/html"],
      ["notes.md", "file", "text/markdown"],
      ["report.pdf", "file", "application/pdf"],
      ["photo.png", "image", "image/png"],
      ["archive.zip", "file", "application/zip"],
      ["clip.mp4", "video", "video/mp4"]
    ]) assert.equal(resolvedMediaType({ name, type: kind }), expected, name);
  });

  it("keeps valid MIME types from the scene 1173 entry and uses octet-stream for unknown files", () => {
    assert.equal(resolvedMediaType({ name: "report", type: "text/html" }), "text/html");
    assert.equal(resolvedMediaType({ name: "unknown.bin", type: "application/octet-stream" }), "application/octet-stream");
  });
});
