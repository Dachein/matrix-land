import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthRequiredError, isAuthRequiredError } from "./auth.ts";

describe("miniapp authentication boundary", () => {
  it("recognises the auth-required error class", () => {
    assert.equal(isAuthRequiredError(new AuthRequiredError()), true);
  });

  it("treats a bare 401 and 403 as a lost web session", () => {
    assert.equal(isAuthRequiredError({ status: 401 }), true);
    assert.equal(isAuthRequiredError({ status: 403 }), true);
    assert.equal(isAuthRequiredError({ code: "http_401", status: 401 }), true);
  });

  it("recognises known auth error codes regardless of status", () => {
    assert.equal(isAuthRequiredError({ code: "session_expired" }), true);
    assert.equal(isAuthRequiredError({ code: "wechat_binding_required" }), true);
    assert.equal(isAuthRequiredError({ message: "unauthenticated", status: 500 }), true);
  });

  it("never mistakes a runtime session failure for a lost web session", () => {
    // runtime_token_invalid is renewed in place and must not route the user to login.
    assert.equal(isAuthRequiredError({ code: "runtime_token_invalid", status: 401 }), false);
    assert.equal(isAuthRequiredError({ message: "runtime_token_invalid", status: 401 }), false);
  });

  it("ignores ordinary transport and validation failures", () => {
    assert.equal(isAuthRequiredError({ code: "http_502", status: 502 }), false);
    assert.equal(isAuthRequiredError({ code: "conversation_create_failed", status: 400 }), false);
    assert.equal(isAuthRequiredError(new Error("网络不可用")), false);
    assert.equal(isAuthRequiredError(undefined), false);
    assert.equal(isAuthRequiredError("auth_required"), false);
  });
});
