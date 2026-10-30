import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import { MateAvatar, UserAvatar } from "./Avatar";
import { KnowledgeIcon } from "./KnowledgeIcon";
import { useI18n } from "../services/i18n";
import { MINIAPP_VERSION } from "../services/appVersion";
import type { Mate, User } from "../types";
import "./MateSidebar.scss";

type Props = {
  active: "chat" | "knowledge" | "setup";
  mates: Mate[];
  onClose: () => void;
  onCreate: () => void;
  onKnowledge: () => void;
  onLogout: () => void;
  onSelect: (mate: Mate) => void;
  onSetup?: () => void;
  onSettings: (mate: Mate) => void;
  open: boolean;
  selectedMateId?: string;
  showSetup?: boolean;
  user: User | null | undefined;
};

export function MateSidebar({ active, mates, onClose, onCreate, onKnowledge, onLogout, onSelect, onSetup, onSettings, open, selectedMateId, showSetup, user }: Props) {
  const { language, setLanguage, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!open) return null;
  const windowInfo = Taro.getWindowInfo();
  const topPadding = (windowInfo.statusBarHeight || Taro.getMenuButtonBoundingClientRect().top || 20) + 14;
  return <View className="mate-menu-overlay" onClick={onClose}>
    <View className="mate-menu-panel" style={{ paddingTop: `${topPadding}px` }} onClick={(event) => event.stopPropagation()}>
      <View className="mate-menu-head"><Text className="mate-menu-title">{t("brand.title")}</Text><Text className="mate-menu-close" onClick={onClose}>×</Text></View>
      <ScrollView className="mate-menu-scroll" scrollY enhanced showScrollbar={false}>
        <Text className="mate-menu-section">{t("chat.mates")}</Text>
        {showSetup && <View className={`mate-menu-setup ${active === "setup" ? "selected" : ""}`} onClick={onSetup}><Text>{t("home.initialState")}</Text><Text className="mate-menu-setup-chevron">›</Text></View>}
        {(expanded ? mates.slice(0, 7) : mates.slice(0, 3)).map((mate) => <View key={mate.id} className={`mate-menu-item ${mate.id === selectedMateId ? "selected" : ""}`} onClick={() => onSelect(mate)}><MateAvatar avatarUrl={mate.avatarUrl} className="mate-menu-avatar" /><View className="mate-menu-copy"><Text className="mate-menu-name">{mate.displayName}</Text><Text className="mate-menu-role">{mate.jobRole}</Text></View>{mate.id === selectedMateId && <Text className="mate-menu-check">✓</Text>}<Text className="mate-menu-settings" onClick={(event) => { event.stopPropagation(); onSettings(mate); }} aria-label={t("mateSettings.open")}>{t("mateSettings.open")}</Text></View>)}
        {mates.length > 3 && <Text className="mate-menu-expand" onClick={() => setExpanded((value) => !value)}>{expanded ? t("chat.collapseMates") : t("chat.expandMates", { count: Math.min(mates.length, 7) })}　⌄</Text>}
        {!showSetup && <View className="mate-menu-create" onClick={onCreate}><Text>＋</Text><Text>{t("home.create")}</Text></View>}
        <View className="mate-menu-divider" />
        <View className={`mate-menu-knowledge ${active === "knowledge" ? "selected" : ""}`} onClick={onKnowledge}><KnowledgeIcon className="knowledge-icon" /><Text>{t("chat.knowledge")}</Text><Text className="knowledge-chevron">›</Text></View>
      </ScrollView>
      <View className="mate-menu-account">
        <View className="mate-menu-account-profile"><UserAvatar avatarUrl={user?.avatarUrl} className="mate-menu-account-avatar" fallback={(user?.name || user?.email || "F").slice(0, 1).toUpperCase()} fallbackClassName="mate-menu-account-monogram" /><View className="mate-menu-account-copy"><Text className="mate-menu-account-name">{user?.name || t("home.colleague")}</Text><Text className="mate-menu-account-email">{user?.email || ""}</Text></View></View>
        <View className="mate-menu-language" onClick={() => setLanguage(language === "zh-CN" ? "en" : "zh-CN")}><Text>{t("account.language")}</Text><Text>{language === "zh-CN" ? t("account.chinese") : t("account.english")}　›</Text></View>
        <View className="mate-menu-logout" onClick={onLogout}><Text>{t("account.logout")}</Text></View>
        <Text className="mate-menu-version">{MINIAPP_VERSION}</Text>
      </View>
    </View>
  </View>;
}
