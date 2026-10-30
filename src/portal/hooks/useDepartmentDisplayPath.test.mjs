import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDepartmentDisplayPath } from "./useDepartmentDisplayPath.ts";

describe("department display path", () => {
  const departments = [
    { id: "dept-root", name: "Workspace Wealth Group Limited" },
    { id: "dept-group", name: "Group" },
    { id: "dept-ai", name: "AI Adoption" }
  ];

  it("excludes the organization root and retains every lower level", () => {
    assert.equal(formatDepartmentDisplayPath({
      departmentPath: ["dept-root", "dept-group", "dept-ai"]
    }, departments), "Group/AI Adoption");
  });

  it("does not guess a path when a department is missing", () => {
    assert.equal(formatDepartmentDisplayPath({
      departmentPath: ["dept-root", "dept-missing", "dept-ai"]
    }, departments), undefined);
  });

  it("prefers the server-resolved display path for the current user", () => {
    assert.equal(formatDepartmentDisplayPath({
      departmentDisplayPath: "Group/AI Adoption",
      departmentPath: ["dept-root", "dept-group", "dept-ai"]
    }, []), "Group/AI Adoption");
  });
});
