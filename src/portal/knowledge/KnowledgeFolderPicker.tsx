import { FeedbackNotice } from "../components/FeedbackNotice";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Folder, FolderPlus, X } from "lucide-react";
import { Button } from "../components/Button";
import { ModalShell } from "../components/ModalShell";
import type { KnowledgeApiItem, KnowledgeTreeResponse } from "./types";
import { knowledgeFetch } from "./utils";
import "./knowledgeFolderPicker.css";

export type SelectedKnowledgeFolder = { id: string; path: string };

/** Browses the current user's writable Knowledge folders without guessing paths. */
export function KnowledgeFolderPicker({ mode = "save", onClose, onSelect, zh }: {
  mode?: "save" | "save-and-share";
  onClose: () => void;
  onSelect: (folder: SelectedKnowledgeFolder) => void;
  zh: boolean;
}) {
  const [trail, setTrail] = useState<SelectedKnowledgeFolder[]>([]);
  const [folders, setFolders] = useState<SelectedKnowledgeFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const current = trail.at(-1);

  useEffect(() => {
    let cancelled = false;
    const path = current ? `/api/tree?folderObjectId=${encodeURIComponent(current.id)}` : "/api/tree?prefix=";
    setLoading(true);
    setError("");
    void knowledgeFetch<KnowledgeTreeResponse>(path).then((response) => {
      if (cancelled) return;
      setFolders((response.items ?? []).filter(isWritableFolder).map((item) => ({
        id: item.id!, path: item.path || item.name!
      })).sort((a, b) => a.path.localeCompare(b.path)));
    }).catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [current?.id]);

  async function createFolder() {
    const name = newFolderName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError("");
    try {
      const response = await knowledgeFetch<{ item?: KnowledgeApiItem }>("/api/folders", {
        body: JSON.stringify({ name, ...(current ? { parentObjectId: current.id } : { parentPath: "" }) }),
        headers: { "Content-Type": "application/json" }, method: "POST"
      });
      if (!response.item?.id) throw new Error("knowledge_folder_response_missing");
      onSelect({ id: response.item.id, path: response.item.path || [current?.path, name].filter(Boolean).join("/") });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setCreating(false); }
  }

  return <ModalShell ariaLabel={zh ? "选择知识库文件夹" : "Choose Knowledge folder"} className="knowledgeFolderPicker" header={<div className="knowledgeFolderPickerTitle"><Folder size={17} /><strong>{zh ? "保存到知识库" : "Save to Knowledge"}</strong></div>} headerActions={<Button aria-label={zh ? "关闭" : "Close"} iconBefore={<X size={16} />} onClick={onClose} variant="icon" />} headerClassName="knowledgeFolderPickerHeader" modalClassName="knowledgeFolderPickerDialog" onClose={onClose} overlayClassName="knowledgeFolderPickerOverlay">
    {trail.length > 0 && <nav aria-label={zh ? "文件夹路径" : "Folder path"} className="knowledgeFolderPickerLocation">
      <button aria-label={zh ? "返回知识库根目录" : "Back to Knowledge root"} onClick={() => { setTrail([]); setCreateOpen(false); }} title={zh ? "返回知识库根目录" : "Back to Knowledge root"} type="button"><ChevronLeft aria-hidden="true" size={16} /></button>
      {trail.map((folder, index) => <span className="knowledgeFolderPickerCrumb" key={folder.id}>
        {index > 0 && <ChevronRight aria-hidden="true" size={14} />}
        <button aria-current={index === trail.length - 1 ? "location" : undefined} onClick={() => { setTrail((value) => value.slice(0, index + 1)); setCreateOpen(false); }} title={folder.path} type="button">{folder.path.split("/").at(-1)}</button>
      </span>)}
    </nav>}
    <div className="knowledgeFolderPickerListHeader"><span>{zh ? "文件夹" : "Folders"}</span><span>{zh ? "仅显示可编辑" : "Writable only"}</span></div>
    <div className="knowledgeFolderPickerList">
      {loading ? <p role="status">{zh ? "正在读取文件夹…" : "Loading folders…"}</p>
        : error ? <FeedbackNotice tone="error">{zh ? "读取失败：" : "Could not load folders: "}{error}</FeedbackNotice>
          : folders.length ? folders.map((folder) => <button className="knowledgeFolderPickerRow" key={folder.id} onClick={() => { setTrail((value) => [...value, folder]); setCreateOpen(false); }} title={folder.path} type="button">
            <span className="knowledgeFolderPickerRowName"><Folder aria-hidden="true" size={18} /><strong>{folder.path.split("/").at(-1)}</strong></span>
            <ChevronRight aria-hidden="true" size={16} />
          </button>) : <p>{zh ? "这里没有可编辑的子文件夹。" : "No writable subfolders here."}</p>}
    </div>
    <div className="knowledgeFolderPickerTools">
      {!createOpen ? <Button iconBefore={<FolderPlus size={16} />} onClick={() => setCreateOpen(true)} variant="secondary">{zh ? "新建文件夹" : "New folder"}</Button>
        : <form className="knowledgeFolderPickerCreate" onSubmit={(event) => { event.preventDefault(); void createFolder(); }}>
          <label htmlFor="knowledge-folder-picker-new-name">{zh ? "新文件夹名称" : "New folder name"}</label>
          <div><input autoFocus id="knowledge-folder-picker-new-name" maxLength={160} onChange={(event) => setNewFolderName(event.target.value)} placeholder={zh ? "输入文件夹名称" : "Enter folder name"} value={newFolderName} />
            <Button disabled={creating || !newFolderName.trim()} isLoading={creating} type="submit" variant="primary">{mode === "save-and-share" ? zh ? "创建并分享" : "Create and share" : zh ? "创建并保存" : "Create and save"}</Button></div>
          <button className="knowledgeFolderPickerCreateCancel" onClick={() => { setCreateOpen(false); setNewFolderName(""); }} type="button">{zh ? "取消新建" : "Cancel new folder"}</button>
        </form>}
    </div>
    <footer className="knowledgeFolderPickerActions">
      <span>{current ? zh ? "保存位置：" : "Save to: " : zh ? "请选择文件夹" : "Choose a folder"}{current?.path}</span>
      <Button onClick={onClose} variant="secondary">{zh ? "取消" : "Cancel"}</Button>
      {!createOpen && <Button disabled={!current} onClick={() => { if (current) onSelect(current); }} variant="primary">{mode === "save-and-share" ? zh ? "保存并生成分享链接" : "Save and create share link" : zh ? "保存到此文件夹" : "Save here"}</Button>}
    </footer>
  </ModalShell>;
}

function isWritableFolder(item: KnowledgeApiItem) {
  return Boolean(item.id && item.name && (item.kind === "folder" || item.objectKind === "folder")
    && (item.capabilities?.canEdit === true || item.effectiveRole === "owner" || item.effectiveRole === "collaborator"));
}
