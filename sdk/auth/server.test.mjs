import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkspaceAuthServer } from "./server.ts";

describe("WorkspaceAuthServer", () => {
  it("reads launch callback params from code and migration token callbacks", () => {
    const sdk = new WorkspaceAuthServer({
      appId: "app-1",
      authOrigin: "https://auth.test"
    });

    assert.deepEqual(
      sdk.readLaunchParams("https://app.test/auth/workspace/callback?client_id=app-1&code=launch-code&redirect_url=https%3A%2F%2Fapp.test%2Fhome"),
      {
        accessResult: undefined,
        appId: "app-1",
        code: "launch-code",
        error: undefined,
        requestId: undefined,
        redirectUrl: "https://app.test/home",
        token: undefined
      }
    );

    assert.deepEqual(
      sdk.readLaunchParams("https://app.test/auth/workspace/callback?app_id=app-1&workspace_token=direct-jump"),
      {
        accessResult: undefined,
        appId: "app-1",
        code: undefined,
        error: undefined,
        requestId: undefined,
        redirectUrl: undefined,
        token: "direct-jump"
      }
    );
  });

  it("preserves a signed access result on a denied Auth response", async () => {
    const sdk = new WorkspaceAuthServer({
      appId: "app-1",
      authOrigin: "https://auth.test",
      async fetcher() {
        return Response.json({
          accessResult: "signed-access-result",
          error: "access_denied",
          requestId: "request-1"
        }, { status: 403 });
      }
    });

    await assert.rejects(
      sdk.exchangeLaunch({ code: "denied-code", redirectUri: "https://app.test/auth/workspace/callback" }),
      (error) => error?.status === 403
        && error?.details?.accessResult === "signed-access-result"
        && error?.details?.requestId === "request-1"
    );
  });

  it("exchanges launch credentials with app client authentication", async () => {
    const calls = [];
    const sdk = new WorkspaceAuthServer({
      appId: "app-1",
      appSecret: "secret-1",
      authOrigin: "https://auth.test/",
      async fetcher(url, init) {
        calls.push({ init, url });
        return new Response(JSON.stringify({
          appId: "app-1",
          expiresAt: 1234,
          requestId: "req-1",
          tokenType: "Bearer",
          user: {
            defaultAgent: { id: "finance-assistant", name: "小鲸", email: "receipts-assistant@example.invalid" },
            departmentId: "dept-ops",
            departmentPath: ["dept-company", "dept-ops"],
            id: "user-1",
            email: "ada@example.com",
            name: "Ada",
            role: "member"
          },
          valid: true
        }));
      }
    });

    const result = await sdk.exchangeLaunch({
      code: "launch-code",
      redirectUri: "https://app.test/auth/workspace/callback"
    });

    assert.equal(calls[0].url, "https://auth.test/v1/app-login/exchange");
    assert.equal(calls[0].init.headers.get("authorization"), `Basic ${btoa("app-1:secret-1")}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      appId: "app-1",
      clientId: "app-1",
      code: "launch-code",
      redirectUri: "https://app.test/auth/workspace/callback"
    });

    assert.equal(result.valid, true);
    assert.equal(result.user.id, "user-1");
    assert.equal(result.claims.sub, "user-1");
    assert.deepEqual(result.claims.defaultAgent, result.user.defaultAgent);
    assert.equal(result.claims.aud, "app-1");
    assert.equal(result.claims.departmentId, "dept-ops");
    assert.deepEqual(result.claims.departmentPath, ["dept-company", "dept-ops"]);
  });

  it("invokes the default runtime fetch without rebinding its receiver", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async function runtimeFetch() {
      assert.equal(this, undefined);
      calls += 1;
      return Response.json({
        appId: "app-1",
        user: { id: "user-1" },
        valid: true
      });
    };

    try {
      const sdk = new WorkspaceAuthServer({
        appId: "app-1",
        authOrigin: "https://auth.test"
      });

      const result = await sdk.exchangeLaunch({
        code: "launch-code",
        redirectUri: "https://app.test/auth/workspace/callback"
      });

      assert.equal(calls, 1);
      assert.equal(result.valid, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to migration token verification when no code is present", async () => {
    const calls = [];
    const sdk = new WorkspaceAuthServer({
      appId: "app-1",
      authOrigin: "https://auth.test",
      async fetcher(url, init) {
        calls.push({ init, url });
        return new Response(JSON.stringify({
          appId: "app-1",
          expiresAt: 1234,
          user: { id: "user-1" },
          valid: true
        }));
      }
    });

    const result = await sdk.exchangeLaunch({ token: "direct-jump-token" });

    assert.equal(calls[0].url, "https://auth.test/v1/app-login/verify");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      appId: "app-1",
      token: "direct-jump-token"
    });
    assert.equal(result.valid, true);
  });
});
