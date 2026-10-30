import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: [
    "**/mate-preview-deployed.spec.ts",
    "**/mate-preview-recovery.spec.ts",
    "**/mate-approvals.spec.ts"
  ],
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 5174",
    reuseExistingServer: true,
    timeout: 120_000,
    url: "http://127.0.0.1:5174/#/home"
  },
  projects: [{
    name: "chromium",
    use: { ...devices["Desktop Chrome"] }
  }]
});
