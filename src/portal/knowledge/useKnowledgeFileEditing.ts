import type { KnowledgeMessageSetter } from "./types";
import { useState } from "react";
import type { KnowledgeItem, KnowledgeTranslate } from "./types";
import type { useKnowledgeTree } from "./useKnowledgeTree";
import { useKnowledgeRequestSession } from "./useKnowledgeRequestSession";
import { errorMessage, knowledgeApiBase, knowledgeFetch, portalMutationHeaders } from "./utils";

// Own the text-edit draft and isolate it from earlier loads and save callbacks.
export function useKnowledgeFileEditing({ userId, tree, t, setMessage, onSaved }: {
  userId: string;
  tree: Pick<ReturnType<typeof useKnowledgeTree>, "setSelectedId" | "refreshCurrentFolder">;
  t: KnowledgeTranslate;
  setMessage: KnowledgeMessageSetter;
  onSaved: (objectId: string, versionId: string) => void;
}) {
  const [editTarget, setEditTarget] = useState<KnowledgeItem>();
  const [editContent, setEditContent] = useState("");
  const [editOriginalContent, setEditOriginalContent] = useState("");
  const [isEditLoading, setIsEditLoading] = useState(false);
  const [editError, setEditError] = useState("");
  const session = useKnowledgeRequestSession(userId, closeEditDialog);

  async function openEditDialog(item: KnowledgeItem) {
    const ticket = session.begin();
    tree.setSelectedId(item.id);
    setEditTarget(item);
    setEditContent("");
    setEditOriginalContent("");
    setEditError("");
    setIsEditLoading(true);
    try {
      const response = await fetch(`${knowledgeApiBase()}/api/files/${encodeURIComponent(item.id)}/raw`, { credentials: "include" });
      const content = await response.text();
      if (!session.isCurrent(ticket)) return;
      if (!response.ok) throw new Error(content || response.statusText);
      setEditContent(content);
      setEditOriginalContent(content);
    } catch (error) {
      if (!session.isCurrent(ticket)) return;
      closeEditDialog();
      setMessage(errorMessage(error, t("knowledge.editLoadFailed")), "error");
    } finally {
      if (session.isCurrent(ticket)) setIsEditLoading(false);
    }
  }

  function closeEditDialog() {
    session.invalidate();
    setEditTarget(undefined);
    setEditContent("");
    setEditOriginalContent("");
    setIsEditLoading(false);
    setEditError("");
  }

  async function saveEditedFile() {
    const target = editTarget;
    const ticket = session.capture();
    if (!target?.currentVersionId || isEditLoading || !session.isCurrent(ticket) || editContent === editOriginalContent) return;
    setIsEditLoading(true);
    setEditError("");
    try {
      const result = await knowledgeFetch<{ versionAfterId: string }>(`/api/files/${encodeURIComponent(target.id)}/edit`, {
        body: JSON.stringify({ contentText: editContent, expectedCurrentVersionId: target.currentVersionId, operation: "replace_content" }),
        headers: portalMutationHeaders(true),
        method: "POST"
      });
      if (!session.isCurrent(ticket)) return;
      onSaved(target.id, result.versionAfterId);
      closeEditDialog();
      setMessage(t("knowledge.edited"), "success");
      // The write is already committed. A list refresh must not delay the
      // preview or turn a successful save into an apparent write failure.
      void tree.refreshCurrentFolder().catch(() => {});
    } catch (error) {
      if (session.isCurrent(ticket)) setEditError(errorMessage(error, t("knowledge.editFailed")));
    } finally {
      if (session.isCurrent(ticket)) setIsEditLoading(false);
    }
  }

  return { editTarget, editContent, editOriginalContent, editError, isEditLoading, setEditContent, openEditDialog, closeEditDialog, saveEditedFile };
}
