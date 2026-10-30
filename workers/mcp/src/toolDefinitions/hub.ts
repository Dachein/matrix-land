import { WORKSPACE_APP_COVER_GUIDANCE } from "../../../../src/shared/mcpHandbook.ts";
import { HUB_CATEGORY_NAMES, type McpToolDefinition } from "./shared.ts";

export const hubToolDefinitions: McpToolDefinition[] = [
{
      name: "hub_search",
      description: "Search listed Workspace Hub items for Skills and Apps.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 20 },
          q: { type: "string" },
          type: { type: "string", enum: ["skill", "app"] }
        }
      }
    },
{
      name: "hub_skills_list",
      description: "List listed Skill Hub items available for install or download.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 20 },
          q: { type: "string" }
        }
      }
    },
{
      name: "hub_skill_download",
      description: "Download the latest listed Skill Hub package. Returns a verified base64 zip payload for local Agent installation.",
      inputSchema: {
        type: "object",
        properties: {
          listingId: { type: "string" },
          skillId: { type: "string" },
          client: { type: "string", enum: ["codex", "claude-code", "codebuddy", "openclaw"] }
        }
      }
    },
{
      name: "hub_submit_listing",
      description: "Submit a APPS App or Skill to Skill Hub review from MCP. coverImageUrl may be a locally processed 600x600 data:image/...;base64 URL or a hosted image URL. " + WORKSPACE_APP_COVER_GUIDANCE,
      inputSchema: {
        type: "object",
        required: ["targetType", "targetId"],
        properties: {
          artifactBody: { type: "string" },
          artifactType: { type: "string", enum: ["skill_md", "app_config", "document", "package"] },
          artifactUrl: { type: "string" },
          builderSnapshot: { type: "object" },
          category: { type: "string", enum: HUB_CATEGORY_NAMES },
          changelog: { type: "string" },
          config: { type: "object" },
          coverImageUrl: {
            type: "string",
            description: "Optional when retaining an existing cover; required for new Apps. Current asset-specific accelerated cover URLs are accepted. If an App has no supplied/existing cover, automatically generate one with tools_image_generation and resize it to 600x600. Use the downloaded image as a data URL of at most 1,200,000 characters, not the expiring preview URL. Prefer a local 600x600 data:image/png|jpeg|webp|gif;base64 URL; /assets, /api/forum/media, and http(s) URLs are also accepted."
          },
          description: { type: "string" },
          name: { type: "string" },
          overviewMarkdown: { type: "string" },
          riskLevel: { type: "string", enum: ["low", "medium", "high"] },
          summary: { type: "string" },
          tags: {
            type: "array",
            items: { type: "string" },
            maxItems: 8
          },
          targetId: { type: "string" },
          targetType: { type: "string", enum: ["app", "skill"] },
          version: { type: "string" },
          versionId: { type: "string" },
          visibility: { type: "string", enum: ["org", "company", "team", "private"], description: "Organization visibility uses org; company remains accepted as a legacy alias." }
        }
      }
    }
];
