import { FileText, Image as ImageIcon, Play, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { filePreviewKind } from "../../../../src/shared/filePreview";
import { mateFileReferenceFromUrl } from "../../../../src/shared/mateFileReference.js";
import { useMateLocale } from "../locale";

export function ConversationFile({ fileName, mediaType, onLoad, onOpen, url }: {
  fileName: string;
  mediaType?: string;
  onLoad?: (url: string) => Promise<Blob>;
  onOpen?: (url: string, fileName: string) => void;
  url: string;
}) {
  const { text } = useMateLocale();
  const kind = filePreviewKind(fileName, mediaType);
  const reference = mateFileReferenceFromUrl(url, fileName);
  const fileUrl = reference?.url;
  const [previewUrl, setPreviewUrl] = useState("");
  const [loadAudio, setLoadAudio] = useState(false);
  const loadRef = useRef(onLoad);
  const canLoad = Boolean(onLoad);
  useEffect(() => { loadRef.current = onLoad; }, [onLoad]);

  useEffect(() => {
    setPreviewUrl("");
    if (kind !== "image" && (kind !== "audio" || !loadAudio)) return;
    if (url.startsWith("blob:")) { setPreviewUrl(url); return; }
    const load = loadRef.current;
    if (!fileUrl || !load) return;
    let cancelled = false;
    let objectUrl = "";
    void load(fileUrl).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setPreviewUrl(objectUrl);
    }).catch(() => { if (!cancelled) { setPreviewUrl(""); setLoadAudio(false); } });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [canLoad, fileUrl, kind, loadAudio, url]);

  const open = () => { if (fileUrl && onOpen) onOpen(fileUrl, fileName); };
  const canPlayAudio = kind === "audio" && Boolean(fileUrl && onLoad);
  const icon = kind === "image" ? <ImageIcon size={19} />
    : kind === "audio" ? <Play aria-hidden="true" fill="currentColor" size={17} />
      : kind === "video" ? <Video size={19} /> : <FileText size={19} />;
  const label = kind === "image" ? text("图片", "Image")
    : kind === "audio" ? text("音频", "Audio")
      : kind === "video" ? text("视频", "Video")
        : text("文档", "Document");

  return <figure className={`tm-conversation-file is-${kind}`}>
    <div className="tm-conversation-file-main">
      {kind === "audio" && fileUrl && onLoad ? <button
        aria-label={text(`播放 ${fileName}`, `Play ${fileName}`)}
        className="tm-conversation-file-icon tm-conversation-file-audio-play"
        onClick={() => setLoadAudio(true)}
        type="button"
      >
        {icon}
      </button> : <button className="tm-conversation-file-open" disabled={!fileUrl || !onOpen} onClick={open} type="button" aria-label={text(`预览 ${fileName}`, `Preview ${fileName}`)}>
        {kind === "image" && previewUrl ? <img alt="" loading="lazy" src={previewUrl} /> : <span className="tm-conversation-file-icon">{icon}</span>}
      </button>}
      <button className="tm-conversation-file-open tm-conversation-file-info-open" disabled={canPlayAudio ? false : !fileUrl || !onOpen} onClick={canPlayAudio ? () => setLoadAudio(true) : open} type="button" aria-label={canPlayAudio ? text(`播放 ${fileName}`, `Play ${fileName}`) : text(`预览 ${fileName}`, `Preview ${fileName}`)}>
        <span className="tm-conversation-file-info"><strong title={fileName}>{fileName}</strong><small>{label}{canPlayAudio ? text(" · 点击播放", " · Click to play") : fileUrl && onOpen ? text(" · 点击预览", " · Open preview") : ""}</small></span>
      </button>
    </div>
    {kind === "audio" && fileUrl && onLoad && (previewUrl
      ? <audio controls preload="metadata" src={previewUrl} aria-label={fileName} />
      : null)}
  </figure>;
}
