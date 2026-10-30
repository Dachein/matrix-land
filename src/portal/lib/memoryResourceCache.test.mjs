import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearMemoryResources,
  invalidateMemoryResources,
  loadMemoryResource,
  readMemoryResource,
  writeMemoryResource
} from "./memoryResourceCache.ts";
import {
  publishUserJourneyProjectionUpdate,
  withLatestUserJourneyProjection
} from "./userJourneyProjectionEvents.ts";

afterEach(() => clearMemoryResources());

describe("memory resource cache", () => {
  it("returns fresh values without repeating the loader", async () => {
    let calls = 0;
    const load = async () => ({ value: ++calls });
    const first = await loadMemoryResource({ key: "user-1:apps", load, maxAgeMs: 1_000, now: 100 });
    const second = await loadMemoryResource({ key: "user-1:apps", load, maxAgeMs: 1_000, now: 200 });

    assert.equal(calls, 1);
    assert.equal(first.value, 1);
    assert.equal(second.value, 1);
  });

  it("deduplicates concurrent loads and keeps stale data when inspected", async () => {
    let resolve;
    let calls = 0;
    const load = () => {
      calls += 1;
      return new Promise((done) => { resolve = done; });
    };
    const left = loadMemoryResource({ key: "user-1:knowledge", load, maxAgeMs: 1_000 });
    const right = loadMemoryResource({ key: "user-1:knowledge", load, maxAgeMs: 1_000 });
    resolve({ items: ["one"] });

    assert.deepEqual(await left, { items: ["one"] });
    assert.deepEqual(await right, { items: ["one"] });
    assert.equal(calls, 1);
    const cached = readMemoryResource("user-1:knowledge", 1, Date.now() + 10);
    assert.equal(cached?.fresh, false);
    assert.deepEqual(cached?.value, { items: ["one"] });
  });

  it("invalidates only the requested user-scoped prefix", () => {
    writeMemoryResource("user-1:knowledge:a", 1, 10);
    writeMemoryResource("user-1:knowledge:b", 2, 10);
    writeMemoryResource("user-2:knowledge:a", 3, 10);
    invalidateMemoryResources("user-1:knowledge:");

    assert.equal(readMemoryResource("user-1:knowledge:a", 100, 20), undefined);
    assert.equal(readMemoryResource("user-1:knowledge:b", 100, 20), undefined);
    assert.equal(readMemoryResource("user-2:knowledge:a", 100, 20)?.value, 3);
  });

  it("does not restore an invalidated value when an older request finishes", async () => {
    let resolve;
    const request = loadMemoryResource({
      key: "user-1:token",
      load: () => new Promise((done) => { resolve = done; }),
      maxAgeMs: 1_000
    });

    invalidateMemoryResources("user-1:");
    resolve({ status: "obsolete" });
    assert.deepEqual(await request, { status: "obsolete" });
    assert.equal(readMemoryResource("user-1:token", 1_000), undefined);
  });

  it("keeps the latest Journey projection for profile actions opened after an award", () => {
    publishUserJourneyProjectionUpdate({
      id: "user-awarded",
      journeyBadgeCount: 4,
      journeyCommunityContributionPoints: 80,
      journeyLevelKey: "contributor",
      journeyTotalPoints: 230
    });

    assert.deepEqual(withLatestUserJourneyProjection({
      id: "user-awarded",
      name: "Ada",
      journeyCommunityContributionPoints: 50,
      journeyTotalPoints: 200
    }), {
      id: "user-awarded",
      journeyBadgeCount: 4,
      journeyCommunityContributionPoints: 80,
      journeyLevelKey: "contributor",
      journeyTotalPoints: 230,
      name: "Ada"
    });
  });
});
