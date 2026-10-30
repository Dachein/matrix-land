import type { PortalCatalog } from "./types.ts";
import { buildPortalJourneySnapshot } from "./journey.ts";
import { defaultPortalConfig } from "./portalConfig.ts";

export const fallbackPortal: PortalCatalog = {
  portal: defaultPortalConfig,
  currentUser: {
    id: "local-dev-admin",
    name: "Local Admin",
    email: "local.admin@example.invalid",
    avatarUrl: "",
    team: "AI Adoption",
    department: "AI Adoption",
    jobTitle: "",
    bio: "Local fallback account for development when the API catalog is unavailable.",
    location: "Local",
    role: "admin",
    identity: {
      provider: "microsoft_entra_id",
      tenantId: "local-dev",
      objectId: "local-dev-admin",
      principalName: "local.admin@example.invalid"
    }
  },
  categories: ["Coding", "Design", "Media", "Research", "Finance", "Workflow", "Office"],
  get hubListings() {
    return this.publicationListings;
  },
  publicationListings: [
    {
      id: "listing-skill-contract-review",
      type: "skill",
      targetId: "skill-contract-review",
      name: "Contract Risk Review",
      submittedByProfile: {
        id: "portal-system",
        name: "Frontier Workspace",
        email: "portal.system@example.invalid",
        team: "Legal AI"
      },
      status: "listed",
      visibility: "org",
      summary: "Vendor contract risk review Skill.",
      description: "Reviews vendor contracts, extracts obligations, and flags risky clauses before approval.",
      category: "Office",
      tags: ["legal", "contracts", "skill"],
      installs: 428,
      comments: 31,
      rating: 4.8,
      updatedAt: "2026-06-10"
    },
    {
      id: "listing-app-growth-lab",
      type: "app",
      targetId: "app-growth-lab",
      name: "Workspace Onboarding",
      submittedByProfile: {
        id: "portal-system",
        name: "Frontier Workspace",
        email: "portal.system@example.invalid",
        team: "AI Adoption"
      },
      status: "listed",
      visibility: "org",
      summary: "Employee onboarding and account activation App.",
      description: "Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.",
      category: "Workflow",
      tags: ["app", "onboarding", "hr", "vercel"],
      installs: 88,
      comments: 4,
      rating: 4.3,
      updatedAt: "2026-06-18"
    }
  ],
  skills: [
    {
      id: "skill-contract-review",
      name: "Contract Risk Review",
      owner: "Legal AI",
      status: "listed",
      description: "Reviews vendor contracts, extracts obligations, and flags risky clauses before approval.",
      category: "Office",
      kind: "app",
      version: "2.3.0",
      scopes: ["contracts:read", "legal:risk.write"],
      mcpTools: ["doc.extract", "clause.compare", "risk.report"],
      dependencies: ["legal-mcp"],
      rating: 4.8,
      installs: 428,
      discussions: 31,
      updatedAt: "2026-06-10"
    },
    {
      id: "skill-sales-brief",
      name: "Account Brief Builder",
      owner: "Revenue Ops",
      status: "listed",
      description: "Builds a customer brief from CRM, support tickets, and recent account activity.",
      category: "Finance",
      kind: "app",
      version: "1.9.2",
      scopes: ["crm:read", "support:read"],
      mcpTools: ["crm.account.read", "support.ticket.search"],
      dependencies: ["enterprise-crm"],
      rating: 4.6,
      installs: 312,
      discussions: 18,
      updatedAt: "2026-06-09"
    },
    {
      id: "skill-policy-writer",
      name: "Policy Draft Assistant",
      owner: "People Ops",
      status: "listed",
      description: "Turns policy notes into readable internal drafts with review checklists.",
      category: "Research",
      kind: "vanilla",
      version: "1.4.1",
      scopes: ["profile:read"],
      mcpTools: [],
      dependencies: [],
      rating: 4.5,
      installs: 271,
      discussions: 24,
      updatedAt: "2026-06-08"
    },
    {
      id: "skill-prod-deploy",
      name: "Production Deploy Assistant",
      owner: "Platform",
      status: "listed",
      description: "Summarizes release readiness and prepares deployment checklists with controlled actions.",
      category: "Coding",
      kind: "app",
      version: "0.8.7",
      scopes: ["deploy:read", "incident:read"],
      mcpTools: ["release.status", "incident.lookup"],
      dependencies: ["platform-mcp"],
      rating: 4.4,
      installs: 146,
      discussions: 12,
      updatedAt: "2026-06-06"
    }
  ],
  dataServices: [
    {
      id: "mcp-legal",
      name: "legal-mcp",
      owner: "Legal AI",
      status: "listed",
      description: "Trusted legal document extraction, clause comparison, and risk reporting service.",
      endpoint: "https://mcp.legal.internal.example",
      risk: "high",
      scopes: ["contracts:read", "legal:risk.write"],
      tools: ["doc.extract", "clause.compare", "risk.report"],
      boundSkills: ["Contract Risk Review"],
      freshness: "Live",
      monthlyCalls: 18240
    },
    {
      id: "mcp-crm",
      name: "enterprise-crm",
      owner: "Revenue Ops",
      status: "listed",
      description: "CRM and support context service for account brief generation.",
      endpoint: "https://mcp.crm.internal.example",
      risk: "medium",
      scopes: ["crm:read", "support:read"],
      tools: ["crm.account.read", "support.ticket.search"],
      boundSkills: ["Account Brief Builder"],
      freshness: "5 min",
      monthlyCalls: 26410
    },
    {
      id: "mcp-platform",
      name: "platform-mcp",
      owner: "Platform",
      status: "pending_review",
      description: "Release, deployment, and incident metadata service for platform Builders.",
      endpoint: "https://mcp.platform.internal.example",
      risk: "medium",
      scopes: ["deploy:read", "incident:read"],
      tools: ["release.status", "incident.lookup"],
      boundSkills: ["Production Deploy Assistant"],
      freshness: "Live",
      monthlyCalls: 7312
    }
  ],
  apps: [
    {
      id: "app-growth-lab",
      name: "Workspace Onboarding",
      nameZh: "Workspace Onboarding",
      nameEn: "Workspace Onboarding",
      subtitle: "Employee onboarding and account activation portal",
      appType: "web",
      publisherId: "portal-system",
      publisherProfile: {
        id: "portal-system",
        name: "Frontier Workspace",
        email: "portal.system@example.invalid",
        department: "AI Adoption",
        team: "AI Adoption",
        jobTitle: ""
      },
      status: "pending_review",
      description: "Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.",
      descriptionZh: "Workspace 员工入职与账号开通门户，用于员工登录、访问激活和 HR 协助开通。",
      descriptionEn: "Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.",
      coverImageUrl: "/assets/workspace-onboarding-home-cover.png",
      screenshots: [
        "/assets/workspace-onboarding-home-cover.png"
      ],
      sdkStatus: "pending",
      scopes: ["profile:read"],
      launchUrl: "https://workspace-onboarding.vercel.app/login",
      callbackUrl: "",
      category: "Workflow",
      tags: ["app", "onboarding", "hr", "vercel"],
      model: "Manual onboarding workflow",
      deploymentType: "saas",
      deploymentProvider: "vercel",
      deploymentMethod: "serverless",
      dataRegion: "hong_kong",
      modelProvider: "Manual / internal workflow",
      dataTypes: ["Employee information", "Internal onboarding materials"],
      knowledgeSources: ["HR onboarding policy", "Internal account activation checklist"],
      userScope: "custom",
      accessMode: "request",
      accessTargets: ["Workspace employees", "HR approved users"],
      usesWorkspaceAuth: false,
      sensitiveDataTypes: ["employee_information", "internal_materials"],
      riskLevel: "medium",
      riskReason: "Handles employee login and onboarding data with internal access control. No customer or transaction data is processed.",
      permissionNotes: "Public request flow requires publisher approval by email before access is granted.",
      outputNotes: "Creates account activation and onboarding state for internal employee onboarding.",
      reviewNotes: "First official external App integration sample. Verify publisher approval email and access activation audit before listing.",
      version: "1.0.0",
      changelog: "Initial formal App Store review entry using the live Workspace Onboarding login surface.",
      updatedAt: "2026-06-18",
      viewCount: 312,
      launchCount: 88,
      downloadCount: 88,
      likeCount: 16,
      favoriteCount: 12,
      rating: 4.3,
      ratingCount: 9,
      discussionCount: 4,
      activeUserCount: 88,
      monthlyUsers: 88
    }
  ],
  discussions: [
    {
      id: "discussion-contract-review",
      title: "How should high-risk legal write scopes be confirmed?",
      authorId: "00000000-0000-0000-0000-000000000002",
      author: "Removed Account 2",
      authorEmail: "removed-user-0002@example.invalid",
      authorAvatar: "RA",
      category: "公告与建议",
      categorySlug: "platform-help",
      topicType: "question",
      bu: "Legal AI",
      tag: "MCP Auth",
      tags: ["mcp-auth", "legal", "scope-confirmation"],
      linkedSkill: "Contract Risk Review",
      linkedMcp: "legal-mcp",
      replies: 14,
      views: 286,
      lastActive: "18 min ago",
      excerpt: "A proposal for user confirmation before risk.report writes are executed by agents.",
      body: "Proposal: require an explicit user confirmation before legal:risk.write is executed, then write an audit event with scope, tool, and linked Skill.",
      attachments: [],
      linkEmbeds: [],
      contentPlugins: [],
      mentions: []
    },
    {
      id: "discussion-pure-skill-versioning",
      title: "Versioning convention for vanilla Skills",
      authorId: "00000000-0000-0000-0000-000000000003",
      author: "Removed Account 3",
      authorEmail: "removed-user-0003@example.invalid",
      authorAvatar: "RA",
      category: "AI应用探索",
      categorySlug: "ai-exploration",
      topicType: "idea",
      bu: "AI Adoption",
      tag: "Skill Publishing",
      tags: ["semver", "skill-md"],
      replies: 21,
      views: 412,
      lastActive: "44 min ago",
      excerpt: "Should vanilla Skills follow semver even when the only artifact is SKILL.md?",
      body: "I suggest semver for SKILL.md packages so Publication users can reason about breaking SOP or prompt changes even when there is no runtime dependency.",
      attachments: [],
      linkEmbeds: [],
      contentPlugins: [],
      mentions: []
    },
    {
      id: "discussion-direct-jump-sdk",
      title: "Direct Jump SDK checklist before app launch",
      authorId: "00000000-0000-0000-0000-000000000004",
      author: "Removed Account 4",
      authorEmail: "removed-user-0004@example.invalid",
      authorAvatar: "RA",
      category: "公告与建议",
      categorySlug: "platform-help",
      topicType: "help",
      bu: "Operations",
      tag: "Apps",
      tags: ["sdk", "app-publishing"],
      linkedApp: "Workspace Onboarding",
      replies: 9,
      views: 198,
      lastActive: "2 hr ago",
      excerpt: "A lightweight checklist for app owners integrating current-user and scoped token APIs.",
      body: "Before Workspace Onboarding goes live in the App Store we need publisher approval email, access activation audit, and a smoke test for the login entry.",
      attachments: [
        {
          id: "fallback-attachment-direct-jump-flow",
          type: "image",
          url: "https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=900&q=80",
          fileName: "direct-jump-flow.jpg",
          mimeType: "image/jpeg",
          alt: "Direct Jump planning board"
        }
      ],
      linkEmbeds: [
        {
          id: "fallback-link-sdk",
          url: "https://workspace.internal.example/sdk/auth/",
          provider: "Workspace Docs",
          title: "Workspace Auth SDK contract",
          description: "Runtime SDK contract for App callback exchange and Resource API Bearer token checks.",
          embedType: "link"
        },
        {
          id: "fallback-video-launch",
          url: "https://stream.microsoft.com/video/workspace-app-launch-demo",
          provider: "Microsoft Stream",
          title: "Workspace Onboarding launch walkthrough",
          description: "Five-minute internal walkthrough of the App card and access request launch path.",
          embedType: "video"
        }
      ],
      contentPlugins: [
        {
          id: "fallback-plugin-workspace-onboarding",
          pluginType: "app_support",
          targetType: "app",
          targetId: "app-growth-lab",
          title: "Workspace Onboarding",
          description: "Workspace employee onboarding portal for account login, access activation, and HR-assisted onboarding.",
          status: "listed",
          actionLabel: "Open support thread"
        }
      ],
      mentions: [
        {
          id: "fallback-mention-ada",
          userId: "00000000-0000-0000-0000-000000000004",
          name: "Removed Account 4",
          email: "removed-user-0004@example.invalid",
          emailPrefix: "removed-user-0004",
          text: "@removed-user-0004"
        }
      ]
    }
  ],
  usage: {
    quotaLimit: 100000,
    quotaUsed: 42680,
    resetDate: "2026-07-01",
    apiKeys: 3,
    activeTokens: 8,
    lastTokenRefresh: "2026-06-11 18:34"
  },
  mcpTools: [
    {
      id: "tool-crm-account-read",
      server: "enterprise-crm",
      name: "crm.account.read",
      risk: "medium",
      scopes: ["crm:read"],
      boundSkill: "Account Brief Builder"
    },
    {
      id: "tool-risk-report",
      server: "legal-mcp",
      name: "risk.report",
      risk: "high",
      scopes: ["legal:risk.write"],
      boundSkill: "Contract Risk Review"
    },
    {
      id: "tool-release-status",
      server: "platform-mcp",
      name: "release.status",
      risk: "low",
      scopes: ["deploy:read"],
      boundSkill: "Production Deploy Assistant"
    }
  ],
  activityEvents: [],
  journey: buildPortalJourneySnapshot([
    "profile_ready",
    "token_ready",
    "first_post",
    "first_reply",
    "skill_maker",
    "app_maker",
    "first_published_capability"
  ], "2026-06-18T10:00:00.000Z"),
  audit: [
    {
      id: "audit-1",
      actor: "portal.system@example.invalid",
      action: "issued mcp token",
      target: "legal-mcp / risk.report",
      time: "2 min ago"
    },
    {
      id: "audit-2",
      actor: "ops-copilot",
      action: "verified direct jump",
      target: "Ops Copilot",
      time: "14 min ago"
    },
    {
      id: "audit-3",
      actor: "revenue-ops",
      action: "requested scope review",
      target: "crm:read",
      time: "38 min ago"
    }
  ],
  reviewQueue: [
    {
      id: "review-growth-lab",
      type: "app",
      title: "Workspace Onboarding access review",
      owner: "AI Adoption",
      risk: "medium",
      submittedAt: "Today 09:12"
    },
    {
      id: "review-risk-report-scope",
      type: "scope",
      title: "legal:risk.write elevation",
      owner: "Legal AI",
      risk: "high",
      submittedAt: "Yesterday 17:42"
    },
    {
      id: "review-deploy-skill",
      type: "skill",
      title: "Production Deploy Assistant v0.8.7",
      owner: "Platform",
      risk: "medium",
      submittedAt: "Yesterday 10:08"
    }
  ]
};
