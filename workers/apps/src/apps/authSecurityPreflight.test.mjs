import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-auth-preflight-test-"));
  const outfile = join(outdir, "authSecurityPreflight.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./authSecurityPreflight.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function preflightModule() {
  modulePromise ??= loadModule();
  return modulePromise;
}

function file(path, content) {
  return { content, path };
}

describe("APPS app auth security preflight", () => {
    it("blocks header identity and fallback session secret patterns", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      loginRequired: true,
      sourceFiles: [file("src/worker.ts", `
        import { WorkspaceAuthServer } from "@frontier-workspace/auth";
        async function login(request, env) {
          const auth = new WorkspaceAuthServer({ clientId: env.APP_ID });
          const verified = await auth.exchangeLaunch({ code: new URL(request.url).searchParams.get("code") });
          const id = request.headers.get("x-workspace-user-id");
          const role = request.headers.get("x-workspace-role") || "member";
          const secret = env.APP_SESSION_SECRET || env.APPS_JWT_SECRET || "local-app-session-secret";
          return { id, role, secret, verified };
        }
      `)]
    });

    assert.equal(report.ok, false);
    assert.equal(report.status, "blocked");
    assert.deepEqual(
      new Set(report.findings.map((finding) => finding.code)),
      new Set([
        "AUTH_PLATFORM_INTEGRATION_MISSING",
        "AUTH_UNTRUSTED_IDENTITY_HEADER",
        "AUTH_SESSION_SECRET_IN_SOURCE"
      ])
    );
    assert.equal(report.findings.filter((finding) => finding.code === "AUTH_UNTRUSTED_IDENTITY_HEADER").length, 2);
  });

  it("passes Ask-style official SDK exchange and fail-closed session configuration", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      loginRequired: true,
      sourceFiles: [file("worker/src/auth.ts", `
        import { WorkspaceAuthServer } from "../../../sdk/auth/index.ts";
        export async function completeAuth(request, env) {
          const expectedState = cookieValue(request, AUTH_STATE_COOKIE);
          if (!expectedState) throw new Error("auth_state_missing");
          const auth = new WorkspaceAuthServer({ appSecret: env.WORKSPACE_AUTH_APP_SECRET, clientId: env.APP_ID });
          const login = await auth.exchangeLaunch({
            code: new URL(request.url).searchParams.get("code"),
            redirectUri: env.WORKSPACE_AUTH_CALLBACK_URL
          });
          if (!env.APP_SESSION_SECRET || env.APP_SESSION_SECRET.length < 32) throw new Error("not_configured");
          return sessionCookie(await createSessionToken(login.user, env));
        }
        export function localSession(request, env) {
          if (env.DEV_AUTH_BYPASS === "1" && isLocalHost(new URL(request.url).hostname)) return { id: "local" };
        }
      `)]
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "warning");
    assert.deepEqual(report.findings.map((finding) => finding.code), ["AUTH_LOCAL_DEV_BYPASS_PRESENT"]);
  });

  it("passes the official browser App Session helper", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      loginRequired: true,
      sourceFiles: [file("worker/src/index.ts", `
        import { WorkspaceBrowserAppSession } from "@frontier-workspace/auth";
        export async function handle(request, env) {
          const auth = new WorkspaceBrowserAppSession({
            appId: env.APP_ID,
            appOrigin: env.APP_ORIGIN,
            appSecret: env.APP_SECRET,
            appVersion: env.APP_VERSION,
            authOrigin: env.AUTH_ORIGIN,
            sessionSecret: env.SESSION_SECRET
          });
          if (new URL(request.url).pathname.endsWith("/callback")) return auth.callback(request);
          return Response.json(await auth.require(request));
        }
      `)]
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "passed");
  });

  it("passes a reachable official SDK production bundle marker", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const appSession = await readFile(new URL("../../../../sdk/auth/appSession.ts", import.meta.url), "utf8");
    const server = await readFile(new URL("../../../../sdk/auth/server.ts", import.meta.url), "utf8");
    const report = inspectAuthSecurityPreflight({
      entrypoint: "index.js",
      loginRequired: true,
      sourceFiles: [file("index.js", `
        ${appSession}
        ${server}
      `)]
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "passed");
  });

  it("does not accept a copied SDK marker without the official session boundary", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      entrypoint: "index.js",
      loginRequired: true,
      sourceFiles: [file("index.js", `
        export default { fetch() { return new Response("workspace-browser-app-session-v1"); } };
      `)]
    });

    assert.equal(report.ok, false);
    assert.deepEqual(report.findings.map((finding) => finding.code), ["AUTH_PLATFORM_INTEGRATION_MISSING"]);
  });

  it("passes IMA-style direct one-time code exchange", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      loginRequired: true,
      sourceFiles: [file("worker/src/auth.js", `
        export async function completeAuth(request, env, fetchImpl = fetch) {
          const expectedState = cookieValue(request, AUTH_STATE_COOKIE);
          if (!expectedState) throw new Error("auth_state_missing");
          const response = await fetchImpl(\`${"${env.WORKSPACE_AUTH_ORIGIN}"}/v1/app-login/exchange\`, {
            method: "POST",
            headers: { Authorization: basicAuth(env.WORKSPACE_AUTH_CLIENT_ID, env.WORKSPACE_AUTH_APP_SECRET) },
            body: JSON.stringify({
              code: new URL(request.url).searchParams.get("code"),
              clientId: env.WORKSPACE_AUTH_CLIENT_ID,
              redirectUri: env.WORKSPACE_AUTH_CALLBACK_URL
            })
          });
          if (!response.ok) throw new Error("workspace_auth_exchange_failed");
          const login = await response.json();
          if (!login.valid || login.appId !== env.WORKSPACE_AUTH_CLIENT_ID) throw new Error("invalid_login");
          return sessionCookie(await createSessionToken(login.user, env));
        }
      `)]
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "passed");
    assert.deepEqual(report.findings, []);
  });

  it("blocks a login-required pure static bundle until edge Auth enforcement exists", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      loginRequired: true,
      sourceFiles: [
        file("README.md", "Never derive identity with request.headers.get('x-workspace-role')."),
        file("index.html", "<!doctype html><main>Platform protected content</main>"),
        file("styles.css", "main { display: block; }")
      ]
    });

    assert.equal(report.ok, false);
    assert.equal(report.status, "blocked");
    assert.deepEqual(report.findings.map((finding) => finding.code), ["AUTH_STATIC_EDGE_ENFORCEMENT_UNVERIFIED"]);
  });

  it("inspects the Cloudflare Pages _worker.bundle as executable runtime code", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      loginRequired: true,
      sourceFiles: [file("_worker.bundle", `
        export default { fetch(request) {
          return Response.json({ role: request.headers.get("x-workspace-role") });
        } };
      `)]
    });

    assert.equal(report.ok, false);
    assert.equal(report.inspectedFileCount, 1);
    assert.deepEqual(
      new Set(report.findings.map((finding) => finding.code)),
      new Set(["AUTH_PLATFORM_INTEGRATION_MISSING", "AUTH_UNTRUSTED_IDENTITY_HEADER"])
    );
  });

  it("blocks aliased framework header reads and hard-coded SDK secrets", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      loginRequired: true,
      sourceFiles: [file("src/index.ts", `
        import { WorkspaceBrowserAppSession } from "@frontier-workspace/auth";
        export async function handler(request, env, c) {
          const headers = request.headers;
          const role = headers.get("x-workspace-role");
          const scopes = c.req.header("x-workspace-scopes");
          const auth = new WorkspaceBrowserAppSession({
            appId: env.APP_ID,
            appOrigin: env.APP_ORIGIN,
            appSecret: "public-client-secret-value",
            appVersion: env.APP_VERSION,
            authOrigin: env.AUTH_ORIGIN,
            sessionSecret: "public-session-secret-that-is-longer-than-32-characters"
          });
          if (new URL(request.url).pathname.endsWith("/callback")) return auth.callback(request);
          return Response.json({ role, scopes, session: await auth.read(request) });
        }
      `)]
    });

    assert.equal(report.ok, false);
    assert.equal(report.findings.filter((finding) => finding.code === "AUTH_UNTRUSTED_IDENTITY_HEADER").length, 2);
    assert.equal(report.findings.filter((finding) => finding.code === "AUTH_SESSION_SECRET_IN_SOURCE").length, 2);
  });

  it("does not accept a keyword-only direct exchange as a complete browser Auth boundary", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      loginRequired: true,
      sourceFiles: [file("worker.js", `
        export async function fetch(request, env) {
          return fetch(env.AUTH_ORIGIN + "/v1/app-login/exchange", {
            method: "POST",
            body: JSON.stringify({ code: "anything" })
          });
        }
      `)]
    });

    assert.equal(report.ok, false);
    assert.deepEqual(report.findings.map((finding) => finding.code), ["AUTH_PLATFORM_INTEGRATION_MISSING"]);
  });

  it("does not let an unused SDK file certify an anonymous deployed entrypoint", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      entrypoint: "src/index.js",
      loginRequired: true,
      sourceFiles: [
        file("src/index.js", `export default { fetch() { return new Response("public"); } };`),
        file("src/unused-auth.js", `
          import { WorkspaceBrowserAppSession } from "@frontier-workspace/auth";
          const auth = new WorkspaceBrowserAppSession({});
          export const callback = (request) => auth.callback(request);
          export const session = (request) => auth.read(request);
        `)
      ]
    });

    assert.equal(report.ok, false);
    assert.equal(report.inspectedFileCount, 1);
    assert.deepEqual(report.findings.map((finding) => finding.code), ["AUTH_PLATFORM_INTEGRATION_MISSING"]);
  });

  it("inspects a runtime dependency even when it is stored under a test-named directory", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      entrypoint: "src/index.js",
      loginRequired: true,
      sourceFiles: [
        file("src/index.js", `import { role } from "../tests/auth.js"; export default { fetch() { return Response.json({ role }); } };`),
        file("tests/auth.js", `export const role = new Headers().get("x-workspace-role");`)
      ]
    });

    assert.equal(report.ok, false);
    assert.equal(report.inspectedFileCount, 2);
    assert.deepEqual(
      new Set(report.findings.map((finding) => finding.code)),
      new Set(["AUTH_PLATFORM_INTEGRATION_MISSING", "AUTH_UNTRUSTED_IDENTITY_HEADER"])
    );
  });

  it("does not let an exposed DEV bypass satisfy production authentication", async () => {
    const { assertAuthSecurityPreflight, AuthSecurityPreflightError, inspectAuthSecurityPreflight } = await preflightModule();
    const input = {
      loginRequired: true,
      sourceFiles: [file("worker.js", `
        export function currentUser(request, env) {
          if (env.DEV_AUTH_BYPASS === "1") return { id: "developer", role: "admin" };
          return undefined;
        }
      `)]
    };
    const report = inspectAuthSecurityPreflight(input);

    assert.equal(report.ok, false);
    assert.deepEqual(
      new Set(report.findings.map((finding) => finding.code)),
      new Set(["AUTH_DEV_BYPASS_EXPOSED", "AUTH_PLATFORM_INTEGRATION_MISSING"])
    );
    assert.throws(
      () => assertAuthSecurityPreflight(input),
      (error) => error instanceof AuthSecurityPreflightError
        && error.code === "auth_security_preflight_failed"
        && error.status === 422
        && error.report.status === "blocked"
    );
  });

  it("ignores examples in comments and test files", async () => {
    const { inspectAuthSecurityPreflight } = await preflightModule();
    const report = inspectAuthSecurityPreflight({
      loginRequired: false,
      sourceFiles: [
        file("src/index.ts", "// request.headers.get('x-workspace-user-id')\nexport const page = true;"),
        file("src/index.test.ts", "request.headers.get('x-workspace-role')")
      ]
    });

    assert.equal(report.ok, true);
    assert.deepEqual(report.findings, []);
  });
});
