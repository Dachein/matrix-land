import { expect, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

type SanitizedFrame = {
  direction: "client" | "server";
  done?: boolean;
  error?: boolean;
  replay?: boolean;
  type: string;
};

type RoutedSocket = {
  client: WebSocketRoute;
  server: WebSocketRoute;
};

export const matePreview = Object.freeze({
  cancel: "preview-cancel",
  composer: "preview-composer",
  debugInspector: "preview-debug-inspector",
  error: "preview-host-error",
  host: "mate-preview-host",
  input: "preview-message-input",
  loading: "preview-host-loading",
  resume: "preview-resume",
  send: "preview-send",
  transcript: "preview-transcript"
});

export async function expectPreviewHostReady(page: Page, expected: {
  conversationId?: string;
  mode?: "live" | "preview";
  releaseId?: string;
} = {}) {
  const host = page.getByTestId(matePreview.host);
  await expect(host).toBeVisible();
  await expect(page.getByTestId(matePreview.loading)).toHaveCount(0);
  await expect(page.getByTestId(matePreview.error)).toHaveCount(0);
  await expect(host).toHaveAttribute("data-hydration-state", "ready");
  await expect(host).toHaveAttribute("data-connection-state", "connected");
  if (expected.mode) await expect(host).toHaveAttribute("data-mode", expected.mode);
  if (expected.releaseId) {
    await expect(debugField(page, "release")).toHaveText(expected.releaseId);
  }
  if (expected.conversationId) {
    await expect(debugField(page, "conversation")).toHaveText(expected.conversationId);
  }
}

export async function sendPreviewMessage(page: Page, text: string) {
  const input = page.getByTestId(matePreview.input);
  await expect(input).toBeEnabled();
  await input.fill(text);
  const send = page.getByTestId(matePreview.send);
  await expect(send).toBeEnabled();
  await send.click({ timeout: 5_000 });
  try {
    await expect(input).toHaveValue("", { timeout: 5_000 });
  } catch {
    const outcome = await debugField(page, "last-outcome").textContent().catch(() => "unknown");
    const error = await debugField(page, "last-error").textContent().catch(() => "unknown");
    const alert = await page.getByRole("alert").first().textContent().catch(() => "none");
    throw new Error(
      `preview_send_failed:${outcome?.trim() || "unknown"}`
      + `:${safeDiagnosticCode(error)}:${safeDiagnosticCode(alert)}`
    );
  }
}

function safeDiagnosticCode(value: string | null | undefined) {
  const match = String(value ?? "").match(/[a-z][a-z0-9_]{2,95}/);
  return match?.[0] ?? "unavailable";
}

export async function expectPreviewTurnSettled(page: Page, outcome: "cancelled" | "completed" | "failed") {
  const host = page.getByTestId(matePreview.host);
  await expect(host).toHaveAttribute("data-streaming", "false");
  await expect(host).toHaveAttribute("data-recovering", "false");
  await expect(debugField(page, "last-outcome")).toHaveText(outcome);
}

export function debugField(page: Page, field: string) {
  return page.getByTestId(matePreview.debugInspector)
    .locator(`[data-debug-field="${field}"]`)
    .locator("strong");
}

/**
 * Proxies the real Agent WebSocket while retaining only protocol metadata.
 * Raw frames may carry short-lived grants, Environment coordinates, or message
 * text and are intentionally never returned to the test or written to traces.
 */
export async function installMateSocketProbe(
  context: BrowserContext,
  runtimeOrigin: string
) {
  const origin = new URL(runtimeOrigin);
  const sockets: RoutedSocket[] = [];
  const frames: SanitizedFrame[] = [];
  const waiters = new Set<() => void>();
  const protocol = origin.protocol === "https:" ? "wss:" : "ws:";

  await context.routeWebSocket((url) => (
    url.protocol === protocol
    && url.host === origin.host
    && /\/v1\/owner-test\/mates\/[^/]+\/conversations\/[^/]+\/chat(?:\?|$)/.test(url.href)
  ), (client) => {
    const server = client.connectToServer();
    const socket = { client, server };
    sockets.push(socket);
    for (const resolve of waiters) resolve();
    waiters.clear();

    client.onMessage((message) => {
      frames.push(sanitizeFrame("client", message));
      server.send(message);
    });
    server.onMessage((message) => {
      frames.push(sanitizeFrame("server", message));
      client.send(message);
    });
  });

  return {
    connectionCount: () => sockets.length,
    frames: () => frames.map((frame) => ({ ...frame })),
    async cutLatest() {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("mate_preview_socket_not_connected");
      await socket.client.close({ code: 1012, reason: "preview-acceptance-cut" });
    },
    async waitForConnections(count: number, timeoutMs = 15_000) {
      if (sockets.length >= count) return;
      const deadline = Date.now() + timeoutMs;
      while (sockets.length < count) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`mate_preview_socket_connection_timeout_${count}`);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(onConnection);
            reject(new Error(`mate_preview_socket_connection_timeout_${count}`));
          }, remaining);
          const onConnection = () => {
            clearTimeout(timer);
            resolve();
          };
          waiters.add(onConnection);
        });
      }
    }
  };
}

function sanitizeFrame(direction: SanitizedFrame["direction"], message: string | Buffer): SanitizedFrame {
  try {
    const value = JSON.parse(typeof message === "string" ? message : message.toString("utf8")) as Record<string, unknown>;
    return {
      direction,
      ...(typeof value.done === "boolean" ? { done: value.done } : {}),
      ...(typeof value.error === "boolean" ? { error: value.error } : {}),
      ...(typeof value.replay === "boolean" ? { replay: value.replay } : {}),
      type: typeof value.type === "string" ? value.type.slice(0, 120) : "unknown"
    };
  } catch {
    return { direction, type: "non_json" };
  }
}
