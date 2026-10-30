import type { Discussion, DiscussionAttachment, DiscussionMention } from "../../shared/types";
import { createMarkdownRenderer } from "../../shared/markdownRenderer.ts";
import { hashText, personInitials, personPalette } from "../components/shared/visualIdentity.ts";
import type { MarkdownMentionEnv } from "./types";

const forumMarkdown = createMarkdownRenderer({
  classNames: {
    containsTaskList: "containsTaskList",
    table: "forumMarkdownTable",
    taskListItem: "taskListItem",
    taskListItemCheckbox: "taskListItemCheckbox"
  }
});

// Give standalone media and its italic caption their own block rhythm. Leave
// inline images and mention avatars in the normal text flow.
forumMarkdown.core.ruler.after("inline", "forum-media-blocks", (state: any) => {
  const tokens = state.tokens;
  let previousImageClose = -1;
  for (let index = 0; index < tokens.length - 2; index++) {
    if (tokens[index].type !== "paragraph_open" || tokens[index + 1].type !== "inline") continue;
    const children = tokens[index + 1].children ?? [];
    const isImage = children.length === 1 && children[0].type === "image";
    const isLinkedImage = children.length === 3 && children[0].type === "link_open"
      && children[1].type === "image" && children[2].type === "link_close";
    if (isImage || isLinkedImage) {
      tokens[index].attrJoin("class", "forumMarkdownImage");
      previousImageClose = index + 2;
    } else if (index === previousImageClose + 1 && children.length >= 3
      && children[0].type === "em_open" && children.at(-1).type === "em_close"
      && children.slice(1, -1).every((child: any) => child.type === "text" || child.type === "code_inline")) {
      tokens[index].attrJoin("class", "forumMarkdownCaption");
    }
  }
  return true;
});

forumMarkdown.renderer.rules.text = (tokens: any[], idx: number, _options: any, env: MarkdownMentionEnv) => renderTextWithMentionMarkup(tokens[idx].content, env.mentionMap);

const defaultFenceRule = forumMarkdown.renderer.rules.fence ?? ((tokens: any[], idx: number, options: any, _env: any, self: any) => self.renderToken(tokens, idx, options));
forumMarkdown.renderer.rules.fence = (tokens: any[], idx: number, options: any, env: MarkdownMentionEnv, self: any) => {
  const code = defaultFenceRule(tokens, idx, options, env, self);
  if (!env.copyCodeLabel) return code;

  const label = escapeAttribute(env.copyCodeLabel);
  const copiedLabel = escapeAttribute(env.copiedCodeLabel || env.copyCodeLabel);
  const failedLabel = escapeAttribute(env.copyCodeFailedLabel || env.copyCodeLabel);
  return `<div class="forumCodeBlock"><button aria-label="${label}" aria-live="polite" class="forumCodeCopyButton" data-copied-label="${copiedLabel}" data-copy-failed-label="${failedLabel}" data-copy-label="${label}" title="${label}" type="button">${COPY_CODE_ICON_SVG}${COPIED_CODE_ICON_SVG}</button>${code}</div>`;
};

const MENTION_TEXT_PATTERN = /(^|[\s([{"'，。！？、:：;；])@([a-zA-Z0-9._-]{1,64})/g;

const COPY_CODE_ICON_SVG = '<svg aria-hidden="true" class="forumCodeCopyIcon" fill="none" height="14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24" width="14"><rect height="14" rx="2" ry="2" width="14" x="8" y="8"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
const COPIED_CODE_ICON_SVG = '<svg aria-hidden="true" class="forumCodeCopiedIcon" fill="none" height="14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24" width="14"><path d="M20 6 9 17l-5-5"></path></svg>';

export function mentionMapForDiscussion(discussion: Discussion, postId?: string) {
  const mentions = discussion.mentions ?? [];
  const scopedMentions = postId ? mentions.filter((mention) => !mention.postId || mention.postId === postId) : topicMentionsForDiscussion(discussion);
  const mentionMap = new Map<string, DiscussionMention>();

  scopedMentions.forEach((mention) => {
    const keys = [mention.emailPrefix, mention.text.replace(/^@/, "")]
      .map(mentionKey)
      .filter(Boolean);

    keys.forEach((key) => {
      if (!mentionMap.has(key)) {
        mentionMap.set(key, mention);
      }
    });
  });

  return mentionMap;
}

export function topicMentionsForDiscussion(discussion: Discussion) {
  const mentions = discussion.mentions ?? [];
  const rootPostId = discussion.rootPostId;

  return mentions.filter((mention) => !mention.postId || (rootPostId ? mention.postId === rootPostId : false));
}

function mentionKey(value: string) {
  return value.trim().replace(/^@/, "").toLowerCase();
}

export function renderForumMarkdown(
  value: string,
  mentionMap?: Map<string, DiscussionMention>,
  options?: Pick<MarkdownMentionEnv, "copiedCodeLabel" | "copyCodeFailedLabel" | "copyCodeLabel">
) {
  return forumMarkdown.render(value || "", { ...options, mentionMap } satisfies MarkdownMentionEnv);
}

export function forumMarkdownPreviewText(value: string) {
  const tokens = forumMarkdown.parse(value || "", {});
  const parts: string[] = [];

  tokens.forEach((token) => {
    if (token.type === "inline") {
      token.children?.forEach((child) => {
        if (child.type === "text" || child.type === "code_inline") {
          parts.push(child.content);
        } else if (child.type === "softbreak" || child.type === "hardbreak") {
          parts.push(" ");
        }
      });
      return;
    }

    if (token.type === "fence" || token.type === "code_block") {
      parts.push(token.content);
    }
  });

  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function forumInlineImageUrls(value: string) {
  const urls = new Set<string>();
  const tokens = forumMarkdown.parse(value || "", {});

  tokens.forEach((token) => collectMediaUrls(token, urls, false));
  return urls;
}

export function forumInlineMediaUrls(value: string) {
  const urls = new Set<string>();
  const tokens = forumMarkdown.parse(value || "", {});

  tokens.forEach((token) => collectMediaUrls(token, urls, true));
  return urls;
}

export function forumStandaloneAttachments(value: string, attachments: DiscussionAttachment[]) {
  const inlineMediaUrls = forumInlineMediaUrls(value);
  return attachments.filter((attachment) => !inlineMediaUrls.has(attachment.url));
}

function collectMediaUrls(token: any, urls: Set<string>, includeLinks: boolean) {
  if (token.type === "image") {
    const source = token.attrGet?.("src");
    if (source) urls.add(source);
  }

  if (includeLinks && token.type === "link_open") {
    const target = token.attrGet?.("href");
    if (target) urls.add(target);
  }

  token.children?.forEach((child: any) => collectMediaUrls(child, urls, includeLinks));
}

function renderTextWithMentionMarkup(value: string, mentionMap?: Map<string, DiscussionMention>) {
  const parts: string[] = [];
  let lastIndex = 0;

  for (const match of value.matchAll(MENTION_TEXT_PATTERN)) {
    const startIndex = match.index ?? 0;
    const boundary = match[1];
    const rawPrefix = match[2];
    const resolvedPrefix = rawPrefix.replace(/[._-]+$/g, "");
    const rawText = `@${resolvedPrefix}`;
    const trailingPunctuation = rawPrefix.slice(resolvedPrefix.length);
    const prefix = mentionKey(resolvedPrefix);

    if (startIndex > lastIndex) {
      parts.push(escapeHtml(value.slice(lastIndex, startIndex)));
    }

    if (boundary) {
      parts.push(escapeHtml(boundary));
    }

    const mention = mentionMap?.get(prefix);
    if (mention) {
      parts.push(renderMentionChip(mention, prefix));
    } else {
      parts.push(escapeHtml(rawText));
    }
    parts.push(escapeHtml(trailingPunctuation));

    lastIndex = startIndex + match[0].length;
  }

  if (lastIndex < value.length) {
    parts.push(escapeHtml(value.slice(lastIndex)));
  }

  return parts.join("");
}

function renderMentionChip(mention: DiscussionMention, prefix: string) {
  const identity = mention.name || mention.email || mention.emailPrefix;
  const palette = personPalette(hashText(identity));
  const avatar = mention.avatarUrl
    ? `<img alt="" loading="lazy" src="${escapeAttribute(mention.avatarUrl)}">`
    : escapeHtml(personInitials(identity));
  const avatarStyle = `--avatar-a:${palette.a};--avatar-b:${palette.b};--avatar-ink:${palette.ink}`;

  return `<button aria-label="${escapeAttribute(identity)}" class="peopleMentionTag readOnly inlineMentionTag" data-mention-prefix="${escapeAttribute(prefix)}" title="${escapeAttribute(identity)}" type="button"><span class="peopleMentionIdentity"><span aria-hidden="true" class="peopleMentionAvatar" style="${escapeAttribute(avatarStyle)}">${avatar}</span><span class="peopleMentionName">${escapeHtml(identity)}</span></span></button>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
