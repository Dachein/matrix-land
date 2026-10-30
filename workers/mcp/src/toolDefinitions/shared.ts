import { MARKET_CATEGORIES } from "../../../../src/shared/marketCategories.ts";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const HUB_CATEGORY_NAMES = MARKET_CATEGORIES.map((category) => category.en);
export const KNOWLEDGE_QUERY_CONTEXT_SCHEMA = {
  type: "object",
  description: "Optional correlation context for one user intent. Reuse queryId returned by a prior Knowledge query step.",
  properties: {
    queryId: { type: "string", description: "Workspace Query Ledger id returned by a prior Knowledge query step." },
    parentStepId: { type: "string", description: "Optional parent Query Step id when this call is a child branch." },
    clientSessionId: { type: "string", maxLength: 240, description: "Optional Agent-host conversation/session id." },
    clientTurnId: { type: "string", maxLength: 240, description: "Optional user-turn id inside the Agent-host session." },
    originalQuestion: { type: "string", maxLength: 4000, description: "Optional original user question. It is hashed by default." },
    storeOriginalQuestion: {
      type: "boolean",
      default: false,
      description: "Store the original question temporarily under the organization retention policy. Defaults to false."
    }
  }
};

export type McpToolDefinition = {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
};

export function mateIdInputSchema() {
  return {
    type: "object",
    required: ["mateId"],
    additionalProperties: false,
    properties: { mateId: { type: "string", maxLength: 128 } }
  };
}


export const MAX_FORUM_BODY_CHARS = 8000;
export const MAX_FORUM_ATTACHMENTS = 16;
export const MAX_FORUM_ATTACHMENT_BYTES = 15 * 1024 * 1024;
