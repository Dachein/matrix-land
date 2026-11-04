import { fileURLToPath } from "node:url";
import { installationOptions } from "../src/installation.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { runCli as runConfiguredCli } from "../src/cli.mjs";
import { browserLaunchCommand, currentCredential } from "../src/auth.mjs";
import { createCredentialStore } from "../src/credential-store.mjs";
import { runMcpProxy } from "../src/mcp-proxy.mjs";
import { createLoopbackReceiver } from "../src/loopback-receiver.mjs";
import { createDeploymentArtifact } from "../src/deployment-artifact.mjs";
import { deploymentArtifactSummary } from "../src/apps-deploy-artifacts.mjs";
import { analyzeAppsMigrationSql } from "../src/apps-migrations.mjs";
import { createSourceSnapshot } from "../src/source-snapshot.mjs";
import { defaultAgentConfigPath, defaultWorkBuddyConfigPath, installWorkBuddyMcp } from "../src/workbuddy-install.mjs";
import { CLI_VERSION } from "../src/constants.mjs";

const fixtureInstallation = {authUrl:"https://auth.example.invalid",mcpUrl:"https://mcp.example.invalid/mcp",apiUrl:"https://mcp.example.invalid"};
const fixtureKey = installationOptions(fixtureInstallation).installationKey;
const fixtureServer = `workspace-${fixtureKey.slice(0,12)}`;
const fixtureEnv = {WORKSPACE_AUTH_URL:fixtureInstallation.authUrl,WORKSPACE_MCP_URL:fixtureInstallation.mcpUrl,WORKSPACE_API_URL:fixtureInstallation.apiUrl};
Object.assign(process.env,fixtureEnv);
function runCli(args, options={}) { const merged={...fixtureInstallation,...options}; if(options.apiUrl&&!options.mcpUrl)merged.mcpUrl=options.apiUrl+"/mcp"; return runConfiguredCli(args,merged); }

function memoryStore(initial) {
  const complete=value=>value?{auth_url:fixtureInstallation.authUrl,resource_url:fixtureInstallation.mcpUrl,...value}:value;
  let credential = complete(initial);
  return { kind: "memory", async load() { return credential; }, async save(value) { credential = complete(value); }, async clear() { credential = undefined; }, value() { return credential; } };
}

function collector() {
  let value = "";
  return { stream: new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } }), value: () => value };
}

describe("workspace-cli", () => {
  it("keeps the executable version aligned with the published package", async () => {
    const packageMetadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(CLI_VERSION, packageMetadata.version);
  });

  it("shows the complete APPS deploy help before validating required options", async () => {
    const output = collector();
    const errors = collector();

    await runCli(["apps", "deploy", "--help"], {
      stdout: output.stream,
      stderr: errors.stream,
      store: memoryStore(),
      throwOnError: true
    });

    assert.match(output.value(), /--assets-dir <directory>/);
    assert.match(output.value(), /--queue-consumer <binding>/);
    assert.match(output.value(), /--cron <expression>/);
    assert.match(output.value(), /maximum 4000 characters/);
    assert.match(output.value(), /ready, unpublished deployment/);
    assert.match(output.value(), /apps_deployment_release\(action=publish\)/);
    assert.match(output.value(), /--notes-file RELEASE_NOTES\.md/);
    assert.doesNotMatch(output.value(), /--notes-file CHANGELOG\.md/);
    assert.match(output.value(), /\.workspace-assets\/ is an internal archive directory reserved for Workspace CLI/);
    assert.equal(errors.value(), "");
  });

  it("enforces the documented release-note limit for inline and file input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-release-notes-limit-"));
    const deployDirectory = join(directory, "dist");
    const notesPath = join(directory, "RELEASE_NOTES.md");
    await mkdir(deployDirectory, { recursive: true });
    await writeFile(join(deployDirectory, "index.js"), "export default {};\n");
    await writeFile(notesPath, "x".repeat(4_001));
    const baseArgs = [
      "apps", "deploy", "--app", "app-1", "--deploy-dir", deployDirectory,
      "--target", "worker", "--version", "1.0.0", "--name", "Limit check"
    ];

    await assert.rejects(
      () => runCli([...baseArgs, "--notes", "x".repeat(4_001)], {
        stdout: collector().stream,
        stderr: collector().stream,
        store: memoryStore(),
        throwOnError: true
      }),
      /Notes must not exceed 4000 characters/
    );
    await assert.rejects(
      () => runCli([...baseArgs, "--notes-file", notesPath], {
        stdout: collector().stream,
        stderr: collector().stream,
        store: memoryStore(),
        throwOnError: true
      }),
      /Notes must not exceed 4000 characters/
    );
  });

  it("targets the WorkBuddy AI configuration directory", () => {
    assert.equal(defaultWorkBuddyConfigPath("/home/tester"), "/home/tester/.workbuddy-ai/mcp.json");
    assert.equal(defaultAgentConfigPath("cursor", "/home/tester"), "/home/tester/.cursor/mcp.json");
  });

  it("completes device authorization and stores rotating credentials", async () => {
    const store = memoryStore();
    const output = collector();
    let tokenPolls = 0;
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/device_authorization")) {
        return Response.json({ device_code: "private-device-code", user_code: "ABCD-EFGH", verification_uri: "https://example.test/verify", verification_uri_complete: "https://example.test/verify?user_code=ABCDEFGH", expires_in: 600, interval: 1 });
      }
      tokenPolls += 1;
      if (tokenPolls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
    };
    await runCli(["auth", "device", "--open-browser=never", "--output=jsonl"], { fetchImpl, sleep: async () => {}, stdout: output.stream, stderr: collector().stream, store, throwOnError: true });
    const messages = output.value().trim().split("\n").map(JSON.parse);
    assert.equal(messages[0].verification_uri_complete, "https://example.test/verify?user_code=ABCDEFGH");
    assert.equal(messages[0].device_code, undefined);
    assert.equal(output.value().includes("private-device-code"), false);
    assert.equal(messages[1].logged_in, true);
    assert.equal(store.value().refresh_token, "refresh");
    assert.equal(tokenPolls, 2);
  });

  it("completes authorization code with PKCE on an exact loopback callback", async () => {
    const store = memoryStore();
    const output = collector();
    let registration;
    let tokenRequest;
    let callbackResponse;
    const fetchImpl = async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          authorization_endpoint: "https://portal.example.test/auth/mcp/oauth/authorize",
          code_challenge_methods_supported: ["S256"],
          registration_endpoint: "https://auth.example.test/v1/mcp/oauth/register",
          token_endpoint: "https://auth.example.test/v1/mcp/oauth/token"
        });
      }
      if (target.endsWith("/register")) {
        registration = JSON.parse(init.body);
        return Response.json({ client_id: "dynamic-workbuddy-client" }, { status: 201 });
      }
      if (target.endsWith("/token")) {
        tokenRequest = new URLSearchParams(init.body);
        return Response.json({ access_token: "pkce-access", refresh_token: "pkce-refresh", token_type: "Bearer", expires_in: 3600 });
      }
      throw new Error(`Unexpected request: ${target}`);
    };
    const browserOpener = (authorizationUrl) => {
      const authorization = new URL(authorizationUrl);
      const redirect = new URL(authorization.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", "one-time-code");
      redirect.searchParams.set("state", authorization.searchParams.get("state"));
      callbackResponse = new Promise((resolve) => setImmediate(async () => resolve(fetch(redirect))));
    };

    await runCli(["auth", "login", "--agent=cc", "--open-browser=always", "--output=jsonl"], {
      authUrl: "https://auth.example.test",
      browserOpener,
      fetchImpl,
      stdout: output.stream,
      stderr: collector().stream,
      store,
      throwOnError: true
    });

    const messages = output.value().trim().split("\n").map(JSON.parse);
    const authorization = new URL(messages[0].authorization_url);
    assert.equal(messages[0].method, "authorization_code_pkce");
    assert.equal(messages[0].callback, "loopback");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorization.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/[A-Za-z0-9_-]+$/);
    assert.equal(registration.agent_type, "claude-code");
    assert.equal(registration.client_name, "Workspace CLI for Claude Code");
    assert.deepEqual(registration.redirect_uris, [authorization.searchParams.get("redirect_uri")]);
    assert.equal(tokenRequest.get("grant_type"), "authorization_code");
    assert.equal(tokenRequest.get("client_id"), "dynamic-workbuddy-client");
    assert.equal(tokenRequest.get("redirect_uri"), authorization.searchParams.get("redirect_uri"));
    assert.equal(createHash("sha256").update(tokenRequest.get("code_verifier")).digest("base64url"), authorization.searchParams.get("code_challenge"));
    assert.equal(output.value().includes(tokenRequest.get("code_verifier")), false);
    assert.equal(messages[1].logged_in, true);
    assert.equal(store.value().authorization_method, "authorization_code_pkce");
    assert.equal(store.value().agent_type, "claude-code");
    assert.equal(store.value().client_id, "dynamic-workbuddy-client");
    assert.equal((await callbackResponse).status, 200);
  });

  it("passes the complete OAuth URL to the Windows browser without CMD parsing", () => {
    const authorizationUrl = "https://ai.example.invalid/auth/mcp/oauth/authorize?client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A51483%2Foauth%2Fcallback%2Fstate&code_challenge=challenge";
    assert.deepEqual(browserLaunchCommand(authorizationUrl, "win32"), {
      command: "explorer.exe",
      args: [authorizationUrl]
    });
  });

  it("serializes rotating refresh tokens across concurrent sessions", async () => {
    const initial = { access_token: "expired", refresh_token: "refresh-1", expires_at: 0, client_id: "client-1", token_endpoint: "https://auth.example.invalid/token" };
    const store = memoryStore(initial);
    let lock = Promise.resolve();
    store.withRefreshLock = (callback) => {
      const next = lock.then(callback);
      lock = next.catch(() => {});
      return next;
    };
    let refreshes = 0;
    const fetchImpl = async () => {
      refreshes += 1;
      await Promise.resolve();
      return Response.json({ access_token: "fresh", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600 });
    };

    const [first, second] = await Promise.all([
      currentCredential(store, { fetchImpl }),
      currentCredential(store, { fetchImpl })
    ]);

    assert.equal(refreshes, 1);
    assert.equal(first.refresh_token, "refresh-2");
    assert.equal(second.refresh_token, "refresh-2");
  });

  it("uses an atomic cross-process refresh lock for local credential stores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-refresh-lock-"));
    const store = createCredentialStore({
      env: { ...fixtureEnv, WORKSPACE_CREDENTIAL_STORE: "file" },
      home: directory,
      platform: "linux"
    });
    let active = 0;
    let maxActive = 0;
    await Promise.all([1, 2].map(() => store.withRefreshLock(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    })));
    assert.equal(maxActive, 1);
  });

  it("defaults WorkBuddy macOS credentials to a hardened private file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-macos-file-store-"));
    const credential = { auth_url:fixtureInstallation.authUrl, resource_url:fixtureInstallation.mcpUrl, access_token: "access", refresh_token: "refresh" };
    const store = createCredentialStore({ env: { ...fixtureEnv }, home: directory, platform: "darwin" });

    assert.equal(store.kind, "private-file");
    await store.save(credential);
    const credentialPath = store.filePath;
    assert.deepEqual(await store.load(), credential);
    assert.equal((await lstat(join(directory, ".frontier-workspace", "instances", fixtureKey))).mode & 0o777, 0o700);
    assert.equal((await lstat(credentialPath)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(join(directory, ".frontier-workspace", "instances", fixtureKey))).sort(), ["credentials.json"]);

    await chmod(credentialPath, 0o644);
    await store.load();
    assert.equal((await lstat(credentialPath)).mode & 0o777, 0o600);
  });

  it("rejects a symlinked private credential file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-symlink-store-"));
    const credentialDirectory = join(directory, ".frontier-workspace", "instances", fixtureKey);
    const target = join(directory, "not-a-credential.json");
    await mkdir(credentialDirectory, { mode: 0o700, recursive:true });
    await writeFile(target, JSON.stringify({ refresh_token: "do-not-read" }), { mode: 0o600 });
    await symlink(target, join(credentialDirectory, "credentials.json"));
    const store = createCredentialStore({ env: { ...fixtureEnv }, home: directory, platform: "darwin" });
    await assert.rejects(store.load(), /not a regular file/);
  });

  it("uses a private file on Windows and rejects unavailable platform credential stores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-windows-file-store-"));
    const credential = { auth_url:fixtureInstallation.authUrl, resource_url:fixtureInstallation.mcpUrl, access_token: "access", refresh_token: "refresh" };
    const windowsStore = createCredentialStore({
      env: { ...fixtureEnv, APPDATA: directory },
      home: directory,
      platform: "win32"
    });
    assert.equal(windowsStore.kind, "private-file");
    await windowsStore.save(credential);
    assert.deepEqual(await windowsStore.load(), credential);
    const credentialPath = windowsStore.filePath;
    assert.equal((await lstat(credentialPath)).isFile(), true);
    await chmod(credentialPath, 0o644);
    await windowsStore.load();
    assert.equal((await lstat(credentialPath)).mode & 0o777, 0o644);
    assert.throws(() => createCredentialStore({
      env: { ...fixtureEnv, WORKSPACE_CREDENTIAL_STORE: "keychain" },
      home: "/Users/tester",
      platform: "darwin"
    }), /not supported by Workspace CLI/);
    assert.throws(() => createCredentialStore({
      env: { ...fixtureEnv, WORKSPACE_CREDENTIAL_STORE: "dpapi" },
      home: "C:\\Users\\tester",
      platform: "win32"
    }), /not supported by Workspace CLI/);
  });

  it("rejects a loopback callback whose OAuth state does not match", async () => {
    const receiver = await createLoopbackReceiver({ expectedState: "expected-state", timeoutMs: 2_000 });
    const rejected = assert.rejects(receiver.waitForCallback(), /state did not match/);
    const callback = new URL(receiver.redirectUri);
    callback.searchParams.set("code", "intercepted-code");
    callback.searchParams.set("state", "wrong-state");
    const response = await fetch(callback);
    await rejected;
    assert.equal(response.status, 400);
    await receiver.close();
  });

  it("proxies stdio JSON-RPC to the hosted MCP endpoint", async () => {
    const store = memoryStore({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600_000, authorization_method: "authorization_code_pkce" });
    const output = collector();
    let authorization;
    await runMcpProxy(store, {
      input: Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`]),
      output: output.stream,
      fetchImpl: async (_url, init) => {
        authorization = init.headers.Authorization;
        return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } }, { headers: { "mcp-session-id": "session-1" } });
      }
    });
    assert.equal(authorization, "Bearer access");
    const listed = JSON.parse(output.value());
    assert.equal(listed.id, 1);
    assert.deepEqual(listed.result.tools, []);
  });

  it("calls hosted MCP tools as a one-shot Agent-neutral CLI command", async () => {
    const store = memoryStore({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600_000, authorization_method: "authorization_code_pkce" });
    const output = collector();
    let request;
    await runCli(["mcp", "call", "apps_get_app", "--args", '{"appId":"app-1"}'], {
      fetchImpl: async (url, init) => {
        request = { body: JSON.parse(init.body), headers: new Headers(init.headers), url: String(url) };
        return Response.json({ jsonrpc: "2.0", id: request.body.id, result: { app: { id: "app-1" } } });
      },
      stdout: output.stream,
      stderr: collector().stream,
      store,
      throwOnError: true
    });

    assert.equal(request.url, "https://mcp.example.invalid/mcp");
    assert.equal(request.headers.get("authorization"), "Bearer access");
    assert.equal(request.body.method, "tools/call");
    assert.deepEqual(request.body.params, { name: "apps_get_app", arguments: { appId: "app-1" } });
    assert.deepEqual(JSON.parse(output.value()), { app: { id: "app-1" } });
  });

  it("builds deterministic source ZIPs and applies secure default and .appsignore rules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-source-snapshot-"));
    await mkdir(join(directory, "src"), { recursive: true });
    await mkdir(join(directory, ".build"), { recursive: true });
    await mkdir(join(directory, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(directory, "src", "index.js"), "export default 1;\n");
    await writeFile(join(directory, "README.md"), "hello\n");
    await writeFile(join(directory, ".env"), "SECRET=never-upload\n");
    await writeFile(join(directory, ".env.example"), "SECRET=example\n");
    await writeFile(join(directory, "ignored.txt"), "ignored\n");
    await writeFile(join(directory, ".build", "generated-helper"), "ignored build output\n");
    await writeFile(join(directory, "node_modules", "dependency", "index.js"), "ignored dependency\n");
    await writeFile(join(directory, ".appsignore"), "ignored.txt\n");
    await symlink(join(directory, "README.md"), join(directory, "linked-readme"));

    const first = await createSourceSnapshot(directory);
    const second = await createSourceSnapshot(directory);
    const files = unzipSync(first.archive);
    const manifest = JSON.parse(strFromU8(files[".workspace-snapshot/manifest.json"]));

    assert.equal(first.archiveSha256, second.archiveSha256);
    assert.equal(first.contentSha256, second.contentSha256);
    assert.equal(first.skippedSymlinkCount, 1);
    assert.ok(files["src/index.js"]);
    assert.ok(files["README.md"]);
    assert.ok(files[".env.example"]);
    assert.equal(files[".env"], undefined);
    assert.equal(files["ignored.txt"], undefined);
    assert.equal(files[".build/generated-helper"], undefined);
    assert.equal(files["node_modules/dependency/index.js"], undefined);
    assert.equal(files["linked-readme"], undefined);
    assert.equal(manifest.contentSha256, first.contentSha256);
    assert.equal(manifest.fileCount, first.fileCount);
  });

  it("uploads a source snapshot over the authenticated HTTP data path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-source-upload-"));
    await writeFile(join(directory, "index.js"), "export default 1;\n");
    const store = memoryStore({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600_000, authorization_method: "authorization_code_pkce" });
    const output = collector();
    let upload;
    await runCli(["apps", "snapshot", "upload", "--app", "app-1", "--source", directory, "--version", "1.0.0", "--name", "First backup", "--notes", "Before refactor"], {
      apiUrl: "https://mcp.example.invalid",
      fetchImpl: async (url, init) => {
        upload = { body: new Uint8Array(init.body), headers: new Headers(init.headers), url: String(url) };
        return Response.json({ deduplicated: false, sourceSnapshot: { id: "snap-1" } }, { status: 201 });
      },
      stdout: output.stream,
      stderr: collector().stream,
      store,
      throwOnError: true
    });

    assert.equal(upload.url, "https://mcp.example.invalid/api/apps/apps/app-1/source-snapshots?version=1.0.0");
    assert.equal(upload.headers.get("authorization"), "Bearer access");
    assert.equal(upload.headers.get("content-type"), "application/zip");
    assert.equal(Number(upload.headers.get("content-length")), upload.body.byteLength);
    assert.match(upload.headers.get("x-workspace-source-archive-sha256"), /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(Buffer.from(upload.headers.get("x-workspace-source-metadata"), "base64url").toString("utf8")), {
      notes: "Before refactor",
      purpose: "backup",
      version: "1.0.0",
      versionName: "First backup"
    });
    assert.equal(upload.body[0], 0x50);
    assert.equal(upload.body[1], 0x4b);
    assert.equal(JSON.parse(output.value()).sourceSnapshot.id, "snap-1");
  });

  it("builds deterministic deployment ZIPs with binary files and deploy-only exclusions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-deploy-artifact-"));
    await mkdir(join(directory, "node_modules", "dependency"), { recursive: true });
    await writeFile(join(directory, "index.html"), "<!doctype html><h1>Hello</h1>\n");
    await writeFile(join(directory, "logo.png"), Uint8Array.from([0, 1, 2, 3, 254, 255]));
    await writeFile(join(directory, ".env"), "SECRET=never-upload\n");
    await writeFile(join(directory, "ignored.map"), "{}\n");
    await writeFile(join(directory, ".appsdeployignore"), "ignored.map\n");
    await writeFile(join(directory, "node_modules", "dependency", "index.js"), "ignored\n");

    const first = await createDeploymentArtifact(directory, { target: "pages", entrypoint: "index.html" });
    const second = await createDeploymentArtifact(directory, { target: "pages", entrypoint: "index.html" });
    const entries = unzipSync(first.archive);
    const manifest = JSON.parse(strFromU8(entries[".workspace-deploy/manifest.json"]));

    assert.equal(first.archiveSha256, second.archiveSha256);
    assert.equal(first.contentSha256, second.contentSha256);
    assert.deepEqual(entries["logo.png"], Uint8Array.from([0, 1, 2, 3, 254, 255]));
    assert.equal(entries[".env"], undefined);
    assert.equal(entries["ignored.map"], undefined);
    assert.equal(entries["node_modules/dependency/index.js"], undefined);
    assert.equal(manifest.target, "pages");
    assert.equal(manifest.entrypoint, "index.html");
    assert.equal(manifest.files.find((file) => file.path === "logo.png").contentType, "image/png");
  });

  it("packages Worker Static Assets with an explicit binding and routing contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-worker-assets-"));
    const workerDirectory = join(directory, "worker");
    const assetsDirectory = join(directory, "assets");
    await mkdir(workerDirectory, { recursive: true });
    await mkdir(assetsDirectory, { recursive: true });
    await writeFile(join(workerDirectory, "index.js"), "export default { fetch() {} };\n");
    await writeFile(join(assetsDirectory, "index.html"), "<!doctype html><main>Academy</main>\n");
    await writeFile(join(assetsDirectory, "app.js"), "console.log('academy');\n");

    const artifact = await createDeploymentArtifact(workerDirectory, {
      target: "worker",
      entrypoint: "index.js",
      assets: {
        sourceDirectory: assetsDirectory,
        binding: "ASSETS",
        notFoundHandling: "single-page-application",
        runWorkerFirst: true
      }
    });
    const entries = unzipSync(artifact.archive);
    const manifest = JSON.parse(strFromU8(entries[".workspace-deploy/manifest.json"]));

    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.assets, {
      binding: "ASSETS",
      directory: ".workspace-assets",
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "single-page-application",
      runWorkerFirst: true
    });
    assert.ok(entries[".workspace-assets/index.html"]);
    assert.ok(entries[".workspace-assets/app.js"]);
    assert.deepEqual(deploymentArtifactSummary(artifact).fileBreakdown, {
      staticAssets: 2,
      workerModules: 1
    });
    assert.equal(deploymentArtifactSummary(artifact).schemaVersion, 2);
  });

  it("fails early when Worker browser assets bypass --assets-dir", async () => {
    const manualDirectory = await mkdtemp(join(tmpdir(), "workspace-worker-manual-assets-"));
    await mkdir(join(manualDirectory, ".workspace-assets"), { recursive: true });
    await writeFile(join(manualDirectory, "index.js"), "export default { fetch() {} };\n");
    await writeFile(join(manualDirectory, ".workspace-assets", "index.html"), "<!doctype html>\n");
    await assert.rejects(
      () => createDeploymentArtifact(manualDirectory, { target: "worker", entrypoint: "index.js" }),
      /reserved path '\.workspace-assets'/
    );

    const rootDirectory = await mkdtemp(join(tmpdir(), "workspace-worker-root-assets-"));
    await writeFile(join(rootDirectory, "index.js"), "export default { fetch() {} };\n");
    await writeFile(join(rootDirectory, "index.html"), "<!doctype html>\n");
    await assert.rejects(
      () => createDeploymentArtifact(rootDirectory, { target: "worker", entrypoint: "index.js" }),
      /contains browser entry file 'index.html'/
    );

    const overlappingDirectory = await mkdtemp(join(tmpdir(), "workspace-worker-overlapping-assets-"));
    const nestedAssetsDirectory = join(overlappingDirectory, "public");
    await mkdir(nestedAssetsDirectory, { recursive: true });
    await writeFile(join(overlappingDirectory, "index.js"), "export default { fetch() {} };\n");
    await writeFile(join(nestedAssetsDirectory, "index.html"), "<!doctype html>\n");
    await assert.rejects(
      () => createDeploymentArtifact(overlappingDirectory, {
        target: "worker",
        entrypoint: "index.js",
        assets: { sourceDirectory: nestedAssetsDirectory }
      }),
      /must be separate, non-overlapping directories/
    );
  });

  it("rejects Worker asset options without --assets-dir", async () => {
    await assert.rejects(
      () => runCli(["apps", "deploy", "--app", "app-1", "--assets-binding", "ASSETS"], {
        stdout: collector().stream,
        stderr: collector().stream,
        store: memoryStore(),
        throwOnError: true
      }),
      /require --assets-dir <directory>/
    );
  });

  it("composes source backup, deployment artifact upload, and a ready MCP deployment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-local-deploy-"));
    const deployDirectory = join(directory, "dist");
    await mkdir(deployDirectory, { recursive: true });
    await writeFile(join(directory, "package.json"), '{"name":"fixture"}\n');
    await writeFile(join(directory, "generated.tmp"), "excluded from the source snapshot\n");
    await writeFile(join(deployDirectory, "index.html"), "<!doctype html><h1>Ready</h1>\n");
    await writeFile(join(deployDirectory, "logo.png"), Uint8Array.from([137, 80, 78, 71]));
    const store = memoryStore({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600_000, authorization_method: "authorization_code_pkce" });
    const output = collector();
    const requests = [];

    await runCli([
      "apps", "deploy", "--app", "app-1", "--source", directory,
      "--deploy-dir", deployDirectory, "--target", "pages", "--version", "2.0.0",
      "--name", "Navigation refresh", "--notes", "Adds the new navigation",
      "--login-required", "yes",
      "--source-exclude", "node_modules/", "--source-exclude=generated.tmp"
    ], {
      apiUrl: "https://mcp.example.invalid",
      mcpUrl: "https://mcp.example.invalid/mcp",
      fetchImpl: async (url, init = {}) => {
        const target = String(url);
        const headers = new Headers(init.headers);
        if (target.includes("/source-snapshots")) {
          requests.push({ kind: "source", body: new Uint8Array(init.body), headers, target });
          return Response.json({ sourceSnapshot: { id: "snap-2" } }, { status: 201 });
        }
        if (target.includes("/deploy-artifacts")) {
          requests.push({ kind: "artifact", body: new Uint8Array(init.body), headers, target });
          return Response.json({ deployArtifact: { id: "artifact-2" } }, { status: 201 });
        }
        const rpc = JSON.parse(init.body);
        requests.push({ kind: "mcp", rpc, headers, target });
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({
              deployment: { id: "dep-2", status: "ready" },
              sourceVersion: { id: "src-2" }
            }) }]
          }
        });
      },
      stdout: output.stream,
      stderr: collector().stream,
      store,
      throwOnError: true
    });

    assert.deepEqual(requests.map((request) => request.kind), ["source", "artifact", "mcp"]);
    assert.equal(requests[0].headers.get("authorization"), "Bearer access");
    const sourceFiles = unzipSync(requests[0].body);
    assert.equal(sourceFiles["generated.tmp"], undefined);
    assert.equal(requests[1].headers.get("x-workspace-deploy-target"), "pages");
    assert.match(requests[1].headers.get("x-workspace-deploy-archive-sha256"), /^[a-f0-9]{64}$/);
    assert.equal(requests[2].rpc.params.name, "apps_deploy_prepare");
    assert.deepEqual(requests[2].rpc.params.arguments, {
      action: "pages",
      appId: "app-1",
      deployArtifactId: "artifact-2",
      entrypoint: "index.html",
      loginRequired: true,
      releaseNotes: "Adds the new navigation",
      sourceSnapshotId: "snap-2",
      version: "2.0.0",
      versionName: "Navigation refresh"
    });
    assert.equal(requests[2].rpc.params.arguments.files, undefined);
    const result = JSON.parse(output.value());
    assert.equal(result.deployment.id, "dep-2");
    assert.equal(result.deployment.status, "ready");
  });

  it("requires explicit deployment metadata and can deliberately skip source upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-local-deploy-skip-source-"));
    await writeFile(join(directory, "index.js"), "export default { fetch() { return new Response('ok'); } };\n");
    const store = memoryStore({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600_000, authorization_method: "authorization_code_pkce" });
    const requests = [];
    const output = collector();

    await assert.rejects(
      () => runCli([
        "apps", "deploy", "--app", "app-1", "--deploy-dir", directory,
        "--target", "worker", "--version", "2.1.0"
      ], { stderr: collector().stream, store, throwOnError: true }),
      /Missing required option --name/
    );

    await runCli([
      "apps", "deploy", "--app", "app-1", "--deploy-dir", directory,
      "--target", "worker", "--version", "2.1.0", "--name", "Runtime only",
      "--notes", "Emergency runtime patch", "--skip-source",
      "--cron", "*/5 * * * *", "--queue-consumer", "QUEUE",
      "--queue-max-batch-size", "10", "--queue-max-batch-timeout", "5",
      "--queue-max-retries", "3"
    ], {
      apiUrl: "https://mcp.example.invalid",
      mcpUrl: "https://mcp.example.invalid/mcp",
      fetchImpl: async (url, init = {}) => {
        const target = String(url);
        if (target.includes("/source-snapshots")) throw new Error("source upload must be skipped");
        if (target.includes("/deploy-artifacts")) {
          requests.push("artifact");
          return Response.json({ deployArtifact: { id: "artifact-skip" } }, { status: 201 });
        }
        const rpc = JSON.parse(init.body);
        requests.push(rpc.params.arguments);
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify({ deployment: { id: "dep-skip", status: "ready" } }) }] } });
      },
      stdout: output.stream,
      stderr: collector().stream,
      store,
      throwOnError: true
    });

    assert.equal(requests[0], "artifact");
    assert.equal(requests[1].sourceSnapshotId, undefined);
    assert.equal(requests[1].version, "2.1.0");
    assert.equal(requests[1].versionName, "Runtime only");
    assert.equal(requests[1].releaseNotes, "Emergency runtime patch");
    assert.deepEqual(requests[1].cronSchedules, ["*/5 * * * *"]);
    assert.deepEqual(requests[1].queueConsumer, {
      bindingName: "QUEUE",
      maxBatchSize: 10,
      maxBatchTimeout: 5,
      maxRetries: 3
    });
    assert.equal(JSON.parse(output.value()).sourceSnapshotSkipped, true);
  });

  it("plans and applies ordered local D1 migrations with content-drift protection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-local-migrations-"));
    await writeFile(join(directory, "001_create.sql"), "CREATE TABLE IF NOT EXISTS request_app_requests (id TEXT PRIMARY KEY);\n");
    await writeFile(join(directory, "002_index.sql"), "CREATE INDEX IF NOT EXISTS request_app_requests_id_idx ON request_app_requests(id);\n");
    const store = memoryStore({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600_000, authorization_method: "authorization_code_pkce" });
    const output = collector();
    const applied = [];
    const fetchImpl = async (_url, init) => {
      const rpc = JSON.parse(init.body);
      const { name, arguments: args } = rpc.params;
      const payload = name === "apps_database" && args.action === "migrations_list"
        ? { migrations: [] }
        : (applied.push(args), { migration: { id: `mig-${applied.length}`, ...args, status: "applied" } });
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
      });
    };

    const planOutput = collector();
    await runCli([
      "apps", "d1", "migrate", "plan", "--app", "app-1", "--dir", directory,
      "--table-prefix", "request_app_"
    ], {
      fetchImpl,
      stdout: planOutput.stream,
      stderr: collector().stream,
      store,
      throwOnError: true
    });
    const publicPlan = JSON.parse(planOutput.value());
    assert.equal(publicPlan.summary.pending, 2);
    assert.equal(publicPlan.migrations[0].sql, undefined);

    await runCli([
      "apps", "d1", "migrate", "apply", "--app", "app-1", "--dir", directory,
      "--table-prefix", "request_app_"
    ], {
      fetchImpl,
      stdout: output.stream,
      stderr: collector().stream,
      store,
      throwOnError: true
    });

    assert.deepEqual(applied.map((migration) => migration.fileName), ["001_create.sql", "002_index.sql"]);
    assert.deepEqual(applied.map((migration) => migration.version), ["001_create", "002_index"]);
    assert.ok(applied.every((migration) => /^[a-f0-9]{64}$/.test(migration.contentSha256)));
    assert.equal(JSON.parse(output.value()).appliedCount, 2);

    const driftOutput = collector();
    const driftHash = "0".repeat(64);
    await assert.rejects(
      () => runCli([
        "apps", "d1", "migrate", "apply", "--app", "app-1", "--dir", directory,
        "--table-prefix", "request_app_"
      ], {
        fetchImpl: async (_url, init) => {
          const rpc = JSON.parse(init.body);
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { content: [{ type: "text", text: JSON.stringify({ migrations: [{ version: "001_create", contentSha256: driftHash }] }) }] }
          });
        },
        stdout: driftOutput.stream,
        stderr: collector().stream,
        store,
        throwOnError: true
      }),
      /Migration drift detected: 001_create\.sql/
    );
  });

  it("plans controlled App D1 data impact and requires an explicit apply approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-local-controlled-data-migrations-"));
    await writeFile(join(directory, "001_schema.sql"), "CREATE TABLE IF NOT EXISTS app_records (id TEXT PRIMARY KEY, value TEXT NOT NULL);\n");
    await writeFile(join(directory, "002_seed.sql"), `
      INSERT INTO app_records (id, value) VALUES ('seed', 'one')
      ON CONFLICT(id) DO UPDATE SET value = excluded.value;
      UPDATE app_records SET value = 'two' WHERE id = 'seed';
      DELETE FROM app_records WHERE id = 'obsolete';
    `);
    const store = memoryStore({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600_000, authorization_method: "authorization_code_pkce" });
    const applied = [];
    const fetchImpl = async (_url, init) => {
      const rpc = JSON.parse(init.body);
      const { name, arguments: args } = rpc.params;
      const payload = name === "apps_database" && args.action === "migrations_list"
        ? { migrations: [] }
        : (applied.push(args), { migration: { id: `mig-${applied.length}`, ...args, status: "applied" } });
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
      });
    };

    const planOutput = collector();
    await runCli([
      "apps", "d1", "migrate", "plan", "--app", "app-1", "--dir", directory,
      "--table-prefix", "app_"
    ], { fetchImpl, stdout: planOutput.stream, stderr: collector().stream, store, throwOnError: true });
    const plan = JSON.parse(planOutput.value());
    assert.equal(plan.summary.pendingDataMigrationCount, 1);
    assert.equal(plan.summary.requiresDataMigrationApproval, true);
    assert.deepEqual(plan.summary.dataMutationTypes, ["delete", "insert", "update"]);
    assert.deepEqual(plan.migrations[1].impact.dataTables, ["app_records"]);
    assert.equal(plan.migrations[1].impact.dataStatementCount, 3);

    await assert.rejects(
      () => runCli([
        "apps", "d1", "migrate", "apply", "--app", "app-1", "--dir", directory,
        "--table-prefix", "app_"
      ], { fetchImpl, stdout: collector().stream, stderr: collector().stream, store, throwOnError: true }),
      /require separate approval.*--allow-data-migrations/i
    );
    assert.equal(applied.length, 0);

    const applyOutput = collector();
    await runCli([
      "apps", "d1", "migrate", "apply", "--app", "app-1", "--dir", directory,
      "--table-prefix", "app_", "--allow-data-migrations"
    ], { fetchImpl, stdout: applyOutput.stream, stderr: collector().stream, store, throwOnError: true });
    assert.equal(JSON.parse(applyOutput.value()).appliedCount, 2);
    assert.equal(applied[0].allowDataMigrations, false);
    assert.equal(applied[1].allowDataMigrations, true);
    assert.equal(applied[1].tablePrefix, "app_");
  });

  it("requires a local App prefix for every schema and data migration plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-local-prefix-required-"));
    await writeFile(join(directory, "001_schema.sql"), "CREATE TABLE IF NOT EXISTS app_records (id TEXT PRIMARY KEY);\n");
    let contactedMcp = false;

    await assert.rejects(
      () => runCli(["apps", "d1", "migrate", "plan", "--app", "app-1", "--dir", directory], {
        fetchImpl: async () => {
          contactedMcp = true;
          throw new Error("MCP should not be contacted");
        },
        stdout: collector().stream,
        stderr: collector().stream,
        store: memoryStore(),
        throwOnError: true
      }),
      /requires --table-prefix/
    );
    assert.equal(contactedMcp, false);
  });

  it("rejects non-App schema objects and references locally before contacting MCP", async () => {
    for (const [fileName, sql] of [
      ["001_table.sql", "CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY);\n"],
      ["001_index_name.sql", "CREATE INDEX IF NOT EXISTS records_idx ON app_records(id);\n"],
      ["001_index_table.sql", "CREATE INDEX IF NOT EXISTS app_records_idx ON records(id);\n"],
      ["001_alter.sql", "ALTER TABLE records ADD COLUMN value TEXT;\n"],
      ["001_reference.sql", "CREATE TABLE IF NOT EXISTS app_children (parent_id TEXT REFERENCES parents(id));\n"]
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "workspace-local-owned-schema-"));
      await writeFile(join(directory, fileName), sql);
      let contactedMcp = false;

      await assert.rejects(
        () => runCli([
          "apps", "d1", "migrate", "plan", "--app", "app-1", "--dir", directory,
          "--table-prefix", "app_"
        ], {
          fetchImpl: async () => {
            contactedMcp = true;
            throw new Error("MCP should not be contacted");
          },
          stdout: collector().stream,
          stderr: collector().stream,
          store: memoryStore(),
          throwOnError: true
        }),
        /outside App prefix app_/
      );
      assert.equal(contactedMcp, false);
    }
  });

  it("uses SQL tokens instead of keywords inside migration literals or comments", () => {
    const impact = analyzeAppsMigrationSql(`
      CREATE TABLE IF NOT EXISTS app_notes (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO app_notes (id, value) VALUES ('one', 'SELECT FROM DROP; WHERE -- text');
      UPDATE app_notes SET value = '/* WHERE */ SELECT' WHERE id = 'one';
    `, "tokens.sql", { tablePrefix: "app_" });

    assert.equal(impact.schemaStatementCount, 1);
    assert.equal(impact.dataStatementCount, 2);
    assert.deepEqual(impact.statementTypes, ["create_table", "insert", "update"]);
  });

  it("rejects unsafe App D1 data statements locally before contacting MCP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-local-migration-preflight-"));
    await writeFile(join(directory, "001_schema.sql"), "CREATE TABLE IF NOT EXISTS app_records (id TEXT PRIMARY KEY);\n");
    await writeFile(join(directory, "002_seed.sql"), "UPDATE app_records SET id = 'seed' /* WHERE id = 'target' */;\n");
    let contactedMcp = false;

    await assert.rejects(
      () => runCli(["apps", "d1", "migrate", "plan", "--app", "app-1", "--dir", directory, "--table-prefix", "app_"], {
        fetchImpl: async () => {
          contactedMcp = true;
          throw new Error("MCP should not be contacted");
        },
        stdout: collector().stream,
        stderr: collector().stream,
        store: memoryStore(),
        throwOnError: true
      }),
      /002_seed\.sql at statement 1 \(UPDATE\).*must include WHERE/
    );
    assert.equal(contactedMcp, false);
  });

  it("rejects system and non-App data tables locally before contacting MCP", async () => {
    for (const [fileName, sql, expected] of [
      ["001_system.sql", "INSERT INTO sqlite_shadow (id) VALUES ('seed');\n", /reserved_migration_identifier/],
      ["001_outside.sql", "DELETE FROM other_records WHERE id = 'seed';\n", /outside App prefix app_/],
      ["001_qualified.sql", "INSERT INTO app_remote.app_records (id) VALUES ('seed');\n", /qualified table names/]
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "workspace-local-owned-data-migrations-"));
      await writeFile(join(directory, fileName), sql);
      let contactedMcp = false;

      await assert.rejects(
        () => runCli([
          "apps", "d1", "migrate", "plan", "--app", "app-1", "--dir", directory,
          "--table-prefix", "app_"
        ], {
          fetchImpl: async () => {
            contactedMcp = true;
            throw new Error("MCP should not be contacted");
          },
          stdout: collector().stream,
          stderr: collector().stream,
          store: memoryStore(),
          throwOnError: true
        }),
        expected
      );
      assert.equal(contactedMcp, false);
    }
  });

  it("installs an idempotent WorkBuddy MCP entry without replacing other servers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-workbuddy-install-"));
    const configPath = join(directory, "mcp.json");
    await writeFile(configPath, `${JSON.stringify({ mcpServers: { existing: { command: "existing-server" }, "workspace-ai": { command: "legacy-server" } }, custom: true }, null, 2)}\n`);
    const store = memoryStore({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600_000, authorization_method: "authorization_code_pkce" });
    const firstOutput = collector();
    const installOptions = {
      configPath,
      home: directory,
      npxCommand: process.execPath,
      platform: "darwin",
      stderr: collector().stream,
      store,
      throwOnError: true
    };
    await runCli(["workbuddy", "install", "--open-browser=never", "--output=jsonl"], { ...installOptions, stdout: firstOutput.stream });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.custom, true);
    assert.equal(config.mcpServers.existing.command, "existing-server");
    assert.equal(config.mcpServers["workspace-ai"].command, "legacy-server");
    assert.equal(config.mcpServers[fixtureServer].command, process.execPath);
    assert.deepEqual(config.mcpServers[fixtureServer].args, [fileURLToPath(new URL("../bin/frontier-workspace.mjs",import.meta.url)), "mcp", "serve"]);
    assert.equal(config.mcpServers[fixtureServer].env.WORKSPACE_CREDENTIAL_STORE, "file");
    assert.equal(config.mcpServers[fixtureServer].env.WORKSPACE_CREDENTIAL_PATH, join(directory, ".frontier-workspace", "instances", fixtureKey, "credentials.json"));
    assert.equal(config.mcpServers[fixtureServer].env.WORKSPACE_REFRESH_LOCK_PATH, join(directory, ".frontier-workspace", "instances", fixtureKey, "oauth-refresh.lock"));
    assert.equal(config.mcpServers[fixtureServer].env.WORKSPACE_AUTH_URL,fixtureInstallation.authUrl);
    assert.equal(JSON.parse(firstOutput.value()).changed, true);

    const secondOutput = collector();
    await runCli(["workbuddy", "install", "--open-browser=never", "--output=jsonl"], { ...installOptions, stdout: secondOutput.stream });
    assert.equal(JSON.parse(secondOutput.value()).changed, false);
  });

  it("installs Cursor once through CLI and preserves unrelated MCP servers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-cursor-install-"));
    const configPath = join(directory, "mcp.json");
    await writeFile(configPath, `${JSON.stringify({ mcpServers: { existing: { command: "existing-server" } }, custom: true }, null, 2)}\n`);
    const store = memoryStore({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600_000, authorization_method: "authorization_code_pkce" });
    const output = collector();

    await runCli(["agent", "install", "--agent=cursor", "--open-browser=never", "--output=jsonl"], {
      configPath,
      home: directory,
      npxCommand: process.execPath,
      platform: "darwin",
      stderr: collector().stream,
      stdout: output.stream,
      store,
      throwOnError: true
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.custom, true);
    assert.equal(config.mcpServers.existing.command, "existing-server");
    assert.equal(config.mcpServers[fixtureServer].command, process.execPath);
    assert.deepEqual(config.mcpServers[fixtureServer].args, [fileURLToPath(new URL("../bin/frontier-workspace.mjs",import.meta.url)), "mcp", "serve"]);
    assert.equal(config.mcpServers[fixtureServer].env.WORKSPACE_CREDENTIAL_STORE, "file");
    assert.equal(config.mcpServers[fixtureServer].type, undefined);
    assert.deepEqual(JSON.parse(output.value()), {
      type: "agent_installation_complete",
      agent: "cursor",
      installed: true,
      changed: true,
      server_name: fixtureServer,
      package: "@frontier-workspace/cli@0.1.0",
      config_path: configPath,
      trust_required: false,
      next_action: "Restart Cursor or start a new Agent session, then call ping_who_am_i.",
      authorization_reused: true
    });
  });

  it("configures Codex and Claude Code through their CLIs while reusing one OAuth credential", async () => {
    const store = memoryStore({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 600_000, authorization_method: "authorization_code_pkce" });
    const commands = [];
    const runCommand = async (command, args) => {
      commands.push({ command, args });
      if (args[1] === "remove") return {
        exitCode: 1,
        stderr: command === "claude" ? "No user-scoped MCP server found with name: workspace-ai" : "No MCP server found with name: workspace-ai"
      };
      return { exitCode: 0 };
    };

    for (const agent of ["codex", "claude-code"]) {
      const output = collector();
      await runCli(["agent", "install", `--agent=${agent}`, "--open-browser=never", "--output=jsonl"], {
        home: "/home/tester",
        npxCommand: "/usr/local/bin/npx",
        platform: "linux",
        runCommand,
        stderr: collector().stream,
        stdout: output.stream,
        store,
        throwOnError: true
      });
      const result = JSON.parse(output.value());
      assert.equal(result.agent, agent);
      assert.equal(result.installed, true);
      assert.equal(result.authorization_reused, true);
    }

    assert.deepEqual(commands.map(({ command, args }) => [command, args.slice(0, 2)]), [
      ["codex", ["mcp", "remove"]],
      ["codex", ["mcp", "add"]],
      ["claude", ["mcp", "remove"]],
      ["claude", ["mcp", "add"]]
    ]);
    for (const { args } of commands.filter(({ args }) => args[1] === "add")) {
      assert.ok(args.includes(fixtureServer));
      assert.ok(args.includes(fileURLToPath(new URL("../bin/frontier-workspace.mjs",import.meta.url))));
      assert.ok(args.includes("serve"));
      assert.equal(args.some((value) => String(value).startsWith("http")), false);
    }
    const claudeAdd = commands.find(({ command, args }) => command === "claude" && args[1] === "add");
    assert.ok(claudeAdd.args.indexOf(fixtureServer) < claudeAdd.args.indexOf("-e"));
  });

  it("writes explicit Windows file storage while leaving command selection unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-workbuddy-windows-install-"));
    const configPath = join(directory, "mcp.json");
    const appData = join(directory, "AppData", "Roaming");

    await installWorkBuddyMcp({
      configPath,
      env: { ...fixtureEnv, APPDATA: appData, Path: "C:\\Program Files\\nodejs;C:\\Windows\\System32" },
      home: "C:\\Users\\tester",
      packageVersion: "0.4.2",
      platform: "win32"
    });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.mcpServers[fixtureServer].command, process.execPath);
    assert.equal(config.mcpServers[fixtureServer].env.WORKSPACE_CREDENTIAL_STORE, "file");
    assert.equal(config.mcpServers[fixtureServer].env.WORKSPACE_CREDENTIAL_PATH, join(appData, "Frontier Workspace", "instances", fixtureKey, "credentials.json"));
    assert.equal(config.mcpServers[fixtureServer].env.WORKSPACE_REFRESH_LOCK_PATH, join(appData, "Frontier Workspace", "instances", fixtureKey, "oauth-refresh.lock"));
    assert.equal(config.mcpServers[fixtureServer].env.WORKSPACE_MCP_URL,fixtureInstallation.mcpUrl);
  });
});
