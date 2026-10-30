import { useInstallationEndpoints } from "../../brand/PlatformBrandProvider";
import { ArrowUpRight, Bot, Check, Copy, Mail, MessageCircleMore, QrCode, Settings, Sparkles, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  normalizeMateCodeDraft,
  mateCodeFromWorkEmail,
  type Mate
} from "../../../shared/mate";
import type { PortalCatalog } from "../../../shared/types";
import { Button, ButtonLink } from "../../components/Button";
import { FormField, TextInput } from "../../components/FormField";
import { ModalShell } from "../../components/ModalShell";
import { SquareCoverImageField } from "../../components/SquareCoverImageField";
import { useI18n } from "../../i18n";
import { AppsApiError } from "../apiClient";
import { MateAvatarChoices, defaultMateAvatarUrl } from "../components/MateAvatarChoices";

type SetupPhase = "form" | "provisioning" | "success" | "failed";
type ProvisionStep = "create" | "deploy" | "publish" | "connect";
type WeixinState = {
  qrContent?: string;
  sessionId?: string;
  state: "unbound" | "pending" | "scanned" | "need_verify_code" | "active" | "expired" | "failed";
};
type LiveSession = { accessToken: string; runtimeOrigin: string; mate: { id: string } };

export function MateQuickSetupModal({
  catalog,
  onAdvanced,
  onClose,
  onCreate,
  onDeployPreview,
  onPublish,
  submitting
}: {
  catalog: PortalCatalog;
  onAdvanced: (mate?: Mate) => void;
  onClose: () => void;
  onCreate: (input: Record<string, unknown>) => Promise<Mate | undefined>;
  onDeployPreview: (mate: Mate) => Promise<Mate | undefined>;
  onPublish: (mate: Mate, releaseId: string) => Promise<Mate | undefined>;
  submitting: boolean;
}) {
  const { t } = useI18n();
  const {mateEmailDomain} = useInstallationEndpoints();
  const [phase, setPhase] = useState<SetupPhase>("form");
  const [step, setStep] = useState<ProvisionStep>("create");
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState(defaultMateAvatarUrl);
  const [workEmail, setWorkEmail] = useState("");
  const [created, setCreated] = useState<Mate>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"link">();
  const [session, setSession] = useState<LiveSession>();
  const [weixin, setWeixin] = useState<WeixinState>();
  const [qrImage, setQrImage] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const code = mateCodeFromWorkEmail(workEmail);
  const webPath = created ? `/mates/${encodeURIComponent(created.id)}` : "";
  const webUrl = useMemo(() => webPath ? new URL(webPath, window.location.origin).toString() : "", [webPath]);
  const busy = phase === "provisioning" || submitting;

  useEffect(() => {
    if (!weixin?.qrContent) { setQrImage(""); return; }
    let active = true;
    void QRCode.toDataURL(weixin.qrContent, {
      color: { dark: "#17231d", light: "#ffffff" },
      errorCorrectionLevel: "M",
      margin: 1,
      width: 228
    }).then((value) => { if (active) setQrImage(value); })
      .catch(() => { if (active) setError(t("apps.mate.quick.qrFailed")); });
    return () => { active = false; };
  }, [t, weixin?.qrContent]);

  useEffect(() => {
    if (!session || !weixin?.sessionId || !["pending", "scanned"].includes(weixin.state)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void requestWeixin(session, { sessionId: weixin.sessionId, signal: controller.signal })
        .then(setWeixin)
        .catch((reason) => { if ((reason as Error).name !== "AbortError") setError(t("apps.mate.quick.qrPollFailed")); });
    }, 900);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [session, t, weixin]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void provision();
  }

  async function provision() {
    if (!displayName.trim() || !code) return;
    setError("");
    setPhase("provisioning");
    setStep("create");
    let workingMate = created;
    try {
      const mate = workingMate ?? await onCreate({
        creationProfile: "personal_mate",
        avatarUrl,
        defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
        description: t("apps.mate.quick.defaultDescription", { name: displayName.trim() }),
        displayName: displayName.trim(),
        jobRole: t("apps.mate.quick.defaultRole"),
        workEmail
      });
      if (!mate) throw new Error("mate_create_failed");
      workingMate = mate;
      setCreated(mate);
      setStep("deploy");
      const deployed = mate.previewReleaseId ? mate : await onDeployPreview(mate);
      if (!deployed?.previewReleaseId) throw new Error("mate_deploy_failed");
      workingMate = deployed;
      setCreated(deployed);
      setStep("publish");
      const published = deployed.activeReleaseId === deployed.previewReleaseId
        ? deployed
        : await onPublish(deployed, deployed.previewReleaseId);
      if (!published) throw new Error("mate_publish_failed");
      setCreated(published);
      setStep("connect");
      setPhase("success");
      void startWeixin(published.id);
    } catch (reason) {
      setPhase(workingMate ? "failed" : "form");
      if (workingMate) setCreated(workingMate);
      if (reason instanceof AppsApiError && reason.code === "mate_email_conflict") {
        setError(t("apps.mate.emailConflict"));
      } else {
        setError(t("apps.mate.quick.createFailed"));
      }
    }
  }

  async function startWeixin(mateId: string) {
    try {
      const live = await requestLiveSession(mateId);
      setSession(live);
      const current = await requestWeixin(live);
      setWeixin(current.state === "unbound" ? await requestWeixin(live, { method: "POST" }) : current);
    } catch {
      setError(t("apps.mate.quick.qrUnavailable"));
    }
  }

  async function submitVerifyCode(event: FormEvent) {
    event.preventDefault();
    if (!session || !weixin?.sessionId || !/^\d{4,8}$/.test(verifyCode)) return;
    try {
      setWeixin(await requestWeixin(session, { method: "POST", sessionId: weixin.sessionId, verifyCode }));
      setVerifyCode("");
    } catch { setError(t("apps.mate.quick.verifyFailed")); }
  }

  async function copy(value: string, kind: "link") {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(undefined), 1600);
  }

  return (
    <ModalShell
      ariaLabel={t("apps.mate.quick.aria")}
      className="appsMateQuickModal"
      header={<QuickHeader phase={phase} />}
      headerActions={<Button aria-label={t("apps.detail.close")} disabled={busy} onClick={onClose} variant="icon"><X size={18} /></Button>}
      onClose={() => { if (!busy) onClose(); }}
    >
      {phase === "form" && (
        <form className="appsQuickSetupBody" onSubmit={(event) => void submit(event)}>
          <div className="appsQuickHero"><span><Sparkles size={22} /></span><div><h3>{t("apps.mate.quick.title")}</h3><p>{t("apps.mate.quick.subtitle")}</p></div></div>
          <div className="formGrid appsQuickIdentity">
            <FormField label={t("apps.mate.quick.name")} required>
              <TextInput autoFocus placeholder={t("apps.mate.quick.namePlaceholder")} required value={displayName} onChange={(event) => {
                const name = event.target.value;
                setDisplayName(name);
                if (!workEmail || code === normalizeMateCodeDraft(displayName)) {
                  const nextCode = normalizeMateCodeDraft(name);
                  setWorkEmail(nextCode ? `${nextCode}@${mateEmailDomain ?? ""}` : "");
                }
              }} />
            </FormField>
            <FormField description={t("apps.mate.quick.codeHelp")} error={error} label={t("apps.mate.code")} required>
              <div className="appsEmailAddressInput appsMateCodeInput">
                <TextInput maxLength={63} pattern="[a-z0-9](?:[a-z0-9\x2d]{0,61}[a-z0-9])?" placeholder="your-name" required value={code} onChange={(event) => {
                  setError("");
                  const nextCode = normalizeMateCodeDraft(event.target.value);
                  setWorkEmail(nextCode ? `${nextCode}@${mateEmailDomain ?? ""}` : "");
                }} />
                <span aria-hidden="true">@{mateEmailDomain ?? ""}</span>
              </div>
            </FormField>
          </div>
          <FormField full label={t("apps.mate.avatar")}>
            <MateAvatarChoices catalog={catalog} onChange={setAvatarUrl} value={avatarUrl} />
          </FormField>
          <section className="appsQuickDefaults"><div><strong>{t("apps.mate.quick.defaultsTitle")}</strong><small>{t("apps.mate.quick.defaultsHint")}</small></div><ul>
            <li><Check size={14} />{t("apps.mate.quick.defaultKnowledge")}</li>
            <li><Check size={14} />{t("apps.mate.quick.defaultApps")}</li>
            <li><Check size={14} />{t("apps.mate.quick.defaultFolders")}</li>
            <li><Check size={14} />{t("apps.mate.quick.defaultChannels")}</li>
          </ul></section>
          <div className="appsQuickActions"><Button onClick={() => onAdvanced()} variant="secondary"><Settings size={15} />{t("apps.mate.quick.advanced")}</Button><Button disabled={!displayName.trim() || !code} type="submit" variant="primary"><Sparkles size={15} />{t("apps.mate.quick.create")}</Button></div>
        </form>
      )}
      {phase === "provisioning" && <Provisioning step={step} />}
      {phase === "failed" && created && (
        <div className="appsQuickProvisioning failed">
          <span className="appsQuickBotPulse"><Bot size={28} /></span>
          <h3>{t("apps.mate.quick.partialTitle")}</h3>
          <p>{error || t("apps.mate.quick.partialHelp")}</p>
          <div className="appsQuickRetryActions"><Button onClick={() => onAdvanced(created)} variant="secondary">{t("apps.mate.quick.manage")}</Button><Button onClick={() => void provision()} variant="primary">{t("apps.mate.quick.retry")}</Button></div>
        </div>
      )}
      {phase === "success" && created && (
        <div className="appsQuickSuccessBody">
          <div className="appsQuickSuccessTitle"><span><Check size={24} /></span><div><h3>{t("apps.mate.quick.successTitle", { name: created.displayName })}</h3><p>{t("apps.mate.quick.successSubtitle")}</p></div></div>
          <div className="appsQuickAccessGrid">
            <section className="appsQuickAccessCard web"><Bot size={20} /><div><strong>{t("apps.mate.quick.web")}</strong><p>{webUrl}</p></div><div className="appsQuickCardActions"><Button aria-label={t("common.copy")} onClick={() => void copy(webUrl, "link")} size="compact" variant="secondary"><Copy size={14} />{copied === "link" ? t("common.copied") : t("common.copy")}</Button><ButtonLink href={webPath} iconAfter={<ArrowUpRight size={14} />} size="compact" target="_blank" variant="primary">{t("apps.mate.quick.open")}</ButtonLink></div></section>
            <section className="appsQuickAccessCard weixin"><div className="appsQuickQr"><WeixinContent error={error} qrImage={qrImage} state={weixin?.state} t={t} verifyCode={verifyCode} onVerifyCode={setVerifyCode} onVerify={submitVerifyCode} /></div><div><MessageCircleMore size={20} /><strong>{t("apps.mate.quick.weixin")}</strong><p>{t("apps.mate.quick.weixinHelp")}</p></div></section>
            <section className="appsQuickAccessCard compact email"><Mail size={19} /><div><strong>{t("apps.mate.quick.email")}</strong><p>{created.workEmail}</p></div><ButtonLink href={`mailto:${created.workEmail ?? workEmail}`} iconAfter={<ArrowUpRight size={14} />} size="compact" variant="primary">{t("apps.mate.quick.composeEmail")}</ButtonLink></section>
            <section className="appsQuickAccessCard compact"><Settings size={19} /><div><strong>{t("apps.mate.quick.settings")}</strong><p>{t("apps.mate.quick.settingsHelp")}</p></div><Button onClick={() => onAdvanced(created)} size="compact" variant="secondary">{t("apps.mate.quick.manage")}</Button></section>
          </div>
          <div className="appsQuickActions"><span /><Button onClick={onClose} variant="primary">{t("apps.mate.quick.done")}</Button></div>
        </div>
      )}
    </ModalShell>
  );

  function QuickHeader({ phase: current }: { phase: SetupPhase }) {
    return <div><p className="eyebrow">Workspace Bot</p><h2>{current === "success" ? t("apps.mate.quick.ready") : t("apps.mate.quick.header")}</h2></div>;
  }

  function Provisioning({ step: current }: { step: ProvisionStep }) {
    const steps: ProvisionStep[] = ["create", "deploy", "publish", "connect"];
    const currentIndex = steps.indexOf(current);
    return <div className="appsQuickProvisioning"><span className="appsQuickBotPulse"><Bot size={28} /></span><h3>{t(`apps.mate.quick.step.${current}`)}</h3><p>{t("apps.mate.quick.provisioningHelp")}</p><ol>{steps.map((item, index) => <li className={index < currentIndex ? "done" : index === currentIndex ? "active" : ""} key={item}><span>{index < currentIndex ? <Check size={12} /> : index + 1}</span>{t(`apps.mate.quick.stepLabel.${item}`)}</li>)}</ol></div>;
  }
}

function WeixinContent({ error, onVerify, onVerifyCode, qrImage, state, t, verifyCode }: {
  error: string;
  onVerify: (event: FormEvent) => void;
  onVerifyCode: (value: string) => void;
  qrImage: string;
  state?: WeixinState["state"];
  t: ReturnType<typeof useI18n>["t"];
  verifyCode: string;
}) {
  if (state === "active") return <div className="appsQuickQrState active"><Check size={28} /><strong>{t("apps.mate.quick.weixinConnected")}</strong></div>;
  if (state === "need_verify_code") return <form className="appsQuickVerify" onSubmit={onVerify}><QrCode size={25} /><strong>{t("apps.mate.quick.verifyTitle")}</strong><input inputMode="numeric" maxLength={8} onChange={(event) => onVerifyCode(event.target.value.replace(/\D/g, ""))} value={verifyCode} /><Button disabled={!/^\d{4,8}$/.test(verifyCode)} size="compact" type="submit" variant="primary">{t("apps.mate.quick.verify")}</Button></form>;
  if (qrImage) return <><img alt={t("apps.mate.quick.qrAlt")} src={qrImage} /><small>{state === "scanned" ? t("apps.mate.quick.scanned") : t("apps.mate.quick.scan")}</small></>;
  return <div className="appsQuickQrState"><QrCode size={27} /><small>{error || t("apps.mate.quick.qrLoading")}</small></div>;
}

async function requestLiveSession(mateId: string): Promise<LiveSession> {
  const response = await fetch("/api/mate-runtime/live-sessions", {
    body: JSON.stringify({ mateId }), credentials: "include", headers: { accept: "application/json", "content-type": "application/json" }, method: "POST"
  });
  const payload = await response.json() as { session?: LiveSession };
  if (!response.ok || !payload.session) throw new Error("live_session_unavailable");
  return payload.session;
}

async function requestWeixin(session: LiveSession, input: { method?: "GET" | "POST"; sessionId?: string; signal?: AbortSignal; verifyCode?: string } = {}): Promise<WeixinState> {
  const suffix = input.sessionId ? `/authorize/${encodeURIComponent(input.sessionId)}${input.verifyCode ? "/verify" : ""}` : input.method === "POST" ? "/authorize" : "";
  const response = await fetch(new URL(`/v1/mates/${encodeURIComponent(session.mate.id)}/channels/weixin${suffix}`, session.runtimeOrigin), {
    body: input.verifyCode ? JSON.stringify({ code: input.verifyCode }) : undefined,
    headers: { accept: "application/json", authorization: `Bearer ${session.accessToken}`, ...(input.verifyCode ? { "content-type": "application/json" } : {}) },
    method: input.method ?? "GET",
    signal: input.signal
  });
  const payload = await response.json() as WeixinState;
  if (!response.ok || !payload.state) throw new Error("weixin_unavailable");
  return payload;
}
