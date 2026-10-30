import { Check } from "lucide-react";
import workBuddyIcon from "../../assets/agent-brands/workbuddy-color.svg";
import claudeIcon from "../../assets/model-brands/claude-color.svg";
import cursorIcon from "../../assets/model-brands/cursor.svg";
import openAiIcon from "../../assets/model-brands/openai.svg";

export type McpAgentTargetId = "workbuddy" | "claude-code" | "codex" | "cursor";

export type McpAgentTarget = {
  iconSrc: string;
  id: McpAgentTargetId;
  label: string;
};

export const mcpAgentTargets: McpAgentTarget[] = [
  { iconSrc: workBuddyIcon, id: "workbuddy", label: "WorkBuddy" },
  { iconSrc: claudeIcon, id: "claude-code", label: "Claude Code" },
  { iconSrc: openAiIcon, id: "codex", label: "Codex" },
  { iconSrc: cursorIcon, id: "cursor", label: "Cursor" }
];

export function McpAgentTargetPicker({
  ariaLabel,
  onChange,
  value
}: {
  ariaLabel: string;
  onChange: (value: McpAgentTargetId) => void;
  value: McpAgentTargetId;
}) {
  return (
    <div className="agentTargetGrid" role="radiogroup" aria-label={ariaLabel}>
      {mcpAgentTargets.map((target) => {
        const selected = value === target.id;
        return (
          <button
            aria-checked={selected}
            className={selected ? "selected" : ""}
            key={target.id}
            onClick={() => onChange(target.id)}
            role="radio"
            type="button"
          >
            <img alt="" aria-hidden="true" src={target.iconSrc} />
            <span>{target.label}</span>
            {selected && <Check aria-hidden="true" size={14} />}
          </button>
        );
      })}
    </div>
  );
}
