import assert from "node:assert/strict";
import { test } from "node:test";
import { designTokens, renderDesignTokensCss } from "./tokens.ts";
import { portalTokenAliases, renderPortalTokensCss } from "./portalTokens.ts";
import { platformCssVariables } from "../../shared/platformPalette.ts";

for (const runtime of [false, true]) test(`compatibility tokens resolve without cycles ${runtime ? "with" : "before"} the brand provider`, () => {
  const inputs = platformCssVariables();
  const values = {
    ...Object.fromEntries(Object.entries(designTokens).map(([key, value]) => [`--fw-${key}`, value])),
    ...Object.fromEntries(Object.entries(portalTokenAliases).map(([key, value]) => [`--${key}`, value])),
    ...(runtime ? inputs : {})
  };
  function visit(key, ancestors = []) {
    if (!(key in values) && key in inputs) return;
    assert.ok(key in values, `Missing ${key}, referenced by ${ancestors.at(-1)}`);
    assert.ok(!ancestors.includes(key), `Cycle: ${[...ancestors, key].join(" → ")}`);
    for (const match of values[key].matchAll(/var\(\s*(--[\w-]+)/g)) visit(match[1], [...ancestors, key]);
  }
  for (const key of Object.keys(values)) visit(key);
});

test("legacy names contain no second authored palette and tokens cover body-level portals", () => {
  assert.doesNotMatch(renderPortalTokensCss(), /#[\da-f]{3,8}\b|rgba?\(/i);
  assert.match(renderDesignTokensCss(), /:root, \.fw-scope/);
  assert.equal(portalTokenAliases["portal-signal"], "var(--fw-color-action)");
  assert.equal(portalTokenAliases["portal-rose"], "var(--fw-color-danger)");
  assert.equal(portalTokenAliases["portal-green"], "var(--fw-color-success)");
});
