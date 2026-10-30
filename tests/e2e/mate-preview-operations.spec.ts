import { expect, test } from "@playwright/test";
import { debugField, matePreview } from "./fixtures/matePreview";
import { mockPortalApis } from "./fixtures/portalApi";

const RUNTIME_ORIGIN = "https://runtime.operations.preview.test";
const MATE_ID = "cortana-preview-e2e";
const RELEASE_ID = "cortana-preview-e2e-r1";

test("Operations Mate selects Task Inbox, executes Preview safely, and hydrates Tasks", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "zh-CN"));
  await mockPortalApis(page);
  const tasks: Array<Record<string, unknown>> = [
    {
      channel: "schedule",
      createdAt: "2026-08-27T11:59:00.000Z",
      id: "task_preview_schedule_1",
      instruction: "Run the scheduled private follow-up",
      releaseId: RELEASE_ID,
      sessionId: "session_preview_schedule_1",
      status: "completed",
      mateId: MATE_ID
    },
    {
      channel: "email",
      createdAt: "2026-08-27T11:58:00.000Z",
      id: "task_preview_email_1",
      instruction: "Review one-time inbound email",
      releaseId: RELEASE_ID,
      sessionId: "session_preview_email_1",
      status: "completed",
      mateId: MATE_ID
    },
    {
      channel: "mate_call",
      createdAt: "2026-08-27T11:57:00.000Z",
      id: "task_old_release_1",
      instruction: "Old Release Task",
      releaseId: "old-release",
      sessionId: "session_old_release_1",
      status: "completed",
      mateId: MATE_ID
    }
  ];
  let previewSessionRequests = 0;
  let taskListRequests = 0;
  let liveRequests = 0;

  await page.route("**/api/mate-runtime/preview-sessions", async (route) => {
    previewSessionRequests += 1;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body.mateId).toBe(MATE_ID);
    expect(body.releaseId).toBe(RELEASE_ID);
    await route.fulfill({
      contentType: "application/json",
      json: {
        session: {
          accessToken: "eyJtb2NrIjp0cnVlfQ.eyJtb2NrIjp0cnVlfQ.mock-signature",
          conversationId: "conv-preview-operations-unused",
          conversationState: "draft",
          expiresAt: "2099-08-27T10:05:00.000Z",
          mode: "preview",
          principalKey: "preview-operations-principal-key",
          release: {
            id: RELEASE_ID,
            manifestSha256: `sha256:${"b".repeat(64)}`,
            version: 1
          },
          runtimeOrigin: RUNTIME_ORIGIN,
          surface: {
            channels: ["mate_call", "email", "schedule"],
            defaultExecutor: "operations",
            entries: [
              { channel: "mate_call", kind: "task_inbox" },
              { channel: "email", kind: "task_inbox" },
              { channel: "schedule", kind: "task_inbox" }
            ],
            kind: "task_inbox"
          },
          mate: {
            description: "Synthetic Operations Preview fixture",
            displayName: "Cortana Preview",
            id: MATE_ID,
            jobRole: "Review operations tasks"
          }
        }
      },
      status: 201
    });
  });

  await page.route(`${RUNTIME_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/mates/")) liveRequests += 1;
    const base = `/v1/owner-test/mates/${MATE_ID}/tasks`;
    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: corsHeaders(page.url()), status: 204 });
      return;
    }
    if (request.method() === "GET" && url.pathname === base) {
      taskListRequests += 1;
      await route.fulfill({ contentType: "application/json", headers: corsHeaders(page.url()), json: { tasks } });
      return;
    }
    if (request.method() === "POST" && url.pathname === base) {
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body.channel).toBe("mate_call");
      expect(body.conversationId).toBeUndefined();
      expect(body.userId).toBeUndefined();
      expect((body.context as Record<string, unknown>).schemaVersion).toBe("workspace.mate-environment/v1");
      expect(((body.context as Record<string, unknown>).location as Record<string, unknown>).ref).toBe("mate:cortana-preview-e2e");
      const task = {
        channel: "mate_call",
        createdAt: "2026-08-27T12:00:00.000Z",
        id: "task_preview_operations_1",
        instruction: body.instruction,
        releaseId: RELEASE_ID,
        sessionId: "session_preview_operations_1",
        status: "queued",
        mateId: MATE_ID
      };
      tasks.unshift(task);
      await route.fulfill({ contentType: "application/json", headers: corsHeaders(page.url()), json: { task }, status: 202 });
      return;
    }
    if (request.method() === "POST" && url.pathname === `${base}/task_preview_operations_1/run`) {
      const completed = {
        ...tasks[0],
        conclusion: {
          actions: [{ title: "Review adoption signal", type: "todo.proposed" }],
          artifacts: [],
          followUps: ["Todo proposal · Review adoption signal"],
          outcome: "completed",
          summary: "Preview Operations Task completed without Live writes."
        },
        status: "completed",
        updatedAt: "2026-08-27T12:00:01.000Z"
      };
      tasks[0] = completed;
      await route.fulfill({ contentType: "application/json", headers: corsHeaders(page.url()), json: { task: completed } });
      return;
    }
    await route.fulfill({ contentType: "application/json", headers: corsHeaders(page.url()), json: { error: "unexpected_runtime_route" }, status: 404 });
  });

  const route = `/mates/${MATE_ID}/preview?release=${RELEASE_ID}&debug=1`;
  await page.goto(route, { waitUntil: "domcontentloaded" });
  const host = page.getByTestId(matePreview.host);
  await expect(host).toHaveAttribute("data-surface", "task_inbox");
  await expect(host).toHaveAttribute("data-hydration-state", "ready");
  await expect(host).toHaveAttribute("data-connection-state", "connected");
  await expect(host).toHaveAttribute("data-entry-channel", "mate_call");
  await expect(page.getByTestId("preview-operations-surface")).toBeVisible();
  await expect(page.getByTestId("preview-operation-task")).toHaveCount(2);
  await expect(page.getByTestId("preview-task-inbox")).toContainText("Schedule");
  await expect(page.getByTestId("preview-task-inbox")).toContainText("Email Call");
  await expect(page.getByRole("button", { exact: true, name: /^(任务|Tasks)$/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId(matePreview.input)).toHaveCount(0);
  await expect(debugField(page, "surface")).toHaveText("task_inbox");
  await expect(debugField(page, "executor")).toHaveCount(0);

  await expect(page.getByLabel("Environment 语义坐标")).toHaveCount(0);

  await page.getByTestId("preview-operations-input").fill("Review current adoption work without writes");
  await page.getByTestId("preview-operations-run").click();
  await expect(page.getByTestId("preview-operation-task")).toHaveCount(3);
  const createdTask = page.locator('[data-task-id="task_preview_operations_1"]');
  await expect(createdTask).toContainText("completed");
  await expect(createdTask).toContainText("Preview Operations Task completed without Live writes.");
  await expect(createdTask).toContainText("0 个 Live 写入");
  await expect(debugField(page, "last-outcome")).toHaveText("completed");
  expect(liveRequests).toBe(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(host).toHaveAttribute("data-hydration-state", "ready");
  await expect(page.getByTestId("preview-operation-task")).toHaveCount(3);
  await expect(page.getByTestId(matePreview.input)).toHaveCount(0);
  expect(previewSessionRequests).toBeGreaterThanOrEqual(2);
  expect(taskListRequests).toBeGreaterThanOrEqual(2);

  const clean = await page.evaluate(() => {
    const jwt = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
    return [window.localStorage, window.sessionStorage].every((storage) => (
      Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "").every((key) => {
        const value = storage.getItem(key) ?? "";
        return !/token|grant|authorization|bearer|conversation/i.test(key) && !jwt.test(value);
      })
    ));
  });
  expect(clean).toBe(true);
});

function corsHeaders(pageUrl: string) {
  return {
    "access-control-allow-headers": "Authorization,Content-Type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": new URL(pageUrl || "http://127.0.0.1:5191").origin,
    "cache-control": "private, no-store"
  };
}
