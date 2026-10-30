import { FeedbackNotice } from "../../../../src/portal/components/FeedbackNotice";
import { useEffect, useState } from "react";
import { ArrowRightToLine, Download, Link2, Maximize2, Minimize2, Save, X } from "lucide-react";
import { useI18n } from "../../../../src/portal/i18n";
import { knowledgeFetch } from "../../../../src/portal/knowledge/utils";
import { KnowledgeFolderPicker, type SelectedKnowledgeFolder } from "../../../../src/portal/knowledge/KnowledgeFolderPicker";
import { renderMarkdown } from "../../../../src/shared/markdownRenderer";
import { filePreviewKind, parseCsvPreview, type CsvPreview } from "../../../../src/shared/filePreview";
import { PortalUtilityRailPanel, usePortalRightRail } from "./PortalUtilityRail";

export type MateArtifact = {
  name: string;
  load: () => Promise<Blob>;
  preview?: () => Promise<Blob>;
  save?: (folderId: string) => Promise<{ knowledgeFile: { objectId: string; path: string } }>;
};

export function MateArtifactPreview({ artifact, onClose }: { artifact: MateArtifact | null; onClose: () => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const rail = usePortalRightRail();
  const [width, setWidth] = useState(560);
  const [file, setFile] = useState<{ csv?: CsvPreview; url: string; kind: string; text?: string }>();
  const [error, setError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [knowledgeFile, setKnowledgeFile] = useState<{ objectId: string; path: string }>();
  const [shareUrl, setShareUrl] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [folderPickerMode, setFolderPickerMode] = useState<"save" | "save-and-share" | null>(null);
  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    setFile(undefined);
    setError(false);
    setKnowledgeFile(undefined);
    setShareUrl("");
    setActionError("");
    if (artifact) void artifact.load().then(async blob => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      // A conversion failure must still leave the original file downloadable.
      if (artifact.preview) setFile({ url, kind: "download" });
      const preview = artifact.preview ? await artifact.preview() : blob;
      const kind = filePreviewKind(artifact.name, preview.type);
      const text = ["csv", "html", "markdown", "text"].includes(kind) ? await preview.text() : undefined;
      const csv = kind === "csv" ? parseCsvPreview(text || "") : undefined;
      if (cancelled) return;
      setFile({ url, kind, text, ...(csv ? { csv } : {}) });
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [artifact, retryKey]);
  useEffect(() => {
    if (!artifact) return;
    const shell = rail?.host?.closest<HTMLElement>(".portal-shell");
    if (!shell) return;
    shell.style.setProperty("--portal-utility-width", `${width}px`);
    return () => { shell.style.removeProperty("--portal-utility-width"); };
  }, [artifact, rail?.host, width]);
  useEffect(() => {
    if (!artifact) return;
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [artifact, onClose]);
  const resize = (next: number) => setWidth(Math.round(Math.max(320, Math.min(next, window.innerWidth - 360))));
  const expandedWidth = Math.max(320, Math.min(860, window.innerWidth - 360));
  const expanded = width >= expandedWidth;
  async function saveToFolder(folder: SelectedKnowledgeFolder) {
    const shareAfterSave = folderPickerMode === "save-and-share";
    setFolderPickerMode(null);
    if (!artifact?.save) throw new Error("mate_artifact_save_unavailable");
    setBusy(true);
    setActionError("");
    try {
      const result = await artifact.save(folder.id);
      setKnowledgeFile(result.knowledgeFile);
      setShareUrl("");
      if (shareAfterSave) await share(result.knowledgeFile);
    }
    catch (caught) { setActionError(artifactActionError(caught, zh)); }
    finally { setBusy(false); }
  }
  async function share(file = knowledgeFile) {
    if (!file) { setFolderPickerMode("save-and-share"); return; }
    setBusy(true);
    setActionError("");
    try {
      const result = await knowledgeFetch<{ url?: string; share?: { url?: string } }>(`/api/objects/${encodeURIComponent(file.objectId)}/public-share`, {
        body: JSON.stringify({ expiry: "24h" }), headers: { "Content-Type": "application/json" }, method: "POST"
      });
      const url = result.url || result.share?.url || "";
      if (!url) throw new Error("share_url_missing");
      setShareUrl(url);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
    } catch (caught) { setActionError(artifactActionError(caught, zh)); }
    finally { setBusy(false); }
  }
  async function revokeShare() {
    if (!knowledgeFile) return;
    setBusy(true);
    setActionError("");
    try {
      await knowledgeFetch(`/api/objects/${encodeURIComponent(knowledgeFile.objectId)}/public-share`, { method: "DELETE" });
      setShareUrl("");
    } catch (caught) { setActionError(artifactActionError(caught, zh)); }
    finally { setBusy(false); }
  }
  return <><PortalUtilityRailPanel open={Boolean(artifact)} onClose={onClose} variant="wide">
    <section className="portal-mate-artifact" aria-label={zh ? "Artifact 文件预览" : "Artifact preview"}>
      <div className="portal-mate-artifact-resize" role="separator" aria-label={zh ? "调整预览宽度" : "Resize preview"} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={Math.max(320, window.innerWidth - 360)} aria-valuenow={width} tabIndex={0}
        onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resize(width + (event.key === "ArrowLeft" ? 40 : -40)); } }}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(window.innerWidth - event.clientX); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
      <header className="portal-mate-artifact-header">
        <strong title={artifact?.name}>{artifact?.name}</strong>
        <div className="portal-mate-artifact-actions" role="toolbar" aria-label={zh ? "文件预览操作" : "File preview actions"}>
          {artifact?.save && <button aria-label={zh ? "另存为..." : "Save as..."} disabled={busy} onClick={() => setFolderPickerMode("save")} title={zh ? "选择知识库文件夹" : "Choose Knowledge folder"} type="button"><Save size={16} /><span>{zh ? "另存为..." : "Save as..."}</span></button>}
          {artifact?.save && !shareUrl && <button disabled={busy} onClick={() => void share()} title={knowledgeFile ? zh ? "生成 24 小时公开链接并复制" : "Create and copy a 24-hour public link" : zh ? "选择知识库文件夹并生成分享链接" : "Choose a Knowledge folder and create a public link"} type="button"><Link2 size={16} /><span>{zh ? "分享" : "Share"}</span></button>}
          {shareUrl && <button disabled={busy} onClick={() => void revokeShare()} title={zh ? "撤销公开链接" : "Revoke public link"} type="button"><X size={16} /><span>{zh ? "撤销分享" : "Revoke"}</span></button>}
          {expandedWidth > 560 && <button aria-label={expanded ? zh ? "恢复预览宽度" : "Restore preview width" : zh ? "扩大预览" : "Expand preview"} aria-pressed={expanded} onClick={() => resize(expanded ? 560 : expandedWidth)} title={expanded ? zh ? "恢复预览宽度" : "Restore preview width" : zh ? "扩大预览" : "Expand preview"} type="button">{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>}
          {file && <a href={file.url} download={artifact?.name} aria-label={zh ? "下载文件" : "Download file"} title={zh ? "下载文件" : "Download file"}><Download size={16} /></a>}
          <button aria-label={zh ? "关闭" : "Close"} className="portal-mate-artifact-back" onClick={onClose} title={zh ? "关闭" : "Close"} type="button"><ArrowRightToLine size={16} /></button>
        </div>
      </header>
      {(knowledgeFile || shareUrl || actionError) && <div className="portal-mate-artifact-status" role="status">
        {knowledgeFile && <span>{zh ? "已保存到知识库" : "Saved to Knowledge"} / {knowledgeFile.path}</span>}
        {shareUrl && <span>{zh ? "公开链接有效期 24 小时：" : "Public link, valid for 24 hours: "}<a href={shareUrl} rel="noreferrer" target="_blank">{shareUrl}</a></span>}
        {actionError && <span className="portal-mate-artifact-error">{zh ? "操作失败：" : "Action failed: "}{actionError}</span>}
      </div>}
      <div className="portal-mate-artifact-body">
        {error ? <div><FeedbackNotice tone="error">{zh ? "文件暂时无法加载。" : "The file is temporarily unavailable."}</FeedbackNotice><button onClick={() => setRetryKey((key) => key + 1)} type="button">{zh ? "重试加载文件" : "Retry loading file"}</button></div> : !file ? <p role="status">{zh ? "正在加载文件…" : "Loading file…"}</p> : file.kind === "image" ? <img src={file.url} alt={artifact?.name} /> : file.kind === "audio" ? <audio controls preload="metadata" src={file.url} /> : file.kind === "video" ? <video controls preload="metadata" src={file.url} /> : file.kind === "html" ? <iframe title={artifact?.name} sandbox="" srcDoc={file.text} /> : file.kind === "pdf" ? <iframe title={artifact?.name} src={file.url} /> : file.kind === "csv" && file.csv ? <CsvTablePreview preview={file.csv} zh={zh} /> : file.kind === "markdown" ? <article className="portal-mate-artifact-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(file.text || "") }} /> : file.kind === "text" ? <pre>{file.text}</pre> : <p>{zh ? "此格式暂不支持在线预览，请下载查看。" : "Download this file to view its contents."}</p>}
      </div>
    </section>
  </PortalUtilityRailPanel>
    {artifact?.save && folderPickerMode && <KnowledgeFolderPicker mode={folderPickerMode} onClose={() => setFolderPickerMode(null)} onSelect={(folder) => void saveToFolder(folder)} zh={zh} />}
  </>;
}

function CsvTablePreview({ preview, zh }: { preview: CsvPreview; zh: boolean }) {
  const [header = [], ...rows] = preview.rows;
  if (!header.length) return <p>{zh ? "CSV 文件为空。" : "The CSV file is empty."}</p>;
  return <div className="portal-mate-artifact-csv">
    <table>
      <thead><tr>{header.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>
      <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? ""}</td>)}</tr>)}</tbody>
    </table>
    {(preview.truncatedColumns || preview.truncatedRows) && <p className="portal-mate-artifact-csv-note">{zh ? "文件较大，预览仅显示前 2,000 行和前 100 列；下载文件可查看完整内容。" : "This preview shows the first 2,000 rows and 100 columns. Download the file to see all content."}</p>}
  </div>;
}

function artifactActionError(caught: unknown, zh: boolean) {
  const code = caught instanceof Error ? caught.message : String(caught);
  if (code === "knowledge_file_not_scan_clean") return zh
    ? "文件已保存，但知识库尚未完成安全扫描；扫描通过后才能生成公开链接。"
    : "The file was saved, but Knowledge requires a clean security scan before public sharing.";
  if (code === "mate_artifact_knowledge_upload_too_large") return zh
    ? "文件超过知识库当前的 25 MB 上传上限。"
    : "The file exceeds the current 25 MB Knowledge upload limit.";
  return code;
}
