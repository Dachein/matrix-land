import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  testDir: "./tests/e2e",
  testMatch: ["knowledge-navigation.spec.ts", "knowledge-workspace.spec.ts", "knowledge-dialog-lifecycle.spec.ts", "access-targets.spec.ts", "mate-builder.spec.ts", "profile-interactions.spec.ts"],
  use: { baseURL: "http://127.0.0.1:5185", trace: "retain-on-failure" },
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 5185 --strictPort",
    reuseExistingServer: false,
    timeout: 120_000,
    url: "http://127.0.0.1:5185/"
  },
  projects: [{ name: "knowledge-chromium", use: { ...devices["Desktop Chrome"] } }],
  workers: 1
});
