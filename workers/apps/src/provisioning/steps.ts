export type ProvisioningStepTemplate = {
  key: string;
  label: string;
  progress: number;
  resourceTypes?: string[];
};

export const CREATE_APP_STEPS: ProvisioningStepTemplate[] = [
  { key: "validate_request", label: "验证应用配置", progress: 5 },
  { key: "create_registry", label: "写入 APPS 应用注册表", progress: 12 },
  { key: "register_auth", label: "注册预发布 Auth Client", progress: 18 },
  {
    key: "create_data",
    label: "创建 Agent 应用资源",
    progress: 38,
    resourceTypes: ["d1_database", "hyperdrive_config", "schema_registry"]
  },
  {
    key: "create_storage",
    label: "创建存储与配置资源",
    progress: 52,
    resourceTypes: ["r2_bucket", "kv_namespace"]
  },
  {
    key: "create_runtime",
    label: "创建运行资源",
    progress: 68,
    resourceTypes: [
      "pages_project",
      "pages_function",
      "worker",
      "media",
      "cron_trigger",
      "queue"
    ]
  },
  { key: "configure_routes", label: "配置正式与 MCP 入口", progress: 82 },
  { key: "health_check", label: "执行健康检查", progress: 96 },
  { key: "finalize_manifest", label: "生成资源清单", progress: 100 }
];
