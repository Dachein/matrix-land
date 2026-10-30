import assert from "node:assert/strict";
import { it } from "node:test";
import { inspectAuthModuleBoundaries } from "./auth-module-boundaries.mjs";

const inspect = (files) => inspectAuthModuleBoundaries(new Map(Object.entries(files))).problems;

it("accepts a route depending on a handler depending on its repository", () => {
  assert.deepEqual(inspect({
    "index.ts": 'import "./mcp/tokens.ts";',
    "mcp/tokens.ts": 'import { read } from "../repositories/mcp/clients.ts";',
    "repositories/mcp/clients.ts": 'import type { Env } from "../../types.ts"; export const read = () => {};',
    "types.ts": 'export interface Env {}',
    "repository.ts": 'export { read } from "./repositories/mcp/clients.ts";'
  }), []);
});

it("rejects persistence importing authorization, including type-only imports", () => {
  assert.match(inspect({
    "repositories/users/reads.ts": 'import type { User } from "../../identity/users";',
    "identity/users.ts": 'export interface User {}'
  }).join("\n"), /outside persistence ownership/);
});

it("rejects handlers routing back through the entrypoint or repository facade", () => {
  const problems = inspect({
    "mcp/tokens.ts": 'import "../index.ts"; import "../repository.ts";',
    "index.ts": '', "repository.ts": ''
  });
  assert.match(problems.join("\n"), /route entrypoint/);
  assert.match(problems.join("\n"), /compatibility facade instead/);
});

it("detects cycles through static imports, re-exports and dynamic imports", () => {
  assert.match(inspect({
    "mcp/a.ts": 'export { value } from "./b.ts";',
    "mcp/b.ts": 'export const value = () => import("./c.ts");',
    "mcp/c.ts": 'import "./a.ts";'
  }).join("\n"), /a\.ts -> mcp\/b\.ts -> mcp\/c\.ts -> mcp\/a\.ts/);
});

it("allows erased type cycles without treating mixed imports as erased", () => {
  assert.deepEqual(inspect({
    "mcp/a.ts": 'import type { B } from "./b"; export interface A {}',
    "mcp/b.ts": 'import { type A } from "./a"; export interface B {}'
  }), []);
  assert.match(inspect({
    "mcp/a.ts": 'import { type B, value } from "./b";',
    "mcp/b.ts": 'import "./a"; export const value = 1; export interface B {}'
  }).join("\n"), /runtime dependency cycle/);
});

it("rejects new business logic in the compatibility facade", () => {
  assert.match(inspect({ "repository.ts": 'export function read() {}' }).join("\n"), /re-export compatibility facade/);
});

it("keeps default imports in the runtime graph when named imports are types", () => {
  assert.match(inspect({
    "mcp/a.ts": 'import value, { type B } from "./b.js";',
    "mcp/b.ts": 'import "./a.ts"; export default 1; export interface B {}'
  }).join("\n"), /runtime dependency cycle/);
});

it("does not permit persistence to bypass ownership through external relative paths", () => {
  assert.match(inspect({
    "repositories/users/reads.ts": 'import "../../../../../src/portal/knowledge/utils.ts";'
  }).join("\n"), /outside persistence ownership/);
});
