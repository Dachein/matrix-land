import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createDeploymentArtifact } from "../../../../packages/cli/src/deployment-artifact.mjs";

class D1Adapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementAdapter(this.database.prepare(sql)); }
}

class D1StatementAdapter {
  constructor(statement, params = []) { this.params = params; this.statement = statement; }
  bind(...params) { return new D1StatementAdapter(this.statement, params); }
  async all() { return { results: this.statement.all(...this.params) }; }
  async first() { return this.statement.get(...this.params) ?? null; }
  async run() { this.statement.run(...this.params); return { success: true }; }
}

class R2Adapter {
  constructor() { this.objects = new Map(); }

  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      async arrayBuffer() { return bytes.slice().buffer; },
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

async function deployArtifactsModule() {
  modulePromise ??= (async () => {
    const outdir = await mkdtemp(join(tmpdir(), "apps-deploy-artifacts-module-"));
    const outfile = join(outdir, "deployArtifacts.mjs");
    await build({
      bundle: true,
      entryPoints: [fileURLToPath(new URL("./deployArtifacts.ts", import.meta.url))],
      format: "esm",
      logLevel: "silent",
      outfile,
      platform: "neutral"
    });
    const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    await rm(outdir, { force: true, recursive: true });
    return mod;
  })();
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
    "app-1", "org-1", "workspace", "user-1", "Artifact App", "artifact-app",
    "artifact-app", "", "web", "draft", "private", 0, 0, 0, "ds-1",
    "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z"
  );
  return {
    database,
    env: { APPS_ARTIFACTS: new R2Adapter(), APPS_DB: new D1Adapter(database) }
  };
}

const principal = {
  orgId: "org-1",
  orgSlug: "workspace",
  scopes: ["apps:apps:read", "apps:apps:write"],
  sub: "user-1"
};

function uploadRequest(artifact, overrides = {}) {
  return new Request("https://apps.example.test/apps/app-1/deploy-artifacts?version=v1", {
    method: "POST",
    headers: {
      "content-length": String(artifact.archive.byteLength),
      "content-type": "application/zip",
      "x-workspace-deploy-archive-sha256": artifact.archiveSha256,
      "x-workspace-deploy-content-sha256": artifact.contentSha256,
      "x-workspace-deploy-content-size": String(artifact.contentSizeBytes),
      "x-workspace-deploy-entrypoint": artifact.entrypoint,
      "x-workspace-deploy-file-count": String(artifact.fileCount),
      "x-workspace-deploy-target": artifact.target,
      ...overrides
    },
    body: artifact.archive
  });
}

function rewriteArtifactManifest(artifact, rewrite) {
  const entries = unzipSync(artifact.archive);
  const manifestPath = ".workspace-deploy/manifest.json";
  const manifest = JSON.parse(strFromU8(entries[manifestPath]));
  rewrite(manifest);
  entries[manifestPath] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  const archive = zipSync(entries);
  return {
    ...artifact,
    archive,
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    entrypoint: manifest.entrypoint,
    target: manifest.target
  };
}

describe("APPS deployment artifacts", () => {
  it("verifies, deduplicates, lists, downloads, and expands a CLI deployment ZIP", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apps-deploy-artifact-fixture-"));
    try {
      await writeFile(join(directory, "index.html"), "<!doctype html><h1>Artifact</h1>\n");
      await writeFile(join(directory, "logo.png"), Uint8Array.from([0, 1, 2, 3, 254, 255]));
      const artifact = await createDeploymentArtifact(directory, { target: "pages", entrypoint: "index.html" });
      const { database, env } = createEnv();
      const { downloadDeployArtifact, listDeployArtifacts, loadDeployArtifact, uploadDeployArtifact } = await deployArtifactsModule();

      const uploaded = await uploadDeployArtifact(uploadRequest(artifact), env, principal, "app-1");
      assert.equal(uploaded.deduplicated, false);
      assert.match(uploaded.deployArtifact.id, /^artifact_/);
      assert.equal(uploaded.deployArtifact.contentSha256, artifact.contentSha256);
      assert.equal(uploaded.deployArtifact.target, "pages");
      assert.equal(env.APPS_ARTIFACTS.lastPut.options.sha256, artifact.archiveSha256);

      const duplicate = await uploadDeployArtifact(uploadRequest(artifact), env, principal, "app-1");
      assert.equal(duplicate.deduplicated, true);
      assert.equal(duplicate.deployArtifact.id, uploaded.deployArtifact.id);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM apps_app_deploy_artifacts").get().count, 1);

      const listed = await listDeployArtifacts(env, principal, "app-1");
      assert.equal(listed.deployArtifacts.length, 1);
      assert.equal(listed.deployArtifacts[0].id, uploaded.deployArtifact.id);

      const loaded = await loadDeployArtifact(env, principal, "app-1", uploaded.deployArtifact.id, "pages");
      assert.equal(loaded.files.find((file) => file.path === "index.html").encoding, "text");
      const binary = loaded.files.find((file) => file.path === "logo.png");
      assert.equal(binary.encoding, "base64");
      assert.deepEqual(Uint8Array.from(Buffer.from(binary.content, "base64")), Uint8Array.from([0, 1, 2, 3, 254, 255]));

      const response = await downloadDeployArtifact(env, principal, "app-1", uploaded.deployArtifact.id);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-workspace-deploy-archive-sha256"), artifact.archiveSha256);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), artifact.archive);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a deployment archive whose declared SHA-256 is false", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apps-deploy-artifact-invalid-"));
    try {
      await writeFile(join(directory, "index.js"), "export default { fetch() { return new Response('ok'); } };\n");
      const artifact = await createDeploymentArtifact(directory, { target: "worker", entrypoint: "index.js" });
      const { env } = createEnv();
      const { uploadDeployArtifact } = await deployArtifactsModule();
      await assert.rejects(
        () => uploadDeployArtifact(uploadRequest(artifact, { "x-workspace-deploy-archive-sha256": "0".repeat(64) }), env, principal, "app-1"),
        (error) => error.status === 400 && error.code === "deploy_artifact_archive_sha256_mismatch"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects Worker browser assets that are missing schema v2 metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apps-worker-assets-metadata-"));
    try {
      await writeFile(join(directory, "index.js"), "export default { fetch() { return new Response('ok'); } };\n");
      await writeFile(join(directory, "index.html"), "<!doctype html><main>App</main>\n");
      const pagesArtifact = await createDeploymentArtifact(directory, { target: "pages", entrypoint: "index.html" });
      const rootAssetsArtifact = rewriteArtifactManifest(pagesArtifact, (manifest) => {
        manifest.target = "worker";
        manifest.entrypoint = "index.js";
      });
      const { env } = createEnv();
      const { uploadDeployArtifact } = await deployArtifactsModule();

      await assert.rejects(
        () => uploadDeployArtifact(uploadRequest(rootAssetsArtifact), env, principal, "app-1"),
        (error) => error.status === 400
          && error.code === "deploy_artifact_worker_assets_metadata_missing"
          && error.details?.detectedPath === "index.html"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a manual .workspace-assets archive without assets metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "apps-worker-manual-assets-"));
    const workerDirectory = join(directory, "worker");
    const assetsDirectory = join(directory, "assets");
    try {
      await Promise.all([mkdir(workerDirectory), mkdir(assetsDirectory)]);
      await writeFile(join(workerDirectory, "index.js"), "export default { fetch() { return new Response('ok'); } };\n");
      await writeFile(join(assetsDirectory, "index.html"), "<!doctype html><main>App</main>\n");
      const validArtifact = await createDeploymentArtifact(workerDirectory, {
        target: "worker",
        entrypoint: "index.js",
        assets: { sourceDirectory: assetsDirectory }
      });
      const missingMetadataArtifact = rewriteArtifactManifest(validArtifact, (manifest) => {
        manifest.schemaVersion = 1;
        delete manifest.assets;
      });
      const { env } = createEnv();
      const { uploadDeployArtifact } = await deployArtifactsModule();

      await assert.rejects(
        () => uploadDeployArtifact(uploadRequest(missingMetadataArtifact), env, principal, "app-1"),
        (error) => error.status === 400
          && error.code === "deploy_artifact_worker_assets_metadata_missing"
          && error.details?.detectedPath === ".workspace-assets/"
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
