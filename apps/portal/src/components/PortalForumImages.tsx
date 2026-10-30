import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ForumAttachmentBlocks, ForumRichBlocks } from "../../../../src/portal/forum/components/ForumRichBlocks";
import { useI18n } from "../../../../src/portal/i18n";
import { forumStandaloneAttachments } from "../../../../src/portal/forum/markdown";
import type { Discussion, DiscussionAttachment, PortalCatalog } from "../../../../src/shared/types";
import { PortalForumImageViewer } from "./PortalForumImageViewer";

const MAX_VISIBLE_THUMBNAILS = 9;
const SINGLE_IMAGE_NATURAL_MIN_RATIO = 1 / 2;
const SINGLE_IMAGE_NATURAL_MAX_RATIO = 2 / 1;

type ImagePresentation = "landscape" | "portrait" | "square";

export function PortalForumRichBlocks({
  appsById,
  discussion,
  skillsById
}: {
  appsById: Map<string, PortalCatalog["apps"][number]>;
  discussion: Discussion;
  skillsById: Map<string, PortalCatalog["skills"][number]>;
}) {
  return (
    <>
      <PortalForumAttachmentBlocks attachments={forumStandaloneAttachments(discussion.body ?? "", discussion.attachments ?? [])} />
      <ForumRichBlocks
        appsById={appsById}
        discussion={{ ...discussion, attachments: [] }}
        skillsById={skillsById}
      />
    </>
  );
}

export function PortalForumAttachmentBlocks({
  attachments,
  compact = false
}: {
  attachments: DiscussionAttachment[];
  compact?: boolean;
}) {
  const images = attachments.filter((attachment) => attachment.type === "image");
  const files = attachments.filter((attachment) => attachment.type !== "image");

  if (images.length === 0 && files.length === 0) {
    return null;
  }

  return (
    <div className={`forumAttachmentBlocks ${compact ? "compact" : ""}`}>
      {images.length > 0 && <PortalForumImageGallery images={images} />}
      {files.length > 0 && <ForumAttachmentBlocks attachments={files} compact={compact} />}
    </div>
  );
}

function PortalForumImageGallery({ images }: { images: DiscussionAttachment[] }) {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const previewImages = images.slice(0, MAX_VISIBLE_THUMBNAILS);
  const activeImage = activeIndex === null ? undefined : images[Math.min(activeIndex, images.length - 1)];
  const hasMultiple = images.length > 1;
  const columnCount = previewImages.length === 1 ? 1 : previewImages.length <= 4 ? 2 : 3;

  useEffect(() => {
    setActiveIndex(null);
  }, [images.length]);

  useEffect(() => {
    if (activeIndex === null) {
      return;
    }

    function shift(delta: number) {
      setActiveIndex((current) => current === null ? null : (current + delta + images.length) % images.length);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setActiveIndex(null);
      } else if (event.key === "ArrowLeft" && hasMultiple) {
        event.preventDefault();
        shift(-1);
      } else if (event.key === "ArrowRight" && hasMultiple) {
        event.preventDefault();
        shift(1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeIndex, hasMultiple, images.length]);

  function shift(delta: number) {
    setActiveIndex((current) => current === null ? null : (current + delta + images.length) % images.length);
  }

  return (
    <>
      {previewImages.length === 1 ? (
        <PortalSingleImageThumbnail
          groupLabel={t("portal.post.imageGrid")}
          image={previewImages[0]}
          imageLabel={t("forum.showImage", { index: 1 })}
          onOpen={() => setActiveIndex(0)}
        />
      ) : (
        <div
          aria-label={t("portal.post.imageGrid")}
          className={`portal-forum-image-grid columns-${columnCount}`}
          role="group"
        >
          {previewImages.map((image, index) => (
            <button
              aria-label={t("forum.showImage", { index: index + 1 })}
              className="portal-forum-image-thumbnail"
              key={image.id}
              onClick={() => setActiveIndex(index)}
              type="button"
            >
              <PortalThumbnailImage image={image} />
              {index === MAX_VISIBLE_THUMBNAILS - 1 && images.length > MAX_VISIBLE_THUMBNAILS && (
                <span className="portal-forum-image-more">+{images.length - MAX_VISIBLE_THUMBNAILS}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {activeImage && activeIndex !== null && createPortal(
        <PortalForumImageViewer
          activeIndex={activeIndex}
          image={activeImage}
          imageCount={images.length}
          key={activeImage.id}
          onClose={() => setActiveIndex(null)}
          onNext={() => shift(1)}
          onPrevious={() => shift(-1)}
        />,
        document.body
      )}
    </>
  );
}

function PortalSingleImageThumbnail({
  groupLabel,
  image,
  imageLabel,
  onOpen
}: {
  groupLabel: string;
  image: DiscussionAttachment;
  imageLabel: string;
  onOpen: () => void;
}) {
  const [intrinsicSize, setIntrinsicSize] = useState<{ height: number; width: number }>();

  const aspectRatio = intrinsicSize ? intrinsicSize.width / intrinsicSize.height : 1;
  const useNaturalPresentation = intrinsicSize
    ? aspectRatio >= SINGLE_IMAGE_NATURAL_MIN_RATIO && aspectRatio <= SINGLE_IMAGE_NATURAL_MAX_RATIO
    : true;
  const displayStyle = intrinsicSize && useNaturalPresentation ? {
    aspectRatio: `${intrinsicSize.width} / ${intrinsicSize.height}`,
    width: `min(${Math.min(1, aspectRatio) * 100}%, ${intrinsicSize.width}px)`
  } : undefined;
  const presentation = useNaturalPresentation
    ? "complete"
    : aspectRatio < SINGLE_IMAGE_NATURAL_MIN_RATIO ? "portrait" : "landscape";

  return (
    <div aria-label={groupLabel} className="portal-forum-image-grid columns-1 single" role="group">
      <button
        aria-label={imageLabel}
        className={`portal-forum-image-thumbnail single ${useNaturalPresentation ? "natural" : "extreme"}`}
        onClick={onOpen}
        style={displayStyle}
        type="button"
      >
        <img
          alt={image.alt ?? image.fileName}
          className={presentation}
          loading="lazy"
          onLoad={(event) => setIntrinsicSize({
            height: event.currentTarget.naturalHeight,
            width: event.currentTarget.naturalWidth
          })}
          src={image.url}
        />
      </button>
    </div>
  );
}

function PortalThumbnailImage({ image }: { image: DiscussionAttachment }) {
  const [presentation, setPresentation] = useState<ImagePresentation>("square");

  return (
    <img
      alt={image.alt ?? image.fileName}
      className={presentation}
      loading="lazy"
      onLoad={(event) => {
        const { naturalHeight, naturalWidth } = event.currentTarget;
        setPresentation(naturalHeight > naturalWidth ? "portrait" : naturalWidth > naturalHeight ? "landscape" : "square");
      }}
      src={image.url}
    />
  );
}
