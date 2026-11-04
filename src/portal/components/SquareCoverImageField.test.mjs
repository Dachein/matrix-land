import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

async function loadComponent() {
  const outdir = await mkdtemp(join(process.cwd(), ".tmp-workspace-square-cover-"));
  const outfile = join(outdir, "SquareCoverImageField.mjs");
  try {
    await build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL("./SquareCoverImageField.tsx", import.meta.url))],
      external: ["lucide-react", "react", "react-dom"],
      format: "esm",
      logLevel: "silent",
      outfile,
      platform: "node"
    });
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    await rm(outdir, { force: true, recursive: true });
  }
}

const copy = {
  collapse: "Collapse",
  empty: "No avatar uploaded",
  help: "Cropped to 600 × 600.",
  invalidType: "Invalid image",
  manage: "Manage avatar",
  processing: "Processing",
  readFailed: "Read failed",
  remove: "Remove",
  replace: "Replace avatar",
  required: "Required",
  tooLarge: "Too large",
  upload: "Upload avatar"
};

describe("SquareCoverImageField", () => {
  it("renders an existing image as a collapsed thumbnail by default", async () => {
    const { SquareCoverImageField } = await loadComponent();
    const html = renderToStaticMarkup(createElement(SquareCoverImageField, {
      copy,
      label: "Avatar",
      onChange() {},
      required: false,
      value: "data:image/png;base64,aGVsbG8="
    }));

    assert.match(html, /class="appCoverThumbnail"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /decoding="async"/);
    assert.match(html, />Manage avatar</);
    assert.doesNotMatch(html, /class="appCoverManagement"/);
    assert.doesNotMatch(html, />Replace avatar</);
  });

  it("keeps the empty upload state compact until management is opened", async () => {
    const { SquareCoverImageField } = await loadComponent();
    const html = renderToStaticMarkup(createElement(SquareCoverImageField, {
      copy,
      label: "Avatar",
      onChange() {},
      required: false,
      value: ""
    }));

    assert.match(html, /No avatar uploaded/);
    assert.match(html, />Manage avatar</);
    assert.doesNotMatch(html, /class="appCoverManagement"/);
    assert.doesNotMatch(html, />Upload avatar</);
  });
});
