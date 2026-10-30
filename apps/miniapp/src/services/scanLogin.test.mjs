import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanLoginTicket } from "./scanLogin.ts";

const ticket = "ticket_1234567890_abcdef";

describe("miniapp scan login QR validation", () => {
  it("accepts the direct mini program launch path", () => {
    assert.equal(scanLoginTicket({ path: `pages/login/index?scene=${ticket}` }), ticket);
    assert.equal(scanLoginTicket({ path: `pages/login/index?ticket=${ticket}` }), ticket);
  });

  it("accepts only the Workspace Auth HTTPS login URL", () => {
    assert.equal(scanLoginTicket({ result: `https://ai.example.invalid/auth/miniapp/login?ticket=${ticket}` }), ticket);
    assert.equal(scanLoginTicket({ result: `https://auth.example.invalid/auth/miniapp/scan?ticket=${ticket}` }), ticket);
    assert.equal(scanLoginTicket({ result: `https://attacker.example/auth/miniapp/login?ticket=${ticket}` }), "");
  });

  it("rejects unrelated paths and malformed tickets", () => {
    assert.equal(scanLoginTicket({ path: `pages/chat/index?scene=${ticket}` }), "");
    assert.equal(scanLoginTicket({ result: "https://ai.example.invalid/auth/miniapp/login?ticket=short" }), "");
  });
});
