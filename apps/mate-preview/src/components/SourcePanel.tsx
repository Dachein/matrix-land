import { Download, FileOutput, Folder, Save, Search, X } from "lucide-react";
import { useState } from "react";
import type { PreviewMessagePartView } from "../messageParts";
import { useMateLocale } from "../locale";
import { KnowledgeFolderPicker } from "../../../../src/portal/knowledge/KnowledgeFolderPicker";
import { MateFileLink } from "./MateFileLink";

export function ConversationSourcePanel({ downloadsEnabled, filesOnly = false, onClose, onDownload, onPreview, onSave, resources }: {
  downloadsEnabled: boolean;
  filesOnly?: boolean;
  onClose: () => void;
  onDownload: (url: string, fileName: string) => void;
  onPreview?: (url: string, name: string) => void;
  onSave?: (url: string, folderId: string) => Promise<boolean>;
  resources: PreviewMessagePartView[];
}) {
  const { locale, text } = useMateLocale();
  const [saved, setSaved] = useState<string[]>([]);
  const [saving, setSaving] = useState<string[]>([]);
  const [pickerUrl, setPickerUrl] = useState("");
  return (
    <><aside className="tm-preview-sources" aria-label={text("文件与来源", "Files and sources")} data-testid="preview-source-panel">
      <header>
        <div><span className="tm-preview-eyebrow">{text("对话上下文", "Conversation context")}</span><h2>{text("文件与来源", "Files and sources")}</h2></div>
        <button aria-label={text("关闭文件与来源", "Close files and sources")} onClick={onClose} type="button"><X size={16} /></button>
      </header>
      <p>{text("这里只显示当前 Agent 对话返回的引用与生成文件；资源权限仍按当前用户实时校验。", "Only citations and generated files returned in this Agent conversation appear here. Resource access is still verified for the current user.")}</p>
      <div className="tm-preview-source-list">
        {resources.length ? resources.map((resource, index) => (
          <article key={`${resource.kind}-${resource.label}-${resource.text}-${index}`}>
            <span>{resource.kind === "artifact" ? <FileOutput size={16} /> : <Search size={16} />}</span>
            <div className="tm-preview-source-details">{resource.kind === "artifact" && resource.text.startsWith("/api/workspace-files/")
              ? <MateFileLink fileName={resource.label || "mate-file"} onOpen={downloadsEnabled ? onPreview ?? onDownload : undefined} url={resource.text}><strong>{localizedResourceLabel(resource.label, resource.kind, text)}</strong><small>{workspaceFileLabel(resource.text, text)}</small></MateFileLink>
              : <><strong>{localizedResourceLabel(resource.label, resource.kind, text)}</strong><small title={resource.text}>{resource.text}</small></>}</div>
            {downloadsEnabled && !onPreview && resource.kind === "artifact" && resource.text.startsWith("/api/workspace-files/") && (
              <button aria-label={text(`下载 ${resource.label || "文件"}`, `Download ${resource.label || "file"}`)} onClick={() => onDownload(resource.text, resource.label || "mate-file")} type="button"><Download size={13} /></button>
            )}
            {downloadsEnabled && onSave && !onPreview && resource.kind === "artifact" && /^\/api\/workspace-files\/art_[0-9a-f-]{36}\/(raw|download)$/.test(resource.text) && (
              <button
                aria-label={text(`将 ${resource.label || "文件"} 保存到知识库`, `Save ${resource.label || "file"} to Knowledge`)}
                disabled={saved.includes(resource.text) || saving.includes(resource.text)}
                onClick={() => setPickerUrl(resource.text)}
                type="button"
              ><Save size={13} />{saved.includes(resource.text) ? text("已保存到知识库", "Saved to Knowledge") : saving.includes(resource.text) ? text("保存中…", "Saving…") : text("保存到知识库", "Save to Knowledge")}</button>
            )}
          </article>
        )) : <div className="tm-preview-source-empty"><Folder size={24} /><strong>{filesOnly ? text("当前对话暂无文件", "No files in this conversation") : text("暂时没有来源或文件", "No sources or files yet")}</strong><span>{text("Agent 调用知识库、应用工具或创建文件后会显示在这里。", "Sources appear here after the Agent uses knowledge, app tools, or creates files.")}</span></div>}
      </div>
    </aside>
    {pickerUrl && onSave && <KnowledgeFolderPicker onClose={() => setPickerUrl("")} onSelect={(folder) => {
      const url = pickerUrl;
      setPickerUrl("");
      setSaving((current) => [...current, url]);
      void onSave(url, folder.id).then((ok) => { if (ok) setSaved((current) => [...current, url]); })
        .finally(() => setSaving((current) => current.filter((item) => item !== url)));
    }} zh={locale === "zh-CN"} />}
    </>
  );
}

function workspaceFileLabel(url: string, text: (chinese: string, english: string) => string) {
  return /^\/api\/workspace-files\/art_/.test(url)
    ? text("Mate 私有暂存 · 7 天", "Private Mate storage · 7 days")
    : text("资料库文件", "Knowledge file");
}

function localizedResourceLabel(label: string | undefined, kind: PreviewMessagePartView["kind"], text: (chinese: string, english: string) => string) {
  const known: Record<string, string> = {
    "公开网页": text("公开网页", "Public webpage"),
    "网页来源": text("网页来源", "Web source"),
    "网页搜索结果": text("网页搜索结果", "Web search result"),
    "文档来源": text("文档来源", "Document source")
  };
  return (label ? known[label] : undefined) || label || (kind === "artifact" ? text("文件", "File") : text("来源", "Source"));
}

export default ConversationSourcePanel;
