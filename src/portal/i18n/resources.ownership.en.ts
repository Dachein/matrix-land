import type { ownershipZhCN } from "./resources.ownership.zh-CN";

export const ownershipEn: Record<keyof typeof ownershipZhCN, string> = {
  "apps.ownership.ownerHelp": "Choose a new Owner. They must accept within 7 days before ownership changes.",
  "apps.ownership.adminHelp": "Administrators can transfer Apps and Skills directly without recipient acceptance. A reason is required and recorded.",
  "apps.ownership.currentOwner": "Current Owner",
  "apps.ownership.retain": "Keep the previous Owner as a collaborator",
  "apps.ownership.removeOld": "Remove the previous Owner’s management access",
  "apps.ownership.reason": "Reason (required)",
  "apps.ownership.transferNow": "Transfer now",
  "apps.ownership.send": "Request transfer",
  "apps.ownership.requests": "Ownership requests",
  "apps.ownership.accept": "Accept",
  "apps.ownership.reject": "Decline",
  "apps.ownership.completed": "Ownership transferred and permissions synchronized.",
  "apps.ownership.requestClosed": "Ownership request closed.",
  "apps.ownership.expires": "Expires",
  "apps.ownership.adminTitle": "Apps and Skills · Ownership",
  "apps.ownership.searchAssets": "Search resources or current Owner",
  "apps.ownership.inactive": "Choose an active user in this organization.",
  "apps.ownership.alreadyPending": "This resource already has a pending transfer. Cancel it first.",
  "apps.ownership.syncPending": "The transfer is saved and permissions are synchronizing. Further changes are temporarily blocked. Refresh shortly.",
  "apps.ownership.conflict": "The request or Owner has changed. Refresh and try again.",
  "apps.ownership.denied": "Only the current Owner or an authorized administrator can perform this action.",
  "apps.ownership.failed": "Completion could not be confirmed. Refresh the transfer status before retrying."
} as const;
