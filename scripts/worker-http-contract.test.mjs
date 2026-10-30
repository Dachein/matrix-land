import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { before, after, describe, it } from "node:test";
import { build } from "esbuild";

let outdir;
const modules = new Map();
before(async () => {
  outdir = await mkdtemp(join(tmpdir(), "workspace-http-contract-"));
  for (const [name, path] of [
    ["auth", "workers/auth/src/http.ts"],
    ["portal", "functions/api/http.ts"],
    ["mcp", "workers/mcp/src/http.ts"],
    ["apps", "workers/apps/src/core/http.ts"],
    ["backup", "workers/backup/src/http.ts"],
    ["knowledge", "workers/knowledge/src/http.ts"]
  ]) {
    const outfile = join(outdir, `${name}.mjs`);
    await build({ entryPoints: [path], bundle: true, outfile, format: "esm", platform: "neutral", logLevel: "silent" });
    modules.set(name, await import(pathToFileURL(outfile).href));
  }
});
after(async () => { if (outdir) await rm(outdir, { force: true, recursive: true }); });

for (const name of ["auth", "apps", "backup", "knowledge"]) describe(`${name} HTTP contract`, () => {
  for (const headers of [new Headers({ "x-contract": "preserved" }), [["x-contract", "preserved"]], { "x-contract": "preserved" }]) {
    it(`preserves ${headers instanceof Headers ? "Headers" : Array.isArray(headers) ? "tuple" : "record"} response headers`, async () => {
      const response = modules.get(name).json({ ok: true }, { status: 202, headers });
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("x-contract"), "preserved");
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.deepEqual(await response.json(), { ok: true });
    });
  }
  it("keeps unexpected exception details in correlated server logs", async () => {
    const originalError = console.error, logs = [];
    console.error = (...args) => logs.push(args);
    try {
      const response = modules.get(name).errorResponse(new Error("synthetic-private-detail"), "req-contract");
      const payload = await response.json();
      assert.equal(response.status, 500);
      assert.equal(payload.requestId, "req-contract");
      assert.equal(JSON.stringify(payload).includes("synthetic-private-detail"), false);
      assert.equal(logs[0][1].requestId, "req-contract");
      assert.equal(logs[0][1].errorName, "Error");
      assert.equal(JSON.stringify(logs).includes("synthetic-private-detail"), false);
    } finally { console.error = originalError; }
  });
});

it("reports malformed Auth JSON as a client error", async () => {
  await assert.rejects(modules.get("auth").readJson(new Request("https://auth.test/", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{broken"
  })), error => error.status === 400 && error.code === "invalid_json");
});
it("retains the Auth content-type and APPS optional body contracts", async () => {
  const request = new Request("https://worker.test/", { method: "POST", body: "plain" });
  await assert.rejects(modules.get("auth").readJson(request.clone()), error => error.status === 415 && error.code === "json_required");
  assert.deepEqual(await modules.get("apps").readJson(request.clone()), {});
});

for (const name of ["portal", "auth", "apps", "knowledge", "mcp"]) {
  it(`${name} isolates CORS to configured installation origins`, () => {
    const mod = modules.get(name);
    const headers = (origin, env = {}, url = "https://service.example/") => {
      const request = new Request(url, { headers: { Origin: origin } });
      const stale = new Headers({ "Access-Control-Allow-Origin": "https://old.example", "Access-Control-Allow-Credentials": "true" });
      return name === "auth" ? mod.withCors(stale, request, env) : mod.corsHeaders(request, env, stale);
    };
    assert.equal(headers("https://ai.example.invalid").get("Access-Control-Allow-Origin"), null);
    assert.equal(headers("https://workspace.example", { CORS_ALLOWED_ORIGINS: "https://workspace.example" }).get("Access-Control-Allow-Origin"), "https://workspace.example");
    assert.equal(headers("https://workspace.example.evil.test", { CORS_ALLOWED_ORIGINS: "https://workspace.example" }).get("Access-Control-Allow-Origin"), null);
    const denied = headers("http://localhost:5193");
    assert.equal(denied.get("Access-Control-Allow-Origin"), null);
    assert.equal(denied.get("Access-Control-Allow-Credentials"), null);
    assert.match(denied.get("Vary"), /Origin/);
    assert.equal(headers("http://localhost:5193", {}, "http://127.0.0.1:8792/").get("Access-Control-Allow-Origin"), "http://localhost:5193");
    assert.equal(headers("null", { CORS_ALLOWED_ORIGINS: "data:text/plain,test" }).get("Access-Control-Allow-Origin"), null);
  });
}
