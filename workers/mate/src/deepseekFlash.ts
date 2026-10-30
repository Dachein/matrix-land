import type { FetchFunction } from "@ai-sdk/provider-utils";
import { plainObjectToolSchema } from "./toolSchemaCompatibility.ts";
import { RuntimeHttpError } from "./types.ts";

/** Tencent Flash accepts object-root function parameters, preserving local validation. */
export function deepseekFlashFetch(fetcher: FetchFunction): FetchFunction {
  return async (url, init) => {
    if (typeof init?.body !== "string") throw new RuntimeHttpError(502, "mate_deepseek_request_invalid");
    const body = JSON.parse(init.body);
    for (const tool of body.tools ?? []) {
      if (tool.type === "function" && tool.function?.parameters) {
        tool.function.parameters = plainObjectToolSchema(tool.function.parameters, "mate_deepseek_tool_schema_unsupported");
      }
    }
    return fetcher(url, { ...init, body: JSON.stringify(body) });
  };
}
