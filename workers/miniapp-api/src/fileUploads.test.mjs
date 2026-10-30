import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMiniappFileUploadApi } from "./fileUploads.ts";

function stagingBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options) {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { bytes, customMetadata: options?.customMetadata || {} });
    },
    async get(key) {
      const item = objects.get(key);
      return item && { arrayBuffer: async () => item.bytes.buffer.slice(0), json: async () => JSON.parse(new TextDecoder().decode(item.bytes)) };
    },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); }
  };
}

function context(bucket, request) {
  return { env: { UPLOAD_STAGING: bucket }, request };
}

describe("miniapp staged file uploads", () => {
  it("rejects files above 20 MiB before allocating staging objects", async () => {
    const bucket = stagingBucket();
    const api = createMiniappFileUploadApi({ readOwner: async () => "user-1" });
    await assert.rejects(() => api.start(context(bucket, new Request("https://miniapp.example/start", {
      method: "POST", body: JSON.stringify({ target: "knowledge", fileName: "large.pdf", sizeBytes: 20 * 1024 * 1024 + 1 })
    }))), { status: 400, message: "upload_metadata_invalid" });
    assert.equal(bucket.objects.size, 0);
  });

  it("assembles and completes an exact 20 MiB file", async () => {
    const bucket = stagingBucket();
    const api = createMiniappFileUploadApi({ readOwner: async () => "user-1" });
    const started = await api.start(context(bucket, new Request("https://miniapp.example/start", {
      method: "POST", body: JSON.stringify({ target: "knowledge", fileName: "large.pdf", sizeBytes: 20 * 1024 * 1024 })
    })));
    assert.equal(started.chunkBytes, 4 * 1024 * 1024);
    for (let index = 0; index < 5; index += 1) {
      await api.putChunk(context(bucket, new Request("https://miniapp.example/chunk", {
        method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(started.chunkBytes).fill(index + 1)
      })), started.uploadId, index);
    }
    const response = await api.complete(context(bucket, new Request("https://miniapp.example/complete", { method: "POST" })), started.uploadId, {
      knowledgeApi: { async uploadFile(upstream) {
        const file = (await upstream.request.formData()).get("file");
        assert.equal(file.size, 20 * 1024 * 1024);
        assert.equal(new Uint8Array(await file.slice(0, 1).arrayBuffer())[0], 1);
        assert.equal(new Uint8Array(await file.slice(-1).arrayBuffer())[0], 5);
        return { item: { id: "file-20m" } };
      } },
      miniappFacadeApi: { async proxyRuntime() { throw new Error("unexpected runtime upload"); } }
    });
    assert.equal(response.status, 201);
    assert.equal(bucket.objects.size, 0);
  });

  it("reassembles chunks and forwards a named Knowledge file", async () => {
    const bucket = stagingBucket();
    const api = createMiniappFileUploadApi({ readOwner: async () => "user-1" });
    const started = await api.start(context(bucket, new Request("https://miniapp.example/api/miniapp/v1/file-uploads", {
      method: "POST", body: JSON.stringify({ target: "knowledge", fileName: "notes.md", mediaType: "text/markdown", sizeBytes: 4 * 1024 * 1024 + 3 })
    })));
    const first = new Uint8Array(4 * 1024 * 1024).fill(65);
    const second = new Uint8Array([66, 67, 68]);
    for (const [index, bytes] of [first, second].entries()) {
      await api.putChunk(context(bucket, new Request("https://miniapp.example/chunk", {
        method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes
      })), started.uploadId, index);
    }
    let received;
    const response = await api.complete(context(bucket, new Request("https://miniapp.example/complete", { method: "POST", headers: { cookie: "session=one" } })), started.uploadId, {
      knowledgeApi: { async uploadFile(upstream) {
        const form = await upstream.request.formData();
        received = form.get("file");
        assert.equal(upstream.request.headers.get("cookie"), "session=one");
        return { item: { id: "file-1", name: received.name } };
      } },
      miniappFacadeApi: { async proxyRuntime() { throw new Error("unexpected runtime upload"); } }
    });
    assert.equal(response.status, 201);
    assert.equal(received.name, "notes.md");
    assert.equal(received.type, "text/markdown");
    assert.equal(received.size, 4 * 1024 * 1024 + 3);
    assert.equal((await received.arrayBuffer()).byteLength, 4 * 1024 * 1024 + 3);
    assert.equal(bucket.objects.size, 0);
  });

  it("preserves common file formats and raw bytes when completing a Knowledge upload", async () => {
    const samples = [
      ["page.html", "text/html", new TextEncoder().encode("<h1>Report</h1>")],
      ["report.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.4\n")],
      ["photo.png", "image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      ["table.csv", "text/csv", new TextEncoder().encode("name,value\nA,1\n")],
      ["archive.zip", "application/zip", new Uint8Array([80, 75, 3, 4, 0, 0])]
    ];
    for (const [fileName, mediaType, bytes] of samples) {
      const bucket = stagingBucket();
      const api = createMiniappFileUploadApi({ readOwner: async () => "user-1" });
      const started = await api.start(context(bucket, new Request("https://miniapp.example/start", {
        method: "POST", body: JSON.stringify({ target: "knowledge", fileName, mediaType, sizeBytes: bytes.byteLength })
      })));
      await api.putChunk(context(bucket, new Request("https://miniapp.example/chunk", {
        method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes
      })), started.uploadId, 0);
      const response = await api.complete(context(bucket, new Request("https://miniapp.example/complete", { method: "POST" })), started.uploadId, {
        knowledgeApi: { async uploadFile(upstream) {
          const file = (await upstream.request.formData()).get("file");
          assert.equal(file.name, fileName);
          assert.equal(file.type, mediaType);
          assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
          return { item: { id: "file-1" } };
        } },
        miniappFacadeApi: { async proxyRuntime() { throw new Error("unexpected runtime upload"); } }
      });
      assert.equal(response.status, 201);
      assert.equal(bucket.objects.size, 0);
    }
  });

  it("binds staged chunks to the Workspace user and forwards the Mate token at completion", async () => {
    const bucket = stagingBucket();
    let ownerId = "user-1";
    const api = createMiniappFileUploadApi({ readOwner: async () => ownerId });
    const started = await api.start(context(bucket, new Request("https://miniapp.example/start", {
      method: "POST", body: JSON.stringify({ target: "mate", fileName: "note.txt", mediaType: "text/plain", sizeBytes: 4, mateId: "mate-1" })
    })));
    ownerId = "user-2";
    await assert.rejects(() => api.putChunk(context(bucket, new Request("https://miniapp.example/chunk", {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "note"
    })), started.uploadId, 0), { status: 404 });
    ownerId = "user-1";
    await api.putChunk(context(bucket, new Request("https://miniapp.example/chunk", {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "note"
    })), started.uploadId, 0);
    const response = await api.complete(context(bucket, new Request("https://miniapp.example/complete", {
      method: "POST", headers: { authorization: "Bearer runtime-token", cookie: "session=one" }
    })), started.uploadId, {
      knowledgeApi: { async uploadFile() { throw new Error("unexpected Knowledge upload"); } },
      miniappFacadeApi: { async proxyRuntime(upstream, path) {
        assert.equal(path, "/v1/mates/mate-1/workspace-attachments");
        assert.equal(upstream.request.headers.get("authorization"), "Bearer runtime-token");
        assert.equal((await upstream.request.formData()).get("file").name, "note.txt");
        return Response.json({ file: { objectId: "artifact-1" } }, { status: 201 });
      } }
    });
    assert.equal(response.status, 201);
    assert.equal(bucket.objects.size, 0);
  });

  it("rejects missing or wrong-size chunks before contacting an upstream", async () => {
    const bucket = stagingBucket();
    const api = createMiniappFileUploadApi({ readOwner: async () => "user-1" });
    const started = await api.start(context(bucket, new Request("https://miniapp.example/start", {
      method: "POST", body: JSON.stringify({ target: "knowledge", fileName: "note.md", sizeBytes: 4 })
    })));
    await assert.rejects(() => api.putChunk(context(bucket, new Request("https://miniapp.example/chunk", {
      method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "bad"
    })), started.uploadId, 0), { status: 400, message: "upload_chunk_size_invalid" });
    await assert.rejects(() => api.complete(context(bucket, new Request("https://miniapp.example/complete", { method: "POST" })), started.uploadId, {
      knowledgeApi: { async uploadFile() { throw new Error("upstream must not be called"); } },
      miniappFacadeApi: { async proxyRuntime() { throw new Error("upstream must not be called"); } }
    }), { status: 409, message: "upload_chunk_missing" });
  });
});
