import assert from "node:assert/strict";
import test from "node:test";
import { assertSameOrigin } from "./http.ts";

test("same-origin guard accepts matching production origins", () => {
  assert.doesNotThrow(() => assertSameOrigin(new Request("https://mate-runtime.example/api", {
    headers: { origin: "https://mate-runtime.example", "sec-fetch-site": "same-origin" }
  })));
});

test("same-origin guard allows Wrangler's local custom-domain rewrite only in explicit dev mode", () => {
  const request = new Request("https://mate-runtime.example/api", {
    headers: { origin: "http://localhost:8798", "sec-fetch-site": "same-origin" }
  });
  assert.throws(() => assertSameOrigin(request), (error) => error?.status === 403);
  assert.doesNotThrow(() => assertSameOrigin(request, true));
});

test("same-origin guard never treats a Cloudflare edge request as local bypass", () => {
  const request = new Request("https://mate-runtime.example/api", {
    headers: {
      "cf-ray": "edge-request",
      origin: "http://localhost:8798",
      "sec-fetch-site": "same-origin"
    }
  });
  assert.throws(() => assertSameOrigin(request, true), (error) => error?.status === 403);
});
