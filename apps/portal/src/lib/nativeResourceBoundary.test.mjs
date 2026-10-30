import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(sourceRoot, "..", "..", "..");

describe("Portal native resource boundaries", () => {
  it("does not load demo portal data in the Portal application bundle", async () => {
    const files = await sourceFiles(sourceRoot);
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));

    assert.equal(sources.some((source) => source.includes("fallbackPortal")), false);
  });

  it("keeps versioned runtime entrypoints retired and makes Portal the only toolchain", async () => {
    for (const retired of [
      "apps/portal-v2",
      "dist-v2",
      "playwright.v2.config.ts",
      "vite.v2.config.ts",
      "src/App.tsx",
      "src/main.tsx"
    ]) {
      await assert.rejects(access(join(repositoryRoot, retired)), undefined, `retired V1 entry still exists: ${retired}`);
    }

    for (const canonical of ["apps/portal", "playwright.config.ts", "vite.config.ts"]) {
      await access(join(repositoryRoot, canonical));
    }

    const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    assert.equal(packageJson.scripts["dev:v2"], undefined);
    assert.equal(packageJson.scripts["build:v2"], undefined);
    assert.equal(packageJson.scripts["test:v2"], undefined);
    assert.equal(packageJson.scripts["test:e2e:v2"], undefined);
    assert.equal(packageJson.scripts["portal-v2:deploy:production"], undefined);
    assert.match(packageJson.scripts.build, /apps\/portal\/tsconfig\.json/);
    assert.match(packageJson.scripts["test:portal"], /scripts\/test\.mjs portal/);
    assert.match(packageJson.scripts["setup:apply"], /installer\/src\/cli\.mjs apply/);
    assert.equal(packageJson.scripts["build:app"], undefined);
  });

  it("keeps APPS and Knowledge independent from V1 pages and domain styles", async () => {
    const appsRoute = await readFile(join(sourceRoot, "routes", "PortalApps.tsx"), "utf8");
    const knowledgeRoute = await readFile(join(sourceRoot, "routes", "PortalKnowledge.tsx"), "utf8");
    const combined = `${appsRoute}\n${knowledgeRoute}`;

    for (const forbidden of [
      "WorkspaceApps",
      "MyKnowledge",
      "src/styles/domains/apps.css",
      "src/styles/domains/knowledge.css",
      "src/styles/domains/mcp-portal.css",
      "domain-bridge"
    ]) {
      assert.equal(combined.includes(forbidden), false, `unexpected V1 boundary: ${forbidden}`);
    }

    assert.match(appsRoute, /useAppsWorkspace/);
    assert.match(knowledgeRoute, /PortalKnowledgeWorkspace/);
  });

  it("keeps Gateway Admin native to Portal and contract-bound to LiteLLM", async () => {
    const files = [
      join(sourceRoot, "routes", "PortalAdminGateway.tsx"),
      join(sourceRoot, "components", "admin", "PortalAdminGatewayDialogs.tsx"),
      join(sourceRoot, "components", "admin", "PortalAdminGatewayPanels.tsx"),
      join(sourceRoot, "admin", "gateway", "api.ts"),
      join(sourceRoot, "admin", "gateway", "usePortalAdminGateway.ts")
    ];
    const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");

    for (const forbidden of [
      "AdminConsole",
      "LlmGatewayAllocationAdmin",
      "LlmGatewayUsageAdmin",
      "LlmGatewayAdmin",
      "src/styles/domains/admin.css",
      "src/portal/admin/"
    ]) {
      assert.equal(combined.includes(forbidden), false, `unexpected V1 Admin boundary: ${forbidden}`);
    }

    assert.match(combined, /source_not_litellm|provider !== "litellm"/);
  });

  it("keeps User Management, MCP Connections, and Hub Review native to Portal", async () => {
    const userRoute = await readFile(join(sourceRoot, "routes", "PortalAdminUsers.tsx"), "utf8");
    const mcpRoute = await readFile(join(sourceRoot, "routes", "PortalAdminMcpConnections.tsx"), "utf8");
    const mcpApi = await readFile(join(sourceRoot, "admin", "mcp", "api.ts"), "utf8");
    const reviewRoute = await readFile(join(sourceRoot, "routes", "PortalHubReview.tsx"), "utf8");
    const combined = `${userRoute}\n${mcpRoute}\n${mcpApi}\n${reviewRoute}`;

    for (const forbidden of ["AdminUsersPanel", "AssetManagementAdmin", "AssetReviewModal", "src/styles/domains/admin.css"]) {
      assert.equal(combined.includes(forbidden), false, `unexpected V1 Admin operations boundary: ${forbidden}`);
    }

    assert.match(userRoute, /\/api\/admin\/users/);
    assert.match(mcpApi, /\/api\/admin\/mcp\/connections/);
    assert.match(mcpRoute, /usePortalAdminMcpConnections/);
    assert.match(reviewRoute, /\/api\/listings\/|\/api\/assets\//);
    assert.match(reviewRoute, /asset\.type === "app" \|\| asset\.type === "skill"/);
    assert.match(reviewRoute, /publication\?\.status === "pending" \|\| publication\?\.status === "failed"/);
    assert.match(reviewRoute, /admin\.assets\.authPublicationPending/);
    assert.match(reviewRoute, /admin\.assets\.authPublicationFailed/);
  });

  it("mounts Admin data hooks only inside role-gated authenticated route components", async () => {
    const routes = [
      {
        file: "PortalAdminUsers.tsx",
        hook: "useAdminUsers",
        inner: "PortalAdminUsersAuthenticated",
        outer: "PortalAdminUsers"
      },
      {
        file: "PortalAdminGateway.tsx",
        hook: "usePortalAdminGateway",
        inner: "PortalAdminGatewayAuthenticated",
        outer: "PortalAdminGateway"
      },
      {
        file: "PortalAdminMcpConnections.tsx",
        hook: "usePortalAdminMcpConnections",
        inner: "PortalAdminMcpConnectionsAuthenticated",
        outer: "PortalAdminMcpConnections"
      }
    ];

    for (const route of routes) {
      const source = await readFile(join(sourceRoot, "routes", route.file), "utf8");
      const outerStart = source.indexOf(`export function ${route.outer}`);
      const innerStart = source.indexOf(`function ${route.inner}`);
      assert.ok(outerStart >= 0 && innerStart > outerStart, `${route.file} must define an outer role boundary before its data component`);

      const outerSource = source.slice(outerStart, innerStart);
      assert.match(outerSource, /currentUser\.role !== "admin"/);
      assert.match(outerSource, new RegExp(`<${route.inner}\\b`));
      assert.doesNotMatch(outerSource, new RegExp(`\\b${route.hook}\\s*\\(`));
      assert.doesNotMatch(outerSource, /\bfetch\s*\(/);
      assert.match(source.slice(innerStart), new RegExp(`\\b${route.hook}\\s*\\(`));
    }
  });

  it("keeps lazy routes visible and recoverable at the application boundary", async () => {
    const entry = await readFile(join(sourceRoot, "main.tsx"), "utf8");
    const portalApp = await readFile(join(sourceRoot, "PortalApp.tsx"), "utf8");
    const recovery = await readFile(join(sourceRoot, "components", "PortalRecovery.tsx"), "utf8");

    assert.match(entry, /<PortalAppErrorBoundary>\s*<PortalApp \/>\s*<\/PortalAppErrorBoundary>/);
    assert.doesNotMatch(portalApp, /fallback=\{null\}|<Suspense\b/);
    const routeSuspenseOpenings = portalApp.match(/<PortalRouteSuspense(?:\s[^>]*)?>/g) ?? [];
    assert.ok(routeSuspenseOpenings.length > 0);
    assert.equal(
      routeSuspenseOpenings.length,
      (portalApp.match(/<\/PortalRouteSuspense>/g) ?? []).length
    );
    assert.match(recovery, /<Suspense fallback=\{<PortalRouteLoading(?:\s[^>]*)? \/>\}>/);
    assert.match(recovery, /aria-live="polite"[\s\S]*role="status"/);
    assert.match(recovery, /portal\.data\.loadingTitle/);
    assert.match(recovery, /getDerivedStateFromError/);
    assert.match(recovery, /componentDidCatch/);
    assert.match(recovery, /role="alert"/);
    assert.match(recovery, /portal\.data\.retry/);
    assert.match(recovery, /common\.refresh/);
  });

  it("keeps Portal route styles on the centralized color token contract", async () => {
    const styleDirectory = join(sourceRoot, "styles");
    const styleEntries = await readdir(styleDirectory, { withFileTypes: true });
    const routeStyles = styleEntries.filter((entry) => (
      entry.isFile() && entry.name.endsWith(".css") && entry.name !== "tokens.css"
    ));
    const sources = await Promise.all(routeStyles.map((entry) => readFile(join(styleDirectory, entry.name), "utf8")));

    assert.equal(sources.some((source) => /#[0-9a-fA-F]{3,8}|rgba?\(/.test(source)), false);
  });
});

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}
