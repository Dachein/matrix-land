import type {
  AssignedUserRole,
  PortalCatalog
} from "../../shared/types";
import type { ForumDiscussion, ForumDiscussionReply } from "./forumAnonymousIdentity";

export function hasAssignedRole(currentUser: PortalCatalog["currentUser"], role: AssignedUserRole) {
  return currentUser.roles?.includes(role) ?? (role === "admin" && currentUser.role === "admin");
}

export function canModerateForum(currentUser: PortalCatalog["currentUser"]) {
  return hasAssignedRole(currentUser, "community_admin");
}

export function isOwnDiscussion(discussion: ForumDiscussion, currentUser: PortalCatalog["currentUser"]) {
  if (discussion.ownedByCurrentUser) {
    return true;
  }

  if (discussion.authorId && discussion.authorId === currentUser.id) {
    return true;
  }

  return Boolean(discussion.authorEmail && discussion.authorEmail.toLowerCase() === currentUser.email.toLowerCase());
}

export function isOwnReply(reply: ForumDiscussionReply, currentUser: PortalCatalog["currentUser"]) {
  if (reply.ownedByCurrentUser) {
    return true;
  }

  if (reply.authorId && reply.authorId === currentUser.id) {
    return true;
  }

  return Boolean(reply.authorEmail && reply.authorEmail.toLowerCase() === currentUser.email.toLowerCase());
}
