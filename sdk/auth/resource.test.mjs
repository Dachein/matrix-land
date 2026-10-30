import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkspaceAuthResource, WorkspaceAuthSdkError } from "./index.ts";

describe("WorkspaceAuthResource", () => {
  it("introspects bearer tokens without requiring an app client id", async () => {
    const calls = [];
    const sdk = new WorkspaceAuthResource({
      authOrigin: "https://auth.test/",
      introspectionToken: "introspect-secret",
      async fetcher(url, init) {
        calls.push({ init, url });
        return new Response(JSON.stringify({
          active: true,
          aud: "https://api.example.com",
          resource_id: "orders-api",
          client_id: "caller-client",
          exp: 1234,
          scope: "orders:read orders:write",
          sub: "user-1",
          email: "ada@example.com",
          name: "Ada"
        }));
      }
    });

    const request = new Request("https://api.example.com/orders", {
      headers: {
        authorization: "Bearer access-token"
      }
    });
    const claims = await sdk.requireAccess(request, {
      audience: "https://api.example.com",
      resourceId: "orders-api",
      scopes: ["orders:read"]
    });

    assert.equal(calls[0].url, "https://auth.test/v1/tokens/introspect");
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer introspect-secret");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      audience: "https://api.example.com",
      scopes: ["orders:read"],
      token: "access-token"
    });
    assert.equal(claims.sub, "user-1");
    assert.equal(claims.clientId, "caller-client");
    assert.equal(claims.appId, "orders-api");
    assert.deepEqual(claims.scopes, ["orders:read", "orders:write"]);
  });

  it("rejects missing required scopes", async () => {
    const sdk = new WorkspaceAuthResource({
      authOrigin: "https://auth.test",
      async fetcher() {
        return new Response(JSON.stringify({
          active: true,
          aud: "https://api.example.com",
          principal: {
            scopes: ["orders:read"],
            sub: "user-1"
          }
        }));
      }
    });

    await assert.rejects(
      () => sdk.verifyAccessToken("access-token", { scopes: ["orders:write"] }),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "token_scope_missing" && error.status === 403
    );
  });

  it("rejects a token minted for another Resource with the same audience", async () => {
    const sdk = new WorkspaceAuthResource({
      authOrigin: "https://auth.test",
      async fetcher() {
        return Response.json({
          active: true,
          aud: "https://api.example.com",
          resource_id: "other-api",
          scopes: ["orders:read"],
          sub: "user-1"
        });
      }
    });

    await assert.rejects(
      () => sdk.verifyAccessToken("access-token", {
        audience: "https://api.example.com",
        resourceId: "orders-api",
        scopes: ["orders:read"]
      }),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "token_resource_mismatch" && error.status === 403
    );
  });
});
