import { createReactInlineContentSpec } from "@blocknote/react";
import { useState, type CSSProperties } from "react";
import {
  PeopleMentionChip,
  type PeopleMentionCandidate
} from "../../components/PeopleMentionPicker";
import { hashText, personInitials, personPalette } from "../../components/shared/visualIdentity";
import { mentionPropsForCandidate, type ForumMentionCandidate } from "./ForumMentionUtils";
export type { ForumMentionCandidate } from "./ForumMentionUtils";

type ForumMentionProps = {
  avatarUrl: string;
  email: string;
  emailPrefix: string;
  id: string;
  name: string;
};

export const forumMentionInlineContentSpec = createReactInlineContentSpec(
  {
    type: "mention",
    propSchema: {
      avatarUrl: { default: "" },
      email: { default: "" },
      emailPrefix: { default: "" },
      id: { default: "" },
      name: { default: "" }
    },
    content: "none"
  },
  {
    render: (props) => (
      <PeopleMentionChip
        className="forumMentionNode forumEditorMentionChip"
        person={personFromMentionProps(props.inlineContent.props as ForumMentionProps)}
      />
    ),
    toExternalHTML: (props) => (
      <span
        data-forum-mention={props.inlineContent.props.emailPrefix}
        data-inline-content-type="mention"
      >
        @{props.inlineContent.props.emailPrefix}
      </span>
    ),
    parse: (element) => {
      const emailPrefix = (element.getAttribute("data-forum-mention") ?? "").trim();
      if (!emailPrefix) return undefined;

      return { emailPrefix, id: emailPrefix, name: emailPrefix };
    }
  }
);

export function ForumMentionAvatar({ person }: { person: PeopleMentionCandidate }) {
  const [imageFailed, setImageFailed] = useState(false);
  const identity = person.name || person.email || person.id;
  const palette = personPalette(hashText(identity));
  const style = {
    "--avatar-a": palette.a,
    "--avatar-b": palette.b,
    "--avatar-ink": palette.ink
  } as CSSProperties;

  return (
    <span aria-hidden="true" className="peopleMentionAvatar" style={style}>
      {person.avatarUrl && !imageFailed
        ? <img alt="" onError={() => setImageFailed(true)} src={person.avatarUrl} />
        : personInitials(identity)}
    </span>
  );
}

function personFromMentionProps(props: ForumMentionProps): ForumMentionCandidate {
  return {
    avatarUrl: props.avatarUrl || undefined,
    email: props.email || props.emailPrefix,
    emailPrefix: props.emailPrefix,
    id: props.id || props.emailPrefix,
    name: props.name || props.emailPrefix
  };
}
