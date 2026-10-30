// Test fixtures declare their installation explicitly; production has no vendor defaults.
export const testInstallation = Object.freeze({
  WORKSPACE_MATE_EMAIL_DOMAIN:'mate.example.invalid',WORKSPACE_EMAIL_ROUTING_DOMAIN:'mail.example.invalid',WORKSPACE_MAIL_URL:'https://mail-api.example.invalid',WORKSPACE_EMAIL_ROUTER_WORKER:'workspace-mail-worker',
  AUTH_ISSUER: 'https://auth.example.invalid', AUTH_WORKER_URL: 'https://auth.example.invalid',
  AUTH_PUBLIC_URL: 'https://ai.example.invalid', PORTAL_URL: 'https://ai.example.invalid',
  LITELLM_URL: 'https://token.example.invalid', APPS_BASE_DOMAIN: 'example.invalid',
  PLATFORM_MCP_URL: 'https://apps.example.invalid/mcp', APPS_CONTROL_PLANE_URL: 'https://apps.example.invalid',
  MATE_WEB_HOST_URL:'https://ai.example.invalid',
  MATE_RUNTIME_URL: 'https://runtime.example.invalid', MCP_RESOURCE_URL: 'https://mcp.example.invalid',
  KNOWLEDGE_WORKER_URL: 'https://knowledge.example.invalid', WORKSPACE_ORG_ID: 'example-org'
});
