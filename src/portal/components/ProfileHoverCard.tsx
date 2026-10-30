import { Award, Building2, Mail, UserRound } from "lucide-react";
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { profileOrgDisplay } from "../lib/profileOrg";
import { useDepartmentDisplayPath } from "../hooks/useDepartmentDisplayPath";
import {
  subscribeToUserJourneyProjectionUpdates,
  withLatestUserJourneyProjection
} from "../lib/userJourneyProjectionEvents";
import type { ProfileModalUser } from "./ProfileModal";

export function openUserProfile(user: ProfileModalUser) {
  window.dispatchEvent(new CustomEvent("workspace:open-profile", {
    detail: withLatestUserJourneyProjection(user)
  }));
}

export function ProfileHoverCardTarget({
  badgeLabel,
  children,
  className = "",
  user
}: {
  badgeLabel?: string;
  children: ReactElement<{ "aria-describedby"?: string }>;
  className?: string;
  user: ProfileModalUser;
}) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [resolvedUser, setResolvedUser] = useState(() => withLatestUserJourneyProjection(user));
  const [position, setPosition] = useState<ProfileHoverPosition>(() => ({ left: 12, top: 12, width: 304 }));

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const viewportPadding = 12;
    const gap = 9;
    const anchorRect = anchor.getBoundingClientRect();
    const width = Math.min(304, Math.max(236, window.innerWidth - viewportPadding * 2));
    const cardHeight = cardRef.current?.offsetHeight ?? 210;
    const fitsBelow = window.innerHeight - anchorRect.bottom >= cardHeight + gap + viewportPadding;
    const top = fitsBelow
      ? anchorRect.bottom + gap
      : Math.max(viewportPadding, anchorRect.top - cardHeight - gap);
    const preferredLeft = anchorRect.left + width <= window.innerWidth - viewportPadding
      ? anchorRect.left
      : anchorRect.right - width;
    const left = Math.min(
      window.innerWidth - width - viewportPadding,
      Math.max(viewportPadding, preferredLeft)
    );

    setPosition({ left, top, width });
  }, []);

  useLayoutEffect(() => {
    if (!visible) return undefined;

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [updatePosition, visible]);

  useEffect(() => {
    setResolvedUser(withLatestUserJourneyProjection(user));
    return subscribeToUserJourneyProjectionUpdates((update) => {
      if (update.id === user.id) {
        setResolvedUser((current) => ({ ...current, ...update }));
      }
    });
  }, [user]);

  return (
    <span
      className={`profileHoverTarget ${className}`.trim()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setVisible(false);
      }}
      onClickCapture={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      ref={anchorRef}
    >
      {cloneElement(children, { "aria-describedby": tooltipId })}
      {visible && typeof document !== "undefined" && createPortal(
        <ProfileHoverCard
          badgeLabel={badgeLabel}
          cardRef={cardRef}
          id={tooltipId}
          position={position}
          user={resolvedUser}
        />,
        document.body
      )}
    </span>
  );
}

type ProfileHoverPosition = {
  left: number;
  top: number;
  width: number;
};

function ProfileHoverCard({
  badgeLabel,
  cardRef,
  id,
  position,
  user
}: {
  badgeLabel?: string;
  cardRef: RefObject<HTMLDivElement | null>;
  id: string;
  position: ProfileHoverPosition;
  user: ProfileModalUser;
}) {
  const { t } = useI18n();
  const { department } = profileOrgDisplay(user);
  const departmentDisplayPath = useDepartmentDisplayPath(user);
  const bio = user.bio?.trim() || t("profile.noBio");
  const email = user.email?.trim() || t("common.notRecorded");
  const organization = departmentDisplayPath || department
    || t("common.notAvailable");
  const fallback = profileInitials(user.name);
  const style = {
    left: position.left,
    top: position.top,
    width: position.width
  } as CSSProperties;

  return (
    <div className="profileHoverCard" id={id} ref={cardRef} role="tooltip" style={style}>
      <div className="profileHoverHeader">
        <span className="profileHoverAvatar" aria-hidden="true">
          <ProfileAvatarVisual fallback={fallback} user={user} />
        </span>
        <div className="profileHoverIdentity">
          <strong>{user.name}</strong>
          {badgeLabel && <span className="profileHoverLevel"><Award size={13} /> {badgeLabel}</span>}
          <span className="profileHoverStats">
            <span><em>{t("profile.points")}</em><strong>{user.journeyTotalPoints ?? "—"}</strong></span>
            <span><em>{t("profile.communityContribution")}</em><strong>{user.journeyCommunityContributionPoints ?? "—"}</strong></span>
          </span>
        </div>
      </div>
      <div className="profileHoverBio">
        <UserRound size={14} />
        <span><em>{t("profile.bio")}</em><strong>{bio}</strong></span>
      </div>
      <div className="profileHoverDepartment">
        <Building2 size={14} />
        <span><em>{t("profile.department")}</em><strong title={organization}>{organization}</strong></span>
      </div>
      <div className="profileHoverEmail">
        <Mail size={14} />
        <span><em>{t("profile.email")}</em><strong title={email}>{email}</strong></span>
      </div>
    </div>
  );
}

function ProfileAvatarVisual({ fallback, user }: { fallback: string; user: ProfileModalUser }) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => setImageFailed(false), [user.avatarUrl]);

  return user.avatarUrl && !imageFailed
    ? <img alt="" decoding="async" loading="lazy" onError={() => setImageFailed(true)} src={user.avatarUrl} />
    : <span>{fallback}</span>;
}

function profileInitials(name: string) {
  const normalized = name.trim();
  if (!normalized) return "?";

  const parts = normalized.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : normalized.slice(0, 2)).toUpperCase();
}
