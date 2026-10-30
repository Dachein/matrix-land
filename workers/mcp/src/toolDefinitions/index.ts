import { mailToolDefinitions } from "../../../../src/shared/mailTools.ts";
import { platformToolDefinitions } from "./platform.ts";
import { forumToolDefinitions } from "./forum.ts";
import { hubToolDefinitions } from "./hub.ts";
import { knowledgeToolDefinitions } from "./knowledge.ts";
import { appsToolDefinitions } from "./apps.ts";
import { deploymentsToolDefinitions } from "./deployments.ts";
import { skillsToolDefinitions } from "./skills.ts";

export { MAX_UPLOAD_BYTES } from "./shared.ts";

// Declarative schemas only. Execution, authorization and persistence stay in tools.ts.
export const INTERNAL_MCP_COMMANDS = [
  ...mailToolDefinitions,
  ...platformToolDefinitions,
  ...forumToolDefinitions,
  ...hubToolDefinitions,
  ...knowledgeToolDefinitions,
  ...appsToolDefinitions,
  ...deploymentsToolDefinitions,
  ...skillsToolDefinitions,
];
