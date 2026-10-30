import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serveMcpHandbookPage } from "./[[path]].ts";

function assets() {
  const requests = [];
  return {
    env: {
      ASSETS: {
        async fetch(request) {
          requests.push(request);
          return new Response("<!doctype html><title>Frontier Workspace</title>", {
            headers: { "content-type": "text/html" }
          });
        }
      }
    },
    requests
  };
}

describe("Legacy MCP Handbook direct page", () => {
  it("permanently redirects the legacy handbook path to Workspace MCP", async () => {
    const fixture = assets();
    const response = await serveMcpHandbookPage(
      new Request("https://ai.example.invalid/workspace-ai-mcp/handbook"),
      fixture.env
    );

    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "https://ai.example.invalid/workspace-pass-mcp/handbook");
    assert.equal(fixture.requests.length, 0);
  });

  it("accepts a trailing slash but rejects unknown paths and write methods", async () => {
    const fixture = assets();
    assert.equal((await serveMcpHandbookPage(
      new Request("https://ai.example.invalid/workspace-ai-mcp/handbook/"),
      fixture.env
    )).status, 308);
    assert.equal((await serveMcpHandbookPage(
      new Request("https://ai.example.invalid/workspace-ai-mcp/unknown"),
      fixture.env
    )).status, 404);
    const methodResponse = await serveMcpHandbookPage(
      new Request("https://ai.example.invalid/workspace-ai-mcp/handbook", { method: "POST" }),
      fixture.env
    );
    assert.equal(methodResponse.status, 405);
    assert.equal(methodResponse.headers.get("allow"), "GET, HEAD");
  });
});
