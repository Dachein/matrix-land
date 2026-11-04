import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadLinkedItems() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-linked-items-"));
  const outfile = join(outdir, "linked-items.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./linkedItems.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

describe("forum linked Hub items", () => {
  it("resolves the current App without requiring a Hub Listing", async () => {
    const { resolveForumListedItemAttachment } = await loadLinkedItems();
    const intent = { id: "current-app", label: "Historical name", type: "app" };
    const resolved = resolveForumListedItemAttachment(intent, {
      apps: [{
        category: "Workflow",
        coverImageUrl: "/current-app.png",
        description: "Current App description",
        id: "current-app",
        name: "Current App",
        publisherProfile: { name: "App owner" },
        status: "pending_review",
        viewCount: 12
      }],
      hubListings: [],
      publicationListings: [],
      skills: []
    });

    assert.deepEqual(resolved, {
      category: "Workflow",
      description: "Current App description",
      iconUrl: "/current-app.png",
      id: "current-app",
      installs: 12,
      label: "Current App",
      owner: "App owner",
      type: "app"
    });
  });
});
