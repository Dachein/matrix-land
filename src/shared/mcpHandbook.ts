export const WORKSPACE_MCP_VERSION = "4.0.3";
export const WORKSPACE_MCP_RELEASED_AT = "2026-10-21";
export const WORKSPACE_MCP_PROTOCOL_VERSION = "2025-06-18";
export const WORKSPACE_MCP_SUPPORTED_PROTOCOL_VERSIONS = [WORKSPACE_MCP_PROTOCOL_VERSION, "2025-03-26"] as const;

export const WORKSPACE_APP_COVER_GUIDANCE = "When creating an App or preparing/submitting it for Hub review without a user-provided or existing cover, unless the user opts out, automatically call tools_image_generation (default gpt-image-2.5-flare), using the App name and purpose, download and resize the result to 600x600, and use its data:image/png|jpeg|webp;base64 representation as coverImageUrl on submission instead of the expiring preview URL.";
export const WORKSPACE_APP_COVER_GUIDANCE_ZH = "创建应用或准备、提交 Hub 审核时，如无用户提供或已有封面且用户未要求跳过，自动调用 tools_image_generation（默认 gpt-image-2.5-flare），结合应用名称和用途生成图片，下载并处理为 600×600，在提交时通过 coverImageUrl 传入图片的 base64 data URL，不使用会过期的预览链接作为正式封面。";

export type McpHandbookGroup = "forum-hub" | "knowledge" | "apps" | "tools";
export type McpHandbookOperation = "read" | "write" | "approval";

export type McpHandbookToolDefinition = {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  title?: string;
};

export type McpHandbookTool = McpHandbookToolDefinition & {
  capabilityPack: string;
  group: McpHandbookGroup;
  operation: McpHandbookOperation;
  version: string;
};

export type McpHandbookFeature = {
  description: string;
  descriptionZh: string;
  id: string;
  title: string;
  titleZh: string;
};

export type McpHandbookRelease = {
  changes: string[];
  changesZh: string[];
  releasedAt: string;
  version: string;
};

export type McpHandbookCapabilityPack = {
  count: number;
  description: string;
  descriptionZh: string;
  group: McpHandbookGroup;
  id: string;
  namespace?: string;
  title: string;
  titleZh: string;
  toolNames: string[];
};

export type McpHandbookPayload = {
  catalogRevision: string;
  capabilityPacks: McpHandbookCapabilityPack[];
  generatedAt: string;
  groups: Array<{ count: number; id: McpHandbookGroup }>;
  latestFeatures: McpHandbookFeature[];
  releases: McpHandbookRelease[];
  server: {
    name: "workspace-pass";
    protocol: "Model Context Protocol";
    protocolVersion: string;
    releasedAt: string;
    version: string;
  };
  summary: {
    approvalTools: number;
    readTools: number;
    toolCount: number;
    writeTools: number;
  };
  tools: McpHandbookTool[];
};

// Kept as release-history data for pre-1.0 catalog comparisons; these command
// ids are internal after the Workspace MCP 1.0 boundary.
const PRE_V1_CAPABILITY_PACKS: Array<
  Omit<McpHandbookCapabilityPack, "count" | "group"> & { group: "forum" | "hub" | "knowledge" | "apps" }
> = [
  {
    id: "forum-discover",
    group: "forum",
    title: "Discover",
    titleZh: "发现",
    description: "Browse categories, search discussions, and read a complete topic before acting.",
    descriptionZh: "浏览分类、检索讨论并读取完整主题，为后续参与建立上下文。",
    toolNames: ["forum_list_categories", "forum_search_topics", "forum_get_topic"]
  },
  {
    id: "forum-participate",
    group: "forum",
    title: "Participate",
    titleZh: "参与",
    description: "Create a topic, upload supporting media (images or files) via URL fetch or the direct binary upload flow, and reply in a discussion.",
    descriptionZh: "创建主题、通过 URL 抓取或二进制直传上传配图/附件，并参与讨论回复。",
    toolNames: ["forum_create_topic", "forum_upload_media", "upload_begin", "upload_finalize", "forum_create_reply"]
  },
  {
    id: "forum-manage",
    group: "forum",
    title: "Manage",
    titleZh: "维护",
    description: "Update a topic that the current user is allowed to manage.",
    descriptionZh: "更新当前用户有权维护的主题。",
    toolNames: ["forum_update_topic"]
  },
  {
    id: "hub-discover",
    group: "hub",
    title: "Discover and consume",
    titleZh: "发现与使用",
    description: "Search Hub listings, inspect Skills, and download an authorized Skill package.",
    descriptionZh: "搜索 Hub 资产、查看 Skill，并下载已授权的 Skill 包。",
    toolNames: ["hub_search", "hub_skills_list", "hub_skill_download"]
  },
  {
    id: "hub-publish",
    group: "hub",
    title: "Publish",
    titleZh: "发布",
    description: "Submit an App or Skill listing to the Hub publication workflow.",
    descriptionZh: "将 App 或 Skill 提交到 Hub 发布流程。",
    toolNames: ["hub_submit_listing"]
  },
  {
    id: "knowledge-consumer",
    group: "knowledge",
    title: "Consumer",
    titleZh: "知识消费者",
    description: "Discover services, read their handbook, retrieve content, search paths and text, and send or track feedback.",
    descriptionZh: "发现知识服务、阅读使用手册、检索内容与路径，并提交或跟踪反馈。",
    toolNames: [
      "knowledge_service_list",
      "knowledge_service_handbook",
      "knowledge_service_search",
      "knowledge_service_grep",
      "knowledge_service_read",
      "knowledge_service_tree",
      "knowledge_service_glob",
      "knowledge_feedback_submit",
      "knowledge_feedback_list_mine",
      "knowledge_feedback_get"
    ]
  },
  {
    id: "knowledge-author",
    group: "knowledge",
    title: "Author",
    titleZh: "知识作者",
    description: "Create and maintain folders and files, manage versions and sharing, and process service feedback.",
    descriptionZh: "创建与维护文件夹和文件、管理版本与分享，并处理知识服务反馈。",
    toolNames: [
      "knowledge_edit_list",
      "knowledge_edit_file_read",
      "knowledge_edit_file_upload",
      "knowledge_edit_file_update",
      "knowledge_edit_file_edit",
      "knowledge_edit_batch",
      "knowledge_edit_folder_create",
      "knowledge_edit_object_rename",
      "knowledge_edit_object_move",
      "knowledge_edit_object_delete",
      "knowledge_edit_object_restore",
      "knowledge_edit_file_versions",
      "knowledge_edit_file_version_restore",
      "knowledge_edit_service_update",
      "knowledge_file_public_share_create",
      "knowledge_file_public_share_get",
      "knowledge_file_public_share_revoke",
      "knowledge_feedback_list",
      "knowledge_feedback_status_update"
    ]
  },
  {
    id: "app-mcp-broker",
    group: "apps",
    title: "App MCP broker",
    titleZh: "App MCP 代理",
    description: "Progressively discover accessible MCP-enabled Apps, list one App's current role-filtered tools, and call a registered tool through the Workspace broker.",
    descriptionZh: "渐进式发现可访问的 MCP App、列出指定 App 按当前角色过滤的工具，并通过 Workspace 代理调用已注册工具。",
    toolNames: ["app_mcp_accessible_list", "app_mcp_tools_list", "app_mcp_tool_call"]
  },
  {
    id: "apps-entry",
    group: "apps",
    title: "Entry",
    titleZh: "入口",
    description: "Inspect existing assets or bootstrap App / Skill workflows. App creation emails its creator office domain allowlist application instructions and copies ai-adoption@example.invalid.",
    descriptionZh: "查看已有资产，或启动 App / Skill 创作流程。创建应用后向创建者发送办公室域名访问白名单申请指引，并抄送 ai-adoption@example.invalid。",
    toolNames: [
      "apps_list_inventory",
      "apps_list_apps",
      "apps_list_skills",
      "apps_create_app",
      "apps_skill_validate",
      "apps_skill_submit"
    ]
  },
  {
    id: "apps-app-definition",
    group: "apps",
    title: "App definition and provisioning",
    titleZh: "App 定义与资源初始化",
    description: "Read the canonical App developer context, follow its readiness and next actions, obtain authentication, organization-directory, people-query, and department-authorization implementation material when required, and monitor or retry provisioning.",
    descriptionZh: "读取统一的 App 开发上下文，依据 readiness 与 nextActions 行动，仅在需要时获取登录、组织架构、人员查询与部门权限实现材料，并监控或重试资源初始化。",
    toolNames: [
      "apps_get_app",
      "apps_update_app_config",
      "apps_get_auth_sdk",
      "apps_get_provisioning_status",
      "apps_retry_provisioning_job"
    ]
  },
  {
    id: "apps-app-resources",
    group: "apps",
    title: "App resources",
    titleZh: "App 资源",
    description: "Manage D1 migrations, environment variables, KV values, R2 objects, and secret declarations.",
    descriptionZh: "管理 D1 Migration、环境变量、KV、R2 对象和 Secret 声明。",
    toolNames: [
      "apps_d1_migrations_apply",
      "apps_d1_migrations_list",
      "apps_d1_schema_get",
      "apps_env_vars_list",
      "apps_env_vars_set",
      "apps_env_vars_delete",
      "apps_kv_keys_list",
      "apps_kv_value_get",
      "apps_kv_value_put",
      "apps_kv_value_delete",
      "apps_r2_objects_list",
      "apps_r2_object_get",
      "apps_r2_object_put",
      "apps_r2_object_delete",
      "apps_secrets_declare",
      "apps_secrets_status"
    ]
  },
  {
    id: "apps-deploy-release",
    group: "apps",
    title: "Deploy and release",
    titleZh: "部署与发布",
    description: "Deploy Pages or Workers, inspect deployments, download the current published source code, and publish or roll back an approved release.",
    descriptionZh: "部署 Pages 或 Worker、检查部署记录、下载当前已发布源码，并发布或回滚已确认的版本。",
    toolNames: [
      "apps_pages_deploy",
      "apps_worker_deploy",
      "apps_deployments_list",
      "apps_deployments_get",
      "apps_download_current_source_code",
      "apps_deployments_publish",
      "apps_deployments_rollback"
    ]
  },
  {
    id: "apps-skill-maintenance",
    group: "apps",
    title: "Skill maintenance",
    titleZh: "Skill 维护",
    description: "Read an existing Skill and submit a maintained version.",
    descriptionZh: "读取已有 Skill，并提交维护后的版本。",
    toolNames: ["apps_get_skill", "apps_skill_update"]
  }
];

const CAPABILITY_PACKS: Array<Omit<McpHandbookCapabilityPack, "count">> = [
  {
    id: "forum",
    group: "forum-hub",
    title: "Forum",
    titleZh: "社区",
    description: "Read discussions, participate, and manage media through three action-oriented tools.",
    descriptionZh: "通过三个 action 化工具阅读讨论、参与社区并管理媒体。",
    toolNames: ["forum_read", "forum_write", "forum_media"]
  },
  {
    id: "hub",
    group: "forum-hub",
    title: "Hub",
    titleZh: "资产中心",
    description: "Search assets and download authorized Skills.",
    descriptionZh: "检索资产并下载已授权 Skill。",
    toolNames: ["hub_search", "hub_skill_download"]
  },
  {
    id: "knowledge-query",
    group: "knowledge",
    title: "Knowledge query",
    titleZh: "知识检索",
    description: "Discover readable Knowledge folders, query their content, and inspect optional service guidance.",
    descriptionZh: "发现可读知识库文件夹、检索内容，并查看可选的服务说明。",
    toolNames: [
      "knowledge_list",
      "knowledge_service_handbook",
      "knowledge_query",
      "knowledge_file_read",
      "knowledge_file_versions",
      "knowledge_feedback_submit",
      "knowledge_feedback_read"
    ]
  },
  {
    id: "knowledge-authoring",
    group: "knowledge",
    title: "Knowledge authoring",
    titleZh: "知识维护",
    description: "Read and maintain library objects, routing Cards, public links, and managed feedback. Upload audio by sourceUrl from an operator-approved HTTPS storage host without passing audio bytes through the model. Text patches require one-file unified diff with numbered hunks and matching line counts.",
    descriptionZh: "读取和维护知识库对象、路由 Card、公开链接与受管反馈。通过 sourceUrl 从管理员允许的 HTTPS 存储主机导入音频，无需把音频字节传给模型。文本补丁须使用带行号、行数匹配的单文件 unified diff。",
    toolNames: [
      "knowledge_library_write",
      "knowledge_library_delete",
      "knowledge_service_update",
      "knowledge_share",
      "knowledge_feedback_manage"
    ]
  },
  {
    id: "apps-app-mcp",
    group: "apps",
    title: "APPS App MCP",
    titleZh: "APPS App MCP",
    description: "Discover and call the MCP tools exposed by APPS Apps that this user is allowed to access.",
    descriptionZh: "发现并调用当前用户有权限访问的 APPS App 所暴露的 MCP 工具。",
    toolNames: ["app_mcp_accessible_list", "app_mcp_tools_list", "app_mcp_tool_call"]
  },
  {
    id: "mate-mail",
    group: "apps",
    title: "Default mailbox",
    titleZh: "默认邮箱",
    description: "Read incoming mail and attachments and organize the authenticated user's default Mate mailbox.",
    descriptionZh: "读取当前用户默认 Mate 邮箱的来信、附件，并管理已读、标签和归档状态。",
    toolNames: ["mail_list", "mail_get", "mail_get_attachment", "mail_update", "mail_send", "mail_reply"]
  },
  {
    id: "mate-runtime",
    group: "apps",
    title: "Mate management",
    titleZh: "Mate 管理",
    description: "Create and maintain Mates, review and publish immutable definitions, and invoke current-user Tasks.",
    descriptionZh: "创建和维护 Mate，评审并发布不可变定义，以及调用当前用户的 Task。",
    toolNames: ["mate_builder_read", "mate_builder_write", "mate_call"]
  },
  {
    id: "apps-build",
    group: "apps",
    title: "Build and configure",
    titleZh: "构建与配置",
    description: "Inspect inventory, develop Apps and Skills, provision resources, and manage data and configuration. " + WORKSPACE_APP_COVER_GUIDANCE,
    descriptionZh: "查看资产、开发 App 与 Skill、初始化资源并管理数据和配置。Mate 定义由独立能力包维护。" + WORKSPACE_APP_COVER_GUIDANCE_ZH,
    toolNames: [
      "apps_inventory",
      "apps_app_read",
      "apps_app_write",
      "apps_provisioning",
      "apps_database",
      "apps_config",
      "apps_storage",
      "apps_skill_read",
      "apps_skill_write"
    ]
  },
  {
    id: "apps-release",
    group: "apps",
    title: "Deploy and release",
    titleZh: "部署与发布",
    description: "Prepare ready, unpublished deployments, inspect status, and publish or roll back after explicit approval. " + WORKSPACE_APP_COVER_GUIDANCE,
    descriptionZh: "准备 ready 但未发布的部署、检查状态，并在明确批准后发布或回滚。" + WORKSPACE_APP_COVER_GUIDANCE_ZH,
    toolNames: ["apps_deploy_prepare", "apps_deployment_read", "apps_deployment_release", "apps_deployment_submit_listing"]
  },
  {
    id: "models",
    group: "tools",
    namespace: "models",
    title: "Models",
    titleZh: "模型",
    description: "List available gateway models with context limits, pricing, and tri-state capability and endpoint support.",
    descriptionZh: "列出可用网关模型及其上下文上限、价格，以及三态的能力与端点支持。",
    toolNames: ["models_list"]
  },
  {
    id: "tools-audio",
    group: "tools",
    namespace: "tools/audio",
    title: "Audio",
    titleZh: "音频",
    description: "Transcribe audio with ASR or generate speech with MiniMax Speech 2.8 Turbo.",
    descriptionZh: "使用 ASR 转录音频，或通过 MiniMax Speech 2.8 Turbo 生成语音。",
    toolNames: ["tools_audio_asr", "tools_audio_tts"]
  },
  {
    id: "tools-image",
    group: "tools",
    namespace: "tools/image",
    title: "Image",
    titleZh: "图片",
    description: "Generate or edit images through Cloudflare using GPT Image 2.5 Flare (default) or Sunburst, with up to sixteen references and PNG/WebP/JPEG output.",
    descriptionZh: "通过 Cloudflare 使用 GPT Image 2.5 Flare（默认）或 Sunburst 生成和编辑图片，支持最多十六张参考图及 PNG、WebP、JPEG 输出。",
    toolNames: ["tools_image_generation"]
  },
  {
    id: "tools-web",
    group: "tools",
    namespace: "tools/web",
    title: "Web",
    titleZh: "网页",
    description: "Search the public web with Exa through Cloudflare credits and read public webpages or PDFs.",
    descriptionZh: "通过 Cloudflare credits 使用 Exa 搜索公开网页，并读取公开网页或 PDF。",
    toolNames: ["tools_web_search", "tools_web_reader"]
  },
  {
    id: "tools-video",
    group: "tools",
    namespace: "tools/video",
    title: "Video",
    titleZh: "视频",
    description: "Generate video through the shared MCP Worker.",
    descriptionZh: "通过公共 MCP Worker 生成视频。",
    toolNames: ["tools_video_generation"]
  },
  {
    id: "tools-jev",
    group: "tools",
    namespace: "tools/jev",
    title: "JEV",
    titleZh: "JEV",
    description: "Evaluate structured state with JEV.",
    descriptionZh: "使用 JEV 评估结构化状态。",
    toolNames: ["tools_jev"]
  }
];

const INSTALLATION_CHECK_TOOL_NAMES = new Set(["ping_who_am_i"]);

export const WORKSPACE_MCP_LATEST_FEATURES: McpHandbookFeature[] = [
  {id:"unified-app-mail",title:"Unified app mail resources",titleZh:"统一应用邮箱资源",description:"One APPS mailbox provides send/receive access, the current Mail SDK and optional signed new-mail Triggers through the canonical app developer context.",descriptionZh:"APPS 一次开通应用邮箱的收发能力，通过开发上下文获取最新 Mail SDK、完整用法和可选的新邮件 Trigger。"},
  {
    id: "default-agent-mailbox",
    title: "Default Agent mailbox",
    titleZh: "默认 Agent 邮箱",
    description: "Desktop clients and your default Mate share incoming mail, attachments and labels. Basic user info includes the Agent name and email, or null before activation.",
    descriptionZh: "桌面客户端与默认 Mate 共用来信、附件和标签。用户基本信息包含 Agent 名字和邮箱，未开通时返回 null。"
  },
  {
    id: "department-only-presentation", title: "Department-based access labels", titleZh: "部门与成员授权展示",
    description: "APPS developer context describes targeted access as Selected members. Portal people profiles show their department path without a default Team suffix.",
    descriptionZh: "APPS 开发上下文将定向授权标为指定成员可见；Portal 人员资料仅展示部门路径，不再追加默认团队。"
  },
  {
    id: "current-directory-identity", title: "Current directory identity", titleZh: "现行目录身份",
    description: "Existing Workspace MCP connections follow current department, email and role assignments on every request. Disabled or missing users cannot reuse old identity claims.",
    descriptionZh: "已有 Workspace MCP 连接在每次请求中跟随现行部门、邮箱和角色；停用或缺失用户无法复用旧身份授权。"
  },
  {
    id: "mate-work-threads", title: "Continuous Mate work", titleZh: "Mate 连续工作往来",
    description: "Mail and Mate Call share a stable work Thread. Continue and query by Mate Call ID, collect scheduled execution receipts, and send saved receipts without rerunning work.",
    descriptionZh: "邮件与 Mate Call 共享稳定工作往来，可用 Mate Call ID 继续指派和查询，汇总定时执行回执，并发送已保存回执而不重新执行。"
  },
  {
    id: "exa-public-web-search", title: "Exa financial research", titleZh: "Exa 金融资料检索",
    description: "tools_web_search uses Exa via Cloudflare credits. Mate prefers Exa for financial research while retaining Luna hosted search for other public web queries.",
    descriptionZh: "tools_web_search 通过 Cloudflare credits 调用 Exa。Mate 金融资料检索优先使用 Exa，其他公开联网问题保留 Luna 托管搜索。"
  },
  {
    id: "knowledge-list-discovery",
    title: "Knowledge base overview",
    titleZh: "知识库总览",
    description: "knowledge_list returns all Knowledge folders readable under the current user's ACL, including folders without an enabled service, while retaining active service cards for existing clients.",
    descriptionZh: "knowledge_list 按当前用户 ACL 返回可读知识库文件夹，包括未开启服务的文件夹，并保留已启用服务卡片供既有客户端使用。"
  },
  {
    id: "personal-mate-creation-profile",
    title: "Shared personal Mate profile",
    titleZh: "统一的个人 Mate 配置",
    description: "Agent creation can select the same server-owned Runtime capability defaults as Web and miniapp personal Mate creation with creationProfile=personal_mate.",
    descriptionZh: "Agent 创建可用 creationProfile=personal_mate 选用与 Web、小程序相同的服务端 Runtime 能力默认配置。"
  },
  {
    id: "ai-resources-direct-tools",
    title: "AI resource packs",
    titleZh: "AI 资源分类",
    description: "AI resources expose directly callable tools_* names and models_list. Audio includes ASR and MiniMax TTS.",
    descriptionZh: "AI 资源直接公开可调用的 tools_* 工具与 models_list。音频分类包含 ASR 和 MiniMax TTS。"
  },
  {
    id: "gateway-model-catalog",
    title: "Gateway model catalog",
    titleZh: "网关模型目录",
    description: "models_list publishes the available gateway models with context limits, pricing, and tri-state capability support; an undeclared capability stays unknown instead of being reported as unsupported.",
    descriptionZh: "models_list 公布可用网关模型及其上下文上限、价格和三态能力支持；未声明能力保持 unknown，绝不被报为不支持。"
  },
  {
    id: "dynamic-current-user-workspace-pass-mcp",
    title: "Dynamic current-user Workspace MCP",
    titleZh: "动态当前用户 Workspace MCP",
    description: "Mate Releases can resolve the invoking user's complete authorized APPS and Knowledge tool surface at Task time, without snapshotting every App token; writes still require exact, single-use approval.",
    descriptionZh: "Mate Release 可在 Task 执行时动态解析调用用户完整的已授权 APPS 与 Knowledge 工具面，无需快照保存每个 App Token；写入仍要求精确、单次有效审批。"
  },
  {
    id: "mate-folder-editing",
    title: "Scoped Mate folder editing",
    titleZh: "Mate 文件夹范围编辑",
    description: "Mate Releases can bind editable folders independently from Knowledge Service reading while every write remains limited by the invoking user's current ACL and explicit approval.",
    descriptionZh: "Mate Release 可独立绑定可编辑文件夹与知识库读取；每次写入仍受调用用户当前 ACL 与显式审批限制。"
  },
  {
    id: "release-safe-apps-build-guidance",
    title: "Release-safe APPS build guidance",
    titleZh: "安全一致的 APPS 构建指引",
    description: "APPS developer context now standardizes cross-platform ESM paths, single-source release versions, concise notes, version-controlled migrations, and the ready-before-publish boundary.",
    descriptionZh: "APPS 开发上下文现已统一跨平台 ESM 路径、单一版本来源、精简发布说明、受版本控制的迁移，以及 ready 后再发布的边界。"
  },
  {
    id: "mate-runtime-v1",
    title: "Mate Runtime V1",
    titleZh: "Mate Runtime V1",
    description: "Create, review, publish, roll back, and invoke shared-runtime Mates while every Task remains bound to the current Workspace user.",
    descriptionZh: "在共享 Runtime 上创建、评审、发布、回滚和调用 Mate，同时每个 Task 始终绑定当前 Workspace 用户。"
  },
  {
    id: "workspace-pass-compact-surface",
    title: "Workspace MCP compact connector surface",
    titleZh: "Workspace MCP 紧凑连接器工具面",
    description: "Related operations now share action-oriented public tools, while App and Publication capabilities use progressive discovery instead of expanding the first-level catalog.",
    descriptionZh: "相关操作通过 action 化公共工具合并；App 与 Publication 能力采用渐进发现，不再扩张一级目录。"
  },
  {
    id: "same-zone-app-mcp-routing",
    title: "Same-zone App MCP routing",
    titleZh: "同 Zone App MCP 路由",
    description: "The Workspace MCP Worker routes App custom-domain fetches through Cloudflare's public front door so same-zone Web, Automation, and Container Workers reach their registered runtime instead of an origin fallback.",
    descriptionZh: "Workspace MCP Worker 通过 Cloudflare 公开前门路由 App 自定义域名请求，使同 Zone 的 Web、Automation 与 Container Worker 到达已注册 Runtime，而不是回退到源站。"
  },
  {
    id: "configurable-app-resource-token-header",
    title: "Configurable App Resource Token header",
    titleZh: "可配置的 App Resource Token 请求头",
    description: "Published App MCP manifests may opt into X-Workspace-Resource-Token when a hosting edge consumes Authorization; the App still converts it in memory and performs the official SDK's complete token and role validation.",
    descriptionZh: "已发布的 App MCP Manifest 可在托管边缘消耗 Authorization 时选择 X-Workspace-Resource-Token；App 仍在内存中转换，并通过官方 SDK 完成全部 Token 与角色校验。"
  },
  {
    id: "capability-based-app-mcp",
    title: "Capability-based App MCP",
    titleZh: "能力化 App MCP",
    description: "Web, Automation, and Container apps can opt into governed App MCP while Agent apps require it; registration remains bound to an immutable published Manifest and current access targets.",
    descriptionZh: "Web、Automation 与 Container App 可选择启用受控 App MCP，Agent App 则必须启用；注册仍绑定不可变的已发布 Manifest 与当前访问目标。"
  },
  {
    id: "current-deployed-source-code",
    title: "Current deployed source code",
    titleZh: "当前部署源码",
    description: "A read-only APPS tool downloads only the immutable source snapshot linked to the currently published production deployment, with integrity hashes and no historical fallback.",
    descriptionZh: "只读 APPS 工具仅下载当前已发布生产部署所绑定的不可变源码快照，附带完整性哈希，且不会回退到历史快照。"
  },
  {
    id: "app-mcp-rbac",
    title: "Progressive App MCP RBAC",
    titleZh: "渐进式 App MCP RBAC",
    description: "A fixed three-tool broker discovers only published App manifests, then rechecks central Resource policy and the App's current local role before every registered call.",
    descriptionZh: "固定三工具代理只发现已发布的 App Manifest，并在每次注册调用前重新核验中心 Resource 策略与 App 当前本地角色。"
  },
  {
    id: "connection-verification",
    title: "Post-install connection verification",
    titleZh: "安装后连接验证",
    description: "Use ping_who_am_i first after setup and whenever guided use, connection, authentication, CLI upgrade, or reinstall behaves unexpectedly. It returns credential-safe checks and the required recovery action.",
    descriptionZh: "安装后，以及使用引导、连接、认证、CLI 升级或重装出现异常时，优先调用 ping_who_am_i；它会在不暴露凭据的前提下返回检查结果和必要的恢复操作。"
  },
  {
    id: "oauth-only-clients",
    title: "One-command CLI connections",
    titleZh: "全客户端一次 CLI 连接",
    description: "WorkBuddy, Claude Code, Codex, and Cursor use one Workspace CLI command for OAuth + PKCE, local stdio configuration, automatic refresh, and a seven-day sliding idle window.",
    descriptionZh: "WorkBuddy、Claude Code、Codex 和 Cursor 统一通过一条 Workspace CLI 命令完成 OAuth + PKCE、本地 stdio 配置、自动刷新与 7 天滑动闲置窗口。"
  },
  {
    id: "domain-workflow-map",
    title: "Domain and workflow map",
    titleZh: "领域与工作流地图",
    description: "Standard platform tools are organized into Forum, Hub, Knowledge, and APPS capability packs with recommended workflow stages.",
    descriptionZh: "标准平台工具按 Forum、Hub、Knowledge 和 APPS 能力包及推荐工作流阶段组织。"
  },
  {
    id: "structured-error-handoff",
    title: "Structured error handoff",
    titleZh: "结构化错误与 Handoff",
    description: "Actionable failures use workspace.mcp.error.v1 with complete findings, retry guidance, and the next recommended tool call.",
    descriptionZh: "可执行错误使用 workspace.mcp.error.v1，返回完整 findings、重试指引和推荐的下一步工具调用。"
  },
  {
    id: "app-session-sdk",
    title: "Official App Session SDK",
    titleZh: "官方 App Session SDK",
    description: "Login-required APPS Apps can request the pinned @frontier-workspace/auth package plus app-specific login, directory, department authorization, and unified local/system App-role guidance.",
    descriptionZh: "需要登录的 APPS App 可以获取固定版本的 @frontier-workspace/auth，以及 App 专用的登录、目录、部门权限与本地/系统角色统一解析指引。"
  },
  {
    id: "artifact-backed-apps-release",
    title: "Artifact-backed APPS release",
    titleZh: "基于制品的 APPS 发布",
    description: "Workspace CLI separates Worker modules from browser assets, rejects invalid Static Assets layouts, and creates immutable deployment artifacts; MCP revalidates the artifact before creating a ready deployment.",
    descriptionZh: "Workspace CLI 分离 Worker 模块与浏览器资源、拒绝无效的 Static Assets 布局并创建不可变部署制品；MCP 在创建 ready 部署前再次校验制品。"
  },
  {
    id: "governed-data-migrations",
    title: "Governed APPS data migrations",
    titleZh: "受控 APPS 数据迁移",
    description: "APPS D1 migrations use token validation, App-prefixed schema and data objects, transactional batches, content hashes, explicit opt-in, and user approval.",
    descriptionZh: "APPS D1 migration 使用 token 校验、App 前缀限定的 Schema 与数据对象、事务批次、内容哈希、显式启用和用户批准。"
  },
  {
    id: "generic-binary-upload",
    title: "Generic binary upload",
    titleZh: "通用二进制上传",
    description: "Forum media supports URL fetches and a begin/upload/finalize flow without base64 crossing the MCP boundary; uploaded files can be appended or used to replace standalone topic attachments through forum_write update_topic.",
    descriptionZh: "Forum 媒体支持 URL 抓取和 begin/upload/finalize 流程，无需让 base64 穿过 MCP 边界；上传后的文件可通过 forum_write update_topic 追加或替换主题独立附件。"
  },
  {
    id: "stable-catalog-loading",
    title: "Stable catalog loading",
    titleZh: "稳定目录加载",
    description: "Workflow stages are documentation guidance only. Advertised platform tools load together, while every call remains protected by server-side authorization.",
    descriptionZh: "工作流阶段仅用于文档导航；已公布的平台工具会整体加载，每次调用仍由服务端鉴权保护。"
  }
];

export const WORKSPACE_MCP_RELEASES: McpHandbookRelease[] = [
  {
    version: "4.0.3", releasedAt: "2026-10-21",
    changes: ["Separate platform rollout from Mate and App lifecycle operations; retire production fixture restoration migrations and remove the configured production acceptance identity. Public MCP tool schemas remain unchanged."],
    changesZh: ["平台发布与 Mate、App 生命周期操作分离；归档生产验收对象恢复迁移，移除生产验收身份配置。公开 MCP 工具结构保持不变。"]
  },
  {
    version: "4.0.2", releasedAt: "2026-10-20",
    changes: ["Add Portal Owner handovers for APPS Apps and Skills with recipient acceptance, permission-checked administrator transfers, atomic decision/audit records and durable Auth/MCP ownership synchronization; preserve the public MCP tool catalog and scopes."],
    changesZh: ["为 APPS Apps 和 Skills 增加网页 Owner 交接：接收人确认、有权限的管理员手动转移、原子交接与操作记录，以及持久化的 Auth/MCP 权限同步；公开 MCP 工具目录和权限范围保持兼容。"]
  },
  {
    version: "4.0.1", releasedAt: "2026-10-19",
    changes: ["Add App creation and Hub submission guidance to automatically generate missing covers with tools_image_generation, resize to 600x600 and submit a durable base64 cover instead of an expiring preview URL; retain supplied/existing covers and user opt-outs."],
    changesZh: ["在应用创建和 Hub 提交指引中加入缺失封面自动生成流程：调用 tools_image_generation、处理为 600×600，并提交持久化 base64 封面而非临时预览链接；保留用户提供或已有封面及跳过要求。"]
  },
  {
    version: "4.0.0", releasedAt: "2026-10-19",
    changes: ["Switch tools_image_generation to GPT Image 2.5 Flare (default) and Sunburst through Cloudflare; replace Lucid/Klein selections and seed with sixteen-reference editing, native quality controls and PNG/WebP/JPEG output, preserving private seven-day artifacts."],
    changesZh: ["tools_image_generation 改用 Cloudflare 的 GPT Image 2.5 Flare（默认）和 Sunburst；替换 Lucid/Klein 选项并移除 seed，支持十六张参考图编辑、原生质量选项及 PNG/WebP/JPEG 输出，保留七天私有产物。"]
  },
  {
    version: "3.14.1", releasedAt: "2026-10-19",
    changes: ["Replaced the unavailable Image2.5 upstream with Lucid Origin for design and FLUX.2 Klein 9B for creative images; added model selection and private storage of native image bytes."],
    changesZh: ["将不可用的 Image2.5 上游替换为用于设计稿的 Lucid Origin 和用于创意配图的 FLUX.2 Klein 9B，新增模型选择并将原生图片数据保存为私有产物。"]
  },
  {version:"3.14.0",releasedAt:"2026-10-18",changes:["Promote mail.md to a versioned Mate document alongside Soul and Handbook, shared by the builder and Runtime.","Expose mail in mate_builder_write(core_update) and core_review, with revision checks, immutable previews, publication and rollback."],changesZh:["将 mail.md 升级为与 Soul、Handbook 同级的版本文档，页面与 Runtime 统一读取。","通过 mate_builder_write(core_update) 的 mail 字段和 core_review 读写，支持版本校验、不可变预览、发布与回滚。"]},
  {version:"3.13.0",releasedAt:"2026-10-18",changes:["Add apps_app_read(mail_sdk) with the current Workspace Mail SDK, complete app-specific usage, signed Trigger examples and development Prompt.","Create and configure one application mailbox using emailEnabled/emailPrefix; emailTriggerEnabled controls new-mail delivery. Workspace MCP lists Workspace Mail SDK beside Auth SDK."],changesZh:["新增 apps_app_read(mail_sdk)，提供当前 Workspace Mail SDK、应用专属完整用法、签名 Trigger 示例与开发 Prompt。","通过 emailEnabled/emailPrefix 统一创建和设置应用邮箱，emailTriggerEnabled 控制新邮件通知；Workspace MCP 将 Mail SDK 与 Auth SDK 并列展示。"]},
  {version:"3.12.0",releasedAt:"2026-10-17",changes:["Unified mailbox reads and explicit-consent sending through workspace-mail-worker with independent private R2 storage.","Added versioned Inbox Prompt decisions, durable email-to-Task intake and optional result replies."],changesZh:["通过 workspace-mail-worker 统一邮件读取和独立授权的发信，并使用独立私有 R2 存储。","新增随 Release 发布的 Inbox Prompt、持久化邮件任务触发和可选结果回复。"]},
  { version: "3.11.0", releasedAt: "2026-10-17",
    changes: ["Add four default-mailbox tools for desktop clients and the owner’s Mate, with private incoming-mail storage, attachment downloads, explicit mail scopes and versioned metadata updates. Auth basic info and ping_who_am_i include the current default Agent name/email or null."],
    changesZh: ["新增四个默认邮箱工具，供桌面客户端和本人的 Mate 使用，支持私有来信存储、附件下载、独立邮件授权与带版本校验的状态更新；Auth 基本信息及 ping_who_am_i 返回当前默认 Agent 名字、邮箱，未开通时为 null。"] },
  { version: "3.10.4", releasedAt: "2026-10-14",
    changes: ["Validate one-file numbered unified patches consistently before Mate approval and Knowledge execution; preserve exact-match edits, correct empty-range insertions, and retain specific write error codes and request identifiers in Mate results."],
    changesZh: ["Mate 审批前与知识库执行时统一校验带行号的单文件 unified diff；保留精确匹配约束，修正空区间插入位置，并在 Mate 执行结果中保留具体写入错误码与请求编号。"] },
  { version: "3.10.3", releasedAt: "2026-10-13",
    changes: ["Encode identity path segments consistently when storing and previewing generated media, supporting legacy email and special-character user IDs while preserving existing safe paths and authorization identities."],
    changesZh: ["生成媒体的存储与预览链接统一编码身份路径段，兼容历史邮箱及特殊字符用户 ID，保留既有安全路径和授权身份。"] },
  { version: "3.10.2", releasedAt: "2026-10-13",
    changes: ["Label targeted APPS access as Selected members in developer context; align Portal profiles and access labels with department-based identity without changing authorization IDs or scopes."],
    changesZh: ["APPS 开发上下文将定向授权标为指定成员可见；Portal 资料与授权文案统一采用部门身份展示，不改变授权 ID 或范围。"] },
  { version: "3.10.1", releasedAt: "2026-10-13",
    changes: ["Resolve each Workspace MCP request against the current Auth identity so existing connections follow department migrations, email changes and role changes; reject inactive or missing users without reusing stale token identity claims."],
    changesZh: ["每次 Workspace MCP 请求均使用现行 Auth 身份，已有连接自动跟随部门迁移、邮箱与角色变更；停用或缺失用户无法继续使用旧令牌身份授权。"] },
  { version: '3.10.0', releasedAt: '2026-10-12',
    changes: ['Add sourceUrl audio import to knowledge_library_write upload, streaming into Knowledge with current-user folder authorization and operator-approved download hosts.'],
    changesZh: ['knowledge_library_write 的 upload 支持 sourceUrl 音频导入，按当前用户目录权限流式写入知识库，仅允许管理员配置的下载域名。'] },
  {
    version: "3.9.2",
    releasedAt: "2026-10-10",
    changes: [
      "Separate MCP forum, publication and service clients from command dispatch while preserving public tool names and schemas.",
      "Separate Knowledge persistence, mutations, services, permissions, indexing and queries; recover interrupted index dispatches after five minutes.",
      "Protect ZIP retry staging and cleanup ownership, and correctly update descendants of folders whose names contain supplementary Unicode characters.",
      "Make Knowledge grant revocation, share rotation and Owner transfer atomic; preserve Owner links during collaborator replacement and revoke demoted collaborators' links.",
      "Reject resource-token requests without a usable service credential and omit raw internal failure details from HTTP responses and Knowledge index status."
    ],
    changesZh: [
      "将 MCP 论坛、市场和服务调用模块从命令分发中拆出，保持公开工具名称与结构兼容。",
      "拆分 Knowledge 持久化、变更、服务、权限、索引和查询，恢复中断超过五分钟的索引发送任务。",
      "保护 ZIP 重试的暂存与清理所有权，正确更新名称含补充 Unicode 字符的目录后代。",
      "确保 Knowledge 授权撤销、分享链接轮换和 Owner 转移原子执行；替换协作者时保留 Owner 链接，并撤销降权协作者的链接。",
      "拒绝未携带可用服务凭证的资源令牌请求，并从 HTTP 响应和 Knowledge 索引状态中移除原始内部错误详情。"
    ]
  },
  {
    version: "3.9.1",
    releasedAt: "2026-10-10",
    changes: ["Separate MCP command schemas by domain without changing tool names, schemas, order, or authorization.", "Correct production deployment selection for bundled cross-module source changes."],
    changesZh: ["按业务域分离 MCP 命令定义，保持工具名称、结构、顺序与授权规则兼容。", "修正跨模块源码变更的生产部署选择。"]
  },
  {
    version: "3.9.0",
    releasedAt: "2026-10-09",
    changes: ["mate_call supports stable threadId and mateCallId for cross-channel continuity, paginated Threads and saved receipt delivery. Non-blocking calls execute through a durable runner and preserve the full instruction."],
    changesZh: ["mate_call 支持用稳定 threadId 和 mateCallId 跨邮件与 Agent 持续往来、分页查询及发送已保存回执。非阻塞调用由持久运行器执行，并完整保留任务指令。"]
  },
  {
    version: "3.8.1",
    releasedAt: "2026-10-08",
    changes: ["tools_audio_asr uses Whisper Large V3 Turbo with base64 audio, optional language and initialPrompt, and detected language from transcription_info. Existing audioUrl-only calls retain automatic language detection."],
    changesZh: ["tools_audio_asr 升级为 Whisper Large V3 Turbo，使用 base64 音频，支持可选 language 与 initialPrompt，并返回 transcription_info 中的识别语言。仅传 audioUrl 的旧调用继续自动识别语言。"]
  },
  {
    version: "3.8.0",
    releasedAt: "2026-10-08",
    changes: ["tools_web_search now uses Exa through Cloudflare AI Gateway credits, adds searchProvider=exa, and reports search failures without an OpenAI model fallback. Mate retains hosted Luna search and prefers Exa for financial research under the existing Web capability."],
    changesZh: ["tools_web_search 通过 Cloudflare AI Gateway credits 调用 Exa，新增 searchProvider=exa，并直接报告搜索失败，不再回退到 OpenAI 模型。Mate 保留 Luna 托管搜索，在既有网页权限下优先使用 Exa 进行金融研究。"]
  },
  {
    version: "3.7.2",
    releasedAt: "2026-10-07",
    changes: ["Hub submissions retain current accelerated cover images and omitted existing covers, reject stale or cross-asset internal image URLs, and map legacy company visibility to org."],
    changesZh: ["Hub 提交保留当前加速封面和未传入的已有封面，拒绝过期或其他对象的内部图片地址，并将旧 company 可见范围映射为 org。"]
  },
  {
    version: "3.7.1",
    releasedAt: "2026-10-07",
    changes: ["Corrected the IT forwarding address in APPS app creation emails to it@example.invalid for office domain allowlist requests."],
    changesZh: ["修正 APPS 应用创建邮件中的 IT 转发邮箱为 it@example.invalid，用于申请办公室域名访问白名单。"]
  },
  {
    version: "3.7.0",
    releasedAt: "2026-10-05",
    changes: ["APPS app creation emails now copy ai-adoption@example.invalid while retaining the authenticated creator as the primary recipient."],
    changesZh: ["APPS 应用创建通知保持已认证的创建者为主收件人，并统一抄送 ai-adoption@example.invalid。"]
  },
  {
    version: "3.6.1",
    releasedAt: "2026-10-05",
    changes: ["Restored the private synthetic APPS source-snapshot acceptance app and its dedicated ownership so production release verification can complete after fixture drift."],
    changesZh: ["恢复专用的私有 APPS 源码快照验收应用及其验收身份归属，使测试数据偏移后的生产发布验证能够完成。"]
  },
  {
    version: "3.6.0",
    releasedAt: "2026-10-05",
    changes: [
      "APPS app creation now emails the authenticated creator a Frontier Workspace notification with the app domain and office access allowlist application instructions; forward the email to it@example.invalid and select all offices or individual locations."
    ],
    changesZh: [
      "创建 APPS 应用后，自动向已认证的创建者发送 Frontier Workspace 通知，包含应用域名及办公室访问白名单申请指引；转发至 it@example.invalid，并选择全部开通或具体职场。"
    ]
  },
  {
    version: "3.5.2",
    releasedAt: "2026-09-30",
    changes: [
      "Forwarded Mate Runtime's existing Auth service credential through its authenticated MCP Knowledge bridge to restore current-user folder reads without provisioning a new MCP secret."
    ],
    changesZh: [
      "Mate Runtime 通过已认证的 MCP 知识库桥接传递现有 Auth 服务凭据，无需为 MCP 新增密钥即可恢复按当前用户权限读取文件夹。"
    ]
  },
  {
    version: "3.5.1",
    releasedAt: "2026-09-30",
    changes: [
      "Fixed current-user Knowledge resource token minting for service-authenticated Mate calls without an OAuth connection ID."
    ],
    changesZh: [
      "修复 Mate 经服务认证调用知识库时没有 OAuth 连接 ID 导致的当前用户资源令牌签发失败。"
    ]
  },
  {
    version: "3.5.0",
    releasedAt: "2026-09-29",
    changes: [
      "Separated file reads from Knowledge queries, renamed the service guide tool to knowledge_service_handbook, and replaced knowledge_library_read with direct file and version tools."
    ],
    changesZh: [
      "将文件读取从知识检索中独立，服务指南工具改名为 knowledge_service_handbook，并以直接的文件读取和版本工具替代 knowledge_library_read。"
    ]
  },
  {
    version: "3.4.0",
    releasedAt: "2026-09-29",
    changes: [
      "Knowledge list, file read, text search, and grep now work from the current user's folder ACL without requiring an enabled Knowledge Service; service Handbook and indexed queries remain available."
    ],
    changesZh: [
      "知识库列举、文件读取、文本搜索与精确匹配按当前用户文件夹 ACL 使用，无需启用知识服务；服务 Handbook 与索引检索继续可用。"
    ]
  },
  {
    version: "3.3.1",
    releasedAt: "2026-09-28",
    changes: ["Removed the obsolete shared App runtime and its compatibility paths."],
    changesZh: ["移除已退役的共享 App 运行时及其兼容路径。"]
  },
  {
    version: "3.3.0",
    releasedAt: "2026-09-28",
    changes: ["Retired the old shared App runtime, provisioning, and publication paths."],
    changesZh: ["退役旧版共享 App 运行时、资源开通与发布路径。"]
  },
  {
    version: "3.2.0",
    releasedAt: "2026-09-27",
    changes: [
      "Added the read-only knowledge_list tool for direct discovery of visible Agent-enabled Knowledge Service cards.",
      "Kept knowledge_service_read(action=list) available for existing clients; use knowledge_list as the first discovery step."
    ],
    changesZh: [
      "新增只读 knowledge_list 工具，可直接发现当前用户可见的 Agent 知识服务卡片。",
      "保留 knowledge_service_read(action=list) 兼容既有客户端；建议先调用 knowledge_list 发现知识库。"
    ]
  },
  {
    version: "3.1.0",
    releasedAt: "2026-09-26",
    changes: ["Added the personal_mate creation profile to Mate Builder so Agent-created personal Mates share Web and miniapp Runtime defaults; exposed mcpCapacity in the forwarded create schema."],
    changesZh: ["为 Mate Builder 增加 personal_mate 创建配置，让 Agent 创建的个人 Mate 与 Web、小程序共用 Runtime 默认值；在转发的创建 schema 中公开 mcpCapacity。"]
  },
  {
    version: "3.0.1",
    releasedAt: "2026-09-25",
    changes: ["Remove the fixed-binding limit from dynamic all-writable-folder scopes while preserving current-user ACL and content-only restrictions."],
    changesZh: ["移除动态全部可写文件夹范围的固定绑定数量上限，同时保留调用用户 ACL 与内容操作限制。"]
  },
  {
    version: "3.0.0",
    releasedAt: "2026-09-25",
    changes: [
      "Dynamic all-App and all-writable-folder scopes now follow each invoking user's current access, including future additions.",
      "Renamed the public Hub submission tool to apps_deployment_submit_listing and classified it under APPS Deploy and release."
    ],
    changesZh: [
      "全部 App 与全部可写文件夹范围按调用用户的当前授权动态扩展，包含未来新增项目。",
      "公开的 Hub 提交工具更名为 apps_deployment_submit_listing，并归入 APPS 部署与发布。"
    ]
  },
  {
    version: "2.2.0",
    releasedAt: "2026-09-25",
    changes: [
      "Added release-bound AI Capacity and Forum & Hub groups for cloud Mate Runtime, with all, none, and explicit child selection.",
      "Removed APPS management and Hub publishing from cloud Runtime's Workspace MCP tool catalog; Knowledge writes remain folder scoped."
    ],
    changesZh: [
      "为云端 Mate Runtime 增加随发布版本绑定的 AI Capacity 与 Forum & Hub 能力组，支持全选、不选和指定子项。",
      "云端 Runtime 的 Workspace MCP 工具目录不再暴露 APPS 管理及 Hub 发布；知识库写入仍受文件夹范围约束。"
    ]
  },
  {
    version: "2.1.0",
    releasedAt: "2026-09-25",
    changes: ["Reserve one immutable default Mate per user with a dedicated address and authorized workspace access."],
    changesZh: ["为每位用户预留唯一且不可删除的默认 Mate，配备专属地址并继承其已授权的工作空间访问权限。"]
  },
  {
    version: "2.0.0",
    releasedAt: "2026-09-25",
    changes: [
      "Store generated image, video, and speech files in a seven-day private Artifact workspace scoped to organization, user, and Mate.",
      "Return temporary preview links and artifact identifiers; adding files to Knowledge now requires an explicit user action."
    ],
    changesZh: [
      "将生成的图片、视频和语音存入按组织、用户和 Mate 隔离、保留七天的私有 Artifact 工作空间。",
      "返回临时预览链接和产物 ID；加入知识库需由用户明确操作。"
    ]
  },
  {
    version: "1.10.0",
    releasedAt: "2026-09-25",
    changes: [
      "Added tools_audio_tts backed by MiniMax Speech 2.8 Turbo through Cloudflare Workers AI.",
      "Kept Audio as a separate category and returned generated speech from shared Workspace media storage."
    ],
    changesZh: [
      "新增 tools_audio_tts，通过 Cloudflare Workers AI 调用 MiniMax Speech 2.8 Turbo。",
      "保留独立的音频分类，并将生成语音存入 Workspace 公共媒体存储后返回。"
    ]
  },
  {
    version: "1.9.0",
    releasedAt: "2026-09-24",
    changes: [
      "Published directly callable tools_* names for web, image, video, audio, and JEV while preserving models_list.",
      "Removed handbook action arrows and reserved tools_audio_tts for an upstream integration."
    ],
    changesZh: [
      "为网页、图片、视频、音频和 JEV 公布直接可调用的 tools_* 名称，同时保留 models_list。",
      "移除手册中的动作箭头，并为上游语音生成集成预留 tools_audio_tts。"
    ]
  },
  {
    version: "1.8.2",
    releasedAt: "2026-09-24",
    changes: [
      "Grouped Forum and Hub under one handbook family, moved models into AI resources, and removed the Publication MCP broker from the public catalog.",
      "Published Audio, Image, Web, Video, and JEV capability namespaces while keeping action-specific MCP tool names stable.",
      "Renamed the connector pack to APPS App MCP and Mate Runtime to Mate management; Audio currently lists ASR only."
    ],
    changesZh: [
      "将 Forum 与 Hub 合并为一个手册分类，把模型目录归入 AI 资源，并从公开目录移除 Publication MCP 代理。",
      "公布 Audio、Image、Web、Video、JEV 能力路径，同时保留现有按动作命名的 MCP 工具 ID。",
      "将连接器能力包改名为 APPS App MCP，并将 Mate Runtime 改为 Mate 管理；Audio 当前仅列出 ASR。"
    ]
  },
  {
    version: "1.8.0",
    releasedAt: "2026-09-24",
    changes: [
      "Added independent image_generation, video_generation, web_search, web_reader, whisper_asr, and jev public MCP capabilities outside the LiteLLM model catalog.",
      "Connected image, video, web search, webpage/PDF reading, Whisper ASR, and typesafe/jev directly to Cloudflare bindings in the shared MCP Worker.",
      "Kept models_list limited to conversational gateway models so generated media and utility tools are discovered through MCP tools/list."
    ],
    changesZh: [
      "新增独立的 image_generation、video_generation、web_search、web_reader、whisper_asr 与 jev 公共 MCP 能力，不进入 LiteLLM 模型目录。",
      "图片、视频、网页搜索、网页/PDF 读取、Whisper ASR 与 typesafe/jev 均通过同一个公共 MCP Worker 直接连接 Cloudflare Binding。",
      "models_list 继续只列对话网关模型，生成媒体与实用能力通过 MCP tools/list 发现。"
    ]
  },
  {
    version: "1.7.2",
    releasedAt: "2026-09-22",
    changes: [
      "Normalized models_list catalog responses so capability-source guidance remains available when the gateway omits optional notes.",
      "Kept undeclared model capabilities and endpoint support explicitly unknown rather than treating missing metadata as unsupported."
    ],
    changesZh: [
      "当网关省略可选 notes 时，规范化 models_list 目录响应并保留能力来源提示。",
      "模型能力与端点支持的未声明状态继续明确保持 unknown，不将缺失元数据视为不支持。"
    ]
  },
  {
    version: "1.7.1",
    releasedAt: "2026-09-22",
    changes: [
      "Changed the canonical Portal origin used by Workspace MCP CORS and generated Forum media URLs from ai.example.invalid to ai.example.invalid.",
      "Kept tool names, schemas, authorization, and protocol compatibility unchanged; existing clients require no migration."
    ],
    changesZh: [
      "将 Workspace MCP CORS 与论坛媒体 URL 使用的 Portal 规范来源从 ai.example.invalid 切换为 ai.example.invalid。",
      "工具名称、Schema、授权与协议兼容性保持不变；现有客户端无需迁移。"
    ]
  },
  {
    version: "1.7.0",
    releasedAt: "2026-09-22",
    changes: [
      "Added models_list, which lists the gateway models available to the account with context limits, pricing, and capability support.",
      "Made capability and endpoint support tri-state (supported, unsupported, unknown); an undeclared value stays unknown and is never reported as unsupported.",
      "Read the catalog from /v1/model/info only, because /model_group/info collapses an undeclared null into false and would misreport models as unsupported.",
      "Kept models_list visible to every authenticated Workspace MCP user without extra scopes; narrowing the list per calling key arrives with the capability registration work."
    ],
    changesZh: [
      "新增 models_list，列出账号可用的网关模型及其上下文上限、价格和能力支持。",
      "能力与端点支持改为三态（supported、unsupported、unknown）；未声明的值保持 unknown，绝不被报为不支持。",
      "模型目录只读 /v1/model/info，因为 /model_group/info 会把未声明的 null 塌成 false，从而错误地标注模型不支持。",
      "models_list 对所有已认证的 Workspace MCP 用户可见且不额外要求 scopes；按调用方 key 收敛列表随能力登记工作一并交付。"
    ]
  },
  {
    version: "1.6.0",
    releasedAt: "2026-09-16",
    changes: [
      "Added dynamic current-user Workspace MCP scope so Mate Releases can resolve the complete authorized APPS and Knowledge tool surface at Task time without snapshotting App tokens.",
      "Required dynamic scope to remain mutually exclusive with fixed App, Knowledge Service, and folder bindings, while skipping stale fixed App bindings without blocking a reply.",
      "Kept dynamic writes behind exact, single-use approval with catalog, schema, Release, identity, and current-user authorization revalidation before execution."
    ],
    changesZh: [
      "新增动态当前用户 Workspace MCP 范围，使 Mate Release 可在 Task 执行时解析完整的已授权 APPS 与 Knowledge 工具面，无需快照保存 App Token。",
      "动态范围必须与固定 App、Knowledge Service 和文件夹绑定互斥；过期的固定 App 绑定会被跳过，不会阻断回复。",
      "动态写入继续要求精确、单次有效审批，并在执行前重新校验工具目录、Schema、Release、身份与当前用户授权。"
    ]
  },
  {
    version: "1.5.0",
    releasedAt: "2026-09-15",
    changes: [
      "Unified natural-language Tasks and reminder invocations on the Role Agent tool loop; Knowledge, App MCP, Forum and private task tools can be combined in one Task.",
      "Removed executor selection from Mate creation and removed the fixed Forum review workflow. Reminder instructions and private Todo notes now describe the work.",
      "Retained per-tool current-user authorization, write approvals and Preview isolation. Legacy executor metadata no longer changes routing."
    ],
    changesZh: [
      "自然语言 Task 与提醒唤醒统一使用 Role Agent 工具循环，同一任务可组合知识、App MCP、论坛和私有任务工具。",
      "移除 Mate 创建中的执行器分类与固定论坛巡检流程，工作目标和上下文由提醒说明、私有 Todo 笔记承载。",
      "保留每次工具调用的当前用户授权、写入审批和 Preview 隔离；旧执行器字段不再影响路由。"
    ]
  },
  {
    version: "1.4.0",
    releasedAt: "2026-09-15",
    changes: [
      "Added folderEditIds to Mate creation so a Release can bind editable folders independently from Knowledge Service reading.",
      "Restricted Mate Knowledge maintenance to selected folders and descendants, rechecking the invoking user's current edit ACL and limiting effective behavior to Collaborator content operations.",
      "Kept every Mate folder write behind an exact, single-use approval and blocked ownership, ACL, Knowledge Service administration, and out-of-scope batch operations."
    ],
    changesZh: [
      "Mate 创建新增 folderEditIds，使 Release 可独立绑定可编辑文件夹与知识库读取。",
      "Mate 知识维护仅限所选文件夹及其子目录，每次重新检查调用用户当前编辑 ACL，并将有效行为限制为 Collaborator 内容操作。",
      "所有 Mate 文件夹写入继续要求精确、单次有效审批，并阻止所有权、ACL、知识库管理及越界批量操作。"
    ]
  },
  {
    version: "1.3.7",
    releasedAt: "2026-09-02",
    changes: [
      "Added retainedAttachmentIds to forum_write update_topic so clients can preserve selected root-post attachments or replace them with finalized forum_media objects.",
      "Removed superseded attachment rows and their R2 objects only after the topic update succeeds.",
      "Kept replacement retries idempotent by retaining an existing attachment when its storageKey is requested again."
    ],
    changesZh: [
      "为 forum_write 的 update_topic 新增 retainedAttachmentIds，可保留指定根帖附件，或用 forum_media 已完成上传的对象替换附件。",
      "仅在主题更新成功后删除被替换的附件记录及对应 R2 对象。",
      "再次请求同一 storageKey 时自动保留现有附件，保证附件替换重试幂等。"
    ]
  },
  {
    version: "1.3.6",
    releasedAt: "2026-09-02",
    changes: [
      "Added standalone attachment binding to forum_write update_topic using file objects returned by forum_media.",
      "Validated attachment ownership, R2 existence, supported MIME type, file size, and per-topic limits before binding media to a topic.",
      "Returned topic attachments from forum_read get_topic and made repeated storageKey attachment requests idempotent."
    ],
    changesZh: [
      "为 forum_write 的 update_topic 新增独立附件绑定，可直接使用 forum_media 返回的文件对象。",
      "绑定前校验附件归属、R2 文件存在性、支持的 MIME 类型、文件大小与主题附件数量上限。",
      "forum_read 的 get_topic 现在返回主题附件，并对重复 storageKey 的绑定请求提供幂等处理。"
    ]
  },
  {
    version: "1.3.5",
    releasedAt: "2026-09-01",
    changes: [
      "Added a service-authenticated Knowledge maintenance bridge for Mate Runtime while preserving Workspace MCP validation and current-user Knowledge ACL enforcement.",
      "Separated read-only Knowledge Service consumption from Owner/Collaborator library maintenance and filtered Viewer objects out of the maintenance surface.",
      "Kept every Mate Knowledge mutation behind exact-action, single-use approval, with destructive and overwrite operations classified as high risk."
    ],
    changesZh: [
      "新增面向 Mate Runtime 的服务鉴权知识库维护桥接，同时保留 Workspace MCP 参数校验与当前用户知识库 ACL 强制检查。",
      "将只读知识库消费与 Owner／Collaborator 内容维护拆分，并从维护能力中排除 Viewer 对象。",
      "所有 Mate 知识库变更继续要求精确操作、单次有效审批，删除与覆盖类操作按高风险处理。"
    ]
  },
  {
    version: "1.3.4",
    releasedAt: "2026-09-01",
    changes: [
      "Standardized APPS developer guidance for cross-platform Node.js ESM paths, single-source release versions, and version-controlled generated migrations.",
      "Replaced full-changelog deployment examples with one-release notes files, documented the 4,000-character limit, and clarified that ready deployment access policy is normally inherited at publish time.",
      "Coordinated Workspace CLI 1.2.1 help and documentation so local deployment clearly remains unpublished until a separately approved apps_deployment_release action."
    ],
    changesZh: [
      "统一 APPS 开发指引：Node.js ESM 路径须跨平台处理、发版版本采用单一来源，并将生成的迁移文件纳入版本控制。",
      "将完整 CHANGELOG 部署示例改为单版本说明文件，标注 4,000 字符限制，并明确发布时通常继承 ready 部署中的访问策略。",
      "协同发布 Workspace CLI 1.2.1 帮助与文档，明确本地部署在单独批准 apps_deployment_release 前始终未上线。"
    ]
  },
  {
    version: "1.3.3",
    releasedAt: "2026-08-30",
    changes: [
      "Made Mate Code immutable after creation and removed workEmail from Mate update tool schemas.",
      "Made the Code the canonical mateId for newly created Mates so the configured Code fixes the direct access URL.",
      "Kept existing Mate ids and immutable Releases compatible while allowing all other identity metadata to remain editable."
    ],
    changesZh: [
      "Mate 创建后 Code 不可修改，并从 Mate 更新工具 Schema 中移除 workEmail。",
      "新建 Mate 使用 Code 作为规范 mateId，使配置的 Code 固定其直接访问地址。",
      "保留既有 Mate id 与不可变 Release 的兼容性，同时允许继续编辑其他身份信息。"
    ]
  },
  {
    version: "1.3.2",
    releasedAt: "2026-08-29",
    changes: [
      "Added a service-authenticated Forum bridge for the Mate Runtime to search, read, and create topics as the invoking user.",
      "Forwarded bounded Forum search filters through the internal Runtime route while retaining Workspace MCP authorization and audit enforcement.",
      "Kept Mate Forum writes behind exact-action, single-use current-user approval before Workspace MCP execution."
    ],
    changesZh: [
      "新增面向 Mate Runtime 的服务鉴权 Forum 桥接，以调用用户身份搜索、读取和创建主题。",
      "通过内部 Runtime 路由转发有界 Forum 搜索条件，同时保留 Workspace MCP 鉴权与审计。",
      "Mate 的 Forum 写入在 Workspace MCP 执行前仍须经过精确操作、单次有效的当前用户审批。"
    ]
  },
  {
    version: "1.3.1",
    releasedAt: "2026-08-26",
    changes: [
      "Added independent App and company directory-read scopes without changing App launch admission.",
      "Added exact immutable person lookup for employee import and account-linking flows.",
      "Preserved an App's configured directory-read scope when Publication publication sends a partial Auth projection."
    ],
    changesZh: [
      "新增独立的 App 范围与公司范围通讯录读取权限，不改变 App 启动准入规则。",
      "为员工导入与账号关联流程新增精确、不可变的人员查询。",
      "Publication 发布部分 Auth 投影时，保留 App 已配置的通讯录读取范围。"
    ]
  },
  {
    version: "1.3.0",
    releasedAt: "2026-08-24",
    changes: [
      "Added deployment-time loginRequired, visibility, and accessTargets policy inputs and bound publication to the security-checked deployment snapshot.",
      "Allowed public Apps to become authenticated, or authenticated Apps to become public, only through a newly prepared deployment while preserving legacy deployment safeguards.",
      "Separated company-account sign-in from access scope in the Portal and aligned App and Knowledge choices around company-wide, specific members, and collaborators."
    ],
    changesZh: [
      "为部署增加 loginRequired、visibility 与 accessTargets 目标权限输入，并要求发布使用通过安全检查的部署权限快照。",
      "允许公开 App 仅通过新准备的部署改为需登录，也允许需登录 App 通过新部署改为公开，同时保留旧部署的安全限制。",
      "在 Portal 中拆分公司账号登录与访问范围，并统一 App、知识库的公司全员、指定成员与协作者选项。"
    ]
  },
  {
    version: "1.2.0",
    releasedAt: "2026-08-24",
    changes: [
      "Enabled private static Pages Apps when loginRequired is true and required Workspace Auth across creation, publication, visibility, and collaborator updates.",
      "Reconciled each canonical production hostname on publish and rollback, including an exact Pages bypass for the account-wide APPS wildcard Worker.",
      "Made domain publication fail closed so a Cloudflare route failure is recorded instead of reporting the hostname active."
    ],
    changesZh: [
      "当 loginRequired 为 true 时支持私有 static Pages App，并在创建、发布、可见性与协作者更新中统一要求 Workspace Auth。",
      "在每次发布与回滚时对账正式域名，包括为 Pages 配置精确绕行规则，避免被账号级 APPS 通配 Worker 截获。",
      "将域名发布改为失败关闭：Cloudflare 路由失败会被记录，不会错误地把域名报告为 active。"
    ]
  },
  {
    version: "1.1.7",
    releasedAt: "2026-08-23",
    changes: [
      "Added avatarUrl to Mate create and update actions in APPS MCP and the public Workspace MCP mate_builder_write tool.",
      "Stored the normalized avatar as the versioned workspace.agentruntime/v1 mate.avatarRef field and rendered the published avatar in the shared Runtime.",
      "Kept avatar removal backward compatible through an empty avatarUrl update without changing mateId or prior immutable Releases."
    ],
    changesZh: [
      "为 APPS MCP 与公开 Workspace MCP mate_builder_write 工具的 Mate 创建、更新动作增加 avatarUrl。",
      "将规范化头像写入版本化 workspace.agentruntime/v1 mate.avatarRef，并在共享 Runtime 中显示已发布头像。",
      "通过空 avatarUrl 更新向后兼容地移除头像，不改变 mateId 或既有不可变 Release。"
    ]
  },
  {
    version: "1.1.6",
    releasedAt: "2026-08-23",
    changes: [
      "Removed the legacy Mate template tool and templateId creation branch; every Mate now starts from one generic identity contract.",
      "Made the shared Runtime email binding accept any sender on a Cloudflare-onboarded domain instead of pinning Cortana's address.",
      "Kept the removed HTTP template endpoint as an explicit 410 migration tombstone rather than silently preserving the old abstraction."
    ],
    changesZh: [
      "移除旧 Mate 模板工具及 templateId 创建分支；所有 Mate 统一从通用身份契约创建。",
      "共享 Runtime 邮件绑定改为接受 Cloudflare 已接入发送域中的任意发件地址，不再固定 Cortana 地址。",
      "旧 HTTP 模板端点仅保留明确的 410 迁移提示，不再悄悄保留旧抽象。"
    ]
  },
  {
    version: "1.1.5",
    releasedAt: "2026-08-23",
    changes: [
      "Added explicit defaultExecutor, defaultTimezone, and scheduledJobs fields to Mate creation so Runtime behavior is Release-driven.",
      "Made scheduled Forum review a reusable configured executor instead of a named Cortana Runtime path.",
      "Kept Mate creation, Soul/Handbook review, immutable Preview deployment, publication, and rollback in the existing Builder actions."
    ],
    changesZh: [
      "为 Mate 创建增加显式 defaultExecutor、defaultTimezone 与 scheduledJobs 字段，使 Runtime 行为完全由 Release 驱动。",
      "将 Forum 定时巡检改为可复用的配置执行器，不再存在按 Cortana 名称分支的 Runtime 路径。",
      "继续通过现有 Builder 动作完成 Mate 创建、Soul/Handbook 审阅、不可变 Preview 部署、发布与回滚。"
    ]
  },
  {
    version: "1.1.4",
    releasedAt: "2026-08-23",
    changes: [
      "Added declarative Cron Trigger and Queue Consumer topology to prepared APPS Worker deployments.",
      "Made Worker preparation upload one immutable Cloudflare Version and defer trigger changes until publish.",
      "Preserved structured Cloudflare API details in deployment error responses."
    ],
    changesZh: [
      "为准备中的 APPS Worker 部署新增声明式 Cron Trigger 与 Queue Consumer 拓扑。",
      "Worker 准备阶段改为上传单个不可变 Cloudflare Version，并将触发器变更延后到发布时执行。",
      "在部署错误响应中保留结构化 Cloudflare API 详情。"
    ]
  },
  {
    version: "1.1.3",
    releasedAt: "2026-08-22",
    changes: [
      "Reconciled the private synthetic source-snapshot acceptance App through the managed APPS D1 migration ledger.",
      "Kept the authenticated production source-snapshot gate fail-closed while making its dedicated fixture recoverable from data drift.",
      "Added a stable mate_email_conflict response when Mate creation reuses a normalized work email."
    ],
    changesZh: [
      "通过受管 APPS D1 迁移账本修复私有的合成 Source Snapshot 验收 App。",
      "保持生产 Source Snapshot 认证门禁 fail-closed，同时允许其专用夹具从数据漂移中恢复。",
      "Mate 创建复用规范化工作邮箱时，返回稳定的 mate_email_conflict。"
    ]
  },
  {
    version: "1.1.2",
    releasedAt: "2026-08-22",
    changes: [
      "Made Mate creation custom-identity-first; the compatibility templates action no longer offers selectable built-in identities.",
      "Added personal, selected-user-or-department, and organization invocation visibility to Mate Builder create and update actions.",
      "Added versioned targetIds so selected people and department descendants are enforced by the shared Runtime."
    ],
    changesZh: [
      "将 Mate 创建统一为自定义身份；兼容 templates 动作不再提供可选择的内置身份。",
      "为 Mate Builder 创建与更新动作增加个人、指定人员或部门、组织三种调用可见性。",
      "增加版本化 targetIds，由共享 Runtime 强制校验指定人员与部门下级成员。"
    ]
  },
  {
    version: "1.1.1",
    releasedAt: "2026-08-22",
    changes: [
      "Added optional Hyperdrive connection parameters to APPS Pages and Worker deployment actions; the password remains a platform-managed App Secret.",
      "Added deployment harness report URL and self-check confirmation fields to the APPS release contract.",
      "Made Hyperdrive configuration idempotent and reusable across subsequent MCP deployments."
    ],
    changesZh: [
      "为 APPS Pages 和 Worker 部署动作增加可选 Hyperdrive 连接参数；密码始终保存在平台管理的 App Secret 中。",
      "为 APPS 发布契约增加部署验证报告 URL 与自检确认字段。",
      "让 Hyperdrive 配置在后续 MCP 部署中可幂等复用。"
    ]
  },
  {
    version: "1.1.0",
    releasedAt: "2026-08-22",
    changes: [
      "Added mate_builder_read for owned Mate, Soul, Handbook, Draft, and immutable Release review.",
      "Added mate_builder_write for confirmed Mate creation, definition maintenance, validation, publication, and Release activation.",
      "Added mate_call for starting, following, and listing Tasks whose user identity is derived from the Workspace MCP connection."
    ],
    changesZh: [
      "新增 mate_builder_read，用于查看本人管理的 Mate、Soul、Handbook、Draft 与不可变 Release。",
      "新增 mate_builder_write，用于经确认创建 Mate、维护定义、校验、发布与激活 Release。",
      "新增 mate_call，用于创建、跟进和列出由 Workspace MCP 连接派生用户身份的 Task。"
    ]
  },
  {
    version: "1.0.3",
    releasedAt: "2026-08-21",
    changes: [
      "Replaced runtime AJV schema compilation with a Cloudflare-safe interpreter so server-side validation does not require dynamic string code generation."
    ],
    changesZh: [
      "将运行时 AJV schema 编译替换为兼容 Cloudflare 的解释式校验器，服务端校验不再依赖动态字符串代码生成。"
    ]
  },
  {
    version: "1.0.2",
    releasedAt: "2026-08-21",
    changes: [
      "Replaced every public root oneOf/anyOf schema with one client-compatible object schema using root properties, required, and additionalProperties.",
      "Kept compact action tools while moving conditional requirements and action-specific strict validation to the Workspace server boundary."
    ],
    changesZh: [
      "将所有公共工具根级 oneOf/anyOf schema 替换为兼容客户端的单一对象 schema，统一使用根级 properties、required 和 additionalProperties。",
      "保留紧凑 action 工具，并将条件必填与 action 专属严格校验移至 Workspace 服务端边界。"
    ]
  },
  {
    version: "1.0.1",
    releasedAt: "2026-08-19",
    changes: [
      "Made ping_who_am_i the first advertised troubleshooting entry for setup, connection, authentication, CLI upgrade or reinstall, and guided-use issues.",
      "Added ready, attention-required, and action-required status with structured checks and executable connector recovery guidance."
    ],
    changesZh: [
      "将 ping_who_am_i 明确为安装、连接、认证、CLI 升级或重装以及使用引导异常时的首要排障入口。",
      "新增 ready、attention-required、action-required 状态，以及结构化检查和可执行的连接器恢复指引。"
    ]
  },
  {
    version: "1.0.0",
    releasedAt: "2026-08-19",
    changes: [
      "Renamed the public connector to Workspace MCP with the machine id workspace-pass.",
      "Compressed 81 formal first-level tools to 34 action-oriented tools while retaining existing downstream command ids only inside the service boundary.",
      "Replaced flattened Publication tools with a fixed three-step progressive broker and added Workspace CLI 1.0 compatibility guidance through MCP initialize and ping_who_am_i.",
      "Removed external aliases for all pre-1.0 tool names; first-party callers must use the Workspace MCP 1.0 contract."
    ],
    changesZh: [
      "将公共连接器更名为 Workspace MCP，机器标识改为 workspace-pass。",
      "将 81 个正式一级工具压缩为 34 个 action 化工具，现有下游命令 ID 仅保留在服务内部边界。",
      "将平铺的 Publication 工具替换为固定三级渐进式 Broker，并通过 MCP initialize 与 ping_who_am_i 提供 Workspace CLI 1.0 兼容升级指引。",
      "不提供任何 1.0 以前工具名的外部 alias；所有第一方调用方必须迁移到 Workspace MCP 1.0 契约。"
    ]
  },
  {
    version: "0.10.0",
    releasedAt: "2026-08-17",
    changes: [
      "Released @frontier-workspace/auth 0.4.1 with live App Center app_owner/app_collaborator facts, declarative App-role inheritance, and one effective-role resolver for browser APIs and App MCP.",
      "Standardized App authorization guidance around owner/admin/member while preserving App-defined business roles, Member admission, and row-level ACLs.",
      "Expanded apps_get_auth_sdk with mapping defaults, empty and partial override semantics, custom multi-role examples, owner precedence, no implicit role hierarchy, UI provenance rules, runtime flow, and acceptance checks."
    ],
    changesZh: [
      "发布 @frontier-workspace/auth 0.4.1：提供实时 App Center app_owner/app_collaborator 事实、声明式 App 角色继承，以及浏览器 API 与 App MCP 共用的有效角色解析器。",
      "将 App 授权指引标准化为 owner/admin/member，同时保留 App 自定义业务角色、Member 准入与行级 ACL。",
      "扩展 apps_get_auth_sdk，补充默认映射、空/部分覆盖语义、自定义多角色示例、owner 优先、无隐含角色层级、UI 来源规则、运行链路与验收检查。"
    ]
  },
  {
    version: "0.9.4",
    releasedAt: "2026-08-17",
    changes: [
      "Hardened APPS App D1 migrations with token-structured validation, mandatory App prefixes for schema and data objects, and transactional multi-statement batches.",
      "Enforced one D1 binding per App environment, globally unique D1 resource ownership, and fail-closed provider validation.",
      "Released Workspace CLI 0.8.0 with matching local migration preflight and a required --table-prefix for every migration plan and apply."
    ],
    changesZh: [
      "强化 APPS App D1 migration：使用 token 结构校验、要求 Schema 与数据对象统一使用 App 前缀，并将多条语句作为事务批次执行。",
      "强制每个 App 环境只能绑定一个 D1、D1 resource ID 全局唯一归属，并对异常 Provider fail closed。",
      "发布 Workspace CLI 0.8.0，提供一致的本地 migration 预检，并要求每次 plan/apply 都显式传入 --table-prefix。"
    ]
  },
  {
    version: "0.9.3",
    releasedAt: "2026-08-17",
    changes: [
      "Restored the private synthetic APPS App required by the authenticated production source-history acceptance gate."
    ],
    changesZh: [
      "恢复 authenticated production source-history acceptance 门禁所需的 private synthetic APPS App。"
    ]
  },
  {
    version: "0.9.2",
    releasedAt: "2026-08-17",
    changes: [
      "Added knowledge_edit_service_update so Knowledge Service Owners and Collaborators can update the Agent routing Card without changing access, lifecycle, files, or ownership."
    ],
    changesZh: [
      "新增 knowledge_edit_service_update，使 Knowledge Service Owner 与 Collaborator 可以更新 Agent 路由 Card，且不能借此修改访问权限、生命周期、文件或所有权。"
    ]
  },
  {
    version: "0.9.1",
    releasedAt: "2026-08-15",
    changes: [
      "Enabled Cloudflare's global_fetch_strictly_public compatibility behavior for the Workspace MCP Worker so same-zone App custom-domain subrequests reach the registered Worker runtime.",
      "Added a deployment-configuration regression test to keep the App MCP broker from silently falling back to a zone origin.",
      "Kept Resource Token minting, immutable Manifest enforcement, App SDK validation, and existing App transports unchanged."
    ],
    changesZh: [
      "为 Workspace MCP Worker 启用 Cloudflare global_fetch_strictly_public 兼容行为，使同 Zone 的 App 自定义域名子请求到达已注册 Worker Runtime。",
      "新增部署配置回归测试，防止 App MCP Broker 静默回退到 Zone 源站。",
      "Resource Token 签发、不可变 Manifest 校验、App SDK 验证与现有 App 传输方式均保持不变。"
    ]
  },
  {
    version: "0.9.0",
    releasedAt: "2026-08-15",
    changes: [
      "Added the optional authorization.resourceTokenHeader App MCP Manifest field with the governed values authorization and x-workspace-resource-token.",
      "Made the App MCP broker honor the published header selection for discovery and registered tool calls while preserving Authorization as the default.",
      "Documented the required in-memory App translation so the official SDK continues to enforce token introspection, audience, Resource ID, scopes, and live App roles."
    ],
    changesZh: [
      "为 App MCP Manifest 增加可选的 authorization.resourceTokenHeader 字段，受控取值为 authorization 与 x-workspace-resource-token。",
      "App MCP Broker 在发现和已注册工具调用中遵循已发布的请求头选择，同时保留 Authorization 作为默认值。",
      "记录 App 必须进行的内存转换，使官方 SDK 继续校验 Token introspection、Audience、Resource ID、Scope 与实时 App 角色。"
    ]
  },
  {
    version: "0.8.0",
    releasedAt: "2026-08-15",
    changes: [
      "Added the optional agentMcpEnabled field to apps_update_app_config so authorized App owners and collaborators can enable or disable App MCP through the governed APPS workflow.",
      "Made App MCP a server capability for Web, Automation, and Container apps while keeping it mandatory for Agent apps, requiring a ready server runtime and adding the logical Agent Schema resource.",
      "Separated configured and registered App MCP status, and synchronized Auth Resource listing, delisting, access targets, and collaborators across capability and access-policy changes."
    ],
    changesZh: [
      "为 apps_update_app_config 增加可选 agentMcpEnabled 字段，使获授权的 App Owner 与 Collaborator 可通过受控 APPS 流程启用或关闭 App MCP。",
      "将 App MCP 设为 Web、Automation 与 Container App 的可选服务器能力，同时保持 Agent App 强制启用；启用时要求 ready 服务器 Runtime 并添加逻辑 Agent Schema 资源。",
      "区分 App MCP 的已配置与已注册状态，并在能力或访问策略变化时同步 Auth Resource 的上架、下架、访问目标与协作者。"
    ]
  },
  {
    version: "0.7.6",
    releasedAt: "2026-08-14",
    changes: [
      "Added apps_download_current_source_code to download only the source snapshot linked to an App's currently published production deployment, with deployment metadata and integrity hashes.",
      "Preserved an existing README.md from the immutable snapshot while deliberately avoiding synthetic context files that would change the deployed source archive."
    ],
    changesZh: [
      "新增 apps_download_current_source_code，仅下载 App 当前已发布生产部署所绑定的源码快照，并附带部署元数据与完整性哈希。",
      "保留不可变快照中已有的 README.md，同时不注入会改变已部署源码归档的合成 context 文件。"
    ]
  },
  {
    version: "0.7.5",
    releasedAt: "2026-08-14",
    changes: [
      "Unified WorkBuddy, Claude Code, Codex, and Cursor installation behind one Workspace CLI command that completes OAuth + PKCE and configures a local stdio MCP connection.",
      "Released Workspace CLI 0.7.3 with Agent-specific installers and shared rotating credential reuse."
    ],
    changesZh: [
      "统一 WorkBuddy、Claude Code、Codex 与 Cursor 安装流程：一条 Workspace CLI 命令完成 OAuth + PKCE 并配置本地 stdio MCP 连接。",
      "发布 Workspace CLI 0.7.3，增加各 Agent 安装适配与共享轮换凭据复用。"
    ]
  },
  {
    version: "0.7.4",
    releasedAt: "2026-08-14",
    changes: [
      "Restored WorkBuddy's default Frontier Workspace connection to the Workspace CLI local stdio bridge with CLI-managed OAuth + PKCE pre-authentication."
    ],
    changesZh: [
      "恢复 WorkBuddy 通过 Workspace CLI 本地 stdio bridge 默认连接 Frontier Workspace，并由 CLI 管理 OAuth + PKCE 预授权。"
    ]
  },
  {
    version: "0.7.3",
    releasedAt: "2026-08-14",
    changes: [
      "Migrated WorkBuddy's default installation from the local Workspace CLI stdio bridge to native remote MCP OAuth without a prerequisite CLI install.",
      "Added a required APPS App deployment preflight that checks the installed Workspace CLI against the matching workspace release, installs or updates it when needed, and authenticates WorkBuddy's CLI only for local operations."
    ],
    changesZh: [
      "将 WorkBuddy 默认安装从 Workspace CLI 本地 stdio bridge 迁移到原生远程 MCP OAuth，初次连接无需预装 CLI。",
      "为 APPS App 部署增加必需的 CLI 前置检查：对比本地版本与当前工作区发行版，按需安装或更新，并仅在 WorkBuddy 执行本地操作时登录 CLI。"
    ]
  },
  {
    version: "0.7.2",
    releasedAt: "2026-08-13",
    changes: [
      "Worker deployment artifacts now reject browser assets that bypass schema v2 Static Assets metadata, including manual .workspace-assets archives and root index.html output, with actionable CLI remediation."
    ],
    changesZh: [
      "Worker 部署制品现会拒绝绕过 schema v2 Static Assets 元数据的浏览器资源，包括手工 .workspace-assets 归档和根目录 index.html，并返回可执行的 CLI 修复指引。"
    ]
  },
  {
    version: "0.7.1",
    releasedAt: "2026-08-13",
    changes: [
      "Added governed Worker Static Assets deployment artifacts, Cloudflare asset upload sessions, asset bindings, and routing configuration to the APPS deployment pipeline."
    ],
    changesZh: [
      "为 APPS 发布链路增加受控的 Worker Static Assets 制品、Cloudflare 资源上传会话、资源绑定与路由配置。"
    ]
  },
  {
    version: "0.7.0",
    releasedAt: "2026-08-12",
    changes: [
      "Added app_mcp_accessible_list, app_mcp_tools_list, and app_mcp_tool_call as a fixed progressive broker for published MCP-enabled Apps.",
      "Added deployment-time workspace.app-mcp/v1 manifest validation, immutable manifest snapshots, deterministic Auth Resource registration, and App-local RBAC rechecks.",
      "Released @frontier-workspace/auth 0.3.0 with a storage-independent WorkspaceAppRoleResolver and WorkspaceMcpAuthorization helper."
    ],
    changesZh: [
      "增加 app_mcp_accessible_list、app_mcp_tools_list 与 app_mcp_tool_call，作为已发布 MCP App 的固定渐进式代理。",
      "增加发布时 workspace.app-mcp/v1 Manifest 校验、不可变 Manifest 快照、确定性的 Auth Resource 注册与 App 本地 RBAC 二次校验。",
      "发布 @frontier-workspace/auth 0.3.0，提供与存储无关的 WorkspaceAppRoleResolver 与 WorkspaceMcpAuthorization 辅助能力。"
    ]
  },
  {
    version: "0.6.2",
    releasedAt: "2026-08-12",
    changes: [
      "Classified ping_who_am_i as a post-install connection check instead of a formal catalog tool, so the Handbook reports four tool families and 76 formal tools while the MCP verification tool remains available."
    ],
    changesZh: [
      "将 ping_who_am_i 明确归类为安装后连接检查而非正式目录工具；Handbook 现显示 4 个工具家族和 76 个正式工具，同时保留实际 MCP 验证工具。"
    ]
  },
  {
    version: "0.6.1",
    releasedAt: "2026-08-11",
    changes: [
      "Fixed knowledge_edit_list root discovery so Owner, Collaborator, and authorized Viewer Roots are returned together without changing write permissions."
    ],
    changesZh: [
      "修复 knowledge_edit_list 根目录发现：统一返回 Owner、Collaborator 与已获授权的 Viewer 根目录，且不改变任何写权限。"
    ]
  },
  {
    version: "0.6.0",
    releasedAt: "2026-08-11",
    changes: [
      "Added Workspace MCP version, release date, preferred protocol date, and supported protocol dates to ping_who_am_i.",
      "Added forum_upload_media plus upload_begin/upload_finalize for URL-based and direct binary attachments.",
      "Removed forum_upload_image; callers must use forum_upload_media or the direct upload flow.",
      "Removed apps_get_app_handoff and consolidated App development context, readiness, blockers, and next actions into apps_get_app.",
      "Added immutable source snapshots and CLI deployment artifacts to APPS Pages and Worker deployment contracts.",
      "Required version number, version name, and release notes for CLI-backed deployments while keeping publication as a separate approved action.",
      "Added source history metadata and governed, app-scoped D1 data migrations with explicit approval and content-drift protection."
    ],
    changesZh: [
      "在 ping_who_am_i 中增加 Workspace MCP 版本、发布日期、首选协议日期和支持的协议日期。",
      "增加 forum_upload_media 与 upload_begin/upload_finalize，支持 URL 抓取和二进制直传附件。",
      "移除 forum_upload_image；调用方必须迁移到 forum_upload_media 或二进制直传流程。",
      "移除 apps_get_app_handoff，并将 App 开发上下文、readiness、blockers 和 next actions 统一到 apps_get_app。",
      "在 APPS Pages 与 Worker 部署契约中增加不可变源码快照和 CLI 部署制品。",
      "CLI 部署必须提供版本号、版本名称和更新说明，生产发布仍保持为独立审批动作。",
      "增加源码历史元数据，以及需要显式批准并防止内容漂移的 App 范围 D1 数据迁移。"
    ]
  },
  {
    version: "0.5.0",
    releasedAt: "2026-08-05",
    changes: [
      "Added ping_who_am_i as a credential-safe OAuth installation verification tool.",
      "Changed Portal setup handoffs to direct native OAuth instructions.",
      "Added the System capability pack and expanded the catalog to 76 tools."
    ],
    changesZh: [
      "增加不暴露凭据的 ping_who_am_i，用于 OAuth 安装验收。",
      "Portal 安装指引改为直接提供原生 OAuth 步骤。",
      "增加 System 能力包，并将工具目录扩展到 76 个工具。"
    ]
  },
  {
    version: "0.4.0",
    releasedAt: "2026-08-04",
    changes: [
      "Migrated WorkBuddy, Claude Code, Codex, and Cursor to standard MCP OAuth with PKCE and automatic refresh.",
      "Retired device login and added a structured OAuth reauthorization handoff for legacy credentials."
    ],
    changesZh: [
      "将 WorkBuddy、Claude Code、Codex 和 Cursor 迁移到支持 PKCE 与自动刷新的标准 MCP OAuth。",
      "退役 device login，并为历史凭据增加结构化 OAuth 重授权 Handoff。"
    ]
  },
  {
    version: "0.3.0",
    releasedAt: "2026-08-04",
    changes: [
      "Organized the 75-tool platform catalog by domain and recommended workflow stage.",
      "Simplified the Knowledge surface into Consumer and Author capability packs.",
      "Clarified stable catalog loading and server-side call authorization.",
      "Added Knowledge file upload, update, and content retrieval guidance."
    ],
    changesZh: [
      "将 75 个平台工具按领域和推荐工作流阶段组织。",
      "将 Knowledge 工具面简化为消费者与作者两个能力包。",
      "明确稳定目录加载方式与服务端调用鉴权。",
      "增加 Knowledge 文件上传、更新与内容读取指引。"
    ]
  },
  {
    version: "0.2.0",
    releasedAt: "2026-08-04",
    changes: [
      "Published the authenticated MCP Handbook and canonical tool catalog.",
      "Removed legacy APPS aliases from the public MCP boundary.",
      "Added structured deployment handoff and the official Workspace App Session SDK.",
      "Added APPS App creation and provisioning lifecycle tools."
    ],
    changesZh: [
      "发布登录后可访问的 MCP Handbook 与正式工具目录。",
      "从公开 MCP 边界移除 APPS 历史别名。",
      "增加结构化部署 Handoff 与官方 Workspace App Session SDK。",
      "增加 APPS App 创建和资源初始化生命周期工具。"
    ]
  },
  {
    version: "0.1.0",
    releasedAt: "2026-07-01",
    changes: ["Initial Frontier Workspace MCP platform tool surface."],
    changesZh: ["Frontier Workspace MCP 平台工具面的初始版本。"]
  }
];

export function buildMcpHandbook(
  definitions: McpHandbookToolDefinition[],
  generatedAt = new Date().toISOString()
): McpHandbookPayload {
  const standardDefinitions = definitions.filter((tool) => !INSTALLATION_CHECK_TOOL_NAMES.has(tool.name));
  const advertisedNames = new Set(standardDefinitions.map((tool) => tool.name));
  const capabilityPacks = CAPABILITY_PACKS.map((pack) => ({
    ...pack,
    count: pack.toolNames.filter((name) => advertisedNames.has(name)).length,
    toolNames: pack.toolNames.filter((name) => advertisedNames.has(name))
  })).filter((pack) => pack.count > 0);
  const capabilityPackByTool = new Map(capabilityPacks.flatMap((pack) => (
    pack.toolNames.map((name) => [name, { id: pack.id, group: pack.group }] as const)
  )));
  const tools = standardDefinitions
    .map((tool) => ({
      ...tool,
      capabilityPack: capabilityPackByTool.get(tool.name)?.id ?? "other",
      group: capabilityPackByTool.get(tool.name)?.group ?? mcpHandbookGroup(tool.name),
      operation: mcpHandbookOperation(tool.name, tool.description),
      version: WORKSPACE_MCP_VERSION
    }))
    .sort((left, right) => left.group.localeCompare(right.group) || left.name.localeCompare(right.name));
  const groups = (["forum-hub", "knowledge", "apps", "tools"] as const).map((id) => ({
    id,
    count: tools.filter((tool) => tool.group === id).length
  }));

  return {
    catalogRevision: `${WORKSPACE_MCP_VERSION}+${WORKSPACE_MCP_RELEASED_AT.replaceAll("-", "")}`,
    capabilityPacks,
    generatedAt,
    groups,
    latestFeatures: WORKSPACE_MCP_LATEST_FEATURES,
    releases: WORKSPACE_MCP_RELEASES,
    server: {
      name: "workspace-pass",
      protocol: "Model Context Protocol",
      protocolVersion: WORKSPACE_MCP_PROTOCOL_VERSION,
      releasedAt: WORKSPACE_MCP_RELEASED_AT,
      version: WORKSPACE_MCP_VERSION
    },
    summary: {
      approvalTools: tools.filter((tool) => tool.operation === "approval").length,
      readTools: tools.filter((tool) => tool.operation === "read").length,
      toolCount: tools.length,
      writeTools: tools.filter((tool) => tool.operation === "write").length
    },
    tools
  };
}

export function mcpHandbookGroup(name: string): McpHandbookGroup {
  if (name.startsWith("forum_") || name.startsWith("upload_") || name.startsWith("hub_")) return "forum-hub";
  if (name.startsWith("knowledge_")) return "knowledge";
  if (name === "models_list" || name.startsWith("tools_")) return "tools";
  return "apps";
}

export function mcpHandbookOperation(name: string, description = ""): McpHandbookOperation {
  if ([
    "app_mcp_tool_call",
    "mail_send", "mail_reply",
    "knowledge_library_delete",
    "knowledge_share",
    "apps_deployment_release",
    "mate_builder_write"
  ].includes(name)) return "approval";
  if (/(?:requires? (?:explicit )?(?:user )?(?:confirmation|approval)|after explicit user approval)/i.test(description)) {
    return "approval";
  }

  if ([
    "forum_read",
    "hub_search",
    "hub_skill_download",
    "knowledge_list",
    "knowledge_service_handbook",
    "knowledge_query",
    "knowledge_file_read",
    "knowledge_file_versions",
    "knowledge_feedback_read",
    "app_mcp_accessible_list",
    "app_mcp_tools_list",
    "mate_builder_read",
    "apps_inventory",
    "apps_app_read",
    "apps_deployment_read",
    "apps_skill_read"
  ].includes(name) || /_(?:get|grep|handbook|list|read|search|status|versions)$/.test(name)) {
    return "read";
  }

  if ([
    "tools_image_generation",
    "tools_video_generation",
    "tools_audio_tts",
    "forum_write",
    "forum_media",
    "apps_deployment_submit_listing",
    "knowledge_library_write",
    "knowledge_service_update",
    "knowledge_feedback_submit",
    "knowledge_feedback_manage",
    "apps_app_write",
    "apps_provisioning",
    "apps_deploy_prepare",
    "apps_database",
    "apps_config",
    "apps_storage",
    "apps_skill_write",
    "mate_call"
  ].includes(name)) return "write";

  const writeMarker = /_(?:apply|batch|create|decide|declare|delete|deploy|edit|initiate|move|publish|put|rename|reply|restore|retry|revoke|rollback|set|submit|update|upload)(?:_|$)/;
  if (writeMarker.test(name) || name === "forum_create_reply" || name === "knowledge_feedback_status_update") {
    return "write";
  }

  return "read";
}
