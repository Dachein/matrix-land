import type { PreviewTurnOutcome } from "./outcome";

export type MateSurfaceSnapshot = {
  connection: "connected" | "connecting" | "error" | "recovering" | "streaming";
  hydration: "error" | "loading" | "ready";
  lastError: string;
  lastOutcome: PreviewTurnOutcome;
  messageCount: number;
  recovering: boolean;
  streaming: boolean;
};

export const INITIAL_SURFACE_SNAPSHOT: MateSurfaceSnapshot = {
  connection: "connecting",
  hydration: "loading",
  lastError: "none",
  lastOutcome: "idle",
  messageCount: 0,
  recovering: false,
  streaming: false
};
