export type PreviewTurnOutcome = "cancelled" | "completed" | "failed" | "idle" | "paused" | "running" | "resuming";

export type PreviewTurnOutcomeEvent = "cancel" | "error" | "finish" | "pause" | "resume" | "send";

export function nextPreviewTurnOutcome(
  current: PreviewTurnOutcome,
  event: PreviewTurnOutcomeEvent
): PreviewTurnOutcome {
  if (event === "send") return "running";
  if (event === "resume") return "resuming";
  if (event === "pause") return current === "cancelled" ? "cancelled" : "paused";
  if (event === "cancel") return "cancelled";
  if (event === "finish") return current === "cancelled" || current === "paused" || current === "failed" ? current : "completed";
  return current === "cancelled" ? "cancelled" : "failed";
}
