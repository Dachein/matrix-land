import { ArrowUp, Check, ChevronUp, CircleStop, Database, FileText, Plus, RotateCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEvent, FormEvent } from "react";
import type { MateRuntimeCapabilityProfile } from "../api";
import { filesFromClipboard, type PendingChatAttachment } from "../attachments";
import { MATE_DOCUMENT_EXTENSIONS } from "../../../../src/shared/mateAttachments";
import { chatCapabilitySummary, type ChatCapabilityKind, type ChatCapabilitySelection } from "../chatSelection";
import { useMateLocale } from "../locale";

export type { PendingChatAttachment } from "../attachments";

export type ChatAttachmentCapabilities = {
  documents: boolean;
  images: boolean;
  paste: boolean;
};

export function ChatComposer({
  attachments,
  attachmentCapabilities,
  busy,
  canStop,
  draft,
  modelId,
  onAddAttachments,
  onDraftChange,
  onModelChange,
  onRemoveAttachment,
  onResume,
  onStop,
  onSubmit,
  onSetResources,
  onToggleResource,
  profile,
  selection,
  showResume,
  mateName
}: {
  attachments: PendingChatAttachment[];
  attachmentCapabilities: ChatAttachmentCapabilities;
  busy: boolean;
  canStop: boolean;
  draft: string;
  modelId: string;
  onAddAttachments: (files: File[]) => void;
  onDraftChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onRemoveAttachment: (id: string) => void;
  onResume: () => void;
  onStop: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSetResources: (kind: ChatCapabilityKind, ids: string[]) => void;
  onToggleResource: (kind: ChatCapabilityKind, id: string) => void;
  profile?: MateRuntimeCapabilityProfile;
  selection: ChatCapabilitySelection;
  showResume: boolean;
  mateName: string;
}) {
  const { text } = useMateLocale();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentsEnabled = attachmentCapabilities.documents || attachmentCapabilities.images;
  const attachmentAccept = [
    ...(attachmentCapabilities.images ? ["image/*"] : []),
    ...(attachmentCapabilities.documents ? MATE_DOCUMENT_EXTENSIONS : [])
  ].join(",");

  useLayoutEffect(() => resizeTextarea(textareaRef.current), [draft]);

  function pasteAttachments(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!attachmentCapabilities.paste || !attachmentsEnabled || busy) return;
    const files = filesFromClipboard(event.clipboardData.items);
    if (!files.length) return;
    event.preventDefault();
    onAddAttachments(files);
  }

  return (
    <form className="tm-preview-composer" data-testid="preview-composer" onSubmit={onSubmit}>
      <div className="tm-preview-composer-card">
        <div className="tm-preview-capability-controls" data-testid="preview-capability-controls">
          <input
            accept={attachmentAccept}
            hidden
            multiple
            onChange={(event) => { onAddAttachments([...event.target.files ?? []]); event.target.value = ""; }}
            ref={fileInputRef}
            type="file"
          />
          <button
            aria-label={text("添加附件", "Add attachment")}
            className="tm-preview-attachment-trigger"
            disabled={busy || !attachmentsEnabled || attachments.length >= 5}
            onClick={() => fileInputRef.current?.click()}
            title={attachmentsEnabled
              ? attachmentCapabilities.paste
                ? text("添加图片或文件，也可以直接粘贴图片", "Add images or files, or paste an image")
                : text("添加图片或文件", "Add an image or file")
              : text("当前 Release 未启用图片或文档输入", "Image or document input is not enabled for this release")}
            type="button"
          ><Plus aria-hidden="true" size={17} /></button>
          <ResourcePicker
            disabled={!profile || busy}
            onSet={onSetResources}
            onToggle={onToggleResource}
            profile={profile}
            selection={selection}
          />
          <ModelPicker
            disabled={!profile?.models.allowUserSelection || busy || (profile?.models.allowed.length ?? 0) < 2}
            models={profile?.models.allowed ?? []}
            onChange={onModelChange}
            selectedId={modelId}
          />
        </div>

        {attachments.length > 0 && <div className="tm-preview-attachment-queue" aria-label={text("待发送附件", "Pending attachments")}>
          {attachments.map((attachment) => (
            <figure className={attachment.previewUrl ? "is-image" : "is-file"} key={attachment.id}>
              {attachment.previewUrl
                ? <img alt={attachment.file.name} src={attachment.previewUrl} />
                : <span><FileText size={16} /></span>}
              <figcaption>{attachment.file.name}</figcaption>
              <button aria-label={text(`移除附件 ${attachment.file.name}`, `Remove attachment ${attachment.file.name}`)} disabled={busy} onClick={() => onRemoveAttachment(attachment.id)} type="button"><X size={13} /></button>
            </figure>
          ))}
        </div>}

        <div className="tm-preview-composer-input-row">
          <textarea
            aria-label={text(`发送给 ${mateName} 的消息`, `Message ${mateName}`)}
            data-testid="preview-message-input"
            disabled={busy && !draft}
            maxLength={12_000}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            onPaste={pasteAttachments}
            placeholder={text(`输入问题，或给 ${mateName} 一条消息…`, `Ask a question or send ${mateName} a message…`)}
            ref={textareaRef}
            rows={2}
            value={draft}
          />
          {busy && canStop ? (
            <button aria-label={text("停止生成", "Stop generating")} className="tm-preview-composer-icon is-stop" data-testid="preview-cancel" onClick={onStop} title={text("停止生成", "Stop generating")} type="button"><CircleStop size={17} /></button>
          ) : (
            <button aria-label={text("发送消息", "Send message")} className="tm-preview-composer-icon is-primary" data-testid="preview-send" disabled={busy || (!draft.trim() && attachments.length === 0)} title={text("发送消息", "Send message")} type="submit"><ArrowUp aria-hidden="true" size={21} strokeWidth={1.8} /></button>
          )}
        </div>
        {showResume && <div className="tm-preview-composer-footer">
          <button className="tm-preview-resume" data-testid="preview-resume" disabled={busy} onClick={onResume} type="button"><RotateCw size={13} />{text("继续执行", "Continue task")}</button>
        </div>}
      </div>
    </form>
  );
}

function ResourcePicker({ disabled, onSet, onToggle, profile, selection }: {
  disabled: boolean;
  onSet: (kind: ChatCapabilityKind, ids: string[]) => void;
  onToggle: (kind: ChatCapabilityKind, id: string) => void;
  profile?: MateRuntimeCapabilityProfile;
  selection: ChatCapabilitySelection;
}) {
  const { locale, text } = useMateLocale();
  const [open, setOpen] = useState(false);
  const [requestedKind, setRequestedKind] = useState<ChatCapabilityKind>("knowledge");
  const rootRef = useRef<HTMLDivElement>(null);
  const knowledge = profile?.knowledge ?? [];
  const apps = profile?.appMcp ?? [];
  const hasKnowledge = knowledge.length > 0;
  const hasApps = apps.length > 0;
  const activeKind = requestedKind === "knowledge" && hasKnowledge
    ? "knowledge"
    : requestedKind === "app" && hasApps
      ? "app"
      : hasKnowledge ? "knowledge" : "app";

  useEffect(() => {
    if (!open) return;
    function closeOnPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const activeResources = activeKind === "knowledge" ? knowledge : apps;
  const activeIds = activeKind === "knowledge" ? selection.knowledgeServiceIds : selection.appIds;
  const selectedActiveCount = activeResources.filter((resource) => activeIds.includes(resource.id)).length;
  const selectedKnowledgeCount = knowledge.filter((resource) => selection.knowledgeServiceIds.includes(resource.id)).length;
  const selectedAppCount = apps.filter((resource) => selection.appIds.includes(resource.id)).length;
  const allActiveSelected = activeResources.length > 0 && selectedActiveCount === activeResources.length;

  return (
    <div className="tm-preview-resource-picker" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={text(`知识库与应用，${chatCapabilitySummary(selection, locale)}`, `Knowledge & apps, ${chatCapabilitySummary(selection, locale)}`)}
        className="tm-preview-resource-trigger"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Database size={16} />
        <span><small>{text("知识库与应用", "Knowledge & apps")}</small><strong>{chatCapabilitySummary(selection, locale)}</strong></span>
        <ChevronUp className={open ? "is-open" : ""} size={14} />
      </button>
      {open && <div aria-label={text("选择当前对话的知识库与应用", "Select knowledge and apps for this conversation")} className="tm-preview-resource-popover" role="dialog">
        {(hasKnowledge || hasApps) ? <>
          <div className="tm-preview-resource-tabs">
            <div aria-label={text("资源类型", "Resource type")} className="tm-preview-resource-tab-list" role="tablist">
              {hasKnowledge && <button
                aria-controls="tm-preview-knowledge-resources"
                aria-selected={activeKind === "knowledge"}
                className={activeKind === "knowledge" ? "is-active" : ""}
                onClick={() => setRequestedKind("knowledge")}
                role="tab"
                type="button"
              >{text("知识库", "Knowledge")} <span>[{selectedKnowledgeCount}]</span></button>}
              {hasApps && <button
                aria-controls="tm-preview-app-resources"
                aria-selected={activeKind === "app"}
                className={activeKind === "app" ? "is-active" : ""}
                onClick={() => setRequestedKind("app")}
                role="tab"
                type="button"
              >{text("应用", "Apps")} <span>[{selectedAppCount}]</span></button>}
            </div>
            <button
              aria-label={`${activeKind === "knowledge" ? text("知识库", "Knowledge") : text("应用", "Apps")}：${allActiveSelected ? text("取消全选", "Clear all") : text("全选", "Select all")}`}
              className="tm-preview-resource-select-all"
              onClick={() => onSet(activeKind, allActiveSelected ? [] : activeResources.map((resource) => resource.id))}
              type="button"
            >{allActiveSelected ? text("取消全选", "Clear all") : text("全选", "Select all")}</button>
          </div>
          <ResourceGroup
            ids={activeIds}
            kind={activeKind}
            onToggle={onToggle}
            resources={activeResources}
          />
        </> : <p className="tm-preview-resource-empty">{text("此 Mate 当前没有关联知识库或应用。", "This Mate has no linked knowledge or apps.")}</p>}
      </div>}
    </div>
  );
}

function ModelPicker({ disabled, models, onChange, selectedId }: {
  disabled: boolean;
  models: Array<{ id: string; name: string }>;
  onChange: (id: string) => void;
  selectedId: string;
}) {
  const { text } = useMateLocale();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = models.find((model) => model.id === selectedId) ?? models[0];

  useEffect(() => {
    if (!open) return;
    function closeOnPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="tm-preview-model-picker" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={text(`选择模型，当前 ${selected?.name ?? "未配置"}`, `Select model, current ${selected?.name ?? "Not configured"}`)}
        className="tm-preview-model-trigger"
        disabled={!models.length || disabled}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span><small>{text("模型", "Model")}</small><strong>{selected?.name ?? text("未配置", "Not configured")}</strong></span>
        <ChevronUp aria-hidden="true" className={open ? "is-open" : ""} size={14} />
      </button>
      {open && <div aria-label={text("选择模型", "Select model")} className="tm-preview-model-popover" role="listbox">
        <header><strong>{text("模型", "Model")}</strong></header>
        <div className="tm-preview-model-options">
          {models.map((model) => (
            <button
              aria-selected={model.id === selected?.id}
              className={model.id === selected?.id ? "is-selected" : ""}
              key={model.id}
              onClick={() => {
                onChange(model.id);
                setOpen(false);
              }}
              role="option"
              type="button"
            >
              <span><strong>{model.name}</strong></span>
              {model.id === selected?.id && <Check aria-hidden="true" size={16} />}
            </button>
          ))}
        </div>
      </div>}
    </div>
  );
}

function ResourceGroup({ ids, kind, onToggle, resources }: {
  ids: string[];
  kind: ChatCapabilityKind;
  onToggle: (kind: ChatCapabilityKind, id: string) => void;
  resources: Array<{ description?: string; id: string; name?: string }>;
}) {
  const { text } = useMateLocale();
  return (
    <section
      aria-label={kind === "knowledge" ? text("知识库", "Knowledge") : text("应用", "Apps")}
      className="tm-preview-resource-group"
      id={`tm-preview-${kind}-resources`}
      role="tabpanel"
    >
      {resources.map((resource) => {
        const checked = ids.includes(resource.id);
        return (
          <button aria-pressed={checked} className={checked ? "is-selected" : ""} key={resource.id} onClick={() => onToggle(kind, resource.id)} type="button">
            <span><strong>{resource.name || resource.id}</strong>{resource.description && <small>{resource.description}</small>}</span>
            {checked && <Check size={16} />}
          </button>
        );
      })}
    </section>
  );
}

function resizeTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  textarea.style.height = "auto";
  const styles = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 22;
  const padding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
  const minHeight = Math.ceil(lineHeight * 2 + padding);
  const maxHeight = Math.ceil(lineHeight * 8 + padding);
  textarea.style.height = `${Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight))}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}
