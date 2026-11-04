import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectDesignCss, inspectFocusCss, inspectPrimitive } from "./design-system-check.mjs";

test("new UI rejects literal palette, undefined tokens and ad hoc design scales", () => {
  const violations = inspectDesignCss('.fw-scope .x { color: #f00; padding: 13px; margin: var(--fw-space-missing); }');
  assert.equal(violations.length, 4);
  assert.deepEqual(inspectDesignCss('.fw-scope .x { color: var(--fw-color-text); padding: var(--fw-space-4); margin: 0; }'), []);
});
test("visual exceptions cannot silently add dark mode or arbitrary breakpoints", () => {
  assert.equal(inspectDesignCss('@media (prefers-color-scheme: dark) { .x { display: block; } }').length, 1);
  assert.equal(inspectDesignCss('@media (max-width: 777px) { .x { display: block; } }').length, 1);
  assert.deepEqual(inspectDesignCss('@media (max-width: 760px) { .x { display: block; } }'), []);
});
test("primitives cannot depend on routes or perform business requests", () => {
  assert.equal(inspectPrimitive('import { User } from "../users/api"; fetch("/api/users");', 'Example.tsx').length, 2);
  assert.deepEqual(inspectPrimitive('import { useState } from "react"; export function Field() { return <input />; }', 'Field.tsx'), []);
});

test("focus frames cannot return through primitives, dropdowns or composite fields", () => {
  for (const selector of ['input:focus', '.dropdown:focus-visible', '.search:focus-within']) {
    assert.equal(inspectFocusCss(`${selector} { outline: 2px solid var(--focus); }`).length, 1);
    assert.equal(inspectFocusCss(`${selector} { box-shadow: inset 0 0 0 2px var(--focus); }`).length, 1);
    assert.equal(inspectFocusCss(`${selector} { box-shadow: 0px 0px 0px 3px var(--focus); }`).length, 1);
    assert.deepEqual(inspectFocusCss(`${selector} { outline: 0; border-bottom-color: var(--focus); box-shadow: inset 0 -2px 0 var(--focus); }`), []);
  }
  assert.deepEqual(inspectFocusCss('.dialog { box-shadow: 0 0 0 1px var(--border); }'), []);
});
