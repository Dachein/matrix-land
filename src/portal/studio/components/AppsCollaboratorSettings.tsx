import { UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PortalCatalog } from "../../../shared/types";
import { Button } from "../../components/Button";
import { PeopleMentionPicker, type PeopleMentionCandidate } from "../../components/PeopleMentionPicker";
import { usePeopleDirectory } from "../../hooks/usePeopleDirectory";
import { useI18n } from "../../i18n";
import { AppsCapabilityCard } from "./AppsCapabilityCard";

export function AppsCollaboratorSettings({
  catalog,
  collaboratorUserIds,
  entityId,
  entityType,
  onSave,
  ownerUserId
}: {
  catalog: PortalCatalog;
  collaboratorUserIds: string[];
  entityId: string;
  entityType: "app" | "skill";
  onSave: (collaboratorUserIds: string[]) => Promise<boolean>;
  ownerUserId: string;
}) {
  const { t } = useI18n();
  const { people: users, state: directoryState } = usePeopleDirectory(catalog);
  const savedUserIds = useMemo(
    () => canonicalCollaboratorIds(collaboratorUserIds, users),
    [collaboratorUserIds, users]
  );
  const [isEditing, setIsEditing] = useState(false);
  const [draftUserIds, setDraftUserIds] = useState(() => normalizedIds(collaboratorUserIds));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const collaboratorKey = savedUserIds.join("\u0000");
  const excludedOwnerIdentifiers = useMemo(() => {
    const ownerIdentifier = normalizeIdentifier(ownerUserId);
    const currentUserIdentifiers = [catalog.currentUser.id, catalog.currentUser.email].map(normalizeIdentifier);
    const ownerDirectoryUser = users.find((user) => [user.id, user.email]
      .some((identifier) => normalizeIdentifier(identifier) === ownerIdentifier));
    const resolvedOwnerIdentifiers = [
      ownerIdentifier,
      ownerDirectoryUser?.id ? normalizeIdentifier(ownerDirectoryUser.id) : "",
      ownerDirectoryUser?.email ? normalizeIdentifier(ownerDirectoryUser.email) : ""
    ].filter(Boolean);
    const currentUserIsOwner = resolvedOwnerIdentifiers.some((identifier) => currentUserIdentifiers.includes(identifier));
    return new Set([
      ...resolvedOwnerIdentifiers,
      ...(currentUserIsOwner ? currentUserIdentifiers : [])
    ].filter(Boolean));
  }, [catalog.currentUser.email, catalog.currentUser.id, ownerUserId, users]);
  const collaboratorCandidates = useMemo<PeopleMentionCandidate[]>(() => users
    .filter((user) => !excludedOwnerIdentifiers.has(normalizeIdentifier(user.id)) && !excludedOwnerIdentifiers.has(normalizeIdentifier(user.email)))
    .map((user) => ({
      avatarUrl: user.avatarUrl,
      email: user.email,
      id: normalizeIdentifier(user.id),
      name: user.name || user.email
    })), [excludedOwnerIdentifiers, users]);
  const hasChanges = !sameIds(draftUserIds, savedUserIds);

  useEffect(() => {
    setIsEditing(false);
    setDraftUserIds(savedUserIds);
    setError("");
  }, [entityId]);

  useEffect(() => {
    if (!isEditing) {
      setDraftUserIds(savedUserIds);
    }
  }, [collaboratorKey, isEditing]);

  function beginEditing() {
    setDraftUserIds(savedUserIds);
    setError("");
    setIsEditing(true);
  }

  function cancelEditing() {
    setDraftUserIds(savedUserIds);
    setError("");
    setIsEditing(false);
  }

  async function saveCollaborators() {
    setIsSaving(true);
    setError("");
    try {
      const saved = await onSave(draftUserIds);
      if (saved) {
        setIsEditing(false);
      } else {
        setError(t("apps.collaborators.saveFailed"));
      }
    } catch {
      setError(t("apps.collaborators.saveFailed"));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AppsCapabilityCard
      action={isEditing ? undefined : (
        <Button onClick={beginEditing} size="compact" variant="secondary">
          {t("apps.collaborators.manage")}
        </Button>
      )}
      className="appsCollaboratorCard"
      description={entityType === "app" ? t("apps.collaborators.appBody") : t("apps.collaborators.skillBody")}
      icon={<UsersRound size={17} />}
      statusLabel={savedUserIds.length > 0
        ? t(savedUserIds.length === 1 ? "apps.collaborators.countOne" : "apps.collaborators.count", { count: savedUserIds.length })
        : t("apps.collaborators.none")}
      statusTone={savedUserIds.length > 0 ? "enabled" : "neutral"}
      title={t("apps.collaborators.title")}
    >
      <div className="appsCollaboratorSummary">
        <div>
          <strong>{t("apps.collaborators.selectedTitle")}</strong>
          <small>{t("apps.collaborators.visibilityNote")}</small>
        </div>
        <PeopleMentionPicker
          ariaLabel={t("apps.collaborators.pickerTitle")}
          candidates={collaboratorCandidates}
          disabled={isSaving || (isEditing && directoryState !== "ready")}
          emptySelectionText={t("apps.collaborators.empty")}
          emptyText={t("apps.collaborators.noResults")}
          onChange={setDraftUserIds}
          placeholder={t("apps.collaborators.searchPlaceholder")}
          readOnly={!isEditing || directoryState === "error"}
          removePersonLabel={(person) => t("apps.collaborators.remove", { label: person.name })}
          selectedIds={isEditing ? draftUserIds : savedUserIds}
          suggestionsLabel={t("apps.collaborators.pickerTitle")}
        />
      </div>

      {isEditing && (
        <div className="appsCollaboratorEditor">
          {directoryState === "loading" && (
            <div className="appsAccessDirectoryState" role="status">{t("apps.config.directoryLoading")}</div>
          )}
          {directoryState === "error" && (
            <div className="appsAccessPickerUnavailable">
              <strong>{t("apps.collaborators.directoryUnavailableTitle")}</strong>
              <p>{t("apps.collaborators.directoryError")}</p>
            </div>
          )}
          {error && <div className="formMessage error">{error}</div>}
          <div className="formActions appsCollaboratorActions">
            <Button disabled={isSaving} onClick={cancelEditing} size="compact" variant="secondary">
              {t("apps.editor.cancel")}
            </Button>
            <Button
              disabled={directoryState !== "ready" || isSaving || !hasChanges}
              isLoading={isSaving}
              onClick={() => void saveCollaborators()}
              size="compact"
              variant="primary"
            >
              {isSaving ? t("apps.editor.saving") : t("apps.collaborators.save")}
            </Button>
          </div>
        </div>
      )}
    </AppsCapabilityCard>
  );
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function normalizedIds(values: string[]) {
  return [...new Set(values.map(normalizeIdentifier).filter(Boolean))];
}

function canonicalCollaboratorIds(values: string[], users: PeopleMentionCandidate[]) {
  const canonicalByAlias = new Map<string, string>();

  users.forEach((user) => {
    const userId = normalizeIdentifier(user.id);
    const email = normalizeIdentifier(user.email ?? "");

    if (userId) canonicalByAlias.set(userId, userId);
    if (email) canonicalByAlias.set(email, userId || email);
  });

  return normalizedIds(values.map((value) => canonicalByAlias.get(normalizeIdentifier(value)) ?? value));
}

function normalizeIdentifier(value: string) {
  return value.trim().toLowerCase();
}
