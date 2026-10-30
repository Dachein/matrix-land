import { HttpError, type Env } from "./types";
import { readString } from "./utils";

export async function deleteR2ArtifactKeys(env: Env, keys: unknown[]): Promise<string[]> {
  // Source history also contains Cloudflare deployment references. Those are
  // removed with the runtime; they are not objects in APPS_ARTIFACTS.
  const artifactKeys = Array.from(new Set(keys.map((key) => readString(key).trim())
    .filter((key) => key && !key.startsWith("cloudflare://"))));
  if (artifactKeys.length === 0) {
    return [];
  }

  if (!env.APPS_ARTIFACTS) {
    throw new HttpError(500, "apps_artifacts_bucket_unavailable");
  }

  // One request per object can outlive the Portal's request timeout on Apps
  // with substantial history. R2 accepts at most 1,000 keys per delete call.
  for (let offset = 0; offset < artifactKeys.length; offset += 1000) {
    await env.APPS_ARTIFACTS.delete(artifactKeys.slice(offset, offset + 1000));
  }

  return artifactKeys;
}
