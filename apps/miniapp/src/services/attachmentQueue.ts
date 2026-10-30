import type { UploadedAttachment } from "../types";
import type { SelectedFile } from "./fileSelection";

/** A failed file must not discard successful uploads or upload them again on retry. */
export async function uploadAttachmentBatch(files: SelectedFile[], upload: (file: SelectedFile) => Promise<UploadedAttachment>) {
  const results = await Promise.allSettled(files.map(upload));
  const uploaded: UploadedAttachment[] = [];
  const failed: Array<{ file: SelectedFile; error: unknown }> = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") uploaded.push(result.value);
    else failed.push({ file: files[index], error: result.reason });
  });
  return { uploaded, failed };
}
