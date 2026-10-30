import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql));
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
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
    return { results: this.statement.all(...this.params) };
  }

  async first() {
    return this.statement.get(...this.params) ?? null;
  }

  async run() {
    this.statement.run(...this.params);
    return { success: true };
  }
}

let modulePromise;

async function loadModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-storage-test-"));
  const outfile = join(outdir, "storage.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./storage.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function storageModule() {
  modulePromise ??= loadModule();
  return modulePromise;
}

function createEnv({ kv = true, r2 = true } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/apps/db/schema.sql", "utf8"));
  database.prepare(`
    INSERT INTO apps_apps (
      id,
      org_id,
      org_slug,
      owner_user_id,
      name,
      code,
      slug,
      description,
      type,
      status,
      visibility,
      login_required,
      agent_mcp_enabled,
      llm_enabled,
      data_service_id,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "app-1",
    "org-1",
    "workspace",
    "user-1",
    "Storage App",
    "storage-app",
    "storage-app",
    "",
    "container",
    "draft",
    "org",
    1,
    0,
    0,
    "ds-1",
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z"
  );

  const resources = [];
  if (kv) {
    resources.push(["res-kv", "kv_namespace", "cloudflare", "apps-storage-app-kv", "kv-1", "CONFIG"]);
  }
  if (r2) {
    resources.push(["res-r2", "r2_bucket", "cloudflare", "apps-storage-app-r2", "r2-1", "BUCKET"]);
  }
  for (const resource of resources) {
    database.prepare(`
      INSERT INTO apps_app_resources (
        id,
        app_id,
        data_service_id,
        type,
        provider,
        resource_name,
        resource_id,
        binding_name,
        environment,
        status,
        created_at
      )
      VALUES (?, 'app-1', 'ds-1', ?, ?, ?, ?, ?, 'prod', 'ready', '2026-07-01T00:00:00.000Z')
    `).run(...resource);
  }

  return {
    CF_ACCOUNT_ID: "acct-1",
    CF_API_TOKEN: "cf-token",
    APPS_DB: new D1Adapter(database),
    __cloudflare: {
      kv: new Map(),
      r2: new Map()
    }
  };
}

const principal = {
  orgId: "org-1",
  orgSlug: "workspace",
  scopes: ["apps:apps:write"],
  sub: "user-1"
};

function withCloudflareMock(env, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = (init.method || "GET").toUpperCase();
    const kvPrefix = "/accounts/acct-1/storage/kv/namespaces/kv-1";
    const r2Prefix = "/accounts/acct-1/r2/buckets/apps-storage-app-r2";

    if (path === "/accounts/acct-1/storage/kv/namespaces" && method === "GET") {
      return jsonResponse([{ id: "kv-1", title: "apps-storage-app-kv" }]);
    }
    if (path === "/accounts/acct-1/r2/buckets/apps-storage-app-r2" && method === "GET") {
      return jsonResponse({ name: "apps-storage-app-r2" });
    }

    if (path === `${kvPrefix}/keys` && method === "GET") {
      const prefix = url.searchParams.get("prefix") || "";
      const keys = Array.from(env.__cloudflare.kv.keys())
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((name) => ({ name }));
      return jsonResponse(keys);
    }
    if (path.startsWith(`${kvPrefix}/values/`)) {
      const key = decodeStoragePath(path.slice(`${kvPrefix}/values/`.length));
      if (method === "PUT") {
        env.__cloudflare.kv.set(key, String(init.body ?? ""));
        return jsonResponse({});
      }
      if (method === "GET") {
        if (!env.__cloudflare.kv.has(key)) {
          return new Response("not found", { status: 404 });
        }
        return new Response(env.__cloudflare.kv.get(key), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (method === "DELETE") {
        env.__cloudflare.kv.delete(key);
        return jsonResponse({});
      }
    }

    if (path === `${r2Prefix}/objects` && method === "GET") {
      const prefix = url.searchParams.get("prefix") || "";
      const objects = Array.from(env.__cloudflare.r2.entries())
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, object]) => ({
          etag: object.etag,
          key,
          last_modified: object.uploaded,
          size: object.bytes.byteLength,
          uploaded: object.uploaded
        }));
      return jsonResponse(objects);
    }
    if (path.startsWith(`${r2Prefix}/objects/`)) {
      const key = decodeStoragePath(path.slice(`${r2Prefix}/objects/`.length));
      if (method === "PUT") {
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        const uploaded = "2026-07-01T00:00:00.000Z";
        const etag = `etag-${bytes.byteLength}`;
        env.__cloudflare.r2.set(key, {
          bytes,
          contentType: init.headers?.["Content-Type"] || init.headers?.get?.("Content-Type") || "application/octet-stream",
          etag,
          uploaded
        });
        return jsonResponse({ etag, key, size: String(bytes.byteLength), uploaded });
      }
      if (method === "GET") {
        const object = env.__cloudflare.r2.get(key);
        if (!object) {
          return new Response("not found", { status: 404 });
        }
        return new Response(object.bytes, {
          headers: {
            "content-type": object.contentType,
            etag: object.etag,
            "last-modified": object.uploaded
          }
        });
      }
      if (method === "DELETE") {
        env.__cloudflare.r2.delete(key);
        return jsonResponse({});
      }
    }

    return jsonResponse({ path, method }, 404);
  };

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

function jsonResponse(result, status = 200) {
  return new Response(JSON.stringify({ result, success: status < 400 }), {
    headers: { "content-type": "application/json" },
    status
  });
}

function decodeStoragePath(value) {
  return value.split("/").map((part) => decodeURIComponent(part)).join("/");
}

describe("APPS app KV/R2 storage helpers", () => {
  it("sets, lists, reads, and deletes app-owned KV values", async () => {
    const env = createEnv();
    const { deleteAppKvValue, getAppKvValue, listAppKvKeys, putAppKvValue } = await storageModule();

    await withCloudflareMock(env, async () => {
      const putResult = await putAppKvValue({
        appId: "app-1",
        key: "feature/workbuddy",
        value: "enabled",
        metadata: { owner: "ops" }
      }, env, principal);

      assert.equal(putResult.item.value, "enabled");

      const listed = await listAppKvKeys({ appId: "app-1", prefix: "feature/" }, env, principal);
      assert.deepEqual(listed.keys.map((item) => item.key), ["feature/workbuddy"]);

      const item = await getAppKvValue({ appId: "app-1", key: "feature/workbuddy" }, env, principal);
      assert.equal(item.item.value, "enabled");

      const deleted = await deleteAppKvValue({ appId: "app-1", key: "feature/workbuddy" }, env, principal);
      assert.equal(deleted.deleted, true);
      await assert.rejects(
        () => getAppKvValue({ appId: "app-1", key: "feature/workbuddy" }, env, principal),
        (error) => error.status === 404 && error.code === "kv_key_not_found"
      );
    });
  });

  it("requires the app to have a KV resource before KV operations", async () => {
    const env = createEnv({ kv: false });
    const { putAppKvValue } = await storageModule();

    await assert.rejects(
      () => putAppKvValue({ appId: "app-1", key: "flag", value: "on" }, env, principal),
      (error) => error.status === 409 && error.code === "kv_resource_not_enabled"
    );
  });

  it("puts, lists, reads, and deletes text R2 objects", async () => {
    const env = createEnv();
    const { deleteAppR2Object, getAppR2Object, listAppR2Objects, putAppR2Object } = await storageModule();

    await withCloudflareMock(env, async () => {
      const putResult = await putAppR2Object({
        appId: "app-1",
        key: "reports/intro.md",
        content: "# Hello",
        contentType: "text/markdown; charset=utf-8"
      }, env, principal);

      assert.equal(putResult.object.key, "reports/intro.md");
      assert.equal(putResult.object.sizeBytes, 7);

      const listed = await listAppR2Objects({ appId: "app-1", prefix: "reports/" }, env, principal);
      assert.deepEqual(listed.objects.map((item) => item.key), ["reports/intro.md"]);

      const object = await getAppR2Object({ appId: "app-1", key: "reports/intro.md" }, env, principal);
      assert.equal(object.object.content, "# Hello");
      assert.equal(object.object.encoding, "text");

      const deleted = await deleteAppR2Object({ appId: "app-1", key: "reports/intro.md" }, env, principal);
      assert.equal(deleted.deleted, true);
      await assert.rejects(
        () => getAppR2Object({ appId: "app-1", key: "reports/intro.md" }, env, principal),
        (error) => error.status === 404 && error.code === "r2_object_not_found"
      );
    });
  });

  it("round-trips binary R2 objects as base64", async () => {
    const env = createEnv();
    const { getAppR2Object, putAppR2Object } = await storageModule();
    const content = btoa(String.fromCharCode(0, 1, 2, 255));

    await withCloudflareMock(env, async () => {
      await putAppR2Object({
        appId: "app-1",
        key: "files/blob.bin",
        content,
        contentType: "application/octet-stream",
        encoding: "base64"
      }, env, principal);

      const object = await getAppR2Object({ appId: "app-1", key: "files/blob.bin" }, env, principal);
      assert.equal(object.object.encoding, "base64");
      assert.equal(object.object.content, content);
    });
  });

  it("requires the app to have an R2 resource before R2 operations", async () => {
    const env = createEnv({ r2: false });
    const { putAppR2Object } = await storageModule();

    await assert.rejects(
      () => putAppR2Object({ appId: "app-1", key: "file.txt", content: "hello" }, env, principal),
      (error) => error.status === 409 && error.code === "r2_resource_not_enabled"
    );
  });
});
