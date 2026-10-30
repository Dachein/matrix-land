import { Check } from "lucide-react";
import { Button } from "../../components/Button";
import { ModalShell } from "../../components/ModalShell";
import { useI18n } from "../../i18n";

export function AppsCopyNoticeModal({ detail, onClose, title }: { detail: string; onClose: () => void; title: string }) {
  const { t } = useI18n();

  return (
    <ModalShell ariaLabel={title} modalClassName="appsCopyNoticeModal" onClose={onClose} overlayClassName="appsCopyNoticeOverlay">
      <span className="appsCopyNoticeIcon">
        <Check size={18} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
      <Button onClick={onClose} size="compact" variant="secondary">
        {t("apps.copy.gotIt")}
      </Button>
    </ModalShell>
  );
}
