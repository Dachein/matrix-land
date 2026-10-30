import { Image, Text, View } from "@tarojs/components";
import type { MateFileReference } from "../../../../src/shared/mateFileReference.js";
import { fileTypeIcon } from "../services/fileTypeIcons";
import { fileCardDetails } from "../services/fileCard";
import { useI18n } from "../services/i18n";
import "./MateFileLink.scss";

export function MateFileLink({ file, onOpen, mimeType, sizeBytes }: {
  file: MateFileReference;
  mimeType?: string;
  sizeBytes?: number;
  onOpen: (file: MateFileReference) => void;
}) {
  const { t } = useI18n();
  const details = fileCardDetails(file.fileName, mimeType, sizeBytes);
  return <View className="chat-file-card" hoverClass="chat-file-card-pressed" onClick={() => onOpen(file)} ariaLabel={file.fileName}>
    <Image className="chat-file-card-icon" src={fileTypeIcon(file.fileName, mimeType)} mode="aspectFit" />
    <View className="chat-file-card-content">
      <Text className="chat-file-card-name">{file.fileName}</Text>
      <Text className="chat-file-card-meta">{details.type || t("preview.file")} · {details.size || t("files.sizeUnknown")}</Text>
      <Text className="chat-file-card-hint">{t(details.supported ? "files.tapPreview" : "files.previewUnavailable")}</Text>
    </View>
    <Text className="chat-file-card-chevron">›</Text>
  </View>;
}
