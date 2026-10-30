import { Award, Check, Loader2 } from "lucide-react";
import "./ForumContributorAward.css";
import { useState, type FormEvent } from "react";
import {
  portalCommunityContributionNotePresetKeys,
  portalCommunityContributionRules
} from "../../../shared/journey";
import type { DiscussionContributorAward, PortalJourneyLevelKey } from "../../../shared/types";
import { Button } from "../../components/Button";
import { FormField, TextArea, TextInput } from "../../components/FormField";
import { ModalShell } from "../../components/ModalShell";
import { useI18n, type TranslationKey } from "../../i18n";
import { publishUserJourneyProjectionUpdate } from "../../lib/userJourneyProjectionEvents";
import type { SubmitState } from "../types";

const contributionNotePresetTranslationKeys: Record<
  (typeof portalCommunityContributionNotePresetKeys)[number],
  TranslationKey
> = {
  importantImprovement: "forum.contributorAwardPreset.importantImprovement",
  majorFix: "forum.contributorAwardPreset.majorFix",
  reusableGuide: "forum.contributorAwardPreset.reusableGuide",
  valuableFeedback: "forum.contributorAwardPreset.valuableFeedback"
};

export type ContributorAwardResult = {
  award: DiscussionContributorAward;
  journeyBadgeCount?: number;
  journeyCommunityContributionPoints: number;
  journeyLevelKey: PortalJourneyLevelKey;
  journeyTotalPoints: number;
  postId: string;
  recipientUserId: string;
  topicId: string;
};

export function ContributorAwardBadge({
  award,
  compact = false
}: {
  award: DiscussionContributorAward;
  compact?: boolean;
}) {
  const { t } = useI18n();

  if (compact) {
    return (
      <span
        aria-label={`${t("forum.contributorAwardBadge")} +${award.points}: ${award.note}`}
        className="forumContributorAwardBadge"
        data-tooltip={award.note}
        tabIndex={0}
      >
        <Award aria-hidden="true" size={11} />
        {t("forum.contributorAwardBadge")}
        <b>+{award.points}</b>
      </span>
    );
  }

  return (
    <aside className="forumContributorAwardCallout">
      <span className="forumContributorAwardIcon"><Award aria-hidden="true" size={19} /></span>
      <span className="forumContributorAwardCopy">
        <span>
          <strong>{t("forum.contributorAwardBadge")}</strong>
          <b>+{award.points} {t("journey.points")}</b>
        </span>
        <p>{award.note}</p>
        <small>{t("forum.contributorAwardedBy", { name: award.awardedByName })}</small>
      </span>
    </aside>
  );
}

export function ContributorAwardModal({
  endpoint,
  onAwarded,
  onClose,
  recipientName
}: {
  endpoint: string;
  onAwarded: (result: ContributorAwardResult) => void;
  onClose: () => void;
  recipientName: string;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [points, setPoints] = useState<number>(portalCommunityContributionRules.contributionTagPoints[0]);
  const [customPoints, setCustomPoints] = useState("");
  const [useCustomPoints, setUseCustomPoints] = useState(false);
  const [status, setStatus] = useState<SubmitState>("idle");
  const selectedPoints = useCustomPoints ? Number(customPoints) : points;
  const validPoints = Number.isInteger(selectedPoints)
    && selectedPoints >= portalCommunityContributionRules.contributionTagCustomMin
    && selectedPoints <= portalCommunityContributionRules.contributionTagCustomMax;
  const canSubmit = note.trim().length > 0 && validPoints && status !== "submitting";

  async function submitAward(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setStatus("submitting");
    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify({ note, points: selectedPoints }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) throw new Error("forum_contributor_award_failed");
      const payload = await response.json() as Partial<ContributorAwardResult>;
      if (
        !payload.award?.id
        || !payload.recipientUserId
        || typeof payload.journeyCommunityContributionPoints !== "number"
        || typeof payload.journeyTotalPoints !== "number"
        || !payload.journeyLevelKey
      ) throw new Error("forum_contributor_award_invalid_response");
      const result = payload as ContributorAwardResult;
      setStatus("success");
      publishUserJourneyProjectionUpdate({
        id: result.recipientUserId,
        journeyBadgeCount: result.journeyBadgeCount,
        journeyCommunityContributionPoints: result.journeyCommunityContributionPoints,
        journeyLevelKey: result.journeyLevelKey,
        journeyTotalPoints: result.journeyTotalPoints
      });
      onAwarded(result);
      onClose();
    } catch {
      setStatus("error");
    }
  }

  return (
    <ModalShell
      ariaLabel={t("forum.contributorAwardTitle")}
      header={(
        <div>
          <p className="portal-kicker">{t("forum.adminActions")}</p>
          <h2>{t("forum.contributorAwardTitle")}</h2>
        </div>
      )}
      modalClassName="portal-contributor-award-dialog"
      onClose={() => status !== "submitting" && onClose()}
      overlayClassName="portal-dialog-layer"
    >
      <form className="forumContributorAwardForm" onSubmit={submitAward}>
        <div className="forumContributorAwardPreview">
          <span><Award aria-hidden="true" size={20} /></span>
          <div>
            <strong>{t("forum.contributorAwardBadge")}</strong>
            <small>{t("forum.contributorAwardRecipient", { name: recipientName, points: selectedPoints || 0 })}</small>
          </div>
          <b>+{selectedPoints || 0}</b>
        </div>
        <FormField label={t("forum.contributorAwardPoints")} required>
          <div aria-label={t("forum.contributorAwardPoints")} className="forumContributorAwardTiers" role="radiogroup">
            {portalCommunityContributionRules.contributionTagPoints.map((option) => (
              <button
                aria-checked={!useCustomPoints && points === option}
                className={!useCustomPoints && points === option ? "active" : ""}
                key={option}
                onClick={() => {
                  setUseCustomPoints(false);
                  setPoints(option);
                }}
                role="radio"
                type="button"
              >
                +{option}
              </button>
            ))}
            <button
              aria-checked={useCustomPoints}
              className={useCustomPoints ? "active" : ""}
              onClick={() => setUseCustomPoints(true)}
              role="radio"
              type="button"
            >
              {t("forum.contributorAwardCustom")}
            </button>
          </div>
          {useCustomPoints && (
            <div className="forumContributorAwardCustomPoints">
              <TextInput
                aria-label={t("forum.contributorAwardCustom")}
                inputMode="numeric"
                max={portalCommunityContributionRules.contributionTagCustomMax}
                min={portalCommunityContributionRules.contributionTagCustomMin}
                onChange={(event) => setCustomPoints(event.target.value)}
                placeholder={t("forum.contributorAwardCustomPlaceholder")}
                type="number"
                value={customPoints}
              />
              <span>{t("journey.points")}</span>
            </div>
          )}
        </FormField>
        <FormField
          description={t("forum.contributorAwardNoteHint")}
          label={t("forum.contributorAwardNote")}
          required
        >
          <div aria-label={t("forum.contributorAwardPresets")} className="forumContributorAwardPresets">
            {portalCommunityContributionNotePresetKeys.map((presetKey) => (
              <button key={presetKey} onClick={() => setNote(t(contributionNotePresetTranslationKeys[presetKey]))} type="button">
                {t(contributionNotePresetTranslationKeys[presetKey])}
              </button>
            ))}
          </div>
          <TextArea
            autoFocus
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("forum.contributorAwardNotePlaceholder")}
            rows={4}
            value={note}
          />
        </FormField>
        <ContributorAwardStatusText
          errorText={t("forum.contributorAwardFailed")}
          status={status}
          successText={t("forum.contributorAwardSuccess")}
        />
        <div className="portal-confirm-actions">
          <Button disabled={status === "submitting"} onClick={onClose} variant="secondary">
            {t("forum.cancel")}
          </Button>
          <Button disabled={!canSubmit} isLoading={status === "submitting"} type="submit" variant="primary">
            {t("forum.contributorAwardConfirm", { points: selectedPoints || 0 })}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

function ContributorAwardStatusText({
  errorText,
  status,
  successText
}: {
  errorText: string;
  status: SubmitState;
  successText: string;
}) {
  const { t } = useI18n();

  if (status === "idle") {
    return <span className="statusText" />;
  }

  return (
    <span className={`statusText ${status}`}>
      {status === "submitting" && <Loader2 className="spinIcon" size={14} />}
      {status === "success" && <Check size={14} />}
      {status === "error" ? errorText : status === "success" ? successText : t("forum.working")}
    </span>
  );
}
