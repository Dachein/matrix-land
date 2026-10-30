import { Button, Text, View } from "@tarojs/components";
import Taro, { useLoad } from "@tarojs/taro";
import { useMemo, useState } from "react";
import { MateIdentityForm, type MateIdentity } from "../../components/MateIdentityForm";
import { deleteMate, getMate, redirectToLogin, updateMateIdentity } from "../../services/api";
import { isAuthRequiredError } from "../../services/auth";
import { quickCreateErrorMessage } from "../../services/quickCreate";
import { useI18n } from "../../services/i18n";
import { state } from "../../state";
import type { Mate } from "../../types";
import "./index.scss";

export default function MateSettingsPage() {
  const { language, t } = useI18n();
  const [mate, setMate] = useState<Mate>();
  const [identity, setIdentity] = useState<MateIdentity>({ displayName: "", jobRole: "", avatarUrl: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mateId, setMateId] = useState("");
  const navigation = useMemo(() => customNavigationMetrics(), []);

  useLoad((query) => {
    const id = typeof query.id === "string" ? query.id : "";
    setMateId(id);
    if (!id) { setLoading(false); setError(t("mateSettings.notFound")); return; }
    void load(id);
  });

  async function load(id: string) {
    try {
      const found = state.getMates().find((item) => item.id === id) || await getMate(id);
      setMate(found);
      setIdentity({ displayName: found.displayName, jobRole: found.jobRole, avatarUrl: found.avatarUrl || "" });
    } catch (caught) {
      if (isAuthRequiredError(caught)) redirectToLogin();
      else setError(t("mateSettings.loadFailed"));
    } finally { setLoading(false); }
  }

  async function save() {
    if (!mate || busy || !identity.displayName.trim() || !identity.jobRole.trim()) return;
    setBusy(true); setError("");
    try {
      const updated = await updateMateIdentity(mate, {
        ...identity,
        displayName: identity.displayName.trim(),
        jobRole: identity.jobRole.trim()
      });
      const next = [updated, ...state.getMates().filter((item) => item.id !== updated.id)];
      state.setMates(next);
      state.requestMatesRefresh();
      await Taro.showToast({ title: t("mateSettings.saved"), icon: "success" });
      await Taro.navigateBack();
    } catch (caught) {
      if (isAuthRequiredError(caught)) redirectToLogin();
      else setError(quickCreateErrorMessage(caught, language));
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!mate || busy || mate.isDefault) return;
    const localOnly = isLocalOnlyMate(mate);
    const confirmation = await Taro.showModal({
      title: t("mateSettings.deleteTitle"),
      content: localOnly
        ? t("mateSettings.deleteLocalBody", { name: mate.displayName })
        : t("mateSettings.deleteRemoteBody", { name: mate.displayName }),
      confirmText: t("common.delete"),
      confirmColor: "#a02920"
    });
    if (!confirmation.confirm) return;
    setBusy(true); setError("");
    try {
      if (!localOnly) await deleteMate(mate.id);
      state.setMates(state.getMates().filter((item) => item.id !== mate.id));
      state.requestMatesRefresh();
      await Taro.showToast({ title: localOnly ? t("mateSettings.localDeleted") : t("mateSettings.deleted"), icon: "success" });
      await Taro.navigateBack();
    } catch (caught) {
      if (isAuthRequiredError(caught)) redirectToLogin();
      else setError(t("mateSettings.deleteFailed"));
    } finally { setBusy(false); }
  }

  return <View className="page mate-settings-page">
    <View className="settings-topbar" style={{ height: `${navigation.height}px`, paddingTop: `${navigation.statusBarHeight}px` }}>
      <Text className="settings-back" onClick={() => Taro.navigateBack()}>‹</Text>
      <Text className="settings-title">{t("mateSettings.title")}</Text>
      <View className="settings-topbar-spacer" />
    </View>
    {loading ? <View className="loading">{t("common.loading")}</View> : mate ? <View className="settings-card card">
      <View className="settings-card-heading">
        <Text className="settings-name">{mate.displayName}</Text>
        {!mate.isDefault && <Button className="settings-delete-button" disabled={busy} onClick={() => void remove()}>{busy ? t("common.processing") : t("common.delete")}</Button>}
      </View>
      <Text className="settings-help">{isLocalOnlyMate(mate) ? t("mateSettings.localOnly") : t("mateSettings.help")}</Text>
      {mate.workEmail && <View className="settings-code"><Text>{t("mateSettings.code")}</Text><Text>{mate.workEmail.split("@")[0]}</Text><Text>{t("mateSettings.codeImmutable")}</Text></View>}
      <MateIdentityForm busy={busy} onChange={(next) => { setIdentity(next); setError(""); }} value={identity} />
      {error && <Text className="create-error">{error}</Text>}
      <Button className="settings-save" disabled={busy || !identity.displayName.trim() || !identity.jobRole.trim()} onClick={() => void save()}>{busy ? t("mateSettings.saving") : t("mateSettings.save")}</Button>
    </View> : <View className="loading">{error || t("mateSettings.notFound")}</View>}
  </View>;
}

function isLocalOnlyMate(mate: Mate) {
  // The miniapp mock/local draft path uses this synthetic ID; it must never be
  // sent to the server's archive endpoint as if it were a persisted Mate.
  return !mate.id?.trim() || /^mate_\d+$/.test(mate.id);
}

function customNavigationMetrics() {
  const windowInfo = Taro.getWindowInfo();
  const capsule = Taro.getMenuButtonBoundingClientRect();
  const statusBarHeight = windowInfo.statusBarHeight || capsule.top || 20;
  const gap = Math.max(4, capsule.top - statusBarHeight);
  return { height: capsule.bottom + gap, statusBarHeight };
}
