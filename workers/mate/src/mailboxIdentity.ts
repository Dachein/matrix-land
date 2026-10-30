import { missingConfiguration } from "../../../src/shared/requiredConfiguration.ts";
import { RuntimeHttpError, type RuntimeEnv, type RuntimePrincipal } from "./types.ts";

export type MailboxIdentity = { orgId: string; userId: string; mateId: string; address: string };

export async function resolveDefaultMailbox(env: RuntimeEnv, lookup: { address: string } | { principal: RuntimePrincipal }): Promise<MailboxIdentity | null> {
  const token = env.MATE_RUNTIME_SERVICE_TOKEN?.trim();
  if (!token) throw new RuntimeHttpError(503, "control_plane_service_token_not_configured");
  const url = new URL("/internal/runtime/default-mailbox", env.APPS_CONTROL_PLANE_URL || missingConfiguration("APPS_CONTROL_PLANE_URL"));
  const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: "application/json" });
  if ("address" in lookup) url.searchParams.set("address", lookup.address);
  else {
    headers.set("x-workspace-runtime-user-id", lookup.principal.userId);
    headers.set("x-workspace-runtime-org-id", lookup.principal.orgId);
  }
  const request = new Request(url, { headers });
  const response = env.APPS_CONTROL_PLANE ? await env.APPS_CONTROL_PLANE.fetch(request) : await fetch(request);
  if (!response.ok) throw new RuntimeHttpError(503, "mailbox_lookup_unavailable");
  const { mailbox } = await response.json() as { mailbox: MailboxIdentity | null };
  if (mailbox === null) return null;
  if (!mailbox || [mailbox.orgId, mailbox.userId, mailbox.mateId, mailbox.address].some(value => typeof value !== "string" || !value)) {
    throw new RuntimeHttpError(502, "mailbox_identity_invalid");
  }
  if ("principal" in lookup && (mailbox.userId !== lookup.principal.userId || mailbox.orgId !== lookup.principal.orgId)) {
    throw new RuntimeHttpError(403, "mailbox_access_denied");
  }
  if ("address" in lookup && mailbox.address.toLowerCase() !== lookup.address.toLowerCase()) throw new RuntimeHttpError(403, "mailbox_access_denied");
  return mailbox;
}
