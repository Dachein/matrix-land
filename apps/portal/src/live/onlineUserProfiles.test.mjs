import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadProfilesModule() {
  const outdir = await mkdtemp(join(tmpdir(), "workspace-online-user-profiles-"));
  const outfile = join(outdir, "online-user-profiles.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./onlineUserProfiles.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function response(json, status = 200) {
  return new Response(JSON.stringify(json), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("online user profiles", () => {
  it("loads canonical avatar and materialized journey level for unique online ids", async () => {
    const { loadOnlineUserProfiles } = await loadProfilesModule();
    const calls = [];
    const fetcher = async (input, init) => {
      calls.push({ init, input: String(input) });
      return response({
        users: [
          {
            avatarUrl: "data:image/png;base64,avatar",
            bio: "Builds reliable tools.",
            department: "Engineering",
            email: "ada@example.test",
            id: "user/1",
            jobTitle: "Engineer",
            journeyCommunityContributionPoints: 80,
            journeyLevelKey: "explorer",
            journeyTotalPoints: 480,
            name: "Ada",
            team: "Platform"
          },
          {
            id: "user-2",
            journeyLevelKey: null,
            name: "Grace"
          },
          { journeyLevelKey: "master", name: "Missing id" }
        ]
      });
    };

    const profiles = await loadOnlineUserProfiles([" user/1 ", "user/1", "user-2", ""], undefined, fetcher);

    const url = new URL(calls[0].input, "https://portal.test");
    assert.equal(url.pathname, "/api/users/batch");
    assert.equal(url.searchParams.get("ids"), "user/1,user-2");
    assert.equal(calls[0].init.headers.Accept, "application/json");
    assert.deepEqual(profiles, [
      {
        avatarUrl: "data:image/png;base64,avatar",
        bio: "Builds reliable tools.",
        department: "Engineering",
        email: "ada@example.test",
        id: "user/1",
        jobTitle: "Engineer",
        journeyCommunityContributionPoints: 80,
        journeyLevelKey: "explorer",
        journeyTotalPoints: 480,
        name: "Ada",
        team: "Platform"
      },
      { id: "user-2", name: "Grace" }
    ]);
  });

  it("does not request or invent profiles for an empty presence list", async () => {
    const { loadOnlineUserProfiles } = await loadProfilesModule();
    let calls = 0;
    const profiles = await loadOnlineUserProfiles([], undefined, async () => {
      calls += 1;
      return response({ users: [] });
    });

    assert.deepEqual(profiles, []);
    assert.equal(calls, 0);
  });

  it("formats only known community levels in the requested locale", async () => {
    const { onlineUserLevelLabel } = await loadProfilesModule();

    assert.equal(onlineUserLevelLabel("explorer", "en"), "Level 2 · Explorer");
    assert.equal(onlineUserLevelLabel("explorer", "zh-CN"), "Level 2 · 探索者");
    assert.equal(onlineUserLevelLabel(undefined, "en"), undefined);
    assert.equal(onlineUserLevelLabel("unknown", "zh-CN"), undefined);
  });
});
