import assert from "node:assert/strict";
import test from "node:test";
import {
  canDeleteKnowledgeItem,
  canDirectlyEditKnowledgeItem,
  canManageKnowledgeAccess,
  canManageKnowledgeService,
  canRenameKnowledgeItem,
  canUpdateKnowledgeServiceInfo,
  knowledgeAgentHandoffText,
  knowledgeSharingScope,
  knowledgeWorkspaceAgentPrompt,
  knowledgeServiceAccessPayload,
  knowledgeVersionUploadFormData,
  normalizeApiItem,
  normalizeKnowledgeServiceAccess
} from "./utils.ts";

test("builds canonical MCP handoffs for Knowledge folders and files", () => {
  const folder = normalizeApiItem({ id: "folder-1", kind: "folder", name: "Research" });
  const file = normalizeApiItem({ id: "file-1", kind: "markdown", name: "notes.md" });

  const folderPrompt = knowledgeAgentHandoffText(folder, "我的知识库 / Research", "zh-CN");
  assert.match(folderPrompt, /文件夹路径：我的知识库 \/ Research/);
  assert.match(folderPrompt, /knowledge_list/);
  assert.match(folderPrompt, /folderObjectId="folder-1"/);

  const filePrompt = knowledgeAgentHandoffText(file, "My Knowledge / Research / notes.md", "en");
  assert.match(filePrompt, /File path: My Knowledge \/ Research \/ notes\.md/);
  assert.match(filePrompt, /knowledge_file_read with objectId="file-1"/);
});

test("builds the permission-bound workspace prompt for asking and maintenance", () => {
  const prompt = knowledgeWorkspaceAgentPrompt("zh-CN");

  assert.match(prompt, /当前连接用户的权限为边界/);
  assert.match(prompt, /knowledge_list/);
  assert.match(prompt, /knowledge_query/);
  assert.match(prompt, /knowledge_file_read/);
  assert.match(prompt, /knowledge_service_handbook/);
  assert.match(prompt, /folderObjectId/);
  assert.match(prompt, /knowledge_library_write/);
  assert.match(prompt, /删除必须获得我的明确确认/);
  assert.match(prompt, /Frontier Workspace How To/);
});

test("normalizes the current version id returned by the Knowledge API", () => {
  const item = normalizeApiItem({
    currentVersionId: "kver-current",
    effectiveRole: "owner",
    id: "kobj-file",
    kind: "markdown",
    name: "provenance.md"
  });

  assert.equal(item.currentVersionId, "kver-current");
});

test("describes root sharing as a folder property instead of the current user's role", () => {
  const privateRoot = normalizeApiItem({
    collaboratorCount: 0,
    effectiveRole: "owner",
    id: "private-root",
    kind: "folder",
    name: "Private"
  });
  const collaborativeRoot = normalizeApiItem({
    collaboratorCount: 3,
    effectiveRole: "owner",
    id: "collaborative-root",
    kind: "folder",
    name: "Collaborative"
  });
  const sharedRoot = normalizeApiItem({
    effectiveRole: "viewer",
    id: "shared-root",
    kind: "folder",
    name: "Shared"
  });

  assert.deepEqual(knowledgeSharingScope(privateRoot), { count: 0, kind: "private" });
  assert.deepEqual(knowledgeSharingScope(collaborativeRoot), { count: 3, kind: "collaboration" });
  assert.deepEqual(knowledgeSharingScope(sharedRoot), { count: 0, kind: "shared" });
});

test("a collaborator never sees a shared folder mislabeled as private during mixed-version rollout", () => {
  const collaboratorRoot = normalizeApiItem({
    effectiveRole: "collaborator",
    id: "collaborator-root",
    kind: "folder",
    name: "Collaborator"
  });

  assert.deepEqual(knowledgeSharingScope(collaboratorRoot), { count: 1, kind: "collaboration" });
});

test("includes the current version id in Portal version upload requests", () => {
  const file = new File(["updated"], "provenance.md", { type: "text/markdown" });
  const formData = knowledgeVersionUploadFormData(file, "kver-current");

  assert.equal(formData.get("expectedCurrentVersionId"), "kver-current");
  assert.equal(formData.get("file"), file);
});

test("refuses to send a version upload without the compare-and-swap guard", () => {
  const file = new File(["updated"], "provenance.md", { type: "text/markdown" });

  assert.throws(
    () => knowledgeVersionUploadFormData(file, ""),
    /knowledge_current_version_missing/
  );
});

test("Portal direct Edit is limited to the AI-safe textual file matrix", () => {
  const base = normalizeApiItem({
    capabilities: { canEdit: true },
    effectiveRole: "collaborator",
    id: "file-1",
    kind: "text",
    name: "records.jsonl"
  });

  assert.equal(canDirectlyEditKnowledgeItem(base), true);
  assert.equal(canDirectlyEditKnowledgeItem({ ...base, name: "records.ndjson" }), true);
  assert.equal(canDirectlyEditKnowledgeItem({ ...base, name: "report.pdf" }), false);
  assert.equal(canDirectlyEditKnowledgeItem({ ...base, name: "photo.png" }), false);
  assert.equal(canDirectlyEditKnowledgeItem({
    ...base,
    capabilities: { ...base.capabilities, canEdit: false }
  }), false);
});

test("Knowledge Service access treats no Viewer grants as private", () => {
  assert.deepEqual(
    normalizeKnowledgeServiceAccess({
      company: false,
      departments: [],
      users: []
    }),
    { mode: "private", targets: [] }
  );
  assert.deepEqual(knowledgeServiceAccessPayload("private", []), {
    company: false,
    departments: [],
    users: []
  });
});

test("Knowledge Service access preserves company and targeted Viewer modes", () => {
  assert.deepEqual(
    normalizeKnowledgeServiceAccess({
      company: true,
      departments: [],
      users: []
    }),
    { mode: "company", targets: [] }
  );
  assert.deepEqual(
    normalizeKnowledgeServiceAccess({
      company: false,
      departments: ["dept-1"],
      users: ["user-1"]
    }),
    {
      mode: "targeted",
      targets: ["department:dept-1", "user:user-1"]
    }
  );
  assert.deepEqual(
    knowledgeServiceAccessPayload("targeted", ["department:dept-1", "user:user-1"]),
    {
      company: false,
      departments: ["dept-1"],
      users: ["user-1"]
    }
  );
});

test("Knowledge Service Card can be updated by Root Collaborators but not Viewers", () => {
  const collaborator = normalizeApiItem({
    agentEnabled: true,
    capabilities: {
      canManageKnowledgeService: false,
      canUpdateKnowledgeServiceInfo: true
    },
    effectiveRole: "collaborator",
    id: "service-root",
    kind: "folder",
    knowledgeServiceId: "service-1",
    name: "Partner Banking",
    parentPath: ""
  });

  assert.equal(canManageKnowledgeService(collaborator), false);
  assert.equal(canUpdateKnowledgeServiceInfo(collaborator), true);
  assert.equal(canUpdateKnowledgeServiceInfo({
    ...collaborator,
    capabilities: {
      ...collaborator.capabilities,
      canUpdateKnowledgeServiceInfo: false
    },
    effectiveRole: "viewer"
  }), false);
});

test("nested folders fail closed for Root-only collaborator and Agent Knowledge controls", () => {
  const nestedFolder = normalizeApiItem({
    agentEnabled: true,
    capabilities: {
      canManageAccess: true,
      canManageKnowledgeService: true,
      canUseKnowledgeService: true
    },
    effectiveRole: "owner",
    id: "nested-folder",
    kind: "folder",
    name: "Research",
    parentPath: "PB Partner"
  });

  assert.equal(nestedFolder.capabilities.canManageAccess, false);
  assert.equal(nestedFolder.capabilities.canManageKnowledgeService, false);
  assert.equal(nestedFolder.capabilities.canUseKnowledgeService, true);
  assert.equal(nestedFolder.agentEnabled, false);
  assert.equal(nestedFolder.withinKnowledgeService, true);
  assert.deepEqual(nestedFolder.accessKinds, []);
  assert.equal(canManageKnowledgeAccess(nestedFolder), false);
  assert.equal(canManageKnowledgeService(nestedFolder), false);

  const staleNestedFolder = {
    ...nestedFolder,
    capabilities: {
      ...nestedFolder.capabilities,
      canManageAccess: true,
      canManageKnowledgeService: true
    }
  };

  assert.equal(canManageKnowledgeAccess(staleNestedFolder), false);
  assert.equal(canManageKnowledgeService(staleNestedFolder), false);
});

test("a disabled Root service id is not mistaken for inherited Agent Knowledge", () => {
  const disabledRoot = normalizeApiItem({
    agentEnabled: false,
    effectiveRole: "owner",
    id: "disabled-root",
    kind: "folder",
    knowledgeServiceId: "disabled-service",
    name: "Archive",
    parentPath: ""
  });

  assert.equal(disabledRoot.agentEnabled, false);
  assert.equal(disabledRoot.withinKnowledgeService, false);
  assert.equal(disabledRoot.capabilities.canUseKnowledgeService, false);
});

test("top-level folder mutations require the protected-structure capability", () => {
  const root = normalizeApiItem({
    agentEnabled: true,
    capabilities: {
      canEdit: true,
      canManageProtectedStructure: true
    },
    effectiveRole: "owner",
    id: "active-root",
    kind: "folder",
    name: "Active Root",
    parentPath: ""
  });

  assert.equal(canDeleteKnowledgeItem(root), false);
  assert.equal(canRenameKnowledgeItem(root), false);
  assert.equal(canDeleteKnowledgeItem({
    ...root,
    agentEnabled: false,
    withinKnowledgeService: false
  }), true);
  assert.equal(canRenameKnowledgeItem({
    ...root,
    agentEnabled: false,
    withinKnowledgeService: false
  }), true);
  assert.equal(canDeleteKnowledgeItem({
    ...root,
    capabilities: { ...root.capabilities, canManageProtectedStructure: false }
  }), false);
});
