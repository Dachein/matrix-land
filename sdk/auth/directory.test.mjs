import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WorkspaceAuthDirectory,
  WorkspaceAuthSdkError,
  hasDepartmentAccess,
  requireDepartmentAccess
} from "./index.ts";

describe("WorkspaceAuthDirectory", () => {
  it("queries the policy-filtered organization directory with App Basic auth", async () => {
    const calls = [];
    const directory = new WorkspaceAuthDirectory({
      appId: "app-people",
      appSecret: "directory-test-app-secret-at-least-32",
      authOrigin: "https://auth.example.test",
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        if (new URL(request.url).pathname.endsWith("/departments")) {
          return Response.json({ appId: "app-people", departments: [], directoryReadScope: "app", policyFiltered: true });
        }
        if (new URL(request.url).pathname.endsWith("/people")) {
          return Response.json({ appId: "app-people", count: 0, directoryReadScope: "app", hasMore: false, people: [], policyFiltered: true });
        }
        if (new URL(request.url).pathname.endsWith("/people/person-1")) {
          return Response.json({
            appId: "app-people",
            directoryReadScope: "company",
            person: { id: "person-1", name: "Ada" },
            policyFiltered: false
          });
        }
        return Response.json({
          allowed: true,
          appId: "app-people",
          decision: "allow",
          policyVersion: "app-access-v1",
          reason: "allowed_target_match",
          systemRolePolicyVersion: "2026-08-17T09:30:00.000Z",
          systemRoles: ["app_collaborator"],
          user: { id: "user-1" }
        });
      }
    });

    await directory.listDepartments({ q: "investment", limit: 50 });
    await directory.listPeople({ departmentId: "dept-investment", includeDescendants: true, limit: 25 });
    const person = await directory.getPerson("person-1");
    const access = await directory.checkAccess("user-1");

    assert.equal(calls.length, 4);
    assert.match(calls[0].headers.get("authorization"), /^Basic /);
    assert.equal(new URL(calls[0].url).searchParams.get("q"), "investment");
    assert.equal(new URL(calls[1].url).searchParams.get("departmentId"), "dept-investment");
    assert.equal(new URL(calls[2].url).pathname, "/v1/app-directory/people/person-1");
    assert.equal(person.directoryReadScope, "company");
    assert.deepEqual(await calls[3].json(), { userId: "user-1" });
    assert.equal(access.allowed, true);
    assert.deepEqual(access.systemRoles, ["app_collaborator"]);
  });

  it("uses immutable department ids and ancestor lineage for authorization", () => {
    const user = {
      departmentId: "dept-research",
      departmentPath: ["company", "dept-investment", "dept-research"]
    };

    assert.equal(hasDepartmentAccess(user, ["dept-investment"]), true);
    assert.equal(hasDepartmentAccess(user, ["dept-investment"], { includeDescendants: false }), false);
    assert.doesNotThrow(() => requireDepartmentAccess(user, ["dept-research"]));
    assert.throws(
      () => requireDepartmentAccess(user, ["dept-hr"]),
      (error) => error instanceof WorkspaceAuthSdkError && error.code === "department_access_denied" && error.status === 403
    );
  });

  it("preserves stable directory error codes", async () => {
    const directory = new WorkspaceAuthDirectory({
      appId: "app-people",
      appSecret: "directory-test-app-secret-at-least-32",
      authOrigin: "https://auth.example.test",
      fetcher: async () => Response.json({ error: "invalid_app_client_authentication" }, { status: 401 })
    });

    await assert.rejects(
      directory.listPeople(),
      (error) => error instanceof WorkspaceAuthSdkError
        && error.code === "invalid_app_client_authentication"
        && error.status === 401
    );
  });
});
