import { expect, type Page } from "@playwright/test";
import { fallbackPortal } from "../../../src/shared/fallbackPortal";
import { defaultPlatformBrand } from "../../../src/shared/platformBrand";
import { workspaceModuleNames, type WorkspaceModule } from "../../../src/shared/workspaceModules";
import type { PortalCatalog } from "../../../src/shared/types";

type RuntimeErrorOptions = {
  ignoredApiUrls?: RegExp[];
  ignoredConsoleTexts?: RegExp[];
};

type PortalApiMockOptions = {
  modules?: WorkspaceModule[];
  apps?: PortalCatalog["apps"];
  authSession?: Record<string, unknown>;
  catalog?: {
    json?: Record<string, unknown>;
    status?: number;
  };
  journey?: {
    json?: Record<string, unknown>;
    status?: number;
  };
  groupUsage?: {
    requestCount: number;
    startDate: string;
    totalTokens: number;
    updatedAt: string;
  };
  hubListings?: PortalCatalog["hubListings"];
  publicationListings?: PortalCatalog["publicationListings"];
};

export function collectRuntimeErrors(page: Page, options: RuntimeErrorOptions = {}) {
  const errors: string[] = [];

  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("response", (response) => {
    const url = response.url();
    const ignored = options.ignoredApiUrls?.some((pattern) => pattern.test(url));
    const expectedLegacyBootstrap = response.status() === 404 && /\/api\/home-bootstrap(?:\?|$)/.test(url);
    if (!ignored && !expectedLegacyBootstrap && url.includes("/api/") && response.status() >= 400) {
      errors.push(`${response.status()} ${url}`);
    }
  });
  page.on("console", (message) => {
    const text = message.text();
    const ignored = options.ignoredConsoleTexts?.some((pattern) => pattern.test(text));
    if (!ignored && message.type() === "error" && !text.startsWith("Failed to load resource:")) {
      errors.push(text);
    }
  });

  return errors;
}

export async function expectPortalReady(page: Page) {
  await expect(page.locator("main.shell")).toBeVisible();
  await expect(page.locator(".portalBootShell")).toHaveCount(0);
  await expect(page.locator(".portalRouteLoading")).toHaveCount(0);
  await expect.poll(async () => page.locator("main.shell").evaluate((element) => element.textContent?.trim().length ?? 0)).toBeGreaterThan(40);
}

export async function mockPortalApis(page: Page, options: PortalApiMockOptions = {}) {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 501,
      json: {
        error: "unmocked_api_request",
        url: route.request().url()
      }
    });
  });

  // Most page-level fixtures still exercise the independent auth/catalog
  // contracts. Let the production loader take its explicit legacy fallback so
  // the new bootstrap endpoint cannot be intercepted by the generic 501 mock.
  await page.route("**/api/home-bootstrap", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 404,
      json: { error: "home_bootstrap_not_mocked" }
    });
  });

  await page.route("**/api/public/brand", async (route) => {
    await route.fulfill({ json: {
      schemaVersion: 1,
      brand: defaultPlatformBrand,
      modules: options.modules ?? [...workspaceModuleNames]
    } });
  });

  await page.route("**/api/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        authenticated: true,
        configured: false,
        loginUrl: "/auth/login",
        logoutUrl: "/auth/logout",
        ...options.authSession
      }
    });
  });

  await page.route("**/api/llm-gateway/group-usage", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: options.groupUsage ?? {
        requestCount: 12_204,
        startDate: "2026-07-13",
        totalTokens: 48_200_122,
        updatedAt: "2026-08-17T04:00:00.000Z"
      }
    });
  });

  await page.route("**/api/notifications**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        notifications: [],
        unreadCount: 0
      }
    });
  });

  await page.route("**/api/catalog", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: options.catalog?.status ?? 200,
      json: options.catalog?.json ?? fallbackPortal
    });
  });

  await page.route("**/api/journey", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: options.journey?.status ?? 200,
      json: options.journey?.json ?? {
        journey: fallbackPortal.journey
      }
    });
  });

  await page.route("**/api/me", async (route) => {
    const catalog = (options.catalog?.json ?? fallbackPortal) as unknown as PortalCatalog;
    const journeyPayload = options.journey?.json ?? { journey: fallbackPortal.journey };
    const journey = (journeyPayload.journey ?? fallbackPortal.journey) as PortalCatalog["journey"];
    const badgeKeys = new Set(journey.badges.map((badge) => badge.badgeKey));
    await route.fulfill({
      contentType: "application/json",
      status: options.journey?.status ?? 200,
      json: {
        me: {
          ...catalog.currentUser,
          status: {
            journeyLevelKey: journey.level.key,
            mcpConnected: badgeKeys.has("mcp_connected"),
            tokenApplied: badgeKeys.has("token_ready"),
            updatedAt: journey.updatedAt
          }
        },
        ...journeyPayload
      }
    });
  });

  await page.route(/\/api\/apps(?:\?.*)?$/, async (route) => {
    const apps = options.apps ?? fallbackPortal.apps;
    await route.fulfill({
      contentType: "application/json",
      json: {
        apps: filterByRequestedTargetIds(apps, route.request().url(), (app) => app.id)
      }
    });
  });

  await page.route("**/api/skills", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        skills: fallbackPortal.skills
      }
    });
  });

  await page.route("**/api/data-services", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        dataServices: fallbackPortal.dataServices
      }
    });
  });

  await page.route(/\/api\/publication\/listings(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        publicationListings: options.publicationListings ?? fallbackPortal.publicationListings
      }
    });
  });

  await page.route(/\/api\/publication\/hub-listings(?:\?.*)?$/, async (route) => {
    const hubListings = options.hubListings ?? fallbackPortal.hubListings;
    await route.fulfill({
      contentType: "application/json",
      json: {
        hubListings: filterByRequestedTargetIds(
          hubListings,
          route.request().url(),
          (listing) => listing.targetId
        )
      }
    });
  });

  await page.route("**/api/publication/interactions", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    await route.fulfill({
      contentType: "application/json",
      status: 201,
      json: {
        action: body.action,
        recorded: true
      }
    });
  });

  await page.route("**/api/community/join", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        joined: true
      }
    });
  });

  await page.route("**/api/forum/topics/**/view", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        viewed: true
      }
    });
  });

  await page.route(/\/api\/forum\/topics\/([^/?]+)$/, async (route) => {
    const topicId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    const discussion = fallbackPortal.discussions.find((item) => item.id === topicId)
      ?? { ...fallbackPortal.discussions[0], id: topicId, title: topicId };
    await route.fulfill({
      contentType: "application/json",
      json: { discussion }
    });
  });

  await page.route(/\/api\/forum\/topics(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        discussions: fallbackPortal.discussions.filter((discussion) => !discussion.pinned),
        pinnedDiscussions: fallbackPortal.discussions.filter((discussion) => discussion.pinned)
      }
    });
  });

  await page.route("**/api/activity/events**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        events: fallbackPortal.activityEvents
      }
    });
  });

  await page.route("**/api/users/departments", route => route.fulfill({ json: { departments: [
    { id: "dept-research", name: "Research", path: ["dept-research"], status: "active" },
    { id: "dept-macro", name: "Macro", parentId: "dept-research", path: ["dept-research", "dept-macro"], status: "active" },
    { id: "dept-credit", name: "Credit", parentId: "dept-research", path: ["dept-research", "dept-credit"], status: "active" }
  ] } }));

  await page.route("**/api/users/directory**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        users: [{
          department: fallbackPortal.currentUser.department,
          departmentId: fallbackPortal.currentUser.departmentId,
          departmentPath: fallbackPortal.currentUser.departmentPath,
          email: fallbackPortal.currentUser.email,
          emailPrefix: fallbackPortal.currentUser.email.split("@")[0],
          id: fallbackPortal.currentUser.id,
          name: fallbackPortal.currentUser.name,
          team: fallbackPortal.currentUser.team
        }, {
          department: "Research / Macro",
          departmentId: "dept-macro",
          departmentPath: ["dept-research", "dept-macro"],
          email: "bob@example.test",
          emailPrefix: "bob",
          id: "user-bob",
          name: "Bob Chen",
          team: "Macro"
        }, {
          department: "Research / Credit",
          departmentId: "dept-credit",
          departmentPath: ["dept-research", "dept-credit"],
          email: "alice@example.test",
          emailPrefix: "alice",
          id: "user-alice",
          name: "Alice Wong",
          team: "Credit"
        }]
      }
    });
  });

  await page.route("**/api/users/batch**", async (route) => {
    const ids = new URL(route.request().url()).searchParams.getAll("ids")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim());
    const users: Array<Record<string, unknown>> = [];
    if (ids.includes(fallbackPortal.currentUser.id)) {
      users.push({
        avatarUrl: fallbackPortal.currentUser.avatarUrl,
        bio: fallbackPortal.currentUser.bio,
        department: fallbackPortal.currentUser.department,
        email: fallbackPortal.currentUser.email,
        id: fallbackPortal.currentUser.id,
        jobTitle: fallbackPortal.currentUser.jobTitle,
        journeyLevelKey: fallbackPortal.journey.level.key,
        name: fallbackPortal.currentUser.name,
        role: fallbackPortal.currentUser.role,
        team: fallbackPortal.currentUser.team
      });
    }
    if (ids.includes("user-owner")) {
      users.push({
        avatarUrl: "",
        bio: "Owns controlled knowledge for the company.",
        department: "Knowledge Governance",
        email: "knowledge.owner@example.test",
        id: "user-owner",
        jobTitle: "Knowledge Owner",
        journeyLevelKey: "builder",
        name: "Knowledge Owner",
        role: "member",
        team: "AI Adoption"
      });
    }
    if (ids.includes("user-bob")) {
      users.push({
        avatarUrl: "",
        bio: "Maintains shared research knowledge.",
        department: "Research / Macro",
        email: "bob@example.test",
        id: "user-bob",
        jobTitle: "Research Analyst",
        journeyLevelKey: "builder",
        name: "Bob Chen",
        role: "member",
        team: "Macro"
      });
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        users
      }
    });
  });

  await page.route("**/api/admin/users", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        users: [{
          createdAt: "2026-07-01T00:00:00.000Z",
          department: fallbackPortal.currentUser.department,
          departmentId: fallbackPortal.currentUser.departmentId,
          departmentPath: fallbackPortal.currentUser.departmentPath,
          email: fallbackPortal.currentUser.email,
          id: fallbackPortal.currentUser.id,
          lastSeenAt: "2026-07-10T00:00:00.000Z",
          name: fallbackPortal.currentUser.name,
          principalName: fallbackPortal.currentUser.identity.principalName,
          role: fallbackPortal.currentUser.role,
          status: "active",
          team: fallbackPortal.currentUser.team
        }]
      }
    });
  });

  await page.route("**/k/api/admin/knowledge-services", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        services: [{
          access: { company: false, departments: ["dept-approved"], users: [] },
          agentEnabled: true,
          category: "partner-intelligence",
          collaboratorUserIds: ["user-bob"],
          createdAt: "2026-07-20T08:00:00.000Z",
          description: "Private partner intelligence for approved collaborators.",
          feedbackEnabled: true,
          fileCount: 18,
          folderName: "PB Partner",
          folderObjectId: "knowledge-folder-1",
          folderPath: "PB Partner",
          id: "service-1",
          indexStatus: "ready",
          indexedAt: "2026-07-26T09:30:00.000Z",
          languages: ["en", "zh-CN"],
          lastActiveAt: "2026-07-26T09:30:00.000Z",
          name: "PB Partner",
          namespaceId: "namespace-1",
          ownerUserId: fallbackPortal.currentUser.id,
          permissionType: "targeted",
          requestCount: 42,
          slug: "pb-partner",
          sourceRevision: 3,
          tags: ["partners", "private"],
          updatedAt: "2026-07-26T09:00:00.000Z"
        }],
        summary: {
          companyVisibleCount: 0,
          fileCount: 18,
          requestCount: 42,
          serviceCount: 1
        }
      }
    });
  });

  await page.route("**/api/forum/link-preview**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        preview: {
          title: "E2E link preview",
          type: "link",
          url: "https://example.test"
        }
      }
    });
  });

  await page.route("**/api/apps/token", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        scopes: ["apps:apps:read", "apps:skills:read"],
        token: "e2e-apps-token",
        tokenType: "Bearer"
      }
    });
  });

  await page.route("**/api/apps/apps", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        apps: []
      }
    });
  });

  await page.route("**/api/apps/inventory", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        apps: [],
        skills: []
      }
    });
  });

  await page.route("**/api/apps/skills", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        skills: []
      }
    });
  });

  await page.route("**/api/mcp/connections/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        status: {
          activeCount: 0,
          connected: false,
          connections: [],
          maxActiveConnections: 3
        }
      }
    });
  });

  await page.route("**/api/mcp/install/config", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        agents: [],
        llmsTxt: "https://mcp.example.test/llms.txt",
        resource: "https://mcp.example.test"
      }
    });
  });

  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        gatewayUrl: "https://llm.example.test",
        modelOptions: [],
        policies: [],
        source: {
          endpoints: ["/user/info", "/key/list", "/v1/model/info"],
          fetchedAt: "2026-07-12T05:00:00.000Z",
          mode: "admin-api",
          provider: "litellm"
        },
        series: [],
        tokens: [],
        usage: []
      }
    });
  });

  await page.route("**/k/api/tree**", async (route) => {
    const url = new URL(route.request().url());
    const folderObjectId = url.searchParams.get("folderObjectId");
    const prefix = url.searchParams.get("prefix") ?? "";
    if (folderObjectId === "knowledge-folder-1" || (!folderObjectId && prefix === "client-onboarding-kit")) {
      await route.fulfill({
        contentType: "application/json",
        json: {
          items: [{
            access: "owner",
            agentEnabled: false,
            description: "A nested folder covered by an ancestor Knowledge Service.",
            id: "knowledge-nested-folder",
            kind: "folder",
            knowledgeServiceAvailable: true,
            knowledgeServiceId: "service-ancestor",
            modifiedAt: "2026-07-02T08:00:00.000Z",
            name: "Nested Reference",
            ownerUserId: "user-owner",
            parentPath: "client-onboarding-kit",
            path: "client-onboarding-kit/nested-reference",
            shareMode: "private",
            sizeBytes: 0,
            tags: ["nested"],
            version: "v1"
          }]
        }
      });
      return;
    }
    if (folderObjectId) {
      const folderPath = folderObjectId === "shared-viewer-folder" ? "company-handbook" : "shared-research";
      await route.fulfill({
        contentType: "application/json",
        json: {
          items: [{
            access: folderObjectId === "shared-viewer-folder" ? "viewer" : "collaborator",
            agentEnabled: folderObjectId === "shared-viewer-folder",
            description: "A file inside a shared folder.",
            id: `${folderObjectId}-file`,
            kind: "markdown",
            modifiedAt: "2026-07-03T12:00:00.000Z",
            name: "handbook.md",
            ownerUserId: "user-owner",
            parentPath: folderPath,
            path: `${folderPath}/handbook.md`,
            shareMode: "private",
            sizeBytes: 1200,
            tags: ["shared"],
            version: "v1"
          }]
        }
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: {
        items: [
          {
            access: "owner",
            agentEnabled: false,
            description: "Reusable onboarding material for the team.",
            id: "knowledge-folder-1",
            kind: "folder",
            modifiedAt: "2026-07-01T10:00:00.000Z",
            name: "Client Onboarding Kit",
            ownerUserId: "user-owner",
            parentPath: "",
            path: "client-onboarding-kit",
            shareMode: "team",
            sizeBytes: 0,
            tags: ["team"],
            version: "v1"
          },
          {
            access: "owner",
            description: "HTML briefing page for smoke testing.",
            id: "knowledge-file-1",
            kind: "html",
            modifiedAt: "2026-07-02T12:00:00.000Z",
            name: "Market Brief.html",
            ownerUserId: "user-owner",
            parentPath: "",
            path: "Market Brief.html",
            shareMode: "company",
            sizeBytes: 24800,
            tags: ["brief"],
            version: "v3"
          }
        ],
        namespace: {
          id: "knowledge-namespace-1",
          name: "QA Knowledge",
          ownerUserId: "user-owner",
          r2BucketName: "qa-knowledge",
          r2Prefix: "qa",
          slug: "qa",
          status: "active",
          usedBytes: 24800
        }
      }
    });
  });

  await page.route("**/k/api/shared-with-me**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        items: [
          {
            access: "collaborator",
            accessKind: "collaboration",
            agentEnabled: false,
            description: "A folder shared for editing.",
            id: "shared-collaborator-folder",
            kind: "folder",
            modifiedAt: "2026-07-03T10:00:00.000Z",
            name: "Shared Research",
            ownerUserId: "user-owner",
            parentPath: "",
            path: "shared-research",
            shareMode: "team",
            sizeBytes: 0,
            tags: ["shared"],
            version: "v1"
          },
          {
            access: "viewer",
            accessKind: "knowledge_service",
            agentEnabled: true,
            description: "The same shared folder is also Agent-ready.",
            id: "shared-collaborator-folder",
            indexStatus: "ready",
            kind: "folder",
            knowledgeServiceId: "service-shared-research",
            modifiedAt: "2026-07-03T11:00:00.000Z",
            name: "Shared Research",
            ownerUserId: "user-owner",
            parentPath: "",
            path: "shared-research",
            shareMode: "team",
            sizeBytes: 0,
            tags: ["agent"],
            version: "v2"
          },
          {
            access: "viewer",
            accessKind: "knowledge_service",
            agentEnabled: true,
            description: "A read-only Agent-ready knowledge base.",
            id: "shared-viewer-folder",
            indexStatus: "ready",
            kind: "folder",
            knowledgeServiceId: "service-viewer",
            modifiedAt: "2026-07-04T11:00:00.000Z",
            name: "Company Handbook",
            ownerUserId: "user-owner",
            parentPath: "",
            path: "company-handbook",
            shareMode: "company",
            sizeBytes: 0,
            tags: ["agent"],
            version: "v1"
          }
        ]
      }
    });
  });

  let publicShare: { expiresAt: string | null; id: string; slug: string; url: string } | undefined;
  await page.route("**/k/api/objects/*/public-share", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: { active: Boolean(publicShare), share: publicShare } });
      return;
    }
    if (route.request().method() === "DELETE") {
      publicShare = undefined;
      await route.fulfill({ contentType: "application/json", json: { active: false } });
      return;
    }
    const body = route.request().postDataJSON() as { expiry?: string };
    publicShare = {
      expiresAt: body.expiry === "permanent" ? null : "2026-07-15T12:00:00.000Z",
      id: "public-share-1",
      slug: "public-share",
      url: "https://knowledge.example.test/public-share"
    };
    await route.fulfill({ contentType: "application/json", json: { active: true, share: publicShare }, status: 201 });
  });

  await page.route("**/k/api/access**", async (route) => {
    const objectId = new URL(route.request().url()).searchParams.get("objectId");
    await route.fulfill({
      contentType: "application/json",
      json: {
        access: {
          grants: objectId === "knowledge-folder-1" ? [
            { id: "grant-direct", objectId, role: "collaborator", subjectId: "user-bob", subjectType: "user" },
            { id: "grant-inherited", objectId: null, role: "viewer", subjectId: "workspace", subjectType: "company" }
          ] : []
        }
      }
    });
  });

  await page.route("**/k/api/access-grants/**", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { ok: true } });
  });

  await page.route("**/k/api/access-grants", async (route) => {
    const body = route.request().postDataJSON() as { objectId?: string; role?: string; subjectId?: string; subjectType?: string };
    await route.fulfill({
      contentType: "application/json",
      json: {
        grant: {
          id: `grant-${body.subjectId ?? "user"}`,
          objectId: body.objectId,
          role: body.role,
          subjectId: body.subjectId,
          subjectType: body.subjectType
        }
      },
      status: 201
    });
  });

  await page.route("**/k/api/objects/*/collaborators", async (route) => {
    const body = route.request().postDataJSON() as { userIds?: string[] };
    const objectId = route.request().url().split("/api/objects/")[1]?.split("/collaborators")[0] ?? "";
    const userIds = body.userIds ?? [];
    await route.fulfill({
      contentType: "application/json",
      json: {
        collaborators: userIds.map((subjectId) => ({
          canShare: true,
          id: `grant-${subjectId}`,
          objectId,
          role: "collaborator",
          subjectId,
          subjectType: "user"
        })),
        userIds
      }
    });
  });

  await page.route("**/k/api/knowledge-services/preflight**", async (route) => {
    const folderObjectId = new URL(route.request().url()).searchParams.get("folderObjectId");
    await route.fulfill({
      contentType: "application/json",
      json: {
        folder: { id: folderObjectId },
        handbookObjectId: `${folderObjectId}-handbook`,
        ready: true,
        status: "ready"
      }
    });
  });

  await page.route("**/k/api/knowledge-services", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        json: {
          services: [{
            agentEnabled: true,
            collaboratorUserIds: ["user-bob"],
            description: "The same shared folder is also Agent-ready.",
            effectiveRole: "collaborator",
            folder: {
              access: "collaborator",
              accessKind: "knowledge_service",
              agentEnabled: true,
              description: "The same shared folder is also Agent-ready.",
              id: "shared-collaborator-folder",
              indexStatus: "ready",
              kind: "folder",
              knowledgeServiceId: "service-shared-research",
              modifiedAt: "2026-07-03T11:00:00.000Z",
              name: "Shared Research",
              ownerUserId: "user-owner",
              parentPath: "",
              path: "shared-research",
              shareMode: "team",
              sizeBytes: 0,
              tags: ["agent"],
              version: "v2"
            },
            folderName: "Shared Research",
            folderObjectId: "shared-collaborator-folder",
            folderPath: "shared-research",
            id: "service-shared-research",
            indexStatus: "ready",
            maintenanceTeam: "Research Operations",
            name: "Shared Research"
          }, {
            agentEnabled: true,
            collaboratorUserIds: ["user-bob"],
            description: "A read-only Agent-ready knowledge base.",
            effectiveRole: "viewer",
            folder: {
              access: "viewer",
              accessKind: "knowledge_service",
              agentEnabled: true,
              description: "A read-only Agent-ready knowledge base.",
              id: "shared-viewer-folder",
              indexStatus: "ready",
              kind: "folder",
              knowledgeServiceId: "service-viewer",
              modifiedAt: "2026-07-04T11:00:00.000Z",
              name: "Company Handbook",
              ownerUserId: "user-owner",
              parentPath: "",
              path: "company-handbook",
              shareMode: "company",
              sizeBytes: 0,
              tags: ["agent"],
              version: "v1"
            },
            folderName: "Company Handbook",
            folderObjectId: "shared-viewer-folder",
            folderPath: "company-handbook",
            id: "service-viewer",
            indexStatus: "ready",
            name: "Company Handbook"
          }]
        }
      });
      return;
    }
    const body = route.request().postDataJSON() as { access?: Record<string, unknown>; maintenanceTeam?: string };
    await route.fulfill({
      contentType: "application/json",
      json: { service: { access: body.access, enabled: true, handbookObjectId: "handbook-1", id: "service-1", indexStatus: "pending", maintenanceTeam: body.maintenanceTeam } },
      status: 201
    });
  });

  await page.route("**/k/api/knowledge-services/service-1", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { service: { agentEnabled: false, handbookObjectId: "handbook-1", id: "service-1", indexStatus: "disabled" } }
    });
  });
}

function filterByRequestedTargetIds<T>(
  items: T[],
  requestUrl: string,
  targetId: (item: T) => string
) {
  const ids = new URL(requestUrl).searchParams.getAll("ids")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return ids.length > 0 ? items.filter((item) => ids.includes(targetId(item))) : items;
}
