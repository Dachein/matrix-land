import { ChevronUp, ImagePlus, Settings2, Trash2, Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Button } from "./Button";

const COVER_IMAGE_SIZE = 600;
const MAX_COVER_SOURCE_BYTES = 10_000_000;
const MAX_PROCESSED_COVER_BYTES = 900_000;

type CoverImageCopy = {
  collapse: string;
  empty: string;
  help: string;
  invalidType: string;
  manage: string;
  processing: string;
  readFailed: string;
  replace: string;
  required: string;
  remove: string;
  tooLarge: string;
  upload: string;
};

type LoadedImageSource = {
  dispose: () => void;
  height: number;
  source: CanvasImageSource;
  width: number;
};

export function SquareCoverImageField({
  copy,
  label,
  onChange,
  onValidityChange,
  required = true,
  value
}: {
  copy: CoverImageCopy;
  label: string;
  onChange: (value: string) => void;
  onValidityChange?: (valid: boolean) => void;
  required?: boolean;
  value: string;
}) {
  const [error, setError] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const managementId = useId();

  function chooseCoverFile() {
    fileInputRef.current?.click();
  }

  async function readCoverFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    if (!isSupportedImage(file)) {
      setError(copy.invalidType);
      return;
    }

    if (file.size > MAX_COVER_SOURCE_BYTES) {
      setError(copy.tooLarge);
      return;
    }

    setIsProcessing(true);
    try {
      onChange(await normalizeCoverImage(file));
      setError("");
    } catch {
      setError(copy.readFailed);
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <div className="appCoverField wide">
      <div className="appCoverFieldHeader">
        <span>{label}</span>
        {required && <strong>{copy.required}</strong>}
      </div>
      <div className="appCoverUploadSummary">
        <button
          aria-controls={managementId}
          aria-expanded={isExpanded}
          aria-label={copy.manage}
          className="appCoverThumbnail"
          disabled={isProcessing}
          onClick={() => setIsExpanded((current) => !current)}
          type="button"
        >
          {value
            ? <CoverImage onValidityChange={onValidityChange} value={value} />
            : <ImagePlus aria-hidden="true" size={20} />}
        </button>
        <div className="appCoverUploadSummaryCopy">
          <strong>{value ? label : copy.empty}</strong>
          <small className={error ? "appCoverUploadError" : ""}>{error || copy.help}</small>
        </div>
        <Button
          aria-controls={managementId}
          aria-expanded={isExpanded}
          disabled={isProcessing}
          iconBefore={<Settings2 size={15} />}
          onClick={() => setIsExpanded((current) => !current)}
          size="compact"
          variant="secondary"
        >
          {copy.manage}
        </Button>
      </div>
      {isExpanded && (
        <div className="appCoverManagement" id={managementId}>
          <div className="appCoverPreview">
            {value
              ? <CoverImage onValidityChange={onValidityChange} value={value} />
              : <span><ImagePlus size={20} /> {copy.empty}</span>}
          </div>
          <div className="appCoverUploadActions">
            <div className="appCoverUploadButtons">
              <Button
                disabled={isProcessing}
                iconBefore={<Upload size={15} />}
                isLoading={isProcessing}
                onClick={chooseCoverFile}
                size="compact"
                variant="secondary"
              >
                {isProcessing ? copy.processing : value ? copy.replace : copy.upload}
              </Button>
              {value && (
                <Button disabled={isProcessing} iconBefore={<Trash2 size={15} />} onClick={() => onChange("")} size="compact" variant="secondary">
                  {copy.remove}
                </Button>
              )}
              <Button disabled={isProcessing} iconBefore={<ChevronUp size={15} />} onClick={() => setIsExpanded(false)} size="compact" variant="secondary">
                {copy.collapse}
              </Button>
            </div>
            <small className={error ? "appCoverUploadError" : ""}>{error || copy.help}</small>
          </div>
        </div>
      )}
      <input
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="visuallyHidden"
        disabled={isProcessing}
        onChange={readCoverFile}
        ref={fileInputRef}
        type="file"
      />
    </div>
  );
}

function CoverImage({ onValidityChange, value }: { onValidityChange?: (valid: boolean) => void; value: string }) {
  return (
    <img
      alt=""
      decoding="async"
      onError={() => onValidityChange?.(false)}
      onLoad={(event) => onValidityChange?.(event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalHeight > 0)}
      src={value}
    />
  );
}

function isSupportedImage(file: File) {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();

  return /^image\/(png|jpe?g|webp|gif)$/.test(type) || /\.(png|jpe?g|webp|gif)$/.test(name);
}

async function normalizeCoverImage(file: File) {
  const loaded = await loadImageSource(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = COVER_IMAGE_SIZE;
    canvas.height = COVER_IMAGE_SIZE;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("cover_canvas_unavailable");
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, COVER_IMAGE_SIZE, COVER_IMAGE_SIZE);

    const sourceSize = Math.min(loaded.width, loaded.height);
    const sourceX = Math.max(0, (loaded.width - sourceSize) / 2);
    const sourceY = Math.max(0, (loaded.height - sourceSize) / 2);
    context.drawImage(
      loaded.source,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      COVER_IMAGE_SIZE,
      COVER_IMAGE_SIZE
    );

    return await blobToDataUrl(await bestCoverBlob(canvas));
  } finally {
    loaded.dispose();
  }
}

async function loadImageSource(file: File): Promise<LoadedImageSource> {
  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        dispose: () => bitmap.close(),
        height: bitmap.height,
        source: bitmap,
        width: bitmap.width
      };
    } catch {
      // Fall through to the image element loader; some browsers reject GIFs here.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  return await new Promise<LoadedImageSource>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      resolve({
        dispose: () => URL.revokeObjectURL(objectUrl),
        height: image.naturalHeight,
        source: image,
        width: image.naturalWidth
      });
    });
    image.addEventListener("error", () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("cover_image_load_failed"));
    });
    image.src = objectUrl;
  });
}

async function bestCoverBlob(canvas: HTMLCanvasElement) {
  let fallback: Blob | undefined;
  const attempts: Array<{ quality: number; type: string }> = [
    { type: "image/webp", quality: 0.86 },
    { type: "image/webp", quality: 0.74 },
    { type: "image/jpeg", quality: 0.86 },
    { type: "image/jpeg", quality: 0.74 }
  ];

  for (const attempt of attempts) {
    const blob = await canvasToBlob(canvas, attempt.type, attempt.quality);
    if (!blob) {
      continue;
    }
    fallback = blob;
    if (blob.size <= MAX_PROCESSED_COVER_BYTES) {
      return blob;
    }
  }

  const png = await canvasToBlob(canvas, "image/png");
  if (png && png.size <= MAX_PROCESSED_COVER_BYTES) {
    return png;
  }
  if (fallback) {
    return fallback;
  }
  if (png) {
    return png;
  }
  throw new Error("cover_image_encode_failed");
}

async function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

async function blobToDataUrl(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("cover_image_read_failed"));
      }
    });
    reader.addEventListener("error", () => reject(new Error("cover_image_read_failed")));
    reader.readAsDataURL(blob);
  });
}
