import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadProfileApi() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-current-user-profile-"));
  const outfile = join(outdir, "current-user-profile.mjs");
  await build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL("./currentUserProfile.ts", import.meta.url))],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "node"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

const currentUser = {
  id: "user-1",
  name: "Ada Before",
  email: "ada@example.test",
  avatarUrl: "https://example.test/before.jpg",
  team: "AI Adoption",
  department: "Technology",
  jobTitle: "Engineer",
  bio: "Before bio",
  location: "Shanghai",
  role: "admin",
  identity: {
    provider: "microsoft_entra_id",
    tenantId: "tenant-1",
    objectId: "object-1",
    principalName: "ada@example.test"
  }
};

const updates = {
  name: "Ada After",
  avatarUrl: "https://example.test/after.jpg",
  bio: "After bio",
  jobTitle: "",
  location: "Hong Kong"
};

describe("current user profile transport", () => {
  it("returns only a server-confirmed user after a valid 2xx response", async () => {
    const { saveCurrentUserProfile } = await loadProfileApi();
    const calls = [];
    const saved = await saveCurrentUserProfile(currentUser, updates, async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse({
        user: {
          id: "user-1",
          name: "Ada After",
          email: "ada@example.test",
          avatarUrl: "https://example.test/after.jpg",
          team: "AI Adoption",
          department: "Technology",
          bio: "After bio",
          location: "Hong Kong",
          role: "admin"
        }
      }, 201);
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, "/api/users/user-1/profile");
    assert.equal(calls[0].init.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].init.body), updates);
    assert.equal(saved.name, "Ada After");
    assert.equal(saved.jobTitle, "");
    assert.equal(saved.location, "Hong Kong");
    assert.strictEqual(saved.identity, currentUser.identity);
  });

  for (const status of [404, 503]) {
    it(`rejects ${status} without creating a local success`, async () => {
      const { saveCurrentUserProfile } = await loadProfileApi();
      await assert.rejects(
        () => saveCurrentUserProfile(currentUser, updates, async () => jsonResponse({ error: "unavailable" }, status)),
        /profile_update_failed/
      );
    });
  }

  it("accepts a department-only profile with an empty team and clears the previous team", async () => {
    const { saveCurrentUserProfile } = await loadProfileApi();
    const saved = await saveCurrentUserProfile(currentUser, updates, async () => jsonResponse({
      user: { ...currentUser, ...updates, team: "", department: "CEO Office" }
    }));
    assert.equal(saved.team, "");
    assert.equal(saved.department, "CEO Office");
  });

  it("rejects a network error without creating a local success", async () => {
    const { saveCurrentUserProfile } = await loadProfileApi();
    await assert.rejects(
      () => saveCurrentUserProfile(currentUser, updates, async () => {
        throw new TypeError("network unavailable");
      }),
      /profile_update_failed/
    );
  });

  it("rejects malformed JSON and malformed user payloads from a 2xx response", async () => {
    const { saveCurrentUserProfile } = await loadProfileApi();
    await assert.rejects(
      () => saveCurrentUserProfile(currentUser, updates, async () => new Response("not-json", { status: 200 })),
      /profile_update_failed/
    );
    await assert.rejects(
      () => saveCurrentUserProfile(currentUser, updates, async () => jsonResponse({ user: { id: "user-1" } })),
      /profile_update_failed/
    );
    await assert.rejects(
      () => saveCurrentUserProfile(currentUser, updates, async () => jsonResponse({
        user: {
          id: "another-user",
          name: "Ada After",
          email: "ada@example.test",
          avatarUrl: "https://example.test/after.jpg",
          team: "AI Adoption",
          bio: "After bio",
          role: "admin"
        }
      })),
      /profile_update_failed/
    );
  });
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status
  });
}
