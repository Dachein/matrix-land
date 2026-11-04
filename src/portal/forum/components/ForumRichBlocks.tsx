import { personPalette } from "../../components/shared/visualIdentity";
import {
  AlertCircle,
  AppWindow,
  AtSign,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Film,
  Link2,
  ServerCog,
  Tags
} from "lucide-react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import type {
  Discussion,
  DiscussionAttachment,
  DiscussionContentPlugin,
  DiscussionLinkEmbed,
  PortalCatalog
} from "../../../shared/types";
import { ButtonLink } from "../../components/Button";
import { useI18n } from "../../i18n";
import {
  fileKind,
  fileLabel,
  filePreviewText
} from "../attachments";
import { youtubeEmbedUrl } from "../embeds";
import { formatBytes } from "../formatters";
import { forumStandaloneAttachments } from "../markdown";

export function ForumRichBlocks({
  appsById,
  discussion,
  skillsById,
  onOpenProduct
}: {
  appsById: Map<string, PortalCatalog["apps"][number]>;
  discussion: Discussion;
  skillsById: Map<string, PortalCatalog["skills"][number]>;
  onOpenProduct?: (plugin: DiscussionContentPlugin) => void;
}) {
  return (
    <>
      <ForumAttachmentBlocks attachments={forumStandaloneAttachments(discussion.body ?? "", discussion.attachments ?? [])} />

      {discussion.linkEmbeds && discussion.linkEmbeds.length > 0 && (
        <div className="embedStack">
          {discussion.linkEmbeds.map((embed) => (
            <ForumLinkEmbed embed={embed} key={embed.id} />
          ))}
        </div>
      )}

      {discussion.contentPlugins && discussion.contentPlugins.length > 0 && (
        <div className="embedStack">
          {discussion.contentPlugins.map((plugin) => {
            const app = plugin.targetType === "app"
              ? appsById.get(plugin.targetId)
              : undefined;
            const skill = plugin.targetType === "skill"
              ? skillsById.get(plugin.targetId)
              : undefined;
            return (
              <ForumContentPlugin
                app={app}
                key={plugin.id}
                onOpenProduct={onOpenProduct}
                plugin={plugin}
                skill={skill}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

export function ForumAttachmentBlocks({ attachments, compact = false }: { attachments: DiscussionAttachment[]; compact?: boolean }) {
  const images = attachments.filter((attachment) => attachment.type === "image");
  const files = attachments.filter((attachment) => attachment.type !== "image");

  if (images.length === 0 && files.length === 0) {
    return null;
  }

  return (
    <div className={`forumAttachmentBlocks ${compact ? "compact" : ""}`}>
      {images.length > 0 && <ForumImageCarousel compact={compact} images={images} />}
      {files.length > 0 && <ForumFilePreviewList compact={compact} files={files} />}
    </div>
  );
}

function ForumImageCarousel({ compact = false, images }: { compact?: boolean; images: DiscussionAttachment[] }) {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState(0);
  const activeImage = images[Math.min(activeIndex, images.length - 1)] ?? images[0];
  const hasMultiple = images.length > 1;

  useEffect(() => {
    setActiveIndex(0);
  }, [images.length]);

  function shiftImage(delta: number) {
    setActiveIndex((current) => (current + delta + images.length) % images.length);
  }

  if (!activeImage) {
    return null;
  }

  return (
    <div className={`forumImageCarousel ${compact ? "compact" : ""}`}>
      <img alt={activeImage.alt ?? activeImage.fileName} loading="lazy" src={activeImage.url} />
      {hasMultiple && (
        <>
          <button aria-label={t("forum.previousImage")} className="imageNav previous" onClick={() => shiftImage(-1)} type="button">
            <ChevronLeft size={18} />
          </button>
          <button aria-label={t("forum.nextImage")} className="imageNav next" onClick={() => shiftImage(1)} type="button">
            <ChevronRight size={18} />
          </button>
          <span className="imageCounter">{activeIndex + 1} / {images.length}</span>
        </>
      )}
      {!compact && hasMultiple && (
        <div className="imageDotRow">
          {images.map((image, index) => (
            <button
              aria-label={t("forum.showImage", { index: index + 1 })}
              className={index === activeIndex ? "active" : undefined}
              key={image.id}
              onClick={() => setActiveIndex(index)}
              type="button"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ForumFilePreviewList({ compact = false, files }: { compact?: boolean; files: DiscussionAttachment[] }) {
  const { t } = useI18n();
  const visibleFiles = compact ? files.slice(0, 2) : files;
  const hiddenCount = files.length - visibleFiles.length;

  return (
    <div className={`forumFilePreviewList ${compact ? "compact" : ""}`}>
      {visibleFiles.map((file) => (
        <a className="forumFilePreview" href={file.url} key={file.id} rel="noreferrer" target="_blank">
          <span className={`fileTypeBadge ${fileKind(file.mimeType)}`}>
            <FileText size={17} />
          </span>
          <div>
            <small>{fileLabel(file.mimeType)} / {formatBytes(file.fileSize)}</small>
            <strong>{file.fileName}</strong>
            <p>{filePreviewText(file.mimeType)}</p>
          </div>
          <ExternalLink size={16} />
        </a>
      ))}
      {hiddenCount > 0 && <div className="forumFileMore">{t("forum.moreFiles", { count: hiddenCount })}</div>}
    </div>
  );
}

export function ForumLinkEmbed({ embed }: { embed: DiscussionLinkEmbed }) {
  const videoUrl = embed.embedType === "video" ? youtubeEmbedUrl(embed.url) : undefined;
  const icon = embed.embedType === "video" ? <Film size={17} /> : embed.embedType === "social" ? <AtSign size={17} /> : <Link2 size={17} />;

  if (videoUrl) {
    return (
      <div className="forumVideoEmbed">
        <iframe
          allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          src={videoUrl}
          title={embed.title}
        />
        <a className="videoSourceLink" href={embed.url} rel="noreferrer" target="_blank">
          <Film size={15} />
          {embed.provider} / {embed.title}
        </a>
      </div>
    );
  }

  return (
    <a className={`forumEmbed ${embed.embedType}`} href={embed.url} rel="noreferrer" target="_blank">
      <span>{icon}</span>
      <div>
        <small>{embed.provider}</small>
        <strong>{embed.title}</strong>
        <p>{embed.description}</p>
      </div>
    </a>
  );
}

function ForumContentPlugin({
  app,
  onOpenProduct,
  plugin,
  skill
}: {
  app?: PortalCatalog["apps"][number];
  onOpenProduct?: (plugin: DiscussionContentPlugin) => void;
  plugin: DiscussionContentPlugin;
  skill?: PortalCatalog["skills"][number];
}) {
  return (
    <ForumProductCard
      app={app}
      className="forumEmbeddedProductCard"
      compact
      onOpen={onOpenProduct ? () => onOpenProduct(plugin) : undefined}
      plugin={plugin}
      skill={skill}
    />
  );
}

export function ForumProductCard({
  app,
  className = "",
  compact = false,
  onOpen,
  plugin,
  skill
}: {
  app?: PortalCatalog["apps"][number];
  className?: string;
  compact?: boolean;
  onOpen?: () => void;
  plugin: DiscussionContentPlugin;
  skill?: PortalCatalog["skills"][number];
}) {
  const { locale, t } = useI18n();
  const Icon = plugin.targetType === "skill" ? BookOpen : AppWindow;
  const actionLabel = plugin.actionLabel ?? (plugin.targetType === "app" ? t("forum.open") : t("forum.view"));
  const canonicalTargetId = app?.id || skill?.id || plugin.targetId;
  const href = plugin.targetType === "app"
    ? `#/apps/${encodeURIComponent(canonicalTargetId)}`
    : `#/skills/${encodeURIComponent(canonicalTargetId)}`;
  const title = app ? localizedAppName(app, locale) : skill?.name || plugin.title;
  const description = app ? localizedAppDescription(app, locale) : skill?.description || plugin.description;
  const owner = app?.publisherProfile?.name || skill?.owner || plugin.owner;
  const category = app?.category || skill?.category || plugin.category;
  const iconUrl = app?.coverImageUrl || skill?.coverImageUrl || plugin.iconUrl;
  const primaryMetricCount = app?.viewCount ?? skill?.installs ?? plugin.installs ?? 0;
  const meta = [owner, productTypeLabel(plugin.targetType, t), category].filter(Boolean).join(" | ");
  const cardClassName = [
    "forumProductCard",
    compact ? "compact" : "",
    onOpen ? "interactive" : "",
    className
  ].filter(Boolean).join(" ");

  function openProduct(event: ReactMouseEvent<HTMLElement>) {
    if (!onOpen) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onOpen();
  }

  function openProductFromKeyboard(event: ReactKeyboardEvent<HTMLElement>) {
    if (!onOpen || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onOpen();
  }

  return (
    <article
      className={cardClassName}
      onClick={onOpen ? openProduct : undefined}
      onKeyDown={onOpen ? openProductFromKeyboard : undefined}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <ForumPluginLogo fallbackIcon={<Icon size={18} />} iconUrl={iconUrl} targetType={plugin.targetType} title={title} />
      <div className="forumProductCardBody">
        {compact && (
          <small className="forumProductAttachmentType">
            {t("forum.linkedItemAttachment")} / {productTypeLabel(plugin.targetType, t)}
          </small>
        )}
        <h3>{title}</h3>
        {!compact && meta && <span className="forumProductMetaPill">{meta}</span>}
        <p>{description}</p>
        {!compact && (
          <div className="forumProductFooter">
            {owner && <strong>{owner}</strong>}
            <span>
              {plugin.targetType === "app" ? <ExternalLink size={14} /> : <Download size={14} />}
              {formatPluginCount(primaryMetricCount, locale)}
            </span>
          </div>
        )}
      </div>
      {onOpen ? (
        <span className="forumProductActionCue">
          {t("forum.viewLinkedItem")}
        </span>
      ) : (
        <ButtonLink href={href} size="compact" variant="secondary">
          {actionLabel}
        </ButtonLink>
      )}
    </article>
  );
}

function localizedAppName(app: PortalCatalog["apps"][number], locale: string) {
  return locale.startsWith("zh") ? app.nameZh || app.name : app.nameEn || app.name;
}

function localizedAppDescription(app: PortalCatalog["apps"][number], locale: string) {
  return locale.startsWith("zh") ? app.descriptionZh || app.description : app.descriptionEn || app.description;
}

function productTypeLabel(type: DiscussionContentPlugin["targetType"], t: ReturnType<typeof useI18n>["t"]) {
  if (type === "app") {
    return t("market.apps");
  }

  return type === "skill" ? t("market.skills") : t("market.apps");
}

function formatPluginCount(count: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    notation: "compact"
  }).format(count);
}

function ForumPluginLogo({
  fallbackIcon,
  iconUrl,
  targetType,
  title
}: {
  fallbackIcon: ReactNode;
  iconUrl?: string;
  targetType: DiscussionContentPlugin["targetType"];
  title: string;
}) {
  const normalizedIconUrl = iconUrl?.trim();
  const [imageFailed, setImageFailed] = useState(false);
  const palette = forumPluginPalette(hashText(`${targetType}:${title}`));
  const style = {
    "--forum-plugin-icon-a": palette.a,
    "--forum-plugin-icon-b": palette.b,
    "--forum-plugin-icon-ink": palette.ink
  } as CSSProperties;

  useEffect(() => {
    setImageFailed(false);
  }, [normalizedIconUrl]);

  return (
    <span className={`forumPluginLogo ${targetType}`} style={style}>
      {normalizedIconUrl && !imageFailed ? (
        <img alt="" onError={() => setImageFailed(true)} src={normalizedIconUrl} />
      ) : targetType === "skill" ? (
        <strong>{forumPluginInitials(title)}</strong>
      ) : (
        fallbackIcon
      )}
    </span>
  );
}

function forumPluginInitials(name: string) {
  const words = name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }

  return words[0]?.slice(0, 2).toUpperCase() || "SH";
}

function forumPluginPalette(hash: number) {
  return personPalette(hash);
}

function hashText(value: string) {
  let hash = 0;

  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash;
}
