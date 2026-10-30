import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseKnowledgeTextPatch } from './knowledgeTextPatch.ts';
import { applyUnifiedTextPatch } from '../../workers/knowledge/src/textPatch.ts';

test('numbered unified hunks support context, CRLF, header-like content and multiple hunks', () => {
  const patch = '--- a/example.md\n+++ b/example.md\n@@ -1,2 +1,2 @@\n # Title\n--- old\n+++ new\n@@ -4 +4 @@\n-last\n+done\n';
  assert.equal(parseKnowledgeTextPatch(patch).length, 2);
  assert.equal(applyUnifiedTextPatch('# Title\r\n-- old\r\nkeep\r\nlast\r\n', patch), '# Title\n++ new\nkeep\ndone\n');
});
test('zero-length unified ranges insert at the correct beginning, middle and end', () => {
  for (const [patch, after] of [
    ['@@ -0,0 +1 @@\n+first', 'first\na\nb'],
    ['@@ -1,0 +2 @@\n+middle', 'a\nmiddle\nb'],
    ['@@ -2,0 +3 @@\n+last', 'a\nb\nlast'],
    ['@@ -1,1 +0,0 @@\n-a', 'b']
  ]) assert.equal(applyUnifiedTextPatch('a\nb', patch), after);
});
test('rejects production-shaped Codex patches, bare hunks, malformed counts and multiple files', () => {
  for (const [patch, code] of [
    ['*** Begin Patch\n*** Update File: example.md\n@@\n-old\n+new\n*** End Patch', 'knowledge_edit_patch_invalid'],
    ['@@\n-old\n+new', 'knowledge_edit_patch_invalid'],
    ['@@ -1,2 +1,1 @@\n-old\n+new', 'knowledge_edit_patch_count_mismatch'],
    ['--- a/example.md\n+++ b/example.md', 'knowledge_edit_patch_invalid'],
    ['@@ -0,1 +1,1 @@\n-old\n+new', 'knowledge_edit_patch_invalid'],
    ['@@ -1 +1 @@\n-old\n+new\ndiff --git a/other b/other', 'knowledge_edit_patch_invalid'],
    ['@@ -2 +2 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new', 'knowledge_edit_patch_invalid']
  ]) {
    assert.throws(() => parseKnowledgeTextPatch(patch), { code });
    assert.throws(() => applyUnifiedTextPatch('old', patch), { status: 400, code });
  }
});
test('valid syntax still requires exact current content at execution', () => {
  const patch = '@@ -1 +1 @@\n-old\n+new';
  assert.equal(parseKnowledgeTextPatch(patch).length, 1);
  assert.throws(() => applyUnifiedTextPatch('changed', patch), { status: 409, code: 'knowledge_edit_patch_context_mismatch' });
});
