import type { AssetPublisherProfile, PublicationListing } from "../../shared/types";
import { publicationOwnerProfiles } from "../market/ownerDisplay";
import type { ProfileModalUser } from "./ProfileModal";
import { openUserProfile, ProfileHoverCardTarget } from "./ProfileHoverCard";
import { PersonAvatar } from "./shared/avatar";

export function PublicationAuthors({
  className = "",
  compact = false,
  fallback,
  listing
}: {
  className?: string;
  compact?: boolean;
  fallback?: string;
  listing?: PublicationListing;
}) {
  const profiles = publicationOwnerProfiles(listing);
  const alias = listing?.ownerAliasName?.trim();
  const rootClassName = [
    "publication-authors",
    compact ? "compact" : "",
    alias ? "alias-mode" : "profile-mode",
    className
  ].filter(Boolean).join(" ");

  if (profiles.length === 0 && !alias) {
    return <span className={rootClassName}><span className="publication-author-fallback">{fallback}</span></span>;
  }

  return (
    <span className={rootClassName}>
      {alias && <span className="publication-author-alias">{alias}</span>}
      {profiles.map((profile, index) => (
        <PublicationAuthorProfile
          aliasMode={Boolean(alias)}
          badgeLabel={index === 0 ? "Owner" : "Collaborator"}
          key={profile.id || profile.email || profile.name}
          profile={profile}
        />
      ))}
    </span>
  );
}

function PublicationAuthorProfile({
  aliasMode,
  badgeLabel,
  profile
}: {
  aliasMode: boolean;
  badgeLabel: string;
  profile: AssetPublisherProfile;
}) {
  const user = publisherProfileUser(profile);

  return (
    <ProfileHoverCardTarget badgeLabel={badgeLabel} user={user}>
      <button
        aria-label={user.name}
        className={`publication-author-profile${aliasMode ? " avatar-only" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          openUserProfile(user);
        }}
        title={user.name}
        type="button"
      >
        <PersonAvatar imageUrl={user.avatarUrl} name={user.name} />
        {!aliasMode && <span className="publication-author-name">{user.name}</span>}
      </button>
    </ProfileHoverCardTarget>
  );
}

function publisherProfileUser(profile: AssetPublisherProfile): ProfileModalUser {
  return {
    id: profile.id,
    name: profile.name?.trim() || profile.email?.trim() || profile.id,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
    department: profile.department,
    journeyCommunityContributionPoints: profile.journeyCommunityContributionPoints,
    journeyLevelKey: profile.journeyLevelKey,
    journeyTotalPoints: profile.journeyTotalPoints,
    team: "",
    jobTitle: profile.jobTitle,
    role: "member"
  };
}
