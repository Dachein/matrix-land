import { useEffect, useRef } from "react";
import { longChatAbsence } from "./sessionRecovery";

/** Detect hidden tabs, window switches, and suspended computers without periodic interruptions. */
export function useChatReturnCheck(check: (signal: AbortSignal) => Promise<void>) {
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    let awayAt: number | undefined;
    let lastHeartbeat = Date.now();
    let checking = false;
    let checkController: AbortController | undefined;
    const returned = () => {
      const now = Date.now();
      if (document.visibilityState === "hidden") return;
      const absent = longChatAbsence({ now, awayAt, lastHeartbeat });
      awayAt = undefined;
      lastHeartbeat = now;
      if (!absent || checking) return;
      checking = true;
      checkController = new AbortController();
      void checkRef.current(checkController.signal).finally(() => { checking = false; });
    };
    const away = () => { awayAt ??= Date.now(); };
    const visibility = () => document.visibilityState === "hidden" ? away() : returned();
    window.addEventListener("blur", away);
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", visibility);
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState !== "hidden" && document.hasFocus()) returned();
    }, 60_000);
    return () => {
      checkController?.abort();
      window.removeEventListener("blur", away);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", visibility);
      window.clearInterval(heartbeat);
    };
  }, []);
}
