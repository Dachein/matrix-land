import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

let serviceModulePromise;
let workerModulePromise;

async function loadServiceModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-skill-service-test-"));
  const outfile = join(outdir, "service.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("./service.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function serviceModule() {
  serviceModulePromise ??= loadServiceModule();
  return serviceModulePromise;
}

async function loadWorkerModule() {
  const outdir = await mkdtemp(join(tmpdir(), "apps-skill-worker-test-"));
  const outfile = join(outdir, "worker.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL("../worker.ts", import.meta.url).pathname],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "neutral"
  });
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await rm(outdir, { force: true, recursive: true });
  return mod;
}

function workerModule() {
  workerModulePromise ??= loadWorkerModule();
  return workerModulePromise;
}

class D1Adapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1StatementAdapter(this.database.prepare(sql));
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

class D1StatementAdapter {
  constructor(statement, params = []) {
    this.params = params;
    this.statement = statement;
  }

  bind(...params) {
    return new D1StatementAdapter(this.statement, params);
  }

  async all() {
    return { results: this.statement.all(...this.params) };
  }

  async first() {
    return this.statement.get(...this.params) ?? null;
  }

  async run() {
    this.statement.run(...this.params);
    return { success: true };
  }
}

function createSkillDb() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE apps_skills (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      org_slug TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      visibility TEXT NOT NULL,
      access_targets_json TEXT NOT NULL DEFAULT '[]',
      login_required INTEGER NOT NULL DEFAULT 1,
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(org_id, slug)
    );
    CREATE TABLE apps_skill_versions (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      version TEXT NOT NULL,
      state TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      skill_md_key TEXT NOT NULL,
      manifest_key TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      manifest_json TEXT NOT NULL DEFAULT '{}',
      frontmatter_json TEXT NOT NULL DEFAULT '{}',
      file_count INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      changelog TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE apps_audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  database.prepare(`
    INSERT INTO apps_skills (
      id, org_id, org_slug, owner_user_id, name, slug, description, kind,
      capabilities_json, status, visibility, access_targets_json, login_required,
      current_version_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "skill_1",
    "org-1",
    "org-1",
    "owner-1",
    "Research Skill",
    "research-skill",
    "Original description.",
    "vanilla",
    JSON.stringify(["research"]),
    "private",
    "private",
    "[]",
    1,
    "ver_1",
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z"
  );
  database.prepare(`
    INSERT INTO apps_skill_versions (
      id, skill_id, version, state, artifact_key, skill_md_key, manifest_key,
      artifact_sha256, manifest_json, frontmatter_json, file_count, size_bytes,
      changelog, created_by, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ver_1",
    "skill_1",
    "1.0.0",
    "private_current",
    "artifact.zip",
    "SKILL.md",
    "pintail.json",
    "abc123",
    "{}",
    "{}",
    2,
    128,
    "",
    "owner-1",
    "2026-07-01T00:00:00.000Z"
  );
  return new D1Adapter(database);
}

const ownerPrincipal = {
  orgId: "org-1",
  orgSlug: "org-1",
  scopes: ["apps:skills:write"],
  sub: "owner-1"
};

describe("APPS Skill metadata service", () => {
  it("allows a target-bound review admin to sync org visibility without becoming an owner", async () => {
    const { syncPublicationSkillVisibility, patchSkillMetadata, readSkill } = await serviceModule();
    const db = createSkillDb();
    const reviewer = { ...ownerPrincipal, sub: "reviewer", tokenType: "apps_publication_review", skillId: "skill_1" };
    await syncPublicationSkillVisibility(new Request("https://apps.local/publication-review/skills/skill_1/visibility", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "org", loginRequired: false })
    }), { APPS_DB: db }, reviewer, "skill_1");
    const skill = await readSkill(db, ownerPrincipal, "skill_1");
    assert.equal(skill.visibility, "org");
    assert.equal(skill.loginRequired, true);
    assert.equal(skill.ownerUserId, "owner-1");
    const log = await db.prepare("SELECT actor_user_id FROM apps_audit_logs LIMIT 1").first();
    assert.equal(log.actor_user_id, "reviewer");
    await assert.rejects(() => patchSkillMetadata({ name: "Nope" }, { APPS_DB: db }, reviewer, "skill_1"), error => error.status === 404);
  });

  it("preserves team targets and narrows org access when the review selects private", async () => {
    const { syncPublicationSkillVisibility, readSkill } = await serviceModule();
    const db = createSkillDb();
    await db.prepare("UPDATE apps_skills SET visibility = 'team', access_targets_json = ? WHERE id = ?")
      .bind('["user:mate-1"]', "skill_1").run();
    const reviewer = { ...ownerPrincipal, sub: "reviewer", tokenType: "apps_publication_review", skillId: "skill_1" };
    const sync = visibility => syncPublicationSkillVisibility(new Request("https://apps.local/review", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility })
    }), { APPS_DB: db }, reviewer, "skill_1");
    await sync("team");
    assert.deepEqual((await readSkill(db, ownerPrincipal, "skill_1")).accessTargets, ["user:mate-1"]);
    await sync("org");
    await sync("private");
    assert.equal((await readSkill(db, ownerPrincipal, "skill_1")).visibility, "private");
    await assert.rejects(() => readSkill(db, reviewer, "skill_1"), error => error.status === 404);
    await assert.rejects(() => sync("team"), error => error.code === "skill_access_targets_required");
  });

  it("rejects ordinary credentials, other skills, other orgs, and access-target overrides without writes", async () => {
    const { syncPublicationSkillVisibility } = await serviceModule();
    const db = createSkillDb();
    const reviewer = { ...ownerPrincipal, sub: "reviewer", tokenType: "apps_publication_review", skillId: "skill_1" };
    for (const [principal, body, status] of [
      [{ ...reviewer, tokenType: "apps_access" }, { visibility: "org" }, 403],
      [{ ...reviewer, skillId: "skill-other" }, { visibility: "org" }, 403],
      [{ ...reviewer, orgId: "other-org" }, { visibility: "org" }, 404],
      [reviewer, { visibility: "public" }, 400],
      [reviewer, { visibility: "org", accessTargets: ["user:anyone"] }, 400]
    ]) {
      await assert.rejects(() => syncPublicationSkillVisibility(new Request("https://apps.local/review", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      }), { APPS_DB: db }, principal, "skill_1"), error => error.status === status);
    }
    const row = await db.prepare("SELECT visibility FROM apps_skills WHERE id = ?").bind("skill_1").first();
    assert.equal(row.visibility, "private");
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM apps_audit_logs").first()).count, 0);
  });

  it("lets the owner update mutable Skill metadata without changing the current artifact", async () => {
    const { patchSkillMetadata } = await serviceModule();
    const db = createSkillDb();
    const skill = await patchSkillMetadata({
      capabilities: ["research", "Finance Review"],
      description: "Updated description.",
      kind: "app",
      name: "Research Skill Plus",
      slug: "research-skill-plus",
      visibility: "team"
    }, { APPS_DB: db }, ownerPrincipal, "skill_1");

    assert.equal(skill.name, "Research Skill Plus");
    assert.equal(skill.slug, "research-skill-plus");
    assert.equal(skill.description, "Updated description.");
    assert.equal(skill.kind, "app");
    assert.equal(skill.visibility, "private");
    assert.deepEqual(skill.accessTargets, []);
    assert.equal(skill.loginRequired, true);
    assert.deepEqual(skill.capabilities, ["research", "finance-review"]);
    assert.equal(skill.currentVersionId, "ver_1");
    assert.equal(skill.versions[0].artifactKey, "artifact.zip");

    const audit = await db.prepare("SELECT action, target_id AS targetId FROM apps_audit_logs LIMIT 1").first();
    assert.deepEqual({ ...audit }, { action: "updated skill metadata", targetId: "skill_1" });
  });

  it("rejects metadata updates from users who are neither owner nor collaborator", async () => {
    const { patchSkillMetadata } = await serviceModule();
    const db = createSkillDb();

    await assert.rejects(
      () => patchSkillMetadata({ name: "Nope" }, { APPS_DB: db }, { ...ownerPrincipal, sub: "someone-else" }, "skill_1"),
      (error) => error.status === 404 && error.code === "apps_skill_not_found"
    );
  });

  it("does not equate Skill owners across email suffixes", async()=>{
 const {patchSkillMetadata}=await serviceModule();const db=createSkillDb();
 await db.prepare("UPDATE apps_skills SET owner_user_id=? WHERE id=?").bind("person@old.example","skill_1").run();
 await assert.rejects(patchSkillMetadata({name:"Denied"},{APPS_DB:db},{...ownerPrincipal,email:"person@new.example",sub:"different-user"},"skill_1"),e=>e.status===404);
 });

  it("shares targeted skills only with selected users or department lineage", async () => {
    const { listSkills, readSkill, updateSkillVisibility } = await serviceModule();
    const db = createSkillDb();
    const directUser = {
      ...ownerPrincipal,
      email: "mate@example.com",
      sub: "mate-1"
    };
    const departmentUser = {
      ...ownerPrincipal,
      departmentId: "wealth-hk",
      departmentPath: ["wealth", "wealth/wealth-hk"],
      email: "department-user@example.com",
      sub: "department-user-1"
    };
    const unrelatedUser = {
      ...ownerPrincipal,
      departmentId: "operations",
      departmentPath: ["operations"],
      email: "unrelated@example.com",
      sub: "unrelated-1"
    };

    assert.deepEqual(await listSkills(db, directUser), []);
    await assert.rejects(
      () => readSkill(db, directUser, "skill_1"),
      (error) => error.status === 404 && error.code === "apps_skill_not_found"
    );

    const updated = await updateSkillVisibility(new Request("https://apps.local/skills/skill_1/visibility", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessTargets: ["user:mate-1", "department:wealth"],
        loginRequired: false,
        visibility: "team"
      })
    }), { APPS_DB: db }, ownerPrincipal, "skill_1");

    assert.equal(updated.visibility, "team");
    assert.deepEqual(updated.accessTargets, ["user:mate-1", "department:wealth"]);
    assert.equal(updated.loginRequired, true);
    assert.equal((await listSkills(db, directUser)).length, 1);
    assert.equal((await readSkill(db, directUser, "skill_1")).id, "skill_1");
    assert.equal((await listSkills(db, departmentUser)).length, 1);
    assert.equal((await readSkill(db, departmentUser, "skill_1")).id, "skill_1");
    assert.deepEqual(await listSkills(db, unrelatedUser), []);
    await assert.rejects(
      () => readSkill(db, unrelatedUser, "skill_1"),
      (error) => error.status === 404 && error.code === "apps_skill_not_found"
    );

    const differentOrgUser = { ...directUser, orgId: "org-2", orgSlug: "org-2" };
    assert.deepEqual(await listSkills(db, differentOrgUser), []);
    await assert.rejects(
      () => readSkill(db, differentOrgUser, "skill_1"),
      (error) => error.status === 404 && error.code === "apps_skill_not_found"
    );
  });

  it("allows org-visible skills inside the organization and always allows the owner", async () => {
    const { listManagedSkills, listSkills, readSkill, updateSkillVisibility } = await serviceModule();
    const db = createSkillDb();
    const orgUser = { ...ownerPrincipal, sub: "org-user-1" };

    const companySkill = await updateSkillVisibility(new Request("https://apps.local/skills/skill_1/visibility", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessTargets: ["user:ignored-for-org"],
        visibility: "org"
      })
    }), { APPS_DB: db }, ownerPrincipal, "skill_1");

    assert.equal(companySkill.visibility, "org");
    assert.deepEqual(companySkill.accessTargets, []);
    assert.equal((await listSkills(db, orgUser)).length, 1);
    assert.deepEqual(await listManagedSkills(db, orgUser), []);
    assert.equal((await listManagedSkills(db, ownerPrincipal)).length, 1);
    assert.equal((await readSkill(db, orgUser, "skill_1")).id, "skill_1");

    await updateSkillVisibility(new Request("https://apps.local/skills/skill_1/visibility", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visibility: "private" })
    }), { APPS_DB: db }, ownerPrincipal, "skill_1");

    assert.equal((await readSkill(db, ownerPrincipal, "skill_1")).id, "skill_1");
    assert.deepEqual(await listSkills(db, orgUser), []);
  });

  it("rejects company as a Skill visibility alias", async () => {
    const { updateSkillVisibility } = await serviceModule();
    const db = createSkillDb();

    await assert.rejects(
      () => updateSkillVisibility(new Request("https://apps.local/skills/skill_1/visibility", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: "company" })
      }), { APPS_DB: db }, ownerPrincipal, "skill_1"),
      (error) => error.status === 400 && error.code === "invalid_skill_visibility"
    );
  });

  it("validates targeted Skill visibility updates", async () => {
    const { updateSkillVisibility } = await serviceModule();
    const db = createSkillDb();
    const request = (body) => new Request("https://apps.local/skills/skill_1/visibility", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    await assert.rejects(
      () => updateSkillVisibility(request({ accessTargets: [], visibility: "team" }), { APPS_DB: db }, ownerPrincipal, "skill_1"),
      (error) => error.status === 400 && error.code === "skill_access_targets_required"
    );
    await assert.rejects(
      () => updateSkillVisibility(request({ accessTargets: ["team:wealth"], visibility: "team" }), { APPS_DB: db }, ownerPrincipal, "skill_1"),
      (error) => error.status === 400 && error.code === "invalid_skill_access_target"
    );
    await assert.rejects(
      () => updateSkillVisibility(request({ visibility: "public" }), { APPS_DB: db }, ownerPrincipal, "skill_1"),
      (error) => error.status === 400 && error.code === "invalid_skill_visibility"
    );
    await assert.rejects(
      () => updateSkillVisibility(request({ accessTargets: ["user:mate-1"], visibility: "team" }), { APPS_DB: db }, { ...ownerPrincipal, sub: "not-owner" }, "skill_1"),
      (error) => error.status === 404 && error.code === "apps_skill_not_found"
    );
  });

  it("routes signed review visibility requests and rejects missing write scope", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const db = createSkillDb();
    const secret = "review-test-secret";
    const send = async (overrides, visibility = "private") => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ typ: "apps_publication_review", sub: "reviewer", org_id: "org-1", skill_id: "skill_1", scopes: ["apps:skills:write"], exp: Math.floor(Date.now() / 1000) + 60, ...overrides })).toString("base64url");
      const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
      return handleAppsWorkerRequest(new Request("https://apps.example.test/publication-review/skills/skill_1/visibility", {
        method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${header}.${payload}.${signature}` }, body: JSON.stringify({ visibility })
      }), { APPS_BASE_DOMAIN: "example.test", PLATFORM_MCP_URL: "https://apps.example.test/mcp", APPS_DB: db, APPS_JWT_SECRET: secret }, { waitUntil() {} });
    };
    assert.equal((await send({ scopes: ["apps:skills:read"] })).status, 403);
    assert.equal((await send({ skill_id: "other" })).status, 403);
    assert.equal((await send({ typ: "apps_access" })).status, 403);
    assert.equal((await send({ org_id: "other" })).status, 404);
    const response = await send({});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { synced: true });
    assert.equal((await db.prepare("SELECT visibility FROM apps_skills WHERE id = 'skill_1'").first()).visibility, "private");
  });

  it("routes PATCH Skill visibility updates through the worker API", async () => {
    const { handleAppsWorkerRequest } = await workerModule();
    const db = createSkillDb();
    const response = await handleAppsWorkerRequest(new Request("http://localhost:8791/skills/skill_1/visibility", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-workspace-org-id": "org-1",
        "x-workspace-scopes": "apps:skills:write",
        "x-workspace-user-id": "owner-1"
      },
      body: JSON.stringify({
        accessTargets: ["department:wealth"],
        visibility: "team"
      })
    }), {
      DEV_AUTH_BYPASS: "1",
      APPS_BASE_DOMAIN: "example.test",
      PLATFORM_MCP_URL: "https://apps.example.test/mcp",
      APPS_DB: db
    }, {
      passThroughOnException() {},
      waitUntil() {}
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.skill.visibility, "team");
    assert.deepEqual(payload.skill.accessTargets, ["department:wealth"]);
    assert.equal(payload.skill.loginRequired, true);
  });

  it("allows listed publication artifact tokens to download skill packages", async () => {
    const { skillZipResponse } = await serviceModule();
    const db = createSkillDb();
    const artifactBytes = new TextEncoder().encode("zip-bytes");
    const object = {
      body: new Blob([artifactBytes])
    };
    const env = {
      APPS_ARTIFACTS: {
        async get(key) {
          assert.equal(key, "artifact.zip");
          return object;
        }
      },
      APPS_BASE_DOMAIN: "example.test",
      PLATFORM_MCP_URL: "https://apps.example.test/mcp",
      APPS_DB: db
    };

    const response = await skillZipResponse(env, {
      orgId: "org-1",
      orgSlug: "org-1",
      scopes: ["apps:skills:read"],
      skillId: "skill_1",
      sub: "viewer-1",
      tokenType: "publication_access"
    }, "skill_1", "1.0.0");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.equal(await response.text(), "zip-bytes");
  });

  it("returns a verified base64 package for App Skill installs", async () => {
    const { downloadSkillPackage } = await serviceModule();
    const db = createSkillDb();
    const artifactBytes = new TextEncoder().encode("zip-bytes");
    const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
    await db.prepare("UPDATE apps_skill_versions SET artifact_sha256 = ?, size_bytes = ? WHERE id = ?")
      .bind(artifactSha256, artifactBytes.byteLength, "ver_1")
      .run();

    const env = {
      APPS_ARTIFACTS: {
        async get(key) {
          assert.equal(key, "artifact.zip");
          return new Blob([artifactBytes]);
        }
      },
      APPS_BASE_DOMAIN: "example.test",
      PLATFORM_MCP_URL: "https://apps.example.test/mcp",
      APPS_DB: db
    };

    const result = await downloadSkillPackage(env, ownerPrincipal, "skill_1", "1.0.0", "codex");

    assert.equal(result.skill.slug, "research-skill");
    assert.equal(result.package.filename, "research-skill-1.0.0.zip");
    assert.equal(result.package.sha256, artifactSha256);
    assert.equal(result.package.zipBase64, Buffer.from(artifactBytes).toString("base64"));
    assert.equal(result.install.target, "${CODEX_HOME:-$HOME/.codex}/skills/research-skill");
  });

  it("deletes a skill only after matching Skill Slug confirmation", async () => {
    const { deleteSkill } = await serviceModule();
    const db = createSkillDb();
    const deletedKeys = [];
    const env = {
      APPS_ARTIFACTS: {
        async delete(key) {
          deletedKeys.push(...(Array.isArray(key) ? key : [key]));
        }
      },
      APPS_BASE_DOMAIN: "example.test",
      PLATFORM_MCP_URL: "https://apps.example.test/mcp",
      APPS_DB: db
    };

    await assert.rejects(
      () => deleteSkill(new Request("https://apps.local/skills/skill_1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "wrong-skill" })
      }), env, ownerPrincipal, "skill_1"),
      (error) => error.status === 400 && error.code === "delete_confirmation_mismatch"
    );

    const result = await deleteSkill(new Request("https://apps.local/skills/skill_1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "research-skill" })
    }), env, ownerPrincipal, "skill_1");

    assert.equal(result.deleted, true);
    assert.deepEqual(deletedKeys, ["artifact.zip", "SKILL.md", "pintail.json"]);
    assert.equal(await db.prepare("SELECT id FROM apps_skills WHERE id = ?").bind("skill_1").first(), null);
    assert.equal(await db.prepare("SELECT id FROM apps_skill_versions WHERE skill_id = ?").bind("skill_1").first(), null);

    const audit = await db.prepare("SELECT action, target_id AS targetId FROM apps_audit_logs WHERE action = ? LIMIT 1").bind("deleted skill").first();
    assert.deepEqual({ ...audit }, { action: "deleted skill", targetId: "skill_1" });
  });
});
