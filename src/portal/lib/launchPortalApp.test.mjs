import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { launchPortalApp } from "./launchPortalApp.ts";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});

describe("Portal App launch", () => {
  it("opens the canonical App origin without requesting a legacy direct-jump token", async () => {
    const target = { location: { href: "" }, opener: {} };
    const requests = [];
    globalThis.window = {
      location: { assign() { throw new Error("same_window_not_expected"); } },
      open() { return target; }
    };
    globalThis.fetch = async (input, init) => {
      requests.push({ input, init });
      return new Response("{}", { status: 201 });
    };

    await launchPortalApp({
      id: "app-1",
      launchUrl: "https://app-1.example.invalid",
      trackingSource: "test_entry"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(target.opener, null);
    assert.equal(target.location.href, "https://app-1.example.invalid");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, "/api/publication/interactions");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      action: "app.visit_url",
      source: "test_entry",
      targetId: "app-1"
    });
  });

  it("uses same-window navigation when the browser blocks the new tab", async () => {
    let assigned = "";
    globalThis.window = {
      location: { assign(value) { assigned = value; } },
      open() { return null; }
    };
    globalThis.fetch = async () => new Response("{}", { status: 201 });

    await launchPortalApp({ id: "app-1", launchUrl: "https://app-1.example.invalid" });

    assert.equal(assigned, "https://app-1.example.invalid");
  });
});
