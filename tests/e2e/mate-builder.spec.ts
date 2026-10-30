import { expect, test } from "@playwright/test";
import { collectRuntimeErrors, mockPortalApis } from "./fixtures/portalApi";

test("opens the Mate Builder with resource and model selectors without crossing the render boundary", async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  const runtimeErrors = collectRuntimeErrors(page, {
    ignoredApiUrls: [/\/api\/home-bootstrap(?:\?|$)/]
  });
  await mockPortalApis(page);
  await page.route("**/api/apps/mates/avatar-options", route => route.fulfill({ json: { avatars: [] } }));
  const defaultMate = { ...editableMateFixture(), isDefault: true };
  await page.route("**/api/apps/mates/default", route => route.fulfill({ contentType: "application/json", json: { mate: defaultMate } }));
  await page.route("**/k/api/editable-folders", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { folders: [] } });
  });
  await page.route("**/api/apps/mcp-apps", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { apps: [null, {}, { appId: "portfolio", manifestVersion: "workspace.app-mcp/v1", name: "Portfolio" }] }
    });
  });
  await page.route("**/k/api/knowledge-services?view=card", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        services: [null, {}, {
          description: "Current-user authorized acceptance knowledge",
          effectiveRole: "viewer",
          name: "Adoption Handbook",
          serviceId: "adoption-handbook"
        }]
      }
    });
  });
  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        modelOptions: [
          null,
          {},
          { displayName: "GPT-6 Luna", id: "cf-openai-gpt-6-luna" },
          { displayName: "Kimi K3", id: "tencent-kimi-k3" }
        ],
        source: { provider: "litellm" }
      }
    });
  });
  await page.goto("/#/mate");
  await page.getByRole("button", { name: /^Switch Mate \(/ }).click();
  await page.getByRole("button", { name: "Create Mate", exact: true }).click();

  const builder = page.getByRole("dialog", { name: "Mate Builder" });
  await expect(builder).toBeVisible();
  await expect(builder.getByRole("heading", { name: "Create Mate" })).toBeVisible();
  await expect(builder.getByText("Runtime execution", { exact: false })).toHaveCount(0);
  await builder.getByRole("region", {name: "Query knowledge", exact: true}).getByRole("switch").click();
  await expect(builder.getByRole("button", { name: "Select Knowledge resources" })).toBeVisible();
  const modelPicker = builder.getByRole("button", { name: "Select Mate models" });
  await expect(modelPicker).toBeVisible();
  await expect(builder.getByText(/Luna-6 prioritizes model-provided web search/)).toBeVisible();
  await modelPicker.click();
  await page.getByRole("option", { name: /Kimi K3/ }).click();
  await expect(modelPicker).toContainText("2 models · default GPT-6 Luna");
  await page.getByRole("option", { name: /GPT-6 Luna/ }).click();
  await expect(modelPicker).toContainText("Kimi K3");
  await page.getByRole("option", { name: /GPT-6 Luna/ }).click();
  await expect(modelPicker).toContainText("2 models · default Kimi K3");
  await expect(builder.getByText("With multiple Target List models, users can switch in chat", { exact: false })).toBeVisible();
  await expect(builder.getByText("Allow users to switch models", { exact: true })).toHaveCount(0);
  await expect(builder.getByText("Default model", { exact: true })).toHaveCount(0);
  await builder.getByRole("region", {name: "Use App MCP", exact: true}).getByRole("switch").click();
  await builder.getByRole("button", { name: "Select App MCP resources" }).click();
  await expect(page.getByRole("option", { name: /Portfolio/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await builder.getByRole("button", { name: "Select Knowledge resources" }).click();
  await page.getByRole("option", { name: /Adoption Handbook/ }).click();
  await expect(builder.getByRole("button", { name: "Select Knowledge resources" })).toContainText("Adoption Handbook");
  await expect(page.getByRole("heading", { name: "The workspace is temporarily unavailable" })).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("keeps the Mate Code immutable and exposes one stable access link with the simplified release actions", async ({ page }) => {
  await page.setViewportSize({ height: 1000, width: 1440 });
  await page.addInitScript(() => window.localStorage.setItem("workspace-ai:locale", "en"));
  const mate = editableMateFixture();
  await mockPortalApis(page);
  await page.route("**/api/apps/mates/default", route => route.fulfill({ contentType: "application/json", json: { mate: { ...mate, isDefault: true } } }));
  await page.route("**/api/apps/inventory", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { apps: [], skills: [], mates: [mate] } });
  });
  await page.route("**/api/apps/mates/fixed-code", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { mate } });
  });
  await page.route("**/api/apps/mcp-apps", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { apps: [] } });
  });
  await page.route("**/k/api/knowledge-services?view=card", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { services: [] } });
  });
  await page.route("**/api/llm-gateway/access", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { modelOptions: [{ displayName: "DeepSeek V4 Flash", id: "tencent-deepseek-v4-flash" }] } });
  });

  await page.goto("/#/mate");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const builder = page.getByRole("dialog", { name: "Mate Builder" });
  await expect(builder).toBeVisible();
  await expect(builder.locator('input[aria-label="Mate Code"]')).toBeDisabled();
  await expect(builder.locator('input[aria-label="Mate Code"]')).toHaveValue("fixed-code");
  await expect(builder.getByText(/\/mates\/fixed-code$/, { exact: false })).toBeVisible();
  await expect(builder.getByRole("link", { name: "Open directly" })).toHaveAttribute("href", "/mates/fixed-code");

  const actions = builder.locator(".formActions");
  await expect(actions.getByRole("button")).toHaveCount(3);
  await expect(actions.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Save and Preview" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Publish as Production" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Save Draft" })).toHaveCount(0);
  await page.route("**/api/users/departments", route => route.fulfill({ json: { departments: [
    { id: "dept-org", name: "Company" },
    { id: "dept-group", name: "Group", parentId: "dept-org" },
    { id: "dept-am", name: "Account Manager", parentId: "dept-group" },
    { id: "dept-empty", name: "Empty team", parentId: "dept-group" }
  ] } }));
  // Reopen so the independent directory request uses this fixture.
  await builder.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await builder.getByRole("button", { name: "Who may call this Mate", exact: true }).click();
  await page.getByRole("option", { name: /Specified people or departments/ }).click();
  const search = builder.getByPlaceholder("Search departments, names, or emails");
  await search.fill("Empty team");
  await expect(builder.getByRole("checkbox", { name: "Empty team Department", exact: true })).toBeVisible();
  await search.fill("Group");
  await expect(builder.getByRole("checkbox", { name: "Group Department", exact: true })).toBeVisible();
  await search.fill("Account Manager");
  await builder.getByRole("checkbox", { name: "Account Manager Department", exact: true }).check();
  await expect(builder.locator(".accessTargetSelectedTag.department")).toContainText("Company / Group / Account Manager");
  await page.screenshot({ path: "output/knowledge-directory-audit-2026-10-13/fixed-mate.png" });
  await expect(builder.getByRole("link", { name: "Open Preview test link" })).toHaveCount(0);
  await expect(builder.getByRole("link", { name: "Open Standalone chat" })).toHaveCount(0);
});

function editableMateFixture() {
  const soul = { content: "# Soul", digest: "sha256:soul", id: "fixed-code-soul", kind: "soul", version: 1 };
  const handbook = { content: "# Handbook", digest: "sha256:handbook", id: "fixed-code-handbook", kind: "handbook", version: 1 };
  return {
    activeReleaseId: "fixed-code-r1",
    createdAt: "2026-08-30T00:00:00.000Z",
    description: "A Mate whose Code determines its stable address.",
    displayName: "Immutable Code Mate",
    draftDocuments: [soul, handbook],
    draftManifest: {
      channels: {
        embedded: { enabled: true },
        inbox: {
          email: { enabled: false },
          schedule: { enabled: false },
          mateCall: { enabled: false, tool: "mate_call", transport: "workspace_pass_mcp" },
          webhook: { enabled: false }
        },
        standalone: { enabled: true }
      },
      eligibilityPolicy: {},
      experiencePolicy: {
        automaticHandbookMutation: false,
        conversation: { channels: ["web", "sdk"], enabled: true },
        ownerTesting: { candidateReleaseOnly: true, enabled: true, isolatedFromLiveData: true },
        requiresReview: true,
        requiresSanitization: true,
        taskInbox: { channels: [], enabled: false }
      },
      invocationPolicy: {
        allowedCallerKinds: ["user"],
        requireAuthenticatedUser: true,
        visibility: "private"
      },
      modelPolicy: {
        allowedModels: ["tencent-deepseek-v4-flash"],
        allowUserSelection: false,
        defaultModel: "tencent-deepseek-v4-flash",
        multimodal: { audioInput: false, documentInput: true, imageInput: true }
      },
      preferenceSchema: {},
      release: {
        handbooks: [{ digest: handbook.digest, id: handbook.id, version: 1 }],
        releaseId: "fixed-code-draft-2",
        skills: [],
        soul: { digest: soul.digest, id: soul.id, version: 1 },
        status: "draft",
        version: 2
      },
      resources: {
        appMcpBindings: [],
        builtInToolBindings: [
          { requiresCurrentUserContext: true, toolId: "public_web_read" },
          { requiresCurrentUserContext: true, toolId: "todo_manage" },
          { requiresCurrentUserContext: true, toolId: "reminder_manage" }
        ],
        knowledgeServiceBindings: [],
        skillDiscoveryPolicy: { autoInstall: false, discoverAndRecommend: true, installationRequests: false }
      },
      schemaVersion: "workspace.agentruntime/v1",
      taskPolicy: {
        approvals: { revalidateDelegation: true, singleUse: true, writeRiskLevels: ["medium", "high", "critical"] },
        conclusionRequired: true,
        defaultExecutor: "operations",
        defaultTimezone: "UTC",
        requireUserOwnership: true,
        scheduledJobs: [],
        mateCallLimits: { maxChildrenPerTask: 8, maxDepth: 3, maxRunSeconds: 1800, maxTasksPerRoot: 24 }
      },
      mate: {
        addresses: [{ address: "fixed-code@example.invalid", type: "email" }],
        description: "A Mate whose Code determines its stable address.",
        displayName: "Immutable Code Mate",
        jobRole: "Verify stable release controls",
        ownerUserId: "local-dev-admin",
        mateId: "fixed-code"
      }
    },
    draftRevision: 2,
    id: "fixed-code",
    jobRole: "Verify stable release controls",
    orgId: "local-org",
    ownerUserId: "local-dev-admin",
    previewReleaseId: "fixed-code-r2",
    status: "deployed",
    updatedAt: "2026-08-30T00:00:00.000Z",
    visibility: "private",
    workEmail: "fixed-code@example.invalid"
  };
}
