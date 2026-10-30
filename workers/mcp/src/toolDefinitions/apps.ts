import { WORKSPACE_APP_COVER_GUIDANCE } from "../../../../src/shared/mcpHandbook.ts";
import { mateIdInputSchema, type McpToolDefinition } from "./shared.ts";

export const appsToolDefinitions: McpToolDefinition[] = [
{
      name: "app_mcp_accessible_list",
      description: "List published MCP-enabled Apps the current Workspace user may access. Returns App summaries only; use app_mcp_tools_list for one selected App.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
{
      name: "app_mcp_tools_list",
      description: "List the MCP tools currently allowed for the authenticated user in one selected App, including descriptions and complete input schemas.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        additionalProperties: false,
        properties: { appId: { type: "string", maxLength: 160 } }
      }
    },
{
      name: "app_mcp_tool_call",
      description: "Call one published, currently authorized MCP tool in a selected App. High-risk or write tools may require confirmation=true.",
      inputSchema: {
        type: "object",
        required: ["appId", "toolName", "arguments"],
        additionalProperties: false,
        properties: {
          appId: { type: "string", maxLength: 160 },
          toolName: { type: "string", maxLength: 96 },
          arguments: { type: "object" },
          confirmation: { type: "boolean" }
        }
      }
    },
{
      name: "apps_list_inventory",
      description: "List every APPS App and Skill the current Workspace user can manage as an owner or collaborator.",
      inputSchema: { type: "object", properties: {} }
    },
{
      name: "apps_list_apps",
      description: "List APPS Apps the current Workspace user can manage as an owner or collaborator.",
      inputSchema: { type: "object", properties: {} }
    },
{
      name: "apps_get_app",
      description: "Read the canonical APPS App developer context: raw App state, resources, bindings, Auth configuration, managed-secret lifecycle, development guidance, readiness gates, deployment summary, blockers, and next actions. Call this before editing or deploying; call apps_get_auth_sdk only when its nextActions require Auth implementation material.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: {
          appId: { type: "string" }
        }
      }
    },
{
      name: "apps_download_current_source_code",
      description: "Download the exact source snapshot linked to the App's currently published production deployment. Returns deployment metadata, integrity hashes, and a base64 ZIP. It never falls back to an un-deployed or historical source snapshot. An existing README.md is preserved, but no synthetic project-context README is added.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        additionalProperties: false,
        properties: {
          appId: { type: "string", maxLength: 160 }
        }
      }
    },
{
      name: "apps_create_app",
      description: "Create a APPS app, start resource provisioning, and email the authenticated creator a creation notice with office domain allowlist application instructions. " + WORKSPACE_APP_COVER_GUIDANCE,
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          emailEnabled: { type: "boolean", description: "Enable or disable one app mailbox with both sending and receiving." },
          emailPrefix: { type: "string", maxLength: 64, description: "Mailbox local part at mail.example.invalid; defaults to the app code." },
          emailTriggerEnabled: { type: "boolean", description: "Deliver signed new-inbound-mail events to the published app callback." },
          code: { type: "string" },
          description: { type: "string" },
          type: { type: "string", enum: ["static_page", "web", "agent_app", "automation", "container"] },
          accessMode: { type: "string", enum: ["public", "company", "targeted", "private"] },
          accessTargets: { type: "array", items: { type: "string" } },
          directoryReadScope: { type: "string", enum: ["app", "company"] },
          agentMcpEnabled: { type: "boolean" },
          resourceTypes: { type: "array", items: { type: "string" } },
          visibility: { type: "string", enum: ["private", "team", "org", "public"] },
          loginRequired: { type: "boolean" },
          llmEnabled: { type: "boolean" }
        }
      }
    },
{
      name: "mate_call_start",
      description: "Start a work Thread or reply in an existing one. Omit threadId/mateCallId for new work; reuse the returned threadId or Mate Call ID for follow-up instructions. Each reply creates a Task and inherits prior exchanges.",
      inputSchema: {
        type: "object",
        required: ["mateId", "instruction"],
        additionalProperties: false,
        properties: {
          mateId: { type: "string", maxLength: 128 },
          instruction: { type: "string", minLength: 1, maxLength: 12000 },
          title: { type: "string", maxLength: 160, description: "Subject for a new Thread. Existing Thread titles remain stable." },
          threadId: { type: "string", maxLength: 180, description: "Stable work Thread ID returned by start or list." },
          mateCallId: { type: "string", maxLength: 180, description: "Human-readable Mate Call ID, e.g. AI-ADOPTION-ABCD, also used in email subjects. Alias of threadId, scoped to this Mate and current user." },
          conversationId: { type: "string", maxLength: 128 },
          parentTaskId: { type: "string", maxLength: 128 },
          context: { type: "object" },
          waitForConclusion: { type: "boolean", default: true }
        }
      }
    },
{
      name: "mate_call_follow",
      description: "Read an entire work Thread by threadId or mateCallId, including requests and receipts, or read one execution by taskId. Exactly one identifier is required; current-user isolation applies.",
      inputSchema: { type: "object", required: ["mateId"], additionalProperties: false, properties: { mateId: { type: "string", maxLength: 128 }, taskId: { type: "string", maxLength: 128 }, threadId: { type: "string", maxLength: 180 }, mateCallId: { type: "string", maxLength: 180 }, cursor: {type:"string",maxLength:400} } }
    },
{
      name: "mate_call_list",
      description: "List work Threads for one Mate, newest first. kind=task groups email and Mate Call; kind=schedule groups timed executions. threadId/mateCallId reads one Thread. Legacy conversationId returns Tasks for that chat; cursor pages through Threads.",
      inputSchema: { type: "object", required: ["mateId"], additionalProperties: false, properties: { mateId: { type: "string", maxLength: 128 }, conversationId: { type: "string", maxLength: 128 }, threadId: {type:"string",maxLength:180}, mateCallId: {type:"string",maxLength:180}, kind:{type:"string",enum:["task","schedule"]}, cursor:{type:"string",maxLength:400} } }
    },
{
      name:"mate_call_receipt",
      description:"Email a saved Task receipt to the authenticated current user's email. Does not execute the Task again. Repeated delivery of the same receipt is idempotent.",
      inputSchema:{type:"object",required:["mateId","taskId"],additionalProperties:false,properties:{mateId:{type:"string",maxLength:128},taskId:{type:"string",maxLength:128}}}
    },
{
      name: "apps_list_mates",
      description: "List Mate identities owned by the current user. Mates use one shared Agent Runtime and immutable releases.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
{
      name: "apps_mate_create",
      description: "Create a stable Mate identity and initial Draft without deploying a dedicated Worker.",
      inputSchema: { type: "object", required: ["displayName", "jobRole", "workEmail"], properties: { avatarUrl: { type: "string", maxLength: 1200000, pattern: "^(?:https?://|data:image/(?:png|jpe?g|webp|gif);base64,)", description: "Mate avatar as an HTTPS URL or uploaded image data URL." }, displayName: { type: "string" }, jobRole: { type: "string" }, description: { type: "string" }, workEmail: { type: "string", format: "email" }, visibility: { type: "string", enum: ["private", "targets", "organization"] }, targetIds: { type: "array", items: { type: "string", pattern: "^(user|department):" } }, creationProfile: { type: "string", enum: ["personal_mate"], description: "Use the same personal Mate Runtime defaults as Web quick setup and miniapp first-Mate creation; explicit fields may override these defaults." }, workspacePassMcpEnabled: { type: "boolean", description: "Legacy alias for all App MCPs and all readable Knowledge Services; cloud Runtime excludes APPS management." }, mcpCapacity: { type: "object", description: "AI Capacity and Forum & Hub selection; each group uses mode all, none, or selected with explicit children. New children automatically join mode all." }, allAppMcp: { type: "boolean", description: "Dynamically include every App MCP accessible to the invoking user, including future Apps." }, allFolderEdit: { type: "boolean", description: "Dynamically include every writable Knowledge folder accessible to the invoking user, including future folders; writes require approval." }, appMcpBindings: { type: "array", items: { type: "object" } }, allKnowledgeServices: { type: "boolean", description: "Dynamically include every Knowledge Service visible to the invoking user." }, folderEditIds: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 180 } }, knowledgeServiceIds: { type: "array", items: { type: "string" } }, builtInToolIds: { type: "array", items: { type: "string" } }, standaloneEnabled: { type: "boolean" }, embeddedEnabled: { type: "boolean" }, emailEnabled: { type: "boolean" }, mateCallEnabled: { type: "boolean" }, scheduleEnabled: { type: "boolean" }, defaultTimezone: { type: "string", maxLength: 80 }, scheduledJobs: { type: "array", maxItems: 32, items: { type: "object", required: ["id", "title", "instruction", "cadence"], properties: { id: { type: "string" }, title: { type: "string" }, instruction: { type: "string" }, cadence: { type: "object", required: ["kind", "at", "timezone"], properties: { kind: { const: "daily" }, at: { type: "string" }, timezone: { type: "string" } } }, delivery: { type: "object" } } } } } }
    },
{
      name: "apps_mate_get",
      description: "Read one Mate identity, current Draft definition, Soul/Handbook/mail.md documents, and active Release pointer.",
      inputSchema: mateIdInputSchema()
    },
{
      name: "apps_mate_update",
      description: "Update mutable Mate identity metadata without changing mateId, Mate Code, or previous releases.",
      inputSchema: { type: "object", required: ["mateId"], properties: { mateId: { type: "string" }, avatarUrl: { type: "string", maxLength: 1200000, pattern: "^(?:$|https?://|data:image/(?:png|jpe?g|webp|gif);base64,)", description: "Replace the Mate avatar with an HTTPS URL or uploaded image data URL; pass an empty string to remove it." }, displayName: { type: "string" }, jobRole: { type: "string" }, description: { type: "string" }, visibility: { type: "string", enum: ["private", "targets", "organization"] }, targetIds: { type: "array", items: { type: "string", pattern: "^(user|department):" } } } }
    },
{
      name: "apps_mate_core_review",
      description: "Review Draft soul.md, handbook.md and mail.md content, versioned references, revision and publication requirements.",
      inputSchema: mateIdInputSchema()
    },
{
      name: "apps_mate_core_update",
      description: "Update Draft soul.md, handbook.md and/or mail.md with expectedRevision. Empty mail.md stores incoming mail only. Preview and confirmed publication are separate actions.",
      inputSchema: { type: "object", required: ["mateId", "expectedRevision"], properties: { mateId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 }, mail: { type: "string", maxLength: 24000 }, soul: { type: "string" }, handbook: { type: "string" } } }
    },
{
      name: "apps_mate_definition_update",
      description: "Replace a Draft workspace.agentruntime/v1 Manifest and versioned documents after server-side validation.",
      inputSchema: { type: "object", required: ["mateId", "expectedRevision", "manifest", "documents"], properties: { mateId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 }, manifest: { type: "object" }, documents: { type: "array", items: { type: "object" } } } }
    },
{
      name: "apps_mate_validate",
      description: "Validate the current Draft and the publisher's current access to configured App MCP resources.",
      inputSchema: mateIdInputSchema()
    },
{
      name: "apps_mate_deploy_preview",
      description: "Deploy the current Draft as an immutable candidate Release for owner testing. Requires confirm=true.",
      inputSchema: { type: "object", required: ["mateId", "confirm"], properties: { mateId: { type: "string" }, confirm: { const: true } } }
    },
{
      name: "apps_mate_publish",
      description: "Publish one exact candidate Release to the shared Runtime. Requires confirm=true after explicit user approval.",
      inputSchema: { type: "object", required: ["mateId", "releaseId", "confirm"], properties: { mateId: { type: "string" }, releaseId: { type: "string" }, confirm: { const: true } } }
    },
{
      name: "apps_mate_releases_list",
      description: "List immutable releases for one Mate.",
      inputSchema: mateIdInputSchema()
    },
{
      name: "apps_mate_release_activate",
      description: "Activate a previous non-revoked Release as rollback. Requires confirm=true.",
      inputSchema: { type: "object", required: ["mateId", "releaseId", "confirm"], properties: { mateId: { type: "string" }, releaseId: { type: "string" }, confirm: { const: true } } }
    }
];
