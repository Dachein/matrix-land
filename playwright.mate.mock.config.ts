import { defineConfig, devices } from "@playwright/test";

/**
 * Deterministic Preview Host browser contract. This suite intentionally runs
 * without Playwright traces, screenshots, or video: the Agent WebSocket URL
 * carries a short-lived grant and its request body carries the Environment.
 */
export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  projects: [{
    name: "mate-preview-chromium",
    use: { ...devices["Desktop Chrome"] }
  }],
  reporter: "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "./tests/e2e",
  testMatch: ["mate-preview-recovery.spec.ts", "mate-preview-operations.spec.ts", "mate-approvals.spec.ts"],
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5191",
    screenshot: "off",
    trace: "off",
    video: "off"
  },
  webServer: {
    command: "npm --prefix apps/mate-preview run dev",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: "http://127.0.0.1:5191/"
  },
  workers: 1
});
