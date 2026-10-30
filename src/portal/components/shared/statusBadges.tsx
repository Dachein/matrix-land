import { ShieldAlert } from "lucide-react";
import type { PortalApp, ReviewStatus, SkillKind } from "../../../shared/types";
import { useI18n } from "../../i18n";

export function KindBadge({ value }: { value: SkillKind }) {
  const { t } = useI18n();

  if (value === "vanilla") {
    return null;
  }

  return <span className={`kindBadge ${value}`}>{kindLabel(value, t)}</span>;
}

export function StatusBadge({ value }: { value: ReviewStatus | PortalApp["status"] }) {
  const { t } = useI18n();

  return <span className={`statusBadge ${value}`}>{statusLabel(value, t)}</span>;
}

export function RiskBadge({ value }: { value: "low" | "medium" | "high" }) {
  const { t } = useI18n();

  return (
    <span className={`riskBadge ${value}`}>
      {value === "high" && <ShieldAlert size={13} />}
      {riskLabel(value, t)}
    </span>
  );
}

function statusLabel(value: string, t: ReturnType<typeof useI18n>["t"]) {
  if (value === "pending_review") {
    return t("ui.status.pendingReview");
  }

  if (value === "listed") {
    return t("ui.status.listed");
  }

  if (value === "delisted") {
    return t("ui.status.delisted");
  }

  if (value === "deleted") {
    return t("ui.status.deleted");
  }

  return value;
}

function riskLabel(value: "low" | "medium" | "high", t: ReturnType<typeof useI18n>["t"]) {
  if (value === "high") {
    return t("ui.risk.high");
  }

  if (value === "medium") {
    return t("ui.risk.medium");
  }

  return t("ui.risk.low");
}

function kindLabel(value: SkillKind, t: ReturnType<typeof useI18n>["t"]) {
  if (value === "knowledge") {
    return t("ui.kind.knowledge");
  }
  if (value === "app") {
    return t("ui.kind.app");
  }
  return t("ui.kind.vanilla");
}
