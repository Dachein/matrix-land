import { HttpError, type Env } from "./types.ts";

export const IMAGE_MODELS = {
  "gpt-image-2.5-flare": "openai/gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst": "openai/gpt-image-2.5-sunburst"
} as const;

export async function runImageModel(env: Env, args: Record<string, unknown>, prompt: string, size: string, quality: string) {
  const selection = args.model === undefined ? "gpt-image-2.5-flare" : args.model;
  if (typeof selection !== "string" || !Object.hasOwn(IMAGE_MODELS, selection)) {
    throw new HttpError(400, "image_model_unsupported");
  }
  const model = IMAGE_MODELS[selection as keyof typeof IMAGE_MODELS];
  const dimensions = size === "auto" ? [] : size.split("x").map(Number);
  if (args.background === "transparent") throw new HttpError(400, "image_transparency_unsupported");
  if (args.seed !== undefined) throw new HttpError(400, "image_seed_unsupported");
  const requestedFormat = args.outputFormat ?? "png";
  const images = args.images === undefined ? [] : args.images;
  if (!Array.isArray(images) || images.length > 16 || images.some((value) => typeof value !== "string")) {
    throw new HttpError(400, "image_inputs_invalid");
  }
  const references: string[] = [];
  let referenceBytes = 0;
  for (const image of images) {
    const response = await imageInput(image);
    const bytes = new Uint8Array(await response.arrayBuffer());
    referenceBytes += bytes.length;
    if (referenceBytes > 20_000_000) throw new HttpError(413, "image_inputs_too_large");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    references.push(`data:${response.headers.get("content-type")};base64,${btoa(binary)}`);
  }
  const input = {
    prompt, size, quality, output_format: requestedFormat,
    ...(args.background === undefined ? {} : { background: args.background }),
    ...(references.length ? { images: references } : {})
  };
  const result = await env.AI!.run(model as never, input as never) as unknown as Record<string, unknown>;
  // The binding returns { state, result }; REST/proxies may wrap that once more.
  const envelope = asRecord(result.result)?.state ? asRecord(result.result)! : result;
  if (envelope.state !== undefined && envelope.state !== "Completed") throw new HttpError(502, "image_generation_incomplete");
  const payload = asRecord(envelope.result) ?? envelope;
  if (typeof payload.image !== "string" || !payload.image) throw new HttpError(502, "image_generation_missing_result");
  // Fetch the provider URL before it expires, then persist verified bytes privately.
  const downloaded = await imageInput(payload.image, 50_000_000);
  const bytes = new Uint8Array(await downloaded.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  const isWebp = new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  if (!isJpeg && !isPng && !isWebp) throw new HttpError(502, "image_generation_invalid_result");
  const format = isJpeg ? "jpeg" : isPng ? "png" : "webp";
  const [width, height] = isPng && bytes.length >= 24
    ? [new DataView(bytes.buffer).getUint32(16), new DataView(bytes.buffer).getUint32(20)] : dimensions;
  return { model, width, height, format, response: new Response(bytes, { headers: { "content-type": `image/${format}` } }), usage: payload.usage ?? envelope.usage ?? result.usage ?? null };
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function imageInput(value: string, limit = 12_000_000) {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "public_https_url_required"); }
  if (url.protocol === "data:") {
    if (!/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value)) throw new HttpError(400, "image_input_type_unsupported");
  } else {
    // Match the shared media fetch policy; block private hosts and redirects.
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new HttpError(400, "public_https_url_required");
    if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.includes(":")) throw new HttpError(403, "private_address_blocked");
    const octets = host.split(".").map(Number);
    if (octets.length === 4 && octets.every(Number.isInteger)) {
      const [a, b] = octets;
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) throw new HttpError(403, "private_address_blocked");
    }
  }
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new HttpError(502, "image_input_fetch_failed");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (!contentType || !/^image\/(png|jpeg|webp)$/.test(contentType)) throw new HttpError(415, "image_input_type_unsupported");
  if (Number(response.headers.get("content-length")) > limit) throw new HttpError(413, "image_input_too_large");
  const reader = response.body?.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  if (!reader) throw new HttpError(400, "image_input_empty");
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, "image_input_too_large"); }
    chunks.push(new Uint8Array(value));
  }
  return new Response(new Blob(chunks, { type: contentType }));
}
