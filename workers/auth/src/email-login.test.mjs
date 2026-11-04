import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker from "./index.ts";
import { upsertAuthUserSnapshot } from "./repository.ts";
import { verifyAuthToken } from "./token.ts";

const PORTAL_ORIGIN = "https://ai.example.invalid";
const PROXY_TOKEN = "email-otp-proxy-token-for-tests";
const OTP_SECRET = "email-otp-hmac-secret-that-is-at-least-32-bytes";

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql));
  }

  async batch(statements) {
    const results = [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class D1StatementAdapter {
  constructor(statement, params = []) {
    this.params = params;
    this.statement = statement;
  }

  bind(...params) {
    return new D1StatementAdapter(this.statement, params);
  }

  async all() {
    return { results: this.statement.all(...this.params), success: true };
  }

  async first(columnName) {
    const row = this.statement.get(...this.params) ?? null;
    return columnName && row ? row[columnName] : row;
  }

  async run() {
    const result = this.statement.run(...this.params);
    return {
      meta: {
        changes: Number(result.changes ?? 0),
        last_row_id: Number(result.lastInsertRowid ?? 0)
      },
      success: true
    };
  }
}

function createAuthDb() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/auth/db/schema.sql", "utf8"));
  database.prepare("UPDATE auth_login_email_policy SET allowed_domains_json = ? WHERE id = 1").run(JSON.stringify(["example.invalid", "partner.example.test"]));
  return new D1Adapter(database);
}

function createFixture(options = {}) {
  const messages = [];
  const env = {
    AUTH_DB: createAuthDb(),
    AUTH_EMAIL: {
      async send(message) {
        messages.push(message);
        if (options.send) {
          return options.send(message);
        }
        return {
          messageId: `message-${messages.length}`,
          status: "sent"
        };
      }
    },
    AUTH_EMAIL_OTP_SECRET: OTP_SECRET,
    AUTH_ISSUER: "https://auth.example.invalid",
    AUTH_JWT_SECRET: "email-login-jwt-test-secret",
    AUTH_PUBLIC_URL: PORTAL_ORIGIN,
    AUTH_SERVICE_TOKEN: PROXY_TOKEN,
    PLATFORM_BRAND_JSON: JSON.stringify({ name: "Example Workspace", logoText: "AI", primaryColor: "#e60012", accentColor: "#b7f43a" }),
    EMAIL_OTP_ENABLED: "1",
    MINIAPP_REVIEW_EMAIL: "ai-adoption@example.invalid",
    EMAIL_OTP_FROM: "no-reply@example.invalid",
    EMAIL_OTP_SESSION_TTL_SECONDS: "604800",
    ENTRA_CLIENT_ID: "entra-client",
    ENTRA_TENANT_ID: "entra-tenant",
    WORKSPACE_ORG_ID: "example-org",
    PORTAL_URL: PORTAL_ORIGIN,
    WECHAT_MINIAPP_APP_ID: "wx1cdd0b65cea38eed",
    WECHAT_MINIAPP_APP_SECRET: "test-miniapp-secret"
  };
  return { env, messages };
}

async function seedUser(fixture, overrides = {}) {
  const email = overrides.email ?? "ai-adoption@example.invalid";
  const id = overrides.id ?? "user-ai-adoption";
  await upsertAuthUserSnapshot(fixture.env, {
    department: "Workspace Wealth / AI Adoption",
    email,
    id,
    name: "AI Adoption Platform",
    provider: "microsoft_entra_id",
    providerSubject: `entra-${id}`,
    role: "admin",
    status: "active",
    ...overrides
  });
  return { email, id };
}

function trustedHeaders(extra = {}) {
  return new Headers({
    "content-type": "application/json",
    origin: PORTAL_ORIGIN,
    "x-workspace-auth-proxy-token": PROXY_TOKEN,
    "x-workspace-client-ip": "203.0.113.19",
    "x-workspace-public-origin": PORTAL_ORIGIN,
    ...extra
  });
}

function miniappTrustedHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    origin: "",
    "x-workspace-auth-channel": "miniapp",
    "x-workspace-auth-proxy-token": PROXY_TOKEN,
    "x-workspace-client-ip": "203.0.113.27",
    "x-workspace-public-origin": PORTAL_ORIGIN,
    ...extra
  };
}

async function requestOtp(fixture, email, options = {}) {
  const response = await worker.fetch(new Request("https://auth.test/auth/email/login", {
    method: "POST",
    headers: trustedHeaders(options.headers),
    body: JSON.stringify({
      email,
      redirect: options.redirect ?? "/catalog",
      ...(options.returnTo ? { returnTo: options.returnTo } : {})
    })
  }), fixture.env, options.executionContext);
  const payload = await response.clone().json();
  return {
    challengeId: payload.challengeId,
    payload,
    response,
    stateCookie: response.status === 202 ? emailOtpStateCookie(response) : undefined
  };
}

async function verifyOtp(fixture, input) {
  const headers = trustedHeaders(input.headers);
  if (input.stateCookie) {
    headers.set("cookie", input.stateCookie);
  }
  return worker.fetch(new Request("https://auth.test/auth/email/login/verify", {
    method: "POST",
    headers,
    body: JSON.stringify({
      challengeId: input.challengeId,
      code: input.code
    })
  }), fixture.env);
}

function extractCode(message) {
  const match = String(message?.text ?? "").match(/\b(\d{6})\b/);
  assert.ok(match?.[1], "expected a six-digit code in the email text");
  return match[1];
}

function emailOtpStateCookie(response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|,\s*)workspace_email_otp_state=([^;,]+)/);
  assert.ok(match?.[1], "expected email OTP state cookie");
  return `workspace_email_otp_state=${match[1]}`;
}

function rawEmailOtpState(stateCookie) {
  return decodeURIComponent(stateCookie.slice(stateCookie.indexOf("=") + 1));
}

function sessionCookie(response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|,\s*)workspace_session=([^;,]+)/);
  assert.ok(match?.[1], "expected workspace_session cookie");
  return decodeURIComponent(match[1]);
}

async function challengeRow(fixture, challengeId) {
  return fixture.env.AUTH_DB
    .prepare("SELECT * FROM auth_email_otp_challenges WHERE id = ?")
    .bind(challengeId)
    .first();
}

describe("custom email OTP login", () => {
  it("accepts origin-less miniapp email OTP through the trusted gateway channel", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);

    const miniappHeaders = () => new Headers({
      "content-type": "application/json",
      "x-workspace-auth-channel": "miniapp",
      "x-workspace-auth-proxy-token": PROXY_TOKEN,
      "x-workspace-client-ip": "203.0.113.27",
      "x-workspace-public-origin": PORTAL_ORIGIN
    });

    const requestedResponse = await worker.fetch(new Request("https://auth.test/auth/email/login", {
      method: "POST",
      headers: miniappHeaders(),
      body: JSON.stringify({ email: user.email, redirect: "/home" })
    }), fixture.env);
    assert.equal(requestedResponse.status, 202);
    const requested = await requestedResponse.clone().json();
    const stateCookie = emailOtpStateCookie(requestedResponse);
    const code = extractCode(fixture.messages[0]);

    const verifyHeaders = miniappHeaders();
    verifyHeaders.set("cookie", stateCookie);
    const verified = await worker.fetch(new Request("https://auth.test/auth/email/login/verify", {
      method: "POST",
      headers: verifyHeaders,
      body: JSON.stringify({ challengeId: requested.challengeId, code })
    }), fixture.env);

    assert.equal(verified.status, 200);
    assert.match(verified.headers.get("set-cookie") ?? "", /workspace_session=/);
  });

  it("accepts configured review codes only for the exact miniapp review account", async () => {
    const fixture = createFixture();
    fixture.env.MINIAPP_REVIEW_OTP_CODE = "555018";
    fixture.env.MOKA_DIRECTORY_ENABLED = "1";
    fixture.env.MOKA_CONNECTOR_SERVICE_TOKEN = "moka-test-service-token";
    let mokaLookupCount = 0;
    fixture.env.MOKA_CONNECTOR = {
      async fetch() {
        mokaLookupCount += 1;
        return new Response(JSON.stringify({ error: "moka_employee_not_found" }), { status: 404 });
      }
    };
    const user = await seedUser(fixture);
    const requested = await requestOtp(fixture, user.email, { headers: miniappTrustedHeaders() });
    assert.equal(requested.response.status, 202);
    assert.equal(fixture.messages.length, 0, "review login does not depend on reading the mailbox");

    const removedCode = await verifyOtp(fixture, { ...requested, code: "888888", headers: miniappTrustedHeaders() });
    assert.equal(removedCode.status, 400, "the removed review code is rejected");
    const verified = await verifyOtp(fixture, { ...requested, code: "555018", headers: miniappTrustedHeaders() });
    assert.equal(verified.status, 200);
    assert.equal(mokaLookupCount, 0, "the configured review code bypasses Moka membership for its review account");
    const replayed = await verifyOtp(fixture, { ...requested, code: "555018", headers: miniappTrustedHeaders() });
    assert.equal(replayed.status, 400, "a review code remains single-use");
  });

  it("does not treat the test fixture review code as a production default", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const requested = await requestOtp(fixture, user.email, { headers: miniappTrustedHeaders() });

    assert.equal(requested.response.status, 202);
    assert.equal(fixture.messages.length, 1, "without the review secret, a normal email code is sent");
    const hardCodedReviewCode = await verifyOtp(fixture, {
      ...requested,
      code: "555018",
      headers: miniappTrustedHeaders()
    });
    assert.equal(hardCodedReviewCode.status, 400);

    const emailedCode = await verifyOtp(fixture, {
      ...requested,
      code: extractCode(fixture.messages[0]),
      headers: miniappTrustedHeaders()
    });
    assert.equal(emailedCode.status, 200);
  });

  it("does not allow review codes through the Portal channel or for another mailbox", async () => {
    const fixture = createFixture();
    fixture.env.MINIAPP_REVIEW_OTP_CODE = "555018";
    const reviewUser = await seedUser(fixture);
    const portalChallenge = await requestOtp(fixture, reviewUser.email);
    assert.equal(fixture.messages.length, 1, "Portal keeps the normal emailed OTP flow");
    const portalReviewAttempt = await verifyOtp(fixture, {
      ...portalChallenge,
      code: "555018"
    });
    assert.equal(portalReviewAttempt.status, 400);
    const portalEmailCode = await verifyOtp(fixture, {
      ...portalChallenge,
      code: extractCode(fixture.messages[0])
    });
    assert.equal(portalEmailCode.status, 200);

    const otherUser = await seedUser(fixture, { email: "review-other@example.invalid", id: "review-other" });
    const otherChallenge = await requestOtp(fixture, otherUser.email, { headers: miniappTrustedHeaders() });
    assert.equal(fixture.messages.length, 2, "other miniapp accounts still receive normal emailed OTPs");
    const otherReviewAttempt = await verifyOtp(fixture, {
      ...otherChallenge,
      code: "555018",
      headers: miniappTrustedHeaders()
    });
    assert.equal(otherReviewAttempt.status, 400);
    const otherEmailCode = await verifyOtp(fixture, {
      ...otherChallenge,
      code: extractCode(fixture.messages[1]),
      headers: miniappTrustedHeaders()
    });
    assert.equal(otherEmailCode.status, 200);
  });

  it("rejects origin-less OTP requests that lack the trusted miniapp channel", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const response = await worker.fetch(new Request("https://auth.test/auth/email/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workspace-auth-proxy-token": PROXY_TOKEN,
        "x-workspace-client-ip": "203.0.113.28",
        "x-workspace-public-origin": PORTAL_ORIGIN
      },
      body: JSON.stringify({ email: user.email })
    }), fixture.env);

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "email_otp_origin_invalid");
    assert.equal(fixture.messages.length, 0);
  });

  it("sends a service-authenticated Portal notification email", async () => {
    const fixture = createFixture();
    const response = await worker.fetch(new Request("https://auth.test/v1/notifications/email", {
      body: JSON.stringify({
        from: "no-reply@example.invalid",
        html: "<p>You received a contribution.</p>",
        subject: "[Frontier Workspace] 你获得了社区贡献",
        text: "You received a contribution.",
        to: "Ada@example.test"
      }),
      headers: {
        authorization: `Bearer ${PROXY_TOKEN}`,
        "content-type": "application/json"
      },
      method: "POST"
    }), fixture.env);

    assert.equal(response.status, 202);
    assert.deepEqual(fixture.messages[0], {
      from: "no-reply@example.invalid",
      html: "<p>You received a contribution.</p>",
      subject: "[Frontier Workspace] 你获得了社区贡献",
      text: "You received a contribution.",
      to: "ada@example.test"
    });
  });

  it("accepts the APPS credential for notification delivery without granting generic service access", async () => {
    const fixture = createFixture();
    fixture.env.APPS_AUTH_SERVICE_TOKEN = "apps-email-test-token";
    const headers = { authorization: "Bearer apps-email-test-token", "content-type": "application/json" };
    const response = await worker.fetch(new Request("https://auth.test/v1/notifications/email", {
      method: "POST", headers,
      body: JSON.stringify({ subject: "App created", text: "Office allowlist application", to: "ada@example.test", cc: ["AI-Adoption@example.invalid", "ai-adoption@example.invalid"] })
    }), fixture.env);
    assert.equal(response.status, 202);
    assert.equal(fixture.messages.length, 1);
    assert.deepEqual(fixture.messages[0].cc, ["ai-adoption@example.invalid"]);
    const session = await worker.fetch(new Request("https://auth.test/v1/session", { headers }), fixture.env);
    assert.equal(session.status, 401);
  });

  it("rejects invalid notification CC addresses before delivery", async () => {
    for (const cc of ["ai-adoption@example.invalid", ["invalid address"], Array(21).fill("copy@example.test")]) {
      const fixture = createFixture();
      const response = await worker.fetch(new Request("https://auth.test/v1/notifications/email", {
        method: "POST",
        headers: { authorization: `Bearer ${PROXY_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ subject: "App created", text: "Office allowlist application", to: "ada@example.test", cc })
      }), fixture.env);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "invalid_notification_email_cc");
      assert.equal(fixture.messages.length, 0);
    }
  });

  it("rejects an unknown credential for notification delivery", async () => {
    const fixture = createFixture();
    fixture.env.APPS_AUTH_SERVICE_TOKEN = "apps-email-test-token";
    const response = await worker.fetch(new Request("https://auth.test/v1/notifications/email", {
      method: "POST",
      headers: { authorization: "Bearer unknown-token", "content-type": "application/json" },
      body: JSON.stringify({ subject: "App created", text: "Office allowlist application", to: "ada@example.test" })
    }), fixture.env);
    assert.equal(response.status, 401);
    assert.equal(fixture.messages.length, 0);
  });

  it("rejects a Portal notification email from an unapproved sender", async () => {
    const fixture = createFixture();
    const response = await worker.fetch(new Request("https://auth.test/v1/notifications/email", {
      body: JSON.stringify({
        from: "attacker@example.test",
        text: "spoofed",
        subject: "Spoofed",
        to: "ada@example.test"
      }),
      headers: {
        authorization: `Bearer ${PROXY_TOKEN}`,
        "content-type": "application/json"
      },
      method: "POST"
    }), fixture.env);

    assert.equal(response.status, 403);
    assert.equal(fixture.messages.length, 0);
  });

  it("requires an exact active or invited user record in addition to an allowed domain", async () => {
    const eligibleFixture = createFixture();
    await seedUser(eligibleFixture);
    const eligible = await requestOtp(eligibleFixture, "ai-adoption@example.invalid");

    const unknownFixture = createFixture();
    const unknown = await requestOtp(unknownFixture, "unknown.person@example.invalid");

    const unsupportedDomainFixture = createFixture();
    const unsupportedDomain = await requestOtp(unsupportedDomainFixture, "outsider@other.example.test");

    assert.equal(eligible.response.status, 202);
    assert.equal(unknown.response.status, 403);
    assert.equal(unsupportedDomain.response.status, 403);
    assert.equal(unknown.payload.error, "email_otp_not_eligible");
    assert.equal(unsupportedDomain.payload.error, "email_otp_not_eligible");
    assert.equal(unknown.response.headers.get("set-cookie"), null);
    assert.equal(unsupportedDomain.response.headers.get("set-cookie"), null);
    assert.equal(eligible.response.headers.get("cache-control"), "no-store");
    assert.equal(unknown.response.headers.get("cache-control"), "no-store");
    assert.match(eligible.response.headers.get("set-cookie"), /HttpOnly/i);
    assert.match(eligible.response.headers.get("set-cookie"), /Secure/i);
    assert.match(eligible.response.headers.get("set-cookie"), /SameSite=Strict/i);
    assert.match(eligible.response.headers.get("set-cookie"), /Path=\/auth\/email/i);
    assert.equal(eligibleFixture.messages.length, 1);
    assert.equal(eligibleFixture.messages[0].to, "ai-adoption@example.invalid");
    assert.equal(unknownFixture.messages.length, 0);
    assert.equal(unsupportedDomainFixture.messages.length, 0);

    const eligibleRow = await challengeRow(eligibleFixture, eligible.challengeId);
    assert.equal(eligibleRow.status, "pending");
    assert.equal(await unknownFixture.env.AUTH_DB.prepare(
      "SELECT COUNT(*) AS count FROM auth_email_otp_challenges"
    ).first("count"), 0);
    assert.equal(await unsupportedDomainFixture.env.AUTH_DB.prepare(
      "SELECT COUNT(*) AS count FROM auth_email_otp_challenges"
    ).first("count"), 0);
  });

  it("rejects inactive and suspended registered users before creating a challenge", async () => {
    for (const status of ["inactive", "suspended"]) {
      const fixture = createFixture();
      const user = await seedUser(fixture, { id: `${status}-user`, status });
      const requested = await requestOtp(fixture, user.email);

      assert.equal(requested.response.status, 403);
      assert.equal(requested.payload.error, "email_otp_not_eligible");
      assert.equal(requested.response.headers.get("set-cookie"), null);
      assert.equal(fixture.messages.length, 0);
      assert.equal(await fixture.env.AUTH_DB.prepare(
        "SELECT COUNT(*) AS count FROM auth_email_otp_challenges"
      ).first("count"), 0);
    }
  });

  it("returns an explicit rate-limit error instead of a challenge that was never stored", async () => {
    const fixture = createFixture();
    fixture.env.EMAIL_OTP_EMAIL_HOURLY_LIMIT = "2";
    const user = await seedUser(fixture);

    const first = await requestOtp(fixture, user.email);
    const cooldown = await requestOtp(fixture, user.email);
    assert.equal(first.response.status, 202);
    assert.equal(cooldown.response.status, 429);
    assert.equal(cooldown.payload.error, "email_otp_rate_limited");
    assert.equal(cooldown.challengeId, undefined);
    assert.equal(fixture.messages.length, 1);
    assert.equal(await fixture.env.AUTH_DB.prepare(
      "SELECT COUNT(*) AS count FROM auth_email_otp_challenges"
    ).first("count"), 1);

    const outsideCooldown = Math.floor(Date.now() / 1000) - 61;
    await fixture.env.AUTH_DB
      .prepare("UPDATE auth_email_otp_challenges SET created_at = ?")
      .bind(outsideCooldown)
      .run();
    const second = await requestOtp(fixture, user.email);
    assert.equal(second.response.status, 202);
    assert.equal(fixture.messages.length, 2);

    await fixture.env.AUTH_DB
      .prepare("UPDATE auth_email_otp_challenges SET created_at = ?")
      .bind(outsideCooldown)
      .run();
    const hourlyLimited = await requestOtp(fixture, user.email);
    assert.equal(hourlyLimited.response.status, 429);
    assert.equal(hourlyLimited.payload.error, "email_otp_rate_limited");
    assert.equal(hourlyLimited.challengeId, undefined);
    assert.equal(fixture.messages.length, 2);
    assert.equal(await fixture.env.AUTH_DB.prepare(
      "SELECT COUNT(*) AS count FROM auth_email_otp_challenges"
    ).first("count"), 2);
  });

  it("enforces the hourly IP limit across different eligible addresses", async () => {
    const fixture = createFixture();
    fixture.env.EMAIL_OTP_IP_HOURLY_LIMIT = "1";
    const firstUser = await seedUser(fixture);
    const secondUser = await seedUser(fixture, {
      email: "second.user@partner.example.test",
      id: "second-user"
    });

    const first = await requestOtp(fixture, firstUser.email);
    const second = await requestOtp(fixture, secondUser.email);
    assert.equal(first.response.status, 202);
    assert.equal(second.response.status, 429);
    assert.equal(second.payload.error, "email_otp_rate_limited");
    assert.equal(second.challengeId, undefined);
    assert.equal(fixture.messages.length, 1);
    assert.equal(await fixture.env.AUTH_DB.prepare(
      "SELECT COUNT(*) AS count FROM auth_email_otp_challenges"
    ).first("count"), 1);
  });

  it("does not activate an invited user until successful verification", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture, {
      id: "invited-user",
      role: "admin",
      status: "invited"
    });
    const requested = await requestOtp(fixture, user.email);

    const before = await fixture.env.AUTH_DB
      .prepare("SELECT status FROM auth_users WHERE id = ?")
      .bind(user.id)
      .first();
    assert.equal(before.status, "invited");

    const response = await verifyOtp(fixture, {
      challengeId: requested.challengeId,
      code: extractCode(fixture.messages[0]),
      stateCookie: requested.stateCookie
    });
    assert.equal(response.status, 200);

    const after = await fixture.env.AUTH_DB
      .prepare("SELECT role, status FROM auth_users WHERE id = ?")
      .bind(user.id)
      .first();
    assert.equal(after.status, "active");
    assert.equal(after.role, "admin", "OTP login must not rewrite the canonical DB role");
  });

  it("stores only HMAC values and preserves the canonical role in the email OTP session", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture, { role: "admin" });
    const requested = await requestOtp(fixture, user.email, {
      redirect: "/catalog"
    });
    const message = fixture.messages[0];
    const code = extractCode(message);
    const state = rawEmailOtpState(requested.stateCookie);
    const row = await challengeRow(fixture, requested.challengeId);

    assert.equal(message.from, "no-reply@example.invalid");
    assert.equal(message.to, user.email);
    assert.doesNotMatch(message.subject, new RegExp(code));
    assert.match(message.text, new RegExp(code));
    assert.match(message.html, new RegExp(code));
    assert.match(message.html, /#b7f43a/);
    assert.match(message.html, /bgcolor="#e60012"/);
    assert.match(message.html, />AI<\/td>/);
    assert.doesNotMatch(message.html, /#ff5a1f/);
    assert.match(message.html, /border-top:3px solid #e60012/);
    assert.doesNotMatch(message.html, /#9f1239/);
    assert.match(row.code_hash, /^[A-Za-z0-9_-]{43}$/);
    assert.match(row.state_hash, /^[A-Za-z0-9_-]{43}$/);
    assert.match(row.email_hash, /^[A-Za-z0-9_-]{43}$/);
    assert.match(row.ip_hash, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(row.code_hash, code);
    assert.notEqual(row.state_hash, state);
    assert.notEqual(row.email_hash, user.email);
    assert.doesNotMatch(JSON.stringify(row), new RegExp(user.email.replaceAll(".", "\\."), "i"));

    const response = await verifyOtp(fixture, {
      challengeId: requested.challengeId,
      code,
      stateCookie: requested.stateCookie
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.clone().json();
    assert.equal(payload.authenticated, true);
    assert.equal(new URL(payload.redirectUrl).pathname, "/catalog");

    const session = await verifyAuthToken(fixture.env, sessionCookie(response));
    const remainingTtl = Number(session.exp) - Math.floor(Date.now() / 1000);
    assert.equal(session.sub, user.id);
    assert.equal(session.email, user.email);
    assert.equal(session.authenticationMethod, "email_otp");
    assert.deepEqual(session.amr, ["email_otp"]);
    assert.match(String(session.authenticationSubject), /^email-otp:/);
    assert.equal(session.role, "admin");
    assert.ok(remainingTtl > 604790 && remainingTtl <= 604800);
    assert.match(response.headers.get("set-cookie"), /workspace_email_otp_state=;[^,]*Max-Age=0/i);

    const canonicalUser = await fixture.env.AUTH_DB
      .prepare("SELECT role FROM auth_users WHERE id = ?")
      .bind(user.id)
      .first();
    assert.equal(canonicalUser.role, "admin");
    const consumed = await challengeRow(fixture, requested.challengeId);
    assert.equal(consumed.status, "consumed");
    assert.ok(consumed.consumed_at);
  });

  it("resumes a same-origin APPS authorize request after email OTP login", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const registered = await worker.fetch(new Request("https://auth.test/v1/admin/apps", {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROXY_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        accessMode: "public",
        appSecret: "email-otp-app-secret-at-least-32-characters",
        callbackUrls: ["https://ops.example.com/auth/workspace/callback"],
        id: "app-ops",
        launchUrl: "https://ops.example.com",
        name: "Ops App",
        sdkStatus: "connected",
        status: "listed"
      })
    }), fixture.env);
    assert.equal(registered.status, 201);
    const returnTo = `${PORTAL_ORIGIN}/auth/v1/authorize?app_id=app-ops`
      + "&redirect_uri=https%3A%2F%2Fops.example.com%2Fauth%2Fworkspace%2Fcallback";
    const requested = await requestOtp(fixture, user.email, { returnTo });
    const stored = await challengeRow(fixture, requested.challengeId);

    assert.equal(stored.return_to, returnTo);

    const response = await verifyOtp(fixture, {
      challengeId: requested.challengeId,
      code: extractCode(fixture.messages[0]),
      stateCookie: requested.stateCookie
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).redirectUrl, returnTo);

    const authorizeResponse = await worker.fetch(new Request(returnTo, {
      headers: { cookie: `workspace_session=${encodeURIComponent(sessionCookie(response))}` }
    }), fixture.env);
    assert.equal(authorizeResponse.status, 302);
    const callback = new URL(authorizeResponse.headers.get("location"));
    assert.equal(callback.origin, "https://ops.example.com");
    assert.equal(callback.pathname, "/auth/workspace/callback");
    assert.ok(callback.searchParams.get("code"));
  });

  it("drops an untrusted email OTP return target", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const requested = await requestOtp(fixture, user.email, {
      returnTo: "https://evil.example/steal-session"
    });
    const stored = await challengeRow(fixture, requested.challengeId);

    assert.equal(stored.return_to, null);

    const response = await verifyOtp(fixture, {
      challengeId: requested.challengeId,
      code: extractCode(fixture.messages[0]),
      stateCookie: requested.stateCookie
    });
    assert.equal(new URL((await response.json()).redirectUrl).pathname, "/catalog");
  });

  it("locks a challenge after five wrong attempts and rejects the correct code afterward", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const requested = await requestOtp(fixture, user.email);
    const correctCode = extractCode(fixture.messages[0]);
    const wrongCode = correctCode === "000000" ? "000001" : "000000";

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await verifyOtp(fixture, {
        challengeId: requested.challengeId,
        code: wrongCode,
        stateCookie: requested.stateCookie
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, "email_otp_invalid_or_expired");
      assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /workspace_session=/);
    }

    const locked = await challengeRow(fixture, requested.challengeId);
    assert.equal(locked.attempt_count, 5);
    assert.equal(locked.status, "locked");

    const correctAfterLock = await verifyOtp(fixture, {
      challengeId: requested.challengeId,
      code: correctCode,
      stateCookie: requested.stateCookie
    });
    assert.equal(correctAfterLock.status, 400);
    assert.doesNotMatch(correctAfterLock.headers.get("set-cookie") ?? "", /workspace_session=/);
  });

  it("rejects expired challenges", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const requested = await requestOtp(fixture, user.email);
    const code = extractCode(fixture.messages[0]);
    await fixture.env.AUTH_DB
      .prepare("UPDATE auth_email_otp_challenges SET expires_at = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000) - 1, requested.challengeId)
      .run();

    const response = await verifyOtp(fixture, {
      challengeId: requested.challengeId,
      code,
      stateCookie: requested.stateCookie
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "email_otp_invalid_or_expired");
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /workspace_session=/);
  });

  it("rejects a replay after a successful one-time consumption", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const requested = await requestOtp(fixture, user.email);
    const input = {
      challengeId: requested.challengeId,
      code: extractCode(fixture.messages[0]),
      stateCookie: requested.stateCookie
    };

    const first = await verifyOtp(fixture, input);
    assert.equal(first.status, 200);
    const replay = await verifyOtp(fixture, input);
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, "email_otp_invalid_or_expired");
    assert.doesNotMatch(replay.headers.get("set-cookie") ?? "", /workspace_session=/);

    const audits = await fixture.env.AUTH_DB
      .prepare("SELECT COUNT(*) AS total FROM auth_audit_events WHERE action = 'portal_user_logged_in'")
      .first();
    assert.equal(audits.total, 1);
  });

  it("atomically allows only one of two concurrent correct verifications", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const requested = await requestOtp(fixture, user.email);
    const input = {
      challengeId: requested.challengeId,
      code: extractCode(fixture.messages[0]),
      stateCookie: requested.stateCookie
    };

    const responses = await Promise.all([
      verifyOtp(fixture, input),
      verifyOtp(fixture, input)
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
    const audits = await fixture.env.AUTH_DB
      .prepare("SELECT COUNT(*) AS total FROM auth_audit_events WHERE action = 'portal_user_logged_in'")
      .first();
    assert.equal(audits.total, 1);
  });

  it("rejects verification without the browser-bound state cookie", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const requested = await requestOtp(fixture, user.email);

    const response = await verifyOtp(fixture, {
      challengeId: requested.challengeId,
      code: extractCode(fixture.messages[0])
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "email_otp_invalid_or_expired");
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /workspace_session=/);
  });

  it("returns a delivery error and invalidates the challenge when email delivery fails", async () => {
    const fixture = createFixture({
      async send() {
        throw new Error("simulated_email_provider_failure");
      }
    });
    const user = await seedUser(fixture);
    const requested = await requestOtp(fixture, user.email);

    assert.equal(requested.response.status, 503);
    assert.equal(requested.payload.error, "email_otp_delivery_failed");
    assert.equal(requested.challengeId, undefined);
    assert.equal(fixture.messages.length, 1);
    const failed = await fixture.env.AUTH_DB.prepare(
      "SELECT * FROM auth_email_otp_challenges WHERE status = 'delivery_failed'"
    ).first();
    assert.equal(failed.status, "delivery_failed");

    const response = await verifyOtp(fixture, {
      challengeId: requested.challengeId,
      code: extractCode(fixture.messages[0]),
      stateCookie: requested.stateCookie
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /workspace_session=/);
  });

  it("advertises and accepts email OTP only when every required setting is present", async () => {
    const fixture = createFixture();
    const ready = await worker.fetch(new Request("https://auth.test/auth/session"), fixture.env);
    assert.equal((await ready.json()).emailLoginConfigured, true);

    for (const key of ["AUTH_EMAIL", "AUTH_EMAIL_OTP_SECRET", "AUTH_SERVICE_TOKEN"]) {
      const incompleteEnv = { ...fixture.env };
      delete incompleteEnv[key];
      const incomplete = await worker.fetch(new Request("https://auth.test/auth/session"), incompleteEnv);
      assert.equal((await incomplete.json()).emailLoginConfigured, false, `expected ${key} to be required`);
    }

    const disabledEnv = { ...fixture.env, EMAIL_OTP_ENABLED: "0" };
    const disabledSession = await worker.fetch(new Request("https://auth.test/auth/session"), disabledEnv);
    assert.equal((await disabledSession.json()).emailLoginConfigured, false);
    const disabledRequest = await worker.fetch(new Request("https://auth.test/auth/email/login", {
      method: "POST",
      headers: trustedHeaders(),
      body: JSON.stringify({ email: "ai-adoption@example.invalid" })
    }), disabledEnv);
    assert.equal(disabledRequest.status, 503);
    assert.equal((await disabledRequest.json()).error, "email_otp_disabled");

    const incompleteEnv = { ...fixture.env };
    delete incompleteEnv.AUTH_EMAIL_OTP_SECRET;
    const incompleteRequest = await worker.fetch(new Request("https://auth.test/auth/email/login", {
      method: "POST",
      headers: trustedHeaders(),
      body: JSON.stringify({ email: "ai-adoption@example.invalid" })
    }), incompleteEnv);
    assert.equal(incompleteRequest.status, 503);
    assert.equal((await incompleteRequest.json()).error, "email_otp_not_configured");
  });

  it("uses the persisted shared email policy for OTP login and exposes it only to trusted admins", async () => {
    const fixture = createFixture();
    const personalUser = await seedUser(fixture, { email: "person@gmail.com", id: "personal-user" });
    const restrictedRequest = await requestOtp(fixture, personalUser.email);
    assert.equal(restrictedRequest.response.status, 403);

    const adminRead = await worker.fetch(new Request("https://auth.test/v1/admin/login-email-policy", {
      headers: { Authorization: `Bearer ${PROXY_TOKEN}` }
    }), fixture.env);
    assert.equal(adminRead.status, 200);
    assert.equal((await adminRead.json()).policy.mode, "company_email_only");

    const update = await worker.fetch(new Request("https://auth.test/v1/admin/login-email-policy", {
      method: "POST",
      headers: { Authorization: `Bearer ${PROXY_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "open", allowedDomains: ["example.invalid"], updatedByUserId: "admin-1" })
    }), fixture.env);
    assert.equal(update.status, 200);
    assert.equal((await update.json()).policy.mode, "open");

    const openRequest = await requestOtp(fixture, personalUser.email);
    assert.equal(openRequest.response.status, 202);
  });

  it("accepts the secondary service token during proxy token rotation", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const rotatingEnv = {
      ...fixture.env,
      AUTH_SERVICE_TOKEN_SECONDARY: PROXY_TOKEN
    };
    delete rotatingEnv.AUTH_SERVICE_TOKEN;

    const session = await worker.fetch(new Request("https://auth.test/auth/session"), rotatingEnv);
    assert.equal((await session.json()).emailLoginConfigured, true);

    const response = await worker.fetch(new Request("https://auth.test/auth/email/login", {
      method: "POST",
      headers: trustedHeaders(),
      body: JSON.stringify({
        email: user.email,
        redirect: "/home"
      })
    }), rotatingEnv);
    assert.equal(response.status, 202);
  });

  it("accepts the dedicated Portal service token without a generic service token", async () => {
    const fixture = createFixture();
    const user = await seedUser(fixture);
    const portalEnv = {
      ...fixture.env,
      PORTAL_AUTH_SERVICE_TOKEN: PROXY_TOKEN
    };
    delete portalEnv.AUTH_SERVICE_TOKEN;

    const session = await worker.fetch(new Request("https://auth.test/auth/session"), portalEnv);
    assert.equal((await session.json()).emailLoginConfigured, true);

    const response = await worker.fetch(new Request("https://auth.test/auth/email/login", {
      method: "POST",
      headers: trustedHeaders(),
      body: JSON.stringify({
        email: user.email,
        redirect: "/home"
      })
    }), portalEnv);
    assert.equal(response.status, 202);
  });
});


describe("OTP enrollment for fresh installations", () => {
  function enrollmentFixture() {
    const fixture = createFixture();
    fixture.env.EMAIL_OTP_ALLOW_SIGNUP = "1";
    delete fixture.env.ENTRA_CLIENT_ID;
    delete fixture.env.ENTRA_TENANT_ID;
    return fixture;
  }
  const countUsers = async fixture => (await fixture.env.AUTH_DB.prepare("SELECT count(*) AS count FROM auth_users").first()).count;
  it("restricts signup to the exact installation mailbox even when its domain policy is open", async () => {
    const fixture = enrollmentFixture();
    fixture.env.AUTH_LOGIN_ALLOWED_EMAILS_JSON = JSON.stringify(["owner@example.invalid"]);
    await fixture.env.AUTH_DB.prepare("UPDATE auth_login_email_policy SET mode = 'open'").run();
    assert.equal((await requestOtp(fixture, "other@example.invalid")).response.status, 403);
    assert.equal(fixture.messages.length, 0);
    const request = await requestOtp(fixture, "OWNER@example.invalid");
    assert.equal(request.response.status, 202);
    const response = await verifyOtp(fixture, { ...request, code: extractCode(fixture.messages[0]) });
    assert.equal(response.status, 200);
    assert.equal((await verifyAuthToken(fixture.env, sessionCookie(response))).email, "owner@example.invalid");
    assert.equal(await countUsers(fixture), 1);
  });
  it("rechecks a changed exact mailbox restriction before enrolling or signing in", async () => {
    for (const existing of [false, true]) {
      const fixture = enrollmentFixture();
      fixture.env.AUTH_LOGIN_ALLOWED_EMAILS_JSON = JSON.stringify(["owner@example.invalid"]);
      if (existing) await seedUser(fixture, { email: "owner@example.invalid", role: "member" });
      const request = await requestOtp(fixture, "owner@example.invalid");
      assert.equal(request.response.status, 202);
      fixture.env.AUTH_LOGIN_ALLOWED_EMAILS_JSON = JSON.stringify(["other@example.invalid"]);
      const response = await verifyOtp(fixture, { ...request, code: extractCode(fixture.messages[0]) });
      assert.equal(response.status, 403);
      assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /workspace_session=/);
      assert.equal(await countUsers(fixture), existing ? 1 : 0);
    }
  });
  it("rejects malformed or empty installation lists before sending a login code", async () => {
    for (const configured of ["", "[]", "{}", "not-json", '["owner@example.invalid",123]']) {
      const fixture = enrollmentFixture();
      fixture.env.AUTH_LOGIN_ALLOWED_EMAILS_JSON = configured;
      assert.equal((await requestOtp(fixture, "owner@example.invalid")).response.status, 403);
      assert.equal(fixture.messages.length, 0);
    }
  });
  it("enables email-only authentication and creates no account until a code is verified", async () => {
    const fixture = enrollmentFixture();
    const before = await worker.fetch(new Request("https://auth.test/auth/session"), fixture.env);
    const session = await before.json();
    assert.equal(session.configured, true);
    assert.equal(session.entraLoginConfigured, false);
    assert.equal(session.emailLoginConfigured, true);
    const request = await requestOtp(fixture, "new@example.invalid");
    assert.equal(request.response.status, 202);
    assert.equal(await countUsers(fixture), 0);
    const row = await challengeRow(fixture, request.challengeId);
    assert.equal(row.user_id, null);
    assert.ok(row.recipient_ciphertext);
    assert.equal(JSON.stringify(row).includes("new@example.invalid"), false);
    const response = await verifyOtp(fixture, { ...request, code: extractCode(fixture.messages[0]) });
    assert.equal(response.status, 200);
    const token = await verifyAuthToken(fixture.env, sessionCookie(response));
    assert.equal(token.role, "member");
    assert.equal(token.email, "new@example.invalid");
    assert.deepEqual(token.department_path, []);
    assert.equal(await countUsers(fixture), 1);
    assert.equal((await verifyOtp(fixture, { ...request, code: extractCode(fixture.messages[0]) })).status, 400);
    assert.equal(await countUsers(fixture), 1);
  });
  it("rejects revoked domains, disabled enrollment and tampered recipient records", async () => {
    for (const change of ["policy", "disabled", "tampered"]) {
      const fixture = enrollmentFixture();
      const request = await requestOtp(fixture, "new@example.invalid");
      if (change === "policy") await fixture.env.AUTH_DB.prepare("UPDATE auth_login_email_policy SET allowed_domains_json = '[]'").run();
      if (change === "disabled") fixture.env.EMAIL_OTP_ALLOW_SIGNUP = "0";
      if (change === "tampered") await fixture.env.AUTH_DB.prepare("UPDATE auth_email_otp_challenges SET recipient_ciphertext = 'invalid'").run();
      const response = await verifyOtp(fixture, { ...request, code: extractCode(fixture.messages[0]) });
      assert.ok(response.status >= 400 && response.status < 500, `${change}: ${response.status}`);
      assert.equal(await countUsers(fixture), 0);
      assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /workspace_session=/);
    }
  });
  it("never reactivates an account disabled after the challenge was sent", async () => {
    const fixture = enrollmentFixture();
    const request = await requestOtp(fixture, "new@example.invalid");
    await seedUser(fixture, { email: "new@example.invalid", status: "suspended", role: "member" });
    const response = await verifyOtp(fixture, { ...request, code: extractCode(fixture.messages[0]) });
    assert.equal(response.status, 403);
    const row = await fixture.env.AUTH_DB.prepare("SELECT status FROM auth_users").first();
    assert.equal(row.status, "suspended");
    assert.equal(await countUsers(fixture), 1);
  });
  it("does not accept an old mailbox proof after the account address changes", async () => {
    const fixture = enrollmentFixture();
    await seedUser(fixture, { email: "old@example.invalid", status: "invited" });
    const request = await requestOtp(fixture, "old@example.invalid");
    await fixture.env.AUTH_DB.prepare("UPDATE auth_users SET email = 'new@example.invalid'").run();
    const response = await verifyOtp(fixture, { ...request, code: extractCode(fixture.messages.at(-1)) });
    assert.equal(response.status, 403);
    assert.equal((await fixture.env.AUTH_DB.prepare("SELECT status FROM auth_users").first()).status, "invited");
  });
  it("reuses a concurrently imported account without changing its identity or role", async () => {
    const fixture = enrollmentFixture();
    const request = await requestOtp(fixture, "new@example.invalid");
    await seedUser(fixture, { id: "directory-id", email: "new@example.invalid", role: "member" });
    const response = await verifyOtp(fixture, { ...request, code: extractCode(fixture.messages[0]) });
    assert.equal(response.status, 200);
    const token = await verifyAuthToken(fixture.env, sessionCookie(response));
    assert.equal(token.sub, "directory-id");
    assert.equal(token.role, "member");
    assert.equal(await countUsers(fixture), 1);
  });
});
