import { useState } from "react";
import { useKnowledgeRequestSession } from "./useKnowledgeRequestSession";
import type { KnowledgeApiItem, KnowledgeItem, KnowledgeTranslate } from "./types";
import type { KnowledgeContextMenu, KnowledgePublicShareExpiry, KnowledgePublicShareResponse } from "./workspaceTypes";
import type { useKnowledgeTree } from "./useKnowledgeTree";
import { errorMessage, knowledgeFetch, normalizeApiItem, portalMutationHeaders } from "./utils";

// Own public-link loading, expiry, creation, revocation and clipboard feedback.
export function useKnowledgePublicShare({ userId, tree, t, setMessage, setContextMenu }: {
  userId: string;
  tree: Pick<ReturnType<typeof useKnowledgeTree>, "updateKnownKnowledgeItem" | "setSelectedId">;
  t: KnowledgeTranslate;
  setMessage: (message: string) => void;
  setContextMenu: (menu: KnowledgeContextMenu | undefined) => void;
}) {
  const { updateKnownKnowledgeItem, setSelectedId } = tree;
  const [shareTarget, setShareTarget] = useState<KnowledgeItem>();
  const [shareUrl, setShareUrl] = useState("");
  const [shareExpiresAt, setShareExpiresAt] = useState<string | null>();
  const [shareExpiry, setShareExpiry] = useState<KnowledgePublicShareExpiry>("24h");
  const [sharePermanentConfirmed, setSharePermanentConfirmed] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const session = useKnowledgeRequestSession(userId, closeShareDialog);
  function shareKnowledgeItem(item: KnowledgeItem) {
    setContextMenu(undefined);
    setSelectedId(item.id);
    if (item.kind === "folder" || !item.capabilities.canCreatePublicShare) {
      return;
    }

    setShareTarget(item);
    setShareUrl("");
    setShareExpiresAt(undefined);
    setShareExpiry("24h");
    setSharePermanentConfirmed(false);
    setShareCopied(false);
    setIsSharing(true);
    const ticket = session.begin();
    void knowledgeFetch<KnowledgePublicShareResponse>(`/api/objects/${encodeURIComponent(item.id)}/public-share`)
      .then((response) => {
        if (session.isCurrent(ticket)) { reconcilePublicShareItem(response.item); applyPublicShareResponse(response); }
      })
      .catch((error) => {
        if (session.isCurrent(ticket)) setMessage(errorMessage(error, t("knowledge.shareLinkLoadFailed")));
      })
      .then(() => {
        if (session.isCurrent(ticket)) setIsSharing(false);
      });
  }

  function closeShareDialog() {
    session.invalidate();
    setShareTarget(undefined);
    setShareUrl("");
    setShareExpiresAt(undefined);
    setShareExpiry("24h");
    setSharePermanentConfirmed(false);
    setIsSharing(false);
    setShareCopied(false);
  }

  function applyPublicShareResponse(response: KnowledgePublicShareResponse) {
    const active = response.active ?? Boolean(response.url || response.share?.url);
    setShareUrl(active ? response.url ?? response.share?.url ?? "" : "");
    setShareExpiresAt(active ? response.share?.expiresAt : undefined);
  }

  function reconcilePublicShareItem(item?: KnowledgeApiItem) {
    if (item) {
      const nextItem = normalizeApiItem(item);
      updateKnownKnowledgeItem(nextItem.id, () => nextItem);
    }
  }

  async function createPublicShareLink() {
    const target = shareTarget;
    const ticket = session.capture();
    if (!target || isSharing || !session.isCurrent(ticket) || (shareExpiry === "permanent" && !sharePermanentConfirmed)) {
      return;
    }
    setIsSharing(true);
    try {
      const response = await knowledgeFetch<KnowledgePublicShareResponse>(`/api/objects/${encodeURIComponent(target.id)}/public-share`, {
        body: JSON.stringify({ expiry: shareExpiry }),
        headers: portalMutationHeaders(true),
        method: "POST"
      });
      reconcilePublicShareItem(response.item);
      if (session.isCurrent(ticket)) {
        applyPublicShareResponse(response);
        setMessage(t("knowledge.shareLinkCreated"));
      }
    } catch (error) {
      if (session.isCurrent(ticket)) setMessage(errorMessage(error, t("knowledge.shareLinkCreateFailed")));
    } finally {
      if (session.isCurrent(ticket)) setIsSharing(false);
    }
  }

  async function revokePublicShareLink() {
    const target = shareTarget;
    const ticket = session.capture();
    if (!target || isSharing || !session.isCurrent(ticket) || !shareUrl) {
      return;
    }
    setIsSharing(true);
    try {
      const response = await knowledgeFetch<KnowledgePublicShareResponse>(`/api/objects/${encodeURIComponent(target.id)}/public-share`, { headers: portalMutationHeaders(), method: "DELETE" });
      let item = response.item;
      if (!item) {
        try {
          item = (await knowledgeFetch<{ item?: KnowledgeApiItem }>(`/api/files/${encodeURIComponent(target.id)}`)).item;
        } catch {
          // Revocation already succeeded. A later folder refresh can reconcile
          // the display if this optional read is temporarily unavailable.
        }
      }
      reconcilePublicShareItem(item);
      if (session.isCurrent(ticket)) {
        setShareUrl("");
        setShareExpiresAt(undefined);
        setShareCopied(false);
        setMessage(t("knowledge.shareLinkRevoked"));
      }
    } catch (error) {
      if (session.isCurrent(ticket)) setMessage(errorMessage(error, t("knowledge.shareLinkRevokeFailed")));
    } finally {
      if (session.isCurrent(ticket)) setIsSharing(false);
    }
  }

  async function copyPublicShareLink() {
    const targetId = shareTarget?.id;
    const ticket = session.capture();
    const url = shareUrl;
    if (!targetId || !url || isSharing || !session.isCurrent(ticket)) {
      return;
    }

    setIsSharing(true);
    try {
      await navigator.clipboard.writeText(url);
      if (session.isCurrent(ticket)) {
        setShareCopied(true);
        setMessage(t("knowledge.shareLinkCopied"));
      }
    } catch (error) {
      if (session.isCurrent(ticket)) setMessage(errorMessage(error, t("knowledge.shareLinkCopyFailed")));
    } finally {
      if (session.isCurrent(ticket)) setIsSharing(false);
    }
  }

  return {
    shareTarget,
    setShareTarget,
    shareUrl,
    shareExpiresAt,
    shareExpiry,
    setShareExpiry,
    sharePermanentConfirmed,
    setSharePermanentConfirmed,
    isSharing,
    shareCopied,
    shareKnowledgeItem,
    closeShareDialog,
    createPublicShareLink,
    revokePublicShareLink,
    copyPublicShareLink,
  };
}
