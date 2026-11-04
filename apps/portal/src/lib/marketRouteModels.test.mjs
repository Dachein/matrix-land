import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadModels() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-portal-market-models-"));
  const outfile = join(outdir, "market-models.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./marketRouteModels.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

const listedApp = {
  id: "app:app-1",
  kind: "app",
  listing: { id: "listing-1" },
  status: "listed",
  targetId: "app-1"
};

describe("Portal Skills & Apps route models", () => {
  it("resolves canonical target, listing, and normalized object ids", async () => {
    const { findPortalMarketItem } = await loadModels();

    assert.equal(findPortalMarketItem([listedApp], "app", "app-1"), listedApp);
    assert.equal(findPortalMarketItem([listedApp], "app", "listing-1"), listedApp);
    assert.equal(findPortalMarketItem([listedApp], "app", "app:app-1"), listedApp);
  });

  it("does not expose a delisted object through a canonical Portal page", async () => {
    const { findPortalMarketItem } = await loadModels();
    const delistedSkill = {
      id: "skill:skill-1",
      kind: "skill",
      status: "delisted",
      targetId: "skill-1"
    };

    assert.equal(findPortalMarketItem([delistedSkill], "skill", "skill-1"), undefined);
    assert.equal(findPortalMarketItem([listedApp], "skill", "app-1"), undefined);
  });

  it("recognizes incomplete Auth publication without treating a 200 review response as ordinary success", async () => {
    const { publicationReviewPublicationState } = await loadModels();

    assert.deepEqual(publicationReviewPublicationState({
      authPublicationStatus: "pending",
      authSync: { reason: "auth_worker_not_configured", skipped: true }
    }), { status: "pending" });
    assert.deepEqual(publicationReviewPublicationState({
      authPublicationStatus: "failed",
      authSync: {
        errorCode: "auth_worker_rejected_projection",
        requestId: "auth-request-503",
        status: 503,
        synced: false
      }
    }), {
      requestId: "auth-request-503",
      status: "failed"
    });
    assert.deepEqual(publicationReviewPublicationState({
      authPublicationStatus: "pending",
      resourceSync: { reason: "auth_worker_not_configured", skipped: true }
    }), { status: "pending" });
    assert.deepEqual(publicationReviewPublicationState({
      authPublicationStatus: "failed",
      resourceSync: {
        errorCode: "auth_worker_rejected_projection",
        requestId: "resource-request-502",
        status: 502,
        synced: false
      }
    }), {
      requestId: "resource-request-502",
      status: "failed"
    });
  });

  it("derives safe legacy Auth outcomes and rejects untrusted request ids", async () => {
    const { publicationReviewPublicationState } = await loadModels();

    assert.deepEqual(publicationReviewPublicationState({ authSync: { synced: true } }), { status: "synced" });
    assert.deepEqual(publicationReviewPublicationState({
      resourceSync: { reason: "auth_worker_not_configured", skipped: true }
    }), { status: "pending" });
    assert.deepEqual(publicationReviewPublicationState({
      authSync: { requestId: "<script>secret</script>", synced: false }
    }), { status: "failed" });
    assert.equal(publicationReviewPublicationState({ authPublicationStatus: "unknown" }), undefined);
  });
});
