export type AppsOwnershipAsset = {
  id: string;
  type: "app" | "skill";
  name: string;
  ownerUserId: string;
  collaboratorUserIds: string[];
  syncPending: boolean;
};

export type AppsOwnerTransfer = {
  id: string;
  assetType: "app" | "skill";
  assetId: string;
  assetName: string;
  fromUserId: string;
  toUserId: string;
  retainPreviousOwner: boolean;
  status: "pending" | "accepted" | "rejected" | "cancelled" | "expired" | "admin_forced";
  reason: string;
  expiresAt: string;
};
