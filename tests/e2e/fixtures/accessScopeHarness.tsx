import { createRoot } from "react-dom/client";
import { useState } from "react";
import { I18nProvider } from "../../../src/portal/i18n";
import { fallbackPortal } from "../../../src/shared/fallbackPortal";
import { AppsAccessScopeEditor } from "../../../src/portal/studio/components/AppsAccessScopeEditor";
import type { AppsAccessInput } from "../../../src/portal/studio/types";

function Harness() {
  const [access, setAccess] = useState<AppsAccessInput>({ accessMode: "private", accessTargets: [], loginRequired: true, visibility: "private" });
  const [saved, setSaved] = useState("");
  const entityType = location.search.includes("skill") ? "skill" : "app";
  return <>
    <AppsAccessScopeEditor access={access} catalog={fallbackPortal} entityType={entityType} error="" saving={false}
      onModeChange={accessMode => setAccess(current => ({ ...current, accessMode }))}
      onTargetsChange={accessTargets => setAccess(current => ({ ...current, accessTargets }))}
      onSave={async () => { setSaved(JSON.stringify(access)); return true; }} />
    <output data-testid="saved">{saved}</output>
  </>;
}
createRoot(document.getElementById("root")!).render(<I18nProvider><Harness /></I18nProvider>);
