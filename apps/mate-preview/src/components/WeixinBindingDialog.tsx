import { Check, LoaderCircle, MessageCircleMore, QrCode, Unlink, X } from "lucide-react";
import QRCode from "qrcode";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  freshMateWeixinSession,
  requestMateWeixinBinding,
  MatePreviewApiError,
  type MatePreviewSession,
  type MateWeixinBindingState
} from "../api";
import { useMateLocale, type MateLocale } from "../locale";
import { createMiniappLoginTicket, readMiniappLoginStatus, type MiniappLoginTicket } from "../miniappLogin";

export function WeixinBindingDialog({
  endpoint,
  fetch: fetcher,
  onClose,
  open,
  session
}: {
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  onClose: () => void;
  open: boolean;
  session: MatePreviewSession;
}) {
  const { text } = useMateLocale();
  const [tab, setTab] = useState<"miniapp" | "qclaw">("miniapp");

  useEffect(() => { if (!open) setTab("miniapp"); }, [open]);

  if (!open) return null;
  return <div className="tm-weixin-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-labelledby="tm-weixin-title" aria-modal="true" className="tm-weixin-dialog" role="dialog">
      <header><MessageCircleMore size={19} /><span><strong id="tm-weixin-title">{text("通过微信访问", "Access through WeChat")}</strong><small>{tab === "miniapp" ? text("扫码登录 Mate 小程序", "Scan to sign in to the Mate miniapp") : text("私聊消息进入当前 Mate 对话", "Private messages enter the current Mate conversation")}</small></span><button aria-label={text("关闭微信访问", "Close WeChat access")} onClick={onClose} type="button"><X size={16} /></button></header>
      <div aria-label={text("微信访问方式", "WeChat access methods")} className="tm-weixin-tabs" role="tablist">
        <button aria-controls="tm-weixin-miniapp-panel" aria-selected={tab === "miniapp"} id="tm-weixin-miniapp-tab" onClick={() => setTab("miniapp")} role="tab" type="button">{text("小程序登录", "Miniapp sign-in")}</button>
        <button aria-controls="tm-weixin-qclaw-panel" aria-selected={tab === "qclaw"} id="tm-weixin-qclaw-tab" onClick={() => setTab("qclaw")} role="tab" type="button">{text("微信Q-Claw连接", "WeChat Q-Claw connection")}</button>
      </div>
      <div aria-labelledby={tab === "miniapp" ? "tm-weixin-miniapp-tab" : "tm-weixin-qclaw-tab"} className="tm-weixin-body" id={tab === "miniapp" ? "tm-weixin-miniapp-panel" : "tm-weixin-qclaw-panel"} role="tabpanel">
        {tab === "miniapp" ? <MiniappLoginPanel fetcher={fetcher} /> : <QClawPanel endpoint={endpoint} fetcher={fetcher} session={session} />}
      </div>
    </section>
  </div>;
}

function MiniappLoginPanel({ fetcher = globalThis.fetch }: { fetcher?: typeof globalThis.fetch }) {
  const { text } = useMateLocale();
  const [ticket, setTicket] = useState<MiniappLoginTicket | null>(null);
  const [qrImage, setQrImage] = useState("");
  const [status, setStatus] = useState<"loading" | "pending" | "scanned" | "authenticated" | "failed">("loading");
  const [error, setError] = useWeixinError();
  const [generation, setGeneration] = useState(0);
  const renewingTicketRef = useRef("");
  const renewTicket = useCallback((expiredTicket: string) => {
    if (renewingTicketRef.current === expiredTicket) return;
    renewingTicketRef.current = expiredTicket;
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setTicket(null);
    setQrImage("");
    setError("");
    void createMiniappLoginTicket(fetcher, controller.signal)
      .then((current) => {
        if (!controller.signal.aborted) { setTicket(current); setQrImage(current.qrImageDataUrl); setStatus("pending"); }
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setStatus("failed");
        if (reason instanceof Error && reason.message === "miniapp_login_required") {
          setError("请先登录 Workspace Web，再生成小程序登录码。", "Sign in to Workspace Web before generating a miniapp code.");
        } else {
          setError("暂时无法生成小程序登录码，请稍后重试。", "Unable to generate a miniapp sign-in code. Try again later.");
        }
      });
    return () => controller.abort();
  }, [fetcher, generation]);

  useEffect(() => {
    if (!ticket || (status !== "pending" && status !== "scanned")) return;
    const remaining = Math.max(0, Date.parse(ticket.expiresAt) - Date.now());
    const timer = window.setTimeout(() => renewTicket(ticket.ticket), remaining);
    return () => window.clearTimeout(timer);
  }, [renewTicket, status, ticket]);

  useEffect(() => {
    if (!ticket || (status !== "pending" && status !== "scanned")) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const current = await readMiniappLoginStatus(fetcher, ticket.ticket, controller.signal);
        if (controller.signal.aborted) return;
        if (current === "pending" || current === "scanned") {
          setStatus(current);
          timer = window.setTimeout(() => void poll(), 1200);
        } else if (current === "expired") renewTicket(ticket.ticket);
        else setStatus(current);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setStatus("failed");
          setError("扫码状态检查中断，请重新生成登录码。", "QR status checking stopped. Generate a new code.");
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 1200);
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [fetcher, renewTicket, status, ticket]);

  if (status === "loading") return <State icon={<LoaderCircle className="is-spinning" size={25} />} title={text("正在生成小程序登录码", "Generating a miniapp sign-in code")} />;
  if (status === "authenticated") return <div className="tm-weixin-active"><Check size={27} /><strong>{text("小程序登录成功", "Miniapp sign-in complete")}</strong><p>{text("现在可以在 Mate 小程序中继续使用。", "You can now continue in the Mate miniapp.")}</p></div>;
  if ((status === "pending" || status === "scanned") && ticket) return <div className="tm-weixin-qr"><img alt={text("Mate 专用小程序登录码", "Mate miniapp sign-in code")} src={qrImage} /><strong>{status === "scanned" ? text("已扫码，正在登录小程序", "Scanned. Signing in to the miniapp") : text("使用微信扫一扫登录小程序", "Scan with WeChat to sign in to the miniapp")}</strong><p>{text("小程序码两分钟内有效，只能登录一次。请勿转发给他人。", "The miniapp code expires in two minutes, works once, and should not be shared.")}</p><span><LoaderCircle className="is-spinning" size={12} />{status === "scanned" ? text("等待手机登录", "Waiting for phone sign-in") : text("等待微信扫码", "Waiting for WeChat scan")}</span></div>;
  return <><State icon={<QrCode size={26} />} title={text("暂时无法生成登录码", "Unable to generate sign-in code")}><button onClick={() => setGeneration((value) => value + 1)} type="button">{text("重新生成", "Generate again")}</button></State>{error && <p className="tm-weixin-error" role="alert">{error}</p>}</>;
}

function QClawPanel({ endpoint, fetcher, session }: { endpoint?: string; fetcher?: typeof globalThis.fetch; session: MatePreviewSession }) {
  const { locale, text } = useMateLocale();
  const [binding, setBinding] = useState<MateWeixinBindingState>({ state: "unbound" });
  const [error, setError] = useWeixinError();
  const [loading, setLoading] = useState(false);
  const [qrImage, setQrImage] = useState("");
  const [verifyCode, setVerifyCode] = useState("");
  const startedRef = useRef(false);
  const sessionRef = useRef(session);

  useEffect(() => {
    const current = sessionRef.current;
    if (current.principalKey !== session.principalKey || current.mate.id !== session.mate.id) {
      startedRef.current = false;
      setBinding({ state: "unbound" });
    }
    if (current.principalKey !== session.principalKey || current.mate.id !== session.mate.id
      || Date.parse(session.expiresAt) > Date.parse(current.expiresAt)) sessionRef.current = session;
  }, [session]);

  const requestBinding = useCallback(async (input: Omit<Parameters<typeof requestMateWeixinBinding>[0], "fetch" | "session">) => {
    const fresh = await freshMateWeixinSession({ endpoint, fetch: fetcher, session: sessionRef.current, signal: input.signal });
    sessionRef.current = fresh;
    return requestMateWeixinBinding({ ...input, fetch: fetcher, session: fresh });
  }, [endpoint, fetcher]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void requestBinding({ signal: controller.signal })
      .then(async (current) => {
        if (current.state !== "unbound" || startedRef.current) return current;
        startedRef.current = true;
        return requestBinding({ method: "POST", signal: controller.signal });
      })
      .then((current) => { if (!controller.signal.aborted) setBinding(current); })
      .catch((reason) => {
        if ((reason as Error).name !== "AbortError") setError("暂时无法创建微信绑定二维码，请稍后重试。", "Unable to create a WeChat binding QR code. Try again later.", reason);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [requestBinding, session.principalKey, session.mate.id]);

  useEffect(() => {
    if (!binding.qrContent) { setQrImage(""); return; }
    let active = true;
    void QRCode.toDataURL(binding.qrContent, {
      color: { dark: "#17231d", light: "#ffffff" }, errorCorrectionLevel: "M", margin: 1, width: 256
    }).then((value) => { if (active) setQrImage(value); })
      .catch(() => { if (active) setError("二维码渲染失败，请重新生成。", "The QR code could not be rendered. Generate a new one."); });
    return () => { active = false; };
  }, [binding.qrContent]);

  useEffect(() => {
    if (!binding.sessionId || !["pending", "scanned"].includes(binding.state)) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const current = await requestBinding({ sessionId: binding.sessionId, signal: controller.signal });
        setBinding(current);
        if (["pending", "scanned"].includes(current.state)) timer = window.setTimeout(() => void poll(), 900);
      } catch (reason) {
        if ((reason as Error).name !== "AbortError") setError("扫码状态检查中断，请重新生成二维码。", "QR status polling was interrupted. Generate a new code.", reason);
      }
    };
    timer = window.setTimeout(() => void poll(), 300);
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [binding.sessionId, binding.state, requestBinding]);

  async function restart() {
    setLoading(true); setError("");
    try {
      setBinding(await requestBinding({ method: "POST" }));
      startedRef.current = true;
    } catch (reason) { setError("暂时无法创建微信绑定二维码，请稍后重试。", "Unable to create a WeChat binding QR code. Try again later.", reason); }
    finally { setLoading(false); }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (!binding.sessionId || !/^\d{4,8}$/.test(verifyCode)) return;
    setLoading(true); setError("");
    try {
      setBinding(await requestBinding({ method: "POST", sessionId: binding.sessionId, verifyCode }));
      setVerifyCode("");
    } catch { setError("校验码未能提交，请检查后重试。", "The verification code could not be submitted. Check it and try again."); }
    finally { setLoading(false); }
  }

  async function revoke() {
    if (!window.confirm(text("解除微信与当前 Mate 的绑定？", "Disconnect WeChat from this Mate?"))) return;
    setLoading(true); setError("");
    try {
      setBinding(await requestBinding({ method: "DELETE" }));
      startedRef.current = false;
    } catch { setError("解除绑定失败，请稍后重试。", "Unable to disconnect. Try again later."); }
    finally { setLoading(false); }
  }

  const waiting = ["pending", "scanned"].includes(binding.state);
  return <>
        {loading && !binding.qrContent && binding.state !== "active" ? <State icon={<LoaderCircle className="is-spinning" size={25} />} title={text("正在生成安全二维码", "Generating a secure QR code")} />
          : binding.state === "active" ? <div className="tm-weixin-active"><Check size={27} /><strong>{text("微信私聊已绑定", "WeChat private chat connected")}</strong><p>{text("微信消息、嵌入式 SDK 与工作台共享同一个对话；每条消息都会重新校验当前用户权限。", "WeChat, the embedded SDK, and the workspace share the same conversation. Every message revalidates the current user's access.")}</p><dl><div><dt>{text("绑定时间", "Connected")}</dt><dd>{formatDate(binding.boundAt, locale)}</dd></div><div><dt>{text("最近使用", "Last used")}</dt><dd>{formatDate(binding.lastUsedAt, locale, text("尚未使用", "Not used yet"))}</dd></div></dl><button disabled={loading} onClick={() => void revoke()} type="button"><Unlink size={14} />{text("解除绑定", "Disconnect")}</button></div>
            : binding.state === "need_verify_code" ? <form onSubmit={(event) => void submitCode(event)}><QrCode size={27} /><strong>{text("完成手机端校验", "Complete mobile verification")}</strong><p>{text("输入手机微信中显示的 4–8 位数字。", "Enter the 4–8 digit code shown in WeChat on your phone.")}</p><input autoFocus inputMode="numeric" maxLength={8} onChange={(event) => setVerifyCode(event.target.value.replace(/\D/g, ""))} value={verifyCode} /><button disabled={loading || !/^\d{4,8}$/.test(verifyCode)}>{text("继续绑定", "Continue")}</button></form>
              : waiting && qrImage ? <div className="tm-weixin-qr"><img alt={text("微信 Mate 绑定二维码", "WeChat Mate binding QR code")} src={qrImage} /><p className="tm-weixin-protocol-note">{text("该连接使用微信官方 OpenClaw 连接协议，因此你的 Agent 会被识别为 OpenClaw 进行接入，在技术上无额外数据和安全风险。", "This connection uses WeChat's official OpenClaw protocol. Your Agent is identified as OpenClaw to connect, with no additional technical data or security risks.")}</p><strong>{binding.state === "scanned" ? text("已扫码，正在确认", "Scanned, awaiting confirmation") : text("使用手机微信扫码", "Scan with WeChat on your phone")}</strong><p>{text("二维码只绑定当前登录用户和这个 Mate；群聊不会进入 Agent。", "The QR code only connects the signed-in user and this Mate. Group chats do not enter the Agent.")}</p><span><LoaderCircle className="is-spinning" size={12} />{text("等待微信确认", "Waiting for WeChat confirmation")}</span></div>
                : <State icon={<QrCode size={26} />} title={binding.state === "expired" ? text("二维码已过期", "QR code expired") : text("暂时无法完成绑定", "Unable to complete binding")}><button disabled={loading} onClick={() => void restart()} type="button">{text("重新生成", "Generate again")}</button></State>}
        {error && <p className="tm-weixin-error" role="alert">{error}</p>}
  </>;
}

function State({ children, icon, title }: { children?: React.ReactNode; icon: React.ReactNode; title: string }) {
  return <div className="tm-weixin-state">{icon}<strong>{title}</strong>{children}</div>;
}
function useWeixinError() {
  const { text } = useMateLocale();
  const [details, setDetails] = useState<{ chinese: string; english: string; code?: string }>();
  const setError = useCallback((chinese: string, english = "", reason?: unknown) => {
    setDetails(chinese ? { chinese, english, code: reason instanceof MatePreviewApiError ? reason.code : undefined } : undefined);
  }, []);
  const error = details ? `${text(details.chinese, details.english)}${details.code ? ` (${details.code})` : ""}` : "";
  return [error, setError] as const;
}
function formatDate(value: string | undefined, locale: MateLocale, fallback = "—") {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
