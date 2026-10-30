import { Canvas, Image, Input, Slider, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../services/i18n";
import { MATE_AVATAR_CHOICES, loadMateAvatarChoices, mateAvatarChoiceForUrl } from "./mateAvatarChoices";
import "./MateIdentityForm.scss";

export type MateIdentity = {
  avatarUrl: string;
  displayName: string;
  jobRole: string;
};

type CropState = {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  baseScale: number;
  zoom: number;
  left: number;
  top: number;
};

type CropCanvasNode = {
  width: number;
  height: number;
  createImage: () => {
    src: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
  };
  getContext: (type: "2d") => CanvasRenderingContext2D;
};

const CROP_OUTPUT_SIZE = 600;

export function MateIdentityForm({ busy, onChange, value }: {
  busy: boolean;
  onChange: (value: MateIdentity) => void;
  value: MateIdentity;
}) {
  const { t } = useI18n();
  const [previewPath, setPreviewPath] = useState("");
  const [avatarChoices, setAvatarChoices] = useState(MATE_AVATAR_CHOICES);
  const [avatarError, setAvatarError] = useState("");
  const [cropViewportSize] = useState(() => Math.min(320, Math.max(240, (Taro.getSystemInfoSync().windowWidth || 360) - 48)));
  const [crop, setCrop] = useState<CropState | null>(null);
  const [cropBusy, setCropBusy] = useState(false);
  const dragStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    let mounted = true;
    void loadMateAvatarChoices().then((choices) => { if (mounted) setAvatarChoices(choices); })
      .catch(() => { /* Keep bundled choices when the catalog is unavailable. */ });
    return () => { mounted = false; };
  }, []);

  function clampCropPosition(left: number, top: number, width: number, height: number) {
    return {
      left: Math.min(0, Math.max(cropViewportSize - width, left)),
      top: Math.min(0, Math.max(cropViewportSize - height, top))
    };
  }

  async function chooseAvatar() {
    setAvatarError("");
    try {
      const chosen = await Taro.chooseImage({ count: 1, sizeType: ["compressed"], sourceType: ["album", "camera"] });
      const src = chosen.tempFilePaths[0];
      const imageInfo = await Taro.getImageInfo({ src });
      const baseScale = Math.max(cropViewportSize / imageInfo.width, cropViewportSize / imageInfo.height);
      const displayWidth = imageInfo.width * baseScale;
      const displayHeight = imageInfo.height * baseScale;
      const position = clampCropPosition((cropViewportSize - displayWidth) / 2, (cropViewportSize - displayHeight) / 2, displayWidth, displayHeight);
      setCrop({ src, naturalWidth: imageInfo.width, naturalHeight: imageInfo.height, baseScale, zoom: 1, ...position });
    } catch (caught) {
      const message = String((caught as { errMsg?: string })?.errMsg || "");
      if (/cancel/i.test(message)) return;
      setAvatarError(t("identity.imageOpenFailed"));
    }
  }

  function updateCropZoom(value: number) {
    setCrop((current) => {
      if (!current) return current;
      const zoom = Math.min(3, Math.max(1, value / 100));
      const width = current.naturalWidth * current.baseScale * zoom;
      const height = current.naturalHeight * current.baseScale * zoom;
      const centerX = current.left + current.naturalWidth * current.baseScale * current.zoom / 2;
      const centerY = current.top + current.naturalHeight * current.baseScale * current.zoom / 2;
      const position = clampCropPosition(centerX - width / 2, centerY - height / 2, width, height);
      return { ...current, zoom, ...position };
    });
  }

  function beginCropDrag(event: unknown) {
    const touch = (event as { touches?: Array<{ clientX: number; clientY: number }> }).touches?.[0];
    if (!crop || cropBusy || !touch) return;
    dragStart.current = { x: touch.clientX, y: touch.clientY, left: crop.left, top: crop.top };
  }

  function moveCropImage(event: unknown) {
    const touch = (event as { touches?: Array<{ clientX: number; clientY: number }> }).touches?.[0];
    const start = dragStart.current;
    if (!crop || !start || cropBusy || !touch) return;
    const width = crop.naturalWidth * crop.baseScale * crop.zoom;
    const height = crop.naturalHeight * crop.baseScale * crop.zoom;
    const position = clampCropPosition(start.left + touch.clientX - start.x, start.top + touch.clientY - start.y, width, height);
    setCrop((current) => current ? { ...current, ...position } : current);
  }

  async function confirmCrop() {
    if (!crop || cropBusy) return;
    setCropBusy(true);
    setAvatarError("");
    try {
      const scale = crop.baseScale * crop.zoom;
      const sourceWidth = Math.min(crop.naturalWidth, cropViewportSize / scale);
      const sourceHeight = Math.min(crop.naturalHeight, cropViewportSize / scale);
      const sourceX = Math.min(crop.naturalWidth - sourceWidth, Math.max(0, -crop.left / scale));
      const sourceY = Math.min(crop.naturalHeight - sourceHeight, Math.max(0, -crop.top / scale));
      const canvas = await new Promise<CropCanvasNode>((resolve, reject) => {
        Taro.createSelectorQuery()
          .select("#avatar-crop-output")
          .fields({ node: true, size: true })
          .exec((result) => {
            const node = (result[0] as { node?: CropCanvasNode } | undefined)?.node;
            if (!node) reject(new Error("avatar_canvas_unavailable"));
            else resolve(node);
          });
      });
      // Set the backing canvas dimensions as well as its CSS size. The legacy
      // canvas API left the backing buffer at its default size, clipping exports.
      canvas.width = CROP_OUTPUT_SIZE;
      canvas.height = CROP_OUTPUT_SIZE;
      const context = canvas.getContext("2d");
      const image = canvas.createImage();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("avatar_image_decode_failed"));
        image.src = crop.src;
      });
      context.drawImage(image as unknown as CanvasImageSource, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, CROP_OUTPUT_SIZE, CROP_OUTPUT_SIZE);
      const output = await Taro.canvasToTempFilePath({
        canvas: canvas as unknown as Parameters<typeof Taro.canvasToTempFilePath>[0]["canvas"],
        x: 0,
        y: 0,
        width: CROP_OUTPUT_SIZE,
        height: CROP_OUTPUT_SIZE,
        destWidth: CROP_OUTPUT_SIZE,
        destHeight: CROP_OUTPUT_SIZE,
        fileType: "jpg",
        quality: 0.86
      });
      // The canvas already emitted a 600×600 crop; only reduce JPEG quality,
      // avoiding another resize/crop pass.
      const compressed = await Taro.compressImage({ src: output.tempFilePath, quality: 82 });
      const imageInfo = await Taro.getImageInfo({ src: compressed.tempFilePath });
      const imageType = imageInfo.type.toLowerCase() === "jpg" ? "jpeg" : imageInfo.type.toLowerCase();
      if (!["jpeg", "png", "webp", "gif"].includes(imageType)) throw new Error("avatar_type_unsupported");
      const base64 = await new Promise<string>((resolve, reject) => {
        Taro.getFileSystemManager().readFile({
          encoding: "base64",
          filePath: compressed.tempFilePath,
          success: (result) => resolve(String(result.data)),
          fail: reject
        });
      });
      const avatarUrl = `data:image/${imageType};base64,${base64}`;
      if (avatarUrl.length > 1_200_000) throw new Error("avatar_too_large");
      setPreviewPath(compressed.tempFilePath);
      onChange({ ...value, avatarUrl });
      setCrop(null);
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "";
      if (code === "avatar_too_large") setAvatarError(t("identity.cropTooLarge"));
      else setAvatarError(t("identity.cropFailed"));
    } finally {
      setCropBusy(false);
    }
  }

  function clearAvatar() {
    setPreviewPath("");
    setAvatarError("");
    onChange({ ...value, avatarUrl: avatarChoices[Math.floor(Math.random() * avatarChoices.length)].savedUrl });
  }

  const cropScale = crop ? crop.baseScale * crop.zoom : 1;
  return <View className="mate-identity-form">
    <View className="quick-create-field"><Text>{t("identity.nickname")}</Text><Input value={value.displayName} disabled={busy} onInput={(event) => onChange({ ...value, displayName: event.detail.value })} placeholder={t("identity.nicknamePlaceholder")} /></View>
    <View className="quick-create-field"><Text>{t("identity.avatar")}</Text><View className="avatar-picker">
      <View className={`avatar-preview avatar-tap-target${busy ? " is-disabled" : ""}`} onClick={() => { if (!busy) void chooseAvatar(); }}>
        {previewPath || value.avatarUrl
          ? <Image className="avatar-preview-image" src={previewPath || mateAvatarChoiceForUrl(value.avatarUrl, avatarChoices)?.previewUrl || value.avatarUrl} mode="aspectFit" />
          : <View className="avatar-placeholder"><Text>＋</Text></View>}
      </View>
      <View className="avatar-picker-actions">
        <Text className="avatar-hint">{value.avatarUrl ? t("identity.changeAvatar") : t("identity.chooseAvatar")}</Text>
        {value.avatarUrl && !mateAvatarChoiceForUrl(value.avatarUrl, avatarChoices) && <Text className="avatar-remove" onClick={(event) => { event.stopPropagation(); clearAvatar(); }}>{t("common.remove")}</Text>}
      </View>
    </View>
      <Text className="mate-avatar-choices-label">{t("identity.avatarChoices")}</Text>
      <View className="mate-avatar-choices">
        {avatarChoices.map((choice) => <View
          className={`mate-avatar-choice${value.avatarUrl === choice.savedUrl ? " is-selected" : ""}`}
          key={choice.id}
          onClick={() => {
            if (busy) return;
            setPreviewPath("");
            setAvatarError("");
            onChange({ ...value, avatarUrl: choice.savedUrl });
          }}
        ><Image src={choice.previewUrl} mode="aspectFit" /><Text>{choice.id === "claude-code" ? "Claude Code" : choice.id}</Text></View>)}
      </View>
      {avatarError && <Text className="create-error">{avatarError}</Text>}</View>
    <View className="quick-create-field"><Text>{t("identity.role")}</Text><Input value={value.jobRole} disabled={busy} onInput={(event) => onChange({ ...value, jobRole: event.detail.value })} placeholder={t("identity.rolePlaceholder")} /></View>
    {crop && <View className="avatar-crop-overlay">
      <View className="avatar-crop-panel">
        <View className="avatar-crop-header"><Text onClick={() => { if (!cropBusy) setCrop(null); }}>{t("common.cancel")}</Text><Text>{t("identity.cropTitle")}</Text><Text className={cropBusy ? "is-muted" : "is-primary"} onClick={() => void confirmCrop()}>{cropBusy ? t("common.processing") : t("common.done")}</Text></View>
        <Text className="avatar-crop-instruction">{t("identity.cropInstruction")}</Text>
        <View
          className="avatar-crop-viewport"
          style={{ width: `${cropViewportSize}px`, height: `${cropViewportSize}px` }}
          onTouchStart={beginCropDrag}
          onTouchMove={moveCropImage}
          onTouchEnd={() => { dragStart.current = null; }}
        >
          <Image
            className="avatar-crop-source"
            src={crop.src}
            mode="scaleToFill"
            style={{ width: `${crop.naturalWidth * cropScale}px`, height: `${crop.naturalHeight * cropScale}px`, left: `${crop.left}px`, top: `${crop.top}px` }}
          />
          <View className="avatar-crop-frame"><View /><View /></View>
        </View>
        <View className="avatar-crop-zoom"><Text>−</Text><Slider min={100} max={300} step={1} value={Math.round(crop.zoom * 100)} activeColor="#222222" backgroundColor="#d8d5ce" blockColor="#222222" onChanging={(event) => updateCropZoom(event.detail.value)} onChange={(event) => updateCropZoom(event.detail.value)} /><Text>＋</Text></View>
        <Text className="avatar-crop-footer">{t("identity.cropFooter")}</Text>
      </View>
    </View>}
    <Canvas className="avatar-crop-canvas" id="avatar-crop-output" type="2d" />
  </View>;
}
