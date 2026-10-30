import Taro from "@tarojs/taro";
import { useState } from "react";
import { deleteConversation, updateConversation } from "../services/api";
import type { Conversation, LiveSession } from "../types";
import type { DrawerAction } from "../components/SessionDrawer";
import { useI18n } from "../services/i18n";

export type ConversationActionResult = { error?: string; message?: string; ok?: boolean };

/**
 * Pin / rename / delete for a conversation. Invalidates the server list through
 * `onMutated` so ordering and titles come from the source of truth rather than from
 * local optimistic patching.
 */
export function useConversationActions(session: LiveSession | undefined, onMutated: (session: LiveSession) => Promise<void> | void) {
  const { t } = useI18n();
  const [busyId, setBusyId] = useState("");

  function manage(item: Conversation, action: DrawerAction): Promise<ConversationActionResult> {
    if (!session) return Promise.resolve({ error: t("sessions.noSession") });
    if (action !== "menu") return run(session, item, action);
    return Taro.showActionSheet({ itemList: [item.pinned ? t("sessions.unpin") : t("sessions.pin"), t("sessions.rename"), t("sessions.delete")] })
      .then((choice) => run(session, item, choice.tapIndex === 0 ? "pin" : choice.tapIndex === 1 ? "rename" : "delete"))
      .catch(() => ({}));
  }

  async function run(session: LiveSession, item: Conversation, action: DrawerAction): Promise<ConversationActionResult> {
    if (busyId) return { message: t("sessions.busy") };
    setBusyId(item.id);
    try {
      if (action === "pin") {
        await updateConversation(session, item.id, { pinned: !item.pinned });
        await onMutated(session);
        return { message: item.pinned ? t("sessions.unpinned") : t("sessions.pinned"), ok: true };
      }
      if (action === "rename") {
        // `editable` is supported at runtime but missing from Taro's modal typings.
        const renamed = await (Taro.showModal as unknown as (options: Record<string, unknown>) => Promise<{ confirm: boolean; content?: string }>)({
          title: t("sessions.rename"), content: item.title, editable: true, placeholderText: t("sessions.renamePlaceholder")
        });
        const title = renamed.content?.trim();
        if (!renamed.confirm || !title) return {};
        await updateConversation(session, item.id, { title });
        await onMutated(session);
        return { message: t("sessions.renamed"), ok: true };
      }
      const confirmed = await Taro.showModal({ title: t("sessions.deleteTitle"), content: t("sessions.deleteBody"), confirmText: t("common.delete"), confirmColor: "#a02920" });
      if (!confirmed.confirm) return {};
      await deleteConversation(session, item.id);
      await onMutated(session);
      return { message: t("sessions.deleted"), ok: true };
    } catch (caught) {
      return { error: t("sessions.actionFailed") };
    } finally {
      setBusyId("");
    }
  }

  return { busyId, manage };
}
