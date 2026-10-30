import Taro from "@tarojs/taro";
import { downloadWorkspaceFile, readKnowledgeLibraryFile } from "./api";
import { workspaceImages } from "./workspaceImages";
import { documentFileType, type FilePreviewKind, type FilePreviewSelection } from "./filePreview";

export type LoadedFilePreview = {
  name?: string;
  mimeType?: string;
  modifiedAt?: string;
  imagePath?: string;
  pdfPath?: string;
  text?: string;
  truncated?: boolean;
  dispose?: () => void;
};

/** The source changes how bytes are fetched; every source uses the same preview renderer. */
let previewSequence = 0;
export const MAX_PREVIEW_CHARACTERS = 200_000;
const MAX_TEXT_BYTES = MAX_PREVIEW_CHARACTERS * 4;

function textPreview(text: string, truncated = false) {
  const normalized = text.replace(/^\uFEFF/, "");
  return { text: normalized.slice(0, MAX_PREVIEW_CHARACTERS).replace(/[\uD800-\uDBFF]$/, ""), truncated: truncated || normalized.length > MAX_PREVIEW_CHARACTERS };
}

async function readPreviewText(path: string) {
  const fs = Taro.getFileSystemManager();
  const size = await new Promise<number>((resolve, reject) => fs.getFileInfo({
    filePath: path, success: (result) => resolve(result.size), fail: reject
  }));
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("text_file_size_invalid");
  if (!size) return textPreview("");
  const result = await new Promise<string>((resolve, reject) => fs.readFile({
    filePath: path, encoding: "utf8", length: Math.min(size, MAX_TEXT_BYTES),
    success: (result) => typeof result.data === "string" ? resolve(result.data) : reject(new Error("text_content_missing")), fail: reject
  }));
  return textPreview(result, size > MAX_TEXT_BYTES);
}

export async function loadFilePreviewSource(file: FilePreviewSelection, kind: FilePreviewKind): Promise<LoadedFilePreview> {
  if (kind === "unsupported") return {};
  const textual = kind === "html" || kind === "markdown";
  if (file.workspace) {
    const path = await (kind === "image" ? workspaceImages.load(file.workspace.session, file.workspace.url) : downloadWorkspaceFile(file.workspace.session, file.workspace.url));
    if (textual) {
      try { return await readPreviewText(path); }
      finally { Taro.getFileSystemManager().unlink({ filePath: path, success: () => {}, fail: () => {} }); }
    }
    if (kind === "image") return { imagePath: path };
    return { pdfPath: path };
  }

  const payload = await readKnowledgeLibraryFile(file.id);
  const metadata = {
    name: payload.file.fileName || file.name,
    mimeType: payload.file.mimeType || file.mimeType,
    modifiedAt: payload.file.modifiedAt || file.modifiedAt
  };
  if (textual && payload.content.encoding === "text") return { ...metadata, ...textPreview(payload.content.text) };
  if (payload.content.encoding !== "base64") throw new Error("binary_content_missing");
  const base64 = payload.content.base64;
  const extension = textual ? ".txt" : kind === "pdf" ? ".pdf" : kind === "document" ? `.${documentFileType(file.name, file.mimeType) || "docx"}` : file.name.match(/\.(?:png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i)?.[0] || ".png";
  const path = `${Taro.env.USER_DATA_PATH}/file-preview-${Date.now()}-${++previewSequence}${extension}`;
  await new Promise<void>((resolve, reject) => Taro.getFileSystemManager().writeFile({
    filePath: path,
    data: base64,
    encoding: "base64",
    success: () => resolve(),
    fail: reject
  }));
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    Taro.getFileSystemManager().unlink({ filePath: path, success: () => {}, fail: () => {} });
  };
  if (textual) {
    try { return { ...metadata, ...await readPreviewText(path) }; }
    finally { dispose(); }
  }
  return kind === "pdf" || kind === "document" ? { ...metadata, pdfPath: path, dispose } : { ...metadata, imagePath: path, dispose };
}
