import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { profileOrgDisplay } from "../lib/profileOrg.ts";
import { canModerateForum } from "./permissions.ts";
import { communityLevelLabel, profileFromDiscussionAuthor, profileSignature } from "./profileModels.ts";

describe("forum profile summaries", () => {
  it("shows a trimmed profile bio before the community level", () => {
    assert.equal(
      profileSignature({ bio: "  Builds useful agents  ", journeyLevelKey: "master" }, "en"),
      "Builds useful agents"
    );
  });

  it("falls back to the localized community level when the bio is empty", () => {
    assert.equal(profileSignature({ bio: "   ", journeyLevelKey: "contributor" }, "en"), "Level 3 · Contributor");
    assert.equal(profileSignature({ journeyLevelKey: "contributor" }, "zh-CN"), "Level 3 · 贡献者");
  });

  it("uses the newcomer level when no valid level is available", () => {
    assert.equal(communityLevelLabel(undefined, "en"), "Level 1 · Newcomer");
    assert.equal(communityLevelLabel(undefined, "zh-CN"), "Level 1 · 新人");
  });

  it("displays only the department even when a stale team is present", () => {
    assert.deepEqual(profileOrgDisplay({ department: "People & Culture", team: "AI Adoption" }), {
      department: "People & Culture",
      fullPath: "People & Culture",
      team: ""
    });
  });

  it("keeps the full department hierarchy together and never substitutes a team", () => {
    assert.deepEqual(profileOrgDisplay({ department: " Group / CEO Office ", team: "AI Adoption" }), {
      department: "Group / CEO Office", fullPath: "Group / CEO Office", team: ""
    });
    assert.deepEqual(profileOrgDisplay({ team: "AI Adoption" }), { department: "", fullPath: "", team: "" });
  });

  it("keeps journey scores when building a forum author profile", () => {
    const profile = profileFromDiscussionAuthor({
      author: "Grace Hopper",
      authorId: "user-grace",
      department: "Platform",
      id: "topic-1",
      journeyCommunityContributionPoints: 80,
      journeyTotalPoints: 480,
      team: "AI Adoption"
    });

    assert.equal(profile.journeyTotalPoints, 480);
    assert.equal(profile.journeyCommunityContributionPoints, 80);
  });

  it("shows community admin actions only to assigned community admins", () => {
    const baseUser = {
      email: "user@example.test",
      id: "user-1",
      name: "User",
      role: "member",
      team: "AI Adoption"
    };

    assert.equal(canModerateForum({ ...baseUser, role: "admin", roles: ["admin"] }), false);
    assert.equal(canModerateForum({ ...baseUser, roles: ["community_admin"] }), true);
  });
});
