import { AppsOwnershipSettings } from './AppsOwnership';
import { useEffect, useState } from "react";
import type { AppsSkill, PortalCatalog } from "../../../shared/types";
import { useI18n } from "../../i18n";
import { appsAccessTemplates } from "../constants";
import type { AppsAccessMode, AppsSkillAccessInput } from "../types";
import { privateAccessTargets } from "../utils";
import { AppsAccessScopeEditor } from "./AppsAccessScopeEditor";
import { AppsCollaboratorSettings } from "./AppsCollaboratorSettings";

export function AppsSkillConfigTab({
  catalog,
  onAccessUpdate,
  onCollaboratorsUpdate,
  onTargetedModeChange,
  skill
}: {
  catalog: PortalCatalog;
  onAccessUpdate: (input: AppsSkillAccessInput) => Promise<AppsSkill | undefined>;
  onCollaboratorsUpdate: (collaboratorUserIds: string[]) => Promise<AppsSkill | undefined>;
  onTargetedModeChange?: (active: boolean) => void;
  skill: AppsSkill;
}) {
  const { t } = useI18n();
  const [accessDraft, setAccessDraft] = useState<AppsSkillAccessInput>(() => accessInputFromSkill(skill, catalog));
  const [accessSaving, setAccessSaving] = useState(false);
  const [accessError, setAccessError] = useState("");

  useEffect(() => {
    setAccessDraft(accessInputFromSkill(skill, catalog));
  }, [catalog, skill.accessTargets, skill.id, skill.loginRequired, skill.visibility]);

  function updateAccessMode(accessMode: AppsAccessMode) {
    setAccessError("");
    setAccessDraft((current) => {
      const template = accessTemplateForMode(accessMode);
      return {
        accessMode,
        accessTargets: accessMode === "private"
          ? privateAccessTargets(catalog)
          : accessMode === "targeted" && current.accessMode !== "private"
            ? current.accessTargets
            : [],
        loginRequired: true,
        visibility: template.visibility
      };
    });
  }

  function updateAccessTargets(accessTargets: string[]) {
    setAccessError("");
    setAccessDraft((current) => ({ ...current, accessTargets }));
  }

  async function saveAccess() {
    const accessTargets = accessDraft.accessMode === "private"
      ? privateAccessTargets(catalog)
      : accessDraft.accessMode === "targeted"
        ? accessDraft.accessTargets
        : [];

    if (accessDraft.accessMode === "targeted" && accessTargets.length === 0) {
      setAccessError(t("apps.message.accessTargetsRequired"));
      return false;
    }

    setAccessSaving(true);
    setAccessError("");
    try {
      const updated = await onAccessUpdate({ ...accessDraft, accessTargets, loginRequired: true });
      if (updated) {
        setAccessDraft(accessInputFromSkill(updated, catalog));
      }
      return Boolean(updated);
    } catch {
      setAccessError(t("apps.message.accessUpdateFailed"));
      return false;
    } finally {
      setAccessSaving(false);
    }
  }

  return (
    <AppsAccessScopeEditor
      access={accessDraft}
      catalog={catalog}
      entityType="skill"
      error={accessError}
      onModeChange={updateAccessMode}
      onSave={saveAccess}
      onTargetedModeChange={onTargetedModeChange}
      onTargetsChange={updateAccessTargets}
      saving={accessSaving}
    >
      <AppsOwnershipSettings catalog={catalog} asset={{ id: skill.id, type: "skill", name: skill.name, ownerUserId: skill.ownerUserId }} />
      <AppsCollaboratorSettings
        catalog={catalog}
        collaboratorUserIds={skill.collaboratorUserIds ?? []}
        entityId={skill.id}
        entityType="skill"
        onSave={async (collaboratorUserIds) => Boolean(await onCollaboratorsUpdate(collaboratorUserIds))}
        ownerUserId={skill.ownerUserId}
      />
    </AppsAccessScopeEditor>
  );
}

function accessInputFromSkill(skill: AppsSkill, catalog: PortalCatalog): AppsSkillAccessInput {
  const accessMode = accessModeFromSkill(skill);
  const template = accessTemplateForMode(accessMode);
  return {
    accessMode,
    accessTargets: accessMode === "private" && skill.accessTargets.length === 0 ? privateAccessTargets(catalog) : skill.accessTargets,
    loginRequired: true,
    visibility: template.visibility
  };
}

function accessModeFromSkill(skill: AppsSkill): AppsAccessMode {
  if (skill.visibility === "team") {
    return "targeted";
  }
  if (skill.visibility === "private") {
    return "private";
  }
  return "company";
}

function accessTemplateForMode(accessMode: AppsAccessMode) {
  return appsAccessTemplates.find((item) => item.value === accessMode) ?? appsAccessTemplates[1];
}
