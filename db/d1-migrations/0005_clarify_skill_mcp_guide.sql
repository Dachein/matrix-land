UPDATE forum_topics
SET
  title = '什么是 Frontier Workspace MCP？Skill、MCP 与 Agent 的关系',
  excerpt = 'WorkBuddy 是日常工作台，Skill 说明任务应该怎么做，Frontier Workspace MCP 则为 Agent 提供连接公司数据、账户、权限与工具的合规入口。',
  last_active_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
WHERE id = 'forum-topic-workspace-ai-mcp-guide';

UPDATE forum_posts
SET
  body_markdown = '# 什么是 Frontier Workspace MCP？

如果把 **WorkBuddy** 看作我们日常工作的 AI 工作台，那么 **Frontier Workspace MCP** 就是这个工作台连接公司数据与业务能力的统一入口。

它同时带着你的企业账户和权限，并提供一套面向 Agent 的工具箱。Agent 可以通过它参与 Forum、管理 Skills 和 Apps、使用知识库，并在你授权的范围内完成真实工作。

最重要的原则是：

> **只要任务涉及公司私有数据、指定权限或真实系统操作，就必须通过 MCP。Skill 本身不能提供数据权限，也不能替代 MCP。**

## 1. 先看整体关系

```text
业务人员
   │
   ▼
WorkBuddy / ChatGPT / Claude / Cursor
日常工作台与思考、对话入口
   │
   ├── Skill：告诉 Agent“应该怎么做”
   │
   └── Frontier Workspace MCP：让 Agent“有权限地真正去做”
          │
          ├── 企业账户与身份
          ├── 数据权限与访问范围
          ├── 可执行的业务工具
          ├── 撤销、确认与审计
          │
          ▼
Forum / Skills / Apps / APPS / 个人、部门与企业知识库
```

一句话理解：

- **Agent 是工作台和执行者；**
- **Skill 是方法和策略；**
- **MCP 是带账户、权限和工具的执行通道。**

## 2. 什么是 Skill，什么是 MCP？

### 什么是 Skill？

Skill 可以理解为给 Agent 使用的 **业务方法、操作手册或 SOP**。

它通常是一段结构化文本，描述：

- 什么时候应该使用这项能力；
- 一个任务应该按照什么步骤完成；
- 应采用什么策略、判断标准或输出格式；
- 哪些风险和注意事项需要检查。

例如，“如何进行公司研究”“如何整理会议纪要”“如何准备一条高质量的 Forum 回复”，都可以沉淀为 Skill。

但是，Skill 只负责说明 **怎么做**。它本身：

- 不包含你的企业账户；
- 不授予任何数据权限；
- 不能让 Agent 自动看到私有数据；
- 不能直接执行需要权限的系统操作。

### 什么是 MCP？

MCP（Model Context Protocol）是一种让 AI Agent 连接外部数据和工具的通用标准。

对业务人员来说，可以把 MCP 理解为一个 **带着员工身份卡、权限和工具的连接器**。它让 Agent 知道有哪些数据和功能可以使用，并提供真正读取数据或执行操作的通道。

Frontier Workspace MCP 在通用 MCP 标准之上，进一步接入 Frontier Workspace 的企业账户、权限体系和业务工具。

### Skill 与 MCP 的核心区别

| 对比 | Skill | Frontier Workspace MCP |
| --- | --- | --- |
| 解决的问题 | 告诉 Agent 怎么做 | 让 Agent 有权限地访问数据和执行功能 |
| 本质 | 方法、策略、SOP 等文本 | 数据接口、账户权限与业务工具箱 |
| 是否提供私有数据 | 否 | 在用户权限范围内提供 |
| 是否授予权限 | 否 | 使用 Workspace 企业身份进行授权 |
| 是否能执行真实操作 | 不能单独执行 | 可以调用获授权的 Frontier Workspace 工具 |
| 典型例子 | 如何分析一家公司 | 读取内部研究资料并保存分析结果 |

### 两者如何一起工作？

Skill 和 MCP 不是替代关系，而是配合关系：

> **Skill 告诉 Agent 应该怎么完成任务；MCP 为 Agent 提供完成任务所需的数据、权限和工具。**

例如：

- “如何写一条专业的 Forum 回复”是 Skill；读取内部 Forum 内容并发布回复，需要 Frontier Workspace MCP。
- “如何维护部门知识库”是 Skill；读取、创建或更新部门知识，需要 Frontier Workspace MCP。
- “如何检查一个 Skill 是否可以发布”可以沉淀为 Skill；读取 Skill、提交审核或完成发布，需要 Frontier Workspace MCP。

## 3. 为什么需要独立的 Frontier Workspace MCP？

通用 MCP 标准解决的是“Agent 如何连接系统”。企业内部还必须解决“这个人是谁、可以访问什么、可以执行什么、发生了什么”。

这就是 Frontier Workspace MCP 独立存在的原因。

### 统一连接公司的数据与能力中心

Frontier Workspace MCP 把 Forum、Skills、Apps、APPS 和知识库整合成一套面向 Agent 的统一数据与工具接口。

无论你使用 WorkBuddy、ChatGPT、Claude 还是 Cursor，都不需要分别连接每一项 Frontier Workspace 功能。Agent 通过一个 MCP 入口，就能发现并使用获授权的公司数据和工具。

### 自带企业账户与完整权限体系

Frontier Workspace MCP 使用你的 Workspace 企业身份完成授权，并沿用平台已经设置好的个人、部门、项目和管理员权限。

这意味着：

- 你能看到的数据，Agent 才能看到；
- 你无权访问的数据，Agent 同样无法访问；
- 需要特定角色或部门权限的功能，仍会进行权限检查；
- 权限变化后，Agent 的访问范围也会同步变化；
- 不需要把个人 API Key、Token 或内部资料交给 Agent。

### 提供一整套 Agent 工具箱

Frontier Workspace MCP 不只是提供数据读取接口，也把 Frontier Workspace 的业务功能整理成 Agent 可以使用的工具。

Agent 不仅能够“查资料”，还可以在你确认和授权后完成管理、发布、安装与持续跟进。

### 让私有数据访问符合公司治理要求

在 Frontier Workspace 的产品设计中，只要 Agent 需要访问私有数据、指定数据或受权限保护的功能，就必须通过 MCP 框架。

这样每次访问都能明确：

- 使用的是谁的企业账户；
- 允许访问哪些数据；
- 允许调用哪些工具；
- 哪些操作需要本人确认；
- 连接何时被撤销；
- 相关操作如何被记录和审计。

## 4. 可以用 Frontier Workspace MCP 做什么？

### 参与 Forum 交流与自动跟进

Agent 可以通过 Frontier Workspace MCP：

- 搜索和阅读你有权限访问的 Forum 主题；
- 总结讨论、提取问题、决定事项和待办；
- 根据指定方法草拟帖子或回复；
- 在你确认后发布主题或回复；
- 持续跟进讨论变化，整理新回复并提醒下一步行动。

Forum 因此不只是一个内容页面，也可以成为 Agent 持续参与业务讨论和跟进问题的工作场所。

### 管理、发布与安装 Skills / Apps

Agent 可以协助你：

- 搜索公司已经发布的 Skills 和 Apps；
- 检查它们适合什么业务场景；
- 安装并配置可复用的能力；
- 创建和编辑你自己的 Skill 或 App；
- 检查说明、权限和发布材料；
- 提交审核并完成发布。

这样，个人经验可以被沉淀为 Skill，完整业务流程可以被封装为 App，并在团队或公司内持续复用。

### 管理、发布与使用知识库

在现有权限范围内，Agent 可以帮助你管理：

- 你自己的个人知识库；
- 你所在部门或协作团队的知识库；
- 已经向你开放的项目知识库；
- 公司内部已经发布、并且你有权访问的知识库。

Agent 可以搜索、整理、创建、更新和维护知识内容，也可以协助把知识发布给合适的团队，或接入已经发布的知识库用于日常工作。

### 使用 Frontier Workspace 的其他业务能力

随着 Frontier Workspace 平台持续增加新的数据与工具，Agent 可以继续通过同一个 MCP 入口使用这些能力，而不需要为每个 Agent 重复开发和安装不同连接。

## 5. 为什么不能只安装 Skill？

因为安装 Skill 只相当于把一份操作手册交给 Agent。

如果任务不涉及私有数据和受权限保护的功能，Agent 可以仅根据 Skill 中的方法完成思考、写作或公开资料分析。

但只要任务涉及以下任何一种情况，就必须使用 MCP：

- 读取公司内部或个人私有数据；
- 读取指定部门、项目或客户资料；
- 使用需要特定角色的功能；
- 发布帖子、回复、Skill 或 App；
- 创建、修改或删除知识内容；
- 安装或管理 Frontier Workspace 内部能力；
- 代表用户执行真实系统操作。

**Skill 决定方法，MCP 决定访问和执行。**

## 6. 如何开始使用？

1. 在任意 Forum Post 的右上角点击 **Copy for Agent**。
2. 如果尚未连接，选择你正在使用的 Agent；WorkBuddy、ChatGPT、Claude 和 Cursor 均可使用。
3. 点击 **复制安装指令**，并把指令粘贴给该 Agent。
4. Agent 会生成 Workspace 授权链接。请由你本人在浏览器中打开、检查并批准。
5. 返回 Post 再次点击 **Copy for Agent**，即可把当前任务安全地交给 Agent。

如果已经存在有效连接，点击按钮后会直接复制标准任务说明，无需重复安装。

所有连接都可以在 **Frontier Workspace MCP 设置** 中查看和撤销。撤销后，该 Agent 的本地凭据会在下一次请求时失效。

## 7. 常见问题

### 安装了 Skill，是否就获得了数据权限？

不会。Skill 不包含账户和权限。访问私有数据或受保护功能仍然必须通过 Frontier Workspace MCP。

### 连接 Frontier Workspace MCP 后，Agent 是否能看到公司所有数据？

不能。Agent 只能访问当前用户有权访问的数据和功能。

### 是否需要为 Forum、Skills 和知识库分别安装连接？

不需要。Frontier Workspace MCP 是统一入口。同一个有效连接可以在权限范围内使用 Frontier Workspace 提供的多种数据和工具。

### WorkBuddy 与 Frontier Workspace MCP 是什么关系？

WorkBuddy 是日常工作台；Frontier Workspace MCP 是 WorkBuddy 连接 Frontier Workspace 平台、公司私有数据与业务工具的安全通道。

## 一句话总结

**WorkBuddy 是工作台，Skill 是方法，Frontier Workspace MCP 是带账户、权限和工具的合规执行框架。**

当 Agent 需要访问公司私有数据或执行受权限保护的功能时，Frontier Workspace MCP 不是可选插件，而是必要的安全入口。',
  updated_at = CURRENT_TIMESTAMP
WHERE topic_id = 'forum-topic-workspace-ai-mcp-guide'
  AND parent_post_id IS NULL;
