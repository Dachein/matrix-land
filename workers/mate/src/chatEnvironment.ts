import {
  acceptWorkspaceMateEnvironment,
  WORKSPACE_MATE_ENVIRONMENT_ACCEPTED_SCHEMA_VERSION,
  WORKSPACE_MATE_ENVIRONMENT_SCHEMA_VERSION,
  type WorkspaceAcceptedMateEnvironment
} from "../../../sdk/mate/environment.ts";
import { RuntimeHttpError } from "./types.ts";

export type ChatEnvironmentPin = {
  digest: string;
  envelope: WorkspaceAcceptedMateEnvironment;
  revision: number;
  sourceKey: string;
};

/**
 * Normalize one SDK Host snapshot and enforce monotonic revisions for a single
 * Agent DO. The browser cannot submit an already-accepted envelope or choose a
 * trust label; acceptance always happens inside the Runtime.
 */
export async function pinChatEnvironment(
  value: unknown,
  current?: Pick<ChatEnvironmentPin, "digest" | "revision" | "sourceKey">
): Promise<{ idempotent: boolean; pin: ChatEnvironmentPin }> {
  if (!isRecord(value) || value.schemaVersion !== WORKSPACE_MATE_ENVIRONMENT_SCHEMA_VERSION) {
    throw new RuntimeHttpError(422, "mate_chat_environment_required");
  }

  let envelope: WorkspaceAcceptedMateEnvironment;
  try {
    envelope = await acceptWorkspaceMateEnvironment(value);
  } catch (error) {
    throw new RuntimeHttpError(
      422,
      error instanceof Error ? error.message : "mate_environment_invalid"
    );
  }

  const revision = envelope.context.revision;
  const sourceKey = environmentSourceKey(envelope);
  const comparable = current?.sourceKey === sourceKey
    ? current
    : undefined;
  if (comparable && revision < comparable.revision) {
    throw new RuntimeHttpError(409, "mate_chat_environment_stale", {
      acceptedRevision: comparable.revision,
      submittedRevision: revision
    });
  }
  if (comparable && revision === comparable.revision && envelope.digest !== comparable.digest) {
    throw new RuntimeHttpError(409, "mate_chat_environment_revision_conflict", {
      acceptedRevision: comparable.revision
    });
  }

  return {
    idempotent: Boolean(comparable && revision === comparable.revision),
    pin: { digest: envelope.digest, envelope, revision, sourceKey }
  };
}

/** Revalidates an accepted envelope embedded in a server-owned turn binding
 * without advancing the host revision pin. */
export async function verifyPinnedChatEnvironment(
  value: WorkspaceAcceptedMateEnvironment
): Promise<WorkspaceAcceptedMateEnvironment> {
  if (
    !isRecord(value)
    || value.schemaVersion !== WORKSPACE_MATE_ENVIRONMENT_ACCEPTED_SCHEMA_VERSION
    || value.trust !== "host_asserted"
    || typeof value.digest !== "string"
  ) throw new RuntimeHttpError(401, "mate_chat_recovery_context_invalid");
  let accepted: WorkspaceAcceptedMateEnvironment;
  try {
    accepted = await acceptWorkspaceMateEnvironment(value.context);
  } catch {
    throw new RuntimeHttpError(401, "mate_chat_recovery_context_invalid");
  }
  if (accepted.digest !== value.digest) {
    throw new RuntimeHttpError(401, "mate_chat_recovery_context_invalid");
  }
  return accepted;
}

function environmentSourceKey(envelope: WorkspaceAcceptedMateEnvironment) {
  const { appId, instanceId, surface } = envelope.context.host;
  return JSON.stringify([appId, surface, instanceId ?? null]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
