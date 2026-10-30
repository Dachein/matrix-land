import { installationHostname, installationAppHostPrefix, type PublicInstallationEndpoints } from "../../shared/installationDomains";
import { appStreamDevelopmentPrompt } from "../../shared/appsStreamGuidance";
import {
  APPS_CUSTOM_RESOURCE_TYPES,
  APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE,
  appsAppendableResourceTypes,
  isAppsAppMcpRequiredType,
  isAppsAppMcpSupportedType,
  isAppsCustomRuntimeResourceType,
  appsResourceDefinitions,
  type AppsProvisionedResourceDefinition,
  type AppsProvisionedResourceType
} from "../../shared/appsResourceCatalog";
import { isReservedAppsAppCode } from "../../shared/appsAppCode";
import { mateWorkEmail, type Mate } from "../../shared/mate";
import type { AppsApp, AppsAppType, PortalCatalog } from "../../shared/types";
import type { TranslationKey } from "../i18n";
import { buildAccessTargetTree, userTargetValue, type AccessTargetDepartment, type AccessTargetTreeNode, type AccessTargetUser } from "../lib/accessTargets";
import { appTypeCatalog, appsAccessTemplates } from "./constants";
import type { CreateInput, AppsAccessMode, AppsAccessTargetNode, AppsAppInfoInput } from "./types";

type TranslationValues = Record<string, number | string | undefined>;
type TFunction = (key: TranslationKey, values?: TranslationValues) => string;

type AppsAccessTargetLabels = {
  department: string;
  unassignedDepartment: string;
};

const defaultAccessTargetLabels: AppsAccessTargetLabels = {
  department: "Department",
  unassignedDepartment: "Unassigned department"
};

export function typeLabel(type: AppsAppType) {
  return appTypeCatalog.find((option) => option.value === type)?.label ?? type;
}

export function canOpenMateOwnerPreview(
  mate: Pick<Mate, "ownerUserId" | "previewReleaseId"> | undefined,
  currentUser: Pick<PortalCatalog["currentUser"], "email" | "id">
) {
  if (!mate?.previewReleaseId) return false;
  const owner = mate.ownerUserId.trim().toLowerCase();
  return owner === currentUser.id.trim().toLowerCase()
    || owner === currentUser.email.trim().toLowerCase();
}

export function nextCreateName(current: CreateInput, name: string): CreateInput {
  const currentGenerated = normalizeAppCode(current.name);
  const shouldUpdateCode = !current.appCode || current.appCode === currentGenerated;
  return {
    ...current,
    name,
    appCode: shouldUpdateCode ? normalizeAppCode(name) : current.appCode
  };
}

export function nextMateIdentityName<T extends { displayName: string; workEmail: string }>(current: T, displayName: string, editing = false, emailDomain?: string): T {
  if (editing) return { ...current, displayName };
  const domain = emailDomain ?? current.workEmail.split("@")[1];
  const generatedFromCurrentName = mateWorkEmail(current.displayName, domain);
  const shouldUpdateCode = !current.workEmail || current.workEmail === generatedFromCurrentName;
  return {
    ...current,
    displayName,
    workEmail: shouldUpdateCode ? mateWorkEmail(displayName, domain) : current.workEmail
  };
}

export function nextCreateTypeInput(current: CreateInput, type: AppsAppType): CreateInput {
  if (type === "static_page") {
    return {
      ...current,
      agentMcpEnabled: false,
      llmEnabled: false,
      resourceTypes: APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE.static_page,
      type
    };
  }

  if (type === "container") {
    return {
      ...current,
      agentMcpEnabled: false,
      resourceTypes: ["worker"],
      type
    };
  }

  return {
    ...current,
    agentMcpEnabled: type === "agent_app",
    loginRequired: current.loginRequired,
    llmEnabled: current.llmEnabled,
    resourceTypes: APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE[type],
    type
  };
}

export function resourceTypesForCreate(input: CreateInput): AppsProvisionedResourceType[] {
  if (input.type === "container") {
    const resourceTypes = new Set<AppsProvisionedResourceType>(input.resourceTypes);
    resourceTypes.add("worker");
    if (input.agentMcpEnabled) {
      resourceTypes.add("schema_registry");
    }
    return Array.from(resourceTypes);
  }

  const allowed = new Set(appsAppendableResourceTypes(input.type));
  const resourceTypes = new Set<AppsProvisionedResourceType>(
    APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE[input.type] ?? APPS_FIXED_RESOURCE_TYPES_BY_APP_TYPE.web
  );
  input.resourceTypes.filter((type) => allowed.has(type)).forEach((type) => resourceTypes.add(type));
  if (input.agentMcpEnabled && isAppsAppMcpSupportedType(input.type)) {
    resourceTypes.add("schema_registry");
  }
  return Array.from(resourceTypes);
}

export function customRuntimeResourceTypesForCreate(input: CreateInput): AppsProvisionedResourceType[] {
  return resourceTypesForCreate(input).filter((type) => isAppsCustomRuntimeResourceType(type));
}

export function createResourcePreviewItems(input: CreateInput): AppsProvisionedResourceDefinition[] {
  return appsResourceDefinitions(resourceTypesForCreate(input));
}

export function toggleCustomResourceType(current: CreateInput, resourceType: AppsProvisionedResourceType): CreateInput {
  if (current.type === "container" && !(APPS_CUSTOM_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
    return current;
  }

  if (current.type === "container" && resourceType === "worker") {
    return current;
  }

  if (current.type === "container" && current.agentMcpEnabled && resourceType === "schema_registry") {
    return current;
  }

  const selected = new Set(current.resourceTypes);

  if (isAppsCustomRuntimeResourceType(resourceType)) {
    const nextSelected = selected.has(resourceType)
      ? new Set(current.resourceTypes.filter((type) => type !== resourceType))
      : new Set([
        ...current.resourceTypes.filter((type) => !isAppsCustomRuntimeResourceType(type)),
        resourceType
      ]);

    return {
      ...current,
      resourceTypes: Array.from(nextSelected)
    };
  }

  if (selected.has(resourceType)) {
    selected.delete(resourceType);
  } else {
    selected.add(resourceType);
  }

  return {
    ...current,
    resourceTypes: Array.from(selected)
  };
}

export function nextAgentMcpInput(current: CreateInput, enabled: boolean): CreateInput {
  if (!isAppsAppMcpSupportedType(current.type)) {
    return {
      ...current,
      agentMcpEnabled: false
    };
  }

  if (isAppsAppMcpRequiredType(current.type)) {
    return {
      ...current,
      agentMcpEnabled: true
    };
  }

  const selected = new Set(current.resourceTypes);
  if (enabled) {
    selected.add("schema_registry");
  } else {
    selected.delete("schema_registry");
  }

  return {
    ...current,
    agentMcpEnabled: enabled,
    resourceTypes: Array.from(selected)
  };
}

export function appsAccessTemplate(mode: AppsAccessMode) {
  return appsAccessTemplates.find((template) => template.value === mode) ?? appsAccessTemplates[1];
}

export function nextAccessModeInput(current: CreateInput, accessMode: AppsAccessMode, catalog: PortalCatalog): CreateInput {
  return {
    ...current,
    accessMode,
    accessTargets: accessMode === "private" ? privateAccessTargets(catalog) : accessMode === "targeted" ? current.accessTargets : []
  };
}

export function nextLoginRequiredInput(current: CreateInput, loginRequired: boolean): CreateInput {
  return {
    ...current,
    accessMode: loginRequired
      ? current.accessMode === "public" ? "private" : current.accessMode
      : "public",
    accessTargets: loginRequired && current.accessMode === "targeted" ? current.accessTargets : [],
    loginRequired
  };
}

export function toggleCreateAccessTarget(current: CreateInput, target: string): CreateInput {
  const targets = new Set(current.accessTargets);

  if (targets.has(target)) {
    targets.delete(target);
  } else {
    targets.add(target);
  }

  return {
    ...current,
    accessTargets: Array.from(targets)
  };
}

export function createAccessTargets(input: CreateInput, catalog: PortalCatalog) {
  if (input.accessMode === "private") {
    return privateAccessTargets(catalog);
  }

  return input.accessMode === "targeted" ? input.accessTargets : [];
}

export function privateAccessTargets(catalog: PortalCatalog) {
  return [userTargetValue(catalog.currentUser.id)];
}

export function appsAccessTargetTree(
  catalog: PortalCatalog,
  labels: AppsAccessTargetLabels = defaultAccessTargetLabels,
  accessTargetUsers?: AccessTargetUser[],
  departments?: AccessTargetDepartment[]
): AppsAccessTargetNode[] {
  const users = accessTargetUsers !== undefined
    ? accessTargetUsers
    : [{
      id: catalog.currentUser.id,
      name: catalog.currentUser.name,
      email: catalog.currentUser.email,
      team: catalog.currentUser.team,
      department: catalog.currentUser.department,
      departmentId: catalog.currentUser.departmentId,
      departmentPath: catalog.currentUser.departmentPath
    }];
  const tree = buildAccessTargetTree(users, catalog.portal.name || "Workspace", departments);

  return [
    ...tree.users.map((user): AppsAccessTargetNode => ({
      detail: user.email, label: user.name || user.email,
      searchText: `${user.name || ""} ${user.email}`, tagDetail: labels.unassignedDepartment,
      type: "user", value: userTargetValue(user.id)
    })),
    ...tree.children.map((node) => appsAccessTargetNodeFromDepartment(node, labels))
  ];
}

function appsAccessTargetNodeFromDepartment(node: AccessTargetTreeNode, labels: AppsAccessTargetLabels): AppsAccessTargetNode {
  return {
    children: [
      ...node.users.map((user) => ({
        detail: user.email,
        label: user.name || user.email,
        searchText: `${user.name || ""} ${user.email || ""} ${node.pathLabel}`.trim(),
        tagDetail: leafDepartmentLabel(node.pathLabel, labels),
        type: "user" as const,
        value: userTargetValue(user.id)
      })),
      ...node.children.map((child) => appsAccessTargetNodeFromDepartment(child, labels))
    ],
    detail: labels.department,
    label: node.label,
    tagDetail: node.pathLabel,
    searchText: node.searchText,
    type: "department",
    value: node.value
  };
}

function leafDepartmentLabel(pathLabel: string, labels: AppsAccessTargetLabels) {
  const parts = pathLabel.split(" / ").map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] || labels.unassignedDepartment;
}

export function filterAppsAccessTargetNodes(nodes: AppsAccessTargetNode[], query: string): AppsAccessTargetNode[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return nodes;
  }

  return nodes.reduce<AppsAccessTargetNode[]>((filtered, node) => {
    const children = filterAppsAccessTargetNodes(node.children ?? [], normalizedQuery);

    if (appsAccessTargetNodeMatches(node, normalizedQuery) || children.length > 0) {
      filtered.push({ ...node, children });
    }

    return filtered;
  }, []);
}

function appsAccessTargetNodeMatches(node: AppsAccessTargetNode, query: string) {
  return [node.label, node.detail, node.searchText, node.value]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

export function appCodeDomainPreview(appCode: string, endpoints: PublicInstallationEndpoints = {}) {
  if (!endpoints.appBaseDomain) return "";
  const code = normalizeAppCode(appCode) || "appcode";
  return `https://${installationAppHostPrefix(endpoints.appHostPrefix ?? "")}${code}.${installationHostname(endpoints.appBaseDomain)}`;
}

export function appAgentHandoffClipboardText(app: AppsApp, handoffUrl: string, expiresAt: number | undefined, t: TFunction, mailDevelopmentPrompt?: string) {
  const ttlMinutes = handoffLinkTtlMinutes(expiresAt);
  const ttlText = expiresAt ? t("apps.handoff.ttlText", { minutes: ttlMinutes }) : "";
  return [
    t("apps.handoff.clipboardIntro"),
    t("apps.handoff.clipboardApp", { appId: app.id, name: app.name }),
    t("apps.handoff.clipboardMcp", { appId: app.id }),
    t("apps.handoff.clipboardFallback"),
    t("apps.handoff.clipboardUrl", { ttl: ttlText, url: handoffUrl }),
    mailDevelopmentPrompt,
    app.resources?.some(resource => resource.type === "media") ? appStreamDevelopmentPrompt(app.id) : undefined
  ].filter(Boolean).join("\n\n");
}

export function appAgentSourceCollaborationClipboardText(app: AppsApp, handoffUrl: string, expiresAt: number | undefined, t: TFunction) {
  const latestPublished = [...app.deployments]
    .filter((deployment) => deployment.status.toLowerCase() === "published")
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];

  return [
    appAgentHandoffClipboardText(app, handoffUrl, expiresAt, t),
    t("apps.handoff.collaborationIntro"),
    t("apps.handoff.collaborationAppInfo", {
      appCode: app.appCode || app.slug,
      appId: app.id,
      name: app.name,
      productionUrl: app.productionUrl || "-"
    }),
    t("apps.handoff.collaborationPublishedInfo", {
      snapshotId: latestPublished?.sourceSnapshotId || "-",
      version: latestPublished?.version || "-"
    }),
    t("apps.handoff.collaborationDownload", { appId: app.id }),
    t("apps.handoff.collaborationFolder"),
    t("apps.handoff.collaborationVerify"),
    t("apps.handoff.collaborationGuard")
  ].join("\n\n");
}

export function appAgentHandoffCopyNotice(expiresAt: number | undefined, t: TFunction) {
  const ttlMinutes = handoffLinkTtlMinutes(expiresAt);
  const expiresText = expiresAt ? t("apps.handoff.noticeExpires", { minutes: ttlMinutes }) : "";
  return t("apps.handoff.copyNotice", { expires: expiresText });
}

export function appAgentSourceCollaborationCopyNotice(expiresAt: number | undefined, t: TFunction) {
  const ttlMinutes = handoffLinkTtlMinutes(expiresAt);
  const expiresText = expiresAt ? t("apps.handoff.noticeExpires", { minutes: ttlMinutes }) : "";
  return t("apps.handoff.collaborationCopyNotice", { expires: expiresText });
}

export function handoffLinkTtlMinutes(expiresAt: number | undefined) {
  if (!expiresAt) {
    return 0;
  }

  return Math.max(1, Math.ceil((expiresAt * 1000 - Date.now()) / 60000));
}

export function isValidAppCode(value: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) && !isReservedAppsAppCode(value);
}

export function isReservedAppCode(value: string) {
  return isReservedAppsAppCode(normalizeAppCode(value));
}

export function appsAppInfoUpdatePayload(input: AppsAppInfoInput) {
  return {
    description: input.note,
    name: input.name.trim()
  };
}

export function normalizeAppCode(value: string) {
  return slugify(value).slice(0, 63);
}

export function normalizeSecretNameForUi(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function parseCommaList(value: string) {
  return value
    .split(/[,\n，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through for browsers or embedded contexts that deny Clipboard API access.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("clipboard_copy_failed");
    }
  } finally {
    textarea.remove();
  }
}
