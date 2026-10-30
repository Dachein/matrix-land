import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateAppAccess, resolveAppSystemRoles } from "./policy.ts";

const baseApp = {
  id: "app-ops",
  status: "listed",
  sdkStatus: "connected"
};

const baseUser = {
  id: "user-1",
  email: "test.user@example.invalid",
  name: "Ada Zhang",
  role: "member",
  status: "active"
};

describe("evaluateAppAccess", () => {
  it("resolves owner before collaborator and keeps ordinary users role-free", () => {
    assert.deepEqual(resolveAppSystemRoles({
      businessOwnerUserId: baseUser.id,
      collaboratorUserIds: [baseUser.id]
    }, baseUser), ["app_owner"]);
    assert.deepEqual(resolveAppSystemRoles({
      collaboratorUserIds: [baseUser.email]
    }, baseUser), ["app_collaborator"]);
    assert.deepEqual(resolveAppSystemRoles({ collaboratorUserIds: [] }, baseUser), []);
  });

  it("allows targeted access through department id path inheritance", () => {
    const result = evaluateAppAccess({
      app: {
        ...baseApp,
        accessMode: "targeted",
        accessTargets: ["department:dept-investment"]
      },
      user: {
        ...baseUser,
        department: "Investment / Research",
        departmentId: "dept-research",
        departmentPath: ["company", "dept-investment", "dept-research"]
      }
    });

    assert.equal(result.decision, "allow");
    assert.equal(result.reason, "allowed_target_match");
  });

  it("allows targeted access for explicit user targets", () => {
    assert.equal(evaluateAppAccess({
      app: {
        ...baseApp,
        accessMode: "targeted",
        accessTargets: ["user:user-1"]
      },
      user: baseUser
    }).decision, "allow");
  });

  it("allows an admin to inspect an App before it is listed", () => {
    const result = evaluateAppAccess({
      app: {
        ...baseApp,
        accessMode: "targeted",
        accessTargets: [],
        sdkStatus: "pending",
        status: "draft"
      },
      user: {
        ...baseUser,
        role: "admin"
      }
    });

    assert.equal(result.decision, "allow");
    assert.equal(result.reason, "allowed_admin_prelist_preview");
  });

  it("allows the App owner to preview a connected App before it is listed", () => {
    const result = evaluateAppAccess({
      app: {
        ...baseApp,
        accessMode: "targeted",
        publisherUserId: baseUser.id,
        status: "draft"
      },
      user: baseUser
    });

    assert.equal(result.decision, "allow");
    assert.equal(result.reason, "allowed_owner_prelist_preview");
  });

  it("allows an explicit collaborator to preview a connected App before it is listed", () => {
    const result = evaluateAppAccess({
      app: {
        ...baseApp,
        accessMode: "targeted",
        accessTargets: [`user:${baseUser.id}`],
        status: "draft"
      },
      user: baseUser
    });

    assert.equal(result.decision, "allow");
    assert.equal(result.reason, "allowed_target_prelist_preview");
  });

  it("does not let an owner launch a draft App before its SDK is connected", () => {
    const result = evaluateAppAccess({
      app: {
        ...baseApp,
        accessMode: "targeted",
        publisherUserId: baseUser.id,
        sdkStatus: "pending",
        status: "draft"
      },
      user: baseUser
    });

    assert.equal(result.decision, "deny");
    assert.equal(result.reason, "denied_app_sdk_not_connected");
  });

  it("does not expose a draft App to non-author users", () => {
    const result = evaluateAppAccess({
      app: {
        ...baseApp,
        accessMode: "public",
        status: "draft"
      },
      user: baseUser
    });

    assert.equal(result.decision, "deny");
    assert.equal(result.reason, "denied_app_not_listed");
  });

  it("does not let an admin bypass targeted access after the App is listed", () => {
    const result = evaluateAppAccess({
      app: {
        ...baseApp,
        accessMode: "targeted",
        accessTargets: []
      },
      user: {
        ...baseUser,
        role: "auth_admin"
      }
    });

    assert.equal(result.decision, "deny");
    assert.equal(result.reason, "denied_not_targeted");
  });

  it("continues to let the App owner bypass targeted access after listing", () => {
    const result = evaluateAppAccess({
      app: {
        ...baseApp,
        accessMode: "targeted",
        accessTargets: [],
        publisherUserId: baseUser.id
      },
      user: baseUser
    });

    assert.equal(result.decision, "allow");
    assert.equal(result.reason, "allowed_owner");
  });

  it("denies legacy targeted access formats", () => {
    for (const target of ["domain:example.invalid", "email:test.user@example.invalid", "Investment / Research"]) {
      assert.equal(evaluateAppAccess({
        app: {
          ...baseApp,
          accessMode: "targeted",
          accessTargets: [target]
        },
        user: {
          ...baseUser,
          department: "Investment / Research",
          departmentId: "dept-research",
          departmentPath: ["company", "dept-investment", "dept-research"]
        }
      }).decision, "deny");
    }
  });

  it("denies targeted access when user no longer matches department", () => {
    const result = evaluateAppAccess({
      app: {
        ...baseApp,
        accessMode: "targeted",
        accessTargets: ["department:dept-operations"]
      },
      user: {
        ...baseUser,
        departmentId: "dept-investment",
        departmentPath: ["company", "dept-investment"]
      }
    });

    assert.equal(result.decision, "deny");
    assert.equal(result.reason, "denied_not_targeted");
  });

  it("shows requestable apps for visibility but denies launch without approved grant", () => {
    const app = {
      ...baseApp,
      accessMode: "request"
    };

    assert.deepEqual(
      {
        decision: evaluateAppAccess({ action: "visibility", app, user: baseUser }).decision,
        reason: evaluateAppAccess({ action: "visibility", app, user: baseUser }).reason
      },
      {
        decision: "allow",
        reason: "allowed_requestable"
      }
    );

    assert.equal(evaluateAppAccess({ action: "launch", app, user: baseUser }).decision, "deny");
    assert.equal(evaluateAppAccess({ action: "launch", app, grantStatus: "approved", user: baseUser }).decision, "allow");
  });
});
