import { MAX_FORUM_BODY_CHARS, MAX_FORUM_ATTACHMENTS } from "./shared.ts";
import { MAX_UPLOAD_BYTES, type McpToolDefinition } from "./shared.ts";

export const forumToolDefinitions: McpToolDefinition[] = [
{
      name: "forum_list_categories",
      description: "List Frontier Workspace forum categories visible to the current user.",
      inputSchema: { type: "object", properties: {} }
    },
{
      name: "forum_search_topics",
      description: "Search Frontier Workspace forum topics by text, category slug, and tags.",
      inputSchema: {
        type: "object",
        properties: {
          categorySlug: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 20 },
          q: { type: "string" }
        }
      }
    },
{
      name: "forum_get_topic",
      description: "Read one Frontier Workspace forum topic with posts and tags.",
      inputSchema: {
        type: "object",
        required: ["topicId"],
        properties: {
          topicId: { type: "string" }
        }
      }
    },
{
      name: "forum_create_topic",
      description: "Publish a new Frontier Workspace forum topic as the current Workspace user.",
      inputSchema: {
        type: "object",
        required: ["title", "bodyMarkdown"],
        properties: {
          bodyMarkdown: { type: "string", maxLength: MAX_FORUM_BODY_CHARS },
          categorySlug: { type: "string", enum: ["ai-exploration", "ai-investment", "platform-help", "off-topic"] },
          idempotencyKey: {
            type: "string",
            description: "Stable key for one publish intent. Reuse it when retrying the same topic.",
            maxLength: 128
          },
          tags: {
            type: "array",
            items: { type: "string" },
            maxItems: 8
          },
          title: { type: "string", maxLength: 140 },
          topicType: { type: "string", enum: ["help", "question", "idea", "showcase", "official", "release"] }
        }
      }
    },
{
      name: "forum_update_topic",
      description: "Update an open Frontier Workspace forum topic owned by the current Workspace user. Optionally append or replace standalone attachments previously uploaded through forum_media; omit attachment selection to leave existing attachments unchanged.",
      inputSchema: {
        type: "object",
        required: ["topicId", "title", "bodyMarkdown"],
        properties: {
          attachments: {
            type: "array",
            description: "Standalone attachments to append. Pass each file object returned by forum_media finalize/import_url unchanged. Attachments named here are retained on retries by storageKey.",
            items: {
              type: "object",
              required: ["storageKey"],
              properties: {
                fileName: { type: "string", maxLength: 180 },
                fileSize: { type: "integer", minimum: 1, maximum: MAX_UPLOAD_BYTES },
                mimeType: { type: "string", maxLength: 120 },
                publicUrl: { type: "string", maxLength: 600 },
                storageKey: { type: "string", maxLength: 260 },
                storageProvider: { type: "string", enum: ["r2"] },
                url: { type: "string", maxLength: 800 }
              }
            },
            maxItems: MAX_FORUM_ATTACHMENTS
          },
          bodyMarkdown: { type: "string", maxLength: MAX_FORUM_BODY_CHARS },
          retainedAttachmentIds: {
            type: "array",
            description: "Existing root-post attachment IDs or storageKeys to keep. Omit to preserve all existing attachments; pass [] with new attachments to replace them.",
            items: { type: "string", maxLength: 260 },
            maxItems: MAX_FORUM_ATTACHMENTS
          },
          title: { type: "string", maxLength: 140 },
          topicId: { type: "string" }
        }
      }
    },
{
      name: "forum_upload_media",
      description: "Upload an image or any file from an https `url` (server fetches the bytes, no base64 crosses the MCP boundary) to Workspace Forum media (R2), and return a public URL to embed in Markdown. Files are limited to 50 MB; images render inline via `![alt](url)`, other files attach and link via `[text](url)`. For local binaries, prefer the `upload_begin` / `upload_finalize` direct-upload flow.",
      inputSchema: {
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", maxLength: 2048, description: "https URL of the image/file to upload (≤50 MB)." },
          fileName: { type: "string", maxLength: 180, description: "Display file name. Defaults to the URL basename." },
          mimeType: { type: "string", maxLength: 120, description: "MIME type. Derives from the URL response when omitted." }
        }
      }
    },
{
      name: "upload_begin",
      description: "Begin a direct binary upload to Workspace storage (R2). Returns a one-time `uploadUrl` that the client PUTs raw bytes to, plus `uploadId`/`r2Key`/`expiresAt`. All files (≤50 MB) use this flow; call `upload_finalize` after the PUT to get the public URL.",
      inputSchema: {
        type: "object",
        required: ["fileName", "mimeType"],
        properties: {
          fileName: { type: "string", maxLength: 180, description: "Display file name." },
          mimeType: { type: "string", maxLength: 120, description: "MIME type (e.g. image/png, application/pdf)." },
          size: { type: "integer", minimum: 1, maximum: MAX_UPLOAD_BYTES, description: "Declared byte size (enforced again at finalize)." }
        }
      }
    },
{
      name: "upload_finalize",
      description: "Finalize a direct upload started by `upload_begin`. Validates the object in R2 (non-empty, ≤50 MB), registers the owner/audit, and returns the public URL to embed in Markdown (images inline via `![]()`, other files as attachment links `[]()`).",
      inputSchema: {
        type: "object",
        required: ["uploadId", "r2Key", "fileName", "mimeType"],
        properties: {
          uploadId: { type: "string", maxLength: 120 },
          r2Key: { type: "string", maxLength: 260 },
          fileName: { type: "string", maxLength: 180 },
          mimeType: { type: "string", maxLength: 120 }
        }
      }
    },
{
      name: "forum_create_reply",
      description: "Publish a Markdown reply to an existing open Frontier Workspace forum topic as the current Workspace user.",
      inputSchema: {
        type: "object",
        required: ["topicId", "bodyMarkdown"],
        properties: {
          topicId: { type: "string" },
          bodyMarkdown: { type: "string", maxLength: MAX_FORUM_BODY_CHARS }
        }
      }
    }
];
