import type { FetchFunction } from "@ai-sdk/provider-utils";
import { RuntimeHttpError } from "./types.ts";
import { plainObjectToolSchema } from "./toolSchemaCompatibility.ts";

export const CLOUDFLARE_HAIKU_MODEL = "cf-anthropic-claude-haiku-5.5";

/** Adapt Cloudflare's Messages wire format without changing local tool validation. */
export function cloudflareHaikuFetch(fetcher: FetchFunction): FetchFunction {
  return async (url, init) => {
    if (typeof init?.body !== "string") throw new RuntimeHttpError(502, "mate_haiku_request_invalid");
    const body = JSON.parse(init.body);
    if (Array.isArray(body.system)) {
      body.system = body.system.map((block: unknown) => {
        if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text"
          || !("text" in block) || typeof block.text !== "string") {
          throw new RuntimeHttpError(502, "mate_haiku_system_invalid");
        }
        return block.text;
      }).join("\n\n");
    }
    if (Array.isArray(body.tools)) {
      for (const tool of body.tools) {
        const schema = tool.input_schema;
        if (!schema || typeof schema !== "object") continue;
        tool.input_schema = plainObjectToolSchema(schema, "mate_haiku_tool_schema_unsupported");
      }
    }
    return fetcher(url, { ...init, body: JSON.stringify(body) });
  };
}
