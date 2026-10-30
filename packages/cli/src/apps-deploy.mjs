import { createDeploymentArtifact } from "./deployment-artifact.mjs";
import { uploadAppsDeployArtifact, deploymentArtifactSummary } from "./apps-deploy-artifacts.mjs";
import { uploadAppsSourceSnapshot } from "./apps-snapshots.mjs";
import { callMcpTool } from "./mcp-client.mjs";
import { mcpToolPayload } from "./mcp-result.mjs";
import { createSourceSnapshot } from "./source-snapshot.mjs";

export async function deployLocalAppsApp(store, input, options = {}) {
  const target = requiredTarget(input.target);
  if (target !== "worker" && (input.cronSchedules?.length || input.queueConsumer)) {
    throw new Error("Cron and Queue consumer topology is supported only for Worker deployments");
  }
  const entrypoint = input.entrypoint || (target === "pages" ? "index.html" : "index.js");
  const [snapshot, artifact] = await Promise.all([
    input.skipSource ? Promise.resolve(undefined) : createSourceSnapshot(input.source || ".", {
      ...options.snapshotOptions,
      ignoreRules: [...(options.snapshotOptions?.ignoreRules ?? []), ...(input.sourceExcludes ?? [])]
    }),
    createDeploymentArtifact(input.deployDir, {
      ...options.artifactOptions,
      target,
      entrypoint,
      assets: input.assetsDirectory ? {
        sourceDirectory: input.assetsDirectory,
        binding: input.assetsBinding,
        htmlHandling: input.assetsHtmlHandling,
        notFoundHandling: input.assetsNotFoundHandling,
        runWorkerFirst: input.assetsRunWorkerFirst
      } : undefined
    })
  ]);

  if (input.dryRun) {
    return {
      dryRun: true,
      release: {
        loginRequired: input.loginRequired,
        notes: input.releaseNotes,
        version: input.version,
        versionName: input.versionName
      },
      sourceSnapshot: snapshot ? sourceSnapshotSummary(snapshot) : undefined,
      sourceSnapshotSkipped: !snapshot,
      deployArtifact: deploymentArtifactSummary(artifact)
    };
  }

  const uploadedSnapshot = snapshot ? await uploadAppsSourceSnapshot(store, {
    appId: input.appId,
    notes: input.releaseNotes,
    purpose: "deployment",
    source: input.source || ".",
    version: input.version,
    versionName: input.versionName
  }, { ...options, snapshot }) : undefined;
  const sourceSnapshotId = uploadedSnapshot?.sourceSnapshot?.id;
  if (snapshot && !sourceSnapshotId) throw new Error("Source snapshot upload did not return sourceSnapshot.id");

  const uploadedArtifact = await uploadAppsDeployArtifact(store, {
    appId: input.appId,
    artifact,
    version: input.version
  }, options);
  const deployArtifactId = uploadedArtifact.deployArtifact?.id;
  if (!deployArtifactId) throw new Error("Deployment artifact upload did not return deployArtifact.id");

  const deploymentInput = {
    action: target,
    appId: input.appId,
    ...(input.cronSchedules?.length ? { cronSchedules: input.cronSchedules } : {}),
    deployArtifactId,
    entrypoint: artifact.entrypoint,
    ...(input.loginRequired === undefined ? {} : { loginRequired: input.loginRequired }),
    releaseNotes: input.releaseNotes,
    ...(input.queueConsumer ? { queueConsumer: input.queueConsumer } : {}),
    version: input.version,
    versionName: input.versionName,
    ...(sourceSnapshotId ? { sourceSnapshotId } : {})
  };
  const deployment = mcpToolPayload(await callMcpTool(store, "apps_deploy_prepare", deploymentInput, options));

  return {
    appId: input.appId,
    target,
    sourceSnapshot: uploadedSnapshot?.sourceSnapshot,
    sourceSnapshotSkipped: !snapshot,
    deployArtifact: uploadedArtifact.deployArtifact,
    deployment: deployment.deployment,
    sourceVersion: deployment.sourceVersion,
    security: deployment.security
  };
}

function sourceSnapshotSummary(snapshot) {
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

function requiredTarget(value) {
  const target = String(value || "").trim().toLowerCase();
  if (target === "pages" || target === "worker") return target;
  throw new Error("Missing or invalid --target; use pages or worker");
}
