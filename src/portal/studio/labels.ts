import type { AppSensitiveDataType, AppsAppStatus, AppsAppType, AppsVisibility } from "../../shared/types";
import type { AppsProvisionedResourceType } from "../../shared/appsResourceCatalog";
import type { TranslationKey } from "../i18n";
import type { AppsAccessMode } from "./types";

type TranslationValues = Record<string, number | string | undefined>;
type TFunction = (key: TranslationKey, values?: TranslationValues) => string;

const appTypeLabelKeys: Record<AppsAppType, TranslationKey> = {
  agent_app: "apps.create.appType.agent.label",
  automation: "apps.create.appType.automation.label",
  container: "apps.create.appType.container.label",
  static_page: "apps.create.appType.static.label",
  web: "apps.create.appType.web.label"
};

const appTypeDetailKeys: Record<AppsAppType, TranslationKey> = {
  agent_app: "apps.create.appType.agent.detail",
  automation: "apps.create.appType.automation.detail",
  container: "apps.create.appType.container.detail",
  static_page: "apps.create.appType.static.detail",
  web: "apps.create.appType.web.detail"
};

const accessModeLabelKeys: Record<AppsAccessMode, TranslationKey> = {
  company: "apps.create.access.company.label",
  private: "apps.create.access.private.label",
  public: "apps.create.access.public.label",
  targeted: "apps.create.access.targeted.label"
};

const accessModeDetailKeys: Record<AppsAccessMode, TranslationKey> = {
  company: "apps.create.access.company.detail",
  private: "apps.create.access.private.detail",
  public: "apps.create.access.public.detail",
  targeted: "apps.create.access.targeted.detail"
};

const appStatusKeys: Record<AppsAppStatus, TranslationKey> = {
  archived: "apps.status.app.archived",
  draft: "apps.status.app.draft",
  provisioning: "apps.status.app.provisioning",
  published: "apps.status.app.published"
};

const exactResourceKeys: Record<AppsProvisionedResourceType, { detail: TranslationKey; label: TranslationKey }> = {
  cron_trigger: {
    detail: "apps.resource.cron.detail",
    label: "apps.resource.cron.label"
  },
  d1_database: {
    detail: "apps.resource.d1.detail",
    label: "apps.resource.d1.label"
  },
  email_sending: {
    detail: "apps.resource.email.detail",
    label: "apps.resource.email.label"
  },
  email_routing: {
    detail: "apps.resource.emailRouting.detail",
    label: "apps.resource.emailRouting.label"
  },
  hyperdrive_config: {
    detail: "apps.resource.hyperdrive.detail",
    label: "apps.resource.hyperdrive.label"
  },
  kv_namespace: {
    detail: "apps.resource.kv.detail",
    label: "apps.resource.kv.label"
  },
  logs_audit: {
    detail: "apps.resource.logs.detail",
    label: "apps.resource.logs.label"
  },
  media: {
    detail: "apps.resource.media.detail",
    label: "apps.resource.media.label"
  },
  pages_function: {
    detail: "apps.resource.pagesFunction.detail",
    label: "apps.resource.pagesFunction.label"
  },
  pages_project: {
    detail: "apps.resource.pagesProject.detail",
    label: "apps.resource.pagesProject.label"
  },
  queue: {
    detail: "apps.resource.queue.detail",
    label: "apps.resource.queue.label"
  },
  r2_bucket: {
    detail: "apps.resource.r2.detail",
    label: "apps.resource.r2.label"
  },
  schema_registry: {
    detail: "apps.resource.schema.detail",
    label: "apps.resource.schema.label"
  },
  worker: {
    detail: "apps.resource.worker.detail",
    label: "apps.resource.worker.label"
  }
};

const resourceStatusKeys: Record<string, TranslationKey> = {
  active: "apps.resource.status.active",
  listed: "apps.resource.status.listed",
  pending: "apps.resource.status.pending",
  placeholder: "apps.resource.status.placeholder",
  private_current: "apps.resource.status.privateCurrent",
  published: "apps.resource.status.published",
  proxied: "apps.resource.status.proxied",
  queued: "apps.resource.status.pending",
  ready: "apps.resource.status.ready",
  registered: "apps.resource.status.registered",
  reserved: "apps.resource.status.reserved"
};

const sensitiveDataKeys: Record<AppSensitiveDataType, TranslationKey> = {
  customer_information: "apps.sensitive.customer",
  employee_information: "apps.sensitive.employee",
  financial_information: "apps.sensitive.financial",
  internal_materials: "apps.sensitive.internal",
  public_information: "apps.sensitive.public",
  transaction_records: "apps.sensitive.transactions"
};

export function appsAppTypeLabel(type: AppsAppType, t: TFunction) {
  return t(appTypeLabelKeys[type] ?? "apps.create.appType.web.label");
}

export function appsAppTypeDetail(type: AppsAppType, t: TFunction) {
  return t(appTypeDetailKeys[type] ?? "apps.create.appType.web.detail");
}

export function appsAccessModeLabel(mode: AppsAccessMode, t: TFunction) {
  return t(accessModeLabelKeys[mode] ?? "apps.create.access.company.label");
}

export function appsAccessModeDetail(mode: AppsAccessMode, t: TFunction) {
  return t(accessModeDetailKeys[mode] ?? "apps.create.access.company.detail");
}

export function appsBooleanLabel(value: "no" | "yes", t: TFunction) {
  return value === "yes" ? t("apps.create.yes") : t("apps.create.no");
}

export function appsAppStatusLabel(status: AppsAppStatus, t: TFunction) {
  return t(appStatusKeys[status] ?? "apps.status.app.draft");
}

export function appsMarketStatusLabel(status: string | undefined, t: TFunction) {
  if (!status) {
    return t("apps.status.market.notSubmitted");
  }

  const keys: Record<string, TranslationKey> = {
    deleted: "apps.status.market.deleted",
    delisted: "apps.status.market.delisted",
    listed: "apps.status.market.listed",
    pending_review: "apps.status.market.pendingReview"
  };

  return keys[status] ? t(keys[status]) : status;
}

export function appsSkillStatusLabel(status: string, t: TFunction) {
  return status === "private" ? t("apps.status.skill.private") : t("apps.status.skill.archived");
}

export function appsVisibilityLabel(value: string, t: TFunction) {
  const keys: Record<string, TranslationKey> = {
    company: "apps.visibility.company",
    org: "apps.visibility.org",
    private: "apps.visibility.private",
    public: "apps.visibility.public",
    team: "apps.visibility.team"
  };

  return keys[value] ? t(keys[value]) : value;
}

export function appsLoginLabel(required: boolean, t: TFunction) {
  return required ? t("apps.login.required") : t("apps.login.notRequired");
}

export function appsResourceLabel(type: string, t: TFunction) {
  const exactKey = exactResourceKeys[type as AppsProvisionedResourceType]?.label;
  if (exactKey) {
    return t(exactKey);
  }

  if (type.includes("pages_project")) {
    return t("apps.resource.hostingPages");
  }
  if (type.includes("pages_function")) {
    return t("apps.resource.functions");
  }
  if (type.includes("d1")) {
    return t("apps.resource.d1.label");
  }
  if (type.includes("r2")) {
    return t("apps.resource.r2.label");
  }
  if (type.includes("kv")) {
    return t("apps.resource.kv.label");
  }
  if (type.includes("email")) {
    return t("apps.resource.email.label");
  }
  if (type.includes("worker") || type.includes("deploy") || type.includes("static_assets")) {
    return t("apps.resource.workerDeploy");
  }
  if (type.includes("domain") || type.includes("route")) {
    return t("apps.resource.domain", { type: "" }).replace(/\(\s*\)$/, "").trim();
  }
  if (type.includes("auth")) {
    return t("apps.resource.auth");
  }
  if (type.includes("mcp")) {
    return t("apps.resource.mcp");
  }
  if (type.includes("cron")) {
    return t("apps.resource.cronFallback");
  }
  if (type.includes("queue")) {
    return t("apps.resource.queueFallback");
  }
  if (type.includes("logs")) {
    return t("apps.resource.auditLogs");
  }
  if (type.includes("vector")) {
    return t("apps.resource.vector");
  }
  if (type.includes("schema") || type.includes("migration")) {
    return t("apps.resource.schemaFallback");
  }
  if (type.includes("secret")) {
    return t("apps.resource.secret");
  }

  return type.replace(/_/g, " ");
}

export function appsResourceDetail(type: string, fallback: string, t: TFunction) {
  const exactKey = exactResourceKeys[type as AppsProvisionedResourceType]?.detail;
  return exactKey ? t(exactKey) : fallback;
}

export function appsResourceStatusLabel(status: string, environment: string | undefined, t: TFunction) {
  const label = resourceStatusKeys[status] ? t(resourceStatusKeys[status]) : status;
  return environment ? `${label} / ${appsEnvironmentLabel(environment, t)}` : label;
}

export function appsEnvironmentLabel(environment: string, t: TFunction) {
  return environment === "prod" || environment === "production" ? t("apps.environment.production") : environment;
}

export function appsDomainResourceLabel(type: string, t: TFunction) {
  return t("apps.resource.domain", { type: type === "production" ? "Production" : type.toUpperCase() });
}

export function appsRiskLabel(value: "high" | "low" | "medium", t: TFunction) {
  const keys: Record<typeof value, TranslationKey> = {
    high: "apps.publish.riskHigh",
    low: "apps.publish.riskLow",
    medium: "apps.publish.riskMedium"
  };

  return t(keys[value]);
}

export function appsSensitiveDataLabel(value: AppSensitiveDataType, t: TFunction) {
  return t(sensitiveDataKeys[value] ?? "apps.sensitive.public");
}

export function appsSkillGroupLabel(path: string, t: TFunction) {
  return path === "/" ? t("apps.skillStructure.root") : path;
}

export type { TFunction as AppsTFunction };
