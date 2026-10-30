import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadModels() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-market-models-"));
  const outfile = join(outdir, "models.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./models.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function listing(id, type, status) {
  return {
    category: type === "app" ? "Workflow" : "Research",
    comments: 0,
    description: `${id} description`,
    id: `listing-${id}`,
    installs: 0,
    name: id,
    rating: 0,
    status,
    summary: `${id} summary`,
    tags: [],
    targetId: id,
    type,
    updatedAt: "2026-07-14",
    visibility: "company"
  };
}

function app(id, status) {
  return {
    category: "Workflow",
    description: `${id} description`,
    discussionCount: 0,
    id,
    launchCount: 0,
    likeCount: 0,
    name: id,
    publisherProfile: { id: "app-owner", name: "Builder", email: "builder@example.com" },
    rating: 0,
    status,
    subtitle: `${id} subtitle`,
    tags: [],
    updatedAt: "2026-07-14"
  };
}

function skill(id, status) {
  return {
    category: "Research",
    description: `${id} description`,
    discussions: 0,
    id,
    installs: 0,
    kind: "vanilla",
    mcpTools: [],
    name: id,
    owner: "Builder",
    rating: 0,
    scopes: [],
    status,
    updatedAt: "2026-07-14"
  };
}

describe("public Market item projection", () => {
  it("excludes pending Apps, Skills, and standalone listings", async () => {
    const { buildMarketItems } = await loadModels();
    const items = buildMarketItems({
      apps: [app("listed-app", "listed"), app("pending-app", "pending_review")],
      hubListings: [
        listing("listed-app", "app", "listed"),
        listing("listed-skill", "skill", "listed"),
        listing("pending-app", "app", "pending_review"),
        listing("pending-standalone", "skill", "pending_review")
      ],
      skills: [skill("listed-skill", "listed"), skill("pending-skill", "pending_review")]
    });

    assert.deepEqual(items.map((item) => item.targetId).sort(), ["listed-app", "listed-skill"]);
    assert.ok(items.every((item) => item.status === "listed"));
  });

  it("treats a matching listing as the publication source of truth", async () => {
    const { buildMarketItems } = await loadModels();
    const items = buildMarketItems({
      apps: [app("reviewing-app", "listed")],
      hubListings: [listing("reviewing-app", "app", "pending_review")],
      skills: []
    });

    assert.deepEqual(items, []);
  });

  it("uses the Listing alias for display while keeping live authors searchable", async () => {
    const { buildMarketItems, visibleMarketItems } = await loadModels();
    const marketListing = {
      ...listing("owned-app", "app", "listed"),
      ownerAliasName: "Workspace Typography Lab",
      ownerProfiles: [
        { id: "owner-1", name: "Ivy Lin", email: "ivy@example.com" },
        { id: "collaborator-1", name: "Ada Zhang", email: "ada@example.com" }
      ]
    };
    const [item] = buildMarketItems({
      apps: [app("owned-app", "listed")],
      hubListings: [marketListing],
      skills: []
    });

    assert.equal(item.owner, "Workspace Typography Lab");
    assert.deepEqual(visibleMarketItems([item], "all", "all", "Ada Zhang"), [item]);
  });

  it("shows the Owner and collaborators when Owner alias name is empty", async () => {
    const { buildMarketItems } = await loadModels();
    const marketListing = {
      ...listing("shared-skill", "skill", "listed"),
      ownerProfiles: [
        { id: "owner-1", name: "Ivy Lin", email: "ivy@example.com" },
        { id: "owner-1", name: "Duplicate Ivy by ID", email: "duplicate-ivy@example.com" },
        { id: "duplicate-owner-email", name: "Duplicate Ivy by email", email: "ivy@example.com" },
        { id: "collaborator-1", name: "Ada Zhang", email: "ada@example.com" }
      ]
    };
    const [item] = buildMarketItems({
      apps: [],
      hubListings: [marketListing],
      skills: [skill("shared-skill", "listed")]
    });

    assert.equal(item.owner, "Ivy Lin · Ada Zhang");
  });

  it("never falls back from Listing merchandising fields to the live App record", async () => {
    const { buildMarketItems } = await loadModels();
    const marketListing = {
      ...listing("listed-copy", "app", "listed"),
      category: "Finance",
      coverImageUrl: undefined,
      description: "Published Listing description",
      name: "Published Listing name",
      ownerProfiles: [{ id: "owner-1", name: "Ivy Lin", email: "ivy@example.com" }],
      summary: "",
      tags: []
    };
    const liveApp = {
      ...app("listed-copy", "listed"),
      category: "Design",
      coverImageUrl: "https://example.test/draft-cover.png",
      description: "Unpublished App description",
      name: "Unpublished App name",
      subtitle: "Unpublished App subtitle",
      tags: ["unpublished-app-tag"]
    };
    const [item] = buildMarketItems({ apps: [liveApp], hubListings: [marketListing], skills: [] });

    assert.equal(item.name, "Published Listing name");
    assert.equal(item.summary, "Published Listing description");
    assert.equal(item.description, "Published Listing description");
    assert.equal(item.coverImageUrl, undefined);
    assert.equal(item.category, "Finance");
    assert.deepEqual(item.tags, []);
    assert.equal(item.owner, "Ivy Lin");
  });

  it("does not enrich a APPS Listing from an unrelated Portal App with the same id", async () => {
    const { buildMarketItems } = await loadModels();
    const marketListing = {
      ...listing("shared-id", "app", "listed"),
      targetPlane: "apps",
      ownerProfiles: [{ id: "apps-owner", name: "APPS Owner", email: "apps@example.com" }]
    };
    const [item] = buildMarketItems({
      apps: [app("shared-id", "listed")],
      hubListings: [marketListing],
      skills: []
    });

    assert.equal(item.id, "apps:app:shared-id");
    assert.equal(item.app, undefined);
    assert.equal(item.owner, "APPS Owner");
  });

  it("never synthesizes Hub rows from raw Apps, Skills, or management listings", async () => {
    const { buildMarketItems } = await loadModels();
    const items = buildMarketItems({
      apps: [app("raw-listed-app", "listed")],
      hubListings: [],
      publicationListings: [listing("management-only-app", "app", "listed")],
      skills: [skill("raw-listed-skill", "listed")]
    });

    assert.deepEqual(items, []);
  });

  it("uses combined Skill actions and App URL visits as the primary metrics", async () => {
    const { buildMarketItems, marketPrimaryMetricCount } = await loadModels();
    const skillListing = {
      ...listing("measured-skill", "skill", "listed"),
      agentAddCount: 3,
      downloadCount: 4,
      installs: 99
    };
    const appListing = {
      ...listing("measured-app", "app", "listed"),
      installs: 88,
      visitCount: 5
    };
    const items = buildMarketItems({
      apps: [app("measured-app", "listed")],
      hubListings: [skillListing, appListing],
      skills: [skill("measured-skill", "listed")]
    });
    const byId = new Map(items.map((item) => [item.targetId, item]));

    assert.equal(marketPrimaryMetricCount(byId.get("measured-skill")), 7);
    assert.equal(marketPrimaryMetricCount(byId.get("measured-app")), 5);
    assert.deepEqual(items.map((item) => item.targetId), ["measured-skill", "measured-app"]);
  });
});
