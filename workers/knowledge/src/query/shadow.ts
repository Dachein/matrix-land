import { safeErrorName } from "../errors.ts";
import { HttpError } from "../http.ts";
import { sha256Hex } from "../objects/content.ts";
import type { Env, Principal } from "../types.ts";
import { isRecord, readString } from "../values.ts";

export async function recordKnowledgeQueryShadow(
  env: Env,
  principal: Principal,
  serviceId: string,
  action: "grep" | "search",
  query: string,
  legacy: { results: unknown[] },
  readV2: () => Promise<{ results: Array<Record<string, unknown>> }>
) {
  const legacyPaths = knowledgeShadowPaths(legacy.results);
  let v2Paths: string[] = [];
  let status = "compared";
  let errorCode = "";
  try {
    const v2 = await readV2();
    v2Paths = knowledgeShadowPaths(v2.results);
  } catch (error) {
    status = "v2_error";
    errorCode = error instanceof HttpError ? error.code : safeErrorName(error);
  }
  const divergent = (
    status !== "compared"
    || legacyPaths.length !== v2Paths.length
    || legacyPaths.some((path, index) => path !== v2Paths[index])
  );
  const queryHash = await sha256Hex(new TextEncoder().encode(query));
  await env.KNOWLEDGE_DB
    .prepare(
      `INSERT INTO knowledge_shadow_query_reports (
         id, service_id, actor_user_id, action, query_hash, legacy_result_count,
         v2_result_count, legacy_paths_json, v2_paths_json, divergent,
         stale_leak_detected, status, error_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .bind(
      `kshadow_${crypto.randomUUID()}`,
      serviceId,
      principal.sub,
      action,
      queryHash,
      legacyPaths.length,
      v2Paths.length,
      JSON.stringify(legacyPaths),
      JSON.stringify(v2Paths),
      divergent ? 1 : 0,
      status,
      errorCode
    )
    .run();
  console.log("knowledge_query_shadow", {
    action,
    divergent,
    errorCode,
    legacyResultCount: legacyPaths.length,
    serviceId,
    status,
    v2ResultCount: v2Paths.length
  });
}

function knowledgeShadowPaths(results: unknown[]) {
  return [...new Set(
    results
      .filter(isRecord)
      .map((row) => readString(row.relativePath ?? row.path))
      .filter(Boolean)
  )].sort();
}
