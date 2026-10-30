import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeV2Flags } from "./knowledge-v2-flags.ts";

test("Knowledge Service V2 paths fail closed until explicitly enabled", () => {
  assert.deepEqual(knowledgeV2Flags({}), {
    indexRead: false,
    mutationSpine: false,
    rootAcl: false,
    shadowRead: false
  });
  assert.deepEqual(knowledgeV2Flags({
    KNOWLEDGE_V2_INDEX_READ_ENABLED: "true",
    KNOWLEDGE_V2_MUTATION_SPINE_ENABLED: "0",
    KNOWLEDGE_V2_ROOT_ACL_ENABLED: " 1 ",
    KNOWLEDGE_V2_SHADOW_READ_ENABLED: "1"
  }), {
    indexRead: false,
    mutationSpine: false,
    rootAcl: true,
    shadowRead: true
  });
});
