import { Button, Image, RichText, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useLoad, useUnload } from "@tarojs/taro";
import { useMemo, useRef, useState } from "react";
import { fileTypeIcon } from "../../services/fileTypeIcons";
import { openNativeFilePreview, sharePreviewFile } from "../../services/fileActions";
import { fileRichText } from "../../services/fileRichText";
import { isPickerCancelled } from "../../services/fileSelection";
import { redirectToLogin, requireAuth, saveWorkspaceFileToKnowledge } from "../../services/api";
import { KnowledgeFolderPicker } from "../../components/KnowledgeFolderPicker";
import { isAuthRequiredError } from "../../services/auth";
import { useI18n } from "../../services/i18n";
import { getFilePreview, filePreviewKind, type FilePreviewKind, type FilePreviewSelection } from "../../services/filePreview";
import { loadFilePreviewSource } from "../../services/filePreviewSource";
import "./index.scss";

export default function FilePreviewPage() {
  const { t } = useI18n();
  const [file, setFile] = useState<FilePreviewSelection>();
  const [kind, setKind] = useState<FilePreviewKind>("unsupported");
  const [imagePath, setImagePath] = useState("");
  const [pdfPath, setPdfPath] = useState("");
  const [content, setContent] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [opening, setOpening] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [metadataCollapsed, setMetadataCollapsed] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const previewRevision = useRef(0);
  const documentBusy = useRef(false);
  const shareBusy = useRef(false);
  const disposePreview = useRef<(() => void)>();
  useUnload(() => { previewRevision.current += 1; disposePreview.current?.(); });
  const [saveError, setSaveError] = useState("");
  const navigation = useMemo(() => customNavigationMetrics(), []);
  const richText = useMemo(() => content === undefined ? undefined : fileRichText(content, kind === "html" ? "html" : "markdown"), [content, kind]);
  const canSave = /^\/api\/workspace-files\/art_[0-9a-f-]{36}\/(?:raw|download)$/.test(file?.workspace?.url || "");

  async function saveToFolder(folderId: string) {
    if (!file?.workspace || savingRef.current) return;
    savingRef.current = true; setSaving(true); setSaveError("");
    try {
      await saveWorkspaceFileToKnowledge(file.workspace.session, file.workspace.url, folderId);
      setChoosingFolder(false);
      await Taro.showToast({ title: t("knowledge.saved", { name: file.name }), icon: "success" });
    } catch (caught) {
      if (isAuthRequiredError(caught)) redirectToLogin();
      else setSaveError(t("files.saveFailed"));
    } finally { savingRef.current = false; setSaving(false); }
  }

  useLoad((options) => {
    if (!requireAuth()) return;
    const id = options.id || "";
    let selected = getFilePreview(id);
    if (!selected) {
      try { selected = getFilePreview(decodeURIComponent(id)); } catch { /* Invalid IDs fail the selection lookup. */ }
    }
    if (!selected) { setError(t("knowledge.openFailed")); setLoading(false); return; }
    setFile(selected);
    const nextKind = filePreviewKind(selected.name, selected.mimeType);
    setKind(nextKind);
    if (nextKind === "unsupported") { setLoading(false); return; }
    void loadPreview(selected, nextKind);
  });

  async function loadPreview(selected: FilePreviewSelection, previewKind: FilePreviewKind) {
    const revision = ++previewRevision.current;
    setLoading(true);
    setError("");
    setImagePath(""); setPdfPath("");
    setContent(undefined); setTruncated(false);
    try {
      const loaded = await loadFilePreviewSource(selected, previewKind);
      if (revision !== previewRevision.current) { loaded.dispose?.(); return; }
      disposePreview.current?.();
      disposePreview.current = loaded.dispose;
      const resolved = { ...selected, name: loaded.name || selected.name, mimeType: loaded.mimeType || selected.mimeType, modifiedAt: loaded.modifiedAt || selected.modifiedAt };
      setFile(resolved);
      if (loaded.text !== undefined) { setContent(loaded.text); setTruncated(!!loaded.truncated); }
      if (loaded.imagePath) setImagePath(loaded.imagePath);
      if (loaded.pdfPath) {
        setPdfPath(loaded.pdfPath);
        void openDocument(loaded.pdfPath, resolved);
      }
    } catch (caught) {
      if (revision !== previewRevision.current) return;
      if (isAuthRequiredError(caught)) { redirectToLogin(); return; }
      setError(t("knowledge.openFailed"));
    } finally { if (revision === previewRevision.current) setLoading(false); }
  }

  function goBack() {
    void Taro.navigateBack().catch(() => Taro.redirectTo({ url: file?.workspace ? "/pages/chat/index" : "/pages/knowledge/index" }));
  }

  async function openDocument(path: string, selected = file) {
    if (!selected || documentBusy.current) return;
    documentBusy.current = true;
    setOpening(true); setError("");
    try { await openNativeFilePreview(path, selected); }
    catch (error) {
      if (!isPickerCancelled(error)) { setError(t("preview.documentOpenFailed")); }
    }
    finally { documentBusy.current = false; setOpening(false); }
  }

  async function shareFile() {
    if (!file || !pdfPath || shareBusy.current) return;
    shareBusy.current = true; setSharing(true); setError("");
    try { await sharePreviewFile(pdfPath, file); }
    catch (caught) { if (!isPickerCancelled(caught)) setError(t("preview.shareFailed")); }
    finally { shareBusy.current = false; setSharing(false); }
  }

  const kindLabel = t(`preview.${kind === "unsupported" ? "file" : kind}`);
  const updatedAt = formatModifiedAt(file?.modifiedAt);

  return <View className="knowledge-preview-page">
    <View className="knowledge-preview-top" style={{ height: `${navigation.height}px`, paddingTop: `${navigation.statusBarHeight}px` }}>
      <Text className="knowledge-preview-back" onClick={goBack} aria-label={t("preview.back")}>‹</Text>
      <Text className="knowledge-preview-title">{t("preview.title")}</Text>
      <View className="knowledge-preview-spacer" />
    </View>
    <View className={`knowledge-preview-meta${metadataCollapsed ? " is-collapsed" : ""}`}>
      <View className="knowledge-preview-file">
        <Text className="knowledge-preview-name">{file?.name || t("preview.file")}</Text>
        <Text className="knowledge-preview-kind">{kindLabel}</Text>
      </View>
      {updatedAt && <Text className="knowledge-preview-updated">{t("preview.updated", { date: updatedAt })}</Text>}
    </View>
    <ScrollView className="knowledge-preview-body" scrollY onScroll={(event) => setMetadataCollapsed(event.detail.scrollTop > 36)}>
      {loading && <Text className="knowledge-preview-status">{t("preview.loading")}</Text>}
      {error && <View className="knowledge-preview-error"><Text>{error}</Text>{file && !pdfPath && !imagePath && content === undefined && <>
        <UnsupportedFileDetails file={file} unsupported={kind === "unsupported"} />
        {kind !== "unsupported" && <Button onClick={() => void loadPreview(file, kind)}>{t("common.retry")}</Button>}
      </>}</View>}
      {!loading && <>
        {richText && <View className={`knowledge-preview-rich knowledge-preview-${kind}`}>
          {(truncated || richText.truncated) && <Text className="knowledge-preview-note">{t("preview.contentLimit")}</Text>}
          {richText.nodes.length ? <RichText nodes={richText.nodes} userSelect /> : <Text className="knowledge-preview-note">{t("preview.empty")}</Text>}
        </View>}
        {kind === "image" && imagePath && <View className="knowledge-preview-image"><Image src={imagePath} mode="widthFix" onClick={() => void openDocument(imagePath)} onError={() => setError(t("preview.imageFailed"))} /><Text className="knowledge-preview-note" onClick={() => void openDocument(imagePath)}>{t("preview.viewImage")}</Text></View>}
        {(kind === "pdf" || kind === "document") && pdfPath && <View className="knowledge-preview-pdf">
          <Image src={fileTypeIcon(file?.name || "", file?.mimeType)} mode="aspectFit" />
          <Button onClick={() => void openDocument(pdfPath)} disabled={opening || sharing} loading={opening}>{t(opening ? "preview.openingDocument" : kind === "pdf" ? "preview.openPdf" : "preview.openDocument")}</Button>
          {kind === "document" && <><Button className="knowledge-preview-share" onClick={() => void shareFile()} disabled={opening || sharing} loading={sharing}>{t("preview.shareFile")}</Button><Text className="knowledge-preview-note">{t("preview.officeHelp")}</Text></>}
        </View>}
        {kind === "unsupported" && file && <UnsupportedFileDetails file={file} />}
      </>}
    </ScrollView>
    {canSave && <View className="file-save-footer"><Button className="primary" onClick={() => setChoosingFolder(true)}>{t("files.saveKnowledge")}</Button></View>}
    {choosingFolder && <KnowledgeFolderPicker onClose={() => setChoosingFolder(false)} onSelect={(folderId) => void saveToFolder(folderId)} busy={saving} error={saveError} />}
  </View>;
}

function UnsupportedFileDetails({ file, unsupported = true }: { file: FilePreviewSelection; unsupported?: boolean }) {
  const { t } = useI18n();
  return <View className="knowledge-preview-unsupported">
    {unsupported && <><Text className="knowledge-preview-unsupported-title">{t("preview.unsupported")}</Text>
    <Text className="knowledge-preview-unsupported-help">{t("preview.unsupportedHelp")}</Text></>}
    <View className="knowledge-preview-detail"><Text>{t("preview.type")}</Text><Text>{file.mimeType || file.name.match(/\.[^.]+$/)?.[0] || t("preview.unknown")}</Text></View>
    <View className="knowledge-preview-detail"><Text>{t("preview.size")}</Text><Text>{typeof file.sizeBytes === "number" ? formatSize(file.sizeBytes) : t("preview.unknown")}</Text></View>
  </View>;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModifiedAt(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const two = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function customNavigationMetrics() {
  const windowInfo = Taro.getWindowInfo();
  const capsule = Taro.getMenuButtonBoundingClientRect();
  const statusBarHeight = windowInfo.statusBarHeight || capsule.top || 20;
  const gap = Math.max(4, capsule.top - statusBarHeight);
  return { height: capsule.bottom + gap, statusBarHeight };
}
