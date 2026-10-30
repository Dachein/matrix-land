import { FeedbackNotice } from "../../../../src/portal/components/FeedbackNotice";
import { Check, LoaderCircle, MessageCircleMore, QrCode, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { createMiniappLoginTicket, readMiniappLoginStatus, type MiniappLoginTicket } from "../../../mate-preview/src/miniappLogin";
import "../styles/miniapp-login.css";

export function MiniappLoginModal({ open, onClose, zh }: { open: boolean; onClose: () => void; zh: boolean }) {
  const [ticket, setTicket] = useState<MiniappLoginTicket | null>(null);
  const [status, setStatus] = useState<"loading" | "pending" | "scanned" | "authenticated" | "failed">("loading");
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setStatus("loading");
    setTicket(null);
    setError("");
    void createMiniappLoginTicket(fetch, controller.signal)
      .then((nextTicket) => {
        if (controller.signal.aborted) return;
        setTicket(nextTicket);
        setStatus("pending");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setStatus("failed");
        setError(zh ? "暂时无法生成小程序登录码，请稍后重试。" : "Unable to generate a miniapp sign-in code. Try again later.");
      });
    return () => controller.abort();
  }, [generation, open, zh]);

  useEffect(() => {
    if (!open || !ticket || !["pending", "scanned"].includes(status)) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const nextStatus = await readMiniappLoginStatus(fetch, ticket.ticket, controller.signal);
        if (controller.signal.aborted) return;
        if (nextStatus === "authenticated") {
          setStatus("authenticated");
        } else if (nextStatus === "expired") {
          setGeneration((value) => value + 1);
        } else {
          setStatus(nextStatus);
          timer = window.setTimeout(() => void poll(), 1200);
        }
      } catch {
        if (!controller.signal.aborted) {
          setStatus("failed");
          setError(zh ? "扫码状态检查中断，请重新生成登录码。" : "QR status checking stopped. Generate a new sign-in code.");
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 1200);
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [open, status, ticket, zh]);

  useEffect(() => {
    if (!open || !ticket || !["pending", "scanned"].includes(status)) return;
    const remaining = Math.max(0, Date.parse(ticket.expiresAt) - Date.now());
    const timer = window.setTimeout(() => setGeneration((value) => value + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [open, status, ticket]);

  if (!open) return null;

  return <ModalShell
    ariaLabel={zh ? "通过微信访问" : "Access through WeChat"}
    header={<><MessageCircleMore aria-hidden="true" className="portal-miniapp-login-wechat-mark" size={19} /><span className="portal-miniapp-login-heading"><strong>{zh ? "通过微信访问" : "Access through WeChat"}</strong><small>{zh ? "扫码登录 Mate 小程序" : "Scan to sign in to the Mate miniapp"}</small></span><button aria-label={zh ? "关闭微信访问" : "Close WeChat access"} className="portal-miniapp-login-close" onClick={onClose} type="button"><X size={18} /></button></>}
    headerClassName="portal-miniapp-login-header"
    modalClassName="portal-miniapp-login-dialog"
    onClose={onClose}
    overlayClassName="portal-miniapp-login-overlay"
  >
    <div aria-label={zh ? "微信访问方式" : "WeChat access methods"} className="portal-miniapp-login-tabs" role="tablist">
      <span aria-selected="true" id="portal-miniapp-login-tab" role="tab">{zh ? "小程序登录" : "Miniapp sign-in"}</span>
    </div>
    <div aria-live="polite" className="portal-miniapp-login-body" role="status">
      {status === "loading" && <div className="portal-miniapp-login-state"><LoaderCircle className="portal-miniapp-login-spinner" size={25} /><strong>{zh ? "正在生成小程序登录码" : "Generating a miniapp sign-in code"}</strong></div>}
      {status === "pending" && ticket && <div className="portal-miniapp-login-qr"><img alt={zh ? "Mate 专用小程序登录码" : "Mate miniapp sign-in code"} src={ticket.qrImageDataUrl} /><strong>{zh ? "使用微信扫一扫登录小程序" : "Scan with WeChat to sign in to the miniapp"}</strong><p>{zh ? "小程序码两分钟内有效，只能登录一次。请勿转发给他人。" : "The miniapp code expires in two minutes, works once, and should not be shared."}</p><span><LoaderCircle className="portal-miniapp-login-spinner" size={12} />{zh ? "等待微信扫码" : "Waiting for WeChat scan"}</span></div>}
      {status === "scanned" && <div className="portal-miniapp-login-state"><LoaderCircle className="portal-miniapp-login-spinner" size={25} /><strong>{zh ? "已扫码，正在登录小程序" : "Scanned. Signing in to the miniapp"}<small>{zh ? "等待手机登录" : "Waiting for phone sign-in"}</small></strong></div>}
      {status === "authenticated" && <><span className="portal-miniapp-login-success"><Check size={26} /></span><strong>{zh ? "小程序登录成功" : "Miniapp sign-in complete"}<small>{zh ? "现在可以在 Mate 小程序中继续使用。" : "You can now continue in the Mate miniapp."}</small></strong></>}
      {status === "failed" && <div className="portal-miniapp-login-state"><QrCode size={26} /><strong>{zh ? "暂时无法生成登录码" : "Unable to generate sign-in code"}</strong><Button onClick={() => setGeneration((value) => value + 1)} variant="primary">{zh ? "重新生成" : "Generate again"}</Button>{error && <FeedbackNotice tone="error">{error}</FeedbackNotice>}</div>}
    </div>
  </ModalShell>;
}
