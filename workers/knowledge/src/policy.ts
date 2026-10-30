import type { Env } from "./types.ts";

// Shared Knowledge content and upload limits; environment values cannot exceed these hard limits.
export function effectiveKnowledgePolicy(env: Env) {
  return {
    html: {
      interactiveExplicitFormats: ["deck", "interactive"],
      interactiveModeEnabled: env.KNOWLEDGE_HTML_INTERACTIVE_ENABLED !== "0",
      ordinaryMode: "static"
    },
    limits: {
      audioFileBytes: configuredKnowledgeLimit(env.KNOWLEDGE_MAX_AUDIO_FILE_BYTES, 512 * 1024 * 1024),
      fileBytes: configuredKnowledgeLimit(env.KNOWLEDGE_MAX_FILE_BYTES, MAX_KNOWLEDGE_FILE_BYTES),
      textIndexBytes: configuredKnowledgeLimit(env.KNOWLEDGE_MAX_TEXT_INDEX_BYTES, KNOWLEDGE_ACTION_MAX_TEXT_BYTES),
      zipBytes: configuredKnowledgeLimit(env.KNOWLEDGE_MAX_ZIP_BYTES, MAX_KNOWLEDGE_ZIP_BYTES),
      zipEntries: configuredKnowledgeLimit(env.KNOWLEDGE_MAX_ZIP_ENTRIES, MAX_KNOWLEDGE_ZIP_ENTRIES),
      zipUncompressedBytes: configuredKnowledgeLimit(
        env.KNOWLEDGE_MAX_ZIP_UNCOMPRESSED_BYTES,
        MAX_KNOWLEDGE_ZIP_UNCOMPRESSED_BYTES
      )
    },
    scan: {
      binaryDefault: "pending",
      builtInUtf8Text: "clean",
      publicShareRequires: "clean",
      serviceIndexRequires: "clean"
    },
    schemaVersion: "workspace.knowledge-policy.v1"
  };
}

function configuredKnowledgeLimit(raw: string | undefined, hardMaximum: number) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return hardMaximum;
  }
  return Math.max(1, Math.min(hardMaximum, Math.trunc(parsed)));
}

export const HANDBOOK_FILE_NAME = "handbook.md";

export const KNOWLEDGE_ACTION_MAX_TEXT_BYTES = 1_000_000;

export const KNOWLEDGE_ACTION_MAX_READ_BYTES = 2_000_000;

export const KNOWLEDGE_ACTION_MAX_CONTENT_CHARS = 200_000;

const MAX_KNOWLEDGE_FILE_BYTES = 25_000_000;

const MAX_KNOWLEDGE_ZIP_BYTES = 20 * 1024 * 1024;

const MAX_KNOWLEDGE_ZIP_ENTRIES = 500;

const MAX_KNOWLEDGE_ZIP_UNCOMPRESSED_BYTES = 50_000_000;
