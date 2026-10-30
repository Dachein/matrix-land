import { KNOWLEDGE_QUERY_CONTEXT_SCHEMA, type McpToolDefinition } from "./shared.ts";

export const knowledgeToolDefinitions: McpToolDefinition[] = [
{
      name: "knowledge_edit_list",
      description: "List files and folders in My Knowledge or in a folder shared with the current user. Pass folderObjectId to browse a shared or nested folder; omit it to discover My Library root together with accessible shared Roots. Each item reports its effective role; Viewer items remain read-only.",
      inputSchema: {
        type: "object",
        properties: {
          folderObjectId: { type: "string", description: "Folder object id to list. Omit for My Library root." }
        }
      }
    },
{
      name: "knowledge_edit_file_read",
      description: "Read one accessible Knowledge file and optionally return its latest content as UTF-8 text or base64.",
      inputSchema: {
        type: "object",
        required: ["objectId"],
        properties: {
          includeContent: { type: "boolean", description: "Return latest file content when true. Defaults to false." },
          objectId: { type: "string", description: "File object id." }
        }
      }
    },
{
      name: "knowledge_edit_file_upload",
      description: "Upload a new file to My Library or a folder where the current user is Owner or Collaborator. Provide contentText, contentBase64, or sourceUrl for server-side audio import from an operator-approved host. sourceUrl avoids placing audio bytes in the model context.",
      inputSchema: {
        type: "object",
        required: ["fileName"],
        properties: {
          sourceUrl: { type: "string", maxLength: 8192, description: "HTTPS audio download URL from an operator-approved storage host. Mutually exclusive with contentText/contentBase64; requires audio MIME type. Never save signed URLs in permanent metadata." },
          contentBase64: { type: "string", description: "Base64 file body, optionally a data: URL." },
          contentText: { type: "string", description: "UTF-8 text file body." },
          extractZip: { type: "boolean", description: "When uploading a zip, extract it into a folder. Defaults to true." },
          fileName: { type: "string" },
          idempotencyKey: { type: "string", maxLength: 200 },
          mimeType: { type: "string" },
          parentObjectId: { type: "string", description: "Destination folder object id. Omit for My Library root." }
        }
      }
    },
{
      name: "knowledge_edit_file_update",
      description: "Upload a new latest version of a Knowledge file where the current user is Owner or Collaborator. Provide either contentText or contentBase64.",
      inputSchema: {
        type: "object",
        required: ["objectId", "fileName", "expectedCurrentVersionId"],
        properties: {
          contentBase64: { type: "string", description: "Base64 file body, optionally a data: URL." },
          contentText: { type: "string", description: "UTF-8 text file body." },
          expectedCurrentVersionId: { type: "string", description: "Version id observed before preparing this replacement. The Worker rejects stale writes." },
          fileName: { type: "string" },
          idempotencyKey: { type: "string", maxLength: 200 },
          mimeType: { type: "string" },
          objectId: { type: "string", description: "Existing file object id." }
        }
      }
    },
{
      name: "knowledge_edit_file_edit",
      description: "Apply an exact CAS text edit to a UTF-8 TXT, Markdown, CSV, JSON, JSONL/NDJSON, or HTML file. Supports exact replacement, append, complete replacement, and unified patch; no fuzzy matching is performed.",
      inputSchema: {
        type: "object",
        required: ["objectId", "expectedCurrentVersionId", "operation", "idempotencyKey"],
        properties: {
          contentText: { type: "string", description: "Complete replacement content for replace_content." },
          expectedCurrentVersionId: { type: "string" },
          expectedOccurrences: { type: "integer", minimum: 1, maximum: 100, default: 1 },
          idempotencyKey: { type: "string", maxLength: 200 },
          newText: { type: "string" },
          objectId: { type: "string" },
          oldText: { type: "string" },
          operation: { type: "string", enum: ["replace_text", "append_text", "replace_content", "apply_patch"] },
          patch: { type: "string", description: "One-file unified diff for apply_patch with numbered hunks, e.g. @@ -1,1 +1,1 @@. Hunk counts must match the body. Do not use *** Begin Patch or bare @@. Every context and removed line must match exactly." },
          text: { type: "string", description: "Text to append for append_text; accepted as the patch body for apply_patch." }
        }
      }
    },
{
      name: "knowledge_edit_batch",
      description: "Apply up to 20 CAS text edits under one Root Folder as one all-or-nothing Change Set.",
      inputSchema: {
        type: "object",
        required: ["items", "idempotencyKey"],
        properties: {
          allOrNothing: { type: "boolean", const: true, default: true },
          idempotencyKey: { type: "string", maxLength: 200 },
          items: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              required: ["objectId", "expectedCurrentVersionId", "operation"],
              properties: {
                contentText: { type: "string" },
                expectedCurrentVersionId: { type: "string" },
                expectedOccurrences: { type: "integer", minimum: 1, maximum: 100 },
                newText: { type: "string" },
                objectId: { type: "string" },
                oldText: { type: "string" },
                operation: { type: "string", enum: ["replace_text", "append_text", "replace_content", "apply_patch"] },
                patch: { type: "string", description: "One-file unified diff with numbered hunks and matching counts; do not use *** Begin Patch or bare @@." },
                text: { type: "string" }
              }
            }
          }
        }
      }
    },
{
      name: "knowledge_edit_folder_create",
      description: "Create a folder in My Library or in a folder where the current user is Owner or Collaborator.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          idempotencyKey: { type: "string", maxLength: 200 },
          parentObjectId: { type: "string", description: "Parent folder object id. Omit for My Library root." }
        }
      }
    },
{
      name: "knowledge_edit_object_rename",
      description: "Rename a Knowledge file or folder where the current user is Owner or Collaborator.",
      inputSchema: {
        type: "object",
        required: ["objectId", "name"],
        properties: {
          name: { type: "string" },
          expectedCurrentVersionId: { type: "string" },
          idempotencyKey: { type: "string", maxLength: 200 },
          objectId: { type: "string" }
        }
      }
    },
{
      name: "knowledge_edit_object_move",
      description: "Move a file or nested folder to another folder inside the same Root Folder. Root Folders cannot be moved.",
      inputSchema: {
        type: "object",
        required: ["objectId", "parentObjectId", "idempotencyKey"],
        properties: {
          expectedCurrentVersionId: { type: "string", description: "Required for files; omit for folders." },
          idempotencyKey: { type: "string", maxLength: 200 },
          objectId: { type: "string" },
          parentObjectId: { type: "string", description: "Destination folder object id inside the same Root Folder." }
        }
      }
    },
{
      name: "knowledge_edit_object_delete",
      description: "Delete a Knowledge file or folder where the current user is Owner or Collaborator. This destructive operation requires explicit confirmation.",
      inputSchema: {
        type: "object",
        required: ["objectId", "confirm"],
        properties: {
          confirm: { type: "boolean", const: true, description: "Must be true after the user explicitly confirms deletion." },
          expectedCurrentVersionId: { type: "string" },
          idempotencyKey: { type: "string", maxLength: 200 },
          objectId: { type: "string" }
        }
      }
    },
{
      name: "knowledge_edit_object_restore",
      description: "Restore a soft-deleted file or folder by object id. Restoring a deleted Root restores content but does not reactivate its Knowledge Service or old Viewer grants.",
      inputSchema: {
        type: "object",
        required: ["objectId", "idempotencyKey"],
        properties: {
          expectedCurrentVersionId: { type: "string", description: "Required for a deleted file; omit for a folder." },
          idempotencyKey: { type: "string", maxLength: 200 },
          objectId: { type: "string" }
        }
      }
    },
{
      name: "knowledge_edit_file_versions",
      description: "List immutable versions for one accessible Knowledge file.",
      inputSchema: {
        type: "object",
        required: ["objectId"],
        properties: { objectId: { type: "string" } }
      }
    },
{
      name: "knowledge_edit_file_version_restore",
      description: "Create a new current version from an older immutable file version. This never rewinds the current pointer and remains auditable.",
      inputSchema: {
        type: "object",
        required: ["objectId", "versionId", "expectedCurrentVersionId", "idempotencyKey"],
        properties: {
          expectedCurrentVersionId: { type: "string" },
          idempotencyKey: { type: "string", maxLength: 200 },
          objectId: { type: "string" },
          versionId: { type: "string", description: "Historical version to copy into a new current version." }
        }
      }
    },
{
      name: "knowledge_edit_service_update",
      description: "Update the routing Card for an active Knowledge Service. Root Owners and Collaborators may update Description, Role, Best for, Not for, Keywords, and Search hints. This tool cannot change access, lifecycle, files, or ownership.",
      inputSchema: {
        type: "object",
        required: ["serviceId"],
        anyOf: [
          { required: ["description"] },
          { required: ["role"] },
          { required: ["bestFor"] },
          { required: ["notFor"] },
          { required: ["keywords"] },
          { required: ["searchHints"] }
        ],
        properties: {
          serviceId: { type: "string", description: "Knowledge Service id returned by knowledge_service_list." },
          description: { type: "string", maxLength: 1000 },
          role: { type: "string", maxLength: 500, description: "The responsibility this Knowledge Service should take in Agent routing." },
          bestFor: { type: "array", maxItems: 30, items: { type: "string", maxLength: 240 } },
          notFor: { type: "array", maxItems: 30, items: { type: "string", maxLength: 240 } },
          keywords: { type: "array", maxItems: 30, items: { type: "string", maxLength: 64 } },
          searchHints: { type: "array", maxItems: 30, items: { type: "string", maxLength: 240 } }
        }
      }
    },
{
      name: "knowledge_file_public_share_create",
      description: "Create a public link to the latest content of one file. Root Owner only; folders are never publicly shared. Requires explicit confirmation.",
      inputSchema: {
        type: "object",
        required: ["fileId", "confirm"],
        properties: {
          confirm: { type: "boolean", const: true, description: "Must be true after the user explicitly confirms public sharing." },
          expiry: { type: "string", enum: ["24h", "permanent"], default: "24h", description: "Link lifetime. Permanent links remain active until revoked or the file is deleted." },
          fileId: { type: "string", description: "File object id." }
        }
      }
    },
{
      name: "knowledge_file_public_share_get",
      description: "Get the active public link and expiry for one file. Root Owner only.",
      inputSchema: {
        type: "object",
        required: ["fileId"],
        properties: {
          fileId: { type: "string", description: "File object id." }
        }
      }
    },
{
      name: "knowledge_file_public_share_revoke",
      description: "Revoke a file public link without deleting the file. Root Owner only; requires explicit confirmation.",
      inputSchema: {
        type: "object",
        required: ["fileId", "confirm"],
        properties: {
          confirm: { type: "boolean", const: true, description: "Must be true after the user explicitly confirms revocation." },
          fileId: { type: "string", description: "File object id." }
        }
      }
    },
{
      name: "knowledge_service_list",
      description: "List compact registration cards for Agent-enabled Knowledge Services visible to the current user.",
      inputSchema: { type: "object", properties: {} }
    },
{
      name: "knowledge_service_handbook",
      description: "Read the handbook.md usage guide for one visible Knowledge Service before querying it.",
      inputSchema: {
        type: "object",
        required: ["serviceId"],
        properties: {
          serviceId: { type: "string" }
        }
      }
    },
{
      name: "knowledge_service_search",
      description: "Search UTF-8 text in a readable Knowledge folder by folderObjectId, or use the indexed Knowledge Service path by serviceId. Binary bodies are not searched.",
      inputSchema: {
        type: "object",
        required: ["query"],
        anyOf: [{ required: ["folderObjectId"] }, { required: ["serviceId"] }],
        properties: {
          folderObjectId: { type: "string", description: "Readable Knowledge folder id; no enabled service is required." },
          limit: { type: "number", minimum: 1, maximum: 50 },
          query: { type: "string" },
          queryContext: KNOWLEDGE_QUERY_CONTEXT_SCHEMA,
          serviceId: { type: "string" }
        }
      }
    },
{
      name: "knowledge_service_grep",
      description: "Find exact text matches in a readable Knowledge folder by folderObjectId, or use the indexed Knowledge Service path by serviceId. Binary bodies are not searched.",
      inputSchema: {
        type: "object",
        required: ["pattern"],
        anyOf: [{ required: ["folderObjectId"] }, { required: ["serviceId"] }],
        properties: {
          caseSensitive: { type: "boolean" },
          folderObjectId: { type: "string", description: "Readable Knowledge folder id; no enabled service is required." },
          limit: { type: "number", minimum: 1, maximum: 100 },
          pattern: { type: "string" },
          queryContext: KNOWLEDGE_QUERY_CONTEXT_SCHEMA,
          serviceId: { type: "string" }
        }
      }
    },
{
      name: "knowledge_service_read",
      description: "Read an authorized Knowledge file by objectId without an enabled service, or read a visible Knowledge Service file by relativePath and serviceId.",
      inputSchema: {
        type: "object",
        anyOf: [
          { required: ["objectId"] },
          { required: ["serviceId", "relativePath"] },
          { required: ["serviceId", "path"] }
        ],
        properties: {
          includeContent: { type: "boolean", description: "Return file content with objectId. Defaults to true; set false for metadata only." },
          objectId: { type: "string" },
          path: { type: "string" },
          queryContext: KNOWLEDGE_QUERY_CONTEXT_SCHEMA,
          relativePath: { type: "string" },
          serviceId: { type: "string" }
        }
      }
    },
{
      name: "knowledge_service_tree",
      description: "List Knowledge Service metadata by relative path and bounded depth without reading file bodies.",
      inputSchema: {
        type: "object",
        required: ["serviceId"],
        properties: {
          depth: { type: "integer", minimum: 1, maximum: 10 },
          limit: { type: "integer", minimum: 1, maximum: 1000 },
          queryContext: KNOWLEDGE_QUERY_CONTEXT_SCHEMA,
          relativePath: { type: "string" },
          serviceId: { type: "string" }
        }
      }
    },
{
      name: "knowledge_service_glob",
      description: "Match Knowledge Service relative paths using *, **, and ? without reading file bodies.",
      inputSchema: {
        type: "object",
        required: ["serviceId", "pattern"],
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 1000 },
          pattern: { type: "string", maxLength: 200 },
          queryContext: KNOWLEDGE_QUERY_CONTEXT_SCHEMA,
          serviceId: { type: "string" }
        }
      }
    },
{
      name: "knowledge_feedback_submit",
      description: "Submit an idempotent question, correction, issue, or suggestion against a visible Knowledge Service or Root Folder.",
      inputSchema: {
        type: "object",
        required: ["kind", "message", "idempotencyKey"],
        anyOf: [
          { required: ["serviceId"] },
          { required: ["rootObjectId"] }
        ],
        properties: {
          changeSetId: { type: "string", description: "Optional related immutable Change Set." },
          context: { type: "object", description: "Optional structured context such as query, path, or expected value." },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
          kind: { type: "string", enum: ["question", "correction", "issue", "suggestion"] },
          message: { type: "string", minLength: 1, maxLength: 4000 },
          objectId: { type: "string", description: "Optional related file or folder inside the target Root." },
          queryId: { type: "string", description: "Optional Query Ledger id that exposed this knowledge gap." },
          queryStepId: { type: "string", description: "Optional Query Step id most closely related to this feedback." },
          rootObjectId: { type: "string" },
          serviceId: { type: "string" }
        }
      }
    },
{
      name: "knowledge_feedback_list_mine",
      description: "List feedback submitted by the current user, optionally limited to one visible Knowledge Service.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          serviceId: { type: "string" },
          status: { type: "string", enum: ["open", "triaged", "resolved", "dismissed"] }
        }
      }
    },
{
      name: "knowledge_feedback_get",
      description: "Read one feedback item when the current user submitted it or currently has audit access to its Root Folder.",
      inputSchema: {
        type: "object",
        required: ["feedbackId"],
        properties: { feedbackId: { type: "string" } }
      }
    },
{
      name: "knowledge_feedback_list",
      description: "List feedback for one Root Folder or Knowledge Service. Requires current Owner or Collaborator access.",
      inputSchema: {
        type: "object",
        anyOf: [
          { required: ["serviceId"] },
          { required: ["rootObjectId"] }
        ],
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          rootObjectId: { type: "string" },
          serviceId: { type: "string" },
          status: { type: "string", enum: ["open", "triaged", "resolved", "dismissed"] }
        }
      }
    },
{
      name: "knowledge_feedback_status_update",
      description: "Triage, resolve, dismiss, or reopen one feedback item. Requires current Owner or Collaborator access.",
      inputSchema: {
        type: "object",
        required: ["feedbackId", "status"],
        properties: {
          feedbackId: { type: "string" },
          status: { type: "string", enum: ["open", "triaged", "resolved", "dismissed"] }
        }
      }
    }
];
