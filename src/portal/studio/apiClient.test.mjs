import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { loadMateBuilderSelection } from "./mateSelection.ts";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
let apiPromise;
let clickedAnchors;

function loadApi() {
  apiPromise ??= (async () => {
    const outdir = await mkdtemp(join(tmpdir(), "workspace-apps-api-client-"));
    const outfile = join(outdir, "apiClient.mjs");
    await build({
      bundle: true,
      define: { "import.meta.env.VITE_APPS_WORKER_URL": '"/api/apps"' },
      entryPoints: [new URL("./apiClient.ts", import.meta.url).pathname],
      format: "esm",
      logLevel: "silent",
      outfile,
      platform: "neutral"
    });
    const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
    await rm(outdir, { force: true, recursive: true });
    return mod;
  })();
  return apiPromise;
}

beforeEach(() => {
  clickedAnchors = [];
  globalThis.document = {
    body: {
      appendChild() {}
    },
    createElement(tagName) {
      assert.equal(tagName, "a");
      const anchor = {
        click() {
          clickedAnchors.push({ download: anchor.download, href: anchor.href });
        },
        remove() {}
      };
      return anchor;
    }
  };
  globalThis.window = {
    localStorage: {
      getItem() {
        return null;
      },
      removeItem() {},
      setItem() {}
    }
  };
});

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

const catalog = {
  currentUser: {
    email: "owner@example.invalid",
    id: "user-1"
  }
};

describe("APPS API client", () => {
  it("loads the complete Mate definition before opening the Builder", async () => {
    const summary = { id: "cortana" };
    const complete = { id: "cortana", draftDocuments: [], draftManifest: { schemaVersion: "workspace.agentruntime/v1" } };
    const calls = [];

    assert.equal(await loadMateBuilderSelection(summary, async (mateId) => {
      calls.push(mateId);
      return complete;
    }), complete);
    assert.deepEqual(calls, ["cortana"]);
  });

  it("does not reinterpret an incomplete Mate summary as a create flow", async () => {
    assert.equal(await loadMateBuilderSelection({ id: "cortana" }, async () => ({
      id: "cortana",
      draftDocuments: [],
      draftManifest: undefined
    })), undefined);
  });

  it("starts source downloads directly through the authenticated Portal proxy", async () => {
    const { downloadAppsSourceSnapshot } = await loadApi();
    globalThis.fetch = async () => {
      throw new Error("Portal proxy downloads must preserve the original user gesture");
    };

    await downloadAppsSourceSnapshot("app/a", "snap/b", catalog);

    assert.deepEqual(clickedAnchors, [{
      download: "app/a-snap/b.zip",
      href: "/api/apps/apps/app%2Fa/source-snapshots/snap%2Fb/download"
    }]);
  });

  it("preserves allowlisted access sync errors and request IDs", async () => {
    const { appsApiRequest, AppsApiError } = await loadApi();
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: "auth_app_sync_timeout",
      requestId: "req-auth-timeout-1"
    }), {
      status: 504,
      headers: { "content-type": "application/json" }
    });

    await assert.rejects(
      () => appsApiRequest("/apps/app-1/visibility", catalog, { method: "PATCH" }),
      (error) => error instanceof AppsApiError
        && error.status === 504
        && error.code === "auth_app_sync_timeout"
        && error.requestId === "req-auth-timeout-1"
    );
  });

  it("preserves immutable App identity conflicts", async () => {
    const { appsApiRequest, AppsApiError } = await loadApi();
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: "apps_app_code_immutable",
      requestId: "req-app-code-1"
    }), {
      status: 409,
      headers: { "content-type": "application/json" }
    });

    await assert.rejects(
      () => appsApiRequest("/apps/app-1", catalog, { method: "PATCH" }),
      (error) => error instanceof AppsApiError
        && error.status === 409
        && error.code === "apps_app_code_immutable"
        && error.requestId === "req-app-code-1"
    );
  });

  it("preserves Mate work email conflicts for inline form feedback", async () => {
    const { appsApiRequest, AppsApiError } = await loadApi();
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: "mate_email_conflict",
      requestId: "req-mate-email-1"
    }), {
      status: 409,
      headers: { "content-type": "application/json" }
    });

    await assert.rejects(
      () => appsApiRequest("/mates", catalog, { method: "POST" }),
      (error) => error instanceof AppsApiError
        && error.status === 409
        && error.code === "mate_email_conflict"
        && error.requestId === "req-mate-email-1"
    );
  });

  it("does not expose unknown server errors", async () => {
    const { appsApiRequest, AppsApiError } = await loadApi();
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: "private_database_error",
      message: "secret internal detail"
    }), {
      status: 500,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-private-1"
      }
    });

    await assert.rejects(
      () => appsApiRequest("/apps/app-1/visibility", catalog, { method: "PATCH" }),
      (error) => error instanceof AppsApiError
        && error.code === "apps_api_unavailable"
        && error.requestId === "req-private-1"
        && !error.message.includes("secret internal detail")
    );
  });

  it("maps network failures to a stable unavailable error", async () => {
    const { appsApiRequest, AppsApiError } = await loadApi();
    globalThis.fetch = async () => {
      throw new Error("private network detail");
    };

    await assert.rejects(
      () => appsApiRequest("/apps/app-1/visibility", catalog, { method: "PATCH" }),
      (error) => error instanceof AppsApiError
        && error.code === "apps_worker_unavailable"
        && !error.message.includes("private network detail")
    );
  });
});
