import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadAuthModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-auth-test-"));
  const outfile = join(outdir, "auth.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./auth.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

describe("apps worker dev auth bypass guard", () => {
  it("allows DEV_AUTH_BYPASS only for localhost worker URLs", async () => {
    const { resolvePrincipal } = await loadAuthModule();
    const principal = await resolvePrincipal(new Request("http://localhost:8791/apps", {
      headers: {
        "x-workspace-org-id": "org-1",
        "x-workspace-scopes": "apps:apps:read",
        "x-workspace-user-id": "user-1"
      }
    }), {
      DEV_AUTH_BYPASS: "1"
    });

    assert.equal(principal.sub, "user-1");
    assert.equal(principal.orgId, "org-1");
    assert.deepEqual(principal.scopes, ["apps:apps:read"]);
  });

  it("rejects DEV_AUTH_BYPASS on non-local worker URLs", async () => {
    const { resolvePrincipal } = await loadAuthModule();
    await assert.rejects(
      () => resolvePrincipal(new Request("https://apps.example.invalid/apps"), {
        DEV_AUTH_BYPASS: "1"
      }),
      (error) => error.status === 503 && error.code === "dev_auth_bypass_forbidden"
    );
  });

  it("preserves handoff token type and app binding from signed tokens", async () => {
    const { resolvePrincipal } = await loadAuthModule();
    const token = await signJwt({
      app_id: "app-1",
      department_id: "wealth-hk",
      department_path: ["wealth", "wealth/wealth-hk"],
      email: "owner@example.com",
      org_id: "org-1",
      org_slug: "Workspace Wealth",
      scopes: ["apps:apps:read"],
      sub: "user-1",
      typ: "apps_handoff"
    }, "test-secret");

    const principal = await resolvePrincipal(new Request("https://apps.example.invalid/apps/app-1/handoff.md", {
      headers: { authorization: `Bearer ${token}` }
    }), {
      APPS_JWT_SECRET: "test-secret"
    });

    assert.equal(principal.appId, "app-1");
    assert.equal(principal.departmentId, "wealth-hk");
    assert.deepEqual(principal.departmentPath, ["wealth", "wealth/wealth-hk"]);
    assert.equal(principal.email, "owner@example.com");
    assert.equal(principal.tokenType, "apps_handoff");
    assert.equal(principal.orgSlug, "workspace-wealth");
    assert.deepEqual(principal.scopes, ["apps:apps:read"]);
  });
});

async function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const data = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(signature).toString("base64url")}`;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
