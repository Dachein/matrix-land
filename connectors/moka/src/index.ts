import {
  mokaConfigurationStatus,
  queryMokaDirectoryDepartments,
  queryMokaDirectoryEmployees,
  queryMokaDepartments,
  queryMokaEmployeeByOfficeEmail,
  queryMokaEmployeeById,
  queryMokaEmployees
} from "./moka.ts";
import { HttpError, type Env, type MokaDirectoryEvent } from "./types.ts";
import { isEmailAllowedByPolicy, readAuthEmailPolicy } from "../../../src/shared/authEmailPolicy.ts";

const WEBHOOK_PATH = "/webhooks/v1/events";

const mokaConnectorWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = request.headers.get("Idempotency-Key")
      ?? request.headers.get("x-request-id")
      ?? crypto.randomUUID();

    try {
      const url = new URL(request.url);
      const isRead = request.method === "GET" || request.method === "HEAD";
      const publicHost = env.MOKA_PUBLIC_HOST?.trim() || "moka-connector.example.invalid";
      const isPublicRequest = url.hostname === publicHost;

      if (isPublicRequest) {
        if ((request.method === "GET" || request.method === "POST") && url.pathname === WEBHOOK_PATH) {
          return await acceptMokaWebhook(request, env);
        }
        if (isRead && url.pathname === "/health") {
          return json({ ok: true, service: "workspace-moka-connector-worker" });
        }
        return json({ error: "not_found", requestId }, { status: 404 });
      }

      if (isRead && url.pathname === "/health") {
        return json({ ok: true, service: "workspace-moka-connector-worker", requestId });
      }

      requireServiceToken(request, env);

      if (isRead && url.pathname === "/v1/status") {
        return json({ connector: "moka", moka: mokaConfigurationStatus(env), requestId }, {
          headers: { "Cache-Control": "no-store" }
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/departments/query") {
        const result = await queryMokaDepartments(env, await readJson(request));
        return json({ ...result, connector: "moka", requestId, source: "moka" }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/employees/query") {
        const result = await queryMokaEmployees(env, await readJson(request));
        return json({ ...result, connector: "moka", requestId, source: "moka" }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/employees/by-email") {
        const body = await readJson(request);
        const employee = await queryMokaEmployeeByOfficeEmail(env, body.email);
        if (!await isMokaEmployeeEmailAllowed(env, employee.email)) throw new HttpError(404, "moka_employee_not_found");
        return json({ connector: "moka", employee, requestId, source: "moka" }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/employees/by-id") {
        const body = await readJson(request);
        const employee = await queryMokaEmployeeById(env, body.employeeId ?? body.externalId);
        if (!await isMokaEmployeeEmailAllowed(env, employee.email)) {
          return json({ connector: "moka", filtered: true, requestId, source: "moka" }, {
            headers: { "Cache-Control": "private, no-store" }
          });
        }
        return json({ connector: "moka", employee, requestId, source: "moka" }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/directory/departments") {
        const departments = await queryMokaDirectoryDepartments(env);
        return json({ connector: "moka", departments, requestId, source: "moka" }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/directory/employees") {
        const sourceEmployees = await queryMokaDirectoryEmployees(env);
        const employees = await filterMokaEmployeesByPolicy(env, sourceEmployees);
        return json({
          connector: "moka",
          employees: employees.eligible,
          filteredCount: employees.filteredCount,
          requestId,
          source: "moka"
        }, {
          headers: { "Cache-Control": "private, no-store" }
        });
      }

      return json({ error: "not_found", requestId }, { status: 404 });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }
};

async function isMokaEmployeeEmailAllowed(env: Env, email: unknown) {
  const policy = await readConnectorEmailPolicy(env);
  return isEmailAllowedByPolicy(policy, email);
}

async function filterMokaEmployeesByPolicy(env: Env, employees: Array<{ email: string; active: boolean }>) {
  const policy = await readConnectorEmailPolicy(env);
  const eligible = employees.filter((employee) => (employee.active && !employee.email.trim()) || isEmailAllowedByPolicy(policy, employee.email));
  return { eligible, filteredCount: employees.length - eligible.length };
}

async function readConnectorEmailPolicy(env: Env) {
  if (!env.AUTH_DB) throw new HttpError(503, "auth_email_policy_database_not_configured");
  try {
    return await readAuthEmailPolicy(env.AUTH_DB);
  } catch {
    throw new HttpError(503, "auth_email_policy_unavailable");
  }
}

export default mokaConnectorWorker;

async function acceptMokaWebhook(request: Request, env: Env) {
  if (!env.MOKA_DIRECTORY_EVENTS) throw new HttpError(503, "moka_webhook_queue_not_configured");
  const secret = env.MOKA_WEBHOOK_SECRET?.trim();
  if (!secret) throw new HttpError(503, "moka_webhook_secret_not_configured");
  const payload = await readWebhookPayload(request);
  const suppliedSecret = webhookText(payload.pwd, 4096);
  if (!safeEqual(suppliedSecret, secret)) throw new HttpError(401, "invalid_moka_webhook_secret");

  const sourceType = webhookText(payload.sourceType, 8);
  const entityType = sourceType === "1" ? "employee" : sourceType === "2" ? "department" : undefined;
  if (!entityType) throw new HttpError(400, "invalid_moka_webhook_source_type");
  const apiCode = webhookText(payload.apiCode, 180);
  const expectedApiCode = entityType === "employee"
    ? env.MOKA_EMPLOYEE_API_CODE?.trim()
    : env.MOKA_DEPARTMENT_API_CODE?.trim();
  if (!expectedApiCode || !safeEqual(apiCode, expectedApiCode)) {
    throw new HttpError(401, "invalid_moka_webhook_api_code");
  }

  const modifyType = webhookText(payload.modifyType, 8);
  const action = modifyType === "1" ? "create" : modifyType === "2" ? "deactivate" : modifyType === "3" ? "update" : undefined;
  if (!action) throw new HttpError(400, "invalid_moka_webhook_modify_type");
  const sourceId = positiveIdentifier(entityType === "employee" ? payload.employeeId : payload.nodeUid);
  const occurredAt = webhookText(payload.ts, 80) || undefined;
  // Moka's People callbacks do not include a requestUniqueKey. Prefer an
  // upstream event id when a tenant provides one; otherwise derive a stable
  // key from the employee callback's timestamp. Organization callbacks may
  // omit ts, so give those deliveries a new id—the queued event itself keeps
  // that id across Cloudflare retries and the sync operation is idempotent.
  const eventKey = webhookText(payload.requestUniqueKey ?? payload.id, 240)
    || (occurredAt ? `${sourceType}:${modifyType}:${sourceId}:${occurredAt}` : crypto.randomUUID());

  const event: MokaDirectoryEvent = {
    action,
    apiCode,
    entityType,
    eventKey,
    occurredAt,
    receivedAt: new Date().toISOString(),
    sourceId,
    sourceType: sourceType as "1" | "2"
  };
  await env.MOKA_DIRECTORY_EVENTS.send(event, { contentType: "json" });
  return json({ code: "200", msg: "success", data: "" }, {
    headers: { "Cache-Control": "no-store" }
  });
}

async function readWebhookPayload(request: Request) {
  const url = new URL(request.url);
  const payload: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());
  if (request.method !== "POST") return payload;
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_moka_webhook_body");
    return { ...payload, ...(body as Record<string, unknown>) };
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return { ...payload, ...Object.fromEntries(new URLSearchParams(await request.text()).entries()) };
  }
  return payload;
}

function webhookText(value: unknown, maxLength: number) {
  const text = String(value ?? "").trim();
  return text.length <= maxLength ? text : "";
}

function positiveIdentifier(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || Number(text) <= 0) throw new HttpError(400, "invalid_moka_webhook_source_id");
  return text;
}

function requireServiceToken(request: Request, env: Env) {
  const configured = env.MOKA_CONNECTOR_SERVICE_TOKEN?.trim();
  if (!configured) {
    throw new HttpError(503, "moka_connector_service_token_not_configured");
  }
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (!safeEqual(supplied, configured)) {
    throw new HttpError(401, "invalid_moka_connector_service_token");
  }
}

async function readJson(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new HttpError(415, "json_required");
  }
  const value = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "json_object_required");
  }
  return value as Record<string, unknown>;
}

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorResponse(error: unknown, requestId: string) {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message, requestId }, { status: error.status });
  }
  return json({ error: "moka_connector_error", message: "Moka connector request failed", requestId }, { status: 500 });
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
