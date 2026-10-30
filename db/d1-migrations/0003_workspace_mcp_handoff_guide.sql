INSERT OR IGNORE INTO forum_categories (
  id,
  name,
  slug,
  description,
  owner_team_id,
  sort_order
) VALUES (
  'forum-platform-help',
  '公告与建议',
  'platform-help',
  'Announcements, suggestions, platform feedback, and official updates.',
  NULL,
  30
);

INSERT OR IGNORE INTO forum_topics (
  id,
  category_id,
  author_user_id,
  title,
  topic_type,
  excerpt,
  source,
  status,
  reply_count,
  view_count,
  last_active_at,
  created_at,
  updated_at
)
SELECT
  'forum-topic-workspace-ai-mcp-guide',
  'forum-platform-help',
  users.id,
  '为什么需要 Frontier Workspace MCP？从安装到把 Post 交给 Agent',
  'official',
  'Frontier Workspace MCP 是 Portal 与个人 Agent 之间的企业授权连接。本文说明它能做什么、如何安装，以及统一的 Agent Handoff 如何工作。',
  'portal',
  'open',
  0,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM users
ORDER BY
  CASE WHEN users.id = '00000000-0000-0000-0000-000000000001' THEN 0 ELSE 1 END,
  users.created_at,
  users.id
LIMIT 1;

INSERT OR IGNORE INTO forum_posts (
  id,
  topic_id,
  author_user_id,
  body_markdown,
  body_json,
  source,
  parent_post_id,
  created_at,
  updated_at
)
SELECT
  'forum-post-workspace-ai-mcp-guide-root',
  forum_topics.id,
  forum_topics.author_user_id,
  '# 什么是 Frontier Workspace MCP？

Frontier Workspace MCP 是 Frontier Workspace Playground 与你正在使用的 Agent 之间的安全连接。它让 ChatGPT、Claude、Cursor 或 WorkBuddy 在你的企业身份和现有权限范围内读取 Forum、浏览 Hub、访问我的 APPS 和 Agent 知识库。

## 为什么 Agent Handoff 需要它？

“交给 Agent”不会把整篇内容和内部数据直接塞进剪贴板。按钮只复制 Topic ID、目标 Post ID 和标准任务说明；Agent 再通过 Frontier Workspace MCP 调用 `forum_get_topic`，按你的实时权限读取内容。这样权限、撤销和审计仍由 Workspace 管理。

## 如何安装

1. 在任意 Post 点击“交给 Agent”。
2. 选择你正在使用的 Agent。
3. 点击“复制安装指令”，把指令粘贴给该 Agent。
4. Agent 会展示一个 Workspace 授权链接。请由你本人在浏览器中打开、检查并批准。
5. 回到 Post 再次点击“交给 Agent”。检测到有效连接后，标准 handoff 会自动复制。

## 能做什么

- 读取和搜索你有权限访问的 Forum 主题；
- 在明确确认后发布主题或回复；
- 浏览企业 Hub 中的 Skills 与 Apps；
- 访问并维护授权范围内的 APPS 资源；
- 检索或维护已启用的 Agent 知识库。

## 安全边界

MCP 不会绕过 Portal 权限，也不会开放个人 API key 或个人 Token 管理。连接可以在 Frontier Workspace MCP 设置中随时撤销；撤销后，本地凭据会在下一次请求时失效。涉及发布、回复、部署等写入动作时，Agent 仍应先获得你的明确确认。

---

Frontier Workspace MCP connects Frontier Workspace Playground to your Agent under enterprise authorization. Use the standard “Hand off to Agent” button, choose your Agent, paste the setup instruction, approve the Workspace authorization link yourself, then retry the handoff.',
  '{}',
  'portal',
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM forum_topics
WHERE forum_topics.id = 'forum-topic-workspace-ai-mcp-guide';

INSERT OR IGNORE INTO forum_topic_tags (topic_id, tag)
SELECT 'forum-topic-workspace-ai-mcp-guide', 'MCP'
WHERE EXISTS (
  SELECT 1 FROM forum_topics WHERE id = 'forum-topic-workspace-ai-mcp-guide'
);

INSERT OR IGNORE INTO forum_topic_tags (topic_id, tag)
SELECT 'forum-topic-workspace-ai-mcp-guide', 'Agent Handoff'
WHERE EXISTS (
  SELECT 1 FROM forum_topics WHERE id = 'forum-topic-workspace-ai-mcp-guide'
);
