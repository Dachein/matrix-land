import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadHomePinsModule() {
  const outdir = await mkdtemp(join(tmpdir(), "home-pins-test-"));
  const outfile = join(outdir, "homePins.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./homePins.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function withHomePins(pins, { dismissed = [], userId = "user-1" } = {}) {
  const storage = new Map([
    ["workspace.homePins.v1", JSON.stringify(pins)],
    [`workspace.homePinDismissals.v1:${userId}`, JSON.stringify(dismissed)]
  ]);
  globalThis.window = {
    dispatchEvent() {},
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value)
    }
  };
  return storage;
}

function catalog(overrides = {}) {
  return {
    apps: [],
    dataServices: [],
    hubListings: [],
    publicationListings: [],
    skills: [],
    ...overrides
  };
}

describe("home pin resolution", () => {
  it("shows accessible Apps automatically and remembers per-user removals", async () => {
    const { addHomePin, isHomePinned, removeHomePin } = await loadHomePinsModule();
    const workbuddy = { id: "app-workbuddy", kind: "app" };
    const academy = { id: "app-academy", kind: "app" };
    const custom = { id: "app-custom", kind: "app" };
    const accessibleAppTargetIds = [workbuddy.id, academy.id];
    const storage = withHomePins([]);

    assert.equal(isHomePinned(workbuddy, { accessibleAppTargetIds, userId: "user-1" }), true);
    assert.equal(isHomePinned(academy, { accessibleAppTargetIds, userId: "user-1" }), true);

    addHomePin(custom, { accessibleAppTargetIds, userId: "user-1" });
    assert.equal(isHomePinned(custom, { accessibleAppTargetIds, userId: "user-1" }), true);

    removeHomePin(academy, { accessibleAppTargetIds, userId: "user-1" });
    assert.equal(isHomePinned(academy, { accessibleAppTargetIds, userId: "user-1" }), false);
    assert.equal(isHomePinned(workbuddy, { accessibleAppTargetIds, userId: "user-1" }), true);
    assert.equal(isHomePinned(custom, { accessibleAppTargetIds, userId: "user-1" }), true);
    assert.equal(isHomePinned(academy, { accessibleAppTargetIds, userId: "user-2" }), true);
    assert.deepEqual(
      JSON.parse(storage.get("workspace.homePinDismissals.v1:user-1")),
      [academy]
    );

    addHomePin(academy, { accessibleAppTargetIds, userId: "user-1" });
    assert.equal(isHomePinned(academy, { accessibleAppTargetIds, userId: "user-1" }), true);
    assert.deepEqual(JSON.parse(storage.get("workspace.homePinDismissals.v1:user-1")), []);
  });

  it("resolves a pinned custom App that only exists as a publication listing", async () => {
    const { resolveHomePins } = await loadHomePinsModule();
    withHomePins([{ id: "apps-app-1", kind: "app" }]);

    const pins = resolveHomePins(catalog({
      hubListings: [
        {
          id: "listing-app-1",
          type: "app",
          targetId: "apps-app-1",
          name: "Workbuddy 申请",
          ownerProfiles: [
            { id: "ivy", name: "Ivy Lin", email: "ivy@example.com" },
            { id: "ada", name: "Ada Zhang", email: "ada@example.com" }
          ],
          status: "listed",
          summary: "企业版使用申请入口",
          description: "企业版使用申请入口",
          category: "内部流程",
          coverImageUrl: "/assets/workbuddy.png",
          config: {
            productionUrl: "https://apps.example.com/workbuddy"
          }
        }
      ]
    }));

    assert.equal(pins.length, 1);
    assert.deepEqual(pins[0], {
      id: "apps-app-1",
      kind: "app",
      category: "内部流程",
      description: "企业版使用申请入口",
      iconUrl: "/assets/workbuddy.png",
      launchAppId: "apps-app-1",
      launchUrl: "https://apps.example.com/workbuddy",
      name: "Workbuddy 申请",
      owner: "Ivy Lin · Ada Zhang",
      status: "listed"
    });
  });

  it("uses review draft launch URLs for older custom App listings", async () => {
    const { resolveHomePins } = await loadHomePinsModule();
    withHomePins([{ id: "legacy-apps-app", kind: "app" }]);

    const pins = resolveHomePins(catalog({
      hubListings: [
        {
          id: "listing-legacy-app",
          type: "app",
          targetId: "legacy-apps-app",
          name: "Legacy App",
          status: "listed",
          summary: "",
          description: "Legacy custom app",
          category: "Workflow",
          config: {
            reviewDraft: {
              launchUrl: "https://legacy.example.com"
            }
          }
        }
      ]
    }));

    assert.equal(pins[0].launchUrl, "https://legacy.example.com");
    assert.equal(pins[0].description, "Legacy custom app");
  });

  it("uses a verified APPS App production URL without runtime-specific fallback logic", async () => {
    const { resolveHomePins } = await loadHomePinsModule();
    withHomePins([{ id: "pb-supply-chain", kind: "app" }]);

    const pins = resolveHomePins(catalog({
      hubListings: [{
        category: "Workflow",
        config: {
          builderSnapshot: {
            appsVerified: {
              app: {
                appCode: "pb-supply-chain-agent",
                productionUrl: "https://pb-supply-chain.example.invalid",
                type: "web"
              }
            }
          }
        },
        description: "Private banking Q&A",
        id: "listing-pb-supply-chain",
        name: "PB Supply Chain Agent",
        status: "listed",
        summary: "Private banking Q&A",
        tags: ["workflow"],
        targetId: "pb-supply-chain",
        type: "app"
      }]
    }));

    assert.equal(pins[0].launchUrl, "https://pb-supply-chain.example.invalid");
  });

  it("drops a saved pin when the target is absent from the authorized Hub projection", async () => {
    const { resolveHomePins } = await loadHomePinsModule();
    withHomePins([{ id: "hidden-app", kind: "app" }]);

    const pins = resolveHomePins(catalog({
      apps: [{ id: "hidden-app", name: "Hidden App", status: "listed" }],
      publicationListings: [{ id: "listing-hidden", type: "app", targetId: "hidden-app", status: "listed" }]
    }));

    assert.deepEqual(pins, []);
  });
});
