import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WORKSPACE_APP_AUTH_STATE_COOKIE,
  WORKSPACE_APP_SESSION_COOKIE,
  WorkspaceAuthSdkError,
  WorkspaceBrowserAppSession
} from "./index.ts";

const APP_ORIGIN = "https://onboarding.test";
const BASE_PATH = "/people";
const NOW = 1_800_000_000_000;
const SESSION_SECRET = "workspace-app-session-test-secret-with-at-least-32-characters";

function createSession(overrides = {}) {
  return new WorkspaceBrowserAppSession({
    appId: "app-onboarding",
    appOrigin: APP_ORIGIN,
    appSecret: "app-basic-secret-with-at-least-32-characters",
    appVersion: "deploy-2026-07-16.1",
    authOrigin: "https://auth.internal.test",
    authorizeOrigin: "https://auth.public.test",
    basePath: BASE_PATH,
    now: () => NOW,
    sessionSecret: SESSION_SECRET,
    ...overrides
  });
}

function startAttempt(session, returnTo = `${BASE_PATH}/welcome?step=profile`) {
  const response = session.start(new Request(
    `${APP_ORIGIN}${BASE_PATH}/auth/workspace/start?return_to=${encodeURIComponent(returnTo)}`
  ));
  const authorize = new URL(response.headers.get("location"));
  const redirectUrl = new URL(authorize.searchParams.get("redirect_url"));
  const state = redirectUrl.searchParams.get("workspace_auth_state");
  return {
    authorize,
    redirectUrl,
    response,
    state,
    stateCookie: cookiePair(response.headers.get("set-cookie"), WORKSPACE_APP_AUTH_STATE_COOKIE)
  };
}

function callbackRequest(attempt, query = {}) {
  const url = new URL(`${APP_ORIGIN}${BASE_PATH}/auth/workspace/callback`);
  url.searchParams.set("app_id", query.appId ?? "app-onboarding");
  if (query.code !== null) {
    url.searchParams.set("code", query.code ?? "fac_one_time_code");
  }
  if (query.error) {
    url.searchParams.set("error", query.error);
  }
  if (query.accessResult) {
    url.searchParams.set("access_result", query.accessResult);
  }
  if (query.redirectUrl !== null) {
    url.searchParams.set("redirect_url", query.redirectUrl ?? attempt.redirectUrl.toString());
  }
  if (query.token) {
    url.searchParams.set("workspace_token", query.token);
  }
  return new Request(url, query.withoutState ? undefined : {
    headers: { Cookie: attempt.stateCookie }
  });
}

function cookiePair(setCookie, name) {
  const match = (setCookie ?? "").match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
  assert.ok(match, `missing cookie ${name}`);
  return `${name}=${match[1]}`;
}

function cookieToken(setCookie, name) {
  return decodeURIComponent(cookiePair(setCookie, name).slice(name.length + 1));
}

describe("WorkspaceBrowserAppSession", () => {
  it("always starts at authorize with a random browser-bound state", () => {
    const session = createSession();
    const attempt = startAttempt(session);
    const setCookie = attempt.response.headers.get("set-cookie") ?? "";

    assert.equal(attempt.response.status, 302);
    assert.equal(attempt.authorize.toString().startsWith("https://auth.public.test/auth/v1/authorize?"), true);
    assert.equal(attempt.authorize.searchParams.get("app_id"), "app-onboarding");
    assert.equal(
      attempt.authorize.searchParams.get("redirect_uri"),
      `${APP_ORIGIN}${BASE_PATH}/auth/workspace/callback`
    );
    assert.equal(attempt.redirectUrl.origin, APP_ORIGIN);
    assert.equal(attempt.redirectUrl.pathname, `${BASE_PATH}/welcome`);
    assert.match(attempt.state, /^[A-Za-z0-9_-]{40,}$/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\/people\//);
  });

  it("falls back to the App home for cross-origin or out-of-base return targets", () => {
    const session = createSession();
    for (const target of ["https://attacker.test/steal", "/people-admin", "//attacker.test/steal"]) {
      const attempt = startAttempt(session, target);
      assert.equal(attempt.redirectUrl.origin, APP_ORIGIN);
      assert.equal(attempt.redirectUrl.pathname, `${BASE_PATH}/`);
    }
  });

  it("exchanges only a state-bound code with App Basic auth and creates a local cookie", async () => {
    const calls = [];
    let authoritativeRedirect;
    const session = createSession({
      async fetcher(url, init) {
        calls.push({ init, url });
        return Response.json({
          appId: "app-onboarding",
          redirectUrl: authoritativeRedirect,
          user: {
            defaultAgent: { id: "finance-assistant", name: "小鲸", email: "receipts-assistant@example.invalid" },
            department: "People",
            departmentId: "dept-people",
            departmentPath: ["dept-company", "dept-people"],
            email: "person@example.test",
            id: "user-authoritative",
            name: "Official User",
            role: "member",
            status: "active"
          },
          valid: true
        });
      }
    });
    const attempt = startAttempt(session);
    authoritativeRedirect = attempt.redirectUrl.toString();
    const response = await session.callback(callbackRequest(attempt));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://auth.internal.test/v1/app-login/exchange");
    assert.equal(calls[0].init.headers.get("authorization"), `Basic ${btoa("app-onboarding:app-basic-secret-with-at-least-32-characters")}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      appId: "app-onboarding",
      clientId: "app-onboarding",
      code: "fac_one_time_code",
      redirectUri: `${APP_ORIGIN}${BASE_PATH}/auth/workspace/callback`
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${APP_ORIGIN}${BASE_PATH}/welcome?step=profile`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");

    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`${WORKSPACE_APP_SESSION_COOKIE}=`));
    assert.match(setCookie, new RegExp(`${WORKSPACE_APP_AUTH_STATE_COOKIE}=;`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);

    const token = cookieToken(setCookie, WORKSPACE_APP_SESSION_COOKIE);
    const current = await session.read(new Request(`${APP_ORIGIN}${BASE_PATH}/api/me`, {
      headers: {
        Cookie: `${WORKSPACE_APP_SESSION_COOKIE}=${encodeURIComponent(token)}`,
        "x-workspace-role": "admin",
        "x-workspace-user-id": "forged-user"
      }
    }));
    assert.equal(current?.appId, "app-onboarding");
    assert.equal(current?.appVersion, "deploy-2026-07-16.1");
    assert.equal(current?.version, 1);
    assert.equal(current?.user.id, "user-authoritative");
    assert.deepEqual(current?.user.defaultAgent, { id: "finance-assistant", name: "小鲸", email: "receipts-assistant@example.invalid" });
    assert.equal(current?.user.role, "member");
    assert.equal(current?.user.departmentId, "dept-people");
    assert.equal(await session.read(new Request(`https://other-app.test${BASE_PATH}/api/me`, {
      headers: { Cookie: `${WORKSPACE_APP_SESSION_COOKIE}=${encodeURIComponent(token)}` }
    })), undefined);

    await assert.rejects(
      session.read(new Request(`${APP_ORIGIN}${BASE_PATH}/api/admin`, {
        method: "POST",
        headers: {
          Cookie: `${WORKSPACE_APP_SESSION_COOKIE}=${encodeURIComponent(token)}`,
          Origin: "https://attacker.example.invalid"
        }
      })),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "app_csrf_origin_mismatch" && error.status === 403
    );
    assert.equal((await session.read(new Request(`${APP_ORIGIN}${BASE_PATH}/api/admin`, {
      method: "POST",
      headers: {
        Cookie: `${WORKSPACE_APP_SESSION_COOKIE}=${encodeURIComponent(token)}`,
        Origin: APP_ORIGIN
      }
    })))?.user.id, "user-authoritative");
  });

  it("ignores forged x-workspace identity when no signed App cookie exists", async () => {
    const session = createSession();
    const request = new Request(`${APP_ORIGIN}${BASE_PATH}/api/admin`, {
      headers: {
        "x-workspace-role": "admin",
        "x-workspace-user-email": "admin@example.test",
        "x-workspace-user-id": "forged-admin"
      }
    });

    assert.equal(await session.read(request), undefined);
    await assert.rejects(
      session.require(request),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "missing_app_session" && error.status === 401
    );
  });

  it("rejects a code callback without the browser state before contacting Auth", async () => {
    let calls = 0;
    const session = createSession({
      async fetcher() {
        calls += 1;
        throw new Error("must not exchange");
      }
    });
    const attempt = startAttempt(session);

    await assert.rejects(
      session.callback(callbackRequest(attempt, { withoutState: true })),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "auth_state_missing" && error.status === 401
    );
    assert.equal(calls, 0);
  });

  it("rejects a callback redirect whose state or App base path is not browser-bound", async () => {
    let calls = 0;
    const session = createSession({
      async fetcher() {
        calls += 1;
        throw new Error("must not exchange");
      }
    });
    const attempt = startAttempt(session);
    const forged = new URL(`${APP_ORIGIN}/admin`);
    forged.searchParams.set("workspace_auth_state", attempt.state);

    await assert.rejects(
      session.callback(callbackRequest(attempt, { redirectUrl: forged.toString() })),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "auth_state_mismatch"
    );
    assert.equal(calls, 0);
  });

  it("sends an authorize denial to the shared Portal access page after validating state", async () => {
    let calls = 0;
    const session = createSession({
      async fetcher() {
        calls += 1;
        throw new Error("denied callback must not exchange");
      }
    });
    const attempt = startAttempt(session);
    const response = await session.callback(callbackRequest(attempt, {
      accessResult: "signed-access-result",
      code: null,
      error: "access_denied"
    }));
    const location = new URL(response.headers.get("location"));

    assert.equal(response.status, 302);
    assert.equal(location.toString(), "https://auth.public.test/auth/access?result=signed-access-result");
    assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`${WORKSPACE_APP_AUTH_STATE_COOKIE}=;`));
    assert.equal(calls, 0);
  });

  it("sends an exchange-time denial to the same shared Portal access page", async () => {
    const session = createSession({
      async fetcher() {
        return Response.json({
          accessResult: "signed-exchange-denial",
          error: "access_denied",
          requestId: "request-denied"
        }, { status: 403 });
      }
    });
    const attempt = startAttempt(session);
    const response = await session.callback(callbackRequest(attempt));
    assert.equal(
      response.headers.get("location"),
      "https://auth.public.test/auth/access?result=signed-exchange-denial"
    );
  });

  it("never verifies a legacy direct-jump token and restarts the bound code flow", async () => {
    let calls = 0;
    const session = createSession({
      async fetcher() {
        calls += 1;
        throw new Error("must not verify token");
      }
    });
    const attempt = startAttempt(session);
    const response = await session.callback(callbackRequest(attempt, {
      redirectUrl: `${APP_ORIGIN}${BASE_PATH}/requests`,
      token: "legacy-direct-jump",
      withoutState: true
    }));
    const location = new URL(response.headers.get("location"));

    assert.equal(response.status, 302);
    assert.equal(location.origin, APP_ORIGIN);
    assert.equal(location.pathname, `${BASE_PATH}/auth/workspace/start`);
    assert.equal(location.searchParams.get("return_to"), `${BASE_PATH}/requests`);
    assert.equal(calls, 0);
  });

  it("requires Auth to return valid, matching App and user data", async () => {
    const invalidResults = [
      { appId: "app-onboarding", user: { id: "user-1" }, valid: false },
      { appId: "different-app", user: { id: "user-1" }, valid: true },
      { appId: "app-onboarding", user: { id: "" }, valid: true }
    ];

    for (const invalid of invalidResults) {
      let redirectUrl;
      const session = createSession({
        async fetcher() {
          return Response.json({ ...invalid, redirectUrl });
        }
      });
      const attempt = startAttempt(session);
      redirectUrl = attempt.redirectUrl.toString();

      await assert.rejects(
        session.callback(callbackRequest(attempt)),
        (error) => error instanceof WorkspaceAuthSdkError
          && ["invalid_auth_login", "missing_auth_user_id"].includes(error.code)
          && error.status === 401
      );
    }
  });

  it("rejects tampered, expired, and differently versioned App cookies", async () => {
    let redirectUrl;
    const issuer = createSession({
      async fetcher() {
        return Response.json({
          appId: "app-onboarding",
          redirectUrl,
          user: { id: "user-1" },
          valid: true
        });
      },
      sessionTtlSeconds: 300
    });
    const attempt = startAttempt(issuer);
    redirectUrl = attempt.redirectUrl.toString();
    const response = await issuer.callback(callbackRequest(attempt));
    const token = cookieToken(response.headers.get("set-cookie"), WORKSPACE_APP_SESSION_COOKIE);
    const requestWith = (value) => new Request(`${APP_ORIGIN}${BASE_PATH}/api/me`, {
      headers: { Cookie: `${WORKSPACE_APP_SESSION_COOKIE}=${encodeURIComponent(value)}` }
    });
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    assert.equal(await issuer.read(requestWith(tampered)), undefined);
    assert.equal(await createSession({
      now: () => NOW + 301_000,
      sessionTtlSeconds: 300
    }).read(requestWith(token)), undefined);
    assert.equal(await createSession({
      appVersion: "deploy-2026-07-16.2",
      sessionTtlSeconds: 300
    }).read(requestWith(token)), undefined);
  });

  it("fails closed when the independent App session secret is shorter than 32 characters", () => {
    assert.throws(
      () => createSession({ sessionSecret: "too-short" }),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "weak_session_secret" && error.status === 503
    );
  });

  it("fails closed when the confidential App client secret is weak", () => {
    assert.throws(
      () => createSession({ appSecret: "too-short" }),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "weak_app_secret" && error.status === 503
    );
  });

  it("does not let an App extend the centralized revocation window beyond 15 minutes", () => {
    assert.throws(
      () => createSession({ sessionTtlSeconds: 901 }),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "invalid_session_ttl" && error.status === 503
    );
  });

  it("rejects an oversized user snapshot instead of creating an unreadable Cookie", async () => {
    let redirectUrl;
    const session = createSession({
      async fetcher() {
        return Response.json({
          appId: "app-onboarding",
          redirectUrl,
          user: {
            id: "large-user",
            departmentPath: Array.from({ length: 32 }, (_, index) => `department-${index}-${"x".repeat(220)}`),
            teamPath: Array.from({ length: 32 }, (_, index) => `team-${index}-${"y".repeat(220)}`)
          },
          valid: true
        });
      }
    });
    const attempt = startAttempt(session);
    redirectUrl = attempt.redirectUrl.toString();

    await assert.rejects(
      session.callback(callbackRequest(attempt)),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "app_session_too_large" && error.status === 503
    );
  });

  it("logout clears both the App session and any pending Auth state", () => {
    const response = createSession().logout();
    const setCookie = response.headers.get("set-cookie") ?? "";

    assert.match(setCookie, new RegExp(`${WORKSPACE_APP_SESSION_COOKIE}=;`));
    assert.match(setCookie, new RegExp(`${WORKSPACE_APP_AUTH_STATE_COOKIE}=;`));
    assert.match(setCookie, /Max-Age=0/);
    assert.equal(response.headers.get("location"), `${APP_ORIGIN}${BASE_PATH}/auth/workspace/signed-out`);
  });

  it("allows an HTTP App origin only for local development hosts", () => {
    assert.doesNotThrow(() => createSession({ appOrigin: "http://127.0.0.1:8787" }));
    assert.throws(
      () => createSession({ appOrigin: "http://onboarding.test" }),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "invalid_app_origin" && error.status === 503
    );
  });
});
