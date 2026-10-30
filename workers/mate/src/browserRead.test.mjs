import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizePublicWebUrl,
  publicWebUrlFromInstruction,
  readPublicWebPage
} from "./browserRead.ts";
import { kitesurfTestBinding } from "./kitesurfTestBinding.mjs";

describe("Kitesurf public web reader", () => {
  it("extracts one HTTPS URL and accepts only public HTTPS port 443 targets", () => {
    assert.equal(
      publicWebUrlFromInstruction("请阅读 https://example.com/docs?q=browser。"),
      "https://example.com/docs?q=browser"
    );
    assert.equal(publicWebUrlFromInstruction("没有链接"), undefined);
    assert.equal(normalizePublicWebUrl("https://example.com.:443/docs#part"), "https://example.com/docs");
    assert.equal(
      normalizePublicWebUrl("https://[2606:4700:4700::1111]/dns"),
      "https://[2606:4700:4700::1111]/dns"
    );
    for (const value of [
      "http://example.com",
      "https://example.com:444/",
      "https://localhost/admin",
      "https://intranet/admin",
      "https://service.internal/",
      "https://service.test/",
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://0x7f000001/",
      "https://10.0.0.1/",
      "https://169.254.169.254/",
      "https://192.0.2.1/",
      "https://[::1]/",
      "https://[fc00::1]/",
      "https://[fe80::1]/",
      "https://user:password@example.com/"
    ]) {
      assert.throws(() => normalizePublicWebUrl(value), /public_web_url_not_allowed/);
    }
  });

  it("opens a guarded Kitesurf CDP session and intercepts requests before navigation", async () => {
    const binding = kitesurfTestBinding();
    const result = await readPublicWebPage({ BROWSER: binding.BROWSER }, "https://example.com/article#section");

    assert.equal(binding.calls.length, 1);
    const endpoint = new URL(binding.calls[0].url);
    const headers = new Headers(binding.calls[0].init.headers);
    assert.equal(endpoint.origin, "https://localhost");
    assert.equal(endpoint.pathname, "/v1/devtools/browser");
    assert.equal(endpoint.searchParams.get("browser"), "kitesurf");
    assert.equal(headers.get("upgrade"), "websocket");
    assert.deepEqual(
      JSON.parse(Buffer.from(headers.get("cf-brapi-guardrails"), "base64url").toString("utf8")),
      { allowedDomains: ["example.com"] }
    );
    assert.deepEqual(binding.commands.map((command) => command.method), [
      "Target.createTarget",
      "Target.attachToTarget",
      "Page.enable",
      "Runtime.enable",
      "Fetch.enable",
      "Page.navigate",
      "Fetch.continueRequest",
      "Runtime.evaluate"
    ]);
    assert.equal(binding.commands[5].params.url, "https://example.com/article");
    assert.equal(result.engine, "kitesurf");
    assert.equal(result.url, "https://example.com/article");
    assert.match(result.markdown, /^# Workspace public page/);
    assert.match(result.markdown, /Kitesurf rendered this evidence/);
    assert.match(result.markdown, /\[More\]\(https:\/\/example\.com\/more\)/);
    assert.match(result.contentDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.truncated, false);
  });

  it("uses the production Browser Run markdown quick action with a same-origin request policy", async () => {
    const calls = [];
    const result = await readPublicWebPage({
      BROWSER: {
        fetch: async () => new Response("unused"),
        async quickAction(action, options) {
          calls.push({ action, options });
          return Response.json({
            result: "# Example Domain\n\nRendered by Browser Run.",
            success: true
          });
        }
      }
    }, "https://example.com/article#section");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "markdown");
    assert.equal(calls[0].options.url, "https://example.com/article");
    assert.deepEqual(calls[0].options.allowRequestPattern, ["/^https:\\/\\/example\\.com(?:\\/|$)/"]);
    assert.equal(calls[0].options.browser, "kitesurf");
    assert.equal(calls[0].options.cacheTTL, 0);
    assert.equal(result.engine, "kitesurf");
    assert.match(result.markdown, /^Source: https:\/\/example\.com\/article/);
    assert.match(result.markdown, /Rendered by Browser Run/);
  });

  it("fails closed on malformed and unsuccessful Browser Run quick-action responses", async () => {
    for (const response of [
      Response.json({ result: "", success: true }),
      Response.json({ errors: [{ message: "navigation failed" }], success: false }, { status: 502 }),
      new Response("not json", { status: 502 })
    ]) {
      await assert.rejects(readPublicWebPage({
        BROWSER: {
          fetch: async () => new Response("unused"),
          quickAction: async () => response.clone()
        }
      }, "https://example.com"), /browser_run_(content_empty|read_failed)/);
    }
  });

  it("blocks cross-origin resources and fails closed on a cross-origin document redirect", async () => {
    const subresource = kitesurfTestBinding({
      requests: [
        { resourceType: "Document", url: "https://example.com/article" },
        { resourceType: "Script", url: "https://cdn.example.net/app.js" }
      ]
    });
    const result = await readPublicWebPage({ BROWSER: subresource.BROWSER }, "https://example.com/article");
    assert.equal(result.url, "https://example.com/article");
    assert.equal(subresource.commands.some((command) => command.method === "Fetch.failRequest"), true);

    const redirect = kitesurfTestBinding({
      requests: [
        { resourceType: "Document", url: "https://example.com/article" },
        { resourceType: "Document", url: "https://redirect.example.net/article" }
      ]
    });
    await assert.rejects(
      readPublicWebPage({ BROWSER: redirect.BROWSER }, "https://example.com/article"),
      /public_web_url_not_allowed/
    );
    assert.equal(redirect.commands.some((command) => command.method === "Fetch.failRequest"), true);
    assert.equal(redirect.commands.some((command) => command.method === "Runtime.evaluate"), false);
  });

  it("fails closed when the Browser Run binding is absent", async () => {
    await assert.rejects(
      readPublicWebPage({}, "https://example.com"),
      /browser_run_not_configured/
    );
  });
});
