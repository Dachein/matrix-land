import { Button, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useLoad } from "@tarojs/taro";
import { useState } from "react";
import { loadRuntimeProfile, redirectToLogin, requireAuth } from "../../services/api";
import { isAuthRequiredError } from "../../services/auth";
import { state } from "../../state";
import { useI18n } from "../../services/i18n";
import type { ChatCapabilitySelection, RuntimeProfile } from "../../types";
import { normalizeCapabilitySelection } from "../../services/capabilitySelection";
import "./index.scss";

export default function CapabilitiesPage() {
  const { t } = useI18n();
  const session = state.getLiveSession();
  const savedSelection = session ? state.getCapabilitySelection(session.mate.id) : undefined;
  const [profile, setProfile] = useState<RuntimeProfile>();
  const [selection, setSelection] = useState<ChatCapabilitySelection>(() => savedSelection || { appIds: [], knowledgeServiceIds: [] });
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"model" | "knowledge" | "apps">("knowledge");
  useLoad(() => {
    if (!session) { void Taro.navigateBack(); return; }
    if (!requireAuth()) return;
    void loadRuntimeProfile(session).then((next) => {
      setProfile(next);
      setSelection((current) => normalizeCapabilitySelection(next, savedSelection ? current : undefined));
    }).catch((caught) => {
      if (isAuthRequiredError(caught)) { redirectToLogin(); return; }
      setError(t("cap.loadFailed"));
    });
  });

  function toggle(key: "appIds" | "knowledgeServiceIds", id: string) {
    if (key === "appIds" && !selection[key].includes(id) && selection[key].length >= 32) {
      void Taro.showToast({ title: t("cap.maxApps"), icon: "none" }); return;
    }
    if (key === "knowledgeServiceIds" && !selection[key].includes(id) && selection[key].length >= 12) {
      void Taro.showToast({ title: t("cap.maxKnowledge"), icon: "none" });
      return;
    }
    setSelection((current) => ({ ...current, [key]: current[key].includes(id) ? current[key].filter((value) => value !== id) : [...current[key], id] }));
  }
  function save() {
    if (!session || !profile) return;
    state.setCapabilitySelection(session.mate.id, normalizeCapabilitySelection(profile, selection));
    void Taro.navigateBack();
  }

  return <View className="capability-page">
    <View className="capability-head"><Text className="subtitle">{t("cap.subtitle")}</Text></View>
    <View className="cap-tabs">
      <View className={`cap-tab ${tab === "knowledge" ? "selected" : ""}`} onClick={() => setTab("knowledge")}>{t("cap.knowledge")}{selection.knowledgeServiceIds.length > 0 && <Text>{selection.knowledgeServiceIds.length}</Text>}</View>
      <View className={`cap-tab ${tab === "apps" ? "selected" : ""}`} onClick={() => setTab("apps")}>{t("cap.apps")}{selection.appIds.length > 0 && <Text>{selection.appIds.length}</Text>}</View>
      <View className={`cap-tab ${tab === "model" ? "selected" : ""}`} onClick={() => setTab("model")}>{t("cap.model")}</View>
    </View>
    <ScrollView className="capability-scroll" scrollY>
      {!profile && !error && <View className="cap-loading">{t("cap.loading")}</View>}
      {error && <Text className="error">{error}</Text>}
      {profile && <>
        {tab === "model" && <Section title={t("cap.chooseModel")} hint={t("cap.single")}>
          {profile.models.allowed.length ? profile.models.allowed.map((model) => <Option key={model.id} title={model.name} subtitle={model.id === profile.models.defaultModel ? t("cap.default") : undefined} active={(selection.modelId || profile.models.defaultModel) === model.id} radio fixed={!profile.models.allowUserSelection} onClick={() => setSelection((current) => ({ ...current, modelId: model.id }))} />) : <Empty />}
        </Section>}
        {tab === "knowledge" && <Section title={t("cap.referenceKnowledge")} hint={t("cap.selectedOf", { count: selection.knowledgeServiceIds.length })}>
          {profile.knowledge.length ? profile.knowledge.map((item) => <Option key={item.id} title={item.name || item.id} subtitle={item.description} active={selection.knowledgeServiceIds.includes(item.id)} onClick={() => toggle("knowledgeServiceIds", item.id)} />) : <Empty />}
        </Section>}
        {tab === "apps" && <Section title={t("cap.availableApps")} hint={t("cap.selectedCount", { count: selection.appIds.length })}>
          {profile.appMcp.length ? profile.appMcp.map((item) => <Option key={item.id} title={item.name || item.id} subtitle={item.description} active={selection.appIds.includes(item.id)} onClick={() => toggle("appIds", item.id)} />) : <Empty />}
        </Section>}
        {tab === "apps" && !!profile.tools.length && <Section title={t("cap.builtInTools")} hint={t("cap.autoAvailable")}>
          {profile.tools.map((item) => <Option key={item.id} title={item.name || item.id} subtitle={item.writeRequiresApproval ? t("cap.approvalRequired") : t("cap.enabled")} active fixed />)}
        </Section>}
      </>}
      <View className="capability-space" />
    </ScrollView>
    <View className="capability-footer"><View><Text className="footer-title">{profile?.models.allowed.find((model) => model.id === (selection.modelId || profile.models.defaultModel))?.name || t("common.defaultModel")}</Text><Text className="footer-detail">{t("cap.footerCount", { knowledgeCount: selection.knowledgeServiceIds.length, appCount: selection.appIds.length })}</Text></View><Button className="primary" disabled={!profile} onClick={save}>{t("cap.save")}</Button></View>
  </View>;
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) { return <View className="cap-section"><View className="section-head"><Text>{title}</Text><Text>{hint}</Text></View><View className="options">{children}</View></View>; }
function Option({ active, fixed, onClick, radio, subtitle, title }: { active?: boolean; fixed?: boolean; onClick?: () => void; radio?: boolean; subtitle?: string; title: string }) { const { t } = useI18n(); return <View className={`cap-option ${active ? "active" : ""} ${fixed ? "fixed" : ""}`} onClick={fixed ? undefined : onClick}><View className={`check ${radio ? "radio" : ""}`}>{active ? "✓" : ""}</View><View className="option-copy"><Text className="option-title">{title}</Text>{subtitle && <Text className="option-subtitle">{subtitle}</Text>}</View>{fixed && <Text className="locked">{t("cap.fixed")}</Text>}</View>; }
function Empty() { const { t } = useI18n(); return <Text className="empty-option">{t("cap.none")}</Text>; }
