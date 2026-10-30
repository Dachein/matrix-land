# Frontier Workspace 安装与集成设计

日期：2026-10-30。本文保留完整目标设计；0.1.0 已包含安装执行器与集成初始化，具体支持边界见[交付状态](delivery.md)，可执行步骤见[安装手册](installation.md)。本次没有连接或安装真实服务器、创建真实 Entra 应用或签发真实 API 密钥。产品术语以[产品蓝图](frontier-workspace-product-blueprint.md)为准。

## 1. 交付目标和范围

用户在本地启动 Setup，配置企业品牌、域名、Cloudflare、邮箱登录、可选 Entra、LiteLLM 和首位管理员，预览完整计划后执行。最终需要能够部署落地，不止导出配置文件。

三类操作明确分开：`plan` 只计算；`validate` 执行明确列出的只读检查；`apply` 执行计划中的云资源、服务器和身份系统变更。模型试调用、测试邮件、临时 Key 属于验收动作，不能伪装为无副作用的连接检查。

Cloudflare 托管 Workspace。LiteLLM 运行于企业已有服务或指定 Linux 服务器；Entra 是企业持有的 Microsoft 身份服务。Setup 编排三者，不将所有服务假设为同一种云资源。

## 2. 安装步骤及完成标准

| 步骤 | 用户填写或选择 | 完成标准 |
| --- | --- | --- |
| 企业 | 实例 ID、显示名、Logo、配色、语言、时区 | 唯一标识、合法公开配置 |
| 域名 | 员工入口、服务根域名 | 无冲突、域名清单可审阅、所属 Zone 明确 |
| Cloudflare | 账号与授权 | 逐模块检查所需权限、资源能力和配额 |
| 模块 | 必需基础与可选业务模块 | 依赖闭包确定；未启用服务不分配资源 |
| 邮件 | 允许登录域名、发件地址 | 发信条件和域名授权通过，随后实际投递验收 |
| 身份 | OTP 默认，Entra 可选 | 策略明确；Entra 配置完整后执行真实登录验收 |
| 模型服务 | 接入已有 / 部署到服务器 | LiteLLM、数据库、模型和 Key 生命周期均通过检查 |
| 管理员 | 明确首位管理员身份 | 完成身份验证及一次性所有权认领 |
| 审阅 | 创建/复用/修改项、权限、成本类别、检查项 | 配置摘要与版本固定，执行时无意外新增项 |
| 执行 | 执行已经审阅的计划 | 每步有记录、失败定位、中断可恢复 |
| 验收 | 登录、邮件、模型、权限、业务样例 | 所有必需检查通过，写入已安装版本 |

可选模块未配置时允许跳过；核心登录或数据库检查失败时不能宣告实例就绪。LiteLLM 若延后配置，界面可验收为“工作区基础已安装、AI 功能未启用”，不能显示完整 AI 安装完成。

### 模块依赖与资源归属

| 模块 | 直接依赖 | 主要持久化资源 | 启用规则 |
| --- | --- | --- | --- |
| Core | Portal、Auth、系统发信 | 身份与策略 D1、工作区业务 D1、必要文件 R2 | 必需；空库初始化不导入员工 |
| Models | Core、可达 LiteLLM | Gateway 管理映射与用量 D1；LiteLLM 自有 PostgreSQL | 启用 AI 能力前必须通过模型验收 |
| Mate | Core、Models | Mate 任务/会话 D1、产物 R2、执行协调对象 | 不要求先启用讨论、小程序或人事连接器 |
| Knowledge | Core | 文件 R2、元数据 D1、索引任务队列 | 文件管理与检索分别验收；语义索引另依赖嵌入模型和选定索引后端 |
| Studio / Catalog | Core、Apps、Publication | App/Skill/Release/Publication 数据、发布制品存储 | 源码生成可依赖 Models，但普通已有制品发布不隐式依赖 AI |
| Connections / MCP | Core、MCP、所启用工具模块 | 连接、授权与 OAuth 客户端记录 | 不发布未启用模块的工具；每次调用仍需授权 |
| Discussions / Live | Core | 讨论记录、事件、实时协调对象 | 可选；通知传递可复用事件设施 |
| Mail / Stream / Miniapp | Core 及各自运行条件 | 各模块明确声明的数据库、对象存储或第三方资源 | 默认按需求开启，分别检查供应商和客户端条件 |
| Operations | Core、已启用模块资源清单 | 任务状态、审计、隔离的备份存储 | 生产验收必须有备份策略和恢复证据 |

该表定义目标资源归属，不是当前 Wrangler 文件的逐份复制。每个数据集合只有一个写入负责人，其他模块通过受控 API 或服务接口变更；是否共享物理 D1 由资源清单决定，但不能让“共用数据库”演变成无边界跨模块写入。备份读取授权和恢复写入授权分别配置。

每个模块的发布清单必须声明 `requires`、`resources`、`bindings`、`secrets`、`migrations`、`publicEndpoints`、`healthChecks`、`backupPolicy` 和 `supportedPlatforms`。安装器从同一注册表生成模块选择、权限需求和部署顺序，拒绝依赖循环。

当前来源工作区涉及 D1、R2、队列、Durable Objects、定时任务和 Service Binding。新安装器必须逐项开通、绑定和核验；仅创建 Worker 名称不足以部署成功。新数据库基线包含索引、唯一约束、状态约束和必要系统配置；示例数据独立且默认不安装。

## 3. LiteLLM 两条路径

### A. 接入已有服务器

配置 `mode=existing`、管理 API Base URL、模型调用 Base URL（默认由相同服务派生）、凭据引用、所管理的 Team、模型和预算策略。

1. 验证 HTTPS、证书、网络可达及受支持的版本/能力；不要把首页 200 当成 API 正常。
2. 检查数据库连接。Key 管理需要 PostgreSQL，预算也依赖数据库；无数据库不能通过企业 Key 管理验收。[Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys)、[Budgets](https://docs.litellm.ai/docs/proxy/users)
3. 识别可用管理权限，列出所需的用户、Team、Key、模型和用量接口。401/403 与功能不支持分别展示。
4. 让管理员选择新建专用 Team 或绑定已有 Team。保存实际服务端 ID 与安装归属；显示名仅供识别。
5. 读取允许的模型，选择至少一个实际可用的推理模型；启用知识索引时还要选择匹配能力的嵌入模型。
6. 在执行阶段创建平台管理凭据、服务调用 Key 和短期验收 Key。重试先核对记录，不能重复发 Key。
7. 从 Workspace 的实际云端网络做一次最小调用，并检查模型权限、用量归属和凭据撤销；本机可达不代表 Cloudflare 可达。

复用已有服务时不自动升级 LiteLLM、不修改无关 Team、不替换供应商 Key、不覆盖服务配置。只管理计划中指定且授权的对象。

### B. 部署到指定服务器

首个受支持部署形态规划为 Linux + Docker Compose 单机；明确是单机方案，不宣称高可用。输入服务器地址、SSH 端口、部署用户、SSH 凭据引用、域名、数据目录、版本和备份目标。

部署组成：LiteLLM、PostgreSQL、HTTPS 入口及持久化目录。Redis 按所选版本和负载需求启用，不作为所有安装的隐式依赖。官方提供 Docker 单机入口；本项目需要在其基础上补齐生命周期管理。[LiteLLM Docker Quickstart](https://docs.litellm.ai/docs/proxy/docker_quick_start)

执行顺序：

1. 检查 CPU 架构、系统版本、磁盘、时间、网络、端口占用、Docker 与 Compose；环境不符合支持矩阵则停在可解释的前置步骤。
2. 检查 SSH 主机指纹并记录，不忽略主机校验。只使用部署所需权限；预检不升级主机或停止已有服务。
3. 生成固定版本及镜像摘要的部署包。禁止生产使用 `latest`，记录 Compose 项目名、镜像、配置摘要和目录归属。
4. 为新建数据库和 LiteLLM 生成不同的随机凭据；供应商 API Key 由企业安全输入。敏感文件限制为部署账户可读，不出现在命令行参数或日志中。
5. 建立专属持久化目录、数据库、网络与服务。数据库不开放到公网；对外入口按审阅计划配置 HTTPS 或已有受控网络通道。
6. 配置的 LiteLLM 地址必须同时满足本地安装器和 Workspace 运行端可达。仅本地 SSH 隧道可达不能作为生产连接方案。
7. 按固定版本执行数据库准备和服务启动，检查重启后的持久化、TLS、数据库状态及管理认证。
8. 进入与 A 相同的 Team、模型、Key 初始化和业务验收流程。
9. 完成数据库与配置备份，至少演练一次恢复到隔离位置。记录运维责任与当前版本。

如果服务端已存在同名目录、Compose 项目、数据库或域名，必须判断归属并选择明确的复用路径，不自动接管。安装失败保留已创建资源记录，清理只针对本次新建且确认可删除的对象。

服务器购买、域名购买、供应商账号开通不属于自动安装器可代办的前提；Setup 应显示所缺条件。现在不执行这些安装动作，但配置模型和执行器接口必须覆盖此路径。

## 4. LiteLLM 凭据、预算与初始化

### 凭据分工

| 凭据 | 使用者 | 保存位置 / 生命周期 |
| --- | --- | --- |
| Provider API Key | LiteLLM 调用上游模型 | LiteLLM 侧安全配置；Workspace 不重复保管 |
| Bootstrap 管理凭据 | 本地 Setup 初始建 Team、授权 | 仅初始化期间或企业选择的受控凭据库；不发给浏览器业务页面 |
| Provisioning Key | Workspace 服务端管理已授权的对象 | 专用管理后端 Secret；不用于普通模型请求 |
| Service Key | Mate、知识索引等服务 | 按用途分离的运行端 Secret；带模型范围与预算 |
| Personal API Key | 员工自己的客户端 | 首次受控交付；平台保存标识、掩码和授权记录，避免可重新展示明文 |
| Test Key | 安装验收 | 短有效期、低预算；验收结束撤销并核验 |

优先使用经实际版本验证的最小权限管理凭据。不能假设所有 LiteLLM 版本/许可证都支持相同的 Team 管理权限。开源基线不依赖 LiteLLM Organization；Team 可作为隔离边界，Organization 和部分委派权限受版本/许可条件约束。[LiteLLM RBAC](https://docs.litellm.ai/docs/proxy/access_control)

若目标服务无法满足所需最小权限，明确提供“受限接入”或“专用实例受控管理”的能力级别；不静默从 Provisioning Key 回退到 Master Key。受限接入只使用预先签发的运行 Key，并禁用不支持的自助密钥管理。

### 稳定归属与幂等

维护 `installationId → teamId`、`workspaceUserId → litellmUserId`、`purpose → keyId` 映射。调用前先写操作意图，再记录返回对象 ID。超时后先核对服务端是否已完成，不能盲目再次创建。

LiteLLM 不一定为每个端点提供幂等 Key，因此适配器必须针对固定版本实现核对。若创建成功但密钥响应丢失且无法安全恢复，撤销该孤立 Key 后重建，并记录原因；不在日志里寻找明文 Key。

预算 UI 区分团队预算、成员预算、Key 预算、周期和币种。使用 Team Key 时不能误把独立个人预算视为同一强制上限；预算关系须按所支持版本验收。[LiteLLM Budgets](https://docs.litellm.ai/docs/proxy/users)

预算是调用时的控制手段，不宣称是对所有并发请求零超额的财务保证。实例展示来源、更新延迟和模型价格口径；用量同步失败显示延迟，不归零。

### 健康与轮换

探针分三层：进程、数据库准备状态、真实模型请求。`/health/readiness` 检查服务准备情况；模型健康检查可能发出实际计费调用，应纳入验收计划。[LiteLLM Health Checks](https://docs.litellm.ai/docs/proxy/health)

轮换顺序为创建替代凭据 → 写入引用 → 部署消费者 → 验证 → 撤销旧凭据。仅在目标版本支持时使用宽限期；失败时停留在明确状态。停用员工同时撤销其个人 Key，但不删除企业服务 Key。

## 5. Entra ID 配置与初始化

### 登录形态

每个企业配置自己的单租户应用。默认只支持一个显式 Tenant；不使用 `common` 或隐式多租户授权。Entra 应用名称可为“企业显示名 — Workspace 登录”。单租户选择与应用注册由企业的 Entra 权限控制。[Microsoft 应用注册](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)

浏览器访问 Workspace 入口的同源 `/auth/entra/start`，回调固定为 `https://{portalHostname}/auth/entra/callback`。Portal 受控代理给 Auth Service，服务端完成 Authorization Code + PKCE，浏览器不持有应用 Secret。Entra 注册的平台类型为 Web；不把此服务端回调注册为 SPA。[Redirect URI 配置](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri)

目标回调路径与当前旧实现不同，必须在新代码库一次性实现并测试。安装器依据实际发布契约生成回调地址，不能仅根据 auth 子域名猜测。CLI、MCP OAuth 和 Entra 回调是不同契约，不能混用。

### 两条初始化路径

| 路径 | 行为 | 适用情况 |
| --- | --- | --- |
| 使用已有应用 | 输入 Tenant ID、Client ID、凭据引用，展示所需回调与权限，验证配置 | 企业已经注册应用，或不希望授予自动建应用权限 |
| 辅助创建应用 | 企业管理员在本地明确授权后，由安装适配器创建/配置本实例应用及服务主体 | 允许自动化初始化的租户 |

辅助创建可通过 Microsoft Graph 实现，但必须使用企业已批准的本地授权方式及足够目录权限；不能假设任意 Microsoft 登录都拥有建应用权限。Graph 提供应用创建及凭据添加接口。[Create application](https://learn.microsoft.com/en-us/graph/api/application-post-applications?view=graph-rest-1.0)、[Add password](https://learn.microsoft.com/en-us/graph/api/application-addpassword?view=graph-rest-1.0)

无相应权限时展示精确的手工配置步骤并继续验证，不能卡死整个邮箱登录安装。自动化初始化凭据不得存入运行时 Auth Worker；运行时仅保存本应用所需凭据。

### 最小配置与验证

配置包括 tenant、client、Microsoft cloud/authority、精确 redirect URI、凭据类型与引用、到期时间、允许的身份范围。初版支持的云环境必须列入发行清单；未验证的主权云标为不支持，不拼接一个未知 authority 继续执行。

默认登录只请求 OIDC `openid profile email`；若启用 Graph 头像或额外资料，独立说明并请求对应权限。组织全量同步不绑定在首次登录中，不默认索取全目录读取权限。

客户端凭据支持 Secret 和证书两种配置形态；证书方案必须完成服务端签名断言实现后才能在 UI 标为可用。Microsoft 推荐生产使用证书；若选择 Secret，需要记录到期和轮换提醒。[Microsoft 应用凭据](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)

真实登录验收检查签名、issuer、audience、tenant、过期时间、state、nonce、PKCE 和回调一次性消费。身份键为 `(tenantId, objectId)`；邮箱 Claim 缺失或不能证明可收信时，引导独立邮箱验证，不据此绕过白名单。[ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)

首次 Entra 登录默认建立 Member。将 Entra 身份绑定到已有 OTP 用户，必须证明两边身份或经过管理员审查；不依赖同名或邮箱前缀匹配。已有停用人员不能借新登录方式恢复权限。Entra 租户角色不映射成 Workspace Owner。

## 6. 首位管理员与恢复

Setup 明确指定首位管理员的已验证邮箱；使用 Entra 时还可绑定经过验证的 tenant + object ID。只知道允许的邮箱后缀不能获得管理权。

1. 安装器生成短期一次性认领令牌，服务端只保存哈希、实例、目标身份、到期时间和状态。
2. 管理员通过已配置的真实登录流程，证明指定身份。
3. 服务端在原子条件下验证尚无 Owner、令牌未使用且身份匹配，创建 Owner 并消费令牌。
4. 并发认领最多成功一次；失败不会给其他登录者自动授予 Owner。
5. 完成后关闭 Bootstrap 入口并清除可重复使用的初始材料。Setup 重跑不再进入首次认领。

恢复方案在交付时设置：Owner 转交、备用受控管理员、短期恢复授权与审计。不存在硬编码超级管理员邮箱。更改登录策略前验证至少一种可用管理登录路径，防止把所有管理员锁在外面。

## 7. 配置、状态与 Secrets 分层

| 数据 | 内容 | 保存与传播 |
| --- | --- | --- |
| Desired config | 品牌、域名、模块、身份策略、集成模式、预算规则、secretRef | 企业本地配置；不等于可公开配置 |
| Public config | 显示名、Logo、palette、浏览器必需的端点和能力标记 | 从 Desired config 白名单投影 |
| Resource state | 云账号/Zone、资源 ID、Team ID、Entra App Object ID、版本与操作状态 | 实例私有状态；备份，但不进入源码 |
| Secrets | CF Token、SSH 凭据、数据库密码、管理 Key、Entra 凭据、运行 Key | OS 凭据库或受控本地加密存储，部署后写入各服务 Secrets |
| Release manifest | 软件版本、契约、schema、镜像摘要、资源能力和支持矩阵 | 公开发行包；不含任何企业实例数据 |

配置示意仅说明目标结构，**不是当前 Setup 已支持的输入文件**：

```json
{
  "schemaVersion": 1,
  "installationId": "example-prod",
  "brand": { "displayName": "Example Workspace", "paletteId": "<approved-palette-id>" },
  "domains": { "portal": "work.example.com", "serviceRoot": "workspace.example.com" },
  "identity": {
    "emailOtp": { "enabled": true, "allowedDomains": ["example.com"] },
    "entra": { "enabled": false }
  },
  "models": {
    "provider": "litellm",
    "mode": "existing",
    "managementBaseUrl": "https://models.example.net",
    "provisioningSecretRef": "secret://models/provisioning"
  }
}
```

新协议在新仓库从 v1 开始；当前探索性配置同样曾使用 schemaVersion 1，不能直接视为相同协议。新格式增加固定产品 schema 标识，避免误读旧准备文件。新配置采用严格 schema、未知字段报错、模式判别联合；`existing` 不允许混入 SSH 部署字段，`server` 必须有完整主机和存储规划。

Secret 引用不包含秘密值。公开品牌 API 不返回完整 Desired config；浏览器 Setup 输入的秘密只发送给本机安装服务，提交后不回显、不写 localStorage、不进入导出 JSON。仅隐藏输入框不等于完成秘密保护。

本地服务绑定 loopback，校验 Host、Origin 和会话令牌，禁止跨站请求和任意跨源访问。初始化入口使用单次会话建立，之后不把 token 留在 URL。安装器只访问审阅计划中的目标；凭据请求禁止跨主机重定向。私有 LiteLLM 允许显式网络配置，但拒绝云元数据地址和未授权转发目标。

## 8. 执行器与恢复契约

所有适配器实现同一组行为：`inspect`、`plan`、`apply`、`verify`，可选 `compensate`。每个步骤记录逻辑 ID、依赖、输入摘要、预期写入、资源归属、重试策略和检查结果。

步骤状态为 `pending / running / waiting-for-user / succeeded / failed / skipped`。每次安装有独立 run ID；执行中的实例加锁。恢复先 inspect 实际状态，再决定继续，不能把上一次 HTTP 超时直接等同于资源不存在。

配置摘要变化后重新生成计划；新旧计划不同的写入不能混用同一执行确认。已有资源只在 ID、归属和配置都匹配时复用。管理员手工创建的资源可显式导入管理，但不通过名字相似自动认领。

失败处理按对象类型决定：新建无数据资源可补偿，已有数据库、用户文件和服务器目录保留。数据库迁移不承诺自动回滚；必要时从已验证备份恢复。日志记录安全错误码、步骤和 request ID，不保存上游完整响应中的潜在秘密。

## 9. 升级规则

Workspace 升级锁定发行版本，读取兼容矩阵、资源状态与数据库版本；品牌、域名、凭据引用和企业数据保留。开源源码的本地修改必须显示差异，不自动 reset。

Setup 管理的 LiteLLM 有独立版本状态，只有计划明确包含该升级时才升级；接入已有服务只做兼容检查。其 PostgreSQL 升级、应用升级和 Workspace 升级分开编排，不把镜像替换当作数据库升级。

Entra 已有应用原则上复用，改回调或轮换凭据都显示精确差异。更换企业域名属于单独变更计划，需要同步证书、回调、MCP 客户端、邮件链接和客户端实例配置。

每次升级至少经过备份、执行、真实健康检查、版本登记。演练“新建实例 v1 → 产生数据 → 升级 v2 → 故障恢复”，不能只测试空库安装。

## 10. 必须覆盖的验收场景

| 类别 | 场景 | 预期结果 |
| --- | --- | --- |
| LiteLLM 接入 | 错误 Key、缺数据库、缺权限、模型不存在 | 明确失败点，不显示完整接入成功 |
| LiteLLM 服务器 | 端口冲突、架构不支持、磁盘不足、SSH 指纹改变 | 预检阻止写入，原有服务不受影响 |
| Key 初始化 | 请求成功但响应丢失、重复执行、中断恢复 | 无重复有效 Key；孤立 Key 有核对及撤销路径 |
| Key 隔离 | 服务、员工、验收 Key 互相越权 | 越权拒绝，日志不含明文 |
| 预算 | 多 Key 同属团队、预算耗尽、用量同步延迟 | 按选定版本正确约束，UI 清晰显示来源和延迟 |
| Entra | 错租户、错 Client、错回调、过期凭据 | 登录失败且无账号提权 |
| Entra 绑定 | 同名、邮箱前缀相同、邮箱变化、停用人员 | 不错误合并或绕过停用 |
| Bootstrap | 其他白名单员工先登录、并发认领、令牌重放 | 只有指定身份一次成功成为 Owner |
| 本地服务 | 非本机 Origin、跨站请求、重定向到另一主机 | 不执行变更，不发送管理凭据 |
| 部署 | DNS 未生效、证书待签发、Cloudflare 到服务器不通 | 保持验证中/失败，不显示完成 |
| 恢复 | 单机重启、数据库恢复、升级中断 | 数据保留，按实际状态续跑，记录可追溯 |

当前可运行内容仍限于品牌/域名配置与计划导出。以上接口、模式、步骤和验收矩阵是下一阶段实现要求，不代表已执行真实安装或已获得外部系统授权。
