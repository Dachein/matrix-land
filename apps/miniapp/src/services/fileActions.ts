import Taro from "@tarojs/taro";
import { documentFileType, filePreviewKind, type FilePreviewSelection } from "./filePreview";

/** User uploads, generated artifacts and Knowledge files share this single native dispatcher. */
export async function openNativeFilePreview(path: string, file: FilePreviewSelection) {
  if (!path) throw new Error("document_path_missing");
  const kind = filePreviewKind(file.name, file.mimeType);
  if (kind === "image") {
    await Taro.previewImage({ current: path, urls: [path] });
    return;
  }
  const fileType = documentFileType(file.name, file.mimeType);
  if (!fileType) throw new Error("document_type_unsupported");
  await Taro.openDocument({ filePath: path, fileType, showMenu: true });
}

/** The system sheet lets the user choose a chat; it does not send on their behalf. */
export async function sharePreviewFile(path: string, file: FilePreviewSelection) {
  if (!path) throw new Error("document_path_missing");
  if (typeof Taro.shareFileMessage !== "function") throw new Error("file_share_unavailable");
  await Taro.shareFileMessage({ filePath: path, fileName: file.name });
}
