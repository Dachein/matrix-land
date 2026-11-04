import { ArrowUpRight, PackageCheck, Star } from "lucide-react";
import type { ReactNode } from "react";
import type { DataService, PublicationListing, PortalApp, Skill } from "../../../shared/types";
import { useI18n } from "../../i18n";
import { launchPortalApp } from "../../lib/launchPortalApp";
import { publicationOwnerLabel, portalAppOwnerName } from "../../market/ownerDisplay";
import { ActivityLine } from "./activityFeed";
import { AvatarStack, OwnerLine } from "./avatar";
import { EntityCover } from "./entityCover";
import { KindBadge, RiskBadge, StatusBadge } from "./statusBadges";

export function StatCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <article className="statCard">
      <div className="statIcon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

export function SectionHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) {
  return (
    <div className="sectionHeader">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function SkillCard({ skill, action }: { skill: Skill; action?: ReactNode }) {
  const { t } = useI18n();

  return (
    <article className="entityCard skillCard">
      <EntityCover category={skill.category} description={skill.description} imageUrl={skill.coverImageUrl} kind="skill" markers={[...skill.scopes, ...skill.mcpTools]} owner={skill.owner} title={skill.name} />
      <div className="entityHeader">
        <div>
          <OwnerLine detail={t("ui.skillSteward", { category: skill.category })} owner={skill.owner} />
          <h3>{skill.name}</h3>
        </div>
        <KindBadge value={skill.kind} />
      </div>
      <p className="entityDescription">{skill.description}</p>
      <div className="entityStatsLine">
        <span>v{skill.version}</span>
        <span>{t("ui.installs", { count: skill.installs })}</span>
        <span>{t("ui.discussions", { count: skill.discussions })}</span>
      </div>
      <TagRow tags={skill.scopes} />
      {skill.dependencies.length > 0 && (
        <div className="dependencyLine">
          <PackageCheck size={14} />
          {t("ui.requires", { dependencies: skill.dependencies.join(", ") })}
        </div>
      )}
      <div className="entityHumanRow">
        <ActivityLine text={t("ui.maintainedBy", { owner: skill.owner })} />
        <AvatarStack people={[skill.owner, skill.category]} />
      </div>
      <div className="entityFooter">
        <span className={`statusBadge ${skill.status}`}>{skill.status}</span>
        <strong>
          <Star size={14} />
          {skill.rating.toFixed(1)}
        </strong>
      </div>
      {action && <div className="entityActionRow">{action}</div>}
    </article>
  );
}

export function AppCard({ app }: { app: PortalApp }) {
  const { t } = useI18n();
  const canLaunch = app.status === "listed" && app.sdkStatus === "connected";
  const appOwner = portalAppOwnerName(app);

  return (
    <article className="entityCard appCard">
      <EntityCover category={app.category} description={app.description} imageUrl={app.coverImageUrl} kind="app" markers={app.scopes} owner={appOwner} title={app.name} />
      <div className="entityHeader">
        <div>
          <OwnerLine detail={t("ui.appOwner", { category: app.category })} owner={appOwner} />
          <h3>{app.name}</h3>
        </div>
        <span className={`statusBadge ${app.status}`}>{app.status}</span>
      </div>
      <p className="entityDescription">{app.description}</p>
      <TagRow tags={app.scopes} />
      <div className="entityHumanRow">
        <ActivityLine text={t("ui.monthlyUsers", { count: app.monthlyUsers.toLocaleString() })} />
        <AvatarStack people={[appOwner, app.category]} />
      </div>
      <div className="entityFooter">
        <span>SDK {app.sdkStatus}</span>
        <button
          className="launchLinkButton"
          disabled={!canLaunch}
          onClick={() => void launchPortalApp({ ...app, trackingSource: "app_card" })}
          type="button"
        >
          {canLaunch ? t("ui.open") : t("ui.review")} <ArrowUpRight size={14} />
        </button>
      </div>
    </article>
  );
}

export function DataServiceCard({ service }: { service: DataService }) {
  const { t } = useI18n();

  return (
    <article className="entityCard dataCard">
      <div className="entityHeader">
        <div>
          <OwnerLine detail={t("ui.dataService", { freshness: service.freshness })} owner={service.owner} />
          <h3>{service.name}</h3>
        </div>
        <RiskBadge value={service.risk} />
      </div>
      <p className="entityDescription">{service.description}</p>
      <div className="entityStatsLine">
        <span>{t("ui.tools", { count: service.tools.length })}</span>
        <span>{t("ui.callsPerMonth", { count: service.monthlyCalls.toLocaleString() })}</span>
        <span>{t("ui.boundSkills", { count: service.boundSkills.length })}</span>
      </div>
      <TagRow tags={service.scopes} />
      <div className="endpointLine">{service.endpoint}</div>
      <div className="entityFooter">
        <StatusBadge value={service.status} />
        <strong>{service.boundSkills.join(", ") || t("ui.unbound")}</strong>
      </div>
    </article>
  );
}

export function PublicationListingCard({ listing }: { listing: PublicationListing }) {
  const { t } = useI18n();
  const owner = publicationOwnerLabel(listing, t("portal.brand.name"));
  const primaryMetricCount = listing.type === "app"
    ? listing.visitCount ?? 0
    : (listing.agentAddCount ?? 0) + (listing.downloadCount ?? listing.installs);

  return (
    <article className="entityCard listingCard">
      <EntityCover category={listing.category} description={listing.description || listing.summary} imageUrl={listing.coverImageUrl} kind={listing.type} markers={listing.tags} owner={owner} title={listing.name} />
      <div className="entityHeader">
        <div>
          <OwnerLine detail={t("ui.categoryPublisher", { category: listing.category })} owner={owner} />
          <h3>{listing.name}</h3>
        </div>
        <span className={`typeBadge ${listing.type}`}>{listing.type === "app" ? "App" : "Skill"}</span>
      </div>
      <p className="entityDescription">{listing.summary || listing.description}</p>
      <div className="entityStatsLine">
        <span>{t(listing.type === "app" ? "ui.visits" : "ui.uses", { count: primaryMetricCount })}</span>
        <span>{t("ui.comments", { count: listing.comments })}</span>
        <span>{listing.visibility}</span>
      </div>
      <TagRow tags={listing.tags} />
      <div className="entityHumanRow">
        <ActivityLine text={t("common.updated") + ` ${listing.updatedAt}`} />
        <AvatarStack people={[owner, listing.category]} />
      </div>
      <div className="entityFooter">
        <span className={`statusBadge ${listing.status}`}>{listing.status}</span>
        <strong>
          <Star size={14} />
          {listing.rating.toFixed(1)}
        </strong>
      </div>
    </article>
  );
}

export function TagRow({ tags }: { tags: string[] }) {
  return (
    <div className="tagRow">
      {tags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
    </div>
  );
}
