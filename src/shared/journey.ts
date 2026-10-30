import type {
  PortalJourney,
  PortalJourneyBadgeCategory,
  PortalJourneyBadgeDefinition,
  PortalJourneyLevelDefinition,
  PortalJourneyLevelKey,
  PortalJourneyUserBadge
} from "./types";

export const portalJourneyLevels: PortalJourneyLevelDefinition[] = [
  {
    key: "newcomer",
    rank: 1,
    nameZh: "新人",
    nameEn: "Newcomer",
    descriptionZh: "刚进入 Frontier Workspace，开始完成基础 Badge。",
    descriptionEn: "New to Frontier Workspace and starting the foundation badges.",
    minPoints: 0,
    criteria: { default: true }
  },
  {
    key: "explorer",
    rank: 2,
    nameZh: "探索者",
    nameEn: "Explorer",
    descriptionZh: "已完成基础准备，开始探索 Agent、MCP、App、Skill。",
    descriptionEn: "Foundation is ready and the user is exploring Agents, MCP, Apps, and Skills.",
    minPoints: 100,
    criteria: { category: "foundation", count: 2 }
  },
  {
    key: "contributor",
    rank: 3,
    nameZh: "贡献者",
    nameEn: "Contributor",
    descriptionZh: "开始参与社区、反馈、复用能力。",
    descriptionEn: "Participates in community, feedback, and capability reuse.",
    minPoints: 150,
    criteria: { anyCategory: ["community", "usage"], count: 1 }
  },
  {
    key: "builder",
    rank: 4,
    nameZh: "创造者",
    nameEn: "Builder",
    descriptionZh: "开始创建并发布 APPS App 或 APPS Skill。",
    descriptionEn: "Creates and publishes APPS Apps or APPS Skills.",
    minPoints: 500,
    criteria: {
      category: "builder",
      count: 1,
      requiredBadge: "first_published_capability"
    }
  },
  {
    key: "master",
    rank: 5,
    nameZh: "大师",
    nameEn: "Master",
    descriptionZh: "持续发布、推动团队复用并参与跨项目协作。",
    descriptionEn: "Publishes repeatedly, drives team reuse, and collaborates across projects.",
    minPoints: 700,
    criteria: {
      category: "impact",
      count: 1,
      requiredBadge: "first_published_capability"
    }
  }
];

export const portalJourneyMonthlyBudgetUsd: Readonly<Record<PortalJourneyLevelKey, number>> = {
  newcomer: 10,
  explorer: 30,
  contributor: 50,
  builder: 100,
  master: 200
};

export const portalCommunityContributionRules = {
  contributionTagPoints: [10, 30, 50],
  contributionTagCustomMin: 1,
  contributionTagCustomMax: 100,
  replyPoints: 1,
  topicPoints: 5
} as const;

export const portalCommunityContributionNotePresetKeys = [
  "majorFix",
  "importantImprovement",
  "reusableGuide",
  "valuableFeedback"
] as const;

export function monthlyBudgetUsdForPortalJourneyLevel(levelKey: unknown) {
  const normalizedLevelKey = normalizePortalJourneyLevelKey(typeof levelKey === "string" ? levelKey : "");
  return portalJourneyMonthlyBudgetUsd[normalizedLevelKey];
}

export const portalBadgeDefinitions: PortalJourneyBadgeDefinition[] = [
  badge("profile_ready", "foundation", "Profile Ready", "资料就绪", "Complete avatar, display name, and bio.", "完成头像、展示名、简介等基础资料。", 20, "profile", { kind: "profile_complete" }, 10),
  badge("agent_declared", "foundation", "Agent Declared", "Agent 已声明", "Declare the primary Agent: ChatGPT, Claude, WorkBuddy, or Cursor.", "声明主要使用的 Agent：ChatGPT、Claude、WorkBuddy 或 Cursor。", 30, "profile", { kind: "agent_preference" }, 20),
  badge("token_ready", "foundation", "Token Ready", "Token 就绪", "Create the first active Frontier Workspace Token.", "创建第一个 active Frontier Workspace Token。", 50, "gateway", { kind: "gateway_token_active" }, 30),
  badge("mcp_connected", "foundation", "MCP Connected", "MCP 已连接", "Authorize or confirm the Workspace MCP connection.", "完成 Workspace MCP 授权或安装确认。", 80, "computed", { kind: "mcp_connected" }, 40),

  badge("first_post", "community", "First Post", "首次发帖", "Publish the first forum post.", "发布第一篇论坛帖子。", 40, "forum", { kind: "first_topic" }, 110),
  badge("first_reply", "community", "First Reply", "首次回复", "Write the first forum reply.", "完成第一次论坛回帖。", 30, "forum", { kind: "first_reply" }, 120),
  badge("forum_active", "community", "Forum Regular", "论坛活跃者", "Start at least five forum topics.", "累计发起至少 5 个论坛帖子。", 100, "forum", { kind: "forum_active", topics: 5 }, 130),
  badge("community_spark", "community", "Community Spark", "社区火花", "A post receives at least 10 reactions or 5 replies.", "单篇帖子获得至少 10 个 reactions 或 5 条回复。", 100, "forum", { kind: "community_spark", reactions: 10, replies: 5 }, 140),

  badge("first_app_launch", "usage", "First App Launch", "首次打开 App", "Launch the first Portal App through Workspace.", "第一次通过 Workspace 打开 Portal App。", 30, "computed", { kind: "first_app_launch" }, 210),
  badge("first_skill_install", "usage", "First Skill Install", "首次安装 Skill", "Install or bookmark the first Skill.", "第一次安装或收藏 Skill。", 40, "market", { kind: "first_skill_install" }, 220),
  badge("apps_skill_user", "usage", "APPS Skill User", "APPS Skill 用户", "Install or use the first APPS Skill.", "首次安装或使用一个 APPS Skill。", 60, "market", { kind: "first_apps_skill_use" }, 230),
  badge("workflow_explorer", "usage", "Workflow Explorer", "工作流探索者", "Use both an App and a APPS Skill.", "同时使用过 App 和 APPS Skill。", 80, "computed", { kind: "workflow_explorer", surfaces: 2 }, 240),

  badge("first_apps_draft", "builder", "First APPS Draft", "首个 APPS 草稿", "Create the first APPS App or APPS Skill draft.", "创建第一个 APPS App 或 APPS Skill 草稿。", 50, "apps", { kind: "first_apps_draft" }, 310),
  badge("skill_maker", "builder", "Skill Maker", "Skill 创作者", "Create the first APPS Skill.", "创建第一个 APPS Skill。", 100, "apps", { kind: "first_apps_skill" }, 320),
  badge("app_maker", "builder", "App Maker", "App 创作者", "Create the first APPS App.", "创建第一个 APPS App。", 100, "apps", { kind: "first_apps_app" }, 330),
  badge("first_published_capability", "builder", "First APPS Published", "首次正式发布", "Publish the first APPS App or APPS Skill.", "正式发布第一个 APPS App 或 APPS Skill。", 150, "market", { kind: "first_published_apps", published: 1 }, 340),

  badge("published_two_appss", "impact", "Two APPS Projects Published", "发布两个 APPS", "Publish at least two APPS Apps or APPS Skills.", "至少正式发布两个 APPS App 或 APPS Skill。", 200, "market", { kind: "published_appss", published: 2 }, 410),
  badge("reused_by_team", "impact", "Reused by Team", "被团队复用", "A published APPS project is used by at least five other users.", "一个已发布 APPS 项目被至少 5 名其他用户使用。", 200, "market", { kind: "reused_by_team", distinctUsers: 5 }, 420),
  badge("collaboration_master", "impact", "Collaboration Master", "协作大师", "Be a collaborator on at least three different APPS projects.", "作为协作者参与至少 3 个不同的 APPS 项目。", 200, "apps", { kind: "apps_collaborator", projects: 3 }, 430)
];

export type PortalJourneyBadgeVisualState = "earned" | "unearned";

export const PORTAL_JOURNEY_ASSET_VERSION = "v2";
const portalJourneyAssetRoot = `/assets/journey/${PORTAL_JOURNEY_ASSET_VERSION}`;

export function portalJourneyLevelImageUrl(levelKey: PortalJourneyLevelKey) {
  return `${portalJourneyAssetRoot}/levels/art/${levelKey}.png`;
}

export function portalJourneyLevelGlyphUrl(levelKey: PortalJourneyLevelKey) {
  return `${portalJourneyAssetRoot}/levels/glyph/${levelKey}.svg`;
}

export function formatPortalJourneyLevelLabel(
  level: Pick<PortalJourneyLevelDefinition, "nameEn" | "nameZh" | "rank">,
  locale: string
) {
  const name = locale.startsWith("zh") ? level.nameZh : level.nameEn;
  return `Level ${level.rank} · ${name}`;
}

export function portalJourneyBadgeImageUrl(badgeKey: string, state: PortalJourneyBadgeVisualState = "earned") {
  const assetKey = portalJourneyBadgeAssetAliases[badgeKey] ?? badgeKey;
  return `${portalJourneyAssetRoot}/badges/${state}/${assetKey}.png`;
}

const portalJourneyBadgeAssetAliases: Readonly<Record<string, string>> = {
  app_maker: "mcp_skill_maker",
  collaboration_master: "mentor",
  forum_active: "helpful_reply",
  apps_skill_user: "mcp_skill_user",
  published_two_appss: "maintainer"
};

export function resolvePortalJourneyLevel(
  totalPoints: number,
  badges: Array<Pick<PortalJourneyUserBadge, "badgeKey" | "category"> | { badgeKey?: string; category: PortalJourneyBadgeCategory }>
) {
  const categoryCounts = categoryCountsForBadges(badges);
  const earnedBadgeKeys = new Set(badges.map((badge) => badge.badgeKey).filter(Boolean));
  const hasPublishedApps = earnedBadgeKeys.has("first_published_capability");
  let resolved = portalJourneyLevels[0];

  for (const level of portalJourneyLevels) {
    if (level.key === "newcomer") {
      resolved = level;
      continue;
    }

    if (totalPoints < level.minPoints) {
      continue;
    }

    if (level.key === "explorer" && categoryCounts.foundation >= 2) {
      resolved = level;
    } else if (level.key === "contributor" && categoryCounts.community + categoryCounts.usage >= 1) {
      resolved = level;
    } else if (level.key === "builder" && categoryCounts.builder >= 1 && hasPublishedApps) {
      resolved = level;
    } else if (level.key === "master" && categoryCounts.impact >= 1 && hasPublishedApps) {
      resolved = level;
    }
  }

  return resolved;
}

export function categoryCountsForBadges(badges: Array<Pick<PortalJourneyUserBadge, "category"> | { category: PortalJourneyBadgeCategory }>) {
  const counts: Record<PortalJourneyBadgeCategory, number> = {
    foundation: 0,
    community: 0,
    usage: 0,
    builder: 0,
    impact: 0
  };

  badges.forEach((badge) => {
    counts[badge.category] += 1;
  });

  return counts;
}

export function buildPortalJourneySnapshot(badgeKeys: string[], updatedAt = new Date().toISOString()): PortalJourney {
  const badges = badgeKeys.flatMap((badgeKey) => {
    const definition = portalBadgeDefinitions.find((item) => item.key === badgeKey);

    if (!definition) {
      return [];
    }

    return [{
      badgeKey: definition.key,
      category: definition.category,
      nameZh: definition.nameZh,
      nameEn: definition.nameEn,
      descriptionZh: definition.descriptionZh,
      descriptionEn: definition.descriptionEn,
      points: definition.points,
      source: "fallback",
      awardedAt: updatedAt
    }];
  });
  const totalPoints = badges.reduce((sum, badgeItem) => sum + badgeItem.points, 0);
  const level = resolvePortalJourneyLevel(totalPoints, badges);
  const earnedKeys = new Set(badges.map((badgeItem) => badgeItem.badgeKey));

  return {
    level,
    levels: portalJourneyLevels,
    badgeDefinitions: portalBadgeDefinitions,
    badges,
    profile: {},
    communityContributionBreakdown: {
      contributionTagPoints: 0,
      replyPoints: 0,
      topicPoints: 0
    },
    communityContributionPoints: 0,
    totalPoints,
    badgeCount: badges.length,
    categoryCounts: categoryCountsForBadges(badges),
    nextBadges: portalBadgeDefinitions.filter((definition) => !earnedKeys.has(definition.key)).slice(0, 4),
    updatedAt
  };
}

export function normalizePortalJourneyLevelKey(value: string): PortalJourneyLevelKey {
  return portalJourneyLevels.some((level) => level.key === value) ? value as PortalJourneyLevelKey : "newcomer";
}

function badge(
  key: string,
  category: PortalJourneyBadgeCategory,
  nameEn: string,
  nameZh: string,
  descriptionEn: string,
  descriptionZh: string,
  points: number,
  triggerType: PortalJourneyBadgeDefinition["triggerType"],
  triggerConfig: Record<string, unknown>,
  sortOrder: number
): PortalJourneyBadgeDefinition {
  return {
    key,
    category,
    nameZh,
    nameEn,
    descriptionZh,
    descriptionEn,
    points,
    triggerType,
    triggerConfig,
    sortOrder
  };
}
