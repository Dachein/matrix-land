import type { AppsAppType } from "../../../../src/shared/types";
import { isReservedAppsAppCode } from "../../../../src/shared/appsAppCode";
import {
  APPS_CUSTOM_RESOURCE_TYPES,
  APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE,
  APPS_RESOURCE_CATALOG,
  isAppsAppMcpSupportedType,
  isAppsCustomRuntimeResourceType,
  appsResourceDefinition,
  type AppsProvisionedResourceDefinition
} from "../../../../src/shared/appsResourceCatalog";
import { HttpError } from "../core/types";
import { normalizeAppCode, randomToken, readString } from "../core/utils";

type ResourceTemplate = {
  bindingName?: string;
  environment: "prod" | "shared";
  nameToken: string;
  provider: string;
  status?: string;
  type: string;
};

const NON_CONTAINER_OPTIONAL_RESOURCE_TYPES = new Set(["kv_namespace", "r2_bucket"]);

export function selectedResourceTemplates(
  type: AppsAppType,
  selectedTypes?: unknown,
  agentMcpEnabled = false
): ResourceTemplate[] {
  if (type !== "container") {
    const templates = resourceTemplates(type);
    const selected = new Set(Array.isArray(selectedTypes)
      ? selectedTypes.map((value) => readString(value).trim()).filter(Boolean)
      : []);
    const allowed = new Set([
      ...templates.map((template) => template.type),
      ...(isAppsAppMcpSupportedType(type) ? NON_CONTAINER_OPTIONAL_RESOURCE_TYPES : []),
      ...(type !== "static_page" ? ["media"] : []),
      ...(isAppsAppMcpSupportedType(type) ? ["schema_registry"] : [])
    ]);
    const unknown = Array.from(selected).filter((resourceType) => !allowed.has(resourceType));
    if (unknown.length > 0) {
      throw new HttpError(400, "invalid_resource_selection");
    }

    const effective = new Set(templates.map((template) => template.type));
    for (const resourceType of selected) {
      effective.add(resourceType);
    }
    if (agentMcpEnabled && isAppsAppMcpSupportedType(type)) {
      effective.add("schema_registry");
    }

    return Array.from(effective).map((resourceType) => {
      const definition = appsResourceDefinition(resourceType);
      if (!definition) {
        throw new HttpError(400, "invalid_resource_selection");
      }
      return resourceTemplateFromDefinition(definition);
    });
  }

  const selected = new Set(Array.isArray(selectedTypes)
    ? selectedTypes.map((value) => readString(value).trim()).filter(Boolean)
    : []);
  selected.add("worker");
  if (agentMcpEnabled) {
    selected.add("schema_registry");
  }

  const allowed = new Set<string>(APPS_CUSTOM_RESOURCE_TYPES);
  const unknown = Array.from(selected).filter((resourceType) => !allowed.has(resourceType));
  if (unknown.length > 0) {
    throw new HttpError(400, "invalid_resource_selection");
  }

  const runtimeTypes = Array.from(selected).filter((resourceType) => isAppsCustomRuntimeResourceType(resourceType));
  if (runtimeTypes.length !== 1) {
    throw new HttpError(400, "missing_runtime_resource");
  }

  return APPS_CUSTOM_RESOURCE_TYPES
    .filter((resourceType) => selected.has(resourceType))
    .map((resourceType) => resourceTemplateFromDefinition(APPS_RESOURCE_CATALOG[resourceType]));
}

export async function uniqueAppCode(
  db: D1Database,
  orgId: string,
  value: string,
  currentAppId?: string,
  globallyUnique = false
) {
  const base = normalizeAppCode(value);
  if (!base) {
    throw new HttpError(400, "missing_app_code");
  }
  if (isReservedAppsAppCode(base)) {
    throw new HttpError(400, "reserved_app_code");
  }
  const candidate = base.slice(0, 72);
  const existing = await db
    .prepare(
      `
      SELECT id
      FROM apps_apps
      WHERE (? = 1 OR org_id = ?)
        AND (code = ? OR slug = ?)
        AND (? IS NULL OR id != ?)
      LIMIT 1
      `
    )
    .bind(globallyUnique ? 1 : 0, orgId, candidate, candidate, currentAppId ?? null, currentAppId ?? null)
    .first<{ id: string }>();

  return existing ? `${candidate}-${randomToken(6)}` : candidate;
}

export function resourceName(appSlug: string, resourceType: string) {
  const appCode = normalizeAppCode(appSlug) || "app";
  const token = normalizeAppCode(resourceType) || "resource";
  return `apps-${appCode}-${token}`.replace(/-+/g, "-").slice(0, 96);
}

function resourceTemplates(type: AppsAppType): ResourceTemplate[] {
  const resourceTypes = APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE[type] ?? APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE.web;
  return resourceTypes.map((resourceType) => resourceTemplateFromDefinition(APPS_RESOURCE_CATALOG[resourceType]));
}

function resourceTemplateFromDefinition(definition: AppsProvisionedResourceDefinition): ResourceTemplate {
  return {
    bindingName: definition.bindingName,
    environment: definition.environment,
    nameToken: definition.nameToken,
    provider: definition.provider,
    status: definition.type === "cron_trigger" || definition.type === "hyperdrive_config" ? "placeholder" : undefined,
    type: definition.type
  };
}
