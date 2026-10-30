import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateImage } from "./publicCapabilityTools.ts";
import { platformToolDefinitions } from "./toolDefinitions/platform.ts";

const png = new Uint8Array(24);
png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
new DataView(png.buffer).setUint32(16, 1024);
new DataView(png.buffer).setUint32(20, 1536);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const webp = new TextEncoder().encode("RIFF0000WEBPVP8X");
const principal = { orgId: "org-1", sub: "user-1", scopes: [] };
const upstream = "https://media.example/generated.png";

function fixture(run = async () => ({ state: "Completed", result: { image: upstream } })) {
  const writes = [];
  const env = {
    AI: { run }, MCP_RESOURCE_URL: "https://mcp.example",
    MATE_ARTIFACTS: { put: async (key, body, options) => {
      assert.ok(body instanceof ArrayBuffer, "images must have a known length for R2");
      const bytes = new Uint8Array(body);
      writes.push({ key, bytes, options });
      return { size: bytes.length };
    } }
  };
  return { env, writes };
}

async function withFetch(handler, work) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await work(); } finally { globalThis.fetch = original; }
}

describe("Cloudflare GPT Image 2.5 models", () => {
  it("defaults to Flare, forwards native options and privately stores downloaded PNG bytes", async () => {
    const { env, writes } = fixture(async (model, input) => {
      assert.equal(model, "openai/gpt-image-2.5-flare");
      assert.deepEqual(input, { prompt: "Workshop poster", size: "1024x1536", quality: "high", output_format: "png", background: "opaque" });
      return { state: "Completed", result: { image: upstream }, usage: { test: 1 } };
    });
    const result = await withFetch(async (url, options) => {
      assert.equal(String(url), upstream);
      assert.equal(options.redirect, "manual");
      return new Response(png, { headers: { "content-type": "image/png" } });
    }, () => generateImage(env, { prompt: "Workshop poster", size: "1024x1536", quality: "high", background: "opaque" }, principal));
    assert.deepEqual(writes[0].bytes, png);
    assert.equal(writes[0].options.httpMetadata.contentType, "image/png");
    assert.equal(writes[0].options.customMetadata.fileName, "generated-image.png");
    assert.equal(writes[0].options.customMetadata.userId, principal.sub);
    assert.equal(result.model, "openai/gpt-image-2.5-flare");
    assert.equal(result.outputFormat, "png");
    assert.equal(result.width, 1024);
    assert.equal(result.height, 1536);
    assert.equal(result.sizeBytes, png.length);
    assert.deepEqual(result.usage, { test: 1 });
    assert.match(result.imageUrl, /^https:\/\/mcp.example\/artifacts\/org-1\/user-1\/direct\/art_.*\?token=/);
    assert.ok(Date.parse(result.expiresAt) > Date.now());
  });

  it("uses Sunburst for sixteen-reference edits and converts HTTPS inputs to base64", async () => {
    const reference = "https://media.example/reference.jpeg";
    const data = `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;
    const original = globalThis.fetch;
    const { env, writes } = fixture(async (model, input) => {
      assert.equal(model, "openai/gpt-image-2.5-sunburst");
      assert.deepEqual(input, { prompt: "Restyle references", size: "auto", quality: "xhigh", output_format: "webp", images: Array(16).fill(data) });
      return { result: { state: "Completed", result: { image: upstream, usage: { test: 2 } } } };
    });
    const result = await withFetch(async (url, options) => {
      if (String(url).startsWith("data:")) return original(url, options);
      return new Response(String(url) === reference ? jpeg : webp, { headers: { "content-type": String(url) === reference ? "image/jpeg" : "image/webp" } });
    }, () => generateImage(env, { model: "gpt-image-2.5-sunburst", prompt: "Restyle references", size: "auto", quality: "xhigh", outputFormat: "webp", images: [reference, ...Array(15).fill(data)] }, principal));
    assert.equal(writes.length, 1);
    assert.equal(result.outputFormat, "webp");
    assert.equal(writes[0].options.httpMetadata.contentType, "image/webp");
    assert.equal(writes[0].options.customMetadata.fileName, "generated-image.webp");
    assert.equal(result.width, undefined, "auto must not invent output dimensions");
    assert.deepEqual(result.usage, { test: 2 });
  });

  it("preserves requested JPEG metadata and passes max quality without diffusion-step mapping", async () => {
    const { env, writes } = fixture(async (model, input) => {
      assert.equal(input.quality, "max");
      assert.equal(input.output_format, "jpeg");
      return { image: upstream };
    });
    const result = await withFetch(async () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }), () => generateImage(env, { prompt: "Poster", outputFormat: "jpeg", quality: "max" }, principal));
    assert.equal(result.outputFormat, "jpeg");
    assert.equal(writes[0].options.customMetadata.fileName, "generated-image.jpeg");
  });

  it("rejects removed models, seed, invalid references and unsupported options before inference", async () => {
    const { env, writes } = fixture(async () => assert.fail("must not call AI"));
    for (const args of [
      { model: "lucid-origin" }, { model: "flux-2-klein-9b" }, { model: "unlisted" },
      { background: "transparent" }, { outputFormat: "gif" }, { seed: 42 },
      { images: Array(17).fill(upstream) }, { images: [null] },
      { images: ["https://127.0.0.1/image.jpg"] }, { images: ["https://localhost/image.jpg"] },
      { images: ["data:text/plain;base64,AAAA"] }
    ]) await assert.rejects(generateImage(env, { prompt: "Poster", ...args }, principal), (error) => error.status === 400 || error.status === 403);
    assert.equal(writes.length, 0);
  });

  it("does not spend on inference without artifact storage", async () => {
    await assert.rejects(generateImage({ AI: { run: async () => assert.fail("must not call AI") } }, { prompt: "Poster" }, principal), /mate_artifact_storage_not_configured/);
  });

  it("bounds the total reference payload before inference", async () => {
    const { env, writes } = fixture(async () => assert.fail("must not call AI"));
    await withFetch(async () => new Response(new Uint8Array(10_000_001), { headers: { "content-type": "image/png" } }), async () => {
      await assert.rejects(generateImage(env, { prompt: "Edit references", images: [upstream, upstream] }, principal), /image_inputs_too_large/);
      assert.equal(writes.length, 0);
    });
  });

  it("rejects incomplete and missing upstream images without fetching or storing", async () => {
    await withFetch(async () => assert.fail("must not fetch"), async () => {
      for (const response of [{}, { state: "Running", result: { image: upstream } }, { state: "Failed", result: { image: upstream } }, { state: "Completed", result: {} }]) {
        const { env, writes } = fixture(async () => response);
        await assert.rejects(generateImage(env, { prompt: "Poster" }, principal), /image_generation_/);
        assert.equal(writes.length, 0);
      }
    });
  });

  it("rejects private output URLs and invalid, redirected or oversized downloads", async () => {
    const { env: privateEnv } = fixture(async () => ({ image: "https://127.0.0.1/private.png" }));
    await assert.rejects(generateImage(privateEnv, { prompt: "Poster" }, principal), /private_address_blocked/);
    for (const response of [
      new Response("bad", { headers: { "content-type": "image/png" } }),
      new Response("bad", { headers: { "content-type": "text/html" } }),
      new Response(null, { status: 302, headers: { location: upstream } }),
      new Response(png, { headers: { "content-type": "image/png", "content-length": "50000001" } })
    ]) {
      const { env, writes } = fixture();
      await withFetch(async () => response, async () => {
        await assert.rejects(generateImage(env, { prompt: "Poster" }, principal));
        assert.equal(writes.length, 0);
      });
    }
  });

  it("publishes the two selected models, references and output formats", () => {
    const schema = platformToolDefinitions.find((tool) => tool.name === "image_generation").inputSchema;
    assert.deepEqual(schema.properties.model.enum, ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
    assert.equal(schema.properties.model.default, "gpt-image-2.5-flare");
    assert.equal(schema.properties.images.maxItems, 16);
    assert.deepEqual(schema.properties.outputFormat.enum, ["png", "webp", "jpeg"]);
    assert.equal(schema.properties.seed, undefined);
  });
});
