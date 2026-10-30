import assert from "node:assert/strict";
import { it } from "node:test";
import { createMiniappLoginTicket, readMiniappLoginStatus } from "./miniappLogin.ts";

it("requests an official miniapp code with the Workspace Web session and polls its ticket", async () => {
  const calls = [];
  const fetcher = async (input, init) => {
    calls.push({ input, init });
    return Response.json(calls.length === 1
      ? { ticket: "abcdefghijklmnopqrstuvwx", qrImageDataUrl: "data:image/png;base64,iVBORw0KGgo=", expiresAt: "2026-09-26T12:00:00Z" }
      : { status: "authenticated" });
  };

  const ticket = await createMiniappLoginTicket(fetcher);
  assert.equal(ticket.ticket, "abcdefghijklmnopqrstuvwx");
  assert.equal(ticket.qrImageDataUrl, "data:image/png;base64,iVBORw0KGgo=");
  assert.equal(await readMiniappLoginStatus(fetcher, ticket.ticket), "authenticated");
  assert.equal(calls[0].input, "/auth/miniapp/login-tickets");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[1].input, "/auth/miniapp/login-tickets/abcdefghijklmnopqrstuvwx/status");
  assert.equal(calls[1].init.credentials, "same-origin");
});

it("rejects a failed or malformed miniapp code response", async () => {
  await assert.rejects(
    createMiniappLoginTicket(async () => Response.json({ error: "unauthorized" }, { status: 401 })),
    /miniapp_login_required/
  );
  await assert.rejects(
    createMiniappLoginTicket(async () => Response.json({ ticket: "not-a-ticket", qrImageDataUrl: "https://attacker.example/login", expiresAt: "invalid" })),
    /miniapp_qr_invalid/
  );
});

it("accepts the scanned state while the phone exchanges its session", async () => {
  const status = await readMiniappLoginStatus(async () => Response.json({ status: "scanned" }), "abcdefghijklmnopqrstuvwx");
  assert.equal(status, "scanned");
});
