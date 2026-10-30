import { encodeIdentityPathSegment } from "./identityPath.ts";

export const MATE_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type MateArtifactOwner = {
  orgId: string;
  userId: string;
  mateId: string;
};

export type MateArtifactKind = "image" | "video" | "audio" | "file";

const ARTIFACT_ID = /^art_[0-9a-f-]{36}$/;

export function mateArtifactOwnerPath(owner: MateArtifactOwner) {
  try {
    return [owner.orgId, owner.userId, owner.mateId].map(encodeIdentityPathSegment).join("/");
  } catch {
    throw new Error("mate_artifact_owner_invalid");
  }
}

export function mateArtifactKey(owner: MateArtifactOwner, artifactId: string) {
  const [orgId, userId, mateId] = mateArtifactOwnerPath(owner).split("/");
  if (!ARTIFACT_ID.test(artifactId)) throw new Error("mate_artifact_id_invalid");
  return `mate-artifacts/org/${orgId}/user/${userId}/mate/${mateId}/artifacts/${artifactId}`;
}

export async function putMateArtifact(
  bucket: R2Bucket,
  owner: MateArtifactOwner,
  input: {
    body: ArrayBuffer | ReadableStream | Uint8Array;
    fileName: string;
    kind: MateArtifactKind;
    mediaType: string;
  }
) {
  const artifactId = `art_${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + MATE_ARTIFACT_TTL_MS).toISOString();
  const key = mateArtifactKey(owner, artifactId);
  const previewToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const stored = await bucket.put(key, input.body, {
    httpMetadata: { contentType: input.mediaType },
    customMetadata: {
      artifactId,
      expiresAt,
      fileName: input.fileName.slice(0, 180),
      kind: input.kind,
      mateId: owner.mateId,
      orgId: owner.orgId,
      previewToken,
      userId: owner.userId
    }
  });
  return { artifactId, expiresAt, key, previewToken, sizeBytes: stored.size };
}

export async function getMateArtifact(bucket: R2Bucket, owner: MateArtifactOwner, artifactId: string) {
  if (!ARTIFACT_ID.test(artifactId)) return null;
  const object = await bucket.get(mateArtifactKey(owner, artifactId));
  if (!object) return null;
  const expiresAt = Date.parse(object.customMetadata?.expiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return object;
}

export function mateArtifactFileName(object: R2Object) {
  return object.customMetadata?.fileName?.replace(/["\\\u0000-\u001f\u007f]/g, "_").slice(0, 180) || "artifact";
}

export function mateArtifactContentDisposition(object: R2Object, disposition: "inline" | "attachment") {
  const fileName = mateArtifactFileName(object);
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
