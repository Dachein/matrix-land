# Matrix Land SI 产品与工程蓝图

日期：2026-10-30。本文记录新产品的目标与命名约束。0.1.0 已实现范围、验证结果和剩余生产验收见[交付状态](delivery.md)，实际操作以[安装手册](installation.md)为准。

## 1. 已确定的产品前提

Matrix Land SI 是供企业独立部署的开源 AI 工作平台。每个实例使用企业自己的域名、Cloudflare 账号、身份目录、数据和模型服务。源码发行版相同，企业配置独立，后续按明确的发行版本升级。

- 新项目从空数据库开始；不导入旧企业数据。本次品牌升级保留现有路由、包名、环境变量和客户端协议；不得将品牌换名当作破坏性迁移。
- 企业可配置平台显示名、Logo、8 组既定配色、域名、邮件和登录策略。产品模块有稳定名称，不随企业品牌任意改写。
- Mate 就叫 **Mate**；界面不用公司前缀，代码与服务统一使用 `mate`。
- 默认企业邮箱白名单 + 邮件验证码；Microsoft Entra ID 可选。人员、组织和部门模型独立于登录方式。
- 本地 Setup 最终负责配置、检查、部署、初始化和验收。LiteLLM 同时规划“接入已有服务”和“部署到指定服务器”。本轮不实际安装服务器。
- 第一版保持浅色、轻量组件、统一反馈与克制动效；延续已有前端及插画规范。

不继承旧系统的默认企业账号、业务内容、部门推断、等级运营规则或生产环境信息。后续若确实需要导入旧数据，应作为独立导入工具讨论，不加入新产品运行路径。

## 2. 名称分为四层

| 层级 | 规则 | 示例 |
| --- | --- | --- |
| 开源产品 | 固定正式名称 | Matrix Land SI |
| 企业实例 | 可配置显示品牌；不可改变协议标识 | Northstar Workspace |
| 功能模块 | 固定中英文术语 | Mate、工作室 / Studio、知识库 / Knowledge |
| 实例标识 | 创建时确定，与显示名分离 | `northstar-prod` |

企业修改平台名不应改变数据库 ID、Cookie 名、API 路径、MCP 工具名或软件包名。每个企业都重新给协议命名，会使文档、升级和客户端配置失去一致性。

`installationId` 识别独立部署；`organizationId` 识别实例内的企业组织；`departmentId` 识别组织单元；不要再用一个 org 字段同时表示 Cloudflare 账号、企业和 LiteLLM Team。

## 3. 员工端栏目

主导航按下表排列。模块未启用时隐藏入口；模块已启用但服务故障时显示状态和恢复入口，避免故障被误认为功能消失。

| 中文栏目 | 英文 | 主路径 | 内容和边界 |
| --- | --- | --- | --- |
| 首页 | Home | `/home` | 最近工作、待办、常用资源、企业公告；不预置旧企业等级或徽章 |
| Mate | Mate | `/mate` | AI 助手、会话、任务、产物；同一工作对象有唯一入口 |
| 知识库 | Knowledge | `/knowledge` | 文件、资料集合、协作与知识服务 |
| 资源中心 | Catalog | `/catalog` | 企业发布的应用和技能；按类型筛选 |
| 工作室 | Studio | `/studio` | 创建和维护自己的应用、技能、Mate；草稿、版本、发布 |
| 讨论 | Discussions | `/discussions` | 帖子、评论、提及；可选社区能力 |
| 模型服务 | Models | `/models` | 可用模型、个人 API 密钥、用量与预算、客户端接入指引 |
| 连接 | Connections | `/connections` | 个人外部服务授权、MCP 客户端接入、授权范围与撤销 |

通知放在全局工具栏，个人设置放在头像菜单，管理放在独立管理入口；实时动态是视图能力，不是独立一级栏目。首页的新建操作根据上下文创建任务、资源或讨论，不固定为“发帖”。

### 二级栏目和对象路由

| 区域 | 二级栏目 | 对象或操作路径 |
| --- | --- | --- |
| Mate | 会话、任务、产物 | `/mate/:mateId`、`/mate/:mateId/conversations/:conversationId`、`/mate/:mateId/tasks/:taskId` |
| 知识库 | 我的资料、共享给我、知识服务 | `/knowledge/collections/:collectionId`、`/knowledge/documents/:documentId`、`/knowledge/services/:serviceId` |
| 资源中心 | 全部、应用、技能、收藏 | `/catalog/apps/:appId`、`/catalog/skills/:skillId` |
| 工作室 | 应用、技能、Mate | `/studio/apps/:appId`、`/studio/skills/:skillId`、`/studio/mates/:mateId` |
| 模型服务 | 模型、API 密钥、用量、接入指引 | `/models/keys`、`/models/usage`、`/models/setup` |
| 连接 | 我的连接、连接工作区、授权记录 | `/connections/:connectionId`、`/connections/workspace`、`/connections/grants` |
| 讨论 | 全部、我参与的 | `/discussions/:discussionId` |

首版资源中心发布应用和技能；Mate 可直接共享给指定成员，不立即增加第三套公开发布审核。将来是否上架 Mate 是独立功能决策。

新 Web 路由采用 History 路径，部署层支持非 API 页面深链接返回入口。API、静态资源和不存在的业务对象必须返回真实错误，不能被统一改写为首页。查询参数用于筛选、排序和分页，不承担主要对象身份。

## 4. 管理端栏目

| 中文 | 英文 / 路径 | 职责 |
| --- | --- | --- |
| 概览 | Overview / `/admin` | 实例状态、告警、待处理事项 |
| 人员与组织 | People / `/admin/people` | 人员、部门、成员状态、导入和同步来源 |
| 身份与访问 | Identity / `/admin/identity` | 邮箱策略、Entra、会话、角色、管理员与恢复 |
| 模型服务 | Models / `/admin/models` | LiteLLM、模型分配、API 密钥策略、预算、用量 |
| 资源发布 | Publishing / `/admin/publishing` | 应用和技能审核、发布、下架 |
| 知识治理 | Knowledge / `/admin/knowledge` | 知识服务、共享范围、容量与数据保留 |
| 集成 | Integrations / `/admin/integrations` | 连接器定义、企业凭据、组织同步、MCP 服务配置 |
| 外观 | Appearance / `/admin/appearance` | 企业品牌、配色、Logo、登录页、邮件品牌 |
| 运行维护 | Operations / `/admin/operations` | 服务健康、版本、安装任务、备份和恢复 |
| 审计 | Audit / `/admin/audit` | 管理操作、授权、部署和密钥生命周期事件 |

普通成员的“连接”与管理员的“集成”共享底层数据模型，但权限和操作不同。个人 OAuth 授权不等于企业共享凭据，删除个人连接不能删除全公司的集成。

## 5. 核心对象与状态词典

| 对象 | 稳定英文名 | 定义 |
| --- | --- | --- |
| 应用 | App | 可运行的软件，有运行地址和部署版本 |
| 技能 | Skill | 可供 Agent 使用的内容和操作说明包；不等于 MCP Server |
| 助手 | Mate | 有配置、能力、会话和任务的 AI 助手；人员仍称 User / Member |
| 会话 | Conversation | 一段对话上下文 |
| 任务 | Task | 有执行状态、结果和重试规则的工作 |
| 产物 | Artifact | 任务生成的文件或结构化结果 |
| 版本 | Release | 某资源已固定的可分发版本；不代表已在资源中心发布 |
| 发布记录 | Publication | 对某 App 或 Skill Release 的审核与可见性记录 |
| 连接器 | Connector | 外部服务的能力定义和授权方式 |
| 连接 | Connection | 某用户或组织对 Connector 的具体授权实例 |
| 授权 | Grant | 某主体可访问某资源的权限记录 |
| 知识服务 | Knowledge Service | 以明确资料范围、索引和访问策略提供的检索能力 |
| API 密钥 | API Key | 模型调用凭据；不再用 Token 作为整个模块名称 |
| 访问令牌 | Access Token | 短期协议凭据；不与 API Key 或模型用量混称 |
| 令牌用量 | Token Usage | 模型计量单位，显示输入/输出及适用成本 |

资源内容状态为 `draft → released → archived`；发布记录状态为 `pending → approved / rejected → withdrawn`，修改已发布内容必须指向新 Release。运行部署状态为 `planned → provisioning → deploying → verifying → ready / failed`，与审核状态分开。

任务状态为 `queued → running → waiting / succeeded / failed / cancelled`；连接状态为 `unconfigured / authorizing / connected / expired / revoked / error`。每种失败都区分可重试、需配置、需授权和不可恢复，不用一个“异常”覆盖所有情况。

## 6. 权限与企业目录

实例内设 Owner、Admin、Member。审核员、模型管理员、知识管理员、运维人员作为可授予的能力集合，不扩展成大量互相包含的全局角色。

- Owner 管理实例所有权、管理员和恢复策略；不得移除最后一个有效 Owner。
- Admin 管理被授权的企业设置；Member 默认只访问自己的资源和明确共享的内容。
- App、Skill、Mate、知识集合支持所有者、协作者和读者；企业可见不自动代表可编辑。
- 部门成员关系不隐含管理员权限；Entra 管理员不自动成为 Workspace 管理员。
- 服务账号与真人账号分开；只授予需要的资源和动作。服务故障不能切换到更大权限凭据。

权限采用 `resource.action`，例如 `mates.read`、`mates.run`、`apps.deploy`、`skills.publish`、`knowledge.share`、`models.keys.manage`、`integrations.manage`、`installation.upgrade`。HTTP API、MCP 和后台任务调用同一授权策略，前端隐藏按钮不能代替后端校验。

内部人员使用稳定 `userId`，外部身份单独记录 provider、tenant、subject 和绑定来源。邮箱是可验证的联系方式，不用邮箱前缀、姓名相似度或域名推断人员归属。Entra 登录以验证后的 `tid + oid` 识别身份，不能把可变邮箱 Claim 当作稳定身份。[Microsoft ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)

目录同步通过受限 Connector 接口导入到内部模型，记录来源 ID、最近同步时间和冲突。登录不依赖实时调用人事系统；停用员工应撤销会话、个人授权和密钥，并保留必要审计。人工字段与同步字段明确归属，不能全量覆盖。

## 7. 服务、域名与工程名称

域名前缀稳定；只有实际启用且需要公开访问的服务创建 DNS。内部任务优先使用 Service Binding、队列和计划任务，不因存在一个 Worker 就分配一个公开域名。

| 服务 ID | 目录 | 默认外部入口 | 边界 |
| --- | --- | --- | --- |
| portal | `apps/portal` | 企业选择的入口域名 | 页面、同源 API 聚合、公开品牌 |
| auth | `workers/auth` | `auth.{serviceRoot}` | 身份、会话、授权；浏览器登录经入口同源路径 |
| mcp | `workers/mcp` | `mcp.{serviceRoot}/mcp` | 工作区 MCP 能力与资源授权 |
| apps | `workers/apps` | `apps.{serviceRoot}` | 应用管理、部署和运行访问 |
| knowledge | `workers/knowledge` | `knowledge.{serviceRoot}` | 文件、索引、知识服务 |
| mate | `workers/mate` | `mate.{serviceRoot}`，按需要公开 | Mate 执行、任务、会话与产物 |
| gateway | `workers/gateway` | `gateway.{serviceRoot}` | 平台模型入口、身份映射与 LiteLLM 适配 |
| live | `workers/live` | `live.{serviceRoot}` | 实时事件与订阅 |
| mail | `workers/mail` | 按启用能力分配 `mail.{serviceRoot}` | 业务邮件；登录系统邮件能力单独说明 |
| stream | `workers/stream` | 按启用能力分配 `stream.{serviceRoot}` | 已有媒体/流能力；可选 |
| backup | `workers/backup` | 默认无公开域名 | 备份编排与恢复验证 |
| publication | `workers/publication` | 默认无公开域名 | 发布任务与审核后分发 |
| model-health | `workers/model-health` | 默认无公开域名 | 模型状态任务 |
| usage-rollup | `workers/usage-rollup` | 默认无公开域名 | 模型用量汇总 |
| miniapp-api | `workers/miniapp-api` | 按启用能力分配 `miniapp-api.{serviceRoot}` | 小程序接口；客户端独立可选 |

表中是目标边界，是否合并低负载后台 Worker 由资源清单评估决定；栏目数量不决定 Worker 数量。组织连接器在 `connectors/` 下按供应商分布，不作为每个企业的必装服务。

员工使用的模型入口是 Gateway；外部 LiteLLM 是一个独立依赖，可以在已有服务器或安装器管理的服务器上。不要把 LiteLLM 管理入口和员工模型调用入口混成一个地址。

`serviceRoot` 可为 `example.com` 或 `workspace.example.com`。输入 `*.workspace.example.com` 表示命名空间，不表示创建一条捕获整个父 Zone 的通配绑定。应用地址默认 `app-{slug}.{serviceRoot}`。保留全部固定前缀及 `app-` 空间，冲突在部署前报告。证书必须按实际主机名检查；Worker Custom Domains 支持精确主机名和多级子域名，不接受通配主机名。[Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

### 工程命名规则

| 项目 | 目标规则 |
| --- | --- |
| 仓库目录 | `frontier-workspace` |
| Workspace 根包 | `frontier-workspace`，`private: true` |
| 工作区内包 | `@frontier-workspace/contracts`、`ui`、`cli`、`sdk`、`installer`；正式 npm 发布前另验名称所有权 |
| CLI | `frontier-workspace`；开发期经仓库脚本运行，不使用尚未发布的包 |
| 文件和目录 | kebab-case；React 组件 PascalCase；类型 PascalCase；变量 camelCase |
| 数据表/列 | snake_case，实体表用复数；如 `mates`、`mate_releases`、`api_keys` |
| API | `/api/v1/mates`、`/api/v1/apps` 等复数资源；管理 API 独立授权 |
| MCP 工具 | 稳定 snake_case，如 `mates_list`、`tasks_create`；不随企业品牌变化 |
| 协议标识 | 工作区固定前缀 `fw`；具体命名在 contracts 包集中声明 |
| 环境变量 | 平台使用 `WORKSPACE_*`，供应商用 `LITELLM_*`、`ENTRA_*`、`CLOUDFLARE_*` |
| 云资源 | `fw-{installationId}-{service}-{kind}`；各产品长度约束由生成器校验，必要时加稳定短摘要 |
| 客户端凭据 | 按规范化实例 URL 和安装 ID 分目录；无默认远程企业地址 |

浏览器会话采用入口主机限定 Cookie，不设企业根域 Cookie；目标为 `__Host-fw_session`，Secure、HttpOnly、Path=/，SameSite 按实际登录流验收。不能因多个子服务同属企业域名就共享登录凭据。

## 8. 品牌、设计与反馈约束

品牌配置只包含可公开字段，不能与 Cloudflare 凭据、LiteLLM Key、Entra Secret、内部资源 ID 混在同一浏览器响应中。8 组配色使用固定 palette ID；企业 Logo 和显示名有长度、格式与可访问性约束。

页面按“标题与主要操作 → 内容 → 局部反馈”组织；共用 Button、Field、Select、Tabs、Dialog、Toast、Empty State、Status。表格和表单不各自发明错误样式。服务未配置给出配置入口，权限不足说明需要何种权限，保存失败保留用户输入。

文案使用“创建、保存、发布、部署、授权、停用、撤销”等具体动作。发布是让资源可发现，部署是让程序运行；不互相替代。密钥只显示掩码，首次完整展示必须明确，日志和错误详情不回显凭据。

沿用[前端标准](frontier-workspace-frontend-standard.md)与[插画规范](frontier-workspace-illustration-standard.md)。本轮不重新建立第二套控件库。

## 9. 安装与维护作为产品能力

Setup 分为：企业信息 → 域名与 Cloudflare → 模块 → 邮件与身份 → 模型服务 → 管理员 → 审阅计划 → 执行 → 验收。每一步保留草稿、独立验证和可解释结果。

`配置已填写`、`连接已验证`、`资源已创建`、`部署已完成`、`业务已验收` 是五种不同状态。只有最后一种通过才显示安装完成。未来 CLI 与浏览器 Setup 共用一个编排内核，避免两套安装逻辑。

具体 LiteLLM、Entra、首位管理员、凭据与重试规则见[安装与集成设计](frontier-workspace-setup-integrations.md)。

## 10. 新代码库的实施顺序

| 阶段 | 工作 | 通过条件 |
| --- | --- | --- |
| A 规则冻结 | 按本文建立术语、模块、路由、权限和服务注册表 | 各模块只有一个稳定 ID；不存在隐式旧名称别名 |
| B 干净源码 | 在独立目录按允许清单导出源码；重命名文件、引用、配置和测试 | 原仓库保留；新库无旧 Git 历史、企业数据、账号和素材 |
| C 核心闭环 | 统一 Portal、Auth、Mate、Knowledge、Apps、MCP、Gateway 契约 | 空白数据启动；登录、权限、创建和调用通过端到端验证 |
| D 安装器 | 配置模型、资源图、幂等执行、LiteLLM/Entra 适配器 | 预检无写入；中断后续跑不重复资源；密钥不进入计划和日志 |
| E 空账号演练 | 新域名、CF 资源、新服务器、企业身份完整部署 | 邮件登录、Entra 登录、管理员、真实模型调用和业务样例通过 |
| F 发布与升级 | 发行清单、备份恢复、升级演练、开源材料与首次提交 | 全新安装和升级都留有验收证据；仅提交已审查的新库内容 |

首次提交前不能以一次全局字符串替换代替 B、C 阶段。必须处理类型、API、数据库、MCP 工具、Cookie、测试夹具、图片、CI 和文档的相互引用。取消旧兼容不等于取消新产品未来发行版本的升级约定。

### 首次提交检查单

- 文件名、文本、代码标识、构建产物中无旧企业名称和域名；审查图片、PDF、压缩包与字体等非文本资源。
- 无实际员工、邮箱、组织结构、业务记录、账号 ID、资源 ID、凭据和生产备份。
- 新建数据库有干净基线及合成示例数据；不重放含企业数据的历史迁移。
- CI 不连接旧环境；示例使用保留示例域名，缺配置时明确失败。
- 安装与升级文档只描述实际可运行版本；未完成项列出，不标成一键部署成功。
- 确定开源许可证和第三方素材/依赖许可；未确定许可证时不宣称已完成开源发布。
- 新目录的测试、构建、深链接、品牌矩阵与安装器验收通过，才建立新的首次提交。

## 11. 当前实现差距

0.1.0 已实现独立源码库、导航与品牌配置、六套空库基线、邮箱验证码登录与所有者认领、本机安装执行器、LiteLLM/Entra 初始化、升级前备份及失败续跑。阶段 A–D 的实现与本地验证已具备，核心模块仍需真实环境端到端验收。

尚未完成阶段 E 的空账号完整部署，以及阶段 F 的真实升级和恢复验收。邮件送达、DNS/TLS、Entra 登录、云端模型调用和业务操作需要在企业测试实例逐项记录证据。`npm run setup` 已支持审阅并执行部署计划；本地模拟或部署包编译不代表真实部署通过。最新验证结果见[交付状态](delivery.md)。

本仓库从独立的空库基线开始，不承诺迁移其他实例的数据或保持其他产品的协议兼容。
