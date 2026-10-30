import { Folder, FolderOpen } from "lucide-react";
import { useMateLocale } from "../locale";

export type MateChatTextSize = "compact" | "standard";

const TEXT_SIZE_STORAGE_KEY = "workspace-mate-chat-text-size-v1";
export function ConversationTopbarControls({
  filesDisabled,
  onToggleSources,
  resourceCount,
  sourcesActivated,
  sourcesOpen
}: {
  filesDisabled?: boolean;
  onToggleSources: () => void;
  resourceCount: number;
  sourcesActivated: boolean;
  sourcesOpen: boolean;
}) {
  const { text } = useMateLocale();
  return (
    <div className="tm-preview-topbar-chat-controls">
      <button
        aria-expanded={sourcesOpen}
        aria-label={sourcesOpen
          ? text("收起文件与来源", "Collapse files and sources")
          : sourcesActivated
            ? text(`展开文件与来源，当前 ${resourceCount} 项`, `Expand files and sources, ${resourceCount} items`)
            : text("展开文件与来源", "Expand files and sources")}
        disabled={filesDisabled}
        onClick={onToggleSources}
        type="button"
      >
        {sourcesOpen ? <FolderOpen aria-hidden="true" size={15} /> : <Folder aria-hidden="true" size={15} />}
        {text("文件与来源", "Files & sources")} <strong>{sourcesActivated ? resourceCount : "—"}</strong>
      </button>
    </div>
  );
}

export function readMateChatTextSize(): MateChatTextSize {
  if (typeof window === "undefined") return "standard";
  try {
    const stored = window.localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
    return stored === "compact" ? stored : "standard";
  } catch {
    return "standard";
  }
}

export function storeMateChatTextSize(value: MateChatTextSize) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TEXT_SIZE_STORAGE_KEY, value);
  } catch {
    // Preference persistence is optional; the active view still updates.
  }
}
