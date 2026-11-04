import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadResourcesModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-resources-test-"));
  const outfile = join(outdir, "resources.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./resources.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

async function loadResourceCatalogModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-resource-catalog-test-"));
  const outfile = join(outdir, "appsResourceCatalog.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("../../../../src/shared/appsResourceCatalog.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

describe("APPS reserved app codes", () => {
  it("keeps platform hostnames out of the app runtime namespace", async () => {
    const { uniqueAppCode } = await loadResourcesModule();
    const db = {
      prepare() {
        throw new Error("reserved codes must be rejected before querying D1");
      }
    };

    for (const code of [
      "ai",
      "auth",
      "auth-service",
      "cf",
      "cf-tools",
      "d1",
      "d1-admin",
      "workspace",
      "workspace-academy",
      "k",
      "knowledge",
      "apps",
      "apps-builder",
      "live",
      "mcp",
      "sqlite",
      "sqlite-browser",
      "token",
      "users",
      "users-admin"
    ]) {
      await assert.rejects(
        uniqueAppCode(db, "org-1", code),
        (error) => error?.status === 400 && error?.code === "reserved_app_code"
      );
    }
  });
});

describe("APPS App resource selection", () => {
  it("allows only D1, KV, and R2 additions for Pages apps", async () => {
    const { appsAppendableResourceTypes } = await loadResourceCatalogModule();

    assert.deepEqual(appsAppendableResourceTypes("static_page"), [
      "d1_database",
      "kv_namespace",
      "r2_bucket"
    ]);
  });

  it("keeps fixed Web resources and honors selected R2/KV storage", async () => {
    const { selectedResourceTemplates } = await loadResourcesModule();
    const templates = selectedResourceTemplates("web", [
      "worker",
      "d1_database",
      "r2_bucket",
      "kv_namespace"
    ]);

    assert.deepEqual(templates.map((template) => template.type), [
      "worker",
      "d1_database",
      "r2_bucket",
      "kv_namespace"
    ]);
    assert.equal(templates.find((template) => template.type === "r2_bucket")?.bindingName, "BUCKET");
    assert.equal(templates.find((template) => template.type === "kv_namespace")?.bindingName, "CONFIG");
  });

  it("rejects capability resources that must be enabled through governed config", async () => {
    const { selectedResourceTemplates } = await loadResourcesModule();

    assert.throws(
      () => selectedResourceTemplates("web", ["worker", "d1_database", "email_sending"]),
      (error) => error?.status === 400 && error?.code === "invalid_resource_selection"
    );
  });

  it("preserves the default Worker runtime for advanced container apps", async () => {
    const { selectedResourceTemplates } = await loadResourcesModule();

    assert.deepEqual(
      selectedResourceTemplates("container", ["r2_bucket"]).map((template) => template.type),
      ["worker", "r2_bucket"]
    );
  });

  it("declares Queue and Hyperdrive bindings and keeps deferred resources unready until configured", async () => {
    const { selectedResourceTemplates } = await loadResourcesModule();
    const templates = selectedResourceTemplates("container", ["queue", "hyperdrive_config", "cron_trigger"]);

    assert.equal(templates.find((template) => template.type === "queue")?.bindingName, "QUEUE");
    assert.equal(templates.find((template) => template.type === "hyperdrive_config")?.bindingName, "HYPERDRIVE");
    assert.equal(templates.find((template) => template.type === "hyperdrive_config")?.status, "placeholder");
    assert.equal(templates.find((template) => template.type === "cron_trigger")?.status, "placeholder");
  });
});
