import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql));
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

class R2Adapter {
  constructor() {
    this.objects = new Map();
  }

  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      body: new Blob([bytes]).stream(),
      size: bytes.byteLength
    };
  }

  async head(key) {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.byteLength } : null;
  }

  async put(key, value, options) {
    const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, bytes);
    this.lastPut = { key, options };
    return { key, size: bytes.byteLength };
  }
}

let modulePromise;

async function sourceSnapshotsModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const outdir = await mkdtemp(join(tmpdir(), "apps-source-snapshots-test-"));
      const outfile = join(outdir, "sourceSnapshots.mjs");
      await build({
        bundle: true,
        entryPoints: [new URL("./sourceSnapshots.ts", import.meta.url).pathname],
        format: "esm",
        logLevel: "silent",
        outfile,
        platform: "neutral"
      });
      const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
      await rm(outdir, { force: true, recursive: true });
      return mod;
    })();
  }
  return modulePromise;
}

function createEnv() {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync("workers/apps/db/schema.sql", "utf8"));
  database.prepare(`
    INSERT INTO apps_apps (
      id, org_id, org_slug, owner_user_id, name, code, slug, description,
      type, status, visibility, login_required, agent_mcp_enabled, llm_enabled,
      data_service_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "app-1", "org-1", "workspace", "user-1", "Snapshot App", "snapshot-app",
    "snapshot-app", "", "web", "draft", "private", 0, 0, 0, "ds-1",
    "2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z"
  );
  return {
    database,
    env: {
      APPS_ARTIFACTS: new R2Adapter(),
      APPS_DB: new D1Adapter(database)
    }
  };
}

const principal = {
  name: "Ada Zhang",
  orgId: "org-1",
  orgSlug: "workspace",
  scopes: ["apps:apps:read", "apps:apps:write"],
  sub: "user-1"
};

function uploadRequest(archive, contentSha256, metadata = { version: "v1", versionName: "Version One", notes: "Initial backup", purpose: "backup" }) {
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  return new Request("https://apps.example.test/apps/app-1/source-snapshots?version=v1", {
    method: "POST",
    headers: {
      "content-length": String(archive.byteLength),
      "content-type": "application/zip",
      "x-workspace-source-archive-sha256": archiveSha256,
      "x-workspace-source-content-sha256": contentSha256,
      "x-workspace-source-file-count": "2",
      "x-workspace-source-metadata": Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url"),
      "x-workspace-source-size": "128"
    },
    body: archive
  });
}

describe("APPS source snapshots", () => {
  it("uploads, deduplicates, lists, and downloads an immutable project archive", async () => {
    const { database, env } = createEnv();
    const {
      downloadCurrentPublishedSourceSnapshot,
      downloadSourceSnapshot,
      listSourceSnapshots,
      uploadSourceSnapshot
    } = await sourceSnapshotsModule();
    const archive = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);
    const contentSha256 = createHash("sha256").update("canonical-source").digest("hex");

    const uploaded = await uploadSourceSnapshot(uploadRequest(archive, contentSha256), env, principal, "app-1");
    assert.equal(uploaded.deduplicated, false);
    assert.match(uploaded.sourceSnapshot.id, /^snap_/);
    assert.equal(uploaded.sourceSnapshot.version, "v1");
    assert.equal(uploaded.sourceSnapshot.versionName, "Version One");
    assert.equal(uploaded.sourceSnapshot.notes, "Initial backup");
    assert.equal(uploaded.sourceSnapshot.purpose, "backup");
    assert.equal(uploaded.sourceSnapshot.createdByName, "Ada Zhang");
    assert.equal(uploaded.sourceSnapshot.fileCount, 2);
    assert.equal(uploaded.sourceSnapshot.sourceSizeBytes, 128);
    assert.equal(uploaded.sourceSnapshot.archiveSizeBytes, archive.byteLength);
    assert.equal(env.APPS_ARTIFACTS.lastPut.options.sha256, uploaded.sourceSnapshot.archiveSha256);
    assert.equal(env.APPS_ARTIFACTS.lastPut.key, `apps/app-1/source-snapshots/${uploaded.sourceSnapshot.id}/source.zip`);

    const duplicate = await uploadSourceSnapshot(uploadRequest(archive, contentSha256, {
      version: "v1",
      versionName: "Version One",
      notes: "Deployed after backup",
      purpose: "deployment"
    }), env, principal, "app-1");
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.sourceSnapshot.id, uploaded.sourceSnapshot.id);
    assert.equal(duplicate.sourceSnapshot.purpose, "both");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM apps_app_source_snapshots").get().count, 1);

    const listed = await listSourceSnapshots(env, principal, "app-1");
    assert.equal(listed.sourceSnapshots.length, 1);
    assert.equal(listed.sourceSnapshots[0].id, uploaded.sourceSnapshot.id);

    const response = await downloadSourceSnapshot(env, principal, "app-1", uploaded.sourceSnapshot.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.match(response.headers.get("content-disposition"), /snapshot-app|app-1/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), archive);

    database.prepare(`
      INSERT INTO apps_deployments (
        id, app_id, source_snapshot_id, environment, version, version_name,
        release_notes, status, url, created_by, created_by_name, created_at
      ) VALUES (?, ?, ?, 'production', ?, '', '', 'published', ?, ?, ?, ?)
    `).run(
      "dep-current",
      "app-1",
      uploaded.sourceSnapshot.id,
      "v1",
      "https://snapshot-app.example.test",
      "user-1",
      "Ada Zhang",
      "2026-08-09T01:00:00.000Z"
    );
    const current = await downloadCurrentPublishedSourceSnapshot(env, principal, "app-1");
    assert.equal(current.status, 200);
    assert.equal(current.headers.get("x-workspace-deployment-id"), "dep-current");
    assert.equal(current.headers.get("x-workspace-deployment-version"), "v1");
    assert.equal(current.headers.get("x-workspace-source-snapshot-id"), uploaded.sourceSnapshot.id);
    assert.equal(current.headers.get("x-workspace-source-archive-sha256"), uploaded.sourceSnapshot.archiveSha256);
    assert.deepEqual(new Uint8Array(await current.arrayBuffer()), archive);
  });

  it("does not fall back to an unrelated snapshot when the published deployment has no source snapshot", async () => {
    const { database, env } = createEnv();
    const { downloadCurrentPublishedSourceSnapshot, uploadSourceSnapshot } = await sourceSnapshotsModule();
    const archive = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 7, 8, 9]);
    await uploadSourceSnapshot(
      uploadRequest(archive, createHash("sha256").update("unrelated-source").digest("hex")),
      env,
      principal,
      "app-1"
    );
    database.prepare(`
      INSERT INTO apps_deployments (
        id, app_id, environment, version, version_name, release_notes, status,
        url, created_by, created_by_name, created_at
      ) VALUES (?, ?, 'production', ?, '', '', 'published', ?, ?, ?, ?)
    `).run(
      "dep-without-source",
      "app-1",
      "legacy-v1",
      "https://snapshot-app.example.test",
      "user-1",
      "Ada Zhang",
      "2026-08-09T01:00:00.000Z"
    );

    await assert.rejects(
      () => downloadCurrentPublishedSourceSnapshot(env, principal, "app-1"),
      (error) => error.status === 409 && error.code === "published_deployment_source_snapshot_not_found"
    );
  });

  it("rejects an archive whose declared SHA-256 does not match its bytes", async () => {
    const { env } = createEnv();
    const { uploadSourceSnapshot } = await sourceSnapshotsModule();
    const archive = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1]);
    const request = uploadRequest(archive, createHash("sha256").update("source").digest("hex"));
    request.headers.set("x-workspace-source-archive-sha256", "0".repeat(64));

    await assert.rejects(
      () => uploadSourceSnapshot(request, env, principal, "app-1"),
      (error) => error.status === 400 && error.code === "source_snapshot_archive_sha256_mismatch"
    );
  });
});
