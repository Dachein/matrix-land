import { Button, Image, Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useLoad, useRouter } from "@tarojs/taro";
import { useEffect, useState } from "react";
import loginBackground from "../../assets/workspace-login-mobile.webp";
import { loginWithScanTicket, prepareScanLoginTicket, requestEmailCode, verifyEmailCode } from "../../services/api";
import { scanLoginTicket } from "../../services/scanLogin";
import { useI18n } from "../../services/i18n";
import { state } from "../../state";
import "./index.scss";

const REMOTE_LOGIN_BACKGROUND = "https://ai.example.invalid/miniapp/workspace-login-mobile.webp";

export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const scene = typeof router.params.scene === "string" ? router.params.scene : "";
  const launchTicket = typeof router.params.ticket === "string" ? router.params.ticket : "";
  const returnToImport = router.params.returnTo === "file-import";
  const afterLoginUrl = returnToImport ? `/pages/file-import/index${router.params.manual === "1" ? "?manual=1" : ""}` : "/pages/mates/index";
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scanIdentity, setScanIdentity] = useState<{ email: string; name: string; ticket: string }>();
  const [remoteBackgroundReady, setRemoteBackgroundReady] = useState(false);
  const [viewportHeight] = useState(() => Taro.getWindowInfo().windowHeight || 0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const visibleHeight = viewportHeight ? Math.max(220, viewportHeight - keyboardHeight) : 0;

  useEffect(() => {
    const handleKeyboardHeight = (event: { height: number }) => setKeyboardHeight(Math.max(0, event.height || 0));
    Taro.onKeyboardHeightChange(handleKeyboardHeight);
    return () => Taro.offKeyboardHeightChange(handleKeyboardHeight);
  }, []);

  useLoad(() => {
    if (scene || launchTicket) {
      const ticket = scanLoginTicket({ path: `pages/login/index?${scene ? "scene" : "ticket"}=${encodeURIComponent(scene || launchTicket)}` });
      if (ticket) void completeScan(ticket);
      else setError(t("login.invalidTicket"));
      return;
    }
    if (state.getUser()) void Taro.redirectTo({ url: afterLoginUrl });
  });

  async function run(task: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await task(); } catch (caught) { setError(message(caught, t)); } finally { setBusy(false); }
  }

  async function completeScan(ticket: string) {
    await run(async () => {
      const prepared = await prepareScanLoginTicket(ticket);
      setScanIdentity({ ...prepared.user, ticket });
      await loginWithScanTicket(ticket);
      state.requestMatesRefresh();
      await Taro.reLaunch({ url: afterLoginUrl });
    });
  }

  async function scan() {
    await run(async () => {
      const result = await Taro.scanCode({ onlyFromCamera: true });
      const ticket = scanLoginTicket(result);
      if (!ticket) throw new Error("invalid_scan_ticket");
      const prepared = await prepareScanLoginTicket(ticket);
      setScanIdentity({ ...prepared.user, ticket });
      await loginWithScanTicket(ticket);
      state.requestMatesRefresh();
      await Taro.reLaunch({ url: afterLoginUrl });
    });
  }

  async function emailSubmit() {
    await run(async () => {
      if (!challengeId) {
        if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("invalid_company_email");
        const challenge = await requestEmailCode(email);
        setChallengeId(challenge.challengeId);
      } else {
        if (!/^\d{6}$/.test(code)) throw new Error("invalid_email_code");
        await verifyEmailCode(challengeId, code);
        state.requestMatesRefresh();
        await Taro.redirectTo({ url: afterLoginUrl });
      }
    });
  }

  return <View className="login-page" style={viewportHeight ? { height: `${viewportHeight}px` } : undefined}>
    <Image className="login-background" mode="aspectFill" src={loginBackground} />
    <Image
      className={`login-background login-background-remote${remoteBackgroundReady ? " is-ready" : ""}`}
      mode="aspectFill"
      src={REMOTE_LOGIN_BACKGROUND}
      onLoad={() => setRemoteBackgroundReady(true)}
      onError={() => setRemoteBackgroundReady(false)}
    />
    <View className="login-veil" />
    <ScrollView className="login-scroll" scrollY enhanced showScrollbar={false} style={visibleHeight ? { height: `${visibleHeight}px` } : undefined}>
    <View className={`login-content${keyboardHeight > 0 ? " keyboard-open" : ""}`} style={visibleHeight ? { minHeight: `${visibleHeight}px` } : undefined}>
      <View className="login-hero">
        <Text className="login-brand-first">Frontier Workspace</Text>
        <Text className="login-brand-second">Anywhere</Text>
      </View>
      <View className="login-card card">
        {scanIdentity ? <>
          <Text className="form-title">正在登录 Frontier Workspace Anywhere</Text>
          <View className="scan-identity">
            <Text className="scan-identity-name">{scanIdentity.name}</Text>
            <Text className="scan-identity-email">{scanIdentity.email}</Text>
            <Text className="scan-identity-note">{error ? "本次扫码登录未完成，请在网页重新生成小程序码。" : "正在以此 Workspace 账号登录小程序…"}</Text>
          </View>
          <Button className="scan-link" disabled={busy} onClick={() => setScanIdentity(undefined)}>返回邮箱登录</Button>
        </> : <>
        <Text className="form-title">{t("login.emailTitle")}</Text>
        <View className="field">
          <Text className="label">{t("login.companyEmail")}</Text>
          <Input adjustPosition={false} confirmType="done" cursorSpacing={0} disabled={Boolean(challengeId)} value={email} onInput={(event) => setEmail(event.detail.value)} onConfirm={() => void Taro.hideKeyboard()} placeholder={t("login.emailPlaceholder")} />
        </View>
        {challengeId && <View className="field">
          <Text className="label">{t("login.code")}</Text>
          <Input adjustPosition={false} confirmType="done" cursorSpacing={0} type="number" maxlength={6} value={code} onInput={(event) => setCode(event.detail.value)} onConfirm={() => void Taro.hideKeyboard()} placeholder={t("login.codePlaceholder")} />
        </View>}
        <Button className="primary login-primary" disabled={busy} loading={busy} onClick={emailSubmit}>{challengeId ? t("login.verify") : t("login.getCode")}</Button>
        <Button className="scan-link" disabled={busy} onClick={scan}>{t("login.scan")}</Button>
        </>}
        {error && <Text className="error">{error}</Text>}
      </View>
    </View>
    </ScrollView>
  </View>;
}

function message(value: unknown, t: ReturnType<typeof useI18n>["t"]) {
  const code = value instanceof Error ? value.message : "";
  if (code === "invalid_scan_ticket") return t("login.invalidScan");
  if (code === "invalid_company_email") return t("login.invalidEmail");
  if (code === "invalid_email_code") return t("login.invalidCode");
  if (code === "email_otp_invalid_or_expired") return t("login.codeExpired");
  if (code === "email_otp_rate_limited") return t("login.rateLimited");
  if (code === "email_otp_delivery_failed") return t("login.deliveryFailed");
  return code && !/^[a-z0-9_]+$/i.test(code) ? code : t("login.failed");
}
