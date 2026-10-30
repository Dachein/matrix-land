import assert from "node:assert/strict";
import { it } from "node:test";
import { publicationAuthEnv } from "./index.ts";

it("prefers the dedicated Publication credential", () => {
  assert.deepEqual(publicationAuthEnv({
    AUTH_SERVICE_TOKEN: "legacy-token",
    AUTH_WORKER_URL: "https://auth.example.test",
    PUBLICATION_AUTH_SERVICE_TOKEN: "publication-token"
  }), {
    AUTH_SERVICE_TOKEN: "publication-token",
    AUTH_WORKER_URL: "https://auth.example.test"
  });
});

it("keeps the legacy Publication credential as a migration fallback", () => {
  assert.deepEqual(publicationAuthEnv({
    AUTH_SERVICE_TOKEN: "legacy-token",
    AUTH_WORKER_URL: "https://auth.example.test"
  }), {
    AUTH_SERVICE_TOKEN: "legacy-token",
    AUTH_WORKER_URL: "https://auth.example.test"
  });
});
