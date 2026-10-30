export type AppsAppRow = {
  id: string;
  org_id: string;
  org_slug: string;
  owner_user_id: string;
  collaborator_user_ids_json?: string;
  ownership_sync_pending?: number;
  ownership_sync_lock_until?: string;
  name: string;
  code?: string;
  slug: string;
  description: string;
  type: string;
  status: string;
  visibility: string;
  login_required: number;
  agent_mcp_enabled?: number;
  llm_enabled?: number;
  llm_default_model?: string;
  llm_endpoint?: string;
  access_targets_json?: string;
  directory_read_scope?: string;
  data_service_id: string;
  created_at: string;
  updated_at: string;
  last_deployed_at?: string;
};

export type AppsResourceRow = {
  id: string;
  app_id: string;
  data_service_id: string;
  type: string;
  provider: string;
  resource_name: string;
  resource_id?: string;
  binding_name?: string;
  environment: string;
  status: string;
  created_at: string;
};

export type AppsAppSecretRow = {
  id: string;
  app_id: string;
  org_id: string;
  name: string;
  environment: string;
  description: string;
  required: number;
  status: string;
  cipher_text?: string;
  cipher_iv?: string;
  algorithm: string;
  configured_by?: string;
  configured_at?: string;
  declared_by: string;
  created_at: string;
  updated_at: string;
};

export type AppsDeploymentRow = {
  access_targets_json?: string;
  id: string;
  app_id: string;
  deploy_artifact_id?: string;
  source_snapshot_id?: string;
  environment: string;
  login_required?: number;
  version: string;
  version_name?: string;
  release_notes?: string;
  runtime_topology_json?: string;
  status: string;
  url?: string;
  visibility?: string;
  created_by: string;
  created_by_name?: string;
  created_at: string;
};

export type AppsDomainRow = {
  id: string;
  app_id: string;
  hostname: string;
  type: string;
  environment: string;
  status: string;
  provider?: string;
  provider_resource_id?: string;
  dns_record_id?: string;
  route_id?: string;
  certificate_status?: string;
  route_status?: string;
  fallback_url?: string;
  last_checked_at?: string;
  error_code?: string;
  error_message?: string;
  created_at: string;
};

export type AppsAppEnvVarRow = {
  app_id: string;
  created_at: string;
  created_by: string;
  environment: string;
  id: string;
  name: string;
  org_id: string;
  target: string;
  updated_at: string;
  updated_by: string;
  value: string;
};

export type AppsProvisioningJobRow = {
  id: string;
  app_id: string;
  org_id: string;
  type: string;
  status: string;
  progress: number;
  current_step?: string;
  error_code?: string;
  error_message?: string;
  requested_by: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
};

export type AppsProvisioningStepRow = {
  id: string;
  job_id: string;
  app_id: string;
  step_order: number;
  step_key: string;
  label: string;
  status: string;
  progress: number;
  resource_type?: string;
  resource_id?: string;
  error_code?: string;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
};

export type AppsSkillRow = {
  id: string;
  org_id: string;
  org_slug: string;
  owner_user_id: string;
  collaborator_user_ids_json?: string;
  ownership_sync_pending?: number;
  ownership_sync_lock_until?: string;
  name: string;
  slug: string;
  description: string;
  kind: string;
  capabilities_json: string;
  status: string;
  visibility: string;
  access_targets_json: string;
  login_required: number;
  current_version_id?: string;
  created_at: string;
  updated_at: string;
};

export type AppsSkillVersionRow = {
  id: string;
  skill_id: string;
  version: string;
  state: string;
  artifact_key: string;
  skill_md_key: string;
  manifest_key: string;
  artifact_sha256: string;
  manifest_json: string;
  frontmatter_json: string;
  file_count: number;
  size_bytes: number;
  changelog: string;
  created_by: string;
  created_at: string;
};
