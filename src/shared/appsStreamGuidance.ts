/** Safe to copy: names and contracts only, never runtime credential values. */
export function appStreamDevelopmentPrompt(appId: string) {
  return `## Workspace Stream: access and authorization

App ID: ${appId}. Enabling the media resource registers this App with the shared workspace-stream-worker. The platform creates an App-scoped grant and automatically injects the WORKSPACE_STREAM service binding and WORKSPACE_STREAM_TOKEN server secret. Do not request Cloudflare account IDs, API tokens or a native STREAM binding. Do not expose the App grant in browser code, CLI descriptors, logs or copied Prompts.

App registration and video ownership are persisted by the platform. Do not create a second registration table in the App database or register arbitrary Stream UIDs. Keep only the local business record and its returned streamUid. Other Apps' videos are inaccessible even when their UIDs are known.

Before calling the service, verify the current Workspace user and the App's content role. The App grant authenticates the backend, not an end user. userId must come from the verified session. The service derives App identity and allowed playback origins from platform registration, never caller-supplied appId or origin fields.

Server request example (after checking the user's upload permission):
\x60\x60\x60ts
const response = await env.WORKSPACE_STREAM.fetch(new Request("https://workspace-stream.internal/v1/uploads", {
  method: "POST",
  headers: { Authorization: \x60Bearer \x24{env.WORKSPACE_STREAM_TOKEN}\x60, "Content-Type": "application/json" },
  body: JSON.stringify({ objectId: localVideo.id, userId: workspaceUser.id, fileName, mimeType, sizeBytes }),
}));
const result = await response.json();
if (!response.ok) throw new Error(result.error);
// Persist result.streamUid on the draft. Return only the temporary upload descriptor to the authorized uploader.
\x60\x60\x60

API (all requests use the same server-only Bearer credential):
- POST /v1/uploads: objectId (stable App-local draft ID), userId, fileName, mimeType, sizeBytes; optional maxDurationSeconds (1–43200). Supports video/mp4, video/webm, video/quicktime, files smaller than 30 GB. Returns provider="media", streamUid, uploadUrl, protocol="post"|"tus", expiresAt, maxSizeBytes, optional chunkSizeBytes. At most 200 MB uses multipart POST, larger files use TUS. The upload URL lasts 24 hours. Identical preparation retries reuse the same allocation; changed parameters or an unresolved allocation return 409. Do not automatically create another draft after a timeout.
- GET /v1/videos/:streamUid: returns {video:{objectId,streamUid,readyToStream,duration,thumbnail,status}}.
- POST /v1/videos/:streamUid/playback: after checking the viewer's permission, returns {video,playbackUrl} with a temporary signed player URL; 409 while processing. Do not persist playbackUrl as a permanent URL.
- GET /v1/videos: returns up to 100 most recent App-owned allocations, without upload URLs.
- DELETE /v1/videos/:streamUid: irreversible removal of an App-owned video; require explicit deletion authorization.

CLI flow: expose an authorized App MCP preparation tool that calls POST /v1/uploads. Supply a version:1, provider:"media" upload descriptor whose prepare action uses transport:"mcp", tool:"app_mcp_tool_call", and arguments {appId:"${appId}",toolName:<your registered begin-upload tool>,confirmation:true,arguments:{videoId:<draft ID>,fileName:{$file:"fileName"},mimeType:{$file:"mimeType"},sizeBytes:{$file:"sizeBytes"}}}. Adapt videoId to your tool's actual schema. Map the preparation result's uploadUrl and protocol if wrapped. Run frontier-workspace upload --file <local path> --request-file <private descriptor>. Workspace CLI sends bytes directly to Stream and supports --resume for TUS. No R2 staging is involved. Never put WORKSPACE_STREAM_TOKEN in the descriptor.

Upload completion and playback readiness are different states. Poll video details or check them before publication; publish only when readyToStream is true. Preserve upstream 401/403/409/503 errors and do not fall back to R2 or another provider. If platform registration is not ready, correct the resource configuration; do not ask the App author for a Cloudflare secret.`;
}
