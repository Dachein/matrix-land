import assert from "node:assert/strict";
import test from "node:test";
import { fetchPublicWeb, searchPublicWeb } from "./web.ts";

test("Cloudflare Exa returns public discovery metadata", async () => {
  const env = {
    AI: {
      websearch: async ({ limit, query, provider, gatewayId }) => {
        assert.equal(provider, "exa");
        assert.equal(gatewayId, "default");
        assert.equal(limit, 3);
        assert.equal(query, "Cloudflare Agents");
        return Response.json({
          items: [{
            description: "Official documentation",
            lastModifiedDate: "2026-08-01T00:00:00",
            title: "Agents",
            url: "https://developers.cloudflare.com/agents/"
          }],
          metadata: { latencyMs: 20, query, requestId: "search-1" }
        });
      }
    }
  };
  const result = await searchPublicWeb(env, "Cloudflare Agents", 3);

  assert.equal(result.searchProvider, "exa");
  assert.equal(result.count, 1);
  assert.equal(result.results[0].url, "https://developers.cloudflare.com/agents/");
  assert.equal(result.requestId, "search-1");
});

test("web fetch converts an allowed public page to Markdown and records fetch time", async () => {
  const env = {
    AI: {
      toMarkdown: async (document, options) => {
        assert.equal(document.name, "page.html");
        assert.equal(options.conversionOptions.html.hostname, "https://docs.example.com");
        return { data: "# Public Guide\n\nVerified body.", format: "markdown" };
      }
    }
  };
  const result = await fetchPublicWeb(env, "https://docs.example.com/guide", {}, {
    fetch: async () => new Response("<h1>Public Guide</h1>", {
      headers: { "content-type": "text/html; charset=utf-8" }
    }),
    now: () => new Date("2026-08-13T01:02:03.000Z")
  });

  assert.equal(result.title, "Public Guide");
  assert.equal(result.fetchedAt, "2026-08-13T01:02:03.000Z");
  assert.match(result.content, /Verified body/);
});

test("web fetch blocks local and private network targets before issuing a request", async () => {
  let called = false;
  await assert.rejects(
    fetchPublicWeb({}, "http://127.0.0.1/admin", {}, {
      fetch: async () => {
        called = true;
        return new Response("secret");
      }
    }),
    (error) => error?.status === 403 && error?.message === "web_fetch_private_address_blocked"
  );
  assert.equal(called, false);
});

 test("Exa failures and malformed responses are reported instead of silently using an OpenAI model", async () => {
  for (const response of [new Response("Unavailable", { status: 503 }), Response.json({ error: "not results" }), Response.json({ items: [null] })]) {
    await assert.rejects(searchPublicWeb({ AI: {
      websearch: async () => response,
      run: async () => { throw Error("Must not fall back to OpenAI"); }
    } }, "MAS regulations"), (error) => error.status === 502);
  }
  await assert.rejects(searchPublicWeb({}, "MAS"), (error) => error.status === 503);
});
