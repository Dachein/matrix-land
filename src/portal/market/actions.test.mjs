import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadActions() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-market-actions-"));
  const outfile = join(outdir, "actions.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./actions.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

describe("publication Listing version precedence", () => {
  it("prefers the listed version over review configuration and the live Skill", async () => {
    const { marketListingVersion } = await loadActions();
    assert.equal(marketListingVersion({
      listing: {
        listedVersionId: "1.2.0",
        reviewVersionId: "1.1.0",
        config: { reviewDraft: { version: "1.1.5" } }
      },
      skill: { version: "2.0.0" }
    }), "1.2.0");
  });

  it("uses review configuration before review metadata or a live Skill version", async () => {
    const { marketListingVersion } = await loadActions();
    assert.equal(marketListingVersion({
      listing: {
        reviewVersionId: "1.1.0",
        config: { builderSnapshot: { reviewDraft: { version: "1.1.5" } } }
      },
      skill: { version: "2.0.0" }
    }), "1.1.5");
  });
});
