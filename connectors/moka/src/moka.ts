import { createSign } from "node:crypto";

import { HttpError, type Env } from "./types.ts";

const DEFAULT_MOKA_BASE_URL = "https://api.mokahr.com/api-platform/hcm/oapi";
const DEPARTMENT_PATH = "/v1/org/department/batchData";
const EMPLOYEE_PATH = "/v1/batch/data";
const MAX_PAGE_SIZE = 200;
const MAX_FILTER_ITEMS = 2000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type MokaEnvelope<T = Record<string, unknown>> = {
  code?: number | string;
  data?: T;
  msg?: string;
};

export type MokaDepartmentQuery = {
  haveUsed?: number | string;
  nodeCodeList?: unknown;
  nodeUidList?: unknown;
  pageNum?: number;
  pageSize?: number;
};

export type MokaEmployeeQuery = {
  employeeNoList?: unknown;
  endDate?: string;
  idNoList?: unknown;
  officeEmailList?: unknown;
  pageNum?: number;
  pageSize?: number;
  startDate?: string;
  telephoneList?: unknown;
  uuidList?: unknown;
};

export type MokaDirectoryEmployee = {
  active: boolean;
  department?: string;
  departmentExternalId?: string;
  duty?: string;
  email: string;
  employeeNo?: string;
  employmentStatus?: string;
  employmentStatusId?: number;
  externalId: string;
  jobTitle?: string;
  name?: string;
  path: string[];
  position?: string;
  source: "moka";
};

export type MokaDirectoryDepartment = {
  active: boolean;
  code?: string;
  externalId: string;
  name: string;
  parentExternalId?: string;
  path: string[];
  source: "moka";
};

type MokaRequestDependencies = {
  fetcher?: typeof fetch;
  nonce?: () => string;
  now?: () => number;
};

export function mokaConfigurationStatus(env: Env) {
  const required = [
    "MOKA_API_KEY",
    "MOKA_DEPARTMENT_API_CODE",
    "MOKA_EMPLOYEE_API_CODE",
    "MOKA_ENT_CODE",
    "MOKA_PRIVATE_KEY",
    "MOKA_USER_NAME"
  ] as const;
  const missing = required.filter((name) => !env[name]?.trim());

  return {
    baseUrl: configuredBaseUrl(env).href.replace(/\/$/, ""),
    configured: missing.length === 0,
    enabled: env.MOKA_ENABLED === "1",
    missing
  };
}

export async function queryMokaDepartments(
  env: Env,
  input: MokaDepartmentQuery = {},
  dependencies: MokaRequestDependencies = {}
) {
  requireMokaEnabled(env);
  const nodeUidList = numberList(input.nodeUidList, 200, "invalid_moka_department_ids");
  const nodeCodeList = stringList(input.nodeCodeList, 200, 180, "invalid_moka_department_codes");
  if (nodeUidList.length > 0 && nodeCodeList.length > 0) {
    throw new HttpError(400, "moka_department_filter_conflict");
  }

  const haveUsed = optionalEnumNumber(input.haveUsed, [0, 1], "invalid_moka_department_status");
  return requestMoka(env, {
    apiCode: requiredMokaConfig(env, "MOKA_DEPARTMENT_API_CODE"),
    body: {
      pageSize: pageSize(input.pageSize),
      pageNum: pageNumber(input.pageNum),
      nodeUidList,
      nodeCodeList,
      ...(haveUsed === undefined ? {} : { haveUsed })
    },
    path: DEPARTMENT_PATH
  }, dependencies);
}

export async function queryMokaEmployees(
  env: Env,
  input: MokaEmployeeQuery = {},
  dependencies: MokaRequestDependencies = {}
) {
  requireMokaEnabled(env);
  return requestMoka(env, {
    apiCode: requiredMokaConfig(env, "MOKA_EMPLOYEE_API_CODE"),
    body: {
      pageSize: pageSize(input.pageSize),
      pageNum: pageNumber(input.pageNum),
      uuidList: numberList(input.uuidList, MAX_FILTER_ITEMS, "invalid_moka_employee_ids"),
      employeeNoList: stringList(input.employeeNoList, MAX_FILTER_ITEMS, 180, "invalid_moka_employee_numbers"),
      officeEmailList: stringList(input.officeEmailList, MAX_FILTER_ITEMS, 320, "invalid_moka_employee_emails"),
      telephoneList: stringList(input.telephoneList, MAX_FILTER_ITEMS, 80, "invalid_moka_employee_telephones"),
      idNoList: stringList(input.idNoList, MAX_FILTER_ITEMS, 180, "invalid_moka_employee_id_numbers"),
      ...(optionalText(input.startDate, 40) ? { startDate: optionalText(input.startDate, 40) } : {}),
      ...(optionalText(input.endDate, 40) ? { endDate: optionalText(input.endDate, 40) } : {})
    },
    path: EMPLOYEE_PATH,
    userName: requiredMokaConfig(env, "MOKA_USER_NAME")
  }, dependencies);
}

/**
 * Resolve one Moka employee using the work email as the only identity key.
 * The private response carries the upstream identifier only as a source link.
 * Workspace sessions and permission tables continue to use internal ids.
 */
export async function queryMokaEmployeeByOfficeEmail(
  env: Env,
  email: unknown,
  dependencies: MokaRequestDependencies = {}
): Promise<MokaDirectoryEmployee> {
  const normalizedEmail = officeEmail(email);
  const response = await queryMokaEmployees(env, {
    officeEmailList: [normalizedEmail],
    pageNum: 1,
    pageSize: MAX_PAGE_SIZE
  }, dependencies);
  const records = Array.isArray(response.data?.list)
    ? response.data.list.filter(isRecord)
    : [];
  const exactMatches = records.filter((record) => normalizedOfficeEmail(record.office_email) === normalizedEmail);

  if (exactMatches.length === 0) {
    throw new HttpError(404, "moka_employee_not_found");
  }
  if (exactMatches.length > 1) {
    throw new HttpError(409, "moka_employee_email_conflict");
  }

  return directoryEmployeeFromMoka(exactMatches[0], normalizedEmail);
}

export async function queryMokaEmployeeById(
  env: Env,
  employeeId: unknown,
  dependencies: MokaRequestDependencies = {}
): Promise<MokaDirectoryEmployee> {
  const externalId = positiveIntegerText(employeeId, "invalid_moka_employee_id");
  const response = await queryMokaEmployees(env, {
    uuidList: [Number(externalId)],
    pageNum: 1,
    pageSize: MAX_PAGE_SIZE
  }, dependencies);
  const records = Array.isArray(response.data?.list) ? response.data.list.filter(isRecord) : [];
  const matches = records.filter((record) => String(record.uuid ?? "").trim() === externalId);
  if (matches.length === 0) throw new HttpError(404, "moka_employee_not_found");
  if (matches.length > 1) throw new HttpError(409, "moka_employee_id_conflict");
  return directoryEmployeeFromMoka(matches[0]);
}

export async function queryMokaDirectoryDepartments(
  env: Env,
  dependencies: MokaRequestDependencies = {}
): Promise<MokaDirectoryDepartment[]> {
  const records = await fetchAllPages((pageNum, pageSize) =>
    queryMokaDepartments(env, { pageNum, pageSize }, dependencies)
  );
  return records.map(directoryDepartmentFromMoka).filter((item): item is MokaDirectoryDepartment => Boolean(item));
}

export async function queryMokaDirectoryEmployees(
  env: Env,
  dependencies: MokaRequestDependencies = {}
): Promise<MokaDirectoryEmployee[]> {
  const records = await fetchAllPages((pageNum, pageSize) =>
    queryMokaEmployees(env, { pageNum, pageSize }, dependencies)
  );
  return records.map((record) => directoryEmployeeFromMoka(record));
}

export function canonicalMokaParams(params: Record<string, string>) {
  return Object.entries(params)
    .filter(([name]) => name !== "sign")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

export function signMokaParams(privateKey: string, params: Record<string, string>) {
  const signer = createSign("RSA-MD5");
  signer.update(canonicalMokaParams(params), "utf8");
  signer.end();
  return signer.sign(normalizePrivateKey(privateKey), "base64");
}

async function requestMoka(
  env: Env,
  input: {
    apiCode: string;
    body: Record<string, unknown>;
    path: string;
    userName?: string;
  },
  dependencies: MokaRequestDependencies
) {
  requireMokaEnabled(env);
  const params: Record<string, string> = {
    apiCode: input.apiCode,
    entCode: requiredMokaConfig(env, "MOKA_ENT_CODE"),
    nonce: dependencies.nonce?.() ?? randomNonce(),
    timestamp: String(dependencies.now?.() ?? Date.now()),
    ...(input.userName ? { userName: input.userName } : {})
  };
  params.sign = signMokaParams(requiredMokaConfig(env, "MOKA_PRIVATE_KEY"), params);

  const url = new URL(`${configuredBaseUrl(env).href.replace(/\/$/, "")}${input.path}`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }

  const response = await (dependencies.fetcher ?? fetch)(url, {
    body: JSON.stringify(input.body),
    headers: {
      Authorization: `Basic ${base64Utf8(`${requiredMokaConfig(env, "MOKA_API_KEY")}:`)}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  }).catch(() => {
    throw new HttpError(502, "moka_request_failed");
  });

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new HttpError(502, "moka_response_too_large");
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new HttpError(502, "moka_response_too_large");
  }

  let payload: MokaEnvelope;
  try {
    payload = JSON.parse(text) as MokaEnvelope;
  } catch {
    throw new HttpError(502, "invalid_moka_response");
  }

  if (!response.ok) {
    throw new HttpError(502, "moka_http_error", safeMokaMessage(payload.msg));
  }
  if (String(payload.code ?? "") !== "200") {
    throw new HttpError(502, "moka_api_error", safeMokaMessage(payload.msg));
  }

  return payload;
}

function configuredBaseUrl(env: Env) {
  const value = env.MOKA_BASE_URL?.trim() || DEFAULT_MOKA_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(503, "invalid_moka_base_url");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new HttpError(503, "invalid_moka_base_url");
  }
  return url;
}

function requireMokaEnabled(env: Env) {
  if (env.MOKA_ENABLED !== "1") {
    throw new HttpError(503, "moka_integration_disabled");
  }
}

function requiredMokaConfig<K extends keyof Env>(env: Env, name: K) {
  const value = String(env[name] ?? "").trim();
  if (!value) {
    throw new HttpError(503, "moka_integration_not_configured", `Missing ${String(name)}`);
  }
  return value;
}

function normalizePrivateKey(value: string) {
  const normalized = value.trim().replace(/\\n/g, "\n");
  if (normalized.includes("-----BEGIN")) {
    return normalized;
  }
  const compact = normalized.replace(/\s+/g, "");
  const lines = compact.match(/.{1,64}/g)?.join("\n") ?? compact;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

function randomNonce() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}

function base64Utf8(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pageSize(value: unknown) {
  const parsed = Number(value ?? MAX_PAGE_SIZE);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new HttpError(400, "invalid_moka_page_size");
  }
  return parsed;
}

function pageNumber(value: unknown) {
  const parsed = Number(value ?? 1);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, "invalid_moka_page_number");
  }
  return parsed;
}

function numberList(value: unknown, maxItems: number, errorCode: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new HttpError(400, errorCode);
  const result = value.map((item) => Number(item));
  if (result.some((item) => !Number.isSafeInteger(item) || item < 1)) throw new HttpError(400, errorCode);
  return result;
}

function stringList(value: unknown, maxItems: number, maxLength: number, errorCode: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new HttpError(400, errorCode);
  const result = value.map((item) => String(item ?? "").trim());
  if (result.some((item) => !item || item.length > maxLength)) throw new HttpError(400, errorCode);
  return result;
}

function officeEmail(value: unknown) {
  const email = normalizedOfficeEmail(value);
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "invalid_moka_employee_email");
  }
  return email;
}

function normalizedOfficeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function directoryEmployeeFromMoka(record: Record<string, unknown>, expectedEmail?: string): MokaDirectoryEmployee {
  const externalId = positiveIntegerText(record.uuid, "invalid_moka_employee_id");
  const email = expectedEmail ?? normalizedOfficeEmail(record.office_email);
  const employmentStatusId = optionalInteger(record.employee_status_id);
  const position = displayName(record.position);
  const duty = displayName(record.duty);
  const department = displayName(record.department);
  return {
    active: String(record.employee_status ?? "").trim() === "在职",
    department,
    departmentExternalId: safeText(record.department_id, 180),
    duty,
    email,
    employeeNo: safeText(record.employee_no, 180),
    employmentStatus: safeText(record.employee_status, 80),
    employmentStatusId,
    externalId,
    jobTitle: position ?? duty,
    name: safeText(record.realname, 240),
    path: pathParts(record.path ?? department),
    position,
    source: "moka"
  };
}

function directoryDepartmentFromMoka(record: Record<string, unknown>): MokaDirectoryDepartment | undefined {
  const externalId = positiveIntegerText(record.node_uid, "invalid_moka_department_id");
  const name = safeText(record.dept_sample_name, 240) ?? pathParts(record.dept_name).at(-1);
  if (!name) return undefined;
  const parentId = isRecord(record.superior_dept) ? safeText(record.superior_dept.id, 180) : undefined;
  return {
    active: Number(record.have_used) === 1,
    code: safeText(record.node_code, 180),
    externalId,
    name,
    parentExternalId: parentId && parentId !== "0" ? parentId : undefined,
    path: pathParts(record.dept_name ?? name),
    source: "moka"
  };
}

async function fetchAllPages(
  queryPage: (pageNum: number, pageSize: number) => Promise<MokaEnvelope<Record<string, unknown>>>
) {
  const records: Record<string, unknown>[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let pageNum = 1; records.length < total; pageNum += 1) {
    if (pageNum > 10_000) throw new HttpError(502, "moka_pagination_limit_exceeded");
    const response = await queryPage(pageNum, MAX_PAGE_SIZE);
    const page = Array.isArray(response.data?.list) ? response.data.list.filter(isRecord) : [];
    const parsedTotal = Number(response.data?.total ?? page.length);
    if (!Number.isSafeInteger(parsedTotal) || parsedTotal < 0) throw new HttpError(502, "invalid_moka_total");
    total = parsedTotal;
    records.push(...page);
    if (page.length === 0) break;
  }
  return records.slice(0, total);
}

function pathParts(value: unknown) {
  return String(value ?? "")
    .split(/\s*\/\s*/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 32);
}

function positiveIntegerText(value: unknown, code: string) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || Number(text) <= 0) throw new HttpError(400, code);
  return text;
}

function displayName(value: unknown) {
  if (typeof value === "string" || typeof value === "number") {
    return safeText(value, 240);
  }
  if (!isRecord(value)) return undefined;
  return safeText(value.name ?? value.value ?? value.label, 240);
}

function safeText(value: unknown, maxLength: number) {
  const text = String(value ?? "").trim();
  return text && text.length <= maxLength ? text : undefined;
}

function optionalInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalEnumNumber(value: unknown, allowed: number[], errorCode: string) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !allowed.includes(parsed)) throw new HttpError(400, errorCode);
  return parsed;
}

function optionalText(value: unknown, maxLength: number) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new HttpError(400, "invalid_moka_filter");
  return text;
}

function safeMokaMessage(value: unknown) {
  const text = String(value ?? "Moka request failed").trim();
  return text.slice(0, 300) || "Moka request failed";
}
