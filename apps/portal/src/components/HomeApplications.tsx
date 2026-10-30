import { useMemo, useState, useSyncExternalStore } from "react";
import { useI18n } from "../../../../src/portal/i18n";
import { addHomePin, readHomePinsSnapshot, removeHomePin, subscribeHomePins } from "../../../../src/portal/lib/homePins";
import type { PortalCatalog } from "../../../../src/shared/types";
import { buildPortalHomeApplications } from "../lib/viewModels";
import { ApplicationRail, ApplicationRailSkeleton } from "./HomeApplicationRail";

export function HomeApplications({ applicationsLoading, catalog }: {
  applicationsLoading: boolean;
  catalog: PortalCatalog;
}) {
  const { t } = useI18n();
  const homePinsSnapshot = useSyncExternalStore(
    subscribeHomePins,
    () => readHomePinsSnapshot(catalog.currentUser.id),
    () => "[[],[]]"
  );
  const [showHiddenApps, setShowHiddenApps] = useState(false);
  const { publicApps, exclusiveApps, hiddenApps } = useMemo(
    () => buildPortalHomeApplications(catalog), [catalog, homePinsSnapshot]);
  const hasApps = publicApps.length + exclusiveApps.length + hiddenApps.length > 0;

  if (!applicationsLoading && !hasApps) return null;

  return (
    <div className="portal-home-applications">
      <section className="portal-quick-access">
        <header className="portal-quick-header">
          <h2>{t("portal.home.publicApplications")}</h2>
          <div className="portal-quick-actions">
            {hiddenApps.length > 0 && (
              <button aria-expanded={showHiddenApps} onClick={() => setShowHiddenApps(!showHiddenApps)} type="button">
                {t(showHiddenApps ? "portal.home.collapseHidden" : "portal.home.showHidden", { count: hiddenApps.length })}
              </button>
            )}
          </div>
        </header>
        {applicationsLoading && !hasApps
          ? <ApplicationRailSkeleton label={t("portal.data.loadingTitle")} />
          : publicApps.length > 0 ? (
              <ApplicationRail
                ariaLabel={t("portal.home.publicApplications")}
                removeLabel={() => t("portal.home.hideApplication")}
                onRemove={(shortcut) => removeHomePin({ id: shortcut.id, kind: "app" }, {
                  accessibleAppTargetIds: catalog.hubListings.filter((listing) => listing.type === "app").map((listing) => listing.targetId),
                  userId: catalog.currentUser.id
                })}
                shortcuts={publicApps}
              />
            ) : <p className="portal-quick-empty">{t("portal.home.noApplications")}</p>}
        {showHiddenApps && hiddenApps.length > 0 && (
          <>
            <ApplicationRail ariaLabel={t("portal.home.hiddenApplications")} shortcuts={hiddenApps} />
            <div className="portal-quick-actions">
              {hiddenApps.filter((app) => app.homeDisplay !== "hidden").map((app) => (
                <button
                  key={app.id}
                  onClick={() => addHomePin({ id: app.id, kind: "app" }, { userId: catalog.currentUser.id })}
                  type="button"
                >
                  {t("portal.home.restoreApplication", { name: app.name })}
                </button>
              ))}
            </div>
          </>
        )}
      </section>
      <section className="portal-quick-access">
        <header className="portal-quick-header">
          <h2>{t("portal.home.exclusiveApplications")}</h2>
          <span>{t("portal.home.exclusiveApplicationsHint")}</span>
        </header>
        {exclusiveApps.length > 0
          ? <ApplicationRail ariaLabel={t("portal.home.exclusiveApplications")} shortcuts={exclusiveApps} />
          : <p className="portal-quick-empty">{t("portal.home.noApplications")}</p>}
      </section>
    </div>
  );
}
