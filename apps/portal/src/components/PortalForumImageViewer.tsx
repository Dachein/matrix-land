import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import { ModalShell } from "../../../../src/portal/components/ModalShell";
import { useI18n } from "../../../../src/portal/i18n";
import type { DiscussionAttachment } from "../../../../src/shared/types";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

type Size = {
  height: number;
  width: number;
};

type Offset = {
  x: number;
  y: number;
};

type ViewerDrag = {
  offset: Offset;
  pointerId: number;
  startX: number;
  startY: number;
};

export function PortalForumImageViewer({
  activeIndex,
  image,
  imageCount,
  onClose,
  onNext,
  onPrevious
}: {
  activeIndex: number;
  image: DiscussionAttachment;
  imageCount: number;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ViewerDrag | null>(null);
  const [canvasSize, setCanvasSize] = useState<Size>({ height: 0, width: 0 });
  const [dragging, setDragging] = useState(false);
  const [naturalSize, setNaturalSize] = useState<Size>({ height: 0, width: 0 });
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const hasMultiple = imageCount > 1;
  const fittedSize = useMemo(
    () => fitImageInsideCanvas(naturalSize, canvasSize),
    [canvasSize, naturalSize]
  );
  const canPan = zoom > MIN_ZOOM;
  const imageStyle: CSSProperties = fittedSize.width > 0 ? {
    height: fittedSize.height,
    transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`,
    width: fittedSize.width
  } : {
    opacity: 0
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const updateCanvasSize = () => {
      setCanvasSize({
        height: canvas.clientHeight,
        width: canvas.clientWidth
      });
    };
    updateCanvasSize();

    const observer = new ResizeObserver(updateCanvasSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setOffset((current) => clampOffset(current, zoom, fittedSize, canvasSize));
  }, [canvasSize, fittedSize, zoom]);

  function updateZoom(nextZoom: number) {
    const constrainedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    setZoom(constrainedZoom);
    setOffset((current) => clampOffset(current, constrainedZoom, fittedSize, canvasSize));
  }

  function resetView() {
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if (!canPan || !event.isPrimary || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      offset,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
    };
    setDragging(true);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    setOffset(clampOffset({
      x: drag.offset.x + event.clientX - drag.startX,
      y: drag.offset.y + event.clientY - drag.startY
    }, zoom, fittedSize, canvasSize));
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return;
    }

    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      updateZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      return;
    }

    if (!canPan) {
      return;
    }

    event.preventDefault();
    setOffset((current) => clampOffset({
      x: current.x - event.deltaX,
      y: current.y - event.deltaY
    }, zoom, fittedSize, canvasSize));
  }

  return (
    <ModalShell
      ariaLabel={t("portal.post.imagePreview")}
      modalClassName="portal-image-viewer-stage"
      onClose={onClose}
      overlayClassName="portal-image-viewer"
    >
      <button
        aria-label={t("common.close")}
        autoFocus
        className="portal-image-viewer-close"
        onClick={onClose}
        type="button"
      >
        <X size={22} />
      </button>

      <div
        aria-label={t("forum.imageViewport")}
        className={`portal-image-viewer-canvas${canPan ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
        onDoubleClick={() => canPan ? resetView() : updateZoom(2)}
        onPointerCancel={endDrag}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onWheel={handleWheel}
        ref={canvasRef}
        role="group"
      >
        <img
          alt={image.alt ?? image.fileName}
          draggable={false}
          onLoad={(event) => {
            setNaturalSize({
              height: event.currentTarget.naturalHeight,
              width: event.currentTarget.naturalWidth
            });
            resetView();
          }}
          src={image.url}
          style={imageStyle}
        />
      </div>

      {hasMultiple && (
        <>
          <button aria-label={t("forum.previousImage")} className="portal-image-viewer-nav previous" onClick={onPrevious} type="button">
            <ChevronLeft size={24} />
          </button>
          <button aria-label={t("forum.nextImage")} className="portal-image-viewer-nav next" onClick={onNext} type="button">
            <ChevronRight size={24} />
          </button>
        </>
      )}

      <div aria-label={t("forum.imageControls")} className="portal-image-viewer-toolbar" role="group">
        <button
          aria-label={t("forum.zoomOut")}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => updateZoom(zoom - ZOOM_STEP)}
          type="button"
        >
          <ZoomOut size={17} />
        </button>
        <button
          aria-label={t("forum.resetZoom")}
          className="portal-image-viewer-zoom"
          disabled={zoom <= MIN_ZOOM}
          onClick={resetView}
          type="button"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          aria-label={t("forum.zoomIn")}
          disabled={zoom >= MAX_ZOOM}
          onClick={() => updateZoom(zoom + ZOOM_STEP)}
          type="button"
        >
          <ZoomIn size={17} />
        </button>
        <span aria-hidden="true" className="portal-image-viewer-divider" />
        <span className="portal-image-viewer-counter">{activeIndex + 1} / {imageCount}</span>
      </div>
    </ModalShell>
  );
}

function fitImageInsideCanvas(naturalSize: Size, canvasSize: Size): Size {
  if (naturalSize.width <= 0 || naturalSize.height <= 0 || canvasSize.width <= 0 || canvasSize.height <= 0) {
    return { height: 0, width: 0 };
  }

  const scale = Math.min(
    1,
    canvasSize.width / naturalSize.width,
    canvasSize.height / naturalSize.height
  );
  return {
    height: naturalSize.height * scale,
    width: naturalSize.width * scale
  };
}

function clampOffset(offset: Offset, zoom: number, fittedSize: Size, canvasSize: Size): Offset {
  const maxX = Math.max(0, (fittedSize.width * zoom - canvasSize.width) / 2);
  const maxY = Math.max(0, (fittedSize.height * zoom - canvasSize.height) / 2);
  return {
    x: clamp(offset.x, -maxX, maxX),
    y: clamp(offset.y, -maxY, maxY)
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
