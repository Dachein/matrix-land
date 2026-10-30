import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectDesignCss, inspectPrimitive } from "./design-system-check.mjs";

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
