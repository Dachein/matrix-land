import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

async function loadComponent() {
  const outdir = await mkdtemp(join(process.cwd(), ".tmp-workspace-publication-authors-"));
  const outfile = join(outdir, "PublicationAuthors.mjs");
  try {
    await build({
      bundle: true,
      entryPoints: [new URL("./PublicationAuthors.tsx", import.meta.url).pathname],
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

const ownerProfiles = [
  { email: "ivy@example.com", id: "owner-ivy", name: "Ivy Lin" },
  { email: "ada@example.com", id: "collaborator-ada", name: "Ada Zhang" }
];

describe("PublicationAuthors", () => {
  it("shows every live author avatar and name when no alias is configured", async () => {
    const { PublicationAuthors } = await loadComponent();
    const html = renderToStaticMarkup(createElement(PublicationAuthors, { listing: { ownerProfiles } }));

    assert.match(html, /publication-author-name">Ivy Lin/);
    assert.match(html, /publication-author-name">Ada Zhang/);
    assert.match(html, /<button[^>]+aria-label="Ivy Lin"/);
    assert.match(html, /<button[^>]+aria-label="Ada Zhang"/);
    assert.equal((html.match(/publication-author-profile/g) ?? []).length, 2);
  });

  it("shows the alias plus accessible avatar-only chips for the unchanged live author set", async () => {
    const { PublicationAuthors } = await loadComponent();
    const html = renderToStaticMarkup(createElement(PublicationAuthors, {
      listing: { ownerAliasName: "Frontier Workspace Product Team", ownerProfiles }
    }));

    assert.match(html, /publication-author-alias">Frontier Workspace Product Team/);
    assert.doesNotMatch(html, /publication-author-name/);
    assert.match(html, /<button[^>]+aria-label="Ivy Lin"/);
    assert.match(html, /<button[^>]+aria-label="Ada Zhang"/);
    assert.match(html, /title="Ivy Lin"/);
    assert.match(html, /title="Ada Zhang"/);
    assert.equal((html.match(/publication-author-profile/g) ?? []).length, 2);
  });
});
