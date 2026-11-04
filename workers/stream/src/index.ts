const BASIC_UPLOAD_BYTES = 200_000_000;
const MAX_UPLOAD_BYTES = 30_000_000_000 - 1;
const MAX_UPLOAD_DURATION_SECONDS = 36_000;
// The native basic-POST API rejects expiry >= 6 hours. TUS accepts a longer
// window so large uploads can still resume on the following day.
const POST_UPLOAD_TTL_MS = 60 * 60 * 1000;
const TUS_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

type VideoDetails = {
  duration?: number;
  hlsPlaybackUrl?: string;
  playback?: { hls?: string };
  readyToStream?: boolean;
  thumbnail?: string;
  status?: { state?: string; errorReasonCode?: string };
};
export type StreamEnv = {
  APPS_DB: D1Database;
  STREAM?: {
    createDirectUpload(params: Record<string, unknown>): Promise<{ id: string; uploadURL: string }>;
    video(id: string): {
      details(): Promise<VideoDetails>;
      generateToken(): Promise<string>;
      delete(): Promise<void>;
    };
  };
  CF_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
};
type Authority = { app_id: string; org_id: string };
type StoredVideo = Authority & {
  id: string; object_id: string; uploaded_by: string; file_name: string; mime_type: string;
  size_bytes: number; max_duration_seconds: number; stream_uid: string | null;
  state: string; upload_url: string | null; protocol: string | null; expires_at: string;
};
class StreamError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export default { fetch: handleStreamRequest };

export async function handleStreamRequest(request: Request, env: StreamEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      const ready = Boolean(env.STREAM && env.CF_ACCOUNT_ID && env.CF_STREAM_API_TOKEN);
      return json({ ok: ready, service: "workspace-stream-worker", capabilities: ["app-stream-v1"],
        directUpload: Boolean(env.STREAM), tusUpload: Boolean(env.CF_ACCOUNT_ID && env.CF_STREAM_API_TOKEN) }, ready ? 200 : 503);
    }
    const authority = await authorize(request, env);
    if (!env.STREAM) throw new StreamError(503, "stream_service_not_configured");
    if (url.pathname === "/v1/uploads" && request.method === "POST") {
      return json(await beginUpload(request, env, authority), 201);
    }
    if (url.pathname === "/v1/videos" && request.method === "GET") {
      const videos = await env.APPS_DB.prepare(`SELECT object_id AS objectId, stream_uid AS streamUid,
        state, file_name AS fileName, size_bytes AS sizeBytes, created_at AS createdAt
        FROM apps_stream_videos WHERE app_id = ? AND org_id = ? AND state != 'deleted'
        ORDER BY created_at DESC, id DESC LIMIT 100`).bind(authority.app_id, authority.org_id).all();
      return json({ videos: videos.results });
    }
    const match = url.pathname.match(/^\/v1\/videos\/([a-zA-Z0-9_-]+)(\/playback)?$/);
    if (!match) throw new StreamError(404, "stream_route_not_found");
    const video = await env.APPS_DB.prepare(`SELECT * FROM apps_stream_videos
      WHERE stream_uid = ? AND app_id = ? AND org_id = ? AND state != 'deleted'`)
      .bind(match[1], authority.app_id, authority.org_id).first<StoredVideo>();
    if (!video) throw new StreamError(404, "stream_video_not_found");
    const handle = env.STREAM.video(match[1]);
    if (request.method === "GET" && !match[2]) {
      return json({ video: publicDetails(video, await handle.details()) });
    }
    if (request.method === "POST" && match[2]) {
      const details = await handle.details();
      if (!details.readyToStream) throw new StreamError(409, "stream_video_processing");
      const token = await handle.generateToken();
      const hls = details.hlsPlaybackUrl || details.playback?.hls;
      if (!hls) throw new StreamError(502, "stream_playback_unavailable");
      const source = new URL(hls);
      if (source.protocol !== "https:" || !(source.hostname.endsWith(".cloudflarestream.com") || source.hostname === "videodelivery.net")) {
        throw new StreamError(502, "stream_playback_origin_invalid");
      }
      const playbackUrl = source.hostname === "videodelivery.net"
        ? `https://iframe.videodelivery.net/${encodeURIComponent(token)}`
        : `${source.origin}/${encodeURIComponent(token)}/iframe`;
      return json({ video: publicDetails(video, details), playbackUrl });
    }
    if (request.method === "DELETE" && !match[2]) {
      await handle.delete();
      await env.APPS_DB.prepare("UPDATE apps_stream_videos SET state = 'deleted', upload_url = NULL, updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), video.id).run();
      return json({ deleted: true, streamUid: video.stream_uid });
    }
    throw new StreamError(405, "method_not_allowed");
  } catch (error) {
    // Never log request bodies, capability tokens or upload/playback URLs.
    return json({ error: error instanceof StreamError ? error.code : "stream_service_request_failed" },
      error instanceof StreamError ? error.status : 502);
  }
}

async function authorize(request: Request, env: StreamEnv): Promise<Authority> {
  const token = request.headers.get("Authorization")?.match(/^Bearer (fstream_[a-f0-9]{64})$/)?.[1];
  if (!token) throw new StreamError(401, "stream_app_unauthorized");
  const hash = await tokenHash(token);
  // Bind identity to the server-issued grant, never to an appId supplied by the caller.
  const grant = await env.APPS_DB.prepare(`SELECT g.app_id, g.org_id FROM apps_stream_app_grants g
    JOIN apps_apps a ON a.id = g.app_id AND a.org_id = g.org_id
    WHERE g.token_sha256 = ? AND a.status != 'archived'
      AND EXISTS (SELECT 1 FROM apps_app_resources r WHERE r.app_id = a.id
        AND r.type = 'media' AND r.environment = 'prod' AND r.status = 'ready')`)
    .bind(hash).first<Authority>();
  if (!grant) throw new StreamError(403, "stream_app_access_denied");
  return grant;
}

async function beginUpload(request: Request, env: StreamEnv, app: Authority) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { throw new StreamError(400, "invalid_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new StreamError(400, "invalid_json");
  const objectId = requiredText(body.objectId, 160);
  const uploadedBy = requiredText(body.userId, 160);
  const fileName = requiredText(body.fileName, 200);
  const mimeType = requiredText(body.mimeType, 100);
  if (!["video/mp4", "video/webm", "video/quicktime"].includes(mimeType)) throw new StreamError(400, "unsupported_video_type");
  const sizeBytes = boundedInteger(body.sizeBytes, MAX_UPLOAD_BYTES);
  const maxDurationSeconds = boundedInteger(body.maxDurationSeconds ?? MAX_UPLOAD_DURATION_SECONDS, MAX_UPLOAD_DURATION_SECONDS);
  const protocol = sizeBytes > BASIC_UPLOAD_BYTES ? "tus" : "post";
  if (protocol === "tus" && (!env.CF_ACCOUNT_ID || !env.CF_STREAM_API_TOKEN)) {
    throw new StreamError(503, "stream_tus_not_configured");
  }
  const origin = await env.APPS_DB.prepare("SELECT hostname FROM apps_domains WHERE app_id = ? AND type = 'production' LIMIT 1")
    .bind(app.app_id).first<{ hostname: string }>();
  if (!origin?.hostname) throw new StreamError(409, "stream_app_origin_not_configured");
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (protocol === "post" ? POST_UPLOAD_TTL_MS : TUS_UPLOAD_TTL_MS)).toISOString();
  const id = `sv_${crypto.randomUUID().replaceAll("-", "")}`;
  const claimed = await env.APPS_DB.prepare(`INSERT INTO apps_stream_videos
    (id, app_id, org_id, object_id, uploaded_by, file_name, mime_type, size_bytes,
      max_duration_seconds, state, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)
    ON CONFLICT(app_id, object_id) DO NOTHING RETURNING id`)
    .bind(id, app.app_id, app.org_id, objectId, uploadedBy, fileName, mimeType, sizeBytes, maxDurationSeconds, expiresAt, now, now)
    .first<{ id: string }>();
  if (!claimed) {
    const existing = await env.APPS_DB.prepare("SELECT * FROM apps_stream_videos WHERE app_id = ? AND object_id = ?")
      .bind(app.app_id, objectId).first<StoredVideo>();
    if (existing?.state === "uploading" && existing.file_name === fileName && existing.mime_type === mimeType
      && existing.size_bytes === sizeBytes && existing.max_duration_seconds === maxDurationSeconds
      && existing.uploaded_by === uploadedBy && Date.parse(existing.expires_at) > Date.now()) return uploadResult(existing);
    throw new StreamError(409, "stream_upload_already_started");
  }
  // Record ownership before contacting Stream. Concurrent retries cannot create another video.
  const meta = { workspaceAppId: app.app_id, workspaceOrgId: app.org_id, workspaceAssetId: id,
    objectId, uploadedBy, name: fileName };
  let upload: { id: string; uploadURL: string };
  try {
    if (protocol === "post") {
      upload = await env.STREAM!.createDirectUpload({ creator: app.app_id, meta, expiry: expiresAt,
        maxDurationSeconds, allowedOrigins: [origin.hostname], requireSignedURLs: true });
    } else {
      upload = await createTusUpload(env, { sizeBytes, maxDurationSeconds, expiresAt, origin: origin.hostname, meta, appId: app.app_id });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(upload.id) || new URL(upload.uploadURL).protocol !== "https:") {
      throw new StreamError(502, "stream_upload_response_invalid");
    }
  } catch (error) {
    await env.APPS_DB.prepare("UPDATE apps_stream_videos SET state = 'failed', updated_at = ? WHERE id = ?").bind(now, id).run();
    // A transport failure can have created an upstream video; do not blindly retry it.
    throw error;
  }
  await env.APPS_DB.prepare(`UPDATE apps_stream_videos SET stream_uid = ?, upload_url = ?, protocol = ?,
    state = 'uploading', updated_at = ? WHERE id = ?`).bind(upload.id, upload.uploadURL, protocol, now, id).run();
  return uploadResult({ stream_uid: upload.id, upload_url: upload.uploadURL, protocol, expires_at: expiresAt });
}

async function createTusUpload(env: StreamEnv, input: {
  sizeBytes: number; maxDurationSeconds: number; expiresAt: string; origin: string; meta: Record<string, string>; appId: string;
}) {
  const metadata = { ...input.meta, maxDurationSeconds: String(input.maxDurationSeconds), expiry: input.expiresAt,
    // TUS metadata is a base64-encoded string, not a JSON array. Stream treats
    // JSON syntax as part of the hostname, which breaks Referer-based playback.
    allowedorigins: input.origin };
  const encoded = Object.entries(metadata).map(([key, value]) => `${key} ${base64(value)}`);
  encoded.push("requiresignedurls");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID!)}/stream?direct_user=true`, {
    // Workers rejects redirect: "error" before sending the request. Return 3xx
    // responses unchanged so the status check below rejects them without forwarding credentials.
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${env.CF_STREAM_API_TOKEN}`, "Tus-Resumable": "1.0.0",
      "Upload-Length": String(input.sizeBytes), "Upload-Creator": input.appId, "Upload-Metadata": encoded.join(",") },
  });
  if (!response.ok) throw new StreamError(502, "stream_upload_creation_failed");
  const location = response.headers.get("Location");
  const id = response.headers.get("stream-media-id");
  if (!location || !id) throw new StreamError(502, "stream_upload_response_invalid");
  return { id, uploadURL: new URL(location, "https://api.cloudflare.com").toString() };
}

function publicDetails(video: StoredVideo, details: VideoDetails) {
  return { objectId: video.object_id, streamUid: video.stream_uid, readyToStream: details.readyToStream === true,
    duration: details.duration, thumbnail: details.thumbnail, status: details.status };
}
function uploadResult(video: Pick<StoredVideo, "stream_uid" | "upload_url" | "protocol" | "expires_at">) {
  return { provider: "media", streamUid: video.stream_uid, uploadUrl: video.upload_url, protocol: video.protocol,
    expiresAt: video.expires_at, maxSizeBytes: MAX_UPLOAD_BYTES, chunkSizeBytes: video.protocol === "tus" ? 50 * 1024 * 1024 : undefined };
}
function requiredText(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new StreamError(400, "invalid_upload_parameter");
  return value.trim();
}
function boundedInteger(value: unknown, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new StreamError(400, "invalid_upload_parameter");
  return value;
}
function base64(value: string) { return btoa(String.fromCharCode(...new TextEncoder().encode(value))); }
export async function tokenHash(token: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
