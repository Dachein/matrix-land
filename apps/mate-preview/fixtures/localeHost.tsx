import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from "../../../src/portal/i18n";
import { MatePreviewApp } from "../src/App";

function LocaleHost() {
  const { locale, setLocale } = useI18n();
  const [navigation, setNavigation] = useState<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<HTMLDivElement | null>(null);
  const [newConversation, setNewConversation] = useState<HTMLDivElement | null>(null);
  return <>
    <div aria-label="Portal language">
      <button onClick={() => setLocale("en")} type="button">Portal English</button>
      <button onClick={() => setLocale("zh-CN")} type="button">Portal 中文</button>
    </div>
    <div ref={setStatus} />
    <div ref={setNewConversation} />
    <div ref={setNavigation} />
    <MatePreviewApp locale={locale} onLocaleChange={setLocale}
      mode="live" mateId="mate-preview-e2e" debug
      portalSummary portalNavigationTarget={navigation} portalStatusTarget={status}
      portalNewConversationTarget={newConversation}
      welcomeDescription={locale === "en" ? "Your work assistant for everyday tasks." : "你的工作秘书，处理日常事务。"} />
  </>;
}

createRoot(document.getElementById("root")!).render(<I18nProvider><LocaleHost /></I18nProvider>);
