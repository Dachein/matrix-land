import { useEffect, useRef, useState, type ReactNode } from "react";

/** Opt-in exit transition. Keep children mounted here, rather than conditionally outside. */
export function Presence({ visible, children }: { visible: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(visible);
  const rootRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    if (visible) { setMounted(true); return; }
    if (!mounted) return;
    const root = rootRef.current;
    if (!root || !root.closest(".fw-scope") || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setMounted(false); return; }
    const rawDuration = getComputedStyle(root).getPropertyValue("--fw-motion-exit").trim();
    const parsed = Number.parseFloat(rawDuration);
    const duration = Number.isFinite(parsed) ? parsed * (rawDuration.endsWith("ms") ? 1 : 1000) : 120;
    // Fallback covers missing animation events (background tab, interrupted animation).
    const timer = window.setTimeout(() => { if (!visibleRef.current) setMounted(false); }, duration + 50);
    return () => window.clearTimeout(timer);
  }, [visible, mounted]);
  if (!mounted && !visible) return null;
  return <div ref={rootRef} data-ui="presence" data-state={visible ? "entering" : "exiting"}
    onAnimationEnd={event => { if (!visibleRef.current && event.animationName === "fw-exit") setMounted(false); }}>
    {children}
  </div>;
}
