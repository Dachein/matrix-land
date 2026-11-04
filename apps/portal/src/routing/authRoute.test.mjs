import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadAuthRoute() {
  return loadModule(new URL("./authRoute.ts", import.meta.url), "auth-route");
}

async function loadEmailOtpClient() {
  return loadModule(new URL("../data/emailOtpClient.ts", import.meta.url), "email-otp-client");
}

async function loadModule(entryPoint, name) {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-portal-auth-route-"));
  const outfile = join(outdir, `${name}.mjs`);
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(entryPoint)],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

describe("Portal auth route recovery", () => {
  it("rejects invalid hash redirects and falls back to Home", async () => {
    const { portalLoginUrl } = await loadAuthRoute();
    const result = new URL(portalLoginUrl("/auth/login", "#//untrusted.example", "https://ai.example.invalid"));

    assert.equal(result.searchParams.get("redirect"), "/home");
  });

  it("preserves the current hash route for the email passcode POST body", async () => {
    const { portalRedirectRoute } = await loadAuthRoute();
    assert.equal(portalRedirectRoute("#/skills-apps?view=cards"), "/skills-apps?view=cards");
    assert.equal(portalRedirectRoute("#//untrusted.example"), "/home");
  });

  it("preserves the canonical MCP Handbook path across login", async () => {
    const { portalLoginUrl, portalRedirectRoute } = await loadAuthRoute();
    const result = new URL(portalLoginUrl(
      "/auth/login",
      "/workspace-pass-mcp/handbook",
      "https://ai.example.invalid"
    ));

    assert.equal(portalRedirectRoute("/workspace-pass-mcp/handbook"), "/workspace-pass-mcp/handbook");
    assert.equal(result.searchParams.get("redirect"), "/workspace-pass-mcp/handbook");
  });

  it("accepts only same-origin Workspace authorize return targets", async () => {
    const { portalAuthReturnTo } = await loadAuthRoute();
    const origin = "https://ai.example.invalid";
    const authorize = `${origin}/auth/v1/authorize?app_id=app-1&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fworkspace%2Fcallback`;

    assert.equal(
      portalAuthReturnTo(`?return_to=${encodeURIComponent(authorize)}`, origin),
      authorize
    );
    assert.equal(
      portalAuthReturnTo(`?return_to=${encodeURIComponent("https://evil.example/steal")}`, origin),
      undefined
    );
    assert.equal(
      portalAuthReturnTo(`?return_to=${encodeURIComponent(`${origin}/not-authorize`)}`, origin),
      undefined
    );
  });

  it("passes the authorize return target into Entra login", async () => {
    const { portalLoginUrl } = await loadAuthRoute();
    const origin = "https://ai.example.invalid";
    const returnTo = `${origin}/auth/v1/authorize?app_id=app-1`;
    const result = new URL(portalLoginUrl("/auth/login", "/home", origin, returnTo));

    assert.equal(result.searchParams.get("return_to"), returnTo);
    assert.equal(result.searchParams.get("redirect"), "/home");
  });

  it("preserves the release-pinned Mate Preview query across login", async () => {
    const { portalLoginUrl, portalRedirectRoute } = await loadAuthRoute();
    const preview = "/mates/mate_123456/preview?release=release_123456&debug=1";
    const result = new URL(portalLoginUrl(
      "/auth/login",
      preview,
      "https://ai.example.invalid"
    ));

    assert.equal(portalRedirectRoute(preview), preview);
    assert.equal(result.searchParams.get("redirect"), preview);
  });
});

describe("Portal email passcode client", () => {
  it("requests a challenge with a normalized email and the current redirect", async () => {
    const { requestEmailOtp } = await loadEmailOtpClient();
    const calls = [];
    const result = await requestEmailOtp(
      "/auth/email/login",
      { email: "  User@example.invalid ", redirect: "/skills-apps" },
      async (input, init) => {
        calls.push({ input: String(input), init });
        return jsonResponse({ challengeId: "challenge-1", expiresIn: 600, retryAfter: 60 }, 202);
      }
    );

    assert.deepEqual(result, { challengeId: "challenge-1", expiresIn: 600, retryAfter: 60 });
    assert.equal(calls[0].input, "/auth/email/login");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(new Headers(calls[0].init.headers).get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      email: "user@example.invalid",
      redirect: "/skills-apps"
    });
  });

  it("passes a APPS authorize return target into the email challenge", async () => {
    const { requestEmailOtp } = await loadEmailOtpClient();
    const returnTo = "https://ai.example.invalid/auth/v1/authorize?app_id=app-1";
    let requestBody;

    await requestEmailOtp(
      "/auth/email/login",
      { email: "user@example.invalid", redirect: "/home", returnTo },
      async (_input, init) => {
        requestBody = JSON.parse(init.body);
        return jsonResponse({ challengeId: "challenge-1", expiresIn: 600, retryAfter: 60 }, 202);
      }
    );

    assert.equal(requestBody.returnTo, returnTo);
  });

  it("requires the uniform 202 challenge response contract", async () => {
    const { requestEmailOtp } = await loadEmailOtpClient();
    await assert.rejects(
      requestEmailOtp("/auth/email/login", { email: "user@example.com", redirect: "/home" }, async () => (
        jsonResponse({ challengeId: "challenge-1" }, 200)
      )),
      /email_otp_request_failed/
    );
    await assert.rejects(
      requestEmailOtp("/auth/email/login", { email: "user@example.com", redirect: "/home" }, async () => (
        jsonResponse({ expiresIn: 600, retryAfter: 60 }, 202)
      )),
      /email_otp_request_failed/
    );
  });

  it("identifies a 403 response for an email that is not registered or invited", async () => {
    const { isEmailOtpNotEligibleError, requestEmailOtp } = await loadEmailOtpClient();

    await assert.rejects(
      requestEmailOtp(
        "/auth/email/login",
        { email: "unknown@example.invalid", redirect: "/home" },
        async () => jsonResponse({ error: "email_otp_not_eligible" }, 403)
      ),
      (error) => {
        assert.equal(error.message, "email_otp_not_eligible");
        assert.equal(isEmailOtpNotEligibleError(error), true);
        return true;
      }
    );
  });

  it("verifies a six-digit code and accepts only a same-origin redirect", async () => {
    const {
      emailOtpVerifyUrl,
      isValidEmailOtpCode,
      normalizeEmailOtpCode,
      reloadAfterEmailOtpLogin,
      sameOriginEmailOtpRedirect,
      verifyEmailOtp
    } = await loadEmailOtpClient();
    let requestBody;
    const result = await verifyEmailOtp(
      emailOtpVerifyUrl("/auth/email/login/"),
      { challengeId: "challenge-1", code: "123456", redirect: "/home" },
      async (_input, init) => {
        requestBody = JSON.parse(init.body);
        return jsonResponse({ redirectUrl: "/#/home" });
      }
    );

    assert.equal(emailOtpVerifyUrl("/auth/email/login/"), "/auth/email/login/verify");
    assert.deepEqual(requestBody, { challengeId: "challenge-1", code: "123456", redirect: "/home" });
    assert.equal(result.redirectUrl, "/#/home");
    assert.equal(
      sameOriginEmailOtpRedirect(result.redirectUrl, "https://ai.example.invalid"),
      "https://ai.example.invalid/#/home"
    );
    assert.equal(normalizeEmailOtpCode("12a 34-567"), "123456");
    assert.equal(isValidEmailOtpCode("123456"), true);
    assert.equal(isValidEmailOtpCode("12345"), false);
    assert.throws(
      () => sameOriginEmailOtpRedirect("https://untrusted.example/", "https://ai.example.invalid"),
      /email_otp_request_failed/
    );

    const navigationCalls = [];
    reloadAfterEmailOtpLogin(result.redirectUrl, {
      origin: "https://ai.example.invalid",
      replaceState: (target) => navigationCalls.push(["replace", target]),
      reload: () => navigationCalls.push(["reload"])
    });
    assert.deepEqual(navigationCalls, [
      ["replace", "https://ai.example.invalid/#/home"],
      ["reload"]
    ]);
  });

  it("rejects a cross-origin post-verification target before changing browser state", async () => {
    const { reloadAfterEmailOtpLogin } = await loadEmailOtpClient();
    const navigationCalls = [];

    assert.throws(
      () => reloadAfterEmailOtpLogin("https://untrusted.example/", {
        origin: "https://ai.example.invalid",
        replaceState: (target) => navigationCalls.push(["replace", target]),
        reload: () => navigationCalls.push(["reload"])
      }),
      /email_otp_request_failed/
    );
    assert.deepEqual(navigationCalls, []);
  });
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status
  });
}
