import Taro from "@tarojs/taro";

export type SelectedFile = { path: string; name: string; size: number; type?: string };
export type FileSource = "chat" | "album";
const ALBUM_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "avif", "tif", "tiff"]);

export async function chooseFileSource(): Promise<FileSource> {
  const result = await Taro.showActionSheet({ itemList: ["从微信聊天选择文件", "从相册选择照片"] });
  return result.tapIndex === 0 ? "chat" : "album";
}

export async function chooseFiles(source: FileSource, count: number): Promise<SelectedFile[]> {
  if (!Number.isInteger(count) || count < 1) return [];
  count = Math.min(count, 5);
  if (source === "chat") {
    const result = await Taro.chooseMessageFile({ count, type: "all" });
    return result.tempFiles.slice(0, count).map((file) => ({ path: file.path, name: file.name, size: file.size }));
  }
  const result = await Taro.chooseMedia({ count, mediaType: ["image"], sourceType: ["album"], sizeType: ["original"] });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 15);
  return Promise.all(result.tempFiles.slice(0, count).map(async (file, index) => {
    const fromPath = file.tempFilePath.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1]?.toLowerCase();
    const info = fromPath && ALBUM_IMAGE_EXTENSIONS.has(fromPath) ? undefined : await Taro.getImageInfo({ src: file.tempFilePath }).catch(() => undefined);
    const extension = fromPath && ALBUM_IMAGE_EXTENSIONS.has(fromPath) ? fromPath : info?.type?.toLowerCase() || "jpg";
    const type = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "tif" ? "image/tiff" : `image/${extension}`;
    return { path: file.tempFilePath, name: `照片-${stamp}-${index + 1}.${extension}`, size: file.size, type };
  }));
}

export function isPickerCancelled(caught: unknown) {
  const error = caught as { errMsg?: string; message?: string } | undefined;
  return /cancel|取消/i.test(String(error?.errMsg || error?.message || ""));
}
