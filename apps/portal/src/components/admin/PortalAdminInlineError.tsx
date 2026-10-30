import { RefreshCw } from "lucide-react";
import { FeedbackNotice } from "../../../../../src/portal/components/FeedbackNotice";
import { Button } from "../../../../../src/portal/components/Button";
import { useI18n } from "../../../../../src/portal/i18n";

export function PortalAdminInlineError({
  isRetrying = false,
  message,
  onRetry
}: {
  isRetrying?: boolean;
  message: string;
  onRetry: () => void;
}) {
  const { t } = useI18n();

  return <FeedbackNotice tone="error" actions={<Button iconBefore={<RefreshCw aria-hidden="true" size={14} />} isLoading={isRetrying} onClick={onRetry} size="compact">{t("portal.data.retry")}</Button>}>{message}</FeedbackNotice>;
}
