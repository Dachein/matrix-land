import { useCallback, useEffect, useRef, useState } from "react";
import { discardForumUploads } from "./attachments";
import type { UploadedForumAttachment } from "./types";

export function useForumInlineAttachments() {
  const [inlineAttachments, setInlineAttachments] = useState<UploadedForumAttachment[]>([]);
  const allDraftsRef = useRef<UploadedForumAttachment[]>([]);
  const activeRef = useRef<UploadedForumAttachment[]>([]);

  const replaceInlineAttachments = useCallback((next: UploadedForumAttachment[]) => {
    const deduplicated = deduplicateUploads(next);
    allDraftsRef.current = deduplicateUploads([...allDraftsRef.current, ...deduplicated]);
    activeRef.current = deduplicated;
    setInlineAttachments(deduplicated);
  }, []);

  const commitInlineAttachments = useCallback(() => {
    const activeKeys = new Set(activeRef.current.map((attachment) => attachment.storageKey));
    const unused = allDraftsRef.current.filter((attachment) => !activeKeys.has(attachment.storageKey));
    allDraftsRef.current = [];
    activeRef.current = [];
    setInlineAttachments([]);
    if (unused.length > 0) void discardForumUploads(unused);
  }, []);

  const discardInlineAttachments = useCallback(() => {
    const drafts = allDraftsRef.current;
    allDraftsRef.current = [];
    activeRef.current = [];
    setInlineAttachments([]);
    if (drafts.length > 0) void discardForumUploads(drafts);
  }, []);

  useEffect(() => () => {
    const drafts = allDraftsRef.current;
    allDraftsRef.current = [];
    activeRef.current = [];
    if (drafts.length > 0) void discardForumUploads(drafts);
  }, []);

  return {
    commitInlineAttachments,
    discardInlineAttachments,
    inlineAttachments,
    replaceInlineAttachments
  };
}

function deduplicateUploads(attachments: UploadedForumAttachment[]) {
  return Array.from(new Map(attachments.map((attachment) => [attachment.storageKey, attachment])).values());
}
