import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadViewModels() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-portal-view-models-"));
  const outfile = join(outdir, "view-models.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./viewModels.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function setHomePins(pins, { dismissed = [], userId = "user-1" } = {}) {
  const storage = new Map([
    ["workspace.homePins.v1", JSON.stringify(pins)],
    [`workspace.homePinDismissals.v1:${userId}`, JSON.stringify(dismissed)]
  ]);
  globalThis.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    }
  };
}

function appListing({
  id,
  launchUrl,
  name = id,
  status = "listed"
}) {
  return {
    category: "Workflow",
    config: launchUrl ? { reviewDraft: { launchUrl } } : {},
    coverImageUrl: `/covers/${id}.png`,
    description: `${name} description`,
    id: `listing-${id}`,
    name,
    owner: "AI Adoption",
    status,
    summary: `${name} summary`,
    targetId: id,
    type: "app"
  };
}

function catalog({ listings }) {
  return {
    apps: [],
    currentUser: { id: "user-1" },
    hubListings: listings,
    publicationListings: listings,
    portal: {},
    skills: []
  };
}

describe("Portal home application entries", () => {
  it("shows every accessible App without configured defaults", async () => {
    const { buildPortalShortcuts } = await loadViewModels();
    setHomePins([{ id: "user-app", kind: "app" }]);

    const shortcuts = buildPortalShortcuts(catalog({
      listings: [
        appListing({ id: "academy", launchUrl: "https://academy.example.test", name: "Workspace Academy" }),
        appListing({ id: "user-app", launchUrl: "https://user-app.example.test" }),
        appListing({ id: "workbuddy-request", launchUrl: "https://workbuddy.example.test" })
      ]
    }));

    assert.deepEqual(shortcuts.map((shortcut) => shortcut.id), ["academy", "user-app", "workbuddy-request"]);
  });

  it("honors a per-user dismissal of an accessible App", async () => {
    const { buildPortalShortcuts } = await loadViewModels();
    setHomePins([], { dismissed: [{ id: "academy", kind: "app" }] });

    const shortcuts = buildPortalShortcuts(catalog({
      listings: [
        appListing({ id: "academy", launchUrl: "https://academy.example.test", name: "Workspace Academy" }),
        appListing({ id: "workbuddy-request", launchUrl: "https://workbuddy.example.test" })
      ]
    }));

    assert.deepEqual(shortcuts.map((shortcut) => shortcut.id), ["workbuddy-request"]);
  });

  it("keeps accessible pending App listings and does not truncate the draggable rail", async () => {
    const { buildPortalShortcuts } = await loadViewModels();
    const listings = Array.from({ length: 6 }, (_, index) => appListing({
      id: `pending-app-${index + 1}`,
      launchUrl: `https://pending-${index + 1}.example.test`,
      status: "pending_review"
    }));
    setHomePins(listings.map((listing) => ({ id: listing.targetId, kind: "app" })));

    const shortcuts = buildPortalShortcuts(catalog({
      listings: [...listings, appListing({
        id: "workbuddy-request",
        launchUrl: "https://workbuddy.example.test",
        name: "WorkBuddy 申请"
      })]
    }));

    assert.equal(shortcuts.length, 7);
    assert.equal(shortcuts.filter((shortcut) => shortcut.status === "pending_review").length, 6);
    assert.equal(shortcuts[0].name, "WorkBuddy 申请");
    assert.equal(shortcuts[1].launchTarget.launchUrl, "https://pending-1.example.test");
    assert.equal(shortcuts.some((shortcut) => shortcut.id === "workbuddy-request"), true);
  });

  it("returns no entries when accessible Apps are invalid", async () => {
    const { buildPortalShortcuts } = await loadViewModels();
    setHomePins([{ id: "deleted-app", kind: "app" }]);

    const shortcuts = buildPortalShortcuts(catalog({
      listings: [appListing({
        id: "deleted-app",
        launchUrl: "https://deleted.example.test",
        status: "deleted"
      })]
    }));

    assert.deepEqual(shortcuts, []);
  });
});

describe("Home public and exclusive application groups", () => {
  it("pins the seven public recommendations and sorts each group by latest update", async () => {
    const { buildPortalHomeApplications } = await loadViewModels();
    const names = ["Bye!OA", "Frontier Workspace cookbook", "Workspace Academy", "Workspace Onboarding", "Workspace Ontology Design", "香港公寓预订", "Workbuddy 使用申请"];
    const recommended = names.map((name, index) => ({ ...appListing({ id: `rec-${index}`, name, launchUrl: "https://app.test" }), visibility: "org", updatedAt: `2026-10-${String(index + 1).padStart(2, "0")}` }));
    const ordinary = [
      { ...appListing({ id: "old", launchUrl: "https://old.test" }), updatedAt: "2026-10-01" },
      { ...appListing({ id: "new", launchUrl: "https://new.test" }), updatedAt: "2026-10-21" }
    ];
    setHomePins([]);
    const result = buildPortalHomeApplications(catalog({ listings: [...ordinary, ...recommended.reverse()] }));
    assert.deepEqual(result.publicApps.map((app) => app.name), [...names.toReversed(), "new", "old"]);
    assert.deepEqual(result.exclusiveApps, []);
  });

  it("keeps private and targeted entries exclusive and puts global and personal hidden entries in a recoverable group", async () => {
    const { buildPortalHomeApplications } = await loadViewModels();
    const entry = (id, extra = {}) => ({ ...appListing({ id, launchUrl: `https://${id}.test` }), ...extra });
    const listings = [entry("public", { homeScope: "public" }), entry("hidden", { homeDisplay: "hidden" }),
      entry("dismissed"), entry("private", { visibility: "private", updatedAt: "2026-10-20" }),
      entry("targeted", { homeScope: "exclusive", updatedAt: "2026-10-21" }),
      entry("team", { visibility: "team" }),
      entry("live-public", { homeScope: "public", config: { reviewDraft: { launchUrl: "https://app.test", accessMode: "targeted" } } })];
    setHomePins([{ id: "inaccessible", kind: "app" }], { dismissed: [{ id: "dismissed", kind: "app" }, { id: "targeted", kind: "app" }] });
    const result = buildPortalHomeApplications(catalog({ listings }));
    assert.deepEqual(new Set(result.publicApps.map((app) => app.id)), new Set(["public", "live-public"]));
    assert.deepEqual(result.exclusiveApps.map((app) => app.id), ["targeted", "private", "team"]);
    assert.deepEqual(new Set(result.hiddenApps.map((app) => app.id)), new Set(["hidden", "dismissed"]));
  });

  it("lets explicit normal override the default recommendation and sorts recommendations by updates", async () => {
    const { buildPortalHomeApplications } = await loadViewModels();
    setHomePins([]);
    const listings = [
      { ...appListing({ id: "byeoa", name: "ByeOA", launchUrl: "https://byeoa.test" }), homeDisplay: "normal", updatedAt: "2026-10-21" },
      { ...appListing({ id: "academy", name: "Workspace Academy", launchUrl: "https://academy.test" }), updatedAt: "2026-10-01" },
      { ...appListing({ id: "custom", launchUrl: "https://custom.test" }), homeDisplay: "recommended", updatedAt: "2026-10-20" }
    ];
    const result = buildPortalHomeApplications(catalog({ listings }));
    assert.deepEqual(result.publicApps.map((app) => app.id), ["custom", "academy", "byeoa"]);
  });
});

describe("Portal discussion ordering", () => {
  it("keeps pinned topics above newer unpinned activity", async () => {
    const { orderedDiscussions } = await loadViewModels();
    const discussions = orderedDiscussions([
      { id: "new", lastActive: "2026-07-21T12:00:00Z", pinned: false },
      { id: "pinned", lastActive: "2026-07-20T12:00:00Z", pinned: true },
      { id: "old", lastActive: "2026-07-19T12:00:00Z" }
    ]);

    assert.deepEqual(discussions.map((discussion) => discussion.id), ["pinned", "new", "old"]);
  });

  it("reserves the two recent home slots for unpinned topics and places pins before earlier topics", async () => {
    const { groupPortalHomeDiscussions, orderedDiscussions } = await loadViewModels();
    const groups = groupPortalHomeDiscussions(orderedDiscussions([
      { id: "recent-2", lastActive: "2026-07-21T11:00:00Z" },
      { id: "pinned-1", lastActive: "2026-07-18T12:00:00Z", pinned: true },
      { id: "earlier-1", lastActive: "2026-07-20T12:00:00Z" },
      { id: "recent-1", lastActive: "2026-07-21T12:00:00Z" },
      { id: "pinned-2", lastActive: "2026-07-19T12:00:00Z", pinned: true }
    ]));

    assert.deepEqual(groups.recent.map((discussion) => discussion.id), ["recent-1", "recent-2"]);
    assert.deepEqual(groups.pinned.map((discussion) => discussion.id), ["pinned-2", "pinned-1"]);
    assert.deepEqual(groups.earlier.map((discussion) => discussion.id), ["earlier-1"]);
  });

  it("combines text, category, and current-user filters", async () => {
    const { filterPortalDiscussions } = await loadViewModels();
    const currentUser = { email: "maya@example.com", id: "user-maya", name: "Maya" };
    const discussions = [
      {
        author: "Maya",
        authorId: "user-maya",
        categorySlug: "ai-investment",
        excerpt: "Portfolio research notes",
        id: "mine-by-id",
        tag: "Research",
        title: "Weekly signal review"
      },
      {
        author: "Maya Chen",
        authorEmail: "MAYA@EXAMPLE.COM",
        category: "AI 应用探索",
        id: "mine-by-email",
        tag: "Agents",
        title: "Agent onboarding"
      },
      {
        author: "Alex",
        authorId: "user-alex",
        categorySlug: "ai-investment",
        id: "someone-else",
        tag: "Market",
        title: "Portfolio outlook"
      }
    ];

    assert.deepEqual(filterPortalDiscussions(discussions, {
      category: "ai-investment",
      currentUser,
      owner: "mine",
      query: "research"
    }).map((discussion) => discussion.id), ["mine-by-id"]);

    assert.deepEqual(filterPortalDiscussions(discussions, {
      category: "ai-exploration",
      currentUser,
      owner: "mine",
      query: "agent"
    }).map((discussion) => discussion.id), ["mine-by-email"]);
  });
});
