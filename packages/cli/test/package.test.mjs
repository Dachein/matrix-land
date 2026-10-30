import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { runCli } from "../src/cli.mjs";
import { listMcpTools, callMcpTool } from "../src/mcp-client.mjs";
import { runMcpProxy } from "../src/mcp-proxy.mjs";
import { Readable, Writable } from "node:stream";

Object.assign(process.env,{WORKSPACE_AUTH_URL:"https://auth.example.test",WORKSPACE_MCP_URL:"https://mcp.example.test/mcp"});

test("the published CLI package contains generic entrypoints and no local YiDA implementation", () => {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: new URL("../", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  }));
  const files = pack.files.map(file => file.path);
  assert.ok(files.includes("bin/frontier-workspace.mjs"));
  assert.ok(files.includes("src/cli.mjs"));
  assert.ok(files.includes("src/mcp-proxy.mjs"));
  assert.equal(files.some(file => /yida/i.test(file)), false);
});

test("CLI help and command dispatch no longer expose the local YiDA entrypoint", async () => {
  let help = "";
  const options = { stdout: { write(value) { help += value; } }, stderr: { write() {} },
    store: { async load() { throw Error("No local credentials should be read"); } }, throwOnError: true };
  await runCli(["--help"], options);
  assert.equal(/yida/i.test(help), false);
  await assert.rejects(runCli(["yida", "auth", "login"], options), /Usage: frontier-workspace/);
});

test("one-shot MCP discovery returns the hosted mailbox catalog without adding local tools", async () => {
  const remote = { tools: [{ name: "mail_list", inputSchema: { type: "object" } }], nextCursor: "next-page" };
  const store = { async load() { return { auth_url:"https://auth.example.test",resource_url:"https://mcp.example.test/mcp",access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600000 }; } };
  const listed = await listMcpTools(store, { async fetchImpl(_url, init) {
    assert.equal(JSON.parse(init.body).method, "tools/list");
    return Response.json({ result: remote });
  } });
  assert.deepEqual(listed, remote);
});

test("cached local YiDA tool calls are rejected before forwarding private form arguments", async () => {
  const store = { async load() { throw Error("Retired tools do not read credentials"); } };
  const options = { async fetchImpl() { assert.fail("Retired arguments must not reach the network"); } };
  await assert.rejects(callMcpTool(store, "yida_submit_expense", { privateField: "private-form-data" }, options), /were removed/);
  let output = "";
  await runMcpProxy(store, { ...options, input: Readable.from([JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "yida_submit_expense", arguments: { privateField: "private-form-data" } }
  }) + "\n"]), output: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }) });
  const response = JSON.parse(output);
  assert.match(response.error.message, /were removed/);
  assert.equal(output.includes("private-form-data"), false);
});
