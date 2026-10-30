import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildForumDiscussions, buildLegacyForumDiscussions } from "./readModel.ts";

describe("forum read model", () => {
  it("builds discussion projections with root attachments, replies, embeds, plugins, mentions, and reactions", () => {
    const discussions = buildForumDiscussions(
      [{
        id: "topic-1",
        rootPostId: "post-root",
        title: "AI onboarding launch",
        authorId: "user-1",
        author: "Ada Lovelace",
        authorEmail: "ada@example.com",
        authorAvatarUrl: "/avatar.png",
        authorDepartment: "AI",
        authorTeam: "Platform",
        authorJobTitle: "Architect",
        authorProfileJson: "{\"bio\":\"Builds tools\",\"location\":\"London\"}",
        authorJourneyLevelKey: "builder",
        authorJourneyTotalPoints: 790,
        authorJourneyCommunityContributionPoints: 80,
        category: "Platform help",
        categorySlug: "platform-help",
        topicType: "announcement",
        source: "mcp",
        pinned: 1,
        tags: "release,onboarding",
        linkedApp: "app-1",
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "",
        replies: 1,
        views: 12,
        likes: 2,
        likedByCurrentUser: 1,
        currentUserReaction: "heart",
        reactionSummary: "heart:2,bad:1,eyes:0",
        lastActive: "2026-06-02T00:00:00Z",
        excerpt: "Launch details",
        body: "Full body"
      }],
      [
        {
          id: "att-root",
          topicId: "topic-1",
          postId: "post-root",
          url: "/api/forum/media/root",
          fileName: "cover.png",
          mimeType: "image/png",
          fileSize: 1024
        },
        {
          id: "att-reply",
          topicId: "topic-1",
          postId: "reply-1",
          url: "/api/forum/media/reply",
          fileName: "notes.pdf",
          mimeType: "application/pdf",
          fileSize: 2048
        }
      ],
      [{
        id: "link-1",
        topicId: "topic-1",
        url: "https://example.com",
        provider: "Example",
        title: "Example link",
        description: "Preview",
        embedType: "bad",
        previewImageUrl: ""
      }],
      [{
        id: "plugin-1",
        topicId: "topic-1",
        pluginType: "app_launch",
        targetType: "skill",
        targetId: "skill-1",
        title: "skill-1",
        description: "Fallback description",
        category: "Fallback category",
        iconUrl: "/fallback.png",
        installs: 12,
        owner: "Fallback owner",
        status: "active",
        configJson: "{\"actionLabel\":\"Open\",\"category\":\"Knowledge\",\"description\":\"Maintain an internal finance wiki.\",\"iconUrl\":\"/skill.png\",\"installs\":42,\"owner\":\"AI Adoption\",\"title\":\"Workspace LLM Wiki Finance\"}"
      }],
      [{
        id: "mention-1",
        topicId: "topic-1",
        postId: "post-root",
        userId: "user-2",
        name: "Grace Hopper",
        email: "grace@example.com",
        emailPrefix: "grace",
        avatarUrl: "/grace.png",
        department: "Product",
        team: "Adoption",
        jobTitle: "Lead",
        profileJson: "{\"bio\":\"Ships forums\",\"location\":\"NYC\"}",
        journeyLevelKey: "explorer",
        text: "@Grace"
      }],
      [{
        id: "reply-1",
        topicId: "topic-1",
        authorId: "user-3",
        author: "Alan Turing",
        authorEmail: "alan@example.com",
        authorDepartment: "Research",
        authorTeam: "Labs",
        authorJobTitle: "Scientist",
        authorProfileJson: "{\"bio\":\"Tests ideas\",\"location\":\"Manchester\"}",
        authorJourneyLevelKey: "contributor",
        authorJourneyTotalPoints: 320,
        authorJourneyCommunityContributionPoints: 30,
        body: "Looks good",
        source: "mcp",
        pinned: 1,
        createdAt: "2026-06-02T00:00:00Z",
        likes: 1,
        likedByCurrentUser: 0,
        reactionSummary: "tada:1",
        parentPostId: ""
      }],
      [{
        id: "award-root",
        topicId: "topic-1",
        postId: "post-root",
        awardedByUserId: "user-admin",
        awardedByName: "Community Admin",
        points: 30,
        note: "Clear and reusable launch guidance.",
        createdAt: "2026-06-02T02:00:00Z"
      }, {
        id: "award-reply",
        topicId: "topic-1",
        postId: "reply-1",
        awardedByUserId: "user-admin",
        awardedByName: "Community Admin",
        points: 10,
        note: "A thoughtful follow-up.",
        createdAt: "2026-06-02T03:00:00Z"
      }]
    );

    assert.equal(discussions.length, 1);
    assert.equal(discussions[0].topicType, "official");
    assert.equal(discussions[0].source, "mcp");
    assert.equal(discussions[0].pinned, true);
    assert.equal(discussions[0].authorAvatar, "AL");
    assert.equal(discussions[0].department, "AI");
    assert.equal(discussions[0].team, "Platform");
    assert.equal(discussions[0].bio, "Builds tools");
    assert.equal(discussions[0].journeyLevelKey, "builder");
    assert.equal(discussions[0].journeyTotalPoints, 790);
    assert.equal(discussions[0].journeyCommunityContributionPoints, 80);
    assert.deepEqual(discussions[0].tags, ["release", "onboarding"]);
    assert.deepEqual(discussions[0].reactions, [
      { reaction: "heart", count: 2 },
      { reaction: "thumbsup", count: 1 }
    ]);
    assert.equal(discussions[0].attachments?.length, 1);
    assert.equal(discussions[0].attachments?.[0].type, "image");
    assert.equal(discussions[0].linkEmbeds?.[0].embedType, "link");
    assert.equal(discussions[0].contentPlugins?.[0].actionLabel, "Open");
    assert.equal(discussions[0].contentPlugins?.[0].title, "Workspace LLM Wiki Finance");
    assert.equal(discussions[0].contentPlugins?.[0].description, "Maintain an internal finance wiki.");
    assert.equal(discussions[0].contentPlugins?.[0].category, "Knowledge");
    assert.equal(discussions[0].contentPlugins?.[0].iconUrl, "/fallback.png");
    assert.equal(discussions[0].contentPlugins?.[0].installs, 42);
    assert.equal(discussions[0].contentPlugins?.[0].owner, "AI Adoption");
    assert.equal(discussions[0].mentions?.[0].bio, "Ships forums");
    assert.equal(discussions[0].mentions?.[0].journeyLevelKey, "explorer");
    assert.equal(discussions[0].replyPosts?.[0].source, "mcp");
    assert.equal(discussions[0].replyPosts?.[0].pinned, true);
    assert.equal(discussions[0].replyPosts?.[0].journeyLevelKey, "contributor");
    assert.equal(discussions[0].replyPosts?.[0].journeyTotalPoints, 320);
    assert.equal(discussions[0].replyPosts?.[0].journeyCommunityContributionPoints, 30);
    assert.equal(discussions[0].replyPosts?.[0].attachments?.[0].type, "file");
    assert.deepEqual(discussions[0].replyPosts?.[0].reactions, [{ reaction: "tada", count: 1 }]);
    assert.equal(discussions[0].contributorAward?.note, "Clear and reusable launch guidance.");
    assert.equal(discussions[0].replyPosts?.[0].contributorAward?.awardedByName, "Community Admin");
  });

  it("tolerates malformed JSON and missing optional values", () => {
    const [discussion] = buildForumDiscussions(
      [{
        id: "topic-2",
        title: "Plain topic",
        author: "Solo",
        authorProfileJson: "{bad",
        authorJourneyLevelKey: "legend",
        category: "General",
        tags: "",
        replies: "nope",
        views: 3,
        reactionSummary: "heart:not-number",
        lastActive: "2026-06-03T00:00:00Z",
        excerpt: "Plain"
      }],
      [],
      [],
      [],
      [],
      []
    );

    assert.equal(discussion.authorAvatar, "S");
    assert.equal(discussion.bio, undefined);
    assert.equal(discussion.journeyLevelKey, undefined);
    assert.equal(discussion.tag, "General");
    assert.deepEqual(discussion.tags, []);
    assert.equal(discussion.replies, 0);
    assert.deepEqual(discussion.reactions, []);
  });

  it("projects inline profile avatars as cacheable user image URLs", () => {
    const [discussion] = buildForumDiscussions(
      [{
        id: "topic-avatar",
        title: "Cached avatar",
        authorId: "user-avatar",
        author: "Avatar User",
        authorAvatarUrl: "data:image/png;base64,SGVsbG8=",
        category: "General",
        tags: "",
        replies: 0,
        views: 0,
        likes: 0,
        lastActive: "2026-09-24T00:00:00Z",
        excerpt: "Avatar"
      }],
      [], [], [], [], []
    );

    assert.match(discussion.authorAvatarUrl, /^\/api\/users\/user-avatar\/avatar\?v=/);
  });

  it("enriches legacy discussion rows with author profile details", () => {
    const [discussion] = buildLegacyForumDiscussions([{
      id: "legacy-1",
      title: "Legacy",
      authorDepartment: "Ops",
      authorTeam: "Enablement",
      authorJobTitle: "Manager",
      authorProfileJson: "{\"bio\":\"Migrated row\",\"location\":\"Shanghai\"}",
      authorJourneyLevelKey: "master"
    }]);

    assert.equal(discussion.department, "Ops");
    assert.equal(discussion.team, "Enablement");
    assert.equal(discussion.jobTitle, "Manager");
    assert.equal(discussion.bio, "Migrated row");
    assert.equal(discussion.location, "Shanghai");
    assert.equal(discussion.journeyLevelKey, "master");
  });

  it("projects anonymous topics and replies without exposing their real profiles", () => {
    const [discussion] = buildForumDiscussions(
      [{
        id: "topic-anonymous",
        rootPostId: "post-root",
        title: "A private question",
        authorId: "user-secret-topic",
        author: "Real Topic Author",
        authorEmail: "topic@example.com",
        authorAvatarUrl: "/real-topic.png",
        authorDepartment: "Finance",
        authorProfileJson: "{\"bio\":\"private\"}",
        anonymous: 1,
        anonymousPersona: "curious-fox",
        currentUserAnonymousPersona: "morning-lark",
        ownedByCurrentUser: 1,
        category: "General",
        tags: "",
        replies: 1,
        views: 0,
        likes: 0,
        lastActive: "2026-08-19T00:00:00Z",
        excerpt: "A private question",
        body: "Question body"
      }],
      [],
      [],
      [],
      [],
      [{
        id: "reply-anonymous",
        topicId: "topic-anonymous",
        authorId: "user-secret-reply",
        author: "Real Reply Author",
        authorEmail: "reply@example.com",
        authorAvatarUrl: "/real-reply.png",
        authorTeam: "Private team",
        authorProfileJson: "{\"bio\":\"also private\"}",
        anonymous: 1,
        anonymousPersona: "bright-otter",
        ownedByCurrentUser: 0,
        body: "Anonymous reply",
        createdAt: "2026-08-19T01:00:00Z",
        likes: 0
      }]
    );

    assert.equal(discussion.author, "Curious Fox");
    assert.equal(discussion.authorId, undefined);
    assert.equal(discussion.authorEmail, undefined);
    assert.equal(discussion.authorAvatarUrl, "/assets/forum-anonymous/curious-fox.png");
    assert.equal(discussion.department, undefined);
    assert.equal(discussion.bio, undefined);
    assert.equal(discussion.anonymousPersona, "curious-fox");
    assert.equal(discussion.currentUserAnonymousPersona, "morning-lark");
    assert.equal(discussion.ownedByCurrentUser, true);

    const [reply] = discussion.replyPosts;
    assert.equal(reply.author, "Bright Otter");
    assert.equal(reply.authorId, undefined);
    assert.equal(reply.authorEmail, undefined);
    assert.equal(reply.authorAvatarUrl, "/assets/forum-anonymous/bright-otter.png");
    assert.equal(reply.team, undefined);
    assert.equal(reply.bio, undefined);
    assert.equal(reply.anonymousPersona, "bright-otter");
  });
});
