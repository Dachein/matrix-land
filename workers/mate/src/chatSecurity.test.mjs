import assert from "node:assert/strict";
import test from "node:test";
import { requireRuntimeMode, resolveRuntimePrincipal } from "./auth.ts";
import {
  MATE_CHAT_INSTANCE_PREFIX,
  mateChatInstanceName
} from "./chatAddress.ts";
import {
  createMateChatGrant,
  MATE_CHAT_GRANT_AUDIENCE,
  MATE_CHAT_GRANT_CLOCK_SKEW_SECONDS,
  MATE_CHAT_GRANT_MAX_TTL_SECONDS,
  verifyMateChatGrant,
  verifyMateChatGrantForBinding
} from "./chatGrant.ts";

const now = 1_800_000_000_000;
const secret = "test-mate-chat-grant-secret-that-is-long-enough";
const liveJwtSecret = "test-live-runtime-jwt-secret-that-is-long-enough";
const previewJwtSecret = "test-preview-runtime-jwt-secret-that-is-long-enough";

test("Runtime JWT verification keeps Live and Preview signing domains separate", async () => {
  const liveToken = await signRuntimeJwt(runtimeClaims(), liveJwtSecret);
  const previewToken = await signRuntimeJwt(runtimeClaims({
    release_id: "candidate-1",
    runtime_mode: "preview",
    mate_id: "knowledge-mate"
  }), previewJwtSecret);
  const env = {
    MATE_PREVIEW_JWT_SECRET: previewJwtSecret,
    MATE_RUNTIME_JWT_SECRET: liveJwtSecret
  };

  const livePrincipal = await resolveRuntimePrincipal(runtimeJwtRequest(liveToken), env);
  assert.equal(livePrincipal.userId, "owner-1");
  assert.equal(livePrincipal.testGrant, undefined);
  const previewPrincipal = await resolveRuntimePrincipal(runtimeJwtRequest(previewToken), env);
  assert.deepEqual(previewPrincipal.testGrant, {
    releaseId: "candidate-1",
    mateId: "knowledge-mate"
  });

  const legacyPreview = await signRuntimeJwt(runtimeClaims({
    release_id: "candidate-1",
    runtime_mode: "preview",
    mate_id: "knowledge-mate"
  }), liveJwtSecret);
  await assert.rejects(
    resolveRuntimePrincipal(runtimeJwtRequest(legacyPreview), {
      MATE_RUNTIME_JWT_SECRET: liveJwtSecret
    }),
    runtimeError(503, "runtime_preview_jwt_secret_not_configured")
  );

  // Preview claims always require the independent key, which is never
  // accepted for a Live token.
  await assert.rejects(
    resolveRuntimePrincipal(runtimeJwtRequest(legacyPreview), env),
    runtimeError(401, "runtime_token_invalid")
  );
  const liveClaimsSignedByPreview = await signRuntimeJwt(runtimeClaims(), previewJwtSecret);
  await assert.rejects(
    resolveRuntimePrincipal(runtimeJwtRequest(liveClaimsSignedByPreview), env),
    runtimeError(401, "runtime_token_invalid")
  );
  const webSessionToken = await signRuntimeJwt(runtimeClaims({
    runtime_mode: "live",
    token_use: "mate_web_session"
  }), previewJwtSecret);
  const webPrincipal = await resolveRuntimePrincipal(runtimeJwtRequest(webSessionToken), env);
  assert.equal(webPrincipal.userId, "owner-1");
  assert.equal(webPrincipal.testGrant, undefined);
  const forgedWebSession = await signRuntimeJwt(runtimeClaims({
    runtime_mode: "live",
    token_use: "mate_web_session"
  }), liveJwtSecret);
  await assert.rejects(
    resolveRuntimePrincipal(runtimeJwtRequest(forgedWebSession), env),
    runtimeError(401, "runtime_token_invalid")
  );
  const malformedPreview = await signRuntimeJwt(runtimeClaims({ runtime_mode: "preview" }), previewJwtSecret);
  await assert.rejects(
    resolveRuntimePrincipal(runtimeJwtRequest(malformedPreview), env),
    runtimeError(401, "runtime_token_invalid")
  );
  const paddedPreviewMode = await signRuntimeJwt(runtimeClaims({
    release_id: "candidate-1",
    runtime_mode: " preview ",
    mate_id: "knowledge-mate"
  }), previewJwtSecret);
  await assert.rejects(
    resolveRuntimePrincipal(runtimeJwtRequest(paddedPreviewMode), env),
    runtimeError(401, "runtime_token_invalid")
  );
  await assert.rejects(
    resolveRuntimePrincipal(runtimeJwtRequest(previewToken), {
      MATE_PREVIEW_JWT_SECRET: "short",
      MATE_RUNTIME_JWT_SECRET: liveJwtSecret
    }),
    runtimeError(503, "runtime_preview_jwt_secret_invalid")
  );
  await assert.rejects(
    resolveRuntimePrincipal(runtimeJwtRequest(legacyPreview), {
      MATE_PREVIEW_JWT_SECRET: liveJwtSecret,
      MATE_RUNTIME_JWT_SECRET: liveJwtSecret
    }),
    runtimeError(503, "runtime_preview_jwt_secret_invalid")
  );
});

test("Preview-bound Runtime principals cannot be downgraded into Live routes", () => {
  const principal = {
    callerKind: "user",
    orgId: "org-1",
    scopes: ["mate:invoke", "mate:owner_test"],
    testGrant: { releaseId: "candidate-1", mateId: "knowledge-mate" },
    userId: "owner-1"
  };
  assert.throws(() => requireRuntimeMode(principal, "live"), runtimeError(403, "runtime_mode_mismatch"));
  assert.doesNotThrow(() => requireRuntimeMode(principal, "preview"));
  assert.doesNotThrow(() => requireRuntimeMode({ ...principal, testGrant: undefined }, "live"));
});

function binding(overrides = {}) {
  return {
    callerKind: "user",
    conversationId: "conv_12345678",
    departmentId: "department-portfolio",
    departmentPath: ["wealth", "portfolio"],
    mode: "live",
    orgId: "org-1",
    releaseId: "portfolio-mate-r3",
    scopes: ["mate:preferences", "mate:invoke"],
    mateId: "portfolio-mate",
    userId: "user-1",
    ...overrides
  };
}

function dependencies(overrides = {}) {
  return {
    now: () => now,
    randomUUID: () => "grant_12345678",
    ...overrides
  };
}

function routeAddress(overrides = {}) {
  const value = binding(overrides);
  return { conversationId: value.conversationId, mode: value.mode, mateId: value.mateId };
}

test("Chat address creates a stable anonymous DO name and isolates every coordinate", async () => {
  const input = binding();
  const first = await mateChatInstanceName(input);
  const repeated = await mateChatInstanceName({ ...input, instanceName: "client-selected" });
  assert.equal(first, repeated);
  const coordinate = [input.mateId, input.userId, input.mode, input.conversationId].join("\u0000");
  const expectedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(coordinate)));
  assert.equal(first, `${MATE_CHAT_INSTANCE_PREFIX}${base64Url(expectedDigest)}`);
  assert.match(first, new RegExp(`^${MATE_CHAT_INSTANCE_PREFIX}[A-Za-z0-9_-]{43}$`));
  for (const raw of [input.mateId, input.userId, input.conversationId]) assert.equal(first.includes(raw), false);

  for (const changed of [
    binding({ mateId: "other-mate" }),
    binding({ userId: "user-2" }),
    binding({ mode: "preview" }),
    binding({ conversationId: "conv_87654321" })
  ]) assert.notEqual(await mateChatInstanceName(changed), first);
});

test("Chat address accepts the isolated Preview mode and rejects unknown or malformed coordinates", async () => {
  assert.match(await mateChatInstanceName(binding({ mode: "preview" })), new RegExp(`^${MATE_CHAT_INSTANCE_PREFIX}`));
  await assert.rejects(
    mateChatInstanceName(binding({ mode: "preview", releaseId: undefined })),
    runtimeError(422, "mate_chat_address_invalid")
  );
  await assert.rejects(
    mateChatInstanceName(binding({ mode: "debug" })),
    runtimeError(422, "mate_chat_mode_invalid")
  );
  for (const changed of [
    binding({ mateId: "" }),
    binding({ userId: " user-1" }),
    binding({ conversationId: "conv_1234\n" }),
    binding({ conversationId: "x".repeat(129) }),
    binding({ mateId: "x".repeat(181) }),
    binding({ userId: "x".repeat(181) })
  ]) await assert.rejects(mateChatInstanceName(changed), runtimeError(422, "mate_chat_address_invalid"));
});

test("Chat Grant carries only the bound Live identity and derives instanceName server-side", async () => {
  const input = {
    ...binding(),
    instanceName: "client-selected-instance",
    ownerUserId: "owner-1"
  };
  const token = await createMateChatGrant(input, secret, { ...dependencies(), ttlSeconds: 120 });
  const claims = await verifyMateChatGrant(token, secret, routeAddress(), dependencies());
  await verifyMateChatGrantForBinding(token, secret, binding(), dependencies());

  assert.equal(claims.aud, MATE_CHAT_GRANT_AUDIENCE);
  assert.equal(claims.callerKind, "user");
  assert.equal(claims.departmentId, "department-portfolio");
  assert.deepEqual(claims.departmentPath, ["wealth", "portfolio"]);
  assert.equal(claims.iat, Math.floor(now / 1_000));
  assert.equal(claims.exp - claims.iat, 120);
  assert.equal(claims.instanceName, await mateChatInstanceName(binding()));
  assert.equal(claims.jti, "grant_12345678");
  assert.equal(claims.mode, "live");
  assert.deepEqual(claims.scopes, ["mate:invoke"]);
  assert.equal("ownerUserId" in claims, false);
  assert.equal("email" in claims, false);
  assert.equal("name" in claims, false);
  assert.equal("token" in claims, false);
  assert.equal(claims.instanceName === input.instanceName, false);
});

test("Preview Chat Grant is mode- and route-bound and derives a distinct DO", async () => {
  const preview = binding({ mode: "preview" });
  const token = await createMateChatGrant(preview, secret, dependencies());
  const claims = await verifyMateChatGrant(token, secret, routeAddress({ mode: "preview" }), dependencies());
  assert.equal(claims.mode, "preview");
  assert.equal(claims.releaseId, preview.releaseId);
  assert.equal(claims.instanceName, await mateChatInstanceName(preview));
  assert.notEqual(claims.instanceName, await mateChatInstanceName(binding()));
  assert.notEqual(
    claims.instanceName,
    await mateChatInstanceName({ ...preview, releaseId: "portfolio-mate-r4" })
  );
  const staleInstanceGrant = await resignPayload(token, {
    ...decodePayload(token),
    releaseId: "portfolio-mate-r4"
  }, secret);
  await assert.rejects(
    verifyMateChatGrant(staleInstanceGrant, secret, routeAddress({ mode: "preview" }), dependencies()),
    invalidGrant
  );
  await assert.rejects(
    verifyMateChatGrant(token, secret, routeAddress(), dependencies()),
    invalidGrant
  );
  await assert.rejects(
    verifyMateChatGrantForBinding(token, secret, binding(), dependencies()),
    invalidGrant
  );
});

test("Chat Grant issuance caps lifetime at five minutes and requires a server secret", async () => {
  await assert.rejects(
    createMateChatGrant(binding(), secret, { ...dependencies(), ttlSeconds: MATE_CHAT_GRANT_MAX_TTL_SECONDS + 1 }),
    runtimeError(422, "mate_chat_grant_ttl_invalid")
  );
  await assert.rejects(
    createMateChatGrant(binding(), secret, { ...dependencies(), ttlSeconds: 0 }),
    runtimeError(422, "mate_chat_grant_ttl_invalid")
  );
  await assert.rejects(
    createMateChatGrant(binding(), "short-secret", dependencies()),
    runtimeError(503, "mate_chat_grant_secret_not_configured")
  );
  await assert.rejects(
    createMateChatGrant(binding({ callerKind: "app" }), secret, dependencies()),
    runtimeError(403, "mate_chat_user_caller_required")
  );
  await assert.rejects(
    createMateChatGrant(binding({ scopes: ["mate:preferences"] }), secret, dependencies()),
    runtimeError(403, "mate_chat_scope_insufficient")
  );
  await assert.rejects(
    createMateChatGrant(binding({ departmentPath: Array.from({ length: 17 }, (_, index) => `department-${index}`) }), secret, dependencies()),
    runtimeError(422, "mate_chat_grant_claim_invalid")
  );
});

test("Chat Grant omits absent departments and canonicalizes wildcard invocation authority", async () => {
  const expected = binding({
    departmentId: undefined,
    departmentPath: undefined,
    scopes: ["mate:invoke", "mate:*", "mate:preferences"]
  });
  const token = await createMateChatGrant(expected, secret, dependencies());
  const claims = await verifyMateChatGrantForBinding(token, secret, expected, dependencies());
  assert.equal("departmentId" in claims, false);
  assert.equal("departmentPath" in claims, false);
  assert.deepEqual(claims.scopes, ["mate:*"]);
});

test("Chat Grant self-verifies before binding trusted claims to the Live route address", async () => {
  const token = await createMateChatGrant(binding(), secret, dependencies());
  const [header, payload, signature] = token.split(".");
  const tamperedPayload = encodeJson({ ...decodeJson(payload), releaseId: "attacker-release" });
  const tamperedAddress = routeAddress({ mateId: "attacker-mate", conversationId: "attacker-conversation" });
  const tamperedAddressPayload = encodeJson({ ...decodeJson(payload), ...tamperedAddress });

  await assert.rejects(
    verifyMateChatGrant(`${header}.${tamperedPayload}.${signature}`, secret, routeAddress(), dependencies()),
    invalidGrant
  );
  await assert.rejects(
    verifyMateChatGrant(`${header}.${tamperedAddressPayload}.${signature}`, secret, tamperedAddress, dependencies()),
    invalidGrant
  );
  await assert.rejects(
    verifyMateChatGrant(token, "another-test-secret-that-is-long-enough", routeAddress(), dependencies()),
    invalidGrant
  );
  const selfVerified = await verifyMateChatGrant(token, secret, undefined, dependencies());
  assert.equal(selfVerified.userId, "user-1");
  assert.equal(selfVerified.releaseId, "portfolio-mate-r3");
  for (const expected of [
    routeAddress({ mateId: "other-mate" }),
    routeAddress({ mode: "preview" }),
    routeAddress({ conversationId: "conv_87654321" })
  ]) await assert.rejects(verifyMateChatGrant(token, secret, expected, dependencies()), invalidGrant);
});

test("Chat Grant optional full-binding verifier rejects a different principal or Release", async () => {
  const token = await createMateChatGrant(binding(), secret, dependencies());
  for (const expected of [
    binding({ orgId: "org-2" }),
    binding({ userId: "user-2" }),
    binding({ releaseId: "portfolio-mate-r4" }),
    binding({ departmentId: "department-advisory" }),
    binding({ departmentPath: ["wealth", "advisory"] }),
    binding({ scopes: ["mate:*"] })
  ]) await assert.rejects(verifyMateChatGrantForBinding(token, secret, expected, dependencies()), invalidGrant);
});

test("Chat Grant rejects signed audience, version, owner authority, address, and lifetime substitutions", async () => {
  const token = await createMateChatGrant(binding(), secret, dependencies());
  const changes = [
    (claims) => ({ ...claims, aud: "another-audience" }),
    (claims) => ({ ...claims, version: 2 }),
    (claims) => ({ ...claims, ownerUserId: "owner-1" }),
    (claims) => ({ ...claims, callerKind: "mate" }),
    (claims) => ({ ...claims, scopes: ["mate:invoke", "mate:preferences"] }),
    (claims) => ({ ...claims, departmentPath: [...claims.departmentPath, "x".repeat(181)] }),
    (claims) => ({ ...claims, instanceName: "mate-chat-client-selected" }),
    (claims) => ({ ...claims, exp: claims.iat + MATE_CHAT_GRANT_MAX_TTL_SECONDS + 1 })
  ];
  for (const change of changes) {
    const substituted = await resignPayload(token, change(decodePayload(token)), secret);
    await assert.rejects(verifyMateChatGrant(substituted, secret, routeAddress(), dependencies()), invalidGrant);
  }
});

test("Chat Grant applies bounded clock skew to future and expired tokens", async () => {
  const token = await createMateChatGrant(binding(), secret, { ...dependencies(), ttlSeconds: 60 });
  await verifyMateChatGrant(token, secret, routeAddress(), {
    now: () => now + (60 + MATE_CHAT_GRANT_CLOCK_SKEW_SECONDS - 1) * 1_000
  });
  await assert.rejects(verifyMateChatGrant(token, secret, routeAddress(), {
    now: () => now + (60 + MATE_CHAT_GRANT_CLOCK_SKEW_SECONDS) * 1_000
  }), invalidGrant);

  const acceptableFuture = await createMateChatGrant(binding(), secret, dependencies({
    now: () => now + MATE_CHAT_GRANT_CLOCK_SKEW_SECONDS * 1_000
  }));
  await verifyMateChatGrant(acceptableFuture, secret, routeAddress(), dependencies());
  const rejectedFuture = await createMateChatGrant(binding(), secret, dependencies({
    now: () => now + (MATE_CHAT_GRANT_CLOCK_SKEW_SECONDS + 1) * 1_000
  }));
  await assert.rejects(verifyMateChatGrant(rejectedFuture, secret, routeAddress(), dependencies()), invalidGrant);
});

test("Chat Grant fails closed for malformed encodings and non-HMAC signatures", async () => {
  for (const token of [
    "",
    "one.two",
    "one.two.three.four",
    "*.payload.signature",
    `${encodeJson({ alg: "HS256", typ: "WORKSPACE_MATE_CHAT_GRANT" })}.${encodeJson({})}._`,
    `${encodeJson({ alg: "HS256", typ: "WORKSPACE_MATE_CHAT_GRANT" })}.${encodeJson({})}.AA`
  ]) await assert.rejects(verifyMateChatGrant(token, secret, routeAddress(), dependencies()), invalidGrant);

  const canonical = await createMateChatGrant(binding(), secret, dependencies());
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const canonicalIndex = alphabet.indexOf(canonical.at(-1));
  const nonCanonical = `${canonical.slice(0, -1)}${alphabet[canonicalIndex + 1]}`;
  await assert.rejects(verifyMateChatGrant(nonCanonical, secret, routeAddress(), dependencies()), invalidGrant);
});

async function resignPayload(token, payload, signingSecret) {
  const [header] = token.split(".");
  const encodedPayload = encodeJson(payload);
  const signed = `${header}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)));
  return `${signed}.${base64Url(signature)}`;
}

async function signRuntimeJwt(claims, signingSecret) {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson(claims);
  const signed = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)));
  return `${signed}.${base64Url(signature)}`;
}

function runtimeClaims(overrides = {}) {
  return {
    aud: "workspace-mate-runtime",
    caller_kind: "user",
    exp: Math.floor(Date.now() / 1_000) + 300,
    org_id: "org-1",
    scopes: ["mate:owner_test", "mate:invoke"],
    sub: "owner-1",
    ...overrides
  };
}

function runtimeJwtRequest(token) {
  return new Request("https://runtime.example.invalid/v1/mates/knowledge-mate/runtime", {
    headers: { authorization: `Bearer ${token}` }
  });
}

function decodePayload(token) {
  return decodeJson(token.split(".")[1]);
}

function encodeJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
}

function base64Url(value) {
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function runtimeError(status, code) {
  return (error) => error?.status === status && error?.code === code;
}

function invalidGrant(error) {
  return error?.status === 401 && error?.code === "mate_chat_grant_invalid";
}
