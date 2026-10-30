import type { TranslationKey } from "../i18n";
import { AppsApiError } from "./apiClient";

type Translate = (key: TranslationKey, values?: Record<string, number | string | undefined>) => string;

export function appsAccessUpdateErrorMessage(error: unknown, t: Translate) {
  const key = accessUpdateErrorKey(error);
  const message = t(key);
  if (!(error instanceof AppsApiError) || !error.requestId) {
    return message;
  }
  return `${message} ${t("apps.message.requestId", { requestId: error.requestId })}`;
}

function accessUpdateErrorKey(error: unknown): TranslationKey {
  if (!(error instanceof AppsApiError)) {
    return "apps.message.accessUpdateFailed";
  }

  if (["auth_app_sync_timeout", "apps_request_timeout", "apps_worker_timeout"].includes(error.code)) {
    return "apps.message.accessUpdateTimeout";
  }
  if (["auth_app_sync_unauthorized", "auth_worker_not_configured", "workspace_auth_app_secret_not_configured"].includes(error.code)) {
    return "apps.message.accessUpdateConfiguration";
  }
  if (["auth_app_sync_unavailable", "apps_worker_unavailable"].includes(error.code)) {
    return "apps.message.accessUpdateUnavailable";
  }
  return "apps.message.accessUpdateFailed";
}
