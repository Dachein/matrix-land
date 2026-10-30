import { defineConfig, devices } from "@playwright/test";
import { productionMatePreviewStorageState } from "./scripts/production-mate-preview-browser-acceptance.mjs";

const baseURL = requiredHttpsOrigin("MATE_PREVIEW_BASE_URL");
const storageState = productionMatePreviewStorageState(
  process.env.MATE_PREVIEW_STORAGE_STATE_B64,
  baseURL
);

/**
 * Opt-in deployed Preview acceptance. Secrets are accepted only as an encoded
 * Playwright storage state; recording is disabled so cookies, Runtime grants,
 * Environment coordinates, and message text cannot enter CI artifacts.
 */
export default defineConfig({
  expect: { timeout: 30_000 },
  forbidOnly: true,
  fullyParallel: false,
  projects: [{
    name: "mate-preview-deployed-chromium",
    use: { ...devices["Desktop Chrome"] }
  }],
  reporter: "list",
  retries: 0,
  testDir: "./tests/e2e",
  testMatch: "mate-preview-deployed.spec.ts",
  timeout: 150_000,
  use: {
    baseURL,
    screenshot: "off",
    serviceWorkers: "block",
    storageState,
    trace: "off",
    video: "off"
  },
  workers: 1
});

function requiredHttpsOrigin(name: string) {
  const value = process.env[name]?.trim() || "";
  try {
    const url = new URL(value);
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
    throw new Error("mate_preview_acceptance_origin_invalid");
  }
}
