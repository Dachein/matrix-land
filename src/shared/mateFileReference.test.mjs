import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mateFileReference,
  mateFileReferenceFromUrl,
  mateFileReferencesFromCitations,
  mateFileReferencesFromTool
} from "./mateFileReference.js";

test("one authenticated Workspace route identifies uploaded and Knowledge files", () => {
  const uploaded = mateFileReference("art_12345678-1234-1234-1234-123456789abc", "photo.png");
  const knowledge = mateFileReference("kobj_policy-1", "policy.pdf");
  assert.equal(uploaded.source, "workspace");
  assert.equal(uploaded.url, "/api/workspace-files/art_12345678-1234-1234-1234-123456789abc/download");
  assert.equal(knowledge.source, "knowledge");
  assert.equal(knowledge.url, "/api/workspace-files/kobj_policy-1/download");
  assert.deepEqual(mateFileReferenceFromUrl("/api/workspace-files/kobj_policy-1/raw", "policy.pdf"), knowledge);
  assert.equal(mateFileReferenceFromUrl("https://example.com/api/workspace-files/kobj_policy-1/raw", "policy.pdf"), undefined);
  assert.equal(mateFileReference("../other", "unsafe"), undefined);
});

test("tool results create stable file links only when an object id exists", () => {
  const read = mateFileReferencesFromTool("knowledge_file_read", { file: { objectId: "kobj_policy-1", fileName: "policy.pdf" } });
  assert.equal(read[0].url, "/api/workspace-files/kobj_policy-1/download");
  const generated = mateFileReferencesFromTool("workspace_file_create", { file: { objectId: "art_12345678-1234-1234-1234-123456789abc", fileName: "report.md" } });
  assert.equal(generated[0].source, "workspace");
  assert.deepEqual(mateFileReferencesFromTool("workspace_file_save_to_knowledge", {
    knowledgeFile: { objectId: "kobj_saved-1", fileName: "report.md" }
  }), [mateFileReference("kobj_saved-1", "report.md")]);
  assert.deepEqual(mateFileReferencesFromTool("knowledge_file_read", { file: { fileName: "no-id.pdf" } }), []);
  assert.deepEqual(mateFileReferencesFromTool("knowledge_file_read", { file: { id: "citation-only", fileName: "citation.pdf" } }), []);
  assert.deepEqual(mateFileReferencesFromTool("knowledge_folder_file_read", { item: { id: "viewer-file", name: "Guide.md" } }), [
    mateFileReference("viewer-file", "Guide.md")
  ]);
  assert.deepEqual(mateFileReferencesFromTool("knowledge_folder_list", { items: [
    { id: "viewer-root", kind: "folder", name: "Shared" }, { id: "viewer-file", kind: "file", name: "Guide.md" }
  ] }), [mateFileReference("viewer-file", "Guide.md")]);
  assert.deepEqual(mateFileReferencesFromCitations({ sources: [{ objectId: "kobj_policy-1", relativePath: "policies/policy.pdf" }] }), [
    mateFileReference("kobj_policy-1", "policy.pdf")
  ]);
  assert.deepEqual(mateFileReferencesFromCitations({ sources: [{ relativePath: "policies/missing.pdf" }] }), []);
});
