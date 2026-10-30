import { Award, BookOpen, Camera, ChevronRight, LogOut, MessageCircle, Move, Package, Save, X } from "lucide-react";
import type { ChangeEvent, CSSProperties, FormEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { portalJourneyBadgeImageUrl, portalJourneyLevels } from "../../shared/journey";
import { useDepartmentDisplayPath } from "../hooks/useDepartmentDisplayPath";
import type { PortalCatalog, PortalJourney, PortalJourneyLevelKey } from "../../shared/types";
import { useI18n } from "../i18n";
import { profileOrgDisplay } from "../lib/profileOrg";
import { Button } from "./Button";
import { FormField, TextArea, TextInput } from "./FormField";
import { JourneyShowcase } from "./JourneyShowcase";
import "../../../apps/portal/src/styles/journey.css";
import { ModalShell } from "./ModalShell";
import { RelativeTime } from "./shared/time";

export type ProfileModalUser = Pick<
  PortalCatalog["currentUser"],
  "id" | "name" | "email" | "avatarUrl" | "team" | "department" | "departmentId" | "departmentPath" | "departmentDisplayPath" | "jobTitle" | "bio" | "location" | "role"
> & {
  journeyBadgeCount?: number;
  journeyCommunityContributionPoints?: number;
  journeyBadges?: Array<{
    awardedAt: string;
    badgeKey: string;
    descriptionEn: string;
    descriptionZh: string;
    nameEn: string;
    nameZh: string;
    points: number;
  }>;
  journeyLevelKey?: PortalJourneyLevelKey;
  journeyTotalPoints?: number;
  publishedSkills?: Array<{
    coverImageUrl?: string;
    id: string;
    installs: number;
    name: string;
    publishedAt: string;
    summary: string;
    targetId: string;
  }>;
  recentPosts?: Array<{
    createdAt: string;
    id: string;
    replyCount: number;
    title: string;
  }>;
};

export type ProfileUpdateInput = {
  name: string;
  avatarUrl: string;
  bio: string;
  jobTitle: string;
  location: string;
};

type ProfileModalProps = {
  completionRequired?: boolean;
  currentUserId: string;
  detailsLoading?: boolean;
  initialTab?: "basic" | "journey";
  journey?: PortalJourney;
  user: ProfileModalUser;
  onClose: () => void;
  onLogout?: () => void;
  onLinkMicrosoft?: () => void;
  onSave?: (updates: ProfileUpdateInput) => Promise<ProfileModalUser | void>;
};

const AVATAR_OUTPUT_SIZE = 600;
const AVATAR_OUTPUT_TYPE = "image/jpeg";

export function ProfileModal({ completionRequired = false, currentUserId, detailsLoading = false, initialTab = "basic", journey, onClose, onLogout, onLinkMicrosoft, onSave, user }: ProfileModalProps) {
  const { locale, t } = useI18n();
  const [name, setName] = useState(user.name);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [avatarEditor, setAvatarEditor] = useState<{
    offsetX: number;
    offsetY: number;
    src: string;
    zoom: number;
  } | null>(null);
  const [bio, setBio] = useState(user.bio ?? "");
  const [jobTitle, setJobTitle] = useState(user.jobTitle ?? "");
  const [location, setLocation] = useState(user.location ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [activeTab, setActiveTab] = useState<"basic" | "journey">(initialTab);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarPreviewRef = useRef<HTMLCanvasElement>(null);
  const avatarDragRef = useRef<{
    pointerId: number;
    startOffsetX: number;
    startOffsetY: number;
    startX: number;
    startY: number;
  } | null>(null);
  const previousUserIdRef = useRef(user.id);
  const isOwnProfile = user.id === currentUserId;
  const canEdit = isOwnProfile && Boolean(onSave);
  const showJourneyTab = isOwnProfile && !completionRequired && Boolean(journey);
  const initials = userInitials(name || user.name);
  const orgDisplay = profileOrgDisplay(user);
  const departmentDisplayPath = useDepartmentDisplayPath(user);
  const departmentValue = departmentDisplayPath || orgDisplay.department || t("common.notAvailable");
  const heroBio = bio.trim();
  const heroTitle = readProfileText(canEdit ? jobTitle : user.jobTitle);
  const currentLevel = journey?.level
    ?? portalJourneyLevels.find((level) => level.key === user.journeyLevelKey)
    ?? portalJourneyLevels[0];
  const journeyPoints = journey?.totalPoints ?? user.journeyTotalPoints ?? 0;
  const journeyCommunityContributionPoints = journey?.communityContributionPoints ?? user.journeyCommunityContributionPoints ?? 0;
  const journeyBadgeCount = journey?.badgeCount ?? user.journeyBadgeCount ?? user.journeyBadges?.length ?? 0;
  const journeyBadges = journey?.badges ?? user.journeyBadges ?? [];
  const avatarZoomProgress = avatarEditor ? `${((avatarEditor.zoom - 1) / 2) * 100}%` : "0%";

  useEffect(() => {
    const isNewProfile = previousUserIdRef.current !== user.id;

    setName(user.name);
    setAvatarUrl(user.avatarUrl ?? "");
    setAvatarEditor(null);
    setBio(user.bio ?? "");
    setJobTitle(user.jobTitle ?? "");
    setLocation(user.location ?? "");
    if (isNewProfile) {
      setStatus("idle");
      setMessage("");
      setActiveTab(initialTab);
    }
    previousUserIdRef.current = user.id;
  }, [initialTab, user]);

  useEffect(() => {
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !completionRequired) {
        onClose();
      }
    };

    document.addEventListener("keydown", closeFromKeyboard);
    return () => document.removeEventListener("keydown", closeFromKeyboard);
  }, [onClose]);

  useEffect(() => {
    if (!avatarEditor || !avatarPreviewRef.current) {
      return;
    }

    void drawAvatarToCanvas(avatarPreviewRef.current, avatarEditor);
  }, [avatarEditor]);

  useEffect(() => {
    if (!showJourneyTab && activeTab !== "basic") {
      setActiveTab("basic");
    }
  }, [activeTab, showJourneyTab]);

  useEffect(() => {
    if (initialTab === "journey" && showJourneyTab) {
      setActiveTab("journey");
    }
  }, [initialTab, showJourneyTab]);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canEdit || !onSave) {
      return;
    }

    const nextName = name.trim();
    const nextAvatarUrl = avatarUrl.trim();
    const nextBio = bio.trim();
    const nextJobTitle = jobTitle.trim();
    const nextLocation = location.trim();

    if (!nextName) {
      setStatus("error");
      setMessage(t("profile.fillName"));
      return;
    }

    if (!nextAvatarUrl) {
      setStatus("error");
      setMessage(t("profile.fillAvatar"));
      return;
    }

    if (!nextBio) {
      setStatus("error");
      setMessage(t("profile.fillBio"));
      return;
    }

    if (avatarEditor) {
      setStatus("error");
      setMessage(t("profile.finishCrop"));
      return;
    }

    setStatus("saving");
    setMessage("");

    try {
      await onSave({
        name: nextName,
        avatarUrl: nextAvatarUrl,
        bio: nextBio,
        jobTitle: nextJobTitle,
        location: nextLocation
      });
      setStatus("success");
      setMessage(t("profile.saved"));
    } catch {
      setStatus("error");
      setMessage(t("profile.saveFailed"));
    }
  }

  function readAvatarFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setStatus("error");
      setMessage(t("profile.chooseImage"));
      return;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        setAvatarEditor({
          offsetX: 0,
          offsetY: 0,
          src: reader.result,
          zoom: 1
        });
        setStatus("idle");
        setMessage(t("profile.adjustCrop"));
      }
    });
    reader.addEventListener("error", () => {
      setStatus("error");
      setMessage(t("profile.imageReadFailed"));
    });
    reader.readAsDataURL(file);
  }

  async function applyAvatarCrop() {
    if (!avatarEditor) {
      return;
    }

    setStatus("idle");
    setMessage("");

    try {
      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_OUTPUT_SIZE;
      canvas.height = AVATAR_OUTPUT_SIZE;
      await drawAvatarToCanvas(canvas, avatarEditor);
      setAvatarUrl(compressAvatarCanvas(canvas));
      setAvatarEditor(null);
      setMessage(t("profile.avatarGenerated"));
    } catch {
      setStatus("error");
      setMessage(t("profile.cropFailed"));
    }
  }

  function beginAvatarDrag(event: PointerEvent<HTMLCanvasElement>) {
    if (!avatarEditor) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    avatarDragRef.current = {
      pointerId: event.pointerId,
      startOffsetX: avatarEditor.offsetX,
      startOffsetY: avatarEditor.offsetY,
      startX: event.clientX,
      startY: event.clientY
    };
  }

  function moveAvatarDrag(event: PointerEvent<HTMLCanvasElement>) {
    const dragState = avatarDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = rect.width ? 200 / rect.width : 0;
    const scaleY = rect.height ? 200 / rect.height : 0;
    const nextOffsetX = clamp(dragState.startOffsetX + (event.clientX - dragState.startX) * scaleX, -100, 100);
    const nextOffsetY = clamp(dragState.startOffsetY + (event.clientY - dragState.startY) * scaleY, -100, 100);

    setAvatarEditor((current) => current ? { ...current, offsetX: nextOffsetX, offsetY: nextOffsetY } : current);
  }

  function endAvatarDrag(event: PointerEvent<HTMLCanvasElement>) {
    const dragState = avatarDragRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    avatarDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function requestClose() {
    if (!completionRequired) {
      onClose();
    }
  }

  return (
    <ModalShell
      ariaLabel={t("profile.modalAria", { name: user.name })}
      modalClassName={[
        "profileModal",
        completionRequired ? "requiredProfileModal" : "",
        !canEdit ? "publicProfileModal" : "",
        activeTab === "journey" ? "journeyProfileModal" : ""
      ].filter(Boolean).join(" ")}
      onClose={requestClose}
      overlayClassName={completionRequired ? "profileModalOverlay locked" : "profileModalOverlay"}
    >
      <form className="profileModalForm" onSubmit={saveProfile}>
        {!completionRequired && (
          <button aria-label={t("profile.close")} className="profileCloseButton" onClick={onClose} type="button">
            <X size={18} />
          </button>
        )}

        <div className="profileHero">
          {canEdit ? (
            <button
              aria-label={t("profile.uploadAvatar")}
              className="profileAvatarLarge profileAvatarUploadButton"
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              {avatarUrl ? <img alt="" src={avatarUrl} /> : <span>{initials}</span>}
              <span className="profileAvatarUploadCue" aria-hidden="true">
                <Camera size={16} />
              </span>
            </button>
          ) : (
            <div className="profileAvatarLarge">
              {avatarUrl ? <img alt="" src={avatarUrl} /> : <span>{initials}</span>}
            </div>
          )}
          <div className="profileHeroCopy">
            <h2>{name || user.name}</h2>
            {currentLevel && (
              <span className="profileLevelMarker">
                <Award size={14} />
                Level {currentLevel.rank} · {localizedLevelName(currentLevel, locale)}
              </span>
            )}
            {canEdit ? (
              <span className={heroBio ? "profileHeroBio" : "profileHeroBio empty"}>{heroBio || t("profile.bioRequiredHint")}</span>
            ) : (
              <div className="profileHeroMeta">
                <span>{departmentValue}</span>
                {heroTitle && <strong>{heroTitle}</strong>}
              </div>
            )}
            {completionRequired && <small>{t("profile.requiredHint")}</small>}
          </div>
          <input accept="image/*" className="visuallyHidden" onChange={readAvatarFile} ref={fileInputRef} type="file" />
        </div>

        {showJourneyTab && (
          <div className="profileTabs" role="tablist" aria-label={t("profile.tabs.aria")}>
            <button className={activeTab === "basic" ? "active" : ""} onClick={() => setActiveTab("basic")} role="tab" type="button">
              {t("profile.tabs.basic")}
            </button>
            <button className={activeTab === "journey" ? "active" : ""} onClick={() => setActiveTab("journey")} role="tab" type="button">
              {t("profile.tabs.journey")}
            </button>
          </div>
        )}

        <div className="profileBody">
          {activeTab === "basic" && canEdit && avatarEditor && (
            <div className="avatarCropPanel">
              <div className="avatarCropHeader">
                <div>
                  <span>{t("profile.cropTitle")}</span>
                  <strong>{t("profile.avatarOutputSize")}</strong>
                </div>
                <Button onClick={() => setAvatarEditor(null)} size="compact" variant="secondary">
                  {t("profile.cancelCrop")}
                </Button>
              </div>
              <div className="avatarCropPreviewWrap">
                <canvas
                  aria-label={t("profile.cropHint")}
                  className="avatarCropPreview"
                  height={AVATAR_OUTPUT_SIZE}
                  onPointerCancel={endAvatarDrag}
                  onPointerDown={beginAvatarDrag}
                  onPointerMove={moveAvatarDrag}
                  onPointerUp={endAvatarDrag}
                  ref={avatarPreviewRef}
                  width={AVATAR_OUTPUT_SIZE}
                />
                <span className="avatarCropDragCue" aria-hidden="true">
                  <Move size={18} />
                </span>
              </div>
              <label className="avatarCropSlider">
                <span className="avatarCropSliderText">
                  <span>{t("profile.zoom")}</span>
                  <small>{t("profile.cropHint")}</small>
                </span>
                <input
                  max="3"
                  min="1"
                  onChange={(event) => setAvatarEditor((current) => current ? { ...current, zoom: Number(event.target.value) } : current)}
                  step="0.01"
                  style={{ "--avatar-zoom-progress": avatarZoomProgress } as CSSProperties}
                  type="range"
                  value={avatarEditor.zoom}
                />
              </label>
              <div className="avatarCropActions">
                <Button onClick={() => void applyAvatarCrop()} size="compact" variant="primary">
                  {t("profile.useAvatar")}
                </Button>
              </div>
            </div>
          )}

          {activeTab === "basic" && canEdit && (
            <FormField label={t("profile.name")}>
              <TextInput maxLength={120} onChange={(event) => setName(event.target.value)} value={name} />
            </FormField>
          )}

          {activeTab === "basic" && (canEdit ? (
            <FormField label={t("profile.bio")}>
              <TextArea
                maxLength={280}
                onChange={(event) => setBio(event.target.value)}
                placeholder={t("profile.bioPlaceholder")}
                required
                rows={3}
                value={bio}
              />
            </FormField>
          ) : heroBio ? (
            <p className="profileBio">{heroBio}</p>
          ) : null)}

          {activeTab === "basic" && canEdit && (
            <FormField label={t("profile.title")}>
              <TextInput maxLength={120} onChange={(event) => setJobTitle(event.target.value)} placeholder={t("profile.titlePlaceholder")} value={jobTitle} />
            </FormField>
          )}

          {activeTab === "basic" && canEdit && (
            <FormField label={t("profile.location")}>
              <TextInput maxLength={80} onChange={(event) => setLocation(event.target.value)} placeholder={t("profile.locationPlaceholder")} value={location} />
            </FormField>
          )}

          {activeTab === "basic" && (
            <div className="profileInfoGrid">
              <div>
                <span>{t("profile.department")}</span>
                <strong>{departmentValue}</strong>
              </div>
              {!canEdit && heroTitle && (
                <div>
                  <span>{t("profile.title")}</span>
                  <strong>{heroTitle}</strong>
                </div>
              )}
              <div className="profileInfoCard profileInfoCardWide">
                <span>{t("profile.email")}</span>
                <strong className="profileEmailText">{user.email || t("common.notAvailable")}</strong>
              </div>
            </div>
          )}

          {activeTab === "basic" && !completionRequired && (
            <ProfileHighlights
              badges={journeyBadges}
              badgeCount={journeyBadgeCount}
              communityContributionPoints={journeyCommunityContributionPoints}
              level={currentLevel}
              loading={detailsLoading}
              onNavigate={onClose}
              points={journeyPoints}
              posts={user.recentPosts ?? []}
              skills={user.publishedSkills ?? []}
            />
          )}

          {activeTab === "journey" && journey && (
            <JourneyShowcase journey={journey} locale={locale} variant="modal" />
          )}
        </div>

        <div className="profileFooter">
          <div className="profileFooterLeft">
            {isOwnProfile && onLinkMicrosoft && (
              <Button onClick={onLinkMicrosoft} size="compact" variant="secondary">
                {locale === "zh-CN" ? "关联 Microsoft 登录" : "Link Microsoft sign-in"}
              </Button>
            )}
            {isOwnProfile && onLogout && (
              <Button iconBefore={<LogOut size={16} />} onClick={onLogout} size="compact" variant="secondary">
                {t("layout.signOut")}
              </Button>
            )}
          </div>
          <span className={`profileStatus ${status}`}>{message}</span>
          <div className="profileFooterActions">
            {canEdit && activeTab === "basic" ? (
              <Button iconBefore={<Save size={16} />} isLoading={status === "saving"} size="compact" type="submit" variant="primary">
                {completionRequired ? t("profile.saveAndContinue") : t("common.save")}
              </Button>
            ) : (
              <Button onClick={onClose} size="compact" variant="secondary">
                {t("common.close")}
              </Button>
            )}
          </div>
        </div>
      </form>
    </ModalShell>
  );
}

function ProfileHighlights({
  badges,
  badgeCount,
  communityContributionPoints,
  level,
  loading,
  onNavigate,
  points,
  posts,
  skills
}: {
  badges: Array<{
    awardedAt: string;
    badgeKey: string;
    descriptionEn: string;
    descriptionZh: string;
    nameEn: string;
    nameZh: string;
    points: number;
  }>;
  badgeCount: number;
  communityContributionPoints: number;
  level: PortalJourney["level"];
  loading: boolean;
  onNavigate: () => void;
  points: number;
  posts: NonNullable<ProfileModalUser["recentPosts"]>;
  skills: NonNullable<ProfileModalUser["publishedSkills"]>;
}) {
  const { locale, t } = useI18n();

  return (
    <section className="profileHighlights" aria-label={t("profile.highlights")}>
      <div className="profileStatStrip">
        <div>
          <span>{t("profile.level")}</span>
          <strong>Level {level.rank}</strong>
          <small>{locale === "zh-CN" ? level.nameZh : level.nameEn}</small>
        </div>
        <div>
          <span>{t("profile.points")}</span>
          <strong>{loading ? "—" : points}</strong>
          <small>{t("profile.pointsUnit")}</small>
        </div>
        <div>
          <span>{t("profile.communityContribution")}</span>
          <strong>{loading ? "—" : communityContributionPoints}</strong>
          <small>{t("profile.pointsUnit")}</small>
        </div>
        <div>
          <span>{t("profile.badges")}</span>
          <strong>{loading ? "—" : badgeCount}</strong>
          <small>{t("profile.badgeUnit")}</small>
        </div>
      </div>

      <div className="profileActivityGrid">
        <section className="profileActivityPanel">
          <header>
            <span><BookOpen size={15} /> {t("profile.recentPosts")}</span>
            <small>{t("profile.latestFive")}</small>
          </header>
          <div className="profilePostList">
            {loading ? <ProfileHighlightsLoading /> : posts.length > 0 ? posts.map((post) => (
              <a href={`#/posts/${encodeURIComponent(post.id)}`} key={post.id} onClick={onNavigate}>
                <span>
                  <strong>{post.title}</strong>
                  <small><RelativeTime value={post.createdAt} /> · <MessageCircle size={11} /> {post.replyCount}</small>
                </span>
                <ChevronRight aria-hidden="true" size={15} />
              </a>
            )) : <p className="profileActivityEmpty">{t("profile.noRecentPosts")}</p>}
          </div>
        </section>

        <section className="profileActivityPanel">
          <header>
            <span><Package size={15} /> {t("profile.publishedSkills")}</span>
            <small>{loading ? "—" : skills.length}</small>
          </header>
          <div className="profileSkillList">
            {loading ? <ProfileHighlightsLoading /> : skills.length > 0 ? skills.map((skill) => (
              <a href={`#/skills/${encodeURIComponent(skill.targetId)}`} key={skill.id} onClick={onNavigate}>
                <span className="profileSkillCover" aria-hidden="true">
                  {skill.coverImageUrl ? <img alt="" decoding="async" loading="lazy" src={skill.coverImageUrl} /> : <Package size={17} />}
                </span>
                <span>
                  <strong>{skill.name}</strong>
                  <small>{t("profile.skillInstalls", { count: skill.installs })}</small>
                </span>
                <ChevronRight aria-hidden="true" size={15} />
              </a>
            )) : <p className="profileActivityEmpty">{t("profile.noPublishedSkills")}</p>}
          </div>
        </section>
      </div>

      <section className="profileBadgeShelf">
        <header>
          <span><Award size={15} /> {t("profile.recentBadges")}</span>
          <small>{loading ? t("profile.loadingHighlights") : t("profile.badgeCount", { count: badgeCount })}</small>
        </header>
        {loading ? <ProfileHighlightsLoading /> : badges.length > 0 ? (
          <div className="profileBadgeList">
            {badges.slice(0, 6).map((badge) => (
              <div key={badge.badgeKey} title={locale === "zh-CN" ? badge.descriptionZh : badge.descriptionEn}>
                <img alt="" loading="lazy" src={portalJourneyBadgeImageUrl(badge.badgeKey)} />
                <span>
                  <strong>{locale === "zh-CN" ? badge.nameZh : badge.nameEn}</strong>
                  <small>+{badge.points} {t("profile.pointsUnit")}</small>
                </span>
              </div>
            ))}
          </div>
        ) : <p className="profileActivityEmpty">{t("profile.noBadges")}</p>}
      </section>
    </section>
  );
}

function ProfileHighlightsLoading() {
  const { t } = useI18n();

  return (
    <div className="profileHighlightsLoading" role="status">
      <span aria-hidden="true" />
      <span>{t("profile.loadingHighlights")}</span>
    </div>
  );
}

function localizedLevelName(level: PortalJourney["levels"][number], locale: ReturnType<typeof useI18n>["locale"]) {
  return locale === "zh-CN" ? level.nameZh : level.nameEn;
}

function userInitials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] ?? ""];

  return letters.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function readProfileText(value?: string) {
  return (value ?? "").trim();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", reject);
    image.src = src;
  });
}

async function drawAvatarToCanvas(
  canvas: HTMLCanvasElement,
  editor: { offsetX: number; offsetY: number; src: string; zoom: number }
) {
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("canvas_unavailable");
  }

  const image = await loadImage(editor.src);
  const baseScale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const scale = baseScale * editor.zoom;
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const maxOffsetX = Math.max(0, (drawWidth - canvas.width) / 2);
  const maxOffsetY = Math.max(0, (drawHeight - canvas.height) / 2);
  const drawX = (canvas.width - drawWidth) / 2 + (editor.offsetX / 100) * maxOffsetX;
  const drawY = (canvas.height - drawHeight) / 2 + (editor.offsetY / 100) * maxOffsetY;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

function compressAvatarCanvas(canvas: HTMLCanvasElement) {
  const qualities = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5];
  let bestDataUrl = canvas.toDataURL(AVATAR_OUTPUT_TYPE, qualities[0]);

  for (const quality of qualities.slice(1)) {
    if (bestDataUrl.length < 360000) {
      break;
    }

    bestDataUrl = canvas.toDataURL(AVATAR_OUTPUT_TYPE, quality);
  }

  return bestDataUrl;
}
