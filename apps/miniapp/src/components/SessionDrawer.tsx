import { Button, Input, ScrollView, Text, View } from "@tarojs/components";
import { useEffect, useState } from "react";
import type { Conversation } from "../types";
import { relativeTime } from "../utils/format";
import { useI18n } from "../services/i18n";

export type DrawerAction = "delete" | "menu" | "pin" | "rename";

export function SessionDrawer({ busyId, error, mateName, onAction, onClose, onNew, onSelect, open, selectedId, sessions, switchingId }: {
  busyId: string;
  error: string;
  mateName: string;
  onAction: (item: Conversation, action: DrawerAction) => void;
  onClose: () => void;
  onNew: () => void;
  onSelect: (item: Conversation) => void;
  open: boolean;
  selectedId?: string;
  sessions: Conversation[];
  switchingId: string;
}) {
  const { language, t } = useI18n();
  const [query, setQuery] = useState("");
  useEffect(() => { if (open) setQuery(""); }, [open]);
  if (!open) return null;
  const visible = sessions.filter((item) => (item.title || t("sessions.new")).toLowerCase().includes(query.trim().toLowerCase()));
  return <View className="session-drawer">
    <View className="session-drawer-mask" onClick={onClose} />
    <View className="session-drawer-panel">
      <View className="drawer-handle" />
      <View className="session-drawer-head">
        <View>
          <Text className="drawer-title">{t("sessions.title")}</Text>
          <Text className="drawer-subtitle">{t("sessions.subtitle", { name: mateName || "Mate", count: sessions.length })}</Text>
        </View>
        <Button className="drawer-close" onClick={onClose} ariaLabel={t("sessions.close")}>×</Button>
      </View>
      <View className="session-search"><Input value={query} placeholder={t("sessions.search")} onInput={(event) => setQuery(event.detail.value)} />{query && <Text onClick={() => setQuery("")}>×</Text>}</View>
      {error && <Text className="drawer-error">{error}</Text>}
      <ScrollView className="session-list" scrollY>
        {!visible.length && <View className="session-empty"><Text>{query.trim() ? t("sessions.notFound") : t("sessions.first")}</Text><Text>{query.trim() ? t("sessions.tryOther") : t("sessions.startChat")}</Text></View>}
        {visible.map((item) => <View
          key={item.id}
          className={`session-option ${item.id === selectedId ? "current" : ""}`}
          onClick={() => onSelect(item)}
          onLongPress={() => onAction(item, "menu")}
        >
          <View className="session-option-copy">
            <Text className="session-option-title">{item.title || t("sessions.new")}</Text>
            <View className="session-option-meta">
              {item.pinned && <Text className="session-pin">{t("sessions.pin")}</Text>}
              <Text className="session-option-time">{relativeTime(item.updatedAt, language)}</Text>
            </View>
          </View>
          {switchingId === item.id
            ? <Text className="session-option-state">…</Text>
            : item.id === selectedId
              ? <Text className="session-option-state current">{t("sessions.current")}</Text>
              : null}
          <Text
            className={`session-more ${busyId === item.id ? "busy" : ""}`}
            onClick={(event) => { event.stopPropagation(); onAction(item, "menu"); }}
          >•••</Text>
        </View>)}
      </ScrollView>
      <View className="session-drawer-footer"><Button className="new-session" disabled={!!switchingId} loading={switchingId === "new"} onClick={onNew}><Text className="new-session-plus">＋</Text> {t("sessions.create")}</Button></View>
    </View>
  </View>;
}
