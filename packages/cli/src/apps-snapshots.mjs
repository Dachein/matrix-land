import { installationOptions } from "./installation.mjs";
import { authenticatedRequest, responsePayload } from "./api-client.mjs";
import { createSourceSnapshot } from "./source-snapshot.mjs";

export async function uploadAppsSourceSnapshot(store, input, options = {}) {
  const snapshot = options.snapshot ?? await createSourceSnapshot(input.source ?? ".", {
    ...options.snapshotOptions,
    ignoreRules: [...(options.snapshotOptions?.ignoreRules ?? []), ...(input.sourceExcludes ?? [])]
  });
  if (input.dryRun) {
    return {
      dryRun: true,
      metadata: {
        notes: input.notes ?? "",
        purpose: input.purpose ?? "backup",
        version: input.version ?? "",
        versionName: input.versionName ?? ""
      },
      snapshot: snapshotSummary(snapshot)
    };
  }

  const url = snapshotCollectionUrl(input.appId, options);
  if (input.version) url.searchParams.set("version", input.version);
  const metadata = Buffer.from(JSON.stringify({
    notes: input.notes ?? "",
    purpose: input.purpose ?? "backup",
    version: input.version ?? "",
    versionName: input.versionName ?? ""
  }), "utf8").toString("base64url");
  const response = await authenticatedRequest(store, url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/zip",
      "Content-Length": String(snapshot.archive.byteLength),
      "X-Workspace-Source-Archive-Sha256": snapshot.archiveSha256,
      "X-Workspace-Source-Content-Sha256": snapshot.contentSha256,
      "X-Workspace-Source-File-Count": String(snapshot.fileCount),
      "X-Workspace-Source-Metadata": metadata,
      "X-Workspace-Source-Size": String(snapshot.sourceSizeBytes)
    },
    body: snapshot.archive
  }, options);
  const payload = await responsePayload(response);
  return {
    ...payload,
    local: snapshotSummary(snapshot)
  };
}

export async function listAppsSourceSnapshots(store, appId, options = {}) {
  const response = await authenticatedRequest(store, snapshotCollectionUrl(appId, options), {
    headers: { Accept: "application/json" }
  }, options);
  return responsePayload(response);
}

export async function downloadAppsSourceSnapshot(store, input, options = {}) {
  const base = snapshotCollectionUrl(input.appId, options);
  base.pathname = `${base.pathname}/${encodeURIComponent(input.snapshotId)}/download`;
  const response = await authenticatedRequest(store, base, {
    headers: { Accept: "application/zip" }
  }, options);
  if (!response.ok) await responsePayload(response);
  return {
    archive: new Uint8Array(await response.arrayBuffer()),
    archiveSha256: response.headers.get("x-workspace-source-archive-sha256") ?? undefined,
    fileName: responseFileName(response) ?? `${input.appId}-${input.snapshotId}.zip`
  };
}

function snapshotCollectionUrl(appId, options) {
  const apiUrl = (installationOptions(options).apiUrl).replace(/\/+$/, "");
  return new URL(`${apiUrl}/api/apps/apps/${encodeURIComponent(appId)}/source-snapshots`);
}

function snapshotSummary(snapshot) {
  return {
    archiveName: snapshot.archiveName,
    archiveSha256: snapshot.archiveSha256,
    archiveSizeBytes: snapshot.archive.byteLength,
    contentSha256: snapshot.contentSha256,
    fileCount: snapshot.fileCount,
    root: snapshot.root,
    skippedSymlinkCount: snapshot.skippedSymlinkCount,
    sourceExcludes: snapshot.sourceExcludes,
    sourceSizeBytes: snapshot.sourceSizeBytes
  };
}

function responseFileName(response) {
  const disposition = response.headers.get("content-disposition") ?? "";
  return disposition.match(/filename="([^"]+)"/i)?.[1];
}
