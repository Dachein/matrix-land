import { LEGACY_MATE_INBOX_PROMPT, type WorkspaceAgentRuntimeManifest, type MateDocument } from "./mate.ts";

export const MATE_MAIL_MAX_LENGTH = 24_000;

/** Old immutable releases remain readable; all newly saved drafts use mail.md. */
export function mateMailContent(manifest: WorkspaceAgentRuntimeManifest, documents: MateDocument[], isDefault = true): string {
  const ref = manifest.release.mail;
  if (!ref) return manifest.channels.inbox.email.inboxPrompt ?? (isDefault ? "" : LEGACY_MATE_INBOX_PROMPT);
  const mailDocuments = documents.filter(document => document.kind === "mail");
  const matches = mailDocuments.filter(document => document.id === ref.id && document.version === ref.version);
  const document = matches[0];
  if (mailDocuments.length !== 1 || matches.length !== 1 || !document || document.digest !== ref.digest || typeof document.content !== "string") {
    throw new Error("mate_mail_document_reference_mismatch");
  }
  return document.content;
}

export async function ensureMateMailDocument(manifest: WorkspaceAgentRuntimeManifest, documents: MateDocument[], isDefault = true) {
  if (manifest.release.mail || documents.some(document => document.kind === "mail")) return;
  const email = manifest.channels.inbox.email;
  if (email.inboxPrompt !== undefined && typeof email.inboxPrompt !== "string") return;
  const legacySender = email.inboxPrompt === undefined && !isDefault;
  const content = mateMailContent(manifest, documents, isDefault);
  const document: MateDocument = {
    kind: "mail", id: `${manifest.mate.mateId}-mail`, version: 1,
    content, digest: await mailDocumentDigest(content)
  };
  documents.push(document);
  manifest.release.mail = { id: document.id, version: document.version, digest: document.digest };
  // Preserve the existing sender's authority when upgrading a legacy shared Mate.
  email.taskAuthority = legacySender ? "verified_sender" : "owner";
  delete email.inboxPrompt;
}

export async function setMateMailContent(manifest: WorkspaceAgentRuntimeManifest, documents: MateDocument[], content: string) {
  if (typeof content !== "string" || content.length > MATE_MAIL_MAX_LENGTH) throw new Error("mate_mail_document_invalid");
  const ref = manifest.release.mail;
  const document = documents.find(document => document.kind === "mail" && document.id === ref?.id && document.version === ref.version);
  if (!ref || !document) throw new Error("mate_mail_document_missing");
  document.content = content;
  document.digest = await mailDocumentDigest(content);
  ref.digest = document.digest;
  delete manifest.channels.inbox.email.inboxPrompt;
}

export async function mailDocumentDigest(content: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
