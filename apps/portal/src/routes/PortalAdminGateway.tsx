import { Database, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../../src/portal/components/Button";
import { SegmentedControl } from "../../../../src/portal/components/SegmentedControl";
import { useI18n } from "../../../../src/portal/i18n";
import type { TranslationKey } from "../../../../src/portal/i18n/resources";
import type { PortalCatalog } from "../../../../src/shared/types";
import { usePortalAdminGateway } from "../admin/gateway/usePortalAdminGateway";
import type { AdminGatewaySection, AdminGatewayToken, AdminGatewayUserLimit } from "../admin/gateway/types";
import {
  PortalAdminDeleteTokenDialog,
  PortalAdminTokenDialog,
  PortalAdminUserLimitDialog
} from "../components/admin/PortalAdminGatewayDialogs";
import {
  PortalAdminAllocations,
  PortalAdminGatewaySummary,
  PortalAdminTokenRegistry,
  PortalAdminUsage
} from "../components/admin/PortalAdminGatewayPanels";
import { PortalRouteLoading } from "../components/PortalRecovery";
import "../styles/admin.css";

type PortalAdminGatewayProps = {
  catalog: PortalCatalog;
  onSectionChange: (section: AdminGatewaySection) => void;
  section: AdminGatewaySection;
};

export function PortalAdminGateway(props: PortalAdminGatewayProps) {
  if (props.catalog.currentUser.role !== "admin") {
    return <AdminGatewayDenied />;
  }

  return <PortalAdminGatewayAuthenticated {...props} />;
}

function PortalAdminGatewayAuthenticated({
  catalog,
  onSectionChange,
  section
}: PortalAdminGatewayProps) {
  const { locale, t } = useI18n();
  const controller = usePortalAdminGateway(catalog.currentUser.id, section);
  const [selectedToken, setSelectedToken] = useState<AdminGatewayToken>();
  const [deleteToken, setDeleteToken] = useState<AdminGatewayToken>();
  const [selectedLimit, setSelectedLimit] = useState<AdminGatewayUserLimit>();

  const fetchedAt = controller.data?.usage?.source.fetchedAt || controller.data?.allocations?.source.fetchedAt;

  if (controller.loading && !controller.ready) {
    return <PortalRouteLoading variant="admin" />;
  }

  return (
    <div className="portal-workspace-inner portal-admin-workspace">
      <section className="portal-page portal-admin-page" aria-labelledby="portal-admin-title">
        <header className="portal-page-heading portal-admin-heading">
          <div className="portal-page-heading-copy">
            <h1 id="portal-admin-title">{t("portal.admin.title")}</h1>
            <p>{t("portal.admin.subtitle")}</p>
          </div>
          <div className="portal-admin-source">
            <span><Database size={15} /> {t("portal.admin.sourceName")}</span>
            <small>{fetchedAt ? t("portal.admin.syncedAt", { time: formatSourceTime(fetchedAt, locale) }) : t("portal.admin.sourcePending")}</small>
          </div>
        </header>

        <div className="portal-admin-section-bar">
          <SegmentedControl
            ariaLabel={t("portal.admin.sectionAria")}
            className="portal-admin-sections"
            onChange={onSectionChange}
            options={[
              { label: t("portal.admin.tokens"), value: "tokens" },
              { label: t("portal.admin.allocations"), value: "allocations" },
              { label: t("portal.admin.usage"), value: "usage" }
            ]}
            value={section}
          />
          <Button iconBefore={<RefreshCw size={15} />} isLoading={controller.loading} onClick={() => void controller.load(true)} size="compact">
            {t("common.refresh")}
          </Button>
        </div>

        {!controller.ready ? (
          <section className="portal-admin-state error" role="alert">
            <ShieldAlert size={22} />
            <div><h2>{t("portal.admin.loadFailed")}</h2><p>{t("portal.admin.loadFailedBody")}</p><small>{controller.error}</small></div>
            <Button iconBefore={<RefreshCw size={15} />} onClick={() => void controller.load(true)}>{t("portal.data.retry")}</Button>
          </section>
        ) : (
          <>
            <PortalAdminGatewaySummary allocations={controller.data?.allocations} usage={controller.data?.usage} />
            {(controller.message || controller.error) && (
              <div className={`portal-admin-notice ${controller.error ? "error" : "success"}`} role={controller.error ? "alert" : "status"}>
                {controller.error || messageLabel(controller.message, t)}
              </div>
            )}
            {section === "tokens" && controller.data?.allocations && <PortalAdminTokenRegistry allocations={controller.data.allocations} onOpen={setSelectedToken} usage={controller.data.usage} />}
            {section === "allocations" && controller.data?.allocations && <PortalAdminAllocations allocations={controller.data.allocations} onOpen={setSelectedLimit} usage={controller.data.usage} />}
            {section === "usage" && controller.data?.usage && (
              <PortalAdminUsage
                busy={controller.busyId === "export"}
                groupBy={controller.groupBy}
                onExport={() => void controller.exportUsage()}
                onGroupByChange={controller.setGroupBy}
                onRangeChange={controller.setRange}
                range={controller.range}
                usage={controller.data.usage}
              />
            )}
          </>
        )}
      </section>

      {selectedToken && (
        <PortalAdminTokenDialog
          modelOptions={controller.data?.allocations?.modelOptions ?? []}
          busy={controller.busyId === selectedToken.id}
          key={selectedToken.id}
          onClose={() => setSelectedToken(undefined)}
          onDelete={() => {
            setDeleteToken(selectedToken);
            setSelectedToken(undefined);
          }}
          onSave={(draft) => controller.saveToken(selectedToken.id, draft)}
          onStatusChange={(status) => controller.setTokenStatus(selectedToken.id, status)}
          token={selectedToken}
        />
      )}
      {selectedLimit && (
        <PortalAdminUserLimitDialog
          modelOptions={controller.data?.allocations?.modelOptions ?? []}
          busy={controller.busyId === selectedLimit.userId}
          key={selectedLimit.id}
          limit={selectedLimit}
          onClose={() => setSelectedLimit(undefined)}
          onSave={(draft) => controller.saveUserLimit(selectedLimit.userId, draft)}
        />
      )}
      {deleteToken && (
        <PortalAdminDeleteTokenDialog
          busy={controller.busyId === deleteToken.id}
          onClose={() => setDeleteToken(undefined)}
          onConfirm={() => controller.removeToken(deleteToken.id)}
          token={deleteToken}
        />
      )}
    </div>
  );
}

function AdminGatewayDenied() {
  const { t } = useI18n();
  return (
    <div className="portal-workspace-inner portal-admin-workspace">
      <section className="portal-admin-state error" role="alert">
        <ShieldAlert size={22} />
        <div><h1>{t("portal.admin.accessDenied")}</h1><p>{t("portal.admin.accessDeniedBody")}</p></div>
      </section>
    </div>
  );
}

function formatSourceTime(value: string, locale: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
    : value;
}

function messageLabel(message: string, t: (key: TranslationKey) => string) {
  const key = {
    token_saved: "portal.admin.tokenSaved",
    token_activated: "portal.admin.tokenActivated",
    token_suspended: "portal.admin.tokenSuspended",
    token_deleted: "portal.admin.tokenDeleted",
    user_limit_saved: "portal.admin.userLimitSaved"
  }[message] as TranslationKey | undefined;
  return key ? t(key) : message;
}
