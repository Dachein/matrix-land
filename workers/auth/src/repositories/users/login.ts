import { type Env, type WorkspaceUser, HttpError } from "../../types.ts";
import { optionalText } from "../values.ts";
import {
  isLoginEligibleAuthUser,
  readAuthUserById,
  readAuthUserByProvider,
  readAuthUserSnapshot,
  readConfirmedLoginAuthUser,
  readEmailOtpAuthUser
} from "./reads.ts";
import type { UserSnapshotInput } from "./types.ts";
import { mergeAuthLoginUser, mergeAuthUser, normalizeAuthUser } from "./values.ts";
import { upsertAuthUserSnapshot } from "./writes.ts";

// Login candidate selection and authorized employee activation.
export type AuthLoginCandidate = {
  department?: string;
  email?: string;
  id: string;
  match: "invited" | "entra";
  name?: string;
  status?: string;
};

export type AuthLoginResolution =
  | { kind: "ready"; userId?: string }
  | {
    candidates: AuthLoginCandidate[];
    kind: "confirmation_required";
    reason: "unmatched_entra_user";
  };

export async function resolveAuthUserSnapshot(env: Env, input: WorkspaceUser): Promise<WorkspaceUser> {
  const normalized = normalizeAuthUser(input);

  if (!env.AUTH_DB || !normalized.id) {
    return normalized;
  }

  const existing = await readAuthUserSnapshot(env, normalized);
  const merged = mergeAuthUser(existing, normalized);
  await upsertAuthUserSnapshot(env, merged);
  return merged;
}

/**
 * Resolve authorization-sensitive identity from the Auth DB when the user is
 * already known. Long-lived tokens and service callers may carry stale role,
 * status, department, or team claims; those claims must not overwrite the
 * current directory snapshot while minting downstream access tokens.
 */
export async function resolveAuthoritativeAuthUserSnapshot(env: Env, input: WorkspaceUser): Promise<WorkspaceUser> {
  const normalized = normalizeAuthUser(input);

  if (!env.AUTH_DB) {
    throw new HttpError(503, "auth_directory_unavailable");
  }
  if (!normalized.id) {
    throw new HttpError(401, "missing_user_id");
  }

  const existing = await readAuthUserById(env, normalized.id);
  if (existing) {
    return existing;
  }

  throw new HttpError(403, "auth_user_not_found");
}

export async function planAuthLoginUser(env: Env, input: UserSnapshotInput): Promise<AuthLoginResolution> {
  const existing = await readAuthUserByProvider(env, input.provider, input.providerSubject);
  if (existing) {
    if (!isLoginEligibleAuthUser(existing)) throw new HttpError(403, "auth_user_inactive");
    return { kind: "ready", userId: existing.id };
  }
  return { kind: "confirmation_required", candidates: [], reason: "unmatched_entra_user" };
}

/** Only an already-bound provider identity may establish a provider session. */
export async function resolveAuthLoginUser(env: Env, input: UserSnapshotInput): Promise<WorkspaceUser> {
  const existing = await readAuthUserByProvider(env, input.provider, input.providerSubject);
  if (!existing) throw new HttpError(428, "identity_link_required");
  if (!isLoginEligibleAuthUser(existing)) throw new HttpError(403, "auth_user_inactive");
  return existing;
}

export async function resolveEmailOtpAuthUser(env: Env, email: string): Promise<WorkspaceUser> {
  const user = await readEmailOtpAuthUser(env, email);
  if (!user) {
    throw new HttpError(403, "email_otp_not_allowed");
  }

  return activateEmailOtpAuthUser(env, user);
}

export async function resolveEmailOtpAuthUserById(env: Env, userId: string): Promise<WorkspaceUser> {
  const user = await readAuthUserById(env, optionalText(userId, 180));
  if (!user || !isLoginEligibleAuthUser(user)) {
    throw new HttpError(403, "email_otp_not_allowed");
  }

  return activateEmailOtpAuthUser(env, user);
}

async function activateEmailOtpAuthUser(env: Env, user: WorkspaceUser): Promise<WorkspaceUser> {

  await env.AUTH_DB
    .prepare(
      `
      UPDATE auth_users
      SET status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
          last_seen_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
    .bind(user.id)
    .run();

  return {
    ...user,
    status: user.status === "invited" ? "active" : user.status
  };
}
