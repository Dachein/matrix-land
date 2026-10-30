import { RefreshCw } from "lucide-react";
import type { UIMessage } from "ai";
import type { MatePreviewSession } from "../api";
import type { MateChatTextSize } from "./ConversationToolbar";
import { useMateLocale } from "../locale";
import { MateMessage } from "./MessageRenderer";

export function ConversationTransitionSurface({
  messages,
  session,
  textSize
}: {
  messages: UIMessage[];
  session: MatePreviewSession;
  textSize: MateChatTextSize;
}) {
  const { text } = useMateLocale();
  if (messages.length === 0) {
    return (
      <div className="tm-preview-chat-loading" data-testid="preview-conversation-switching">
        <RefreshCw size={18} />
        <strong>{text("正在加载对话…", "Loading conversation…")}</strong>
        <span>{text("首次打开这个会话，正在读取最新消息。", "Opening this conversation for the first time and loading the latest messages.")}</span>
      </div>
    );
  }
  return (
    <div className="tm-preview-workspace is-standalone" data-testid="preview-conversation-cache">
      <section className="tm-preview-conversation" aria-label={text("缓存的 Mate 对话", "Cached Mate conversation")}>
        <div className="tm-preview-transcript" data-text-size={textSize} role="log">
          {messages.map((message) => (
            <MateMessage
              key={message.id}
              message={message}
              mate={session.mate}
              user={session.user}
            />
          ))}
        </div>
        <div className="tm-preview-conversation-sync" role="status">
          <RefreshCw size={13} />{text("正在同步最新消息…", "Syncing latest messages…")}
        </div>
      </section>
    </div>
  );
}
