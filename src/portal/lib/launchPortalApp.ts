import type { PortalApp } from "../../shared/types";

export async function launchPortalApp(
  app: Pick<PortalApp, "id" | "launchUrl"> & { trackingSource?: string }
) {
  const targetWindow = window.open("", "_blank");

  if (targetWindow) {
    targetWindow.opener = null;
  }

  void recordAppVisit(app.id, app.trackingSource ?? "portal_app_entry");

  // Every App owns its login start and local session. Opening the canonical
  // origin lets Workspace Auth reuse the existing SSO session through the standard
  // one-time-code flow without minting a Portal-carried identity snapshot.
  openLaunchUrl(targetWindow, app.launchUrl);
}

function openLaunchUrl(targetWindow: Window | null, url: string) {
  if (targetWindow) {
    targetWindow.location.href = url;
    return;
  }

  window.location.assign(url);
}

async function recordAppVisit(targetId: string, source: string) {
  try {
    await fetch("/api/publication/interactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "app.visit_url",
        source,
        targetId
      }),
      keepalive: true
    });
  } catch {
    // App navigation must never be blocked by analytics availability.
  }
}
