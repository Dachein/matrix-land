import { HttpError } from "../http.ts";
import type { Env, KnowledgeServiceRow } from "../types.ts";
import { isRecord, readString, safeJsonArray, safeJsonRecord } from "../values.ts";

export function knowledgeServiceProfileFromBody(
  body: Record<string, unknown>,
  current?: KnowledgeServiceRow
) {
  const nested = isRecord(body.profile)
    ? body.profile
    : isRecord(body.info)
      ? body.info
      : isRecord(body.card)
        ? body.card
        : {};
  const profile = { ...body, ...nested };
  const rawCategory = Object.prototype.hasOwnProperty.call(profile, "category")
    ? readString(profile.category).trim().toLowerCase()
    : current?.category || "general";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(rawCategory)) {
    throw new HttpError(400, "knowledge_service_category_invalid");
  }
  const hasKeywords = Object.prototype.hasOwnProperty.call(profile, "keywords");
  const tags = Object.prototype.hasOwnProperty.call(profile, "tags") || hasKeywords
    ? knowledgeServiceStringList(profile.tags ?? profile.keywords, "knowledge_service_tags_invalid", 30, 64)
    : safeJsonArray(current?.tags_json ?? "[]");
  const languages = Object.prototype.hasOwnProperty.call(profile, "languages")
    ? knowledgeServiceStringList(profile.languages, "knowledge_service_languages_invalid", 12, 35)
    : safeJsonArray(current?.languages_json ?? "[]");
  const hasBestFor = Object.prototype.hasOwnProperty.call(profile, "bestFor")
    || Object.prototype.hasOwnProperty.call(profile, "best_for");
  const coverage = Object.prototype.hasOwnProperty.call(profile, "coverage") || hasBestFor
    ? knowledgeServiceProfileList(profile.coverage ?? profile.bestFor ?? profile.best_for, "knowledge_service_coverage_invalid", 30, 240)
    : safeJsonArray(current?.coverage_json ?? "[]");
  const hasNotFor = Object.prototype.hasOwnProperty.call(profile, "notFor")
    || Object.prototype.hasOwnProperty.call(profile, "not_for");
  const notFor = hasNotFor
    ? knowledgeServiceProfileList(
        profile.notFor ?? profile.not_for,
        "knowledge_service_not_for_invalid",
        30,
        240
      )
    : safeJsonArray(current?.not_for_json ?? "[]");
  const role = Object.prototype.hasOwnProperty.call(profile, "role")
    ? requireProfileText(profile.role, "knowledge_service_role_invalid", 500)
    : current?.role_text ?? "";
  const hasSearchHints = Object.prototype.hasOwnProperty.call(profile, "searchHints")
    || Object.prototype.hasOwnProperty.call(profile, "search_hints");
  const searchHints = hasSearchHints
    ? knowledgeServiceProfileList(
        profile.searchHints ?? profile.search_hints,
        "knowledge_service_search_hints_invalid",
        30,
        240
      )
    : safeJsonArray(current?.search_hints_json ?? "[]");
  const hasMaintenanceTeam = Object.prototype.hasOwnProperty.call(profile, "maintenanceTeam")
    || Object.prototype.hasOwnProperty.call(profile, "maintenance_team");
  const maintenanceTeam = hasMaintenanceTeam
    ? requireProfileText(
        profile.maintenanceTeam ?? profile.maintenance_team,
        "knowledge_service_maintenance_team_invalid",
        120
      )
    : current?.maintenance_team ?? "";
  const feedbackEnabled = true;
  const rawPolicy = profile.feedbackPolicy ?? profile.feedback_policy;
  const feedbackPolicy = rawPolicy === undefined
    ? safeJsonRecord(current?.feedback_policy_json ?? "{}")
    : isRecord(rawPolicy)
      ? rawPolicy
      : (() => {
          throw new HttpError(400, "knowledge_service_feedback_policy_invalid");
        })();
  if (JSON.stringify(feedbackPolicy).length > 4_000) {
    throw new HttpError(400, "knowledge_service_feedback_policy_too_large");
  }
  return {
    category: rawCategory,
    coverage,
    feedbackEnabled,
    feedbackPolicy,
    languages,
    maintenanceTeam,
    notFor,
    role,
    searchHints,
    tags
  };
}

export function requireProfileText(value: unknown, errorCode: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new HttpError(400, errorCode);
  }
  const text = value.trim();
  if (text.length > maxLength || /[\u0000-\u001f]/.test(text)) {
    throw new HttpError(400, errorCode);
  }
  return text;
}

function knowledgeServiceProfileList(
  value: unknown,
  errorCode: string,
  maxItems: number,
  maxItemLength: number
) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HttpError(400, errorCode);
  }
  const normalized = value
    .map((item) => requireProfileText(item, errorCode, maxItemLength))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function knowledgeServiceStringList(
  value: unknown,
  errorCode: string,
  maxItems: number,
  maxLength: number
) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HttpError(400, errorCode);
  }
  const normalized = value.map((item) => {
    if (typeof item !== "string") {
      throw new HttpError(400, errorCode);
    }
    const entry = item.trim();
    if (!entry || entry.length > maxLength || /[\u0000-\u001f]/.test(entry)) {
      throw new HttpError(400, errorCode);
    }
    return entry;
  });
  return [...new Set(normalized)];
}

export function knowledgeServiceProfileUpsertStatement(
  env: Env,
  serviceId: string,
  profile: ReturnType<typeof knowledgeServiceProfileFromBody>
) {
  return env.KNOWLEDGE_DB
    .prepare(
      `INSERT INTO knowledge_service_profiles (
         service_id, category, tags_json, languages_json,
         coverage_json, not_for_json, feedback_enabled, feedback_policy_json,
         maintenance_team
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(service_id) DO UPDATE SET
         category = excluded.category,
         tags_json = excluded.tags_json,
         languages_json = excluded.languages_json,
         coverage_json = excluded.coverage_json,
         not_for_json = excluded.not_for_json,
         feedback_enabled = excluded.feedback_enabled,
         feedback_policy_json = excluded.feedback_policy_json,
         maintenance_team = excluded.maintenance_team,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      serviceId,
      profile.category,
      JSON.stringify(profile.tags),
      JSON.stringify(profile.languages),
      JSON.stringify(profile.coverage),
      JSON.stringify(profile.notFor),
      profile.feedbackEnabled ? 1 : 0,
      JSON.stringify(profile.feedbackPolicy),
      profile.maintenanceTeam
    );
}

export function knowledgeServiceRoutingCardUpsertStatement(
  env: Env,
  serviceId: string,
  profile: ReturnType<typeof knowledgeServiceProfileFromBody>
) {
  return env.KNOWLEDGE_DB
    .prepare(
      `INSERT INTO knowledge_service_routing_cards (
         service_id, role_text, search_hints_json
       ) VALUES (?, ?, ?)
       ON CONFLICT(service_id) DO UPDATE SET
         role_text = excluded.role_text,
         search_hints_json = excluded.search_hints_json,
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(serviceId, profile.role, JSON.stringify(profile.searchHints));
}
