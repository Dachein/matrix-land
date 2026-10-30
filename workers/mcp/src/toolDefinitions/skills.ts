import { type McpToolDefinition } from "./shared.ts";

export const skillsToolDefinitions: McpToolDefinition[] = [
{
      name: "apps_list_skills",
      description: "List APPS Skills the current Workspace user may read or install; use apps_list_inventory for the owner/collaborator-managed set.",
      inputSchema: { type: "object", properties: {} }
    },
{
      name: "apps_get_skill",
      description: "Read one private APPS skill and versions.",
      inputSchema: {
        type: "object",
        required: ["skillId"],
        properties: {
          skillId: { type: "string" }
        }
      }
    },
{
      name: "apps_skill_validate",
      description: "Validate a Skill package before publishing it as an author-managed APPS Skill.",
      inputSchema: {
        type: "object",
        required: ["skillMarkdown"],
        properties: {
          skillMarkdown: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              }
            }
          },
          manifest: { type: "object" }
        }
      }
    },
{
      name: "apps_skill_submit",
      description: "Publish a new collaboratively managed APPS Skill package. Community distribution is handled separately through its APPS listing.",
      inputSchema: {
        type: "object",
        required: ["skillMarkdown"],
        properties: {
          name: { type: "string" },
          slug: { type: "string" },
          description: { type: "string" },
          version: { type: "string" },
          kind: { type: "string", enum: ["vanilla", "app"] },
          capabilities: { type: "array", items: { type: "string" } },
          changelog: { type: "string" },
          skillMarkdown: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              }
            }
          },
          manifest: { type: "object" }
        }
      }
    },
{
      name: "apps_skill_update",
      description: "Create a new immutable version for an existing collaboratively managed APPS Skill.",
      inputSchema: {
        type: "object",
        required: ["skillId", "skillMarkdown"],
        properties: {
          skillId: { type: "string" },
          version: { type: "string" },
          changelog: { type: "string" },
          skillMarkdown: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" }
              }
            }
          },
          manifest: { type: "object" }
        }
      }
    }
];
