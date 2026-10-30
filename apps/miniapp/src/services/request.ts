import Taro from "@tarojs/taro";
import { state } from "../state";
import { AuthRequiredError, isAuthRequiredError } from "./auth";

declare const TARO_APP_API_BASE: string;
declare const TARO_APP_USE_MOCKS: string;

export const API_BASE = typeof TARO_APP_API_BASE === "string" ? TARO_APP_API_BASE.replace(/\/$/, "") : "";
export const USE_MOCKS = typeof TARO_APP_USE_MOCKS === "string" ? TARO_APP_USE_MOCKS === "1" : true;

type RequestOptions = {
  data?: unknown;
  headers?: Record<string, string>;
  method?: "DELETE" | "GET" | "PATCH" | "POST";
  timeoutMs?: number;
  url: string;
};

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function requestJson<T>({ data, headers, method = "GET", timeoutMs = 30_000, url }: RequestOptions): Promise<T> {
  return (await requestJsonResponse<T>({ data, headers, method, timeoutMs, url })).data;
}

export async function requestJsonResponse<T>({ data, headers, method = "GET", timeoutMs = 30_000, url }: RequestOptions): Promise<{ data: T; headers: Record<string, unknown> }> {
  const absolute = /^https?:\/\//.test(url) ? url : `${API_BASE}${url}`;
  const cookie = state.getCookie();
  const response = await Taro.request<T & { error?: string }>({
    url: absolute,
    method,
    data,
    timeout: timeoutMs,
    header: {
      accept: "application/json",
      ...(data === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...headers
    }
  });
  persistCookies(response.header);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const code = String(response.data?.error || `http_${response.statusCode}`);
    const error = new ApiError(response.statusCode, code);
    if (isAuthRequiredError(error)) throw new AuthRequiredError(code);
    throw error;
  }
  return { data: response.data, headers: response.header };
}

function persistCookies(headers: Record<string, unknown>) {
  const raw = headers["Set-Cookie"] ?? headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? splitSetCookie(raw) : [];
  if (!values.length) return;
  const jar = new Map(state.getCookie().split(/;\s*/).filter(Boolean).map((item) => {
    const index = item.indexOf("=");
    return [item.slice(0, index), item.slice(index + 1)];
  }));
  values.forEach((cookie) => {
    const pair = cookie.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  });
  state.setCookie([...jar].map(([key, value]) => `${key}=${value}`).join("; "));
}

function splitSetCookie(value: string) {
  return value.split(/,(?=\s*[A-Za-z0-9_!#$%&'*+.^`|~-]+=)/g).map((item) => item.trim());
}
