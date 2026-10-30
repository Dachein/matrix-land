import pdf from "../assets/file-formats/pdf.png";
import doc from "../assets/file-formats/doc.png";
import sheet from "../assets/file-formats/sheet.png";
import slides from "../assets/file-formats/slides.png";
import html from "../assets/file-formats/html.png";
import markdown from "../assets/file-formats/markdown.png";
import csv from "../assets/file-formats/csv.png";
import image from "../assets/file-formats/image.png";
import archive from "../assets/file-formats/archive.png";
import generic from "../assets/file-formats/generic.png";

export type FileIconKind = "pdf" | "doc" | "sheet" | "slides" | "html" | "markdown" | "csv" | "image" | "archive" | "generic";

const icons: Record<FileIconKind, string> = { pdf, doc, sheet, slides, html, markdown, csv, image, archive, generic };

export function fileIconKind(name: string, mimeType = ""): FileIconKind {
  const extension = name.toLowerCase().split(".").pop() || "";
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  if (extension === "pdf" || mime === "application/pdf") return "pdf";
  if (["doc", "docx", "odt", "rtf"].includes(extension) || /word|opendocument\.text|rtf/.test(mime)) return "doc";
  if (["xls", "xlsx", "ods"].includes(extension) || /spreadsheet|excel/.test(mime)) return "sheet";
  if (["ppt", "pptx", "odp"].includes(extension) || /presentation|powerpoint/.test(mime)) return "slides";
  if (["html", "htm"].includes(extension) || mime === "text/html") return "html";
  if (["md", "markdown", "mdown"].includes(extension) || mime === "text/markdown") return "markdown";
  if (extension === "csv" || mime === "text/csv") return "csv";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "heic", "svg"].includes(extension) || mime.startsWith("image/")) return "image";
  if (["zip", "rar", "7z", "tar", "gz"].includes(extension) || /zip|x-rar|x-7z|x-tar|gzip/.test(mime)) return "archive";
  return "generic";
}

export function fileTypeIcon(name: string, mimeType?: string): string {
  return icons[fileIconKind(name, mimeType)];
}
