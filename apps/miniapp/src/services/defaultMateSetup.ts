import type { Mate } from "../types";
import { isAuthRequiredError } from "./auth";

export type FirstMateProgress = "create" | "configure" | "publish" | "open";
const STEPS: FirstMateProgress[] = ["create", "configure", "publish", "open"];

/** Progress follows persisted state; only a confirmed publication unlocks chat. */
export async function provisionDefaultMate(input: { displayName: string; avatarUrl: string }, dependencies: {
  activate: (input: { displayName: string; avatarUrl: string }) => Promise<Mate>;
  read: () => Promise<Mate | null>;
  onProgress: (step: FirstMateProgress) => void;
  schedule?: (poll: () => void) => ReturnType<typeof setInterval>;
  cancel?: (timer: ReturnType<typeof setInterval>) => void;
}): Promise<Mate> {
  let finished = false;
  let checking = false;
  let progress: FirstMateProgress = "create";
  const advance = (next: FirstMateProgress) => {
    if (finished || STEPS.indexOf(next) <= STEPS.indexOf(progress)) return;
    progress = next;
    dependencies.onProgress(next);
  };
  dependencies.onProgress("create");
  const timer = (dependencies.schedule || ((poll) => setInterval(poll, 2500)))(() => {
    if (finished || checking) return;
    checking = true;
    void dependencies.read().then((mate) => {
      if (!mate) return;
      // A published record may still be awaiting the activation response.
      advance(mate.status === "published" || mate.status === "deployed" ? "publish" : "configure");
    }).catch(() => { /* The activation and final recovery handle request failures. */ })
      .finally(() => { checking = false; });
  });
  try {
    let mate: Mate;
    try {
      mate = await dependencies.activate(input);
    } catch (error) {
      if (isAuthRequiredError(error)) throw error;
      // The server can finish publishing after the client request times out.
      let recovered: Mate | null = null;
      try { recovered = await dependencies.read(); }
      catch (readError) { if (isAuthRequiredError(readError)) throw readError; }
      if (recovered?.status !== "published") throw error;
      mate = recovered;
    }
    if (mate.status !== "published") throw new Error("default_mate_not_published");
    advance("open");
    return mate;
  } finally {
    finished = true;
    (dependencies.cancel || clearInterval)(timer);
  }
}
