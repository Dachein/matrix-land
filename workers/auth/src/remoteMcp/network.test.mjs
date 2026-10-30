import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare';

test('remote MCP fetch runs in Workers and rejects redirects without forwarding credentials', async t => {
  const bundle = await build({
    stdin: { contents: `
      import { remoteFetch } from './workers/auth/src/remoteMcp/network.ts';
      export default { async fetch(request) {
        try {
          const response = await remoteFetch({ REMOTE_MCP_ALLOWED_HOSTS: 'mcp.provider.test' },
            'https://mcp.provider.test' + new URL(request.url).pathname,
            { method: 'POST', headers: { Authorization: 'Bearer test-credential' } });
          return Response.json({ status: response.status, challenge: response.headers.get('WWW-Authenticate') });
        } catch (error) { return Response.json({ error: error.code || error.message }); }
      } };
    `, resolveDir: process.cwd() },
    bundle: true, format: 'esm', write: false,
  });
  const requests = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-06-16',
    script: bundle.outputFiles[0].text, outboundService: request => {
      requests.push(request.url);
      assert.equal(request.headers.get('authorization'), 'Bearer test-credential');
      assert.equal(new URL(request.url).hostname, 'mcp.provider.test');
      return new URL(request.url).pathname === '/mcp'
        ? new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.provider.test/metadata"' } })
        : new Response('', { status: 307, headers: { Location: 'https://unapproved.test/token' } });
    } }));
  t.after(() => mf.dispose());
  assert.deepEqual(await (await mf.dispatchFetch('http://worker.test/mcp')).json(), {
    status: 401, challenge: 'Bearer resource_metadata="https://mcp.provider.test/metadata"',
  });
  assert.deepEqual(await (await mf.dispatchFetch('http://worker.test/redirect')).json(), {
    error: 'remote_mcp_redirect_not_allowed',
  });
  assert.deepEqual(requests, ['https://mcp.provider.test/mcp', 'https://mcp.provider.test/redirect']);
});
