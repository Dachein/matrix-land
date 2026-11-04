import { testInstallation } from "../../../tests/helpers/installation.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from "miniflare";

async function load(path) {
  const result = await build({ entryPoints: [path], bundle: true, write: false, format: "esm", platform: "neutral" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const worker = await load("workers/stream/src/index.ts");
const provisioning = await load("workers/apps/src/provisioning/cloudflareResources.ts");
const secrets = await load("workers/apps/src/apps/appAuthSecrets.ts");

class D1 {
  constructor(database) { this.database = database; }
  prepare(sql) {
    const statement = this.database.prepare(sql);
    function bound(values = []) {
      return { bind: (...params) => bound(params), first: async () => statement.get(...values) ?? null,
        all: async () => ({ results: statement.all(...values) }), run: async () => ({ success: true, meta: statement.run(...values) }) };
    }
    return bound();
  }
  async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }
}
function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/apps/db/schema.sql", "utf8"));
  const calls = [];
  const env = { ...testInstallation, APPS_DB: new D1(database), CF_ACCOUNT_ID: "account-1", CF_STREAM_API_TOKEN: "platform-only-secret",
    APPS_SECRET_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    STREAM: {
      async createDirectUpload(options) {
        calls.push({ type: "create", options });
        // Enforce the provider's native POST constraint, not just our own types.
        if (Date.parse(options.expiry) >= Date.now() + 6 * 60 * 60 * 1000) {
          throw new Error("BadRequestError: expiry must be less than 6h0m0s in the future.");
        }
        return { id: `uid${calls.length}`, uploadURL: "https://upload.videodelivery.net/temporary" };
      },
      video(uid) { return {
        async details() { calls.push({ type: "details", uid }); return { readyToStream: true, duration: 12, hlsPlaybackUrl: `https://customer-test.cloudflarestream.com/${uid}/manifest/video.m3u8` }; },
        async generateToken() { calls.push({ type: "token", uid }); return "signed-playback-token"; },
        async delete() { calls.push({ type: "delete", uid }); },
      }; },
    },
  };
  env.WORKSPACE_STREAM = { fetch: request => worker.handleStreamRequest(request, env) };
  async function app(id, org = "org-1") {
    database.prepare(`INSERT INTO apps_apps (id,org_id,org_slug,owner_user_id,name,code,slug,type,status,visibility,data_service_id,created_at,updated_at)
      VALUES (?,?,?,'owner',?,?,?,'container','published','org',?,'2026-10-27','2026-10-27')`)
      .run(id, org, org, id, id, id, `ds-${id}`);
    database.prepare(`INSERT INTO apps_app_resources (id,app_id,data_service_id,type,provider,resource_name,binding_name,environment,status,created_at)
      VALUES (?,?,?,'media','cloudflare-stream',?,'STREAM','prod','queued','2026-10-27')`).run(`res-${id}`, id, `ds-${id}`, id);
    database.prepare(`INSERT INTO apps_domains (id,app_id,environment,type,hostname,status,created_at) VALUES (?,?,'production','production',?,'active','2026-10-27')`)
      .run(`domain-${id}`, id, `${id}.example.test`);
    const row = database.prepare("SELECT * FROM apps_apps WHERE id = ?").get(id);
    await provisioning.provisionResourceTypes(env, row, ["media"], new Date().toISOString());
    const token = await secrets.ensureManagedAppSecret(env, row, { name: "WORKSPACE_STREAM_TOKEN", description: "Stream" });
    return { row, token };
  }
  async function request(token, path, method = "GET", body) {
    return worker.handleStreamRequest(new Request(`https://workspace-stream.internal${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  }
  return { env, database, calls, app, request };
}
const input = { objectId: "course-1", userId: "employee-1", fileName: "视频.mp4", mimeType: "video/mp4", sizeBytes: 100 };
function decodeTusMetadata(header) {
  return Object.fromEntries(header.split(",").map(entry => {
    const [key, value = ""] = entry.split(" ");
    return [key, Buffer.from(value, "base64").toString("utf8")];
  }));
}

test("opening Stream creates a stable App-scoped grant; upstream credentials stay platform-only", async t => {
  const f = fixture(); t.after(() => f.database.close());
  const a = await f.app("app-a");
  const b = await f.app("app-b");
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^fstream_[a-f0-9]{64}$/);
  await provisioning.provisionResourceTypes(f.env, a.row, ["media"], new Date().toISOString());
  assert.equal(await secrets.ensureManagedAppSecret(f.env, a.row, { name: "WORKSPACE_STREAM_TOKEN", description: "Stream" }), a.token);
  const resource = f.database.prepare("SELECT * FROM apps_app_resources WHERE app_id='app-a'").get();
  assert.equal(resource.provider, "workspace-stream"); assert.equal(resource.binding_name, "WORKSPACE_STREAM");
  assert.equal(resource.resource_id, "example-prod-stream:app-a"); assert.equal(resource.status, "ready");
  assert.equal(f.database.prepare("SELECT count(*) n FROM apps_app_secrets WHERE name LIKE '%CLOUDFLARE%' OR name LIKE 'CF_%'").get().n, 0);
  const grant = f.database.prepare("SELECT * FROM apps_stream_app_grants WHERE app_id='app-a'").get();
  assert.equal(grant.token_sha256, await worker.tokenHash(a.token)); assert.ok(!JSON.stringify(grant).includes(a.token));
});

test("upload scope and origin come from the grant; App B cannot read, play or delete App A videos", async t => {
  const f = fixture(); t.after(() => f.database.close());
  const a = await f.app("app-a"); const b = await f.app("app-b"); const c = await f.app("app-c", "org-2");
  const response = await f.request(a.token, "/v1/uploads", "POST", { ...input, appId: "app-b", allowedOrigins: ["evil.test"] });
  assert.equal(response.status, 201); const upload = await response.json();
  assert.equal(upload.protocol, "post"); assert.equal(upload.provider, "media");
  assert.equal(f.calls[0].options.meta.workspaceAppId, "app-a"); assert.equal(f.calls[0].options.creator, "app-a");
  assert.equal(f.calls[0].options.maxDurationSeconds, 36_000);
  assert.deepEqual(f.calls[0].options.allowedOrigins, ["app-a.example.test"]); assert.equal(f.calls[0].options.requireSignedURLs, true);
  for (const [path, method] of [[`/v1/videos/${upload.streamUid}`, "GET"], [`/v1/videos/${upload.streamUid}/playback`, "POST"], [`/v1/videos/${upload.streamUid}`, "DELETE"]]) {
    for (const other of [b, c]) assert.equal((await f.request(other.token, path, method)).status, 404);
  }
  assert.equal(f.calls.length, 1, "cross-App calls must not reach Cloudflare");
  assert.deepEqual((await (await f.request(b.token, "/v1/videos")).json()).videos, []);
  const playback = await (await f.request(a.token, `/v1/videos/${upload.streamUid}/playback`, "POST", {})).json();
  assert.equal(playback.playbackUrl, "https://customer-test.cloudflarestream.com/signed-playback-token/iframe");
  assert.equal((await f.request(a.token, `/v1/videos/${upload.streamUid}`, "DELETE")).status, 200);
  assert.equal((await f.request(a.token, `/v1/videos/${upload.streamUid}`)).status, 404);
});

test("POST reservations stay below the native six-hour expiry limit and reuse the stored deadline", async t => {
  const f = fixture(); t.after(() => f.database.close()); const a = await f.app("app-a");
  for (const sizeBytes of [336_418, 200_000_000]) {
    const body = { ...input, objectId: `post-${sizeBytes}`, sizeBytes };
    const before = Date.now();
    const response = await f.request(a.token, "/v1/uploads", "POST", body);
    assert.equal(response.status, 201, await response.clone().text());
    const upload = await response.json();
    assert.equal(upload.protocol, "post");
    const expiry = Date.parse(upload.expiresAt);
    assert.ok(expiry >= before + 60 * 60 * 1000 && expiry <= Date.now() + 60 * 60 * 1000);
    const row = f.database.prepare("SELECT * FROM apps_stream_videos WHERE object_id = ?").get(body.objectId);
    assert.equal(row.state, "uploading");
    assert.equal(row.expires_at, upload.expiresAt);
    assert.equal(f.calls.at(-1).options.expiry, upload.expiresAt);
    assert.equal(row.stream_uid, upload.streamUid);
    assert.deepEqual(await (await f.request(a.token, "/v1/uploads", "POST", body)).json(), upload);
    f.database.prepare("UPDATE apps_stream_videos SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), row.id);
    assert.equal((await f.request(a.token, "/v1/uploads", "POST", body)).status, 409);
  }
  assert.equal(f.calls.length, 2, "retries and expiry must not allocate another upstream video");
});

test("TUS grants encode the App hostname as plain metadata and preserve the resumable deadline", async t => {
  const f = fixture(); t.after(() => f.database.close()); const a = await f.app("app-a");
  const upstream = []; const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { upstream.push({ url, init }); return new Response(null, {
    status: 201, headers: { Location: "https://upload.videodelivery.net/tus-temporary", "stream-media-id": "largeuid" },
  }); }; t.after(() => { globalThis.fetch = original; });
  const large = { ...input, sizeBytes: 200_000_001, allowedOrigins: ["evil.test"] };
  const before = Date.now();
  const one = await (await f.request(a.token, "/v1/uploads", "POST", large)).json();
  const two = await (await f.request(a.token, "/v1/uploads", "POST", large)).json();
  assert.deepEqual(one, two); assert.equal(one.protocol, "tus"); assert.equal(upstream.length, 1);
  assert.equal(upstream[0].init.body, undefined, "video bytes must not pass through this Worker");
  assert.equal(upstream[0].init.headers.Authorization, "Bearer platform-only-secret");
  assert.equal(upstream[0].init.headers["Upload-Creator"], "app-a");
  assert.match(upstream[0].init.headers["Upload-Metadata"], /workspaceAppId /);
  assert.match(upstream[0].init.headers["Upload-Metadata"], /requiresignedurls/);
  assert.match(upstream[0].init.headers["Upload-Metadata"], /(?:^|,)maxDurationSeconds MzYwMDA=(?:,|$)/);
  const metadata = decodeTusMetadata(upstream[0].init.headers["Upload-Metadata"]);
  assert.equal(metadata.allowedorigins, "app-a.example.test");
  // Stream splits the decoded string into hostnames; JSON quotes/brackets become literal domain characters.
  assert.deepEqual(metadata.allowedorigins.split(","), ["app-a.example.test"]);
  assert.equal(metadata.requiresignedurls, "");
  assert.equal(metadata.name, input.fileName);
  assert.equal(metadata.expiry, one.expiresAt);
  assert.ok(Date.parse(one.expiresAt) >= before + 24 * 60 * 60 * 1000);
  assert.ok(Date.parse(one.expiresAt) <= Date.now() + 24 * 60 * 60 * 1000);
  assert.equal(f.database.prepare("SELECT expires_at FROM apps_stream_videos").get().expires_at, one.expiresAt);
  assert.ok(!JSON.stringify(one).includes("platform-only-secret"));
  assert.equal((await f.request(a.token, "/v1/uploads", "POST", { ...large, sizeBytes: 200_000_002 })).status, 409);
  assert.equal(upstream.length, 1);
});

test("upload durations above Cloudflare's limit are rejected before reserving an object", async t => {
  const f = fixture(); t.after(() => f.database.close()); const a = await f.app("app-a");
  const originalFetch = globalThis.fetch; let tusCalls = 0;
  globalThis.fetch = async () => { tusCalls++; return new Response(null, { status: 400 }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const maxDurationSeconds of [36_001, 43_200]) {
    for (const sizeBytes of [100, 200_000_001]) {
      const response = await f.request(a.token, "/v1/uploads", "POST", { ...input, sizeBytes, maxDurationSeconds });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_upload_parameter" });
    }
  }
  assert.equal(f.database.prepare("SELECT count(*) n FROM apps_stream_videos").get().n, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(tusCalls, 0);
  const allowed = await f.request(a.token, "/v1/uploads", "POST", { ...input, maxDurationSeconds: 36_000 });
  assert.equal(allowed.status, 201);
  assert.equal(f.calls[0].options.maxDurationSeconds, 36_000);
});

test("TUS preparation reaches the upstream in Workers and rejects redirects without following them", async t => {
  const bundle = await build({ entryPoints: ["workers/stream/src/index.ts"],
    bundle: true, write: false, format: "esm", platform: "neutral" });
  const requests = [];
  let redirect = false;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    // The installed workerd supports this date. Unlike Node fetch, Workers only accepts manual/follow redirect modes.
    compatibilityDate: "2026-07-07", d1Databases: ["APPS_DB"],
    bindings: { STREAM: {}, CF_ACCOUNT_ID: "account-1", CF_STREAM_API_TOKEN: "synthetic-stream-credential" },
    outboundService: async request => {
      requests.push(request.url);
      assert.equal(request.url, "https://api.cloudflare.com/client/v4/accounts/account-1/stream?direct_user=true");
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("Authorization"), "Bearer synthetic-stream-credential");
      assert.equal(request.headers.get("Tus-Resumable"), "1.0.0");
      assert.equal(request.headers.get("Upload-Length"), "5747638675");
      assert.match(request.headers.get("Upload-Metadata"), /(?:^|,)maxDurationSeconds MzYwMDA=(?:,|$)/);
      assert.equal(decodeTusMetadata(request.headers.get("Upload-Metadata")).allowedorigins, "app-a.example.test");
      assert.equal(await request.text(), "", "the preparation request must not proxy video bytes");
      return redirect
        ? new RuntimeResponse(null, { status: 307, headers: { Location: "https://unapproved.test/credentials" } })
        : new RuntimeResponse(null, { status: 201,
          headers: { Location: "https://upload.videodelivery.net/tus-temporary", "stream-media-id": "runtimeuid" } });
    },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("APPS_DB");
  const schema = [
    "CREATE TABLE apps_apps (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, status TEXT NOT NULL)",
    "CREATE TABLE apps_app_resources (app_id TEXT, type TEXT, environment TEXT, status TEXT)",
    "CREATE TABLE apps_domains (app_id TEXT, type TEXT, hostname TEXT)",
    ...readFileSync("schemas/apps/0001_initial.sql", "utf8")
      .match(/CREATE TABLE apps_stream_[\s\S]*?;/g),
  ];
  for (const sql of schema) await db.prepare(sql).run();
  const token = `fstream_${"b".repeat(64)}`;
  await db.prepare("INSERT INTO apps_apps VALUES ('app-a', 'org-1', 'published')").run();
  await db.prepare("INSERT INTO apps_app_resources VALUES ('app-a', 'media', 'prod', 'ready')").run();
  await db.prepare("INSERT INTO apps_domains VALUES ('app-a', 'production', 'app-a.example.test')").run();
  await db.prepare("INSERT INTO apps_stream_app_grants VALUES ('app-a', 'org-1', ?, '2026-10-30', '2026-10-30')")
    .bind(await worker.tokenHash(token)).run();
  const request = objectId => mf.dispatchFetch("https://workspace-stream.internal/v1/uploads", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, objectId, sizeBytes: 5_747_638_675 }),
  });
  const response = await request("runtime-success");
  assert.equal(response.status, 201, await response.clone().text());
  const upload = await response.json();
  assert.equal(upload.streamUid, "runtimeuid");
  assert.equal(upload.uploadUrl, "https://upload.videodelivery.net/tus-temporary");
  assert.equal(upload.protocol, "tus");
  assert.equal((await db.prepare("SELECT state FROM apps_stream_videos WHERE object_id = 'runtime-success'").first()).state, "uploading");
  redirect = true;
  const denied = await request("runtime-redirect");
  assert.equal(denied.status, 502);
  assert.deepEqual(await denied.json(), { error: "stream_upload_creation_failed" });
  assert.equal((await db.prepare("SELECT state FROM apps_stream_videos WHERE object_id = 'runtime-redirect'").first()).state, "failed");
  assert.deepEqual(requests, Array(2).fill("https://api.cloudflare.com/client/v4/accounts/account-1/stream?direct_user=true"));
});

test("revocation, archived Apps, unsupported files and absent platform configuration fail closed", async t => {
  const f = fixture(); t.after(() => f.database.close()); const a = await f.app("app-a");
  assert.equal((await f.request("wrong", "/v1/uploads", "POST", input)).status, 401);
  for (const body of [{ ...input, sizeBytes: 0 }, { ...input, sizeBytes: 30_000_000_000 }, { ...input, mimeType: "text/html" }]) {
    assert.equal((await f.request(a.token, "/v1/uploads", "POST", body)).status, 400);
  }
  f.env.CF_STREAM_API_TOKEN = undefined;
  assert.equal((await f.request(a.token, "/v1/uploads", "POST", { ...input, sizeBytes: 200_000_001 })).status, 503);
  assert.equal(f.calls.length, 0);
  const streamWorker = f.env.WORKSPACE_STREAM_WORKER_NAME;
  delete f.env.WORKSPACE_STREAM_WORKER_NAME;
  await assert.rejects(provisioning.provisionResourceTypes(f.env, a.row, ["media"], new Date().toISOString()), /WORKSPACE_STREAM_WORKER_NAME/);
  f.env.WORKSPACE_STREAM_WORKER_NAME = streamWorker;
  await assert.rejects(provisioning.provisionResourceTypes(f.env, a.row, ["media"], new Date().toISOString()), /workspace_stream_service_not_ready/);
  assert.equal(f.database.prepare("SELECT status FROM apps_app_resources WHERE app_id='app-a'").get().status, "failed");
  f.database.prepare("UPDATE apps_app_resources SET status='ready' WHERE app_id='app-a'").run();
  f.database.prepare("UPDATE apps_apps SET status='archived' WHERE id='app-a'").run();
  assert.equal((await f.request(a.token, "/v1/videos")).status, 403);
  f.database.prepare("UPDATE apps_apps SET status='published' WHERE id='app-a'").run();
  f.database.prepare("DELETE FROM apps_stream_app_grants WHERE app_id='app-a'").run();
  assert.equal((await f.request(a.token, "/v1/videos")).status, 403);
});

test("concurrent and failed preparation cannot allocate duplicate upstream videos", async t => {
  const f = fixture(); t.after(() => f.database.close()); const a = await f.app("app-a");
  let release; const hold = new Promise(resolve => { release = resolve; });
  f.env.STREAM.createDirectUpload = async () => { f.calls.push({ type: "create" }); await hold; throw new Error("upstream secret must stay private"); };
  const first = f.request(a.token, "/v1/uploads", "POST", input);
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.request(a.token, "/v1/uploads", "POST", input)).status, 409);
  release(); const response = await first;
  assert.equal(response.status, 502); assert.ok(!(await response.text()).includes("upstream secret"));
  assert.equal((await f.request(a.token, "/v1/uploads", "POST", input)).status, 409);
  assert.equal(f.calls.length, 1);
});

test("enabling Stream updates an existing Worker with an App grant and service binding, removing account-wide access", async t => {
  const f = fixture(); t.after(() => f.database.close()); const a = await f.app("app-a");
  f.database.prepare(`INSERT INTO apps_app_resources (id,app_id,data_service_id,type,provider,resource_name,resource_id,environment,status,created_at)
    VALUES ('worker-a','app-a','ds-app-a','worker','cloudflare-workers','worker-a','worker-a','prod','ready','2026-10-27')`).run();
  f.env.CF_API_TOKEN = "platform-provisioning-secret";
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let bindings;
  globalThis.fetch = async (url, init) => {
    assert.match(url, /workers\/scripts\/worker-a\/settings$/);
    if (!init.method || init.method === "GET") return Response.json({ success: true, result: { bindings: [
      { name: "STREAM", type: "stream" }, { name: "CLOUDFLARE_STREAM_API_TOKEN", type: "secret_text" },
      { name: "BUSINESS_SECRET", type: "secret_text" }, { name: "DB", type: "d1", id: "business-db" },
    ] } });
    assert.equal(init.method, "PATCH");
    bindings = JSON.parse(await init.body.get("settings").text()).bindings;
    return Response.json({ success: true, result: {} });
  };
  const { patchApp } = await load("workers/apps/src/apps/service.ts");
  await patchApp(new Request("https://apps.internal/apps/app-a", { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addResourceTypes: ["media"] }) }), f.env,
    { sub: "owner", orgId: "org-1", orgSlug: "org-1", scopes: ["apps:write"] }, a.row.id);
  assert.deepEqual(bindings.find(b => b.name === "WORKSPACE_STREAM"), { name: "WORKSPACE_STREAM", type: "service", service: "example-prod-stream" });
  assert.equal(bindings.find(b => b.name === "WORKSPACE_STREAM_TOKEN").text, a.token);
  assert.ok(!bindings.some(b => b.type === "stream" || b.name === "CLOUDFLARE_STREAM_API_TOKEN"));
  assert.deepEqual(bindings.find(b => b.name === "BUSINESS_SECRET"), { name: "BUSINESS_SECRET", type: "inherit" });
  assert.equal(bindings.find(b => b.name === "DB").id, "business-db");
});
