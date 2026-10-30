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

describe("Workspace MCP Handbook direct page", () => {
  it("serves the Portal shell from the canonical handbook path", async () => {
    const fixture = assets();
    const response = await serveMcpHandbookPage(
      new Request("https://ai.example.invalid/workspace-pass-mcp/handbook"),
      fixture.env
    );

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(new URL(fixture.requests[0].url).pathname, "/");
  });

  it("accepts a trailing slash but rejects unknown paths and write methods", async () => {
    const fixture = assets();
    assert.equal((await serveMcpHandbookPage(
      new Request("https://ai.example.invalid/workspace-pass-mcp/handbook/"),
      fixture.env
    )).status, 200);
    assert.equal((await serveMcpHandbookPage(
      new Request("https://ai.example.invalid/workspace-pass-mcp/unknown"),
      fixture.env
    )).status, 404);
    const methodResponse = await serveMcpHandbookPage(
      new Request("https://ai.example.invalid/workspace-pass-mcp/handbook", { method: "POST" }),
      fixture.env
    );
    assert.equal(methodResponse.status, 405);
    assert.equal(methodResponse.headers.get("allow"), "GET, HEAD");
  });
});
