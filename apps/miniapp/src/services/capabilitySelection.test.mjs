import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCapabilitySelection } from "./capabilitySelection.ts";
const profile = { appMcp: Array.from({length:40}, (_, i) => ({id:`app-${i}`})), knowledge: Array.from({length:20}, (_, i) => ({id:`kb-${i}`})), models: {allowUserSelection:false, defaultModel:"default", allowed:[{id:"default"},{id:"other"}]} };
test("caps default resource selection to protocol limits", () => {
  const selection = normalizeCapabilitySelection(profile);
  assert.equal(selection.appIds.length, 32); assert.equal(selection.knowledgeServiceIds.length, 12);
});
test("preserves explicit empty scopes and removes unavailable or forbidden selections", () => {
  const selection = normalizeCapabilitySelection(profile, {appIds:["missing","app-1"],knowledgeServiceIds:[],modelId:"other"});
  assert.deepEqual(selection.appIds,["app-1"]); assert.deepEqual(selection.knowledgeServiceIds,[]); assert.equal(selection.modelId,"default");
});
