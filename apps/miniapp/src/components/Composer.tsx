import { Button, ScrollView, Text, Textarea, View } from "@tarojs/components";
import { useUploadTimer } from "../hooks/useUploadTimer";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import { composerLineCount } from "../services/chatViewport";
import type { UploadedAttachment } from "../types";
import { useI18n } from "../services/i18n";

export function Composer({ attachments, busy, error, input, onAttach, onChange, onRemove, onRetry, onSend, onStop, onContinue, canContinue, failedFiles, onRetryUploads, onRemoveFailed, streaming, uploading, keyboardOpen, onKeyboardHeight, onFocus, onBlur, onResize }: {
  keyboardOpen: boolean;
  onKeyboardHeight: (height: number) => void;
  onFocus: (height?: number) => void;
  onBlur: () => void;
  onResize: () => void;
  attachments: UploadedAttachment[];
  busy: boolean;
  error: string;
  input: string;
  onAttach: () => void;
  onChange: (value: string) => void;
  onRemove: (index: number) => void;
  onRetry: () => void;
  onSend: () => void;
  onStop: () => void;
  onContinue: () => void;
  canContinue: boolean;
  failedFiles: Array<{ name: string }>;
  onRetryUploads: () => void;
  onRemoveFailed: (index: number) => void;
  streaming: boolean;
  uploading: boolean;
}) {
  const { t } = useI18n();
  const [lines, setLines] = useState(1);
  const elapsed = useUploadTimer(uploading);
  useEffect(() => { if (!input) setLines(1); }, [input]);
  useEffect(() => { onResize(); }, [lines, attachments.length, failedFiles.length, error, canContinue, onResize]);
  const attachDisabled = uploading || streaming || busy || attachments.length + failedFiles.length >= 5;
  const sendDisabled = (!input.trim() && !attachments.length) || uploading || busy || failedFiles.length > 0;
  return <View className={`composer-wrap${keyboardOpen ? " keyboard-open" : ""}`}>
    {error && <View className="error-row"><Text className="chat-error">{error}</Text><Text className="retry" onClick={onRetry}>{t("composer.retry")}</Text></View>}
    {!!attachments.length && <ScrollView className="attachment-strip" scrollX>
      {attachments.map((file, index) => <View className="attachment-chip" key={file.objectId}>
        <Text className="attachment-name">{file.fileName}</Text>
        <Text className="remove" onClick={() => onRemove(index)}>×</Text>
      </View>)}
    </ScrollView>}
    {!!failedFiles.length && <View className="attachment-failures">
      {failedFiles.map((file, index) => <View className="attachment-failure-row" key={`${file.name}-${index}`}><Text className="attachment-failure-name">{file.name} · {t("chat.uploadFailed")}</Text><Text className="attachment-failure-remove" onClick={() => onRemoveFailed(index)}> × </Text></View>)}
      <Button disabled={uploading || busy} onClick={onRetryUploads}>{t("chat.retryUploads")}</Button>
    </View>}
    {canContinue && <View className="chat-continuation"><Text>{t("chat.paused")}</Text><Button disabled={busy || uploading || streaming} onClick={onContinue}>{t("chat.continue")}</Button></View>}
    <View className="composer">
      <Button className={`attach icon-button${attachDisabled ? " disabled" : ""}${uploading ? " uploading" : ""}`} disabled={attachDisabled} onClick={onAttach}>
        <Text className="button-icon">{uploading ? `${t("files.uploading")} · ${elapsed}` : "＋"}</Text>
      </Button>
      <View className="composer-input-shell" style={{ height: Taro.pxTransform(lines * 40 + 30) }}>
        <Textarea
          className="composer-input"
          style={{ height: Taro.pxTransform(lines * 40) }}
          autoHeight={false}
          fixed
          adjustPosition={false}
          disableDefaultPadding
          cursorSpacing={12}
          nativeProps={{ style: { font: "inherit", lineHeight: "inherit", padding: 0, resize: "none" } }}
          onFocus={(event) => onFocus(event.detail.height)}
          onBlur={onBlur}
          onKeyboardHeightChange={(event) => onKeyboardHeight(event.detail.height)}
          onLineChange={(event) => setLines(composerLineCount(event.detail.lineCount))}
          maxlength={12000}
          value={input}
          disabled={streaming || busy}
          onInput={(event) => onChange(event.detail.value)}
          placeholder={busy ? t("composer.restore") : t("composer.placeholder")}
        />
      </View>
      {streaming
        ? <Button className="stop icon-button" onClick={onStop}><Text className="button-icon">■</Text></Button>
        : <Button className={`send icon-button${sendDisabled ? " disabled" : ""}`} disabled={sendDisabled} onClick={onSend}><Text className="button-icon">↑</Text></Button>}
    </View>
  </View>;
}
