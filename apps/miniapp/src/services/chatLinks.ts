import type { ChatMessage } from "../types";
import { mateFileReferencesFromCitations } from "../../../../src/shared/mateFileReference.js";

type MessageLink = { key: string; label: string; url?: string; authorization: boolean };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const safeUrl = (url: string, authorization: boolean) => (authorization ? /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#][^\s"<>]*)?$/i : /^https?:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#][^\s"<>]*)?$/i).test(url);

/** Native chat exposes safe copy links for sources and service authorization. */
export function messageLinks(message: ChatMessage): MessageLink[] {
  const result: MessageLink[] = [];
  const seen = new Set(message.parts.filter((part) => part.type === "source-url").map((part) => part.url));
  for (const part of message.parts) {
    if (part.type === "data-mate-citations") {
      const sources = record(part.data).sources;
      const fileIds = new Set(mateFileReferencesFromCitations(part.data).map((file) => file.objectId));
      for (const source of Array.isArray(sources) ? sources : []) {
        const value = record(source);
        // Workspace references are rendered by the shared file-link component.
        if (fileIds.has(text(value.objectId))) continue;
        const url = text(value.url);
        const label = text(value.title) || [text(value.serviceName), text(value.relativePath)].filter(Boolean).join(" · ") || url;
        if (!label || url && !safeUrl(url, false) || seen.has(url || label)) continue;
        seen.add(url || label);
        result.push({ key: url || label, label, url: url || undefined, authorization: false });
      }
    }
    if (part.state !== "output-available" || (part.toolName !== "mate_mcp_manage" && part.type !== "tool-mate_mcp_manage")) continue;
    const output = record(part.output);
    const url = text(output.authorizationUrl);
    if (!safeUrl(url, true) || seen.has(url)) continue;
    seen.add(url);
    result.push({ key: url, label: text(record(output.connection).name) || "MCP", url, authorization: true });
  }
  return result;
}
