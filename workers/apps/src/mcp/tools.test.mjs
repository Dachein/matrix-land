import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { WORKSPACE_AUTH_SDK_PACKAGE_BASE64 } from "../apps/authSdkPackageData.ts";
import {
  WORKSPACE_AUTH_SDK_EMBEDDED_SHA256,
  WORKSPACE_AUTH_SDK_EMBEDDED_SIZE_BYTES,
} from "../apps/authSdkPackageMetadata.ts";
import { mcpTools } from "./tools.ts";

describe("APPS MCP build tool contract", () => {
  it("exposes the structured APPS deploy and data tools", () => {
    const tools = mcpTools();
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes("apps_list_inventory"));
    assert.ok(names.includes("apps_get_app"));
    assert.ok(names.includes("apps_get_auth_sdk"));
    assert.equal(names.includes("apps_get_app_handoff"), false);
    assert.equal(names.includes("apps_get_service_context"), false);
    assert.ok(names.includes("apps_pages_deploy"));
    assert.ok(names.includes("apps_worker_deploy"));
    assert.ok(names.includes("apps_deployments_publish"));
    assert.ok(names.includes("apps_deployments_rollback"));
    assert.ok(names.includes("apps_d1_migrations_apply"));
    assert.ok(names.includes("apps_env_vars_set"));
    assert.ok(names.includes("apps_kv_value_put"));
    assert.ok(names.includes("apps_r2_object_put"));
    assert.ok(names.includes("apps_secrets_declare"));
    const publishTool = tools.find((tool) => tool.name === "apps_deployments_publish");
    assert.ok(Object.hasOwn(publishTool.inputSchema.properties, "accessTargets"));
    assert.ok(Object.hasOwn(publishTool.inputSchema.properties, "harnessReportUrl"));
    assert.ok(Object.hasOwn(publishTool.inputSchema.properties, "harnessSelfCheckConfirmed"));
    assert.deepEqual(publishTool.inputSchema.required, ["appId"]);
    assert.match(publishTool.description, /optional/);
    const migrationTool = tools.find((tool) => tool.name === "apps_d1_migrations_apply");
    assert.ok(Object.hasOwn(migrationTool.inputSchema.properties, "allowDataMigrations"));
    assert.match(migrationTool.description, /explicit user approval/);
    const authSdkTool = tools.find((tool) => tool.name === "apps_get_auth_sdk");
    assert.deepEqual(authSdkTool.inputSchema.required, ["appId"]);
    assert.match(authSdkTool.description, /organization-directory/);
    assert.match(authSdkTool.description, /department-permission/);
    assert.match(authSdkTool.description, /multi-level organization/);
    const getAppTool = tools.find((tool) => tool.name === "apps_get_app");
    assert.match(getAppTool.description, /readiness/);
    assert.match(getAppTool.description, /next actions/i);
    const updateAppConfigTool = tools.find((tool) => tool.name === "apps_update_app_config");
    assert.ok(Object.hasOwn(updateAppConfigTool.inputSchema.properties, "agentMcpEnabled"));
    assert.deepEqual(updateAppConfigTool.inputSchema.properties.directoryReadScope.enum, ["app", "company"]);
    assert.ok(Object.hasOwn(updateAppConfigTool.inputSchema.properties, "addResourceTypes"));
    assert.ok(updateAppConfigTool.inputSchema.properties.addResourceTypes.items.enum.includes("hyperdrive_config"));
    assert.match(updateAppConfigTool.description, /append-only/);
    assert.match(updateAppConfigTool.description, /Web, Automation, and Container/);
    for (const name of ["apps_pages_deploy", "apps_worker_deploy"]) {
      const deployTool = tools.find((tool) => tool.name === name);
      assert.match(deployTool.description, /structuredContent\.error\.details\.security\.auth/);
      assert.deepEqual(deployTool.inputSchema.properties.hyperdrive.required, ["scheme", "host", "database", "user"]);
      assert.equal(Object.hasOwn(deployTool.inputSchema.properties.hyperdrive.properties, "password"), false);
    }
  });

  it("serves the pinned official Auth SDK artifact without byte drift", async () => {
    const bytes = Buffer.from(WORKSPACE_AUTH_SDK_PACKAGE_BASE64, "base64");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    assert.equal(bytes.byteLength, WORKSPACE_AUTH_SDK_EMBEDDED_SIZE_BYTES);
    assert.equal(sha256, WORKSPACE_AUTH_SDK_EMBEDDED_SHA256);
    const tar = gunzipSync(bytes).toString("utf8");
    assert.match(tar, /package\/dist\/directory\.js/);
    assert.match(tar, /class WorkspaceAuthDirectory/);
    assert.match(tar, /class WorkspaceMcpAuthorization/);
  });

  it("exposes the APPS Skill lifecycle tools", () => {
    const names = mcpTools().map((tool) => tool.name);

    assert.ok(names.includes("apps_list_skills"));
    assert.ok(names.includes("apps_get_skill"));
    assert.ok(names.includes("apps_skill_validate"));
    assert.ok(names.includes("apps_skill_submit"));
    assert.ok(names.includes("apps_skill_update"));
  });

  it("exposes the Mate identity, core-review, Draft, and Release lifecycle", () => {
    const tools = mcpTools();
    const names = tools.map((tool) => tool.name);
    for (const name of [
      "apps_list_mates",
      "apps_mate_create",
      "apps_mate_get",
      "apps_mate_update",
      "apps_mate_core_review",
      "apps_mate_core_update",
      "apps_mate_definition_update",
      "apps_mate_validate",
      "apps_mate_deploy_preview",
      "apps_mate_publish",
      "apps_mate_releases_list",
      "apps_mate_release_activate"
    ]) assert.ok(names.includes(name), `${name} must be advertised`);
    assert.deepEqual(tools.find((tool) => tool.name === "apps_mate_deploy_preview").inputSchema.required, ["mateId", "confirm"]);
    assert.deepEqual(tools.find((tool) => tool.name === "apps_mate_publish").inputSchema.required, ["mateId", "releaseId", "confirm"]);
    assert.match(tools.find((tool) => tool.name === "apps_mate_core_review").description, /Soul, Handbook and mail\.md/);
    assert.equal(tools.find(tool=>tool.name==="apps_mate_core_update").inputSchema.properties.mail.maxLength,24000);
  });

  it("does not advertise removed aliases or internal package RPCs in tools/list", () => {
    const names = mcpTools().map((tool) => tool.name);

    for (const name of [
      "apps_apply_app_migration",
      "apps_deploy_app_source",
      "apps_deploy_pages",
      "apps_download_skill_package",
      "apps_get_skill_install_prompt",
      "apps_publish_production",
      "apps_publish_skill",
      "apps_publish_skill_private",
      "apps_update_skill",
      "apps_update_skill_private",
      "apps_validate_skill",
      "apps_validate_skill_package"
    ]) {
      assert.equal(names.includes(name), false);
    }
  });
});
