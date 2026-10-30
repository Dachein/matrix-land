import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseKnowledgeService,
  hasKnowledgeCapability,
  knowledgeCapabilitiesForRole
} from "./knowledge-capabilities.ts";

const expected = {
  owner: [
    "readContent",
    "editContent",
    "manageAccess",
    "manageService",
    "updateServiceInfo",
    "manageProtectedStructure",
    "transferOwnership",
    "createPublicShare",
    "readChangeAudit"
  ],
  collaborator: [
    "readContent",
    "editContent",
    "updateServiceInfo",
    "readChangeAudit"
  ],
  viewer: [
    "readContent"
  ],
  none: []
};

test("Knowledge Service role capabilities preserve the Owner and Collaborator boundary", () => {
  for (const [role, capabilities] of Object.entries(expected)) {
    assert.deepEqual(knowledgeCapabilitiesForRole(role), capabilities);
  }
  assert.equal(hasKnowledgeCapability("collaborator", "manageAccess"), false);
  assert.equal(hasKnowledgeCapability("collaborator", "manageService"), false);
  assert.equal(hasKnowledgeCapability("collaborator", "updateServiceInfo"), true);
  assert.equal(hasKnowledgeCapability("collaborator", "transferOwnership"), false);
});

test("disabled Services are unavailable to every role", () => {
  assert.equal(canUseKnowledgeService("owner", false), false);
  assert.equal(canUseKnowledgeService("collaborator", false), false);
  assert.equal(canUseKnowledgeService("viewer", false), false);
  assert.equal(canUseKnowledgeService("viewer", true), true);
  assert.equal(canUseKnowledgeService("none", true), false);
});
