import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalCardStatus, approvalPresentation, mergeApprovalStates } from './approvalPresentation.ts';
const t = (zh) => zh;
const approval = (args, overrides = {}) => ({ id: 'a', status: 'pending', releaseId: 'r', expiresAt: '2099-01-01', operation: { type: 'workspace_knowledge_maintenance', toolName: 'knowledge_library_write', arguments: { action: 'edit', ...args } }, ...overrides });

test('append and replacement previews preserve exact text and describe their limited scope', () => {
  const raw = '\n## Fees\n\n| Product | Rate |\n| --- | --- |\n| Bond | 1% |\n<<FILE:literal>>';
  const append = approvalPresentation(approval({ operation: 'append_text', text: raw }), t);
  assert.equal(append.preview, raw);
  assert.equal(append.previewLabel, '本次新增内容');
  assert.equal(append.removals, 0);
  const replace = approvalPresentation(approval({ operation: 'replace_text', oldText: 'Old', newText: 'New', expectedOccurrences: 2 }), t);
  assert.deepEqual(replace.diff.map(x => x.kind), ['removed', 'added']);
  assert.match(replace.note, /2 处/);
  const full = approvalPresentation(approval({ operation: 'replace_content', contentText: '# Full replacement' }), t);
  assert.equal(full.diff.length, 0);
  assert.match(full.note, /未包含原文/);
});

test('patch headers do not count as edits and preview keeps separate hunks', () => {
  const patch = '--- a/policy.md\n+++ b/policy.md\n@@ -1 +1 @@\n-Old\n+**New**\n@@ -8 +8 @@\n-Other\n+Updated';
  const value = approvalPresentation(approval({ operation: 'apply_patch', patch }), t);
  assert.match(value.title, /policy.md/);
  assert.equal(value.additions, 2);
  assert.equal(value.removals, 2);
  assert.ok(!value.preview.includes('Old'));
  assert.ok(value.preview.includes('**New**'));
  assert.match(value.note, /片段/);
});

test('authoritative metadata identifies the target and unknown tools retain raw-detail fallback', () => {
  const a = approval({}, { operation: { type: 'workspace_knowledge_maintenance', toolName: 'knowledge_library_write', arguments: { action: 'edit' }, display: { fileName: 'policy.md', path: '/Research/policy.md' } } });
  assert.equal(approvalPresentation(a, t).path, '/Research/policy.md');
  assert.match(approvalPresentation(a, t).title, /policy.md/);
  const other = approval({}, { operation: { type: 'remote_mcp', toolName: 'custom_action' } });
  assert.equal(approvalPresentation(other, t).diff.length, 0);
});

test('approval alone cannot claim success; expiry, refusal and task failure stay distinct', () => {
  assert.equal(approvalCardStatus(approval({}, { status: 'consumed' })), 'executing');
  assert.equal(approvalCardStatus(approval({}, { status: 'approved' })), 'executing');
  assert.equal(approvalCardStatus(approval({}, { expiresAt: '2000-01-01' })), 'expired');
  assert.equal(approvalCardStatus(approval({}, { status: 'denied' })), 'denied');
  assert.equal(approvalCardStatus(approval({}, { status: 'consumed', task: { status: 'failed' } })), 'failed');
});

test('late reads cannot undo a decision, lose results or change card order', () => {
  const a = approval({}, { status: 'consumed', task: { status: 'completed' } });
  const b = approval({}, { id: 'b' });
  const merged = mergeApprovalStates([a, b], [b, approval({})]);
  assert.deepEqual(merged.map(x => x.id), ['a', 'b']);
  assert.equal(merged[0].status, 'consumed');
  assert.equal(merged[0].task.status, 'completed');
  assert.equal(merged[1].status, 'pending');
  assert.equal(mergeApprovalStates([a], [{ ...a, task: undefined }])[0].task.status, 'completed');
});

test('header-like Markdown inside a hunk remains an actual change in the preview', () => {
  const value = approvalPresentation(approval({ operation: 'apply_patch', patch: '--- a/example.md\n+++ b/example.md\n@@ -1 +1 @@\n--- old\n+++ new' }), t);
  assert.equal(value.additions, 1);
  assert.equal(value.removals, 1);
  assert.equal(value.preview, '++ new');
});
