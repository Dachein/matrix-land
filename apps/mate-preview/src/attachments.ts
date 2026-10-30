import type { MateUploadedAttachment } from "./api";
import { safeChatError } from "./chatErrors.ts";

export type PendingChatAttachment = {
  file: File;
  id: string;
  previewUrl?: string;
  uploaded?: { scope: string; file: MateUploadedAttachment };
};

export type AttachmentUploadFailure = { id: string; fileName: string; code: string };

// Wait for every upload before restoring the queue. A failed upload must never
// submit a message that silently omits a requested file.
export async function prepareChatAttachments(
  attachments: PendingChatAttachment[],
  scope: string,
  upload: (file: File) => Promise<MateUploadedAttachment>
) {
  const results = await Promise.allSettled(attachments.map(async (attachment) => (
    attachment.uploaded?.scope === scope
      ? Promise.resolve(attachment.uploaded.file)
      : upload(attachment.file)
  )));
  const files: MateUploadedAttachment[] = [];
  const failures: AttachmentUploadFailure[] = [];
  const pending = attachments.map((attachment, index) => {
    const result = results[index]!;
    if (result.status === "fulfilled") {
      files.push(result.value);
      return { ...attachment, uploaded: { scope, file: result.value } };
    }
    failures.push({ id: attachment.id, fileName: attachment.file.name, code: safeChatError(result.reason) });
    return attachment;
  });
  return { files, failures, pending };
}

export function attachmentUploadErrorLabel(failures: AttachmentUploadFailure[], english: boolean) {
  const names = failures.map((failure) => failure.fileName).join(english ? ", " : "、");
  return english
    ? `File upload failed: ${names}. Retry or remove the failed files to continue. Your conversation is still available.`
    : `文件上传失败：${names}。请重试，或移除失败文件后继续发送。当前对话仍可使用。`;
}

type ClipboardFileItem = {
  getAsFile: () => File | null;
  kind: string;
};

export function filesFromClipboard(items: ArrayLike<ClipboardFileItem>): File[] {
  return Array.from(items).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}
