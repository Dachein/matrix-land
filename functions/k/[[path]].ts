import { missingConfiguration } from "../../src/shared/requiredConfiguration.ts";
export interface Env {
  KNOWLEDGE_WORKER_URL?: string;
}

type PagesContext = EventContext<Env, string, { path?: string | string[] }>;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export const onRequest: PagesFunction<Env, string, { path?: string | string[] }> = async (context) => {
  const target = knowledgeWorkerTarget(context);
  const headers = new Headers(context.request.headers);
  const publicUrl = new URL(context.request.url);

  for (const header of HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }

  headers.set("x-workspace-public-origin", publicUrl.origin);
  headers.set("x-forwarded-host", publicUrl.host);
  headers.set("x-forwarded-proto", publicUrl.protocol.replace(/:$/, ""));

  const response = await fetch(target.toString(), {
    method: context.request.method,
    headers,
    body: context.request.method === "GET" || context.request.method === "HEAD" ? undefined : context.request.body,
    redirect: "manual"
  });

  return new Response(response.body, response);
};

function knowledgeWorkerTarget(context: PagesContext) {
  const base = (context.env.KNOWLEDGE_WORKER_URL?.trim() || missingConfiguration("KNOWLEDGE_WORKER_URL")).replace(/\/+$/, "");
  const path = normalizePathParam(context.params.path);
  const source = new URL(context.request.url);
  const target = new URL(path ? `${base}/${path}` : base);
  target.search = source.search;
  return target;
}

function normalizePathParam(value: string | string[] | undefined) {
  const parts = Array.isArray(value) ? value : value ? [value] : [];
  return parts
    .flatMap((part) => part.split("/"))
    .map((part) => encodeURIComponent(part))
    .join("/");
}
