import { HttpError } from './http.ts';

export const THUMBNAIL_TRANSFORM = { width: 640, height: 640, fit: 'scale-down' as const };
const MAX_INPUT = 20_000_000;
const MAX_OUTPUT = 512 * 1024;

/** Never makes private source URLs public. Authorization precedes even a cache hit. */
export async function workspaceThumbnail(source: Response, images: ImagesBinding | undefined, identity: string, cache?: Cache) {
  if (!source.ok || !source.body) throw new HttpError(502, 'thumbnail_source_unavailable');
  const type = (source.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(jpeg|png|webp|gif|avif|heic|heif|bmp)$/.test(type)) {
    await source.body.cancel();
    throw new HttpError(415, 'thumbnail_type_unsupported');
  }
  if (Number(source.headers.get('content-length')) > MAX_INPUT) {
    await source.body.cancel();
    throw new HttpError(413, 'thumbnail_source_too_large');
  }
  // A source without a trustworthy version is transformed afresh, never served stale.
  const version = source.headers.get('etag');
  const key = version ? new Request(`https://runtime.example.invalid/__private-thumbnails/v1/${await digest(JSON.stringify([identity, version]))}`) : undefined;
  if (cache && key) {
    try {
      const hit = await cache.match(key);
      if (hit) { await source.body.cancel(); return privateResponse(hit); }
    } catch { /* Cache availability must not block a permitted transform. */ }
  }
  if (!images) { await source.body.cancel(); throw new HttpError(503, 'thumbnail_service_unavailable'); }
  try {
    let received = 0;
    const bounded = source.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAX_INPUT) throw new Error('thumbnail_source_too_large');
        controller.enqueue(chunk);
      }
    }));
    const output = (await images.input(bounded).transform(THUMBNAIL_TRANSFORM)
      .output({ format: 'image/jpeg', quality: 75, anim: false })).response();
    if (!output.ok || !output.body) throw new Error('thumbnail_transform_failed');
    const reader = output.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_OUTPUT) { await reader.cancel(); throw new Error('thumbnail_output_too_large'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (!length) throw new Error('thumbnail_empty');
    const response = new Response(bytes, { headers: {
      'Content-Type': 'image/jpeg', 'Content-Length': String(length),
      'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff'
    } });
    if (cache && key) { try { await cache.put(key, response.clone()); } catch { /* Optional optimization. */ } }
    return privateResponse(response);
  } catch {
    // Do not silently send a multi-megabyte original when transformation is unavailable.
    throw new HttpError(503, 'thumbnail_transform_unavailable');
  }
}

function privateResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Disposition', 'inline; filename="thumbnail.jpg"');
  return new Response(response.body, { headers });
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
