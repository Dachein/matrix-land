import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeMaintenanceUpstreamError, validateKnowledgeEditPatch } from './knowledgeMaintenanceErrors.ts';
const error = (status, payload) => knowledgeMaintenanceUpstreamError(status, JSON.stringify(payload), 'knowledge_maintenance_write_failed');

test('preserves direct and MCP-wrapped Knowledge error codes and request identifiers', () => {
  for (const [status, code] of [[400, 'knowledge_edit_patch_invalid'], [409, 'knowledge_object_version_conflict'], [403, 'folder_edit_access_denied']]) {
    const direct = error(status, { error: code, requestId: 'knowledge-request' });
    assert.equal(direct.status, status);
    assert.equal(direct.code, code);
    const nested = error(status, { error: 'knowledge_worker_request_failed', requestId: 'mcp-request', message: JSON.stringify({ error: code, requestId: 'knowledge-request', message: 'private document content' }) });
    assert.equal(nested.code, code);
    assert.deepEqual(nested.details, { upstreamStatus: status, upstreamCode: 'knowledge_worker_request_failed', requestId: 'mcp-request', causeRequestId: 'knowledge-request' });
    assert.doesNotMatch(JSON.stringify(nested), /private document content/);
  }
});
test('malformed or truncated upstream bodies retain status without leaking raw text', () => {
  for (const raw of ['<html>secret credential</html>', '{"error":', 'null', '[]', 'x'.repeat(9000)]) {
    const result = knowledgeMaintenanceUpstreamError(503, raw, 'knowledge_maintenance_write_failed');
    assert.equal(result.status, 502);
    assert.equal(result.code, 'knowledge_maintenance_write_failed');
    assert.deepEqual(result.details, { upstreamStatus: 503 });
  }
  const result = error(400, { error: 'knowledge_worker_request_failed', message: '{"error":"knowledge_edit_', requestId: 'invalid secret / value' });
  assert.equal(result.code, 'knowledge_worker_request_failed');
  assert.deepEqual(result.details, { upstreamStatus: 400, upstreamCode: 'knowledge_worker_request_failed' });
});
test('validation preserves supported patch aliases and ignores non-patch edits', () => {
  for (const key of ['patch', 'patchText', 'text']) validateKnowledgeEditPatch({ operation: 'apply_patch', [key]: '@@ -1 +1 @@\n-a\n+b' });
  validateKnowledgeEditPatch({ operation: 'append_text', text: '*** Begin Patch' });
  assert.throws(() => validateKnowledgeEditPatch({ operation: 'apply_patch', patch: '@@\n-a\n+b' }), error => error.code === 'knowledge_edit_patch_invalid' && /unified diff/.test(error.details.guidance));
});
