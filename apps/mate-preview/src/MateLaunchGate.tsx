import mateRunningUrl from "./assets/workspace-ping/running.gif";
import { matePetIdFromAvatarUrl } from "../../../src/shared/matePet";
import "./launch-gate.css";
import { useMateLocale, type MateLocale } from "./locale";

export function MateLaunchGate({
  avatarUrl,
  locale,
  minimal = false,
  mode = "live",
  testId = "mate-launch-loading"
}: {
  avatarUrl?: string;
  locale?: MateLocale;
  minimal?: boolean;
  mode?: "live" | "preview";
  testId?: string;
}) {
  const context = useMateLocale();
  const text = locale === undefined ? context.text : (chinese: string, english: string) => locale === "en" ? english : chinese;
  const preview = mode === "preview";
  const petId = matePetIdFromAvatarUrl(avatarUrl);
  const runningUrl = petId ? `/assets/mate-pet-actions/${petId}/running.webp` : mateRunningUrl;

  return (
    <main
      aria-busy="true"
      aria-live="polite"
      className={`tm-launch-gate${minimal ? " is-minimal" : ""}`}
      data-testid={testId}
      role="status"
    >
      {minimal ? (
        <>
          <span aria-hidden="true" className="tm-launch-gate-spinner" />
          <span className="tm-launch-gate-minimal-label">{text("正在加载 Mate", "Loading Mate")}</span>
        </>
      ) : (
        <>
          <img
            alt=""
            aria-hidden="true"
            className="tm-launch-gate-avatar"
            decoding="async"
            fetchPriority="high"
            src={runningUrl}
          />
          <p className="tm-launch-gate-eyebrow">Mate</p>
          <h1>{preview ? text("正在打开 Mate Preview", "Opening Mate Preview") : text("正在打开 Mate", "Opening Mate")}</h1>
          <p>
            {preview
              ? text("正在建立 Owner 专用 Preview Session，并校验候选 Release。", "Creating an owner-only Preview session and validating the candidate release.")
              : text("正在建立当前用户的 Mate Session。", "Creating a Mate session for the current user.")}
          </p>
        </>
      )}
    </main>
  );
}
