import { Button, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useMemo, useRef, useState } from "react";
import { FirstMateSetup, type FirstMateProgress } from "../../components/FirstMateSetup";
import { MateSidebar } from "../../components/MateSidebar";
import { activateDefaultMate, getDefaultMate, listMates, logout, redirectToLogin, refreshCurrentUserProfile, requireAuth } from "../../services/api";
import { isAuthRequiredError } from "../../services/auth";
import { useI18n } from "../../services/i18n";
import { quickCreateErrorMessage } from "../../services/quickCreate";
import { provisionDefaultMate } from "../../services/defaultMateSetup";
import { loadMateEntry } from "../../services/mateEntry";
import { state } from "../../state";
import type { Mate } from "../../types";
import "./index.scss";

/** Existing users enter chat directly. This route only hosts first Mate setup. */
export default function MatesPage() {
  const { language, t } = useI18n();
  const [defaultMate, setDefaultMate] = useState<Mate | null>(() => state.getMates().find((mate) => mate.isDefault) || null);
  const [createdDefaultMate, setCreatedDefaultMate] = useState<Mate | null>(null);
  const [loading, setLoading] = useState(true);
  const [mateLoadFailed, setMateLoadFailed] = useState(false);
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [firstMateProgress, setFirstMateProgress] = useState<FirstMateProgress>("create");
  const [menuOpen, setMenuOpen] = useState(false);
  const [mates, setMates] = useState(() => state.getMates());
  const [user, setUser] = useState(() => state.getUser());
  const loadedOnce = useRef(false);
  const creating = useRef(false);
  const navigation = useMemo(() => customNavigationMetrics(), []);

  useDidShow(() => {
    if (loadedOnce.current || !requireAuth()) return;
    loadedOnce.current = true;
    void loadMates();
  });

  async function loadMates() {
    setLoading(true);
    setMateLoadFailed(false);
    let stage = "default";
    try {
      const entry = await loadMateEntry({ readDefault: getDefaultMate, list: () => listMates({ force: true }) });
      const nextDefault = entry.mate;
      if (entry.mates) setMates(entry.mates);
      setDefaultMate(nextDefault);
      if (nextDefault?.status === "published") {
        stage = "store";
        state.setMate(nextDefault);
        const active = state.getLiveSession();
        if (active?.mate?.id !== nextDefault.id) state.clearLiveSession();
        stage = "redirect";
        await Taro.redirectTo({ url: "/pages/chat/index" });
      }
    } catch (caught) {
      if (isAuthRequiredError(caught)) { redirectToLogin(); return; }
      console.error("[Mate load failed]", stage, caught);
      setMateLoadFailed(true);
    } finally { setLoading(false); }
  }

  async function startDefaultMate(displayName: string, avatarUrl: string) {
    if (creating.current || !displayName.trim()) return;
    creating.current = true;
    setDefaultBusy(true);
    setCreateError("");
    setFirstMateProgress("create");
    try {
      const mate = await provisionDefaultMate({ displayName: displayName.trim(), avatarUrl }, {
        activate: activateDefaultMate, read: getDefaultMate, onProgress: setFirstMateProgress
      });
      setDefaultMate(mate);
      state.setMates([mate, ...state.getMates().filter((item) => item.id !== mate.id)]);
      setCreatedDefaultMate(mate);
    } catch (caught) {
      if (isAuthRequiredError(caught)) { redirectToLogin(); return; }
      setCreateError(quickCreateErrorMessage(caught, language));
    } finally { creating.current = false; setDefaultBusy(false); }
  }

  async function open(mate: Mate) {
    setCreatedDefaultMate(null);
    state.setMate(mate);
    state.clearLiveSession();
    await Taro.redirectTo({ url: "/pages/chat/index" });
  }

  async function signOut() {
    setMenuOpen(false);
    const confirmed = await Taro.showModal({ title: t("account.logoutTitle"), content: t("account.logoutBody"), confirmText: t("account.logout"), confirmColor: "#a02920" });
    if (!confirmed.confirm) return;
    try { await logout(); await Taro.reLaunch({ url: "/pages/login/index" }); }
    catch { await Taro.showToast({ title: t("account.logoutFailed"), icon: "none" }); }
  }

  function openMenu() {
    setMenuOpen(true);
    void listMates({ force: true }).then(setMates).catch(() => setMates(state.getMates()));
    void refreshCurrentUserProfile().then((profile) => { if (profile) setUser(profile); }).catch(() => {});
  }

  async function switchMate(mate: Mate) {
    if (mate.status !== "published") { await Taro.showToast({ title: t("home.unpublished"), icon: "none" }); return; }
    setMenuOpen(false);
    await open(mate);
  }

  return <View className="first-mate-page">
    <View className="miniapp-topbar" style={{ height: `${navigation.height}px`, paddingTop: `${navigation.statusBarHeight}px` }}>
      <Text className="first-mate-menu-trigger" onClick={openMenu} aria-label={t("chat.menu")}>☰</Text>
      <Text className="topbar-title">{t("brand.title")}</Text>
      <View className="first-mate-head-spacer" />
    </View>
    {loading ? <View className="first-mate-load-error"><Text>{t("common.loading")}</Text></View>
      : mateLoadFailed ? <View className="first-mate-load-error"><Text>{t("home.firstMateLoadFailed")}</Text><Button onClick={() => void loadMates()}>{t("common.retry")}</Button></View>
      : <FirstMateSetup busy={defaultBusy} error={createError} initialAvatarUrl={defaultMate?.avatarUrl} initialName={defaultMate?.displayName} navigationHeight={navigation.height} progressStep={firstMateProgress} onCreate={(name, avatar) => void startDefaultMate(name, avatar)} />}
    {createdDefaultMate && <View className="drawer-backdrop" onClick={() => void open(createdDefaultMate)}>
      <View className="create-drawer default-mate-permissions" onClick={(event) => event.stopPropagation()}>
        <View className="create-drawer-header"><Text className="form-title">{t("home.defaultCreated", { name: createdDefaultMate.displayName })}</Text><Text className="drawer-close" onClick={() => void open(createdDefaultMate)}>×</Text></View>
        {createdDefaultMate.workEmail && <Text className="default-mate-email">{createdDefaultMate.workEmail}</Text>}
        <Text className="default-mate-permissions-title">{t("home.permissionsTitle")}</Text>
        <View className="default-mate-permissions-list">
          <Text>✓ {t("home.permissionKnowledge")}</Text><Text>✓ {t("home.permissionKnowledgeEdit")}</Text><Text>✓ {t("home.permissionApps")}</Text><Text>✓ {t("home.permissionTools")}</Text><Text>✓ {t("home.permissionTasks")}</Text>
        </View>
        <Text className="default-mate-permissions-note">{t("home.permissionsNote")}</Text>
        <Button className="primary" onClick={() => void open(createdDefaultMate)}>{t("home.enterChat")}</Button>
      </View>
    </View>}
    <MateSidebar active="setup" mates={mates} onClose={() => setMenuOpen(false)} onCreate={() => setMenuOpen(false)} onKnowledge={() => { setMenuOpen(false); void Taro.redirectTo({ url: "/pages/knowledge/index" }); }} onLogout={() => void signOut()} onSelect={(mate) => void switchMate(mate)} onSetup={() => setMenuOpen(false)} onSettings={(mate) => { setMenuOpen(false); void Taro.navigateTo({ url: `/pages/mate-settings/index?id=${encodeURIComponent(mate.id)}` }); }} open={menuOpen} showSetup selectedMateId={defaultMate?.id} user={user} />
  </View>;
}

function customNavigationMetrics() {
  const windowInfo = Taro.getWindowInfo();
  const capsule = Taro.getMenuButtonBoundingClientRect();
  const statusBarHeight = windowInfo.statusBarHeight || capsule.top || 20;
  const gap = Math.max(4, capsule.top - statusBarHeight);
  return { height: capsule.bottom + gap, statusBarHeight };
}
