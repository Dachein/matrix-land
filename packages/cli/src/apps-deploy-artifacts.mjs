import { installationOptions } from "./installation.mjs";
import { authenticatedRequest, responsePayload } from "./api-client.mjs";

export async function uploadAppsDeployArtifact(store, input, options = {}) {
  const artifact = input.artifact;
  if (!artifact?.archive) throw new Error("Deployment artifact archive is required");
  const url = deployArtifactCollectionUrl(input.appId, options);
  if (input.version) url.searchParams.set("version", input.version);
  const response = await authenticatedRequest(store, url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/zip",
      "Content-Length": String(artifact.archive.byteLength),
      "X-Workspace-Deploy-Archive-Sha256": artifact.archiveSha256,
      "X-Workspace-Deploy-Content-Sha256": artifact.contentSha256,
      "X-Workspace-Deploy-Content-Size": String(artifact.contentSizeBytes),
      "X-Workspace-Deploy-Entrypoint": artifact.entrypoint,
      "X-Workspace-Deploy-File-Count": String(artifact.fileCount),
      "X-Workspace-Deploy-Target": artifact.target
    },
    body: artifact.archive
  }, options);
  return {
    ...(await responsePayload(response)),
    local: deploymentArtifactSummary(artifact)
  };
}

export function deploymentArtifactSummary(artifact) {
  const assetPrefix = artifact.assets ? `${artifact.assets.directory}/` : undefined;
  const staticAssetFileCount = assetPrefix
    ? artifact.manifest.files.filter((file) => file.path.startsWith(assetPrefix)).length
    : 0;
  return {
    archiveName: artifact.archiveName,
    archiveSha256: artifact.archiveSha256,
    archiveSizeBytes: artifact.archive.byteLength,
    assets: artifact.assets,
    contentSha256: artifact.contentSha256,
    contentSizeBytes: artifact.contentSizeBytes,
    entrypoint: artifact.entrypoint,
    fileBreakdown: artifact.target === "worker"
      ? { staticAssets: staticAssetFileCount, workerModules: artifact.fileCount - staticAssetFileCount }
      : { pagesFiles: artifact.fileCount },
    fileCount: artifact.fileCount,
    root: artifact.root,
    skippedSymlinkCount: artifact.skippedSymlinkCount,
    schemaVersion: artifact.manifest.schemaVersion,
    target: artifact.target
  };
}

function deployArtifactCollectionUrl(appId, options) {
  const apiUrl = (installationOptions(options).apiUrl).replace(/\/+$/, "");
  return new URL(`${apiUrl}/api/apps/apps/${encodeURIComponent(appId)}/deploy-artifacts`);
}
