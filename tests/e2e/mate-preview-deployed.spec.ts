import { expect, test } from "@playwright/test";
import {
  debugField,
  expectPreviewHostReady,
  expectPreviewTurnSettled,
  installMateSocketProbe,
  sendPreviewMessage,
  matePreview
} from "./fixtures/matePreview";

const mateId = coordinate("MATE_PREVIEW_MATE_ID");
const releaseId = coordinate("MATE_PREVIEW_RELEASE_ID");
const runtimeOrigin = httpsOrigin("MATE_PREVIEW_RUNTIME_ORIGIN");
const prompt = boundedEnvironmentText("MATE_PREVIEW_SYNTHETIC_PROMPT", 2_000);
const expectedMarker = boundedEnvironmentText("MATE_PREVIEW_EXPECTED_MARKER", 500);
const requireActiveResume = process.env.MATE_PREVIEW_REQUIRE_ACTIVE_RESUME?.trim() === "true";
const resumePrompt = requireActiveResume
  ? boundedEnvironmentText("MATE_PREVIEW_RESUME_PROMPT", 2_000)
  : undefined;

test("deployed Preview boots, completes, hydrates, and reconnects without credential artifacts", async ({
  context,
  page
}) => {
  const socket = await installMateSocketProbe(context, runtimeOrigin);
  await page.goto(previewPath(), { waitUntil: "domcontentloaded" });
  await expectPreviewHostReady(page, { mode: "preview", releaseId });
  await assertCredentialHygiene(page);

  const conversationId = (await debugField(page, "conversation").textContent())?.trim() || "";
  expect(conversationId).toMatch(/^[A-Za-z0-9_-]{3,180}$/);

  await sendPreviewMessage(page, prompt);
  await expect(page.getByTestId("preview-message-user")).toHaveCount(1);
  await expectPreviewTurnSettled(page, "completed");
  await expect(page.getByTestId("preview-message-assistant")).toHaveCount(1);
  const found = await page.getByTestId("preview-message-assistant").evaluateAll(
    (messages, marker) => messages.some((message) => (message.textContent ?? "").includes(marker)),
    expectedMarker
  );
  expect(found).toBe(true);
  const messageIds = await transcriptMessageIds(page);
  expect(messageIds).toHaveLength(2);
  expect(new Set(messageIds).size).toBe(messageIds.length);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expectPreviewHostReady(page, { conversationId, mode: "preview", releaseId });
  expect(await transcriptMessageIds(page)).toEqual(messageIds);
  await assertCredentialHygiene(page);

  const beforeIdleCut = socket.connectionCount();
  await socket.cutLatest();
  await socket.waitForConnections(beforeIdleCut + 1, 30_000);
  await expectPreviewHostReady(page, { conversationId, mode: "preview", releaseId });
  await expect.poll(() => socket.frames().some((frame) => (
    frame.direction === "client" && frame.type === "cf_agent_stream_resume_request"
  ))).toBe(true);

  if (requireActiveResume && resumePrompt) {
    const beforeActiveCut = socket.connectionCount();
    await sendPreviewMessage(page, resumePrompt);
    await expect(page.getByTestId(matePreview.host)).toHaveAttribute("data-streaming", "true");
    await expect.poll(() => socket.frames().some((frame) => (
      frame.direction === "server"
      && frame.type === "cf_agent_use_chat_response"
      && frame.done !== true
    ))).toBe(true);
    await socket.cutLatest();
    await socket.waitForConnections(beforeActiveCut + 1, 30_000);
    await expect.poll(() => socket.frames().some((frame) => (
      frame.direction === "server" && frame.type === "cf_agent_stream_resuming"
    ))).toBe(true);
    await expect.poll(() => socket.frames().some((frame) => (
      frame.direction === "client" && frame.type === "cf_agent_stream_resume_ack"
    ))).toBe(true);
    await expectPreviewTurnSettled(page, "completed");
    const finalIds = await transcriptMessageIds(page);
    expect(new Set(finalIds).size).toBe(finalIds.length);
    expect(finalIds).toHaveLength(4);
  }
});

function previewPath() {
  const query = new URLSearchParams({ debug: "1", release: releaseId });
  return `/mates/${encodeURIComponent(mateId)}/preview?${query}`;
}

async function transcriptMessageIds(page: Parameters<typeof expectPreviewHostReady>[0]) {
  return page.locator("[data-message-id]").evaluateAll((messages) => (
    messages.map((message) => message.getAttribute("data-message-id") ?? "")
  ));
}

async function assertCredentialHygiene(page: Parameters<typeof expectPreviewHostReady>[0]) {
  const safe = await page.evaluate(() => {
    const url = new URL(window.location.href);
    const jwt = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
    const urlClean = ![...url.searchParams].some(([key, value]) => (
      /token|grant|authorization|bearer/i.test(key) || jwt.test(value)
    ));
    const inspectorClean = !jwt.test(document.body.textContent ?? "");
    const storageClean = [window.localStorage, window.sessionStorage].every((storage) => (
      Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "")
        .every((key) => {
          const value = storage.getItem(key) ?? "";
          return !/token|grant|authorization|bearer/i.test(key)
            && !jwt.test(value);
        })
    ));
    return inspectorClean && urlClean && storageClean;
  });
  expect(safe).toBe(true);
}

function coordinate(name: string) {
  const value = process.env[name]?.trim() || "";
  if (!/^[A-Za-z0-9_-]{3,180}$/.test(value)) {
    throw new Error("mate_preview_acceptance_coordinate_invalid");
  }
  return value;
}

function httpsOrigin(name: string) {
  try {
    const url = new URL(process.env[name]?.trim() || "");
    if (
      url.protocol !== "https:"
      || url.pathname !== "/"
      || url.search
      || url.hash
      || url.username
      || url.password
    ) throw new Error("invalid_origin");
    return url.origin;
  } catch {
    throw new Error("mate_preview_acceptance_runtime_origin_invalid");
  }
}

function boundedEnvironmentText(name: string, maximum: number) {
  const value = process.env[name]?.trim() || "";
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("mate_preview_acceptance_text_invalid");
  }
  return value;
}
