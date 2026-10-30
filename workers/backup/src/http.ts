import { HttpError } from "./types";

export const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export function json(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(JSON_HEADERS);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return new Response(JSON.stringify(value), { ...init, headers });
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new HttpError(400, "invalid_json_body");
  }
}

export function errorResponse(error: unknown, requestId: string) {
  if (error instanceof HttpError) return json({ error: error.code, requestId }, { status: error.status });
  console.error("backup_worker_error", {
    errorName: error instanceof Error ? error.name : "NonErrorThrown",
    requestId
  });
  return json({ error: "internal_error", requestId }, { status: 500 });
}

export function normalizePath(pathname: string) {
  return (`/${pathname}`.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/");
}
