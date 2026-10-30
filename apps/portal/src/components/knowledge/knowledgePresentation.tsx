import type { ReactNode } from "react";
import type { PortalKnowledgeSection } from "../../routing/portalRoutes";
import type { useKnowledgeWorkspace } from "../../../../../src/portal/knowledge/useKnowledgeWorkspace";
import type { KnowledgeItem, KnowledgeKind } from "../../../../../src/portal/knowledge/types";
import { useI18n } from "../../../../../src/portal/i18n";
import { knowledgeSharingScope } from "../../../../../src/portal/knowledge/utils";
import type { ProfileModalUser } from "../../../../../src/portal/components/ProfileModal";
import { File, Folder, FileCode2, FileImage, FileText } from "lucide-react";

export type Controller = ReturnType<typeof useKnowledgeWorkspace>;

export function PortalKnowledgeAccessBadge({
  item
}: {
  item: KnowledgeItem;
}) {
  const { t } = useI18n();
  const scope = knowledgeSharingScope(item);
  const label = scope.kind === "collaboration"
    ? t("knowledge.visibility.collaboration", { count: scope.count })
    : t(`knowledge.visibility.${scope.kind}`);

  return (
    <span className={`portal-knowledge-access-badge ${scope.kind}`}>
      {label}
    </span>
  );
}

export function knowledgeOwnerProfile(
  item: KnowledgeItem,
  profile: ProfileModalUser | undefined,
  unavailableLabel: string
): ProfileModalUser {
  if (profile) {
    return profile;
  }

  const legacyOwnerName = item.owner.trim();
  const hasLegacyName = legacyOwnerName && !looksLikeUserIdentifier(legacyOwnerName);
  const name = hasLegacyName ? legacyOwnerName : unavailableLabel;

  return {
    email: "",
    id: `knowledge-owner:${item.ownerUserId || name}`,
    name,
    role: "member",
    team: ""
  };
}

export function knowledgeParticipantProfile(
  item: KnowledgeItem,
  userId: string,
  profile: ProfileModalUser | undefined,
  unavailableLabel: string
): ProfileModalUser {
  if (profile) return profile;
  if (userId === item.ownerUserId) return knowledgeOwnerProfile(item, profile, unavailableLabel);
  return {
    email: "",
    id: `knowledge-collaborator:${userId}`,
    name: unavailableLabel,
    role: "member",
    team: ""
  };
}

function looksLikeUserIdentifier(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)
    || /^(?:user|usr|uid|auth)[_:-][a-z0-9_-]+$/i.test(value);
}

export function PortalKnowledgeItemIcon({ item, size }: { item: KnowledgeItem; size: number }) {
  const Icon = knowledgeKindIcon(item.kind);
  return <Icon size={size} />;
}

function knowledgeKindIcon(kind: KnowledgeKind) {
  return {
    binary: File,
    folder: Folder,
    html: FileCode2,
    image: FileImage,
    markdown: FileText,
    pdf: FileText,
    text: FileText
  }[kind];
}

export function knowledgeRootLabel(section: PortalKnowledgeSection, t: ReturnType<typeof useI18n>["t"]) {
  if (section === "services") return t("knowledge.nav.services");
  return t("knowledge.root");
}

export function knowledgeDisplayPath(
  section: PortalKnowledgeSection,
  breadcrumbLabels: string[],
  item: KnowledgeItem | undefined,
  t: ReturnType<typeof useI18n>["t"]
) {
  const labels = item ? [...breadcrumbLabels, item.name] : breadcrumbLabels;
  return [knowledgeRootLabel(section, t), ...labels].join(" / ");
}

export function ContextAction({ disabled = false, icon, label, onClick, tone = "default" }: { disabled?: boolean; icon: ReactNode; label: string; onClick: () => void; tone?: "danger" | "default" }) {
  return <button className={tone} disabled={disabled} onClick={onClick} role="menuitem" type="button">{icon}<span>{label}</span></button>;
}
