import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadApi() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-portal-admin-mcp-api-"));
  const outfile = join(outdir, "api.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./api.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function response(json, status = 200) {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

describe("Admin MCP API contract", () => {
  it("defaults connection queries to active and forwards user search", async () => {
    const { loadAdminMcpConnections } = await loadApi();
    const calls = [];
    const fetcher = async (input, init) => {
      calls.push({ input: String(input), init });
      return response({ connections: [], summary: { activeCount: 0, inactiveCount: 0, totalCount: 0, userCount: 0 } });
    };

    await loadAdminMcpConnections({ fetcher });
    await loadAdminMcpConnections({ fetcher, query: " Alyssa Lin ", status: "all" });

    assert.equal(calls[0].input, "/api/admin/mcp/connections?status=active");
    assert.equal(calls[1].input, "/api/admin/mcp/connections?status=all&q=Alyssa+Lin");
  });

  it("disables a connection through its dedicated admin action", async () => {
    const { disableAdminMcpConnection } = await loadApi();
    const calls = [];
    const fetcher = async (input, init) => {
      calls.push({ input: String(input), init });
      return response({ connection: { id: "conn/1", status: "inactive" } });
    };

    const payload = await disableAdminMcpConnection("conn/1", fetcher);

    assert.equal(payload.connection.status, "inactive");
    assert.equal(calls[0].input, "/api/admin/mcp/connections/conn%2F1/disable");
    assert.equal(calls[0].init.method, "POST");
  });
});
