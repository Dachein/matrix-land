import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE } from "../../../src/shared/appsResourceCatalog.ts";

describe("Agent app APPS contract", () => {
  it("uses Worker, D1, and Agent Schema as the fixed Agent app resource package", () => {
    assert.deepEqual(APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE.agent_app, [
      "worker",
      "d1_database",
      "schema_registry"
    ]);
  });

  it("uses app-scoped resource names and deterministic runtime URL templates", () => {
    const resourcesSource = readFileSync(new URL("../src/apps/resources.ts", import.meta.url), "utf8");
    const urlsSource = readFileSync(new URL("../src/runtime/urls.ts", import.meta.url), "utf8");

    assert.match(resourcesSource, /`apps-\$\{appCode\}-\$\{token\}`/);
    assert.doesNotMatch(resourcesSource, /apps-\$\{envName\}-\$\{orgSlug\}/);
    assert.doesNotMatch(urlsSource, /previewUrl/);
    assert.doesNotMatch(urlsSource, /--preview/);
    assert.match(urlsSource, /productionUrl: `https:\/\/\$\{prefix\}\$\{code\}\.\$\{domain\}`/);
    assert.doesNotMatch(urlsSource, /mcpUrl/);
    assert.doesNotMatch(urlsSource, /--mcp/);
    assert.doesNotMatch(urlsSource, /\/preview/);
    assert.doesNotMatch(urlsSource, /\/run\/\$\{code\}\/mcp/);
  });

  it("does not accept caller supplied orgSlug for app creation", () => {
    const serviceSource = readFileSync(new URL("../src/apps/service.ts", import.meta.url), "utf8");
    const mcpHandlerSource = readFileSync(new URL("../src/mcp/handler.ts", import.meta.url), "utf8");
    const mcpToolsSource = readFileSync(new URL("../src/mcp/tools.ts", import.meta.url), "utf8");

    assert.match(serviceSource, /const orgSlug = slugify\(principal\.orgSlug\)/);
    assert.doesNotMatch(serviceSource, /body\.orgSlug/);
    assert.doesNotMatch(serviceSource, /orgSlug\?: string/);
    assert.doesNotMatch(mcpHandlerSource, /args\.orgSlug/);
    assert.doesNotMatch(mcpToolsSource, /orgSlug: \{ type: "string" \}/);
  });

  it("exposes one canonical App context while retaining the signed handoff fallback", () => {
    const mcpHandlerSource = readFileSync(new URL("../src/mcp/handler.ts", import.meta.url), "utf8");
    const mcpToolsSource = readFileSync(new URL("../src/mcp/tools.ts", import.meta.url), "utf8");
    const workerSource = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    const handoffLinksSource = readFileSync(new URL("../src/apps/handoffLinks.ts", import.meta.url), "utf8");
    const mapperSource = readFileSync(new URL("../src/apps/mappers.ts", import.meta.url), "utf8");
    const handoffSource = readFileSync(new URL("../../../src/shared/appsAgentHandoff.ts", import.meta.url), "utf8");
    const authHandoffDoc = readFileSync(new URL("../../../docs/auth-sdk-handoff.md", import.meta.url), "utf8");
    const builderDoc = readFileSync(new URL("../../../docs/workspace-apps-builder-system.md", import.meta.url), "utf8");
    const portalI18nSource = readFileSync(new URL("../../../src/portal/i18n/resources.ts", import.meta.url), "utf8");

    const secretsSource = readFileSync(new URL("../src/apps/secrets.ts", import.meta.url), "utf8");

    assert.match(mcpToolsSource, /name: "apps_get_app"/);
    assert.doesNotMatch(mcpToolsSource, /name: "apps_get_app_handoff"/);
    assert.doesNotMatch(mcpToolsSource, /name: "apps_get_service_context"/);
    for (const userVisibleSource of [authHandoffDoc, builderDoc, portalI18nSource]) {
      assert.doesNotMatch(userVisibleSource, /apps_get_app_handoff/);
      assert.doesNotMatch(userVisibleSource, /apps_get_service_context/);
    }
    assert.match(mcpHandlerSource, /name === "apps_get_app_handoff"/);
    assert.match(mcpHandlerSource, /developerContext: buildAppDeveloperContext\(app\)/);
    assert.match(workerSource, /handoffAuthorizedRequest/);
    assert.match(workerSource, /handoff-link/);
    assert.match(workerSource, /handoff_token_app_mismatch/);
    assert.match(handoffLinksSource, /HANDOFF_LINK_PREFIX = "lh_"/);
    assert.match(handoffLinksSource, /apps_handoff_links/);
    assert.match(handoffLinksSource, /sha256Hex/);
    assert.match(mapperSource, /WORKSPACE_AUTH_ORIGIN/);
    assert.match(mapperSource, /WORKSPACE_AUTH_AUTHORIZE_ORIGIN/);
    assert.match(mapperSource, /publicOrigin}\/auth\/v1\/authorize/);
    assert.doesNotMatch(mapperSource, /jwksUrl/);
    assert.match(mapperSource, /loginStartPath/);
    assert.doesNotMatch(mapperSource, /fallbackPreview/);
    assert.match(mapperSource, /strategy: "first_login"/);
    assert.match(mapperSource, /appUserObjectName: "appUser"/);
    assert.match(mapperSource, /appUserTableRecommendation: "app_users"/);
    assert.match(mapperSource, /source: "verified_app_session"/);
    assert.doesNotMatch(mapperSource, /x-workspace-user/);
    assert.match(handoffSource, /workspaceUser/);
    assert.match(handoffSource, /Never derive user identity or authorization from caller-supplied/);
    assert.doesNotMatch(handoffSource, /Trusted identity headers/);
    assert.match(handoffSource, /Mandatory login entry/);
    assert.match(handoffSource, /explicit browser `authorizeOrigin`/);
    assert.match(handoffSource, /no separate signup flow/);
    assert.match(handoffSource, /first successful Workspace Auth login/);
    assert.match(handoffSource, /## App User Bootstrap Contract/);
    assert.match(handoffSource, /authenticated: true/);
    assert.match(handoffSource, /CREATE TABLE IF NOT EXISTS/);
    assert.match(handoffSource, /Resource naming/);
    assert.match(handoffSource, /There is no separate Preview environment/);
    assert.match(handoffSource, /request approval before the real deploy/);
    assert.match(handoffSource, /Before every APPS App deploy/);
    assert.match(handoffSource, /CLI bundled with this workspace release/);
    assert.match(handoffSource, /npm install -g .\/frontier-workspace-cli-/);
    assert.match(handoffSource, /frontier-workspace agent install --agent=<agent>/);
    assert.match(handoffSource, /## MCP Build Loop/);
    assert.match(handoffSource, /workspace\.apps\.app-context\.v2/);
    assert.match(handoffSource, /apps_app_read\(action=get\) as the canonical developer context/);
    assert.match(handoffSource, /WorkspaceAuthDirectory/);
    assert.doesNotMatch(handoffSource, /apps_get_service_context/);
    assert.match(handoffSource, /## Data And API Update Contract/);
    assert.match(secretsSource, /managed_secret_declaration_not_required/);
    assert.match(secretsSource, /invalid_secret_requirement_shape/);
  });

  it("accepts agent_app and rejects the retired data_mcp app type in the base schema", () => {
    const database = new DatabaseSync(":memory:");
    const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    database.exec(schema);

    database.prepare(`
      INSERT INTO apps_apps (
        id,
        org_id,
        org_slug,
        owner_user_id,
        name,
        code,
        slug,
        description,
        type,
        status,
        visibility,
        login_required,
        agent_mcp_enabled,
        llm_enabled,
        data_service_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "app-1",
      "org-1",
      "workspace",
      "user-1",
      "Fund Query",
      "fund-query",
      "fund-query",
      "",
      "agent_app",
      "provisioning",
      "org",
      1,
      1,
      0,
      "ds-1",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z"
    );

    assert.throws(
      () => database.prepare(`
        INSERT INTO apps_apps (
          id,
          org_id,
          org_slug,
          owner_user_id,
          name,
          code,
          slug,
          description,
          type,
          status,
          visibility,
          data_service_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "app-2",
        "org-1",
        "workspace",
        "user-1",
        "Old Data MCP",
        "old-data-mcp",
        "old-data-mcp",
        "",
        "data_mcp",
        "provisioning",
        "org",
        "ds-2",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z"
      )
    );
  });

  it("keeps obsolete acceptance App restoration SQL outside the managed migration directory", () => {
    for (const name of [
      "0007_restore_production_acceptance_app.sql",
      "0012_reconcile_production_acceptance_app.sql",
      "0019_restore_source_snapshot_acceptance_fixture.sql"
    ]) {
      assert.equal(existsSync(new URL(`./d1-migrations/${name}`, import.meta.url)), false);
      assert.equal(existsSync(new URL(`./retired-fixtures/${name}`, import.meta.url)), false);
    }
  });
});
