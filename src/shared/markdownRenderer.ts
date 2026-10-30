import MarkdownIt from "markdown-it";

export type MarkdownRendererClassNames = {
  containsTaskList: string;
  table: string;
  taskListItem: string;
  taskListItemCheckbox: string;
};

const DEFAULT_CLASS_NAMES: MarkdownRendererClassNames = {
  containsTaskList: "markdownTaskList",
  table: "markdownTable",
  taskListItem: "markdownTaskListItem",
  taskListItemCheckbox: "markdownTaskListItemCheckbox"
};

const TASK_LIST_MARKER_PATTERN = /^\[([ xX])\]\s+/;

/**
 * Builds Workspace's shared, safe Markdown renderer. Feature-specific surfaces can
 * extend the returned instance (for example Forum mentions and code copying)
 * without maintaining a second Markdown dialect.
 */
export function createMarkdownRenderer(options: {
  classNames?: Partial<MarkdownRendererClassNames>;
} = {}) {
  const classNames = { ...DEFAULT_CLASS_NAMES, ...options.classNames };
  const markdown = new MarkdownIt({
    breaks: true,
    html: false,
    linkify: true,
    typographer: true
  });

  markdown.renderer.rules.link_open = (tokens: any[], idx: number, rendererOptions: any, _env: any, self: any) => {
    const token = tokens[idx];
    const targetIndex = token.attrIndex("target");
    const relIndex = token.attrIndex("rel");

    if (targetIndex < 0) {
      token.attrPush(["target", "_blank"]);
    } else {
      token.attrs![targetIndex][1] = "_blank";
    }

    if (relIndex < 0) {
      token.attrPush(["rel", "noreferrer"]);
    } else {
      token.attrs![relIndex][1] = "noreferrer";
    }

    return self.renderToken(tokens, idx, rendererOptions);
  };

  const defaultTableOpen = markdown.renderer.rules.table_open
    ?? ((tokens: any[], idx: number, rendererOptions: any, _env: any, self: any) => self.renderToken(tokens, idx, rendererOptions));
  const defaultTableClose = markdown.renderer.rules.table_close
    ?? ((tokens: any[], idx: number, rendererOptions: any, _env: any, self: any) => self.renderToken(tokens, idx, rendererOptions));

  markdown.renderer.rules.table_open = (tokens: any[], idx: number, rendererOptions: any, env: any, self: any) => (
    `<div class="${escapeAttribute(classNames.table)}">${defaultTableOpen(tokens, idx, rendererOptions, env, self)}`
  );
  markdown.renderer.rules.table_close = (tokens: any[], idx: number, rendererOptions: any, env: any, self: any) => (
    `${defaultTableClose(tokens, idx, rendererOptions, env, self)}</div>`
  );

  // GFM-style task lists so checklists share the same output across surfaces.
  markdown.core.ruler.after("inline", "workspace-task-list", (state: any) => {
    const tokens = state.tokens;

    for (let index = 2; index < tokens.length; index++) {
      if (tokens[index].type !== "inline") continue;
      if (tokens[index - 1].type !== "paragraph_open") continue;
      if (tokens[index - 2].type !== "list_item_open") continue;

      const match = tokens[index].content.match(TASK_LIST_MARKER_PATTERN);
      if (!match) continue;

      const checked = match[1].toLowerCase() === "x";
      tokens[index].content = tokens[index].content.replace(TASK_LIST_MARKER_PATTERN, "");

      const children = tokens[index].children ?? [];
      if (children[0]?.type === "text") {
        children[0].content = children[0].content.replace(TASK_LIST_MARKER_PATTERN, "");
      }

      const checkbox = new state.Token("html_inline", "", 0);
      checkbox.content = `<input aria-disabled="true" class="${escapeAttribute(classNames.taskListItemCheckbox)}" disabled type="checkbox"${checked ? " checked" : ""}> `;
      children.unshift(checkbox);
      tokens[index].children = children;

      tokens[index - 2].attrJoin("class", classNames.taskListItem);
      for (let listIndex = index - 2; listIndex >= 0; listIndex--) {
        if (tokens[listIndex].type === "bullet_list_open") {
          const existingClass = tokens[listIndex].attrGet("class") ?? "";
          const desiredClasses = classNames.containsTaskList.split(/\s+/).filter(Boolean);
          desiredClasses.forEach((className) => {
            if (!existingClass.split(/\s+/).includes(className)) {
              tokens[listIndex].attrJoin("class", className);
            }
          });
          break;
        }
        if (tokens[listIndex].type === "bullet_list_close") break;
      }
    }

    return true;
  });

  return markdown;
}

const sharedMarkdownRenderer = createMarkdownRenderer();

export function renderMarkdown(value: string) {
  return sharedMarkdownRenderer.render(value || "");
}

function escapeAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
