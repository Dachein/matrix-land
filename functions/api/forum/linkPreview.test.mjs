import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildForumLinkEmbed, resolveForumLinkEmbed, sanitizeForumLinkEmbeds } from "./linkPreview.ts";

function makeDeps(overrides = {}) {
  return {
    httpError(status, message) {
      return Object.assign(new Error(message), { status });
    },
    ...overrides
  };
}

describe("forum link preview", () => {
  it("builds YouTube previews without fetching remote HTML", async () => {
    const preview = await resolveForumLinkEmbed("https://youtu.be/abcDEF12345", makeDeps({
      async fetchForumLinkPreview() {
        throw new Error("fetch should not be called for YouTube embeds");
      }
    }));

    assert.equal(preview.provider, "YouTube");
    assert.equal(preview.embedType, "video");
    assert.equal(preview.previewImageUrl, "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg");
  });

  it("builds social and WeChat fallback embeds", () => {
    const xEmbed = buildForumLinkEmbed(new URL("https://x.com/workspace_ai/status/12345"));
    const wechatEmbed = buildForumLinkEmbed(new URL("https://mp.weixin.qq.com/s/example"));

    assert.equal(xEmbed.provider, "X");
    assert.equal(xEmbed.title, "@workspace_ai on X");
    assert.equal(xEmbed.embedType, "social");
    assert.equal(wechatEmbed.provider, "WeChat Official Account");
    assert.equal(wechatEmbed.embedType, "link");
  });

  it("rejects unsafe initial URLs, IP literals and alternative IP representations", async () => {
    const unsafeUrls = [
      "",
      `https://public-example.com/${"a".repeat(2048)}`,
      "ftp://example.com/file",
      "http://localhost/admin",
      "http://service.local/resource",
      "http://metadata.google.internal/computeMetadata/v1",
      "http://service.test/resource",
      "http://127.0.0.1/admin",
      "http://127.1/admin",
      "http://2130706433/admin",
      "http://0x7f000001/admin",
      "http://017700000001/admin",
      "http://0300.0250.0001.0001/admin",
      "http://169.254.169.254/latest/meta-data",
      "http://192.0.2.1/reserved",
      "http://[::1]/admin",
      "http://[::ffff:127.0.0.1]/admin",
      "https://user:password@mp.weixin.qq.com/s/example",
      "https://mp.weixin.qq.com:8443/s/example"
    ];
    let fetchCalls = 0;
    const deps = makeDeps({
      async fetchForumLinkPreview() {
        fetchCalls += 1;
        return new Response("");
      }
    });

    for (const unsafeUrl of unsafeUrls) {
      await assert.rejects(
        () => resolveForumLinkEmbed(unsafeUrl, deps),
        (error) => error.status === 400 && error.message === "invalid_forum_link_url",
        unsafeUrl
      );
    }

    assert.equal(fetchCalls, 0);
  });

  it("normalizes public URLs but fetches OpenGraph only from exact trusted hosts", async () => {
    let fetchCalls = 0;
    const preview = await resolveForumLinkEmbed("NEWS.PUBLIC-EXAMPLE.COM./article", makeDeps({
      async fetchForumLinkPreview() {
        fetchCalls += 1;
        return new Response("");
      }
    }));

    assert.equal(preview.url, "https://news.public-example.com/article");
    assert.equal(preview.provider, "news.public-example.com");
    assert.equal(fetchCalls, 0);
  });

  it("reads OpenGraph HTML from a trusted host with manual redirects", async () => {
    const calls = [];
    const preview = await resolveForumLinkEmbed("https://mp.weixin.qq.com/s/start", makeDeps({
      async fetchForumLinkPreview(input, init) {
        calls.push({ input: String(input), redirect: init.redirect });

        if (calls.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "/s/final" }
          });
        }

        return new Response(`
          <html>
            <head>
              <meta property="og:title" content="A safe preview">
              <meta property="og:description" content="Preview description">
              <meta property="og:image" content="https://images.public-example.com/cover.png">
            </head>
          </html>
        `, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
    }));

    assert.deepEqual(calls, [
      { input: "https://mp.weixin.qq.com/s/start", redirect: "manual" },
      { input: "https://mp.weixin.qq.com/s/final", redirect: "manual" }
    ]);
    assert.equal(preview.title, "A safe preview");
    assert.equal(preview.description, "Preview description");
    assert.equal(preview.previewImageUrl, "https://images.public-example.com/cover.png");
  });

  it("does not follow redirects to private or untrusted destinations", async () => {
    const blockedLocations = [
      "http://2130706433/admin",
      "http://[::1]/admin",
      "https://untrusted-public-domain.com/next",
      "https://user:password@mp.weixin.qq.com/s/next"
    ];

    for (const location of blockedLocations) {
      const calls = [];
      const preview = await resolveForumLinkEmbed("https://mp.weixin.qq.com/s/start", makeDeps({
        async fetchForumLinkPreview(input, init) {
          calls.push({ input: String(input), redirect: init.redirect });
          return new Response(null, { status: 302, headers: { location } });
        }
      }));

      assert.equal(calls.length, 1, location);
      assert.equal(calls[0].redirect, "manual");
      assert.equal(preview.title, "WeChat article");
    }
  });

  it("stops after the maximum number of trusted redirects", async () => {
    let fetchCalls = 0;
    const preview = await resolveForumLinkEmbed("https://mp.weixin.qq.com/s/start", makeDeps({
      async fetchForumLinkPreview() {
        fetchCalls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: `/s/redirect-${fetchCalls}` }
        });
      }
    }));

    assert.equal(fetchCalls, 4);
    assert.equal(preview.title, "WeChat article");
  });

  it("accepts only exact HTML content types", async () => {
    const preview = await resolveForumLinkEmbed("https://mp.weixin.qq.com/s/example", makeDeps({
      async fetchForumLinkPreview() {
        return new Response("<title>Should not be parsed</title>", {
          headers: { "content-type": "text/html-malicious" }
        });
      }
    }));

    assert.equal(preview.title, "WeChat article");
  });

  it("cancels a streaming response as soon as the byte limit is exceeded", async () => {
    let bodyCancelled = false;
    const oversizedBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(100_000));
        controller.enqueue(new Uint8Array(100_000));
      },
      cancel() {
        bodyCancelled = true;
      }
    });
    const preview = await resolveForumLinkEmbed("https://mp.weixin.qq.com/s/example", makeDeps({
      async fetchForumLinkPreview() {
        return new Response(oversizedBody, {
          headers: { "content-type": "text/html" }
        });
      }
    }));

    assert.equal(bodyCancelled, true);
    assert.equal(preview.title, "WeChat article");
  });

  it("rejects an oversized declared body before consuming it", async () => {
    let bodyCancelled = false;
    const body = new ReadableStream({
      cancel() {
        bodyCancelled = true;
      }
    });
    const preview = await resolveForumLinkEmbed("https://mp.weixin.qq.com/s/example", makeDeps({
      async fetchForumLinkPreview() {
        return new Response(body, {
          headers: {
            "content-length": "160001",
            "content-type": "text/html"
          }
        });
      }
    }));

    assert.equal(bodyCancelled, true);
    assert.equal(preview.title, "WeChat article");
  });

  it("drops unsafe OpenGraph image URLs", async () => {
    const preview = await resolveForumLinkEmbed("https://mp.weixin.qq.com/s/example", makeDeps({
      async fetchForumLinkPreview() {
        return new Response('<meta property="og:image" content="http://127.0.0.1/private.png">', {
          headers: { "content-type": "text/html" }
        });
      }
    }));

    assert.equal(preview.previewImageUrl, undefined);
  });

  it("aborts a slow trusted-host request", async () => {
    let observedAbort = false;
    const preview = await resolveForumLinkEmbed("https://mp.weixin.qq.com/s/example", makeDeps({
      forumLinkPreviewTimeoutMs: 5,
      fetchForumLinkPreview(_input, init) {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
    }));

    assert.equal(observedAbort, true);
    assert.equal(preview.title, "WeChat article");
  });

  it("sanitizes to a single link embed", async () => {
    const previews = await sanitizeForumLinkEmbeds(["", "news.public-example.com/topic"], makeDeps());

    assert.equal(previews.length, 1);
    assert.equal(previews[0].url, "https://news.public-example.com/topic");
    assert.equal(previews[0].provider, "news.public-example.com");
  });
});
