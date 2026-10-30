import { X } from "lucide-react";
import type { FormEvent, SetStateAction } from "react";
import type { PortalCatalog } from "../../../shared/types";
import { Button } from "../../components/Button";
import { ModalShell } from "../../components/ModalShell";
import { useI18n } from "../../i18n";
import { AppsCreateAppForm } from "../components/AppsCreateAppForm";
import type { CreateInput } from "../types";

export function CreateAppsAppModal({
  catalog,
  createInput,
  onClose,
  onSubmit,
  setCreateInput,
  submitting
}: {
  catalog: PortalCatalog;
  createInput: CreateInput;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  setCreateInput: (value: SetStateAction<CreateInput>) => void;
  submitting: boolean;
}) {
  const { t } = useI18n();
  const showsAccessPicker = createInput.type !== "static_page" && createInput.accessMode === "targeted";

  return (
    <ModalShell
      ariaLabel={t("apps.create.aria")}
      className={showsAccessPicker ? "appsCreateModal withAccessPicker" : "appsCreateModal"}
      header={(
        <div>
          <p className="eyebrow">{t("apps.create.eyebrow")}</p>
          <h2>{t("apps.create.title")}</h2>
        </div>
      )}
      headerActions={(
        <Button aria-label={t("apps.detail.close")} disabled={submitting} onClick={onClose} variant="icon">
          <X size={18} />
        </Button>
      )}
      onClose={onClose}
    >
      <AppsCreateAppForm
        catalog={catalog}
        createInput={createInput}
        onClose={onClose}
        onSubmit={onSubmit}
        setCreateInput={setCreateInput}
        submitting={submitting}
      />
    </ModalShell>
  );
}
