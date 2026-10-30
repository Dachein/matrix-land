import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAccessTargetLookup, buildAccessTargetTree } from "./accessTargets.ts";
import { loadAccessTargetDirectory } from "./accessTargetDirectory.ts";

const departments = [
  { id: "company", name: "Workspace", path: ["company"] },
  { id: "group", name: "Group", parentId: "company", path: ["company", "group"] },
  { id: "hr", name: "HR", parentId: "group", path: ["company", "group", "hr"] },
  { id: "sales", name: "Sales", parentId: "company", path: ["company", "sales"] },
  { id: "empty", name: "Empty team", parentId: "group", path: ["company", "group", "empty"] }
];
const users = [
  { id: "ada", email: "ada@example.test", name: "Ada", department: "HR", departmentId: "hr", departmentPath: ["company", "group", "hr"] },
  { id: "bob", email: "bob@example.test", name: "Bob", department: "Sales", departmentId: "sales", departmentPath: ["company", "sales"] }
];
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children)]);

describe("canonical access-target directory", () => {
  it("retains empty departments and attaches leaf-name people by ID without relabeling the company", () => {
    const tree = buildAccessTargetTree(users, "Organization", departments);
    const nodes = flatten(tree.children);
    assert.equal(nodes.length, departments.length);
    assert.equal(tree.children[0].label, "Workspace");
    assert.equal(tree.children[0].value, "department:company");
    assert.deepEqual(nodes.find(n => n.value === "department:hr").users.map(u => u.id), ["ada"]);
    assert.deepEqual(nodes.find(n => n.value === "department:sales").users.map(u => u.id), ["bob"]);
    assert.deepEqual(nodes.find(n => n.value === "department:empty").users, []);
    assert.equal(buildAccessTargetLookup(users, departments).departments.get("department:hr").label, "Workspace / Group / HR");
  });

  it("keeps identically named leaves in separate branches and includes departments with no people at all", () => {
    const tree = buildAccessTargetTree([], "Organization", [...departments, { id: "sales-hr", name: "HR", parentId: "sales" }]);
    assert.equal(flatten(tree.children).filter(n => n.label === "HR").length, 2);
    assert.equal(flatten(tree.children).length, 6);
  });

  it("keeps legacy orphan nodes visible without inventing a grant for their inactive parent", () => {
    const tree = buildAccessTargetTree([{ id: "unknown", email: "unknown@example.test", departmentId: "missing" }], "Organization", [
      { id: "inactive", name: "Old company", status: "inactive" },
      { id: "legacy", name: "Legacy team", parentId: "inactive" }
    ]);
    assert.deepEqual(tree.children.map(n => n.value), ["department:legacy"]);
    assert.deepEqual(tree.users.map(u => u.id), ["unknown"]);
    assert.equal(buildAccessTargetTree(users, "Organization", []).children.length, 0);
  });

  it("cannot bind a leaf name to an ancestor ID even without the department directory", () => {
    const tree = buildAccessTargetTree(users);
    assert.deepEqual(tree.children.map(n => n.value).sort(), ["department:hr", "department:sales"]);
    assert.equal(flatten(tree.children).some(n => n.value === "department:company"), false);
  });

  it("renders malformed cycles without losing departments or recursing indefinitely", () => {
    const tree = buildAccessTargetTree([], "Organization", [
      { id: "a", name: "A", parentId: "b" }, { id: "b", name: "B", parentId: "a" }
    ]);
    assert.equal(flatten(tree.children).length, 2);
  });

  it("loads both independent directories and accepts a valid empty people list", async () => {
    const urls = [];
    const result = await loadAccessTargetDirectory(async url => {
      urls.push(url);
      return Response.json(url.endsWith("/departments") ? { departments } : { users: [] });
    });
    assert.equal(urls.length, 2);
    assert.deepEqual(result, { departments, users: [] });
  });

  it("rejects outages, malformed payloads and capped lists instead of silently authorizing a partial directory", async () => {
    for (const bad of [new Response("", { status: 503 }), Response.json({}), Response.json({ departments: [{ id: "missing-name" }] }),
      Response.json({ departments: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: "Department" })) })]) {
      await assert.rejects(loadAccessTargetDirectory(async url => url.endsWith("/departments") ? bad.clone() : Response.json({ users })), /access_targets_/);
    }
  });
});
