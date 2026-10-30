import { Button, ScrollView, Text, View } from "@tarojs/components";
import { useI18n } from "../services/i18n";
import type { RuntimeApproval } from "../types";
import { useState } from "react";
import { approvalCardStatus, approvalPresentation } from "../../../../src/shared/mateApprovalPresentation";
import { MarkdownMessage } from "./MarkdownMessage";

export function RuntimeApprovalCards({ approvals, busyId, error, notice, onDecision }: {
  approvals: RuntimeApproval[];
  busyId: string;
  error: string;
  notice: string;
  onDecision: (id: string, decision: "approve" | "deny") => void;
}) {
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, boolean>>({});
  if (!approvals.length && !error && !notice) return null;
  return <View className="runtime-approvals">
    {approvals.map((approval) => {
      const status = approvalCardStatus(approval);
      const presentation = approvalPresentation(approval, (zh, en) => language === "en" ? en : zh);
      const labels = { pending: "approval.pending", executing: "approval.executing", completed: "approval.success", failed: "approval.failed", denied: "approval.denied", cancelled: "approval.cancelled", expired: "approval.expired" } as const;
      return <View className="runtime-approval-card" key={approval.id}>
        <Text className="runtime-approval-title">{presentation.title}</Text>
        <Text className={`runtime-approval-state ${status}`}>{t(labels[status])}</Text>
        {presentation.path && <Text className="runtime-approval-operation">{presentation.path}</Text>}
        {approval.task?.conclusion?.summary && <Text className="runtime-approval-operation">{approval.task.conclusion.summary}</Text>}
        {status === "pending" && <Text className="runtime-approval-expiry">{t("approval.expires")}: {approval.expiresAt}</Text>}
        {(presentation.preview || presentation.diff.length > 0) && <>
          <Text className="runtime-approval-toggle" onClick={() => setExpanded((current) => ({ ...current, [approval.id]: !current[approval.id] }))}>{presentation.previewLabel} · +{presentation.additions} / −{presentation.removals} {expanded[approval.id] ? "⌃" : "⌄"}</Text>
          {expanded[approval.id] && <View className="runtime-approval-preview">
            {presentation.note && <Text className="runtime-approval-operation">{presentation.note}</Text>}
            {presentation.preview && <MarkdownMessage content={presentation.preview} />}
            {!!presentation.diff.length && <><Text className="runtime-approval-toggle">{t("approval.diff")}</Text><ScrollView scrollX className="runtime-approval-diff">{presentation.diff.map((line, index) => <View key={index} className={`runtime-approval-diff-line ${line.kind}`}><Text selectable>{line.text}</Text></View>)}</ScrollView></>}
          </View>}
        </>}
        <Text className="runtime-approval-toggle" onClick={() => setDetails((current) => ({ ...current, [approval.id]: !current[approval.id] }))}>{t("approval.showDetails")} {details[approval.id] ? "⌃" : "⌄"}</Text>
        {details[approval.id] && <ScrollView className="runtime-approval-detail-scroll" scrollY>
          <Text className="runtime-approval-details" selectable>{JSON.stringify(approval.operation, null, 2)}</Text>
        </ScrollView>}
        {status === "pending" && <View className="runtime-approval-actions">
            <Button disabled={Boolean(busyId)} onClick={() => onDecision(approval.id, "deny")}>{t("parts.reject")}</Button>
            <Button className="approve" disabled={Boolean(busyId)} onClick={() => onDecision(approval.id, "approve")}>{t("approval.confirm")}</Button>
          </View>}
      </View>;
    })}
    {error && <Text className="runtime-approval-error">{error}</Text>}
    {notice && <Text className="runtime-approval-notice">{notice}</Text>}
  </View>;
}
