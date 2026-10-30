import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadUserProfiles, normalizeUserProfileIds } from "./useUserProfiles.ts";
import { formatDepartmentDisplayPath } from "./useDepartmentDisplayPath.ts";

const currentUser = {
  id: "user-current",
  name: "Current User",
  email: "current@example.test",
  avatarUrl: "https://assets.example.test/current.png",
  team: "AI Adoption",
  department: "Technology / AI Adoption",
  departmentDisplayPath: "Group/AI Adoption",
  jobTitle: "Engineer",
  bio: "Builds useful tools.",
  location: "Hong Kong",
  role: "member",
  identity: {
    provider: "microsoft_entra_id",
    tenantId: "tenant-1",
    objectId: "object-1",
    principalName: "current@example.test"
  }
};

describe("user profile batch hook helpers", () => {
  it("formats internal department IDs as a path without the organization root", () => {
    assert.equal(formatDepartmentDisplayPath({
      departmentPath: ["dept-root", "dept-group", "dept-ai"]
    }, [
      { id: "dept-root", name: "Workspace Wealth Group Limited" },
      { id: "dept-group", name: "Group" },
      { id: "dept-ai", name: "AI Adoption" }
    ]), "Group/AI Adoption");
  });

  it("does not guess a department path when a node name is missing", () => {
    assert.equal(formatDepartmentDisplayPath({
      departmentPath: ["dept-root", "dept-missing", "dept-ai"]
    }, [{ id: "dept-root", name: "Root" }, { id: "dept-ai", name: "AI Adoption" }]), undefined);
  });

  it("prefers the server-resolved display path for the current user", () => {
    assert.equal(formatDepartmentDisplayPath({
      departmentDisplayPath: "Group/AI Adoption",
      departmentPath: ["dept-root", "dept-group", "dept-ai"]
    }, []), "Group/AI Adoption");
  });

  it("deduplicates and caps requested user ids", () => {
    const ids = Array.from({ length: 110 }, (_, index) => ` user-${index} `);

    assert.deepEqual(normalizeUserProfileIds(["", " user-0 ", "user-0", ...ids]).slice(0, 3), [
      "user-0",
      "user-1",
      "user-2"
    ]);
    assert.equal(normalizeUserProfileIds(ids).length, 100);
  });

  it("loads requested profiles and preserves the current user as a fallback", async () => {
    const controller = new AbortController();
    const calls = [];
    const profiles = await loadUserProfiles(
      [" user-current ", "user-other", "user-other"],
      currentUser,
      controller.signal,
      async (input, init) => {
        calls.push({ init, input: String(input) });
        return jsonResponse({
          users: [{
            id: "user-current",
            name: "",
            email: ""
          }, {
            id: "user-other",
            name: "Grace Hopper",
            email: "grace@example.test",
            avatarUrl: "https://assets.example.test/grace.png",
            department: "Research",
            team: "Macro",
            jobTitle: "Researcher",
            bio: "Studies market structure.",
            journeyLevelKey: "builder",
            journeyTotalPoints: 480,
            journeyCommunityContributionPoints: 80
          }, {
            id: "not-requested",
            name: "Should be ignored"
          }, {
            name: "Missing id"
          }]
        });
      }
    );

    const requestUrl = new URL(calls[0].input, "https://portal.test");
    assert.equal(requestUrl.pathname, "/api/users/batch");
    assert.equal(requestUrl.searchParams.get("ids"), "user-current,user-other");
    assert.equal(calls[0].init.headers.Accept, "application/json");
    assert.equal(calls[0].init.signal, controller.signal);
    assert.equal(profiles.size, 2);
    assert.equal(profiles.get("user-current")?.name, "Current User");
    assert.equal(profiles.get("user-current")?.email, "current@example.test");
    assert.equal(profiles.get("user-current")?.departmentDisplayPath, "Group/AI Adoption");
    assert.deepEqual(profiles.get("user-other"), {
      avatarUrl: "https://assets.example.test/grace.png",
      bio: "Studies market structure.",
      department: "Research",
      email: "grace@example.test",
      id: "user-other",
      jobTitle: "Researcher",
      journeyCommunityContributionPoints: 80,
      journeyLevelKey: "builder",
      journeyTotalPoints: 480,
      location: undefined,
      name: "Grace Hopper",
      role: "member",
      team: ""
    });
    assert.equal(profiles.has("not-requested"), false);
  });

  it("returns the current-user fallback when the batch endpoint fails", async () => {
    const profiles = await loadUserProfiles(
      ["user-current", "user-other"],
      currentUser,
      undefined,
      async () => jsonResponse({ error: "unavailable" }, 503)
    );

    assert.deepEqual([...profiles.keys()], ["user-current"]);
    assert.equal(profiles.get("user-current")?.name, "Current User");
  });

  it("does not issue a request for an empty id list", async () => {
    let requests = 0;
    const profiles = await loadUserProfiles([], currentUser, undefined, async () => {
      requests += 1;
      return jsonResponse({ users: [] });
    });

    assert.equal(requests, 0);
    assert.equal(profiles.size, 0);
  });
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status
  });
}
