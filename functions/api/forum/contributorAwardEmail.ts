import { platformBrandFromEnv } from "../../../src/shared/platformBrand.ts";
import {
  canReceiveCollaborationNotificationEmail,
  renderCollaborationNotificationEmail
} from "../../../src/shared/collaborationNotificationEmail.ts";
import type { CurrentUser, ForumContext, ForumEnv } from "./types.ts";

export type ContributorAwardEmailTarget = {
  recipientEmail: string;
  recipientName: string;
  recipientUserId: string;
  recipientStatus: string;
  topicId: string;
  topicTitle: string;
};

export function scheduleContributorAwardEmail<TEnv extends ForumEnv>(
  context: ForumContext<TEnv>,
  input: {
    currentUser: CurrentUser;
    note: string;
    points: number;
    target: ContributorAwardEmailTarget;
  }
) {
  const recipient = String(input.target.recipientEmail ?? "").trim();
  const authWorkerUrl = context.env.AUTH_WORKER_URL?.trim();
  const authServiceToken = context.env.PORTAL_AUTH_SERVICE_TOKEN?.trim();
  if (
    !recipient
    || input.currentUser.id === input.target.recipientUserId
    || !canReceiveCollaborationNotificationEmail(input.target.recipientStatus)
    || !authWorkerUrl
    || !authServiceToken
  ) {
    return false;
  }

  const email = renderCollaborationNotificationEmail({
    actorName: input.currentUser.name,
    excerpt: input.note,
    kind: "contribution_awarded",
    permissionLabel: `+${input.points} 积分`,
    recipientName: input.target.recipientName,
    recipientStatus: input.target.recipientStatus as "active" | "invited",
    resourceName: input.target.topicTitle,
    resourceType: "forum",
    resourceUrl: topicUrl(context, input.target.topicId)
  }, platformBrandFromEnv(context.env));
  const task = fetch(`${authWorkerUrl.replace(/\/+$/, "")}/v1/notifications/email`, {
    body: JSON.stringify({
      ...(context.env.PORTAL_EMAIL_FROM?.trim() ? { from: context.env.PORTAL_EMAIL_FROM.trim() } : {}),
      html: email.html,
      subject: email.subject,
      text: email.text,
      to: recipient
    }),
    headers: {
      Authorization: `Bearer ${authServiceToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`portal_email_dispatch_http_${response.status}`);
    }
  }).catch((error) => {
    console.warn("forum_contributor_award_email_failed", {
      errorName: error instanceof Error ? error.name : typeof error,
      recipient,
      topicId: input.target.topicId
    });
  });

  if (typeof context.waitUntil === "function") {
    context.waitUntil(task);
  } else {
    void task;
  }
  return true;
}

function topicUrl<TEnv extends ForumEnv>(context: ForumContext<TEnv>, topicId: string) {
  const configuredUrl = context.env.PORTAL_URL?.trim();
  const origin = configuredUrl || new URL(context.request.url).origin;
  const url = new URL(origin);
  url.hash = `/community/${encodeURIComponent(topicId)}`;
  return url.toString();
}
