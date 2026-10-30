import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: true,
  reporter: "list",
  testDir: "./tests/e2e",
  testMatch: "admin-ui.spec.ts",
  use: {
    baseURL: "http://127.0.0.1:5184",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 5184 --strictPort",
    reuseExistingServer: false,
    timeout: 120_000,
    url: "http://127.0.0.1:5184/"
  },
  projects: [{ name: "admin-chromium", use: { ...devices["Desktop Chrome"] } }],
  workers: 2
});
