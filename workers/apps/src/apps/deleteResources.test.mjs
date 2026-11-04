import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let modulePromise;

async function loadModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-delete-resources-test-"));
  const outfile = join(outdir, "deleteResources.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./deleteResources.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function deleteResourcesModule() {
  modulePromise ??= loadModule();
  return modulePromise;
}

function cloudflareResponse(result, resultInfo = undefined, status = 200) {
  return new Response(JSON.stringify({
    result,
    ...(resultInfo ? { result_info: resultInfo } : {}),
    success: status < 400
  }), {
    headers: { "content-type": "application/json" },
    status
  });
}

function resource(type, provider, resourceName, resourceId = resourceName) {
  return {
    app_id: "app-1",
    binding_name: "",
    created_at: "2026-07-01T00:00:00.000Z",
    data_service_id: "ds-1",
    environment: "prod",
    id: `res-${type}`,
    provider,
    resource_id: resourceId,
    resource_name: resourceName,
    status: "ready",
    type
  };
}

describe("APPS external resource deletion", () => {
  it("detaches the runtime first, drains every R2 page, then deletes Queue and storage resources", async () => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/client/v4", "");
      const method = (init.method || "GET").toUpperCase();
      calls.push({ method, path, search: url.search });

      if (path.endsWith("/r2/buckets/apps-app-r2/objects") && method === "GET") {
        if (url.searchParams.get("cursor") === "cursor-1") {
          return cloudflareResponse([{ key: "third.txt" }], { is_truncated: false });
        }
        return cloudflareResponse(
          [{ key: "first.txt" }, { key: "folder/second file.txt" }],
          { cursor: "cursor-1", is_truncated: true }
        );
      }
      return cloudflareResponse({});
    };

    try {
      const { deleteAppExternalResources } = await deleteResourcesModule();
      const result = await deleteAppExternalResources(
        { CF_ACCOUNT_ID: "acct-1", CF_API_TOKEN: "cf-token" },
        { code: "app", id: "app-1", slug: "app" },
        [
          resource("d1_database", "cloudflare-d1", "apps-app-db", "d1-1"),
          resource("r2_bucket", "cloudflare-r2", "apps-app-r2"),
          resource("queue", "cloudflare-queues", "apps-app-queue", "queue-1"),
          resource("worker", "cloudflare-workers", "apps-app-worker")
        ],
        []
      );

      assert.deepEqual(result.deletedExternalResources, [
        "worker:apps-app-worker",
        "queue:queue-1",
        "d1:d1-1",
        "r2-objects:apps-app-r2:3",
        "r2:apps-app-r2"
      ]);
      assert.equal(calls[0].path, "/accounts/acct-1/workers/scripts/apps-app-worker");
      assert.equal(calls[1].path, "/accounts/acct-1/queues/queue-1");
      assert.ok(calls.some((call) => call.path.endsWith("/objects/folder/second%20file.txt") && call.method === "DELETE"));
      assert.ok(calls.some((call) => call.path.endsWith("/objects") && call.search.includes("cursor=cursor-1")));
      assert.equal(calls.at(-1).path, "/accounts/acct-1/r2/buckets/apps-app-r2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
