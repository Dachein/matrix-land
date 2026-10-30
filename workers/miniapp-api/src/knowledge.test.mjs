import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMiniappKnowledgeApi } from "./knowledge.ts";

const principal = {
  userId: "user-1",
  email: "user@example.com",
  name: "User",
  role: "member",
  team: "AI Adoption",
  department: "Research",
  departmentId: "dept-1",
  departmentPath: ["Research"],
  identity: { provider: "generic_oidc", tenantId: "tenant-1", objectId: "object-1", principalName: "user@example.com" }
};

function context() {
  return {
    request: new Request("https://ai.example.invalid/api/miniapp/v1/knowledge-services", {
      headers: { cookie: "workspace_session=session-1" }
    }),
    env: {
      AUTH_WORKER_URL: "https://auth.example.test",
      KNOWLEDGE_WORKER_URL: "https://knowledge.example.test",
      KNOWLEDGE_PUBLIC_URL: "https://knowledge.example.test",
      KNOWLEDGE_RESOURCE_ID: "workspace-knowledge",
      PORTAL_AUTH_SERVICE_TOKEN: "portal-service-token"
    }
  };
}

describe("miniapp Knowledge facade", () => {
  it("mints a read token and proxies the card list without forwarding client identity", async () => {
    const calls = [];
    const api = createMiniappKnowledgeApi({
      readPrincipal: async () => principal,
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/v1/resource-tokens/mint")) {
          return Response.json({ access_token: "knowledge-read-token" });
        }
        return Response.json({ services: [{ serviceId: "ksvc-1" }] });
      }
    });

    const payload = await api.listServices(context());

    assert.deepEqual(payload, { services: [{ serviceId: "ksvc-1" }] });
    assert.equal(calls[0].url, "https://auth.example.test/v1/resource-tokens/mint");
    const mintBody = JSON.parse(calls[0].init.body);
    assert.deepEqual(mintBody.scopes, ["workspace:knowledge:read"]);
    assert.equal(mintBody.clientId, "workspace-miniapp");
    assert.equal(calls[1].url, "https://knowledge.example.test/api/knowledge-services?view=card");
    assert.equal(calls[1].init.method, "GET");
    assert.equal(calls[1].init.headers.Authorization, "Bearer knowledge-read-token");
    assert.equal(calls[1].init.headers["x-workspace-source-channel"], "miniapp");
    assert.equal(calls[1].init.headers["x-workspace-user-id"], undefined);
  });

  it("keeps preview target resolution authenticated and forwards no mutation route", async () => {
    const calls = [];
    const api = createMiniappKnowledgeApi({
      readPrincipal: async () => principal,
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith("/v1/resource-tokens/mint")) return Response.json({ access_token: "knowledge-read-token" });
        return Response.json({ service: { id: "ksvc-1", effectiveRole: "viewer" } });
      }
    });

    const result = await api.resolvePreviewTarget(context(), {
      serviceId: "ksvc-1",
      objectId: "object-1",
      path: "docs/guide.md",
      conversationId: "conversation-1",
      messageId: "message-1"
    });

    assert.deepEqual(result.target, {
      type: "knowledge",
      serviceId: "ksvc-1",
      objectId: "object-1",
      path: "docs/guide.md",
      conversationId: "conversation-1",
      messageId: "message-1"
    });
    assert.equal(calls[1].init.method, "GET");
    assert.equal(calls.some(({ url }) => url.includes("/edit") || url.includes("/upload")), false);
  });

  it("rejects anonymous requests before minting or reading content", async () => {
    let called = false;
    const api = createMiniappKnowledgeApi({
      readPrincipal: async () => undefined,
      fetch: async () => {
        called = true;
        return Response.json({});
      }
    });

    await assert.rejects(() => api.listServices(context()), { status: 401, message: "not_authenticated" });
    assert.equal(called, false);
  });

  it("returns the file modification time with preview content", async () => {
    const api = createMiniappKnowledgeApi({
      readPrincipal: async () => principal,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/resource-tokens/mint")) return Response.json({ access_token: "knowledge-read-token" });
        if (url.endsWith("/api/files/file-1")) return Response.json({ item: { kind: "file", name: "guide.md", mimeType: "text/markdown", modifiedAt: "2026-09-28T08:30:00.000Z" } });
        return new Response("# Guide", { headers: { "content-type": "text/markdown" } });
      }
    });

    const payload = await api.readLibraryFile(context(), "file-1");
    assert.equal(payload.file.fileName, "guide.md");
    assert.equal(payload.file.modifiedAt, "2026-09-28T08:30:00.000Z");
    assert.equal(payload.content.text, "# Guide");
  });

  it("uploads a named file with a write token and no client supplied path", async () => {
    const calls = [];
    const api = createMiniappKnowledgeApi({
      readPrincipal: async () => principal,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        if (String(input).endsWith("/v1/resource-tokens/mint")) return Response.json({ access_token: "knowledge-write-token" });
        return Response.json({ item: { id: "file-1", name: "notes.md" } }, { status: 201 });
      }
    });
    const form = new FormData();
    form.set("file", new File(["# Notes"], "temp.dat", { type: "application/octet-stream" }));
    form.set("fileName", "notes.md");
    form.set("mediaType", "text/markdown");
    form.set("parentObjectId", "folder-1");
    form.set("path", "outside/notes.md");
    const uploadContext = { ...context(), request: new Request("https://ai.example.invalid/api/miniapp/v1/knowledge-library/files", { method: "POST", body: form }) };

    assert.deepEqual(await api.uploadFile(uploadContext), { item: { id: "file-1", name: "notes.md" } });
    assert.deepEqual(JSON.parse(calls[0].init.body).scopes, ["workspace:knowledge:write"]);
    assert.equal(calls[1].url, "https://knowledge.example.test/api/files/upload");
    assert.equal(calls[1].init.headers.Authorization, "Bearer knowledge-write-token");
    assert.equal(calls[1].init.body.get("file").name, "notes.md");
    assert.equal(calls[1].init.body.get("file").type, "text/markdown");
    assert.equal(calls[1].init.body.get("parentObjectId"), "folder-1");
    assert.equal(calls[1].init.body.get("extractZip"), "false");
    assert.equal(calls[1].init.body.has("path"), false);
  });

  it("rejects anonymous uploads before reading the file", async () => {
    let called = false;
    const api = createMiniappKnowledgeApi({ readPrincipal: async () => undefined, fetch: async () => { called = true; return Response.json({}); } });
    const uploadContext = { ...context(), request: new Request("https://ai.example.invalid/api/miniapp/v1/knowledge-library/files", { method: "POST", body: new FormData() }) };
    await assert.rejects(() => api.uploadFile(uploadContext), { status: 401, message: "not_authenticated" });
    assert.equal(called, false);
  });
});
