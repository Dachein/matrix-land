import { ModalShell } from "../../components/ModalShell";
import { useI18n } from "../../i18n";
import type { Discussion } from "../../../shared/types";
import "../../../../apps/portal/src/styles/post.css";
import type { ForumListedItemAttachment } from "../types";
import { ForumTopicComposer } from "./ForumTopicComposer";

export function ForumComposerModal({
  linkedItem,
  onCancel,
  onCreated,
  onDismiss
}: {
  linkedItem?: ForumListedItemAttachment;
  onCancel: () => void;
  onCreated: (discussion: Discussion) => Promise<void>;
  onDismiss: () => void;
}) {
  const { t } = useI18n();

  return (
    <ModalShell
      ariaLabel={t("forum.newTopic")}
      header={(
        <div>
          <p className="eyebrow">{t("forum.communityEyebrow")}</p>
          <h2>{t("forum.newTopic")}</h2>
        </div>
      )}
      headerClassName="composerDialogHeader"
      modalClassName="forumComposerDialog"
      onClose={onDismiss}
      overlayClassName="forumComposerOverlay"
    >
      <ForumTopicComposer
        linkedItem={linkedItem}
        onCancel={onCancel}
        onCreated={onCreated}
      />
    </ModalShell>
  );
}
