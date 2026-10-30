import type { DiscussionMention } from "../../shared/types";

export type SubmitState = "idle" | "submitting" | "success" | "error";
export type LinkPreviewState = "idle" | "loading" | "ready" | "error";

export type PendingForumAttachment = {
  id: string;
  file: File;
  previewUrl?: string;
  kind: "image" | "file";
  mimeType: string;
};

export type UploadedForumAttachment = {
  storageProvider: "r2";
  storageKey: string;
  publicUrl: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
};

export type MarkdownMentionEnv = {
  copiedCodeLabel?: string;
  copyCodeLabel?: string;
  copyCodeFailedLabel?: string;
  mentionMap?: Map<string, DiscussionMention>;
};

export type ProfileHoverContext = {
  currentUserEmail: string;
  currentUserId: string;
  currentUserLevelLabel: string;
};

export type LinkedForumFilter = {
  id: string;
  label: string;
  type: "app" | "skill" | "mcp";
};

export type ForumListedItemAttachment = LinkedForumFilter & {
  category?: string;
  description?: string;
  iconUrl?: string;
  installs?: number;
  owner?: string;
};

export type TopicPreview = {
  description?: string;
  kind: "image" | "link" | "plugin" | "video";
  provider?: string;
  title: string;
  url?: string;
};
