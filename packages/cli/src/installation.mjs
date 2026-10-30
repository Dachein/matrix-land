import { createHash } from 'node:crypto';

export function endpoint(value, name, { mcp = false } = {}) {
  if (!value || typeof value !== 'string') throw new Error(`${name} is required; configure this workspace explicitly`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a URL`); }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash
    || !(mcp ? ['/', '/mcp', '/mcp/'] : ['/']).includes(url.pathname)) {
    throw new Error(`${name} must be an HTTPS endpoint without credentials or query parameters`);
  }
  return mcp ? `${url.origin}/mcp` : url.origin;
}

export function installationOptions(options = {}) {
  const env = options.env ?? process.env;
  const authUrl = endpoint(options.authUrl ?? env.WORKSPACE_AUTH_URL, 'authUrl');
  const mcpUrl = endpoint(options.mcpUrl ?? env.WORKSPACE_MCP_URL, 'mcpUrl', { mcp: true });
  const apiUrl = endpoint(options.apiUrl ?? env.WORKSPACE_API_URL ?? new URL(mcpUrl).origin, 'apiUrl');
  if (apiUrl !== new URL(mcpUrl).origin) throw new Error('apiUrl must use the MCP resource origin');
  return { authUrl, mcpUrl, apiUrl, installationKey: createHash('sha256').update(`${authUrl}\n${mcpUrl}`).digest('hex').slice(0, 24) };
}

export function assertCredentialInstallation(credential, options) {
  const expected = installationOptions(options);
  if (!credential || endpoint(credential.auth_url, 'credential.auth_url') !== expected.authUrl
    || endpoint(credential.resource_url, 'credential.resource_url', { mcp: true }) !== expected.mcpUrl) {
    throw new Error('Credential belongs to a different workspace; sign in to this workspace');
  }
  if (credential.token_endpoint && new URL(credential.token_endpoint).origin !== expected.authUrl) {
    throw new Error('Credential token endpoint does not belong to this workspace');
  }
}

export function extractInstallationFlags(args) {
  const rest = [], values = {};
  const flags = { '--auth-url': 'authUrl', '--api-url': 'apiUrl', '--mcp-url': 'mcpUrl' };
  for (let i = 0; i < args.length; i++) {
    const key = flags[args[i]];
    if (!key) { rest.push(args[i]); continue; }
    if (values[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid ${args[i]}`);
    values[key] = args[++i];
  }
  return { args: rest, options: values };
}
