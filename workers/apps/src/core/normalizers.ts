import type {
  AppsAppSecretEnvironment,
  AppsAppSecretStatus,
  AppsAppStatus,
  AppsAppType,
  AppsProvisioningJob,
  AppsProvisioningStatus,
  AppsProvisioningStepStatus,
  AppsSkillKind,
  AppsSkillVersion,
  AppsVisibility
} from "../../../../src/shared/types";
import { HttpError } from "./types";
import { readString, slugify } from "./utils";

export function normalizeSkillKind(value: unknown): AppsSkillKind {
  return readString(value) === "app" ? "app" : "vanilla";
}

export function normalizeSkillVersionState(value: unknown): AppsSkillVersion["state"] {
  const state = readString(value);
  if (
    state === "private_superseded" ||
    state === "submitted_for_market" ||
    state === "listed" ||
    state === "rejected" ||
    state === "archived"
  ) {
    return state;
  }
  return "private_current";
}

export function normalizeCapabilities(value: unknown) {
  const values = Array.isArray(value) ? value : readString(value).split(",");
  const normalized = values
    .map((item) => slugify(item).slice(0, 40))
    .filter(Boolean);

  return [...new Set(normalized)].slice(0, 24);
}

export function normalizeSkillVersion(value: unknown) {
  const version = readString(value).trim();
  return /^\d+\.\d+\.\d+([-.][A-Za-z0-9.]+)?$/.test(version) ? version.slice(0, 40) : "1.0.0";
}

export function normalizeSecretName(value: unknown) {
  const name = readString(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!/^[_A-Z][A-Z0-9_]{1,79}$/.test(name)) {
    throw new HttpError(400, "invalid_secret_name");
  }

  return name;
}

export function normalizeSecretEnvironment(_value: unknown): AppsAppSecretEnvironment {
  return "production";
}

export function normalizeSecretStatus(value: unknown): AppsAppSecretStatus {
  return readString(value) === "configured" ? "configured" : "declared";
}

export function normalizeAppType(value: unknown): AppsAppType {
  return isSupportedAppType(value) ? value : "web";
}

export function isSupportedAppType(value: unknown): value is AppsAppType {
  return value === "static_page" || value === "web" || value === "agent_app" || value === "automation" || value === "container";
}

export function normalizeStatus(value: unknown): AppsAppStatus {
  const status = readString(value);
  if (status === "draft" || status === "provisioning" || status === "published" || status === "archived") {
    return status;
  }
  return "draft";
}

export function normalizeVisibility(value: unknown, fallback: AppsVisibility): AppsVisibility {
  const visibility = readString(value);
  if (visibility === "private" || visibility === "team" || visibility === "org" || visibility === "public") {
    return visibility;
  }
  return fallback;
}

export function normalizeProvisioningType(value: unknown): AppsProvisioningJob["type"] {
  const type = readString(value);
  if (type === "publish_production") {
    return type;
  }
  return "create_app";
}

export function normalizeProvisioningStatus(value: unknown): AppsProvisioningStatus {
  const status = readString(value);
  if (status === "running" || status === "ready" || status === "failed" || status === "cancelled") {
    return status;
  }
  return "queued";
}

export function normalizeProvisioningStepStatus(value: unknown): AppsProvisioningStepStatus {
  const status = readString(value);
  if (status === "running" || status === "ready" || status === "failed" || status === "skipped") {
    return status;
  }
  return "queued";
}
