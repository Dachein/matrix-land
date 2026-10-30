import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { zipSync } from "fflate";
import knowledgeWorker, { applyUnifiedTextPatch, assertKnowledgeAdminReadPrincipal, renderKnowledgeMarkdown } from "./index.ts";
import { dispatchKnowledgeIndexOutbox } from "./indexing/outbox.ts";
import { reconcileKnowledgeServiceState } from "./indexing/operations.ts";
import { cleanupStaleKnowledgeZipImports, failKnowledgeZipImportAndCleanup } from "./imports/zip/cleanup.ts";

// Run against Wrangler's bundled local D1/R2 runtime as well as SQLite.
await import("./imports/zip/runtime-regressions.mjs");

const sourceUrl = new URL("./index.ts", import.meta.url);
const schemaUrl = new URL("../db/schema.sql", import.meta.url);
const migrationUrl = new URL("../db/migrations/20260714_agent_ready_knowledge_services.sql", import.meta.url);
const collaboratorMigrationUrl = new URL("../db/migrations/20260714_personal_collaborators.sql", import.meta.url);
const consistencyMigrationUrl = new URL("../db/migrations/20260715_knowledge_object_consistency.sql", import.meta.url);
const pbPartnerFixtureUrl = new URL("../test-fixtures/pb-partner-service/", import.meta.url);
const pbPartnerFixturePaths = [
  "handbook.md",
  "README.md",
  "entities/example-bank.md",
  "entities/example-trust.md",
  "catalog/partners.jsonl",
  "topics/common-questions.md",
  "views/client-scenarios.md",
  "governance/schema.md",
  "governance/known-gaps.md",
  "governance/source-register.csv"
];

const [source, schema, migration, collaboratorMigration, consistencyMigration] = await Promise.all([
  Promise.all([sourceUrl, ...[
    "routes.ts", "requestIdentity.ts", "objects/listing.ts", "audit/reads.ts",
    "feedback/service.ts", "services/admin.ts", "query/folder.ts", "viewer/render.ts",
    "identity.ts", "configuration.ts", "values.ts", "errors.ts",
    "objects/repository.ts", "objects/content.ts", "objects/versions.ts",
    "mutations/commands.ts", "mutations/indexOutbox.ts",
    "access/transfers.ts", "access/grants.ts", "access/collaborators.ts", "access/representation.ts",
    "shares/revocation.ts", "shares/public.ts", "shares/repository.ts", "shares/values.ts",
    "services/lifecycle.ts", "services/profile.ts", "services/info.ts", "services/viewerAcl.ts",
    "services/preflight.ts", "services/reads.ts", "objects/representation.ts",
    "namespaces/repository.ts", "namespaces/representation.ts",
    "mutations/context.ts", "mutations/folders.ts", "mutations/uploads.ts", "mutations/edits.ts",
    "mutations/rename.ts", "mutations/move.ts", "mutations/delete.ts", "mutations/restore.ts",
    "imports/zip/archive.ts", "imports/zip/jobs.ts", "imports/zip/cleanup.ts", "imports/zip/import.ts",
    "objects/access.ts", "objects/writes.ts", "objects/history.ts", "services/invalidation.ts", "audit/diffs.ts", "sql.ts",
    "policy.ts", "paths.ts", "access/policy.ts", "access/authorization.ts", "audit/events.ts",
    "services/repository.ts", "services/access.ts", "services/snapshots.ts", "services/representation.ts",
    "indexing/reindex.ts", "indexing/build.ts", "indexing/outbox.ts", "indexing/operations.ts",
    "query/types.ts", "query/execute.ts", "query/ledger.ts", "query/tree.ts", "query/legacyText.ts",
    "query/indexedText.ts", "query/shadow.ts", "query/context.ts", "query/read.ts", "query/text.ts"
  ].map(path => new URL(`./${path}`, import.meta.url))]
    .map(url => readFile(url, "utf8"))).then(parts => parts.join("\n")),
  readFile(schemaUrl, "utf8"),
  readFile(migrationUrl, "utf8"),
  readFile(collaboratorMigrationUrl, "utf8"),
  readFile(consistencyMigrationUrl, "utf8")
]);

test("PB Partner JSONL catalog keeps each candidate self-contained and traceable", async () => {
  const catalog = await readFile(new URL("catalog/partners.jsonl", pbPartnerFixtureUrl), "utf8");
  const records = catalog.trim().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.id), [
    "pb-partner.example-bank",
    "pb-partner.example-trust"
  ]);
  assert.equal(records[0].minimum_test_units, null);
  assert.equal(records[1].minimum_test_units, 200);
  assert.ok(records[1].scenario_ids.includes("HARBOR-FAST-TRACK"));
  for (const record of records) {
    assert.match(record.entity_path, /^entities\/[a-z0-9-]+\.md$/);
    assert.ok(Array.isArray(record.source_ids) && record.source_ids.length > 0);
    assert.ok(Array.isArray(record.search_terms) && record.search_terms.length > 0);
  }
});

test("knowledge routes expose the object-id-first shared workspace contract", () => {
  assert.match(source, /folderObjectId/);
  assert.match(source, /parentObjectId/);
  assert.ok(source.includes("serviceHandbookMatch"));
  assert.ok(source.includes("serviceQueryMatch"));
  assert.match(source, /request\.method === "DELETE"[\s\S]+revokeAccessGrant/);
  assert.match(source, /substr\(\?, 1, length\(service_folder\.path\) \+ 1\) = service_folder\.path \|\| '\/'/);
  assert.doesNotMatch(source, /\? LIKE service_folder\.path \|\| '\/%'/);
});

test("audited Knowledge mutations reject principals without an email", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true, mutationSpineV2: true });
  t.after(() => harness.close());
  const response = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workspace-org-id": "org-1",
        "x-workspace-role": "member",
        "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
        "x-workspace-user-email": "",
        "x-workspace-user-id": "missing-email-user",
        "x-workspace-user-name": "Missing Email"
      },
      body: JSON.stringify({ name: "Must Not Commit" })
    }),
    harness.env
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "invalid_principal_email");
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_change_sets").get().count, 0);
});

test("knowledge Markdown preview uses the shared rich renderer", () => {
  const html = renderKnowledgeMarkdown([
    "# Preview",
    "",
    "| 分类 | 适合内容 |",
    "| --- | --- |",
    "| AI 应用探索 | 工具实践 |",
    "",
    "1. first",
    "2. second",
    "",
    "- [x] rendered",
    "",
    "> reusable renderer",
    "",
    "[Workspace](https://example.test)",
    "",
    "<script>alert('no')</script>"
  ].join("\n"));

  assert.match(html, /<div class="markdownTable"><table>/);
  assert.match(html, /<td>AI 应用探索<\/td>/);
  assert.match(html, /<ol>/);
  assert.match(html, /class="markdownTaskListItemCheckbox" disabled type="checkbox" checked/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /target="_blank" rel="noreferrer"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("G1.5 advertises lexical body search only for validated text and metadata discovery separately", () => {
  assert.match(source, /engine: "d1_fts_lexical"/);
  assert.match(source, /bodyExtensions: \[[\s\S]+\"\.md\"[\s\S]+\"\.jsonl\"[\s\S]+\"\.html\"/);
  assert.match(source, /metadataDiscovery: \["tree", "glob"\]/);
  assert.match(source, /nonTextBodySearch: false/);
  assert.doesNotMatch(source, /vectorize/i);
});

test("G1.5 direct Edit accepts exact unified patches and rejects stale context", () => {
  const before = "alpha\nbeta\ngamma\n";
  const patch = [
    "--- a/note.md",
    "+++ b/note.md",
    "@@ -1,3 +1,4 @@",
    " alpha",
    "-beta",
    "+BETA",
    "+between",
    " gamma"
  ].join("\n");

  assert.equal(applyUnifiedTextPatch(before, patch), "alpha\nBETA\nbetween\ngamma\n");
  assert.throws(
    () => applyUnifiedTextPatch(before, "@@ -1,2 +1,2 @@\n alpha\n-wrong\n+replacement"),
    (error) => error.status === 409 && error.code === "knowledge_edit_patch_context_mismatch"
  );
});

test("G1.5 closes move, soft-delete restore, immutable version restore, feedback, and owner-transfer routes", () => {
  for (const routeFragment of [
    "/move",
    "/restore",
    "/versions/",
    "/api/feedback/mine",
    "/api/owner-transfers"
  ]) {
    assert.ok(source.includes(routeFragment), `missing G1.5 route fragment ${routeFragment}`);
  }
  assert.match(source, /knowledge_move_cross_root_denied/);
  assert.match(source, /knowledge_restore_path_conflict/);
  assert.match(source, /operation: "restore_version"/);
  assert.match(source, /ensureRestoredRootOwner/);
  assert.match(source, /serviceViewerGrantRevokeStatements/);
});

test("knowledge scopes stay operation-specific", () => {
  assert.match(source, /const READ_SCOPES = \["workspace:knowledge:read", "workspace:knowledge:admin"\]/);
  assert.match(source, /const WRITE_SCOPES = \["workspace:knowledge:write", "workspace:knowledge:admin"\]/);
  assert.match(source, /const SHARE_SCOPES = \["workspace:knowledge:share", "workspace:knowledge:admin"\]/);
  assert.doesNotMatch(source, /const SKILL_SCOPES/);
});

test("direct collaboration is user-only while Service access uses principal org", () => {
  assert.match(source, /value === "collaborator" \|\| value === "editor"/);
  assert.match(source, /\{ type: "company", id: principal\.orgId \}/);
  assert.match(source, /knowledge_collaborator_subject_must_be_user/);
  assert.match(source, /role === "collaborator" && subjectType !== "user"/);
  assert.match(source, /knowledge_acl_root_required/);
  assert.doesNotMatch(source, /DEFAULT_COMPANY_SUBJECT_ID/);
  assert.match(source, /user\.organization_id\s+\?\? fallbackOrgId\s+\?\? identity\.orgId/);
  assert.match(source, /if \(row\.subject_type !== "user"\) \{\s+return "viewer";\s+\}\s+return role;/);
  assert.match(source, /const role = permissionRoleForRow\(row\)/);
  assert.match(collaboratorMigration, /subject_type != 'user'[\s\S]+role IN \('editor', 'collaborator', 'owner'\)/);
  assert.match(collaboratorMigration, /SET role = 'viewer',[\s\S]+can_share = 0/);
});

test("Owner manages ACL and lifecycle while Collaborator edits content and Service routing info", () => {
  assert.match(source, /roleHasKnowledgeCapability\(role, "editContent"\)/);
  assert.match(source, /roleHasKnowledgeCapability\(effectiveRole, "manageAccess"\)/);
  assert.match(source, /roleHasKnowledgeCapability\(actorRole, "manageService"\)/);
  assert.match(source, /roleHasKnowledgeCapability\(role, "manageProtectedStructure"\)/);
  assert.match(source, /canManageAccess: roleHasKnowledgeCapability\(role, "manageAccess"\)/);
  assert.match(source, /canManageKnowledgeService: roleHasKnowledgeCapability\(role, "manageService"\)/);
  assert.match(source, /canUpdateKnowledgeServiceInfo: roleHasKnowledgeCapability\(role, "updateServiceInfo"\)/);
  assert.doesNotMatch(source, /function hasFullKnowledgeAccess/);
  assert.match(source, /if \(value === "owner"\) return "owner";[\s\S]+if \(value === "editor" \|\| value === "collaborator"\) return "collaborator";/);
});

test("Root ACL replaces namespace-owner bypass and admin requires audited break-glass", () => {
  assert.match(source, /!knowledgeV2Flags\(env\)\.rootAcl[\s\S]+namespace\.owner_user_id === principal\.sub/);
  assert.match(source, /principal\.role === "admin" && principal\.breakGlassReason/);
  assert.match(source, /action: "knowledge\.break_glass\.use"/);
  assert.match(source, /invalid_knowledge_break_glass_reason/);
  assert.match(source, /knowledge_parent_object_id_required/);
});

test("Knowledge admin reads reconcile the Portal role without widening normal Knowledge access", async () => {
  const principal = {
    departmentPath: [],
    name: "Portal Admin",
    orgId: "org-1",
    role: "member",
    scopes: ["workspace:knowledge:read"],
    sub: "portal-admin"
  };
  const request = new Request("https://k.example.test/api/admin/knowledge-services", {
    headers: { cookie: "workspace_session=session-token" }
  });
  let requestedUrl = "";

  await assertKnowledgeAdminReadPrincipal(request, { PORTAL_URL: "https://portal.example.test/" }, principal, async (input) => {
    requestedUrl = String(input);
    return Response.json({ user: { id: "portal-admin", role: "admin" } });
  });
  assert.equal(requestedUrl, "https://portal.example.test/api/auth/current-user");

  await assert.rejects(
    () => assertKnowledgeAdminReadPrincipal(request, { PORTAL_URL: "https://portal.example.test" }, principal, async () => (
      Response.json({ user: { id: "another-user", role: "admin" } })
    )),
    (error) => error.status === 403 && error.code === "knowledge_admin_access_denied"
  );
});

test("personal collaborator migration demotes historical non-user grants without changing the schema", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE knowledge_permissions (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL,
      role TEXT NOT NULL,
      can_share INTEGER NOT NULL,
      can_publish_skill INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO knowledge_permissions (id, subject_type, role, can_share, can_publish_skill) VALUES
      ('department-editor', 'department', 'editor', 1, 1),
      ('company-collaborator', 'company', 'collaborator', 1, 1),
      ('team-owner', 'team', 'owner', 1, 1),
      ('user-editor', 'user', 'editor', 1, 0),
      ('user-owner', 'user', 'owner', 1, 1);
  `);

  database.exec(collaboratorMigration);

  assert.deepEqual(
    database.prepare("SELECT id, role, can_share, can_publish_skill FROM knowledge_permissions ORDER BY id").all().map((row) => ({ ...row })),
    [
      { id: "company-collaborator", role: "viewer", can_share: 0, can_publish_skill: 0 },
      { id: "department-editor", role: "viewer", can_share: 0, can_publish_skill: 0 },
      { id: "team-owner", role: "viewer", can_share: 0, can_publish_skill: 0 },
      { id: "user-editor", role: "editor", can_share: 1, can_publish_skill: 0 },
      { id: "user-owner", role: "editor", can_share: 1, can_publish_skill: 0 }
    ]
  );
  database.close();
});

test("only Root Owner replaces collaborators and changes commit with provenance", () => {
  assert.match(source, /request\.method === "PUT"[\s\S]+replaceFolderCollaborators/);
  assert.match(source, /"manageAccess"[\s\S]+knowledge_collaborators_manage_denied/);
  assert.match(source, /knowledge_collaborators_manage_denied/);
  assert.match(source, /subject_type = 'user'/);
  assert.match(source, /SET role = 'editor', can_share = 1/);
  assert.match(source, /permission_id, grant_source, source_id/);
  assert.match(source, /publicSharesCreatedByUnselectedCollaboratorsRevokeStatement/);
  assert.match(source, /subject_id NOT IN \(\$\{desiredPlaceholders\}\)/);
  assert.match(source, /WHERE NOT EXISTS \([\s\S]+subject_id = \? AND revoked_at IS NULL/);
  assert.match(source, /All collaborator changes and removed-collaborator link revocations commit[\s\S]+KNOWLEDGE_DB\.batch\(statements\)/);
});

test("Agent Knowledge upgrade requires a user-prepared handbook", () => {
  assert.match(source, /path === "\/api\/knowledge-services\/preflight"/);
  assert.match(source, /status: "ready" \| "missing" \| "invalid"/);
  assert.match(source, /knowledge_service_manage_denied/);
  assert.match(source, /"manageService"[\s\S]+knowledge_service_manage_denied/);
  assert.match(source, /knowledge_service_root_required/);
  assert.match(source, /requireExistingHandbookMarkdown/);
  assert.match(source, /KNOWLEDGE_OBJECTS\.head\(version\.r2_key\)/);
  assert.match(source, /throw new HttpError\(409, "knowledge_service_handbook_missing"\)/);
  assert.doesNotMatch(source, /ensureHandbookMarkdown/);
  assert.doesNotMatch(source, /knowledgeServiceHandbookTemplate/);
  assert.match(source, /knowledge_service_handbook_content_edit_not_supported/);
});

test("service Viewer access is an atomic company, user, or department folder ACL", async () => {
  assert.match(await readFile(new URL("./types.ts", import.meta.url), "utf8"), /type KnowledgeServiceAccessSettings = \{[\s\S]+company: boolean;[\s\S]+users: string\[\];[\s\S]+departments: string\[\];/);
  assert.match(source, /knowledge_service_access_mode_conflict/);
  assert.match(source, /assertKnowledgeServiceViewerPolicyCanBeRepresented/);
  assert.match(source, /knowledge_service_inherited_viewer_conflict/);
  assert.match(source, /grant_source = 'knowledge_service'/);
  assert.match(source, /source_id = \?/);
  assert.match(source, /SELECT \?, \?, \?, \?, \?, 'viewer'/);
  assert.match(source, /serviceViewerGrantRevokeStatements\(env, row\.id\)/);
  assert.match(source, /D1 batch is atomic/);
  assert.match(source, /KNOWLEDGE_DB\.batch\(statements\)/);
  assert.match(source, /knowledgeServiceJson\(serviceRow, version, actorRole, access\)/);
});

test("service mutations preserve the actual full-access actor role in responses", () => {
  assert.match(source, /const actorRole = canonicalPermissionRole\(await accessRoleForObject\(env, namespace, folder, principal\)\);/);
  assert.match(source, /knowledgeServiceJson\(serviceRow, version, actorRole, access\)/);
  assert.match(source, /knowledgeServiceJson\(row, version, actorRole, access\)/);
  assert.doesNotMatch(source, /knowledgeServiceJson\([^\n]+"owner", access\)/);
});

test("object JSON exposes the direct Root Owner instead of the object creator", () => {
  assert.match(source, /await rootOwnerForObject\(env, row\)/);
  assert.match(source, /objectJsonWithPrincipalAccess\([\s\S]+rootOwner\?\.subject_id \?\? namespace\.owner_user_id,/);
  assert.match(source, /rootOwner\?\.subject_id \?\? namespace\.owner_user_id,[\s\S]+projectedAccessRole/);
  assert.match(source, /owner: ownerUserId,\s+ownerUserId,/);
  assert.doesNotMatch(source, /owner: row\.created_by_user_id/);
});

test("public shares rotate a file-level latest-content link", () => {
  assert.match(source, /normalizePublicShareExpiry/);
  assert.match(source, /"24h" \| "permanent"/);
  assert.match(source, /SET revoked_at = CURRENT_TIMESTAMP[\s\S]+insertPublicShare/);
  assert.match(source, /requireCurrentVersion\(env, object\)/);
  assert.match(source, /datetime\(expires_at\) > CURRENT_TIMESTAMP/);
  assert.match(source, /knowledge_service_handbook_public_share_not_allowed/);
  assert.match(schema, /idx_knowledge_shares_one_active_public/);
  assert.doesNotMatch(schema, /knowledge_shares[\s\S]{0,500}version_id/);
});

test("agent-ready services retain ACL-safe legacy migration behavior", () => {
  assert.match(schema, /agent_enabled INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /index_status TEXT NOT NULL DEFAULT 'disabled'/);
  assert.match(migration, /visibility = 'private'[\s\S]+access_targets_json/);
  assert.match(migration, /THEN 1 ELSE 0 END/);
  assert.doesNotMatch(migration, /access_targets_json = '\[\]'/);
  assert.match(source, /accessModel: "folder_acl"/);
  assert.match(source, /HANDBOOK_FILE_NAME = "handbook\.md"/);
  assert.match(source, /knowledge_service_package_removed/);
  assert.match(source, /knowledgeServiceId: agentEnabled \? service\?\.id : undefined/);
});

test("service indexing paginates and search excludes handbook instructions", () => {
  const listFilesSource = source.slice(
    source.indexOf("async function listKnowledgeServiceFiles"),
    source.indexOf("async function requireReadableKnowledgeService")
  );
  assert.match(source, /LIMIT \? OFFSET \?/);
  assert.match(source, /if \(snapshot\.isHandbook\) \{\s+continue;/);
  assert.doesNotMatch(listFilesSource, /LIMIT 200/);
  assert.match(source, /index_status === "error"/);
  assert.match(source, /knowledge_service_index_not_ready/);
});

test("security-sensitive control-plane changes are audited", () => {
  for (const action of [
    "knowledge.access_grant.upsert",
    "knowledge.access_grant.revoke",
    "knowledge.collaborators.replace",
    "knowledge.public_share.create",
    "knowledge.public_share.revoke",
    "knowledge.service.enable",
    "knowledge.service.disable",
    "knowledge.service.reindex"
  ]) {
    assert.ok(source.includes(action), `missing audit action ${action}`);
  }
  assert.match(source, /orgId: input\.namespace\.org_id/);
});

test("Admin Knowledge lists shared enabled services with ownership, ACL, files, and request activity", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "namespace-owner" });
  insertObject(harness.database, { id: "service-root", kind: "folder", path: "Published" });
  insertObject(harness.database, { id: "handbook", path: "Published/handbook.md", currentVersionId: "handbook-v1" });
  insertObject(harness.database, { id: "note", path: "Published/note.md", currentVersionId: "note-v1" });
  insertVersion(harness.database, { id: "handbook-v1", objectId: "handbook", version: 1, sizeBytes: 12 });
  insertVersion(harness.database, { id: "note-v1", objectId: "note", version: 1, sizeBytes: 8 });
  harness.database.exec(`
    INSERT INTO knowledge_services (
      id, namespace_id, folder_object_id, handbook_object_id, name, slug, description,
      status, agent_enabled, index_status, created_by_user_id
    ) VALUES (
      'service-1', 'namespace-1', 'service-root', 'handbook', 'Published Service',
      'published-service', 'Service description', 'active', 1, 'ready', 'owner-1'
    );
    INSERT INTO knowledge_permissions (
      id, namespace_id, object_id, subject_type, subject_id, role, can_share, granted_by_user_id
    ) VALUES
      ('owner-grant', 'namespace-1', 'service-root', 'user', 'owner-1', 'owner', 1, 'owner-1'),
      ('collaborator-grant', 'namespace-1', 'service-root', 'user', 'collaborator-1', 'editor', 1, 'owner-1'),
      ('company-viewer', 'namespace-1', 'service-root', 'company', 'org-1', 'viewer', 0, 'owner-1');
    INSERT INTO knowledge_permission_provenance (permission_id, grant_source, source_id) VALUES
      ('owner-grant', 'direct', 'service-root'),
      ('collaborator-grant', 'direct', 'service-root'),
      ('company-viewer', 'knowledge_service', 'service-1');
    INSERT INTO knowledge_query_sessions (
      id, org_id, actor_user_id, created_at, last_activity_at
    ) VALUES
      ('kquery_admin_activity', 'org-1', 'viewer-1', '2026-07-25 08:00:00', '2026-07-26 09:30:00');
    INSERT INTO knowledge_query_steps (
      id, query_id, service_id, actor_user_id, action, created_at
    ) VALUES
      ('kstep_admin_search', 'kquery_admin_activity', 'service-1', 'viewer-1', 'search', '2026-07-25 08:00:00'),
      ('kstep_admin_read', 'kquery_admin_activity', 'service-1', 'viewer-1', 'read', '2026-07-26 09:30:00');
  `);

  const response = await knowledgeWorker.fetch(
    new Request("http://localhost/api/admin/knowledge-services"),
    harness.env
  );
  const body = await response.json();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.summary, {
    companyVisibleCount: 1,
    fileCount: 2,
    requestCount: 2,
    serviceCount: 1
  });
  assert.equal(body.services[0].name, "Published Service");
  assert.equal(body.services[0].ownerUserId, "owner-1");
  assert.deepEqual(body.services[0].collaboratorUserIds, ["collaborator-1"]);
  assert.deepEqual(body.services[0].access, { company: true, departments: [], users: [] });
  assert.equal(body.services[0].permissionType, "company");
  assert.equal(body.services[0].lastActiveAt, "2026-07-26 09:30:00");

  const denied = await knowledgeWorker.fetch(
    new Request("http://localhost/api/admin/knowledge-services", {
      headers: { "x-workspace-role": "member" }
    }),
    harness.env
  );
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "knowledge_admin_access_denied");
});

test("Admin Knowledge excludes Private, disabled, deleted, and foreign services from rows and totals", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database);
  harness.database.exec(`INSERT INTO knowledge_namespaces (id, org_id, owner_user_id) VALUES ('foreign', 'other-org', 'other-owner')`);
  for (const [id, scope, status, enabled, deleted, foreign] of [
    ['company', 'company', 'active', 1, false, false],
    ['targeted', 'user', 'active', 1, false, false],
    ['private', null, 'active', 1, false, false],
    ['draft', 'company', 'draft', 0, false, false],
    ['deleted', 'company', 'active', 1, true, false],
    ['foreign', 'company', 'active', 1, false, true]
  ]) {
    insertObject(harness.database, { id: `${id}-root`, kind: 'folder', path: id });
    insertObject(harness.database, { id: `${id}-file`, path: `${id}/handbook.md` });
    if (foreign) harness.database.prepare('UPDATE knowledge_objects SET namespace_id = ? WHERE id IN (?, ?)').run('foreign', `${id}-root`, `${id}-file`);
    const namespace = foreign ? 'foreign' : 'namespace-1';
    harness.database.prepare(`INSERT INTO knowledge_services (id, namespace_id, folder_object_id, handbook_object_id, name, status, agent_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, namespace, `${id}-root`, `${id}-file`, id, status, enabled);
    if (scope) {
      harness.database.prepare(`INSERT INTO knowledge_permissions (id, namespace_id, object_id, subject_type, subject_id, role) VALUES (?, ?, ?, ?, ?, 'viewer')`).run(`${id}-grant`, namespace, `${id}-root`, scope, scope === 'company' ? 'org-1' : 'viewer-1');
      harness.database.prepare(`INSERT INTO knowledge_permission_provenance (permission_id, grant_source, source_id) VALUES (?, 'knowledge_service', ?)`).run(`${id}-grant`, id);
    }
    if (deleted) harness.database.prepare("UPDATE knowledge_objects SET deleted_at = '2026-01-01' WHERE id = ?").run(`${id}-root`);
  }
  const response = await knowledgeWorker.fetch(new Request('http://localhost/api/admin/knowledge-services'), harness.env);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.services.map((service) => service.id).sort(), ['company', 'targeted']);
  assert.deepEqual(body.summary, { serviceCount: 2, companyVisibleCount: 1, fileCount: 2, requestCount: 0 });
  assert.equal(harness.database.prepare("SELECT agent_enabled FROM knowledge_services WHERE id = 'private'").get().agent_enabled, 1);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_permissions WHERE object_id = 'private-root'").get().count, 0);
});

test("fresh schema allows historical duplicate paths but enforces one active object", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(schema);
  insertNamespace(database);
  insertObject(database, { id: "deleted-1", path: "Reports/report.md", deletedAt: "2026-07-15 00:00:00" });
  insertObject(database, { id: "deleted-2", path: "Reports/report.md", deletedAt: "2026-07-15 00:01:00" });
  insertObject(database, { id: "active-1", path: "Reports/report.md" });

  assert.throws(
    () => insertObject(database, { id: "active-2", path: "Reports/report.md" }),
    /unique/i
  );
  const pathIndex = database.prepare("PRAGMA index_list('knowledge_objects')").all()
    .find((row) => row.name === "idx_knowledge_objects_unique_active_path");
  assert.equal(pathIndex?.unique, 1);
  assert.equal(pathIndex?.partial, 1);
  database.close();
});

test("legacy consistency migration releases deleted paths without cascading data or reviving access", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(legacyKnowledgeSchema());
  insertNamespace(database, { usedBytes: 999 });
  insertObject(database, { id: "deleted-folder", kind: "folder", path: "Reports", deletedAt: "2026-07-15 00:00:00" });
  insertObject(database, { id: "deleted-file", path: "Reports/report.md", sizeBytes: 7, deletedAt: "2026-07-15 00:00:00" });
  insertObject(database, { id: "active-file", path: "Reports/current.md", sizeBytes: 3 });
  database.exec(`
    INSERT INTO knowledge_object_versions (
      id, object_id, namespace_id, version, r2_key, mime_type, size_bytes, sha256, created_by_user_id
    ) VALUES ('old-version', 'deleted-file', 'namespace-1', 1, 'old-r2-key', 'text/markdown', 7, 'old-sha', 'owner-1');
    INSERT INTO knowledge_permissions (
      id, namespace_id, object_id, subject_type, subject_id, role, can_share, granted_by_user_id
    ) VALUES ('old-grant', 'namespace-1', 'deleted-file', 'user', 'collaborator-1', 'viewer', 0, 'owner-1');
    INSERT INTO knowledge_shares (
      id, namespace_id, object_id, slug, visibility, role, created_by_user_id
    ) VALUES ('old-share', 'namespace-1', 'deleted-file', 'OldShare1', 'public', 'viewer', 'owner-1');
    INSERT INTO knowledge_open_tokens (
      id, namespace_id, object_id, token_hash, purpose, created_by_user_id, expires_at
    ) VALUES ('old-token', 'namespace-1', 'deleted-file', 'old-token-hash', 'preview', 'owner-1', '2099-01-01T00:00:00.000Z');
    INSERT INTO knowledge_services (
      id, namespace_id, folder_object_id, handbook_object_id, name, slug, status, created_by_user_id
    ) VALUES ('old-service', 'namespace-1', 'deleted-folder', 'deleted-file', 'Old Service', 'old-service', 'active', 'owner-1');
    INSERT INTO knowledge_service_versions (
      id, service_id, version, handbook_version_id, status, created_by_user_id
    ) VALUES ('old-service-version', 'old-service', 1, 'old-version', 'active', 'owner-1');
  `);

  database.exec(consistencyMigration);
  database.exec(consistencyMigration);
  insertObject(database, { id: "replacement-file", path: "Reports/report.md", sizeBytes: 5 });

  const tombstone = database.prepare("SELECT path, parent_path, metadata_json FROM knowledge_objects WHERE id = 'deleted-file'").get();
  assert.equal(tombstone.path, "/.workspace-deleted/deleted-file");
  assert.equal(tombstone.parent_path, "/.workspace-deleted");
  assert.deepEqual(JSON.parse(tombstone.metadata_json), {
    deletedOriginalParentPath: "Reports",
    deletedOriginalPath: "Reports/report.md"
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM knowledge_object_versions WHERE object_id = 'deleted-file'").get().count, 1);
  assert.notEqual(database.prepare("SELECT revoked_at FROM knowledge_permissions WHERE id = 'old-grant'").get().revoked_at, null);
  assert.notEqual(database.prepare("SELECT revoked_at FROM knowledge_shares WHERE id = 'old-share'").get().revoked_at, null);
  assert.notEqual(database.prepare("SELECT consumed_at FROM knowledge_open_tokens WHERE id = 'old-token'").get().consumed_at, null);
  assert.equal(database.prepare("SELECT status FROM knowledge_services WHERE id = 'old-service'").get().status, "archived");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM knowledge_service_versions WHERE id = 'old-service-version'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM knowledge_permissions WHERE object_id = 'replacement-file'").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM knowledge_shares WHERE object_id = 'replacement-file'").get().count, 0);
  assert.equal(database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 3);
  assert.ok(database.prepare("PRAGMA index_list('knowledge_objects')").all().some((row) => row.name === "idx_knowledge_objects_tree"));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("delete and recreate works against the legacy unique constraint without inheriting ACLs or links", async (t) => {
  const harness = createKnowledgeHarness({ legacySchema: true });
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
  insertObject(harness.database, { id: "folder-old", kind: "folder", path: "Reports" });
  harness.database.exec(`
    INSERT INTO knowledge_permissions (
      id, namespace_id, object_id, subject_type, subject_id, role, can_share, granted_by_user_id
    ) VALUES ('folder-grant', 'namespace-1', 'folder-old', 'user', 'collaborator-1', 'editor', 1, 'owner-1');
    INSERT INTO knowledge_shares (
      id, namespace_id, object_id, slug, visibility, role, created_by_user_id
    ) VALUES ('folder-share', 'namespace-1', 'folder-old', 'FolderShare1', 'public', 'viewer', 'owner-1');
    INSERT INTO knowledge_open_tokens (
      id, namespace_id, object_id, token_hash, purpose, created_by_user_id, expires_at
    ) VALUES ('folder-token', 'namespace-1', 'folder-old', 'folder-token-hash', 'preview', 'owner-1', '2099-01-01T00:00:00.000Z');
  `);

  const deleted = await knowledgeWorker.fetch(
    new Request("http://localhost/api/objects/folder-old", { method: "DELETE" }),
    harness.env
  );
  assert.equal(deleted.status, 200);

  const recreated = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Reports" })
    }),
    harness.env
  );
  const recreatedBody = await recreated.json();
  assert.equal(recreated.status, 201, JSON.stringify(recreatedBody));
  assert.notEqual(recreatedBody.item.id, "folder-old");
  assert.equal(recreatedBody.item.path, "Reports");

  const oldObject = harness.database.prepare("SELECT path, metadata_json FROM knowledge_objects WHERE id = 'folder-old'").get();
  assert.equal(oldObject.path, "/.workspace-deleted/folder-old");
  assert.equal(JSON.parse(oldObject.metadata_json).deletedOriginalPath, "Reports");
  assert.notEqual(harness.database.prepare("SELECT revoked_at FROM knowledge_permissions WHERE id = 'folder-grant'").get().revoked_at, null);
  assert.notEqual(harness.database.prepare("SELECT revoked_at FROM knowledge_shares WHERE id = 'folder-share'").get().revoked_at, null);
  assert.notEqual(harness.database.prepare("SELECT consumed_at FROM knowledge_open_tokens WHERE id = 'folder-token'").get().consumed_at, null);
  assert.deepEqual(
    { ...harness.database.prepare(
      "SELECT subject_id, role FROM knowledge_permissions WHERE object_id = ? AND revoked_at IS NULL"
    ).get(recreatedBody.item.id) },
    { subject_id: "local-dev-admin", role: "owner" }
  );
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_shares WHERE object_id = ?").get(recreatedBody.item.id).count, 0);
});

test("logical quota uses the current file size and rejected uploads leave no D1 or R2 state", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { quotaBytes: 10, usedBytes: 4 });
  insertObject(harness.database, { id: "file-1", path: "report.txt", sizeBytes: 4, currentVersionId: "version-1" });
  insertVersion(harness.database, { id: "version-1", objectId: "file-1", version: 1, sizeBytes: 4 });

  const accepted = await uploadVersion(harness, "file-1", new Uint8Array(8));
  assert.equal(accepted.response.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.version.version, 2);
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 8);

  const rejected = await uploadVersion(harness, "file-1", new Uint8Array(11));
  assert.equal(rejected.response.status, 413);
  assert.equal(rejected.body.error, "knowledge_namespace_quota_exceeded");
  assert.deepEqual(
    harness.database.prepare("SELECT version FROM knowledge_object_versions WHERE object_id = 'file-1' ORDER BY version").all().map((row) => row.version),
    [1, 2]
  );
  const object = harness.database.prepare("SELECT current_version_id, size_bytes FROM knowledge_objects WHERE id = 'file-1'").get();
  assert.equal(object.current_version_id, accepted.body.version.id);
  assert.equal(object.size_bytes, 8);
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 8);
  assert.equal(harness.r2.objects.size, 1);
  assert.equal(harness.r2.deletedKeys.length, 1);
});

test("quota rejection cleans up a newly-created empty file as well as its R2 write", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin", quotaBytes: 4 });
  const form = new FormData();
  form.set("file", new File([new Uint8Array(5)], "too-large.txt", { type: "text/plain" }));

  const response = await knowledgeWorker.fetch(
    new Request("http://localhost/api/files/upload", { method: "POST", body: form }),
    harness.env
  );
  const body = await response.json();

  assert.equal(response.status, 413, JSON.stringify(body));
  assert.equal(body.error, "knowledge_namespace_quota_exceeded");
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 0);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_object_versions").get().count, 0);
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 0);
  assert.equal(harness.r2.objects.size, 0);
  assert.equal(harness.r2.deletedKeys.length, 1);
});

test("concurrent version uploads allocate a gap-free unique sequence and keep logical usage exact", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { usedBytes: 1 });
  insertObject(harness.database, { id: "file-1", path: "report.txt", sizeBytes: 1, currentVersionId: "version-1" });
  insertVersion(harness.database, { id: "version-1", objectId: "file-1", version: 1, sizeBytes: 1 });

  const uploads = await Promise.all(
    Array.from({ length: 12 }, (_, index) => uploadVersion(harness, "file-1", new Uint8Array(index + 2)))
  );
  assert.ok(uploads.every(({ response }) => response.status === 201));
  assert.deepEqual(
    harness.database.prepare("SELECT version FROM knowledge_object_versions WHERE object_id = 'file-1' ORDER BY version").all().map((row) => row.version),
    Array.from({ length: 13 }, (_, index) => index + 1)
  );
  const object = harness.database.prepare("SELECT size_bytes FROM knowledge_objects WHERE id = 'file-1'").get();
  const namespace = harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get();
  assert.equal(namespace.used_bytes, object.size_bytes);
  assert.equal(harness.r2.objects.size, 12);
});

test("a transport error after D1 commit returns the committed version and preserves its R2 object", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { usedBytes: 4 });
  insertObject(harness.database, { id: "file-1", path: "report.txt", sizeBytes: 4, currentVersionId: "version-1" });
  insertVersion(harness.database, { id: "version-1", objectId: "file-1", version: 1, sizeBytes: 4 });
  harness.d1.failNextBatchAfterCommit();

  const uploaded = await uploadVersion(harness, "file-1", new Uint8Array(6));
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.version.version, 2);
  assert.deepEqual(
    harness.database.prepare("SELECT version FROM knowledge_object_versions WHERE object_id = 'file-1' ORDER BY version").all().map((row) => row.version),
    [1, 2]
  );
  assert.deepEqual(
    { ...harness.database.prepare("SELECT current_version_id, size_bytes FROM knowledge_objects WHERE id = 'file-1'").get() },
    { current_version_id: uploaded.body.version.id, size_bytes: 6 }
  );
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 6);
  assert.equal(harness.r2.objects.size, 1);
  assert.equal(harness.r2.deletedKeys.length, 0);
});

test("a rolled-back D1 batch compensates the completed R2 put", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { usedBytes: 4 });
  insertObject(harness.database, { id: "file-1", path: "report.txt", sizeBytes: 4, currentVersionId: "version-1" });
  insertVersion(harness.database, { id: "version-1", objectId: "file-1", version: 1, sizeBytes: 4 });
  harness.d1.failNextBatchAt(1);

  const failed = await uploadVersion(harness, "file-1", new Uint8Array(6));
  assert.equal(failed.response.status, 500);
  assert.deepEqual(
    harness.database.prepare("SELECT version FROM knowledge_object_versions WHERE object_id = 'file-1' ORDER BY version").all().map((row) => row.version),
    [1]
  );
  assert.deepEqual(
    { ...harness.database.prepare("SELECT current_version_id, size_bytes FROM knowledge_objects WHERE id = 'file-1'").get() },
    { current_version_id: "version-1", size_bytes: 4 }
  );
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 4);
  assert.equal(harness.r2.objects.size, 0);
  assert.equal(harness.r2.deletedKeys.length, 1);
});

test("an inconclusive D1 commit-state lookup preserves R2 and emits a safe reconciliation log", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { usedBytes: 4 });
  insertObject(harness.database, { id: "file-1", path: "report.txt", sizeBytes: 4, currentVersionId: "version-1" });
  insertVersion(harness.database, { id: "version-1", objectId: "file-1", version: 1, sizeBytes: 4 });
  harness.d1.failNextBatchAt(1);
  harness.d1.failNextObjectVersionLookup();

  const logCalls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logCalls.push(args);
  let failed;
  try {
    failed = await uploadVersion(harness, "file-1", new Uint8Array(6));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(failed.response.status, 500);
  assert.deepEqual(
    harness.database.prepare("SELECT version FROM knowledge_object_versions WHERE object_id = 'file-1' ORDER BY version").all().map((row) => row.version),
    [1]
  );
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 4);
  assert.equal(harness.r2.objects.size, 1);
  assert.equal(harness.r2.deletedKeys.length, 0);
  assert.equal(logCalls.length, 2);
  assert.equal(logCalls[1][0], "knowledge_worker_error");
  assert.deepEqual(Object.keys(logCalls[1][1]).sort(), ["errorName", "requestId"]);
  assert.equal(logCalls[0][0], "knowledge_object_version_commit_state_unknown");
  assert.deepEqual(Object.keys(logCalls[0][1]).sort(), ["batchErrorName", "lookupErrorName", "versionId"]);
  assert.equal(logCalls[0][1].batchErrorName, "Error");
  assert.equal(logCalls[0][1].lookupErrorName, "Error");
  assert.match(logCalls[0][1].versionId, /^kov_[0-9a-f-]+$/);
  assert.doesNotMatch(JSON.stringify(logCalls), /injected_d1_(?:batch|lookup)_failure/);
});

test("failed R2 compensation keeps the original failure and logs only error classes and storage identifiers", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { usedBytes: 4 });
  insertObject(harness.database, { id: "file-1", path: "report.txt", sizeBytes: 4, currentVersionId: "version-1" });
  insertVersion(harness.database, { id: "version-1", objectId: "file-1", version: 1, sizeBytes: 4 });
  harness.d1.failNextBatchAt(1);
  harness.r2.delete = async () => { throw new Error("sensitive-storage-error-body"); };
  const logCalls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logCalls.push(args);
  let failed;
  try {
    failed = await uploadVersion(harness, "file-1", new Uint8Array(6));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(failed.response.status, 500);
  assert.equal(failed.body.error, "knowledge_worker_error");
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_object_versions").get().count, 1);
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 4);
  assert.equal(harness.r2.objects.size, 1);
  const compensation = logCalls.find(([event]) => event === "knowledge_r2_version_compensation_failed");
  assert.ok(compensation);
  assert.deepEqual(Object.keys(compensation[1]).sort(), ["causeName", "cleanupErrorName", "r2Key"]);
  assert.equal(compensation[1].causeName, "Error");
  assert.equal(compensation[1].cleanupErrorName, "Error");
  assert.equal(compensation[1].r2Key, harness.r2.putKeys[0]);
});

test("failed empty-file compensation preserves quota rejection without logging raw errors", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin", quotaBytes: 4 });
  const prepare = harness.d1.prepare.bind(harness.d1);
  harness.d1.prepare = query => {
    if (/DELETE FROM knowledge_objects\s+WHERE id = \? AND current_version_id = ''/.test(query)) {
      throw new Error("sensitive-database-error-body");
    }
    return prepare(query);
  };
  const form = new FormData();
  form.set("file", new File([new Uint8Array(5)], "too-large.txt", { type: "text/plain" }));
  const logCalls = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logCalls.push(args);
  let response;
  try {
    response = await knowledgeWorker.fetch(new Request("http://localhost/api/files/upload", {
      method: "POST", body: form
    }), harness.env);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "knowledge_namespace_quota_exceeded");
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 1);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_object_versions").get().count, 0);
  assert.equal(harness.r2.objects.size, 0);
  const compensation = logCalls.find(([event]) => event === "knowledge_empty_file_compensation_failed");
  assert.ok(compensation);
  assert.deepEqual(Object.keys(compensation[1]).sort(), ["causeName", "cleanupErrorName", "objectId"]);
  assert.equal(compensation[1].causeName, "Error");
  assert.equal(compensation[1].cleanupErrorName, "Error");
  assert.match(compensation[1].objectId, /^kobj_/);
});

test("interrupted index dispatch and reconciliation records recover without another source mutation", async (t) => {
  const harness = createIndexDispatchHarness();
  t.after(() => harness.close());
  harness.database.exec(`
    INSERT INTO knowledge_index_outbox (
      id, service_id, source_revision, object_id, operation, extractor_version,
      status, attempt_count, updated_at
    ) VALUES
      ('mutation', 'service-1', 1, 'service-root', 'upsert', 'builtin-v1',
       'dispatching', 1, datetime(CURRENT_TIMESTAMP, '-30 minutes')),
      ('kidx_reconcile:service-1:1:0', 'service-1', 1, 'service-root', 'backfill', 'builtin-v1',
       'dispatching', 1, datetime(CURRENT_TIMESTAMP, '-30 minutes'));
  `);

  await dispatchKnowledgeIndexOutbox(harness.env);
  await reconcileKnowledgeServiceState(harness.env);
  await dispatchKnowledgeIndexOutbox(harness.env);

  assert.deepEqual(harness.queueMessages, [{
    kind: "service_reindex", serviceId: "service-1", sourceRevision: 1
  }]);
  assert.deepEqual(harness.database.prepare(
    "SELECT status, attempt_count FROM knowledge_index_outbox ORDER BY id"
  ).all().map(row => ({ ...row })), [
    { status: "dispatched", attempt_count: 2 },
    { status: "dispatched", attempt_count: 2 }
  ]);
});

test("index dispatch recovery preserves current sends, delivery acknowledgements and retry backoff", async (t) => {
  const harness = createIndexDispatchHarness();
  t.after(() => harness.close());
  harness.database.exec(`
    INSERT INTO knowledge_index_outbox (
      id, service_id, source_revision, object_id, operation, extractor_version,
      status, attempt_count, updated_at, next_attempt_at
    ) VALUES
      ('current', 'service-1', 1, 'service-root', 'upsert', 'builtin-v1',
       'dispatching', 1, CURRENT_TIMESTAMP, NULL),
      ('delivered', 'service-1', 1, 'service-root', 'upsert', 'builtin-v1',
       'dispatched', 1, datetime(CURRENT_TIMESTAMP, '-30 minutes'), NULL),
      ('completed', 'service-1', 1, 'service-root', 'upsert', 'builtin-v1',
       'completed', 1, datetime(CURRENT_TIMESTAMP, '-30 minutes'), NULL),
      ('backoff', 'service-1', 1, 'service-root', 'upsert', 'builtin-v1',
       'failed', 1, datetime(CURRENT_TIMESTAMP, '-30 minutes'), datetime(CURRENT_TIMESTAMP, '+10 minutes'));
  `);
  const before = harness.database.prepare("SELECT * FROM knowledge_index_outbox ORDER BY id").all();

  await dispatchKnowledgeIndexOutbox(harness.env);

  assert.deepEqual(harness.queueMessages, []);
  assert.deepEqual(harness.database.prepare("SELECT * FROM knowledge_index_outbox ORDER BY id").all(), before);
});

test("a recovered index dispatch still uses send-failure backoff before a successful retry", async (t) => {
  const harness = createIndexDispatchHarness();
  t.after(() => harness.close());
  harness.database.exec(`
    INSERT INTO knowledge_index_outbox (
      id, service_id, source_revision, object_id, operation, extractor_version,
      status, attempt_count, updated_at
    ) VALUES (
      'mutation', 'service-1', 1, 'service-root', 'upsert', 'builtin-v1',
      'dispatching', 1, datetime(CURRENT_TIMESTAMP, '-30 minutes')
    );
  `);
  let attempts = 0;
  harness.env.KNOWLEDGE_INDEX_QUEUE.send = async message => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary_send_failure");
    harness.queueMessages.push(message);
  };

  await dispatchKnowledgeIndexOutbox(harness.env);
  assert.deepEqual({ ...harness.database.prepare(
    "SELECT status, attempt_count, next_attempt_at > CURRENT_TIMESTAMP AS deferred FROM knowledge_index_outbox"
  ).get() }, { status: "failed", attempt_count: 2, deferred: 1 });
  await dispatchKnowledgeIndexOutbox(harness.env);
  assert.equal(attempts, 1);

  harness.database.exec("UPDATE knowledge_index_outbox SET next_attempt_at = datetime(CURRENT_TIMESTAMP, '-1 second')");
  await dispatchKnowledgeIndexOutbox(harness.env);
  assert.equal(attempts, 2);
  assert.equal(harness.queueMessages.length, 1);
  assert.deepEqual({ ...harness.database.prepare(
    "SELECT status, attempt_count FROM knowledge_index_outbox"
  ).get() }, { status: "dispatched", attempt_count: 3 });
});

test("regular and ZIP compressed-size limits reject before File.arrayBuffer", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
  let arrayBufferCalls = 0;

  const regular = oversizedFile("large.bin", "application/octet-stream", 25_000_001, () => {
    arrayBufferCalls += 1;
  });
  const regularResponse = await knowledgeWorker.fetch(formRequest("/api/files/upload", regular), harness.env);
  assert.equal(regularResponse.status, 413);
  assert.equal((await regularResponse.json()).error, "knowledge_file_too_large");

  const archive = oversizedFile("large.zip", "application/zip", 20 * 1024 * 1024 + 1, () => {
    arrayBufferCalls += 1;
  });
  const archiveResponse = await knowledgeWorker.fetch(formRequest("/api/files/upload", archive), harness.env);
  assert.equal(archiveResponse.status, 413);
  assert.equal((await archiveResponse.json()).error, "knowledge_zip_upload_too_large");

  assert.equal(arrayBufferCalls, 0);
  assert.equal(harness.r2.putKeys.length, 0);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 0);
});

test("ZIP declared uncompressed size is rejected before extraction allocates entries", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
  const archiveBytes = zipSync({ "small.txt": new TextEncoder().encode("small") });
  setFirstZipCentralDirectoryUncompressedSize(archiveBytes, 50_000_001);
  const response = await knowledgeWorker.fetch(
    formRequest("/api/files/upload", new File([archiveBytes], "archive.zip", { type: "application/zip" })),
    harness.env
  );
  const body = await response.json();

  assert.equal(response.status, 413, JSON.stringify(body));
  assert.equal(body.error, "zip_uncompressed_size_too_large");
  assert.equal(harness.r2.putKeys.length, 0);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 0);
});

test("ZIP import commits every object atomically and replays the same idempotency result", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin", quotaBytes: 1_000 });
  const archiveBytes = zipSync({
    "docs/a.txt": new TextEncoder().encode("alpha"),
    "docs/b.txt": new TextEncoder().encode("bravo")
  });
  const request = () => formRequest(
    "/api/files/upload",
    new File([archiveBytes], "bundle.zip", { type: "application/zip" }),
    { "idempotency-key": "knowledge-zip-success-1" }
  );

  const firstResponse = await knowledgeWorker.fetch(request(), harness.env);
  const firstBody = await firstResponse.json();
  assert.equal(firstResponse.status, 201, JSON.stringify(firstBody));
  assert.match(firstBody.importJobId, /^kzip_[0-9a-f-]+$/);
  assert.equal(firstBody.item.path, "bundle");
  assert.equal(firstBody.items.length, 4);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 4);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_object_versions").get().count, 2);
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 10);
  assert.equal(harness.database.prepare("SELECT state FROM knowledge_zip_import_jobs").get().state, "committed");
  assert.equal(harness.r2.objects.size, 2);
  assert.equal(harness.r2.putKeys.length, 2);

  const replayResponse = await knowledgeWorker.fetch(request(), harness.env);
  const replayBody = await replayResponse.json();
  assert.equal(replayResponse.status, 201, JSON.stringify(replayBody));
  assert.equal(replayBody.importJobId, firstBody.importJobId);
  assert.deepEqual(
    replayBody.items.map((item) => item.id).sort(),
    firstBody.items.map((item) => item.id).sort()
  );
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 4);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_object_versions").get().count, 2);
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 10);
  assert.equal(harness.r2.objects.size, 2);
  assert.equal(harness.r2.putKeys.length, 2);
});

test("ZIP publish failure rolls back every live object and compensates staged R2 writes", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin", quotaBytes: 1_000 });
  harness.d1.failNextBatchAt(3);
  const archiveBytes = zipSync({
    "docs/a.txt": new TextEncoder().encode("alpha"),
    "docs/b.txt": new TextEncoder().encode("bravo")
  });

  const response = await knowledgeWorker.fetch(
    formRequest(
      "/api/files/upload",
      new File([archiveBytes], "rollback.zip", { type: "application/zip" }),
      { "idempotency-key": "knowledge-zip-rollback-1" }
    ),
    harness.env
  );
  const body = await response.json();

  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.error, "knowledge_zip_publish_failed");
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 0);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_object_versions").get().count, 0);
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces WHERE id = 'namespace-1'").get().used_bytes, 0);
  assert.deepEqual(
    { ...harness.database.prepare("SELECT state, error_code FROM knowledge_zip_import_jobs").get() },
    { state: "failed", error_code: "knowledge_zip_publish_failed" }
  );
  assert.equal(harness.r2.objects.size, 0);
  assert.equal(harness.r2.putKeys.length, 2);
  assert.equal(harness.r2.deletedKeys.length, 2);
});

for (const mutationSpineV2 of [false, true]) {
  test(`Unicode folder rename and delete include the entire subtree (${mutationSpineV2 ? "v2" : "legacy"})`, async (t) => {
    const harness = createKnowledgeHarness({ mutationSpineV2 });
    t.after(() => harness.close());
    insertNamespace(harness.database, { ownerUserId: "local-dev-admin", usedBytes: 7 });
    insertObject(harness.database, { id: "unicode-root", kind: "folder", path: "📚资料" });
    insertObject(harness.database, { id: "unicode-folder", kind: "folder", path: "📚资料/📁原件" });
    insertObject(harness.database, { id: "unicode-nested", kind: "folder", path: "📚资料/📁原件/子📂目录" });
    insertObject(harness.database, { id: "unicode-file", path: "📚资料/📁原件/子📂目录/记录.md", sizeBytes: 7 });
    insertObject(harness.database, { id: "unicode-sibling", path: "📚资料/📁原件副本/记录.md" });
    const paths = () => harness.database.prepare("SELECT path, parent_path FROM knowledge_objects WHERE id = 'unicode-file'").get();
    const jsonRequest = (route, method, body) => new Request(`http://localhost${route}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });

    const renamed = await knowledgeWorker.fetch(jsonRequest("/api/objects/unicode-folder/rename", "POST", { name: "📁归档" }), harness.env);
    assert.equal(renamed.status, 200, await renamed.clone().text());
    assert.deepEqual({ ...paths() }, { path: "📚资料/📁归档/子📂目录/记录.md", parent_path: "📚资料/📁归档/子📂目录" });
    assert.equal(harness.database.prepare("SELECT path FROM knowledge_objects WHERE id = 'unicode-sibling'").get().path, "📚资料/📁原件副本/记录.md");

    if (mutationSpineV2) {
      insertObject(harness.database, { id: "unicode-target", kind: "folder", path: "📚资料/接收📥" });
      const moved = await knowledgeWorker.fetch(jsonRequest("/api/objects/unicode-folder/move", "POST", { parentObjectId: "unicode-target" }), harness.env);
      assert.equal(moved.status, 200, await moved.clone().text());
      assert.deepEqual({ ...paths() }, { path: "📚资料/接收📥/📁归档/子📂目录/记录.md", parent_path: "📚资料/接收📥/📁归档/子📂目录" });
    }

    const beforeDelete = { ...paths() };
    const deleted = await knowledgeWorker.fetch(new Request("http://localhost/api/objects/unicode-folder", { method: "DELETE" }), harness.env);
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects WHERE deleted_at IS NOT NULL").get().count, 3);
    assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces").get().used_bytes, 0);
    assert.equal(harness.database.prepare("SELECT deleted_at FROM knowledge_objects WHERE id = 'unicode-sibling'").get().deleted_at, null);

    if (mutationSpineV2) {
      const restored = await knowledgeWorker.fetch(jsonRequest("/api/objects/unicode-folder/restore", "POST", {}), harness.env);
      assert.equal(restored.status, 200, await restored.clone().text());
      assert.deepEqual({ ...paths() }, beforeDelete);
      assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects WHERE deleted_at IS NOT NULL").get().count, 0);
      assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces").get().used_bytes, 7);
    }
  });
}

test("ZIP failure cleanup includes a write whose response was lost", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
  const bytes = zipSync({ "a.txt": new TextEncoder().encode("a"), "b.txt": new TextEncoder().encode("b") });
  const put = harness.r2.put.bind(harness.r2);
  harness.r2.put = async (...args) => {
    await put(...args);
    if (harness.r2.putKeys.length === 2) throw new Error("lost_storage_response");
  };

  const response = await knowledgeWorker.fetch(formRequest("/api/files/upload", new File([bytes], "lost.zip")), harness.env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "knowledge_zip_staging_failed");
  assert.equal(harness.r2.objects.size, 0);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 0);
});

test("ZIP sweeper preserves a recently retried job even if its first attempt is old", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  const request = await createFailedZipImport(harness, "retry-old-job");
  harness.database.exec("UPDATE knowledge_zip_import_jobs SET created_at = datetime('now', '-2 hours')");
  const put = harness.r2.put.bind(harness.r2);
  harness.r2.put = async (...args) => {
    await put(...args);
    await cleanupStaleKnowledgeZipImports(harness.env);
  };

  const response = await knowledgeWorker.fetch(request(), harness.env);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(harness.database.prepare("SELECT state FROM knowledge_zip_import_jobs").get().state, "committed");
  for (const { r2_key } of harness.database.prepare("SELECT r2_key FROM knowledge_object_versions").all()) {
    assert.ok(harness.r2.objects.has(r2_key), `missing committed bytes: ${r2_key}`);
  }
});

test("ZIP concurrent failed-job retries permit only one staging owner", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  const request = await createFailedZipImport(harness, "retry-concurrent-job");
  harness.r2.putKeys.length = 0;
  const prepare = harness.d1.prepare.bind(harness.d1);
  let snapshots = 0;
  let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  let preflights = 0;
  let releasePreflights;
  const bothPreflight = new Promise(resolve => { releasePreflights = resolve; });
  harness.d1.prepare = sql => {
    const statement = prepare(sql);
    const jobLookup = /SELECT \*[\s\S]+FROM knowledge_zip_import_jobs[\s\S]+WHERE namespace_id = \?/.test(sql);
    const preflight = /SELECT COUNT\(\*\) AS count[\s\S]+substr\(path/.test(sql);
    if (jobLookup || preflight) {
      const bind = statement.bind.bind(statement);
      statement.bind = (...args) => {
        const bound = bind(...args);
        const first = bound.first.bind(bound);
        bound.first = async () => {
          const row = await first();
          if (jobLookup && snapshots < 2) {
            snapshots += 1;
            if (snapshots === 2) release();
            await bothRead;
          }
          if (preflight && preflights < 2) {
            preflights += 1;
            if (preflights === 2) releasePreflights();
            await bothPreflight;
          }
          return row;
        };
        return bound;
      };
    }
    return statement;
  };

  const responses = await Promise.all([knowledgeWorker.fetch(request(), harness.env), knowledgeWorker.fetch(request(), harness.env)]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409], JSON.stringify(bodies));
  assert.equal(bodies[responses.findIndex(response => response.status === 409)].error, "knowledge_zip_import_in_progress");
  assert.equal(harness.r2.putKeys.length, 2);
  assert.equal(harness.r2.objects.size, 2);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_object_versions").get().count, 2);
});

test("ZIP sweeper rechecks a stale snapshot before removing committed bytes", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  await createFailedZipImport(harness, "sweeper-commit-race");
  harness.database.exec("UPDATE knowledge_zip_import_jobs SET created_at = datetime('now', '-2 hours'), updated_at = datetime('now', '-2 hours'), state = 'staging'");
  const { staging_prefix: prefix } = harness.database.prepare("SELECT staging_prefix FROM knowledge_zip_import_jobs").get();
  await harness.r2.put(`${prefix}/committed-version`, new TextEncoder().encode("keep"));
  const prepare = harness.d1.prepare.bind(harness.d1);
  harness.d1.prepare = sql => {
    const statement = prepare(sql);
    if (/SELECT \*[\s\S]+state IN \('staging', 'failed'\)/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = async () => {
        const snapshot = await all();
        harness.database.exec("UPDATE knowledge_zip_import_jobs SET state = 'committed', updated_at = CURRENT_TIMESTAMP");
        return snapshot;
      };
    }
    return statement;
  };

  await cleanupStaleKnowledgeZipImports(harness.env);
  assert.ok(harness.r2.objects.has(`${prefix}/committed-version`));
  assert.equal(harness.database.prepare("SELECT state FROM knowledge_zip_import_jobs").get().state, "committed");
});

test("ZIP publication rolls back when its staging ownership has expired", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  const request = await createFailedZipImport(harness, "expired-staging-owner");
  const batch = harness.d1.batch.bind(harness.d1);
  harness.d1.batch = async statements => {
    harness.database.exec("UPDATE knowledge_zip_import_jobs SET created_at = datetime('now', '-2 hours'), updated_at = datetime('now', '-2 hours')");
    await cleanupStaleKnowledgeZipImports(harness.env);
    return batch(statements);
  };

  const response = await knowledgeWorker.fetch(request(), harness.env);
  assert.equal(response.status, 409, JSON.stringify(await response.json()));
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 0);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_object_versions").get().count, 0);
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces").get().used_bytes, 0);
  assert.equal(harness.database.prepare("SELECT state FROM knowledge_zip_import_jobs").get().state, "failed");
  assert.equal(harness.r2.objects.size, 0);
});

test("ZIP cleanup of a legacy prefix cannot remove a concurrently committed retry", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  const request = await createFailedZipImport(harness, "legacy-prefix-retry");
  const { id } = harness.database.prepare("SELECT id FROM knowledge_zip_import_jobs").get();
  const legacyPrefix = `org/org-1/ns/namespace-1/imports/${id}`;
  harness.database.prepare(`UPDATE knowledge_zip_import_jobs
    SET staging_prefix = ?, created_at = datetime('now', '-2 hours'), updated_at = datetime('now', '-2 hours')`).run(legacyPrefix);
  const list = harness.r2.list.bind(harness.r2);
  let retried = false;
  harness.r2.list = async options => {
    if (!retried) {
      retried = true;
      const retry = await knowledgeWorker.fetch(request(), harness.env);
      assert.equal(retry.status, 201, await retry.clone().text());
    }
    return list(options);
  };

  await cleanupStaleKnowledgeZipImports(harness.env);
  assert.ok(retried);
  assert.equal(harness.database.prepare("SELECT state FROM knowledge_zip_import_jobs").get().state, "committed");
  for (const { r2_key } of harness.database.prepare("SELECT r2_key FROM knowledge_object_versions").all()) {
    assert.ok(harness.r2.objects.has(r2_key), `missing committed retry: ${r2_key}`);
  }
});

async function createFailedZipImport(harness, idempotencyKey) {
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
  const bytes = zipSync({ "a.txt": new TextEncoder().encode("a"), "b.txt": new TextEncoder().encode("b") });
  const request = () => formRequest("/api/files/upload", new File([bytes], "retry.zip"), { "idempotency-key": idempotencyKey });
  harness.d1.failNextBatchAt(3);
  const failed = await knowledgeWorker.fetch(request(), harness.env);
  assert.equal(failed.status, 409);
  assert.equal(harness.database.prepare("SELECT state FROM knowledge_zip_import_jobs").get().state, "failed");
  return request;
}

test("ZIP normalized duplicate paths are rejected before D1 or R2 writes", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
  const archiveBytes = zipSync({
    "docs/same.txt": new TextEncoder().encode("first"),
    "docs\\same.txt": new TextEncoder().encode("second")
  });

  const response = await knowledgeWorker.fetch(
    formRequest("/api/files/upload", new File([archiveBytes], "duplicates.zip", { type: "application/zip" })),
    harness.env
  );
  const body = await response.json();

  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.error, "knowledge_zip_duplicate_path");
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 0);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_zip_import_jobs").get().count, 0);
  assert.equal(harness.r2.putKeys.length, 0);
});

for (const [name, entries, expectedStatus, expectedError] of [
  ["traversal", { "docs/../escape.md": new Uint8Array() }, 400, "invalid_zip_entry_path"],
  ["folder-conflict", { "docs": new Uint8Array(), "docs/empty.md": new Uint8Array() }, 409, "knowledge_zip_file_folder_conflict"],
  ["directories-only", { "docs/": new Uint8Array() }, 400, "knowledge_zip_contains_no_files"]
]) {
  test(`ZIP ${name} fails before staging with an explicit error`, async (t) => {
    const harness = createKnowledgeHarness({ rootAclV2: true, mutationSpineV2: true });
    t.after(() => harness.close());
    insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
    const response = await knowledgeWorker.fetch(formRequest("/api/files/upload", new File([zipSync(entries)], `${name}.zip`)), harness.env);
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).error, expectedError);
    assert.equal(harness.r2.putKeys.length, 0);
    assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_zip_import_jobs").get().count, 0);
  });
}

test("ZIP identical central-directory entry names cannot silently overwrite files", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
  const bytes = zipSync({ "one.md": new Uint8Array([1]), "two.md": new Uint8Array([2]) });
  const original = new TextEncoder().encode("two.md");
  for (let offset = 0; offset <= bytes.length - original.length; offset += 1) {
    if (original.every((byte, index) => bytes[offset + index] === byte)) {
      bytes.set(new TextEncoder().encode("one.md"), offset);
    }
  }
  const response = await knowledgeWorker.fetch(formRequest("/api/files/upload", new File([bytes], "identical.zip")), harness.env);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "knowledge_zip_duplicate_path");
  assert.equal(harness.r2.putKeys.length, 0);
});

test("ZIP per-file limit is checked before decompression and staging", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
  const bytes = zipSync({ "large.md": new Uint8Array([1]) });
  setFirstZipCentralDirectoryUncompressedSize(bytes, 25_000_001);
  const response = await knowledgeWorker.fetch(formRequest("/api/files/upload", new File([bytes], "large.zip")), harness.env);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "knowledge_file_too_large");
  assert.equal(harness.r2.putKeys.length, 0);
});

for (const conflictingPath of ["归档 %_ Bundle", "归档 %_ Bundle/docs/old.md"]) {
  test(`ZIP preflight rejects literal root or descendant conflicts (${conflictingPath})`, async (t) => {
    const harness = createKnowledgeHarness();
    t.after(() => harness.close());
    insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
    insertObject(harness.database, { id: "conflict", path: conflictingPath });
    const bytes = zipSync({ "empty.md": new Uint8Array() });
    const response = await knowledgeWorker.fetch(formRequest("/api/files/upload", new File([bytes], "归档 %_ Bundle.zip")), harness.env);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "knowledge_zip_root_exists");
    assert.equal(harness.r2.putKeys.length, 0);
  });
}

test("ZIP literal preflight permits prefix siblings and wildcard-like folder names", async (t) => {
  const harness = createKnowledgeHarness();
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
  insertObject(harness.database, { id: "sibling", path: "归档 %_ Bundle sibling/old.md" });
  insertObject(harness.database, { id: "wildcard", path: "归档 XX Bundle/old.md" });
  const bytes = zipSync({ "empty.md": new Uint8Array() });
  const response = await knowledgeWorker.fetch(formRequest("/api/files/upload", new File([bytes], "归档 %_ Bundle.zip")), harness.env);
  assert.equal(response.status, 201, (await response.json()).error);
  assert.equal(harness.r2.objects.size, 1);
});

test("ZIP audit preparation failure cleans staging and permits an idempotent retry", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true, mutationSpineV2: true });
  t.after(() => harness.close());
  const parentResponse = await knowledgeWorker.fetch(new Request("http://localhost/api/folders", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "History" })
  }), harness.env);
  const parent = (await parentResponse.json()).item;
  const bytes = zipSync({ "empty.md": new Uint8Array() });
  const request = async () => {
    const value = formRequest("/api/files/upload", new File([bytes], "retry-preparation.zip"), { "idempotency-key": "audit-preparation-retry" });
    (await value.formData()).set("parentObjectId", parent.id);
    return value;
  };
  const originalPrepare = harness.d1.prepare.bind(harness.d1);
  let failed = false;
  harness.d1.prepare = sql => {
    if (!failed && harness.r2.putKeys.length > 0 && sql.includes("parent_path = '' AND path = ?")) {
      failed = true;
      throw new Error("injected_zip_audit_preparation_failure");
    }
    return originalPrepare(sql);
  };
  const response = await knowledgeWorker.fetch(await request(), harness.env);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "knowledge_zip_publish_failed");
  assert.equal(harness.r2.objects.size, 0);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_objects").get().count, 1);
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces").get().used_bytes, 0);
  assert.equal(harness.database.prepare("SELECT state FROM knowledge_zip_import_jobs").get().state, "failed");
  const retried = await knowledgeWorker.fetch(await request(), harness.env);
  assert.equal(retried.status, 201, (await retried.json()).error);
  assert.equal(harness.r2.objects.size, 1);
});

test("ZIP V2 late failure rolls back ownership, audit, empty files and supports repeated cleanup", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true, mutationSpineV2: true });
  t.after(() => harness.close());
  insertNamespace(harness.database, { ownerUserId: "local-dev-admin" });
  const bytes = zipSync({ "empty.md": new Uint8Array(), "docs/中文 空格.md": new TextEncoder().encode("synthetic") });
  const request = () => formRequest("/api/files/upload", new File([bytes], "late-failure.zip"), { "idempotency-key": "late-failure" });
  const originalBatch = harness.d1.batch.bind(harness.d1);
  let failOnce = true;
  harness.d1.batch = statements => {
    if (failOnce) {
      failOnce = false;
      harness.d1.failNextBatchAt(statements.length - 1);
    }
    return originalBatch(statements);
  };
  const response = await knowledgeWorker.fetch(request(), harness.env);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "knowledge_zip_publish_failed");
  for (const table of ["knowledge_objects", "knowledge_object_versions", "knowledge_ingestion_states",
    "knowledge_permissions", "knowledge_permission_provenance", "knowledge_mutation_commands",
    "knowledge_change_sets", "knowledge_change_items", "knowledge_index_outbox"]) {
    assert.equal(harness.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
  assert.equal(harness.database.prepare("SELECT used_bytes FROM knowledge_namespaces").get().used_bytes, 0);
  const job = harness.database.prepare("SELECT * FROM knowledge_zip_import_jobs").get();
  assert.equal(job.state, "failed");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await failKnowledgeZipImportAndCleanup(harness.env, job.id, job.staging_prefix, harness.r2.putKeys, job.error_code);
    assert.equal(harness.r2.objects.size, 0);
  }
  const retry = await knowledgeWorker.fetch(request(), harness.env);
  assert.equal(retry.status, 201, (await retry.json()).error);
  assert.equal(harness.r2.objects.size, 2);
  // Cleanup from the failed attempt cannot delete a later committed attempt.
  await failKnowledgeZipImportAndCleanup(harness.env, job.id, job.staging_prefix, harness.r2.putKeys.slice(0, 2), job.error_code);
  assert.equal(harness.r2.objects.size, 2);
});

test("folder tree projects access metadata in a bounded number of D1 queries", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true, mutationSpineV2: true });
  t.after(() => harness.close());
  const headers = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
    "x-workspace-user-id": "owner-1",
    "x-workspace-user-name": "Owner One"
  };
  const createFolder = async (name, parentObjectId) => {
    const response = await knowledgeWorker.fetch(
      new Request("http://localhost/api/folders", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name, parentObjectId })
      }),
      harness.env
    );
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body.item;
  };

  const root = await createFolder("Query Count Root");
  for (let index = 0; index < 24; index += 1) {
    await createFolder(`Folder ${String(index).padStart(2, "0")}`, root.id);
  }

  harness.d1.resetPrepareCount();
  const treeResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/tree?folderObjectId=${encodeURIComponent(root.id)}`, { headers }),
    harness.env
  );
  const tree = await treeResponse.json();

  assert.equal(treeResponse.status, 200, JSON.stringify(tree));
  assert.equal(tree.items.length, 24);
  assert.ok(
    harness.d1.prepareCount <= 12,
    `expected no more than 12 D1 prepares for 24 items, received ${harness.d1.prepareCount}`
  );
});

test("ai_adoption can exercise the PB Partner fixture as a live Knowledge Service", async (t) => {
  const harness = createKnowledgeHarness({
    indexReadV2: true,
    knowledgeIndexQueue: true,
    rootAclV2: true
  });
  t.after(() => harness.close());
  const ownerHeaders = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
    "x-workspace-user-email": "ai_adoption@example.invalid",
    "x-workspace-user-id": "ai_adoption",
    "x-workspace-user-name": "AI Adoption"
  };
  const viewerHeaders = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read",
    "x-workspace-user-email": "pb_viewer@example.invalid",
    "x-workspace-user-id": "pb_viewer",
    "x-workspace-user-name": "PB Viewer"
  };
  const jsonRequest = (path, method, body, headers = ownerHeaders) => new Request(
    `http://localhost${path}`,
    {
      method,
      headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }
  );

  const fixtureEntries = Object.fromEntries(await Promise.all(
    pbPartnerFixturePaths.map(async (path) => [
      path,
      new Uint8Array(await readFile(new URL(path, pbPartnerFixtureUrl)))
    ])
  ));
  const archiveBytes = zipSync(fixtureEntries);
  const importedResponse = await knowledgeWorker.fetch(
    formRequest(
      "/api/files/upload",
      new File([archiveBytes], "PB Partner.zip", { type: "application/zip" }),
      { ...ownerHeaders, "idempotency-key": "pb-partner-fixture-v1" }
    ),
    harness.env
  );
  const imported = await importedResponse.json();
  assert.equal(importedResponse.status, 201, JSON.stringify(imported));
  assert.equal(imported.item.path, "PB Partner");
  assert.equal(imported.items.length, 16);
  assert.equal(imported.namespace.ownerUserId, "ai_adoption");
  assert.equal(
    harness.database.prepare("SELECT owner_user_id FROM knowledge_namespaces").get().owner_user_id,
    "ai_adoption"
  );

  const root = imported.item;
  const byRelativePath = (path) => imported.items.find((item) => item.path === `PB Partner/${path}`);
  const entity = byRelativePath("entities/example-bank.md");
  assert.ok(entity);

  const treeResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/tree?folderObjectId=${encodeURIComponent(root.id)}`, { headers: ownerHeaders }),
    harness.env
  );
  const tree = await treeResponse.json();
  assert.equal(treeResponse.status, 200, JSON.stringify(tree));
  assert.deepEqual(
    tree.items.map((item) => item.name).sort(),
    ["README.md", "catalog", "entities", "governance", "handbook.md", "topics", "views"]
  );

  const scratchResponse = await knowledgeWorker.fetch(
    jsonRequest("/api/folders", "POST", { name: "_test_scratch", parentObjectId: root.id }),
    harness.env
  );
  const scratch = await scratchResponse.json();
  assert.equal(scratchResponse.status, 201, JSON.stringify(scratch));
  const scratchUpload = new FormData();
  scratchUpload.set("parentObjectId", scratch.item.id);
  scratchUpload.set("file", new File(["temporary"], "notes.txt", { type: "text/plain" }));
  const scratchFileResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/files/upload", {
      method: "POST",
      headers: ownerHeaders,
      body: scratchUpload
    }),
    harness.env
  );
  const scratchFile = await scratchFileResponse.json();
  assert.equal(scratchFileResponse.status, 201, JSON.stringify(scratchFile));
  const renamedResponse = await knowledgeWorker.fetch(
    jsonRequest(`/api/objects/${scratchFile.item.id}/rename`, "PATCH", { name: "renamed.txt" }),
    harness.env
  );
  const renamed = await renamedResponse.json();
  assert.equal(renamedResponse.status, 200, JSON.stringify(renamed));
  assert.equal(renamed.item.name, "renamed.txt");
  assert.equal(
    (await knowledgeWorker.fetch(
      new Request(`http://localhost/api/objects/${scratchFile.item.id}`, { method: "DELETE", headers: ownerHeaders }),
      harness.env
    )).status,
    200
  );
  assert.equal(
    (await knowledgeWorker.fetch(
      new Request(`http://localhost/api/objects/${scratch.item.id}`, { method: "DELETE", headers: ownerHeaders }),
      harness.env
    )).status,
    200
  );

  const preflightResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/knowledge-services/preflight?folderObjectId=${encodeURIComponent(root.id)}`,
      { headers: ownerHeaders }
    ),
    harness.env
  );
  const preflight = await preflightResponse.json();
  assert.equal(preflightResponse.status, 200, JSON.stringify(preflight));
  assert.equal(preflight.status, "ready");

  const publishResponse = await knowledgeWorker.fetch(
    jsonRequest("/api/knowledge-services", "POST", {
      access: { company: false, departments: [], users: ["pb_viewer"] },
      description: "PB Partner synthetic integration fixture",
      folderObjectId: root.id,
      name: "PB Partner",
      profile: {
        category: "private-banking",
        coverage: ["合作机构、开户场景、KYC 与合作条款"],
        feedbackEnabled: true,
        languages: ["zh-CN", "en"],
        maintenanceTeam: "PB Operations",
        notFor: ["客户资产配置建议"],
        tags: ["pb", "onboarding", "kyc"]
      }
    }),
    harness.env
  );
  const published = await publishResponse.json();
  assert.equal(publishResponse.status, 201, JSON.stringify(published));
  assert.equal(published.service.agentEnabled, true);
  assert.equal(published.service.indexStatus, "ready");
  assert.deepEqual(published.service.profile, {
    category: "private-banking",
    coverage: ["合作机构、开户场景、KYC 与合作条款"],
    feedbackEnabled: true,
    languages: ["zh-CN", "en"],
    maintenanceTeam: "PB Operations",
    notFor: ["客户资产配置建议"],
    role: "",
    searchHints: [],
    tags: ["pb", "onboarding", "kyc"]
  });
  const serviceId = published.service.id;

  const cardListResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/knowledge-services?view=card", { headers: viewerHeaders }),
    harness.env
  );
  const cardList = await cardListResponse.json();
  assert.equal(cardListResponse.status, 200, JSON.stringify(cardList));
  assert.equal(cardList.services.length, 1);
  assert.deepEqual(
    {
      category: cardList.services[0].category,
      coverage: cardList.services[0].coverage,
      effectiveRole: cardList.services[0].effectiveRole,
      languages: cardList.services[0].languages,
      maintenanceTeam: cardList.services[0].maintenanceTeam,
      notFor: cardList.services[0].notFor,
      role: cardList.services[0].role,
      searchHints: cardList.services[0].searchHints,
      serviceId: cardList.services[0].serviceId,
      tags: cardList.services[0].tags
    },
    {
      category: "private-banking",
      coverage: ["合作机构、开户场景、KYC 与合作条款"],
      effectiveRole: "viewer",
      languages: ["zh-CN", "en"],
      maintenanceTeam: "PB Operations",
      notFor: ["客户资产配置建议"],
      role: "",
      searchHints: [],
      serviceId,
      tags: ["pb", "onboarding", "kyc"]
    }
  );
  assert.equal(cardList.services[0].retrieval.search, true);
  assert.equal(cardList.services[0].feedback.canSubmit, true);
  assert.equal(Object.hasOwn(cardList.services[0], "folderObjectId"), false);

  const r2ReadsBeforeMetadata = harness.r2.getKeys.length;
  const serviceTreeResponse = await knowledgeWorker.fetch(
    jsonRequest(
      `/api/knowledge-services/${serviceId}/tree`,
      "POST",
      { depth: 3, relativePath: "entities" },
      viewerHeaders
    ),
    harness.env
  );
  const serviceTree = await serviceTreeResponse.json();
  assert.equal(serviceTreeResponse.status, 200, JSON.stringify(serviceTree));
  assert.ok(serviceTree.items.some((item) => item.relativePath === "entities/example-bank.md"));
  const serviceGlobResponse = await knowledgeWorker.fetch(
    jsonRequest(
      `/api/knowledge-services/${serviceId}/glob`,
      "POST",
      { pattern: "**/*.md" },
      viewerHeaders
    ),
    harness.env
  );
  const serviceGlob = await serviceGlobResponse.json();
  assert.equal(serviceGlobResponse.status, 200, JSON.stringify(serviceGlob));
  assert.ok(serviceGlob.items.some((item) => item.relativePath === "views/client-scenarios.md"));
  assert.equal(harness.r2.getKeys.length, r2ReadsBeforeMetadata);

  const handbookResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/knowledge-services/${serviceId}/handbook`, { headers: viewerHeaders }),
    harness.env
  );
  const handbook = await handbookResponse.json();
  assert.equal(handbookResponse.status, 200, JSON.stringify(handbook));
  assert.match(handbook.content, /会话、使用记录、用户画像/);

  const searchResponse = await knowledgeWorker.fetch(
    jsonRequest(
      `/api/knowledge-services/${serviceId}/search`,
      "POST",
      {
        query: "ALPHA-SCENARIO",
        queryContext: {
          clientSessionId: "agent-session-pb-1",
          clientTurnId: "turn-7",
          originalQuestion: "有哪些适用的私行合作场景？",
          storeOriginalQuestion: false
        }
      },
      viewerHeaders
    ),
    harness.env
  );
  const search = await searchResponse.json();
  assert.equal(searchResponse.status, 200, JSON.stringify(search));
  assert.equal(search.results[0].relativePath, "views/client-scenarios.md");
  assert.match(search.queryLedger.queryId, /^kquery_/);
  assert.match(search.queryLedger.queryStepId, /^kstep_/);
  const querySession = harness.database.prepare(
    `SELECT client_session_id, client_turn_id, original_question_hash,
            original_question_text, raw_question_expires_at
     FROM knowledge_query_sessions
     WHERE id = ?`
  ).get(search.queryLedger.queryId);
  assert.deepEqual(
    {
      clientSessionId: querySession.client_session_id,
      clientTurnId: querySession.client_turn_id,
      originalQuestionText: querySession.original_question_text,
      rawQuestionExpiresAt: querySession.raw_question_expires_at
    },
    {
      clientSessionId: "agent-session-pb-1",
      clientTurnId: "turn-7",
      originalQuestionText: "",
      rawQuestionExpiresAt: null
    }
  );
  assert.match(querySession.original_question_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    { ...harness.database.prepare(
      `SELECT action, parent_step_id, result_count, status
       FROM knowledge_query_steps
       WHERE id = ?`
    ).get(search.queryLedger.queryStepId) },
    {
      action: "search",
      parent_step_id: null,
      result_count: search.results.length,
      status: "succeeded"
    }
  );

  const crossEntitySearchResponse = await knowledgeWorker.fetch(
    jsonRequest(
      `/api/knowledge-services/${serviceId}/search`,
      "POST",
      { query: "HARBOR-FAST-TRACK" },
      viewerHeaders
    ),
    harness.env
  );
  const crossEntitySearch = await crossEntitySearchResponse.json();
  assert.equal(crossEntitySearchResponse.status, 200, JSON.stringify(crossEntitySearch));
  assert.ok(
    crossEntitySearch.results.some((result) => result.relativePath === "entities/example-trust.md")
  );

  const catalogSearchResponse = await knowledgeWorker.fetch(
    jsonRequest(
      `/api/knowledge-services/${serviceId}/search`,
      "POST",
      { query: "最低门槛 200 TEST_UNITS" },
      viewerHeaders
    ),
    harness.env
  );
  const catalogSearch = await catalogSearchResponse.json();
  assert.equal(catalogSearchResponse.status, 200, JSON.stringify(catalogSearch));
  assert.ok(
    catalogSearch.results.some((result) => result.relativePath === "catalog/partners.jsonl")
  );

  const grepResponse = await knowledgeWorker.fetch(
    jsonRequest(`/api/knowledge-services/${serviceId}/grep`, "POST", { pattern: "待确认" }, viewerHeaders),
    harness.env
  );
  const grep = await grepResponse.json();
  assert.equal(grepResponse.status, 200, JSON.stringify(grep));
  assert.ok(grep.results.some((result) => result.relativePath === "entities/example-bank.md"));

  const readResponse = await knowledgeWorker.fetch(
    jsonRequest(
      `/api/knowledge-services/${serviceId}/read`,
      "POST",
      {
        queryContext: {
          parentStepId: search.queryLedger.queryStepId,
          queryId: search.queryLedger.queryId
        },
        relativePath: "entities/example-bank.md"
      },
      viewerHeaders
    ),
    harness.env
  );
  const read = await readResponse.json();
  assert.equal(readResponse.status, 200, JSON.stringify(read));
  assert.match(read.content.text, /示例机构甲/);
  assert.equal(read.queryLedger.queryId, search.queryLedger.queryId);
  assert.deepEqual(
    { ...harness.database.prepare(
      `SELECT action, parent_step_id, result_count, status
       FROM knowledge_query_steps
       WHERE id = ?`
    ).get(read.queryLedger.queryStepId) },
    {
      action: "read",
      parent_step_id: search.queryLedger.queryStepId,
      result_count: 1,
      status: "succeeded"
    }
  );

  const feedbackResponse = await knowledgeWorker.fetch(
    jsonRequest(
      "/api/feedback",
      "POST",
      {
        kind: "suggestion",
        message: "请补充信托账户开户时效。",
        queryId: search.queryLedger.queryId,
        queryStepId: read.queryLedger.queryStepId,
        serviceId
      },
      {
        ...viewerHeaders,
        "idempotency-key": "pb-viewer-query-feedback-1",
        "x-workspace-source-channel": "mcp"
      }
    ),
    harness.env
  );
  const feedback = await feedbackResponse.json();
  assert.equal(feedbackResponse.status, 201, JSON.stringify(feedback));
  assert.equal(feedback.feedback.queryId, search.queryLedger.queryId);
  assert.equal(feedback.feedback.queryStepId, read.queryLedger.queryStepId);

  const myFeedbackResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/feedback/mine?serviceId=${encodeURIComponent(serviceId)}`,
      { headers: viewerHeaders }
    ),
    harness.env
  );
  const myFeedback = await myFeedbackResponse.json();
  assert.equal(myFeedbackResponse.status, 200, JSON.stringify(myFeedback));
  assert.equal(myFeedback.feedback[0].id, feedback.feedback.id);
  const feedbackGetResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/feedback/${encodeURIComponent(feedback.feedback.id)}`,
      { headers: viewerHeaders }
    ),
    harness.env
  );
  const feedbackGet = await feedbackGetResponse.json();
  assert.equal(feedbackGetResponse.status, 200, JSON.stringify(feedbackGet));
  assert.equal(feedbackGet.feedback.queryId, search.queryLedger.queryId);

  const previewResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/view/${entity.id}`, { headers: ownerHeaders }),
    harness.env
  );
  assert.equal(previewResponse.status, 200);
  assert.match(previewResponse.headers.get("content-type") ?? "", /text\/html/);

  const shareResponse = await knowledgeWorker.fetch(
    jsonRequest(`/api/objects/${entity.id}/public-share`, "POST", { expiry: "24h" }),
    harness.env
  );
  const shared = await shareResponse.json();
  assert.equal(shareResponse.status, 201, JSON.stringify(shared));
  const publicRawResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/public/${shared.share.slug}/raw`),
    harness.env
  );
  assert.equal(publicRawResponse.status, 200);
  assert.match(await publicRawResponse.text(), /示例机构甲/);
  assert.equal(
    (await knowledgeWorker.fetch(
      new Request(`http://localhost/api/objects/${entity.id}/public-share`, {
        method: "DELETE",
        headers: ownerHeaders
      }),
      harness.env
    )).status,
    200
  );

  const updateForm = new FormData();
  updateForm.set(
    "file",
    new File(
      [`${read.content.text}\n\nLIVE-UPDATE-MARKER：本行验证同名替换后的自动刷新。\n`],
      "example-bank.md",
      { type: "text/markdown" }
    )
  );
  updateForm.set("expectedCurrentVersionId", entity.currentVersionId);
  harness.env.KNOWLEDGE_V2_MUTATION_SPINE_ENABLED = "1";
  const updateResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/files/${entity.id}/versions`, {
      method: "POST",
      headers: { ...ownerHeaders, "idempotency-key": "pb-partner-live-update-v2" },
      body: updateForm
    }),
    harness.env
  );
  const updated = await updateResponse.json();
  assert.equal(updateResponse.status, 201, JSON.stringify(updated));
  assert.equal(updated.version.version, 2);
  assert.equal(
    harness.database.prepare(
      "SELECT source_revision FROM knowledge_services WHERE id = ?"
    ).get(serviceId).source_revision,
    1
  );
  assert.deepEqual(
    harness.queueMessages.map((message) => ({
      kind: message.kind,
      serviceId: message.serviceId,
      sourceRevision: message.sourceRevision
    })),
    [{ kind: "service_reindex", serviceId, sourceRevision: 1 }]
  );
  assert.deepEqual(
    { ...harness.database.prepare(
      `SELECT diff_status, error_code
       FROM knowledge_change_items
       WHERE version_after_id = ?`
    ).get(updated.version.id) },
    { diff_status: "ready", error_code: "" }
  );

  const refreshedSearchResponse = await knowledgeWorker.fetch(
    jsonRequest(
      `/api/knowledge-services/${serviceId}/search`,
      "POST",
      { query: "LIVE-UPDATE-MARKER" },
      viewerHeaders
    ),
    harness.env
  );
  const refreshedSearch = await refreshedSearchResponse.json();
  assert.equal(refreshedSearchResponse.status, 409, JSON.stringify(refreshedSearch));
  assert.equal(refreshedSearch.error, "knowledge_service_index_not_ready");
  const explicitReindexResponse = await knowledgeWorker.fetch(
    jsonRequest(`/api/knowledge-services/${serviceId}`, "PATCH", { reindex: true }),
    harness.env
  );
  const explicitReindex = await explicitReindexResponse.json();
  assert.equal(explicitReindexResponse.status, 200, JSON.stringify(explicitReindex));
  const indexedSearchResponse = await knowledgeWorker.fetch(
    jsonRequest(
      `/api/knowledge-services/${serviceId}/search`,
      "POST",
      { query: "LIVE-UPDATE-MARKER" },
      viewerHeaders
    ),
    harness.env
  );
  const indexedSearch = await indexedSearchResponse.json();
  assert.equal(indexedSearchResponse.status, 200, JSON.stringify(indexedSearch));
  assert.equal(indexedSearch.results[0].versionId, updated.version.id);

  harness.env.KNOWLEDGE_V2_INDEX_READ_ENABLED = "0";
  harness.env.KNOWLEDGE_V2_SHADOW_READ_ENABLED = "1";
  const shadowResponse = await knowledgeWorker.fetch(
    jsonRequest(
      `/api/knowledge-services/${serviceId}/search`,
      "POST",
      { query: "LIVE-UPDATE-MARKER" },
      viewerHeaders
    ),
    harness.env
  );
  assert.equal(shadowResponse.status, 200, JSON.stringify(await shadowResponse.json()));
  const shadowReport = harness.database.prepare(
    `SELECT action, status, stale_leak_detected
     FROM knowledge_shadow_query_reports
     WHERE service_id = ?
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(serviceId);
  assert.deepEqual(
    { ...shadowReport },
    { action: "search", stale_leak_detected: 0, status: "compared" }
  );
  harness.env.KNOWLEDGE_V2_INDEX_READ_ENABLED = "1";
  harness.env.KNOWLEDGE_V2_SHADOW_READ_ENABLED = "0";

  const mandatoryFeedbackResponse = await knowledgeWorker.fetch(
    jsonRequest(
      `/api/knowledge-services/${serviceId}`,
      "PATCH",
      { profile: { feedbackEnabled: false } }
    ),
    harness.env
  );
  const mandatoryFeedback = await mandatoryFeedbackResponse.json();
  assert.equal(mandatoryFeedbackResponse.status, 200, JSON.stringify(mandatoryFeedback));
  assert.equal(mandatoryFeedback.service.profile.feedbackEnabled, true);
  const mandatoryFeedbackCardResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/knowledge-services?view=card", { headers: viewerHeaders }),
    harness.env
  );
  const mandatoryFeedbackCard = await mandatoryFeedbackCardResponse.json();
  assert.equal(mandatoryFeedbackCardResponse.status, 200, JSON.stringify(mandatoryFeedbackCard));
  assert.deepEqual(mandatoryFeedbackCard.services[0].feedback, {
    canManage: false,
    canSubmit: true,
    canViewMine: true,
    enabled: true
  });
  const existingFeedbackResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/feedback/mine?serviceId=${encodeURIComponent(serviceId)}`,
      { headers: viewerHeaders }
    ),
    harness.env
  );
  const existingFeedback = await existingFeedbackResponse.json();
  assert.equal(existingFeedbackResponse.status, 200, JSON.stringify(existingFeedback));
  assert.equal(existingFeedback.feedback[0].id, feedback.feedback.id);
  const mandatoryFeedbackSubmissionResponse = await knowledgeWorker.fetch(
    jsonRequest(
      "/api/feedback",
      "POST",
      {
        kind: "issue",
        message: "Feedback stays available for every active Agent Knowledge service.",
        serviceId
      },
      {
        ...viewerHeaders,
        "idempotency-key": "pb-viewer-disabled-feedback-1"
      }
    ),
    harness.env
  );
  const mandatoryFeedbackSubmission = await mandatoryFeedbackSubmissionResponse.json();
  assert.equal(mandatoryFeedbackSubmissionResponse.status, 201, JSON.stringify(mandatoryFeedbackSubmission));

  const disableResponse = await knowledgeWorker.fetch(
    jsonRequest(`/api/knowledge-services/${serviceId}`, "PATCH", { agentEnabled: false }),
    harness.env
  );
  const disabled = await disableResponse.json();
  assert.equal(disableResponse.status, 200, JSON.stringify(disabled));
  assert.equal(disabled.service.agentEnabled, false);
  assert.equal(
    (await knowledgeWorker.fetch(
      jsonRequest(
        `/api/knowledge-services/${serviceId}/search`,
        "POST",
        { query: "ALPHA-SCENARIO" },
        viewerHeaders
      ),
      harness.env
    )).status,
    404
  );
  assert.equal(
    (await knowledgeWorker.fetch(
      new Request(`http://localhost/api/files/${entity.id}`, { headers: viewerHeaders }),
      harness.env
    )).status,
    403
  );

  const auditActions = harness.database
    .prepare("SELECT action FROM knowledge_audit_events ORDER BY created_at, id")
    .all()
    .map((row) => row.action);
  assert.ok(auditActions.includes("knowledge.service.create"));
  assert.ok(auditActions.includes("knowledge.service.reindex"));
  assert.ok(auditActions.includes("knowledge.service.disable"));
  assert.ok(auditActions.includes("knowledge.public_share.create"));
  assert.ok(auditActions.includes("knowledge.public_share.revoke"));
});

test("canonical indexing continues during legacy-read rollout and disable purges canonical documents", async (t) => {
  const harness = createKnowledgeHarness({ indexReadV2: false, rootAclV2: true });
  t.after(() => harness.close());
  const headers = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
    "x-workspace-user-id": "rollout-owner",
    "x-workspace-user-name": "Rollout Owner"
  };
  const rootResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Shadow Rollout Root" })
    }),
    harness.env
  );
  const root = await rootResponse.json();
  assert.equal(rootResponse.status, 201, JSON.stringify(root));
  for (const [name, text] of [
    ["handbook.md", "# Shadow rollout\n\nUse the indexed source."],
    ["source.md", "# Source\n\nCANONICAL-SHADOW-MARKER"]
  ]) {
    const form = new FormData();
    form.set("parentObjectId", root.item.id);
    form.set("file", new File([text], name, { type: "text/markdown" }));
    const response = await knowledgeWorker.fetch(
      new Request("http://localhost/api/files/upload", {
        method: "POST",
        headers,
        body: form
      }),
      harness.env
    );
    assert.equal(response.status, 201, JSON.stringify(await response.json()));
  }

  const publishResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/knowledge-services", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        access: { company: false, departments: [], users: [] },
        folderObjectId: root.item.id,
        name: "Shadow Rollout"
      })
    }),
    harness.env
  );
  const published = await publishResponse.json();
  assert.equal(publishResponse.status, 201, JSON.stringify(published));
  const serviceId = published.service.id;
  assert.equal(
    harness.database.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_index_documents WHERE service_id = ? AND status = 'ready'"
    ).get(serviceId).count,
    1
  );
  assert.deepEqual(
    { ...harness.database.prepare(
      "SELECT source_revision, indexed_revision, status FROM knowledge_service_index_state WHERE service_id = ?"
    ).get(serviceId) },
    { indexed_revision: 0, source_revision: 0, status: "ready" }
  );

  const disableResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/knowledge-services/${serviceId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ agentEnabled: false })
    }),
    harness.env
  );
  assert.equal(disableResponse.status, 200, JSON.stringify(await disableResponse.json()));
  assert.equal(
    harness.database.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_index_documents WHERE service_id = ?"
    ).get(serviceId).count,
    0
  );
  assert.deepEqual(
    { ...harness.database.prepare(
      "SELECT indexed_revision, status FROM knowledge_service_index_state WHERE service_id = ?"
    ).get(serviceId) },
    { indexed_revision: 0, status: "disabled" }
  );
});

test("text search follows folder ACL without enabling a Knowledge Service", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true });
  t.after(() => harness.close());
  const headers = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
    "x-workspace-user-id": "search-owner",
    "x-workspace-user-name": "Search Owner"
  };
  const created = await knowledgeWorker.fetch(new Request("http://localhost/api/folders", {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Private Notes" })
  }), harness.env);
  const root = await created.json();
  assert.equal(created.status, 201, JSON.stringify(root));
  const form = new FormData();
  form.set("parentObjectId", root.item.id);
  form.set("file", new File(["Alpha note\nExact phrase here"], "note.md", { type: "text/markdown" }));
  const upload = await knowledgeWorker.fetch(new Request("http://localhost/api/files/upload", {
    method: "POST", headers, body: form
  }), harness.env);
  const uploaded = await upload.json();
  assert.equal(upload.status, 201, JSON.stringify(uploaded));

  const grantResponse = await knowledgeWorker.fetch(new Request("http://localhost/api/access-grants", {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ objectId: root.item.id, subjectType: "user", subjectId: "search-viewer", role: "viewer" })
  }), harness.env);
  assert.equal(grantResponse.status, 201, await grantResponse.text());
  const viewerHeaders = { ...headers, "x-workspace-user-id": "search-viewer" };
  const sharedResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/shared-with-me", { headers: viewerHeaders }), harness.env
  );
  const shared = await sharedResponse.json();
  assert.equal(sharedResponse.status, 200, JSON.stringify(shared));
  assert.equal(shared.items.some((item) => item.id === root.item.id), true);

  const query = async (action, value, requestHeaders = headers) => {
    const response = await knowledgeWorker.fetch(new Request(`http://localhost/api/knowledge-folders/${root.item.id}/query`, {
      method: "POST", headers: { ...requestHeaders, "content-type": "application/json" },
      body: JSON.stringify({ action, ...(action === "search" ? { query: value } : { pattern: value }) })
    }), harness.env);
    return { response, payload: await response.json() };
  };
  const search = await query("search", "Alpha");
  assert.equal(search.response.status, 200, JSON.stringify(search.payload));
  assert.equal(search.payload.results[0].objectId, uploaded.item.id);
  const grep = await query("grep", "Exact phrase");
  assert.equal(grep.response.status, 200, JSON.stringify(grep.payload));
  assert.equal(grep.payload.results[0].lineNumber, 2);
  const viewerSearch = await query("search", "Alpha", viewerHeaders);
  assert.equal(viewerSearch.response.status, 200, JSON.stringify(viewerSearch.payload));
  assert.equal(viewerSearch.payload.results[0].objectId, uploaded.item.id);
  const handbookForm = new FormData();
  handbookForm.set("parentObjectId", root.item.id);
  handbookForm.set("file", new File(["# Handbook"], "handbook.md", { type: "text/markdown" }));
  const handbookUpload = await knowledgeWorker.fetch(new Request("http://localhost/api/files/upload", {
    method: "POST", headers, body: handbookForm
  }), harness.env);
  assert.equal(handbookUpload.status, 201, await handbookUpload.text());
  const serviceResponse = await knowledgeWorker.fetch(new Request("http://localhost/api/knowledge-services", {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      access: { company: false, departments: [], users: ["search-viewer"] },
      folderObjectId: root.item.id,
      name: "Private Notes Handbook"
    })
  }), harness.env);
  const service = await serviceResponse.json();
  assert.equal(serviceResponse.status, 201, JSON.stringify(service));
  const disableResponse = await knowledgeWorker.fetch(new Request(`http://localhost/api/knowledge-services/${service.service.id}`, {
    method: "PATCH", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ agentEnabled: false })
  }), harness.env);
  assert.equal(disableResponse.status, 200, await disableResponse.text());
  const afterDisable = await query("search", "Alpha", viewerHeaders);
  assert.equal(afterDisable.response.status, 200, JSON.stringify(afterDisable.payload));
  assert.equal(afterDisable.payload.results[0].objectId, uploaded.item.id);
  const denied = await query("search", "Alpha", { ...headers, "x-workspace-user-id": "unshared-user" });
  assert.equal(denied.response.status, 403);
});

test("collaborator replacement preserves Owner links and returns only collaborators", async (t) => {
  const harness = createAccessGovernanceHarness();
  t.after(() => harness.close());
  const { call } = harness;
  for (const user of ["owner-1", "collaborator-1"]) insertGovernanceShare(harness, user);
  const response = await call("/api/objects/governance-root/collaborators", "PUT", { userIds: ["collaborator-1"] });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body.userIds, ["collaborator-1"]);
  assert.deepEqual(body.collaborators.map(grant => grant.subjectId), ["collaborator-1"]);
  assert.equal(harness.database.prepare("SELECT revoked_at FROM knowledge_shares WHERE id = 'share-owner-1'").get().revoked_at, null);
  const removed = await call("/api/objects/governance-root/collaborators", "PUT", { userIds: [] });
  const removedBody = await removed.json();
  assert.equal(removed.status, 200, JSON.stringify(removedBody));
  assert.deepEqual(removedBody.userIds, []);
  assert.deepEqual(removedBody.removedUserIds, ["collaborator-1"]);
  assert.equal(harness.database.prepare("SELECT revoked_at FROM knowledge_shares WHERE id = 'share-owner-1'").get().revoked_at, null);
  assert.ok(harness.database.prepare("SELECT revoked_at FROM knowledge_shares WHERE id = 'share-collaborator-1'").get().revoked_at);
});

test("collaborator demotion revokes their public links in the same permission transaction", async (t) => {
  const harness = createAccessGovernanceHarness();
  t.after(() => harness.close());
  insertGovernanceShare(harness, "collaborator-1");
  const response = await harness.call("/api/access-grants", "POST", {
    objectId: "governance-root", subjectType: "user", subjectId: "collaborator-1", role: "viewer"
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(harness.database.prepare("SELECT role FROM knowledge_permissions WHERE id = 'governance-collaborator'").get().role, "viewer");
  assert.ok(harness.database.prepare("SELECT revoked_at FROM knowledge_shares WHERE id = 'share-collaborator-1'").get().revoked_at);
});

test("grant revocation rolls back permissions when public-link revocation fails", async (t) => {
  const harness = createAccessGovernanceHarness();
  t.after(() => harness.close());
  insertGovernanceShare(harness, "collaborator-1");
  harness.database.exec(`CREATE TRIGGER fail_share_revoke BEFORE UPDATE OF revoked_at ON knowledge_shares
    BEGIN SELECT RAISE(ABORT, 'injected_share_revoke_failure'); END`);
  const failed = await harness.call("/api/access-grants/governance-collaborator", "DELETE");
  assert.equal(failed.status, 500);
  assert.equal(harness.database.prepare("SELECT revoked_at FROM knowledge_permissions WHERE id = 'governance-collaborator'").get().revoked_at, null);
  assert.equal(harness.database.prepare("SELECT revoked_at FROM knowledge_shares WHERE id = 'share-collaborator-1'").get().revoked_at, null);
  harness.database.exec("DROP TRIGGER fail_share_revoke");
  const revoked = await harness.call("/api/access-grants/governance-collaborator", "DELETE");
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.ok(harness.database.prepare("SELECT revoked_at FROM knowledge_permissions WHERE id = 'governance-collaborator'").get().revoked_at);
  assert.equal((await harness.call("/public/slug-collaborator-1", "GET")).status, 404);
});

test("public-link rotation preserves the old link when creating its replacement fails", async (t) => {
  const harness = createAccessGovernanceHarness();
  t.after(() => harness.close());
  insertGovernanceShare(harness, "owner-1");
  harness.database.exec(`CREATE TRIGGER fail_share_insert BEFORE INSERT ON knowledge_shares
    BEGIN SELECT RAISE(ABORT, 'injected_share_insert_failure'); END`);
  const failed = await harness.call("/api/objects/file-owner-1/public-share", "POST", { expiry: "permanent" });
  assert.equal(failed.status, 500);
  assert.equal(harness.database.prepare("SELECT revoked_at FROM knowledge_shares WHERE id = 'share-owner-1'").get().revoked_at, null);
  harness.database.exec("DROP TRIGGER fail_share_insert");
  const rotated = await harness.call("/api/objects/file-owner-1/public-share", "POST", { expiry: "permanent" });
  assert.equal(rotated.status, 201, await rotated.clone().text());
  assert.ok(harness.database.prepare("SELECT revoked_at FROM knowledge_shares WHERE id = 'share-owner-1'").get().revoked_at);
  assert.equal((await harness.call("/public/slug-owner-1", "GET")).status, 404);
});

for (const boundary of ["cancelled", "expired", "owner_changed"]) {
  test(`Owner acceptance cannot cross a concurrent ${boundary} boundary`, async (t) => {
    const harness = createAccessGovernanceHarness();
    t.after(() => harness.close());
    const initiated = await harness.call("/api/objects/governance-root/owner-transfer", "POST", { toUserId: "owner-2", retainPreviousOwner: false });
    const { transfer } = await initiated.json();
    assert.equal(initiated.status, 201);
    const batch = harness.d1.batch.bind(harness.d1);
    harness.d1.batch = async statements => {
      if (boundary === "cancelled") harness.database.prepare("UPDATE knowledge_root_owner_transfers SET status = 'cancelled' WHERE id = ?").run(transfer.id);
      if (boundary === "expired") harness.database.prepare("UPDATE knowledge_root_owner_transfers SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(transfer.id);
      if (boundary === "owner_changed") harness.database.exec("UPDATE knowledge_permissions SET subject_id = 'owner-3' WHERE id = 'governance-owner'");
      return batch(statements);
    };
    const accepted = await harness.call(`/api/owner-transfers/${transfer.id}/accept`, "POST", undefined, "owner-2");
    assert.equal(accepted.status, 409, await accepted.clone().text());
    const owner = harness.database.prepare("SELECT subject_id FROM knowledge_permissions WHERE role = 'owner' AND revoked_at IS NULL").get();
    assert.equal(owner.subject_id, boundary === "owner_changed" ? "owner-3" : "owner-1");
    assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_permissions WHERE subject_id = 'owner-2' AND revoked_at IS NULL").get().count, 0);
    assert.notEqual(harness.database.prepare("SELECT status FROM knowledge_root_owner_transfers").get().status, "accepted");
  });
}

for (const action of ["cancel", "reject"]) {
  test(`Owner ${action} reports a conflict when acceptance already won`, async (t) => {
    const harness = createAccessGovernanceHarness();
    t.after(() => harness.close());
    const initiated = await harness.call("/api/objects/governance-root/owner-transfer", "POST", { toUserId: "owner-2" });
    const { transfer } = await initiated.json();
    assert.equal(initiated.status, 201);
    const prepare = harness.d1.prepare.bind(harness.d1);
    harness.d1.prepare = sql => {
      const statement = prepare(sql);
      if (/UPDATE knowledge_root_owner_transfers[\s\S]+SET status = \?/.test(sql)) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...args) => {
          const bound = bind(...args);
          const run = bound.run.bind(bound);
          bound.run = async () => {
            harness.database.prepare("UPDATE knowledge_root_owner_transfers SET status = 'accepted' WHERE id = ?").run(transfer.id);
            harness.database.exec("UPDATE knowledge_permissions SET subject_id = 'owner-2' WHERE id = 'governance-owner'");
            return run();
          };
          return bound;
        };
      }
      return statement;
    };
    const result = await harness.call(`/api/owner-transfers/${transfer.id}/${action}`, "POST", undefined, action === "cancel" ? "owner-1" : "owner-2");
    assert.equal(result.status, 409, await result.clone().text());
    assert.equal(harness.database.prepare("SELECT status FROM knowledge_root_owner_transfers").get().status, "accepted");
    assert.equal(harness.database.prepare("SELECT subject_id FROM knowledge_permissions WHERE role = 'owner' AND revoked_at IS NULL").get().subject_id, "owner-2");
  });
}

test("Owner acceptance reconciles a lost commit response and still records its audit", async (t) => {
  const harness = createAccessGovernanceHarness();
  t.after(() => harness.close());
  const initiated = await harness.call("/api/objects/governance-root/owner-transfer", "POST", { toUserId: "owner-2" });
  const { transfer } = await initiated.json();
  assert.equal(initiated.status, 201);
  harness.d1.failNextBatchAfterCommit();
  const accepted = await harness.call(`/api/owner-transfers/${transfer.id}/accept`, "POST", undefined, "owner-2");
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_audit_events WHERE action = 'knowledge.owner_transfer.accept'").get().count, 1);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_permissions WHERE role = 'owner' AND revoked_at IS NULL").get().count, 1);
});

test("public-link rotation reconciles a lost commit response without issuing another link", async (t) => {
  const harness = createAccessGovernanceHarness();
  t.after(() => harness.close());
  insertGovernanceShare(harness, "owner-1");
  harness.d1.failNextBatchAfterCommit();
  const response = await harness.call("/api/objects/file-owner-1/public-share", "POST", { expiry: "permanent" });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_shares").get().count, 2);
  assert.equal(harness.database.prepare("SELECT id FROM knowledge_shares WHERE revoked_at IS NULL").get().id, body.share.id);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_audit_events WHERE action = 'knowledge.public_share.create'").get().count, 1);
});

function createAccessGovernanceHarness() {
  const harness = createKnowledgeHarness({ rootAclV2: true, indexReadV2: true });
  insertNamespace(harness.database);
  insertObject(harness.database, { id: "governance-root", kind: "folder", path: "Governance Root" });
  for (const [id, user, role] of [["governance-owner", "owner-1", "owner"], ["governance-collaborator", "collaborator-1", "editor"]]) {
    harness.database.prepare(`INSERT INTO knowledge_permissions
      (id, namespace_id, object_id, subject_type, subject_id, role, can_share)
      VALUES (?, 'namespace-1', 'governance-root', 'user', ?, ?, 1)`).run(id, user, role);
    harness.database.prepare("INSERT INTO knowledge_permission_provenance (permission_id, grant_source, source_id) VALUES (?, 'direct', 'governance-root')").run(id);
  }
  harness.call = (route, method = "GET", body, user = "owner-1") => knowledgeWorker.fetch(new Request(`http://localhost${route}`, {
    method,
    headers: {
      "content-type": "application/json", "x-workspace-org-id": "org-1", "x-workspace-role": "member",
      "x-workspace-user-id": user, "x-workspace-user-email": `${user}@example.invalid`,
      "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), harness.env);
  return harness;
}

function insertGovernanceShare(harness, user) {
  const id = `file-${user}`, version = `version-${user}`;
  insertObject(harness.database, { id, path: `Governance Root/${user}.md`, currentVersionId: version });
  insertVersion(harness.database, { id: version, objectId: id, version: 1, sizeBytes: 0 });
  harness.database.prepare("INSERT INTO knowledge_ingestion_states (object_id, version_id, scan_status, scanner_version) VALUES (?, ?, 'clean', 'test')").run(id, version);
  harness.database.prepare(`INSERT INTO knowledge_shares
    (id, namespace_id, object_id, slug, visibility, role, created_by_user_id)
    VALUES (?, 'namespace-1', ?, ?, 'public', 'viewer', ?)`).run(`share-${user}`, id, `slug-${user}`, user);
}

test("service publication failure rolls back lifecycle, Viewer ACL and handbook-link changes", async (t) => {
  const harness = createAccessGovernanceHarness();
  t.after(() => harness.close());
  await prepareGovernanceHandbook(harness);
  harness.database.exec(`INSERT INTO knowledge_shares
    (id, namespace_id, object_id, slug, visibility, role, created_by_user_id)
    VALUES ('handbook-link', 'namespace-1', 'governance-handbook', 'old-handbook-link', 'public', 'viewer', 'owner-1')`);
  harness.d1.failNextBatchAt(2);
  const response = await harness.call("/api/knowledge-services/publish", "POST", {
    folderObjectId: "governance-root", access: { company: true }, profile: { role: "Read internal guidance" }
  });
  assert.equal(response.status, 500);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_services").get().count, 0);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_permissions WHERE subject_type = 'company'").get().count, 0);
  assert.equal(harness.database.prepare("SELECT revoked_at FROM knowledge_shares WHERE id = 'handbook-link'").get().revoked_at, null);
});

test("repeated service publication keeps one identity and disable revokes only service-derived Viewer access", async (t) => {
  const harness = createAccessGovernanceHarness();
  t.after(() => harness.close());
  await prepareGovernanceHandbook(harness);
  const direct = await harness.call("/api/access-grants", "POST", {
    objectId: "governance-root", subjectType: "user", subjectId: "direct-viewer", role: "viewer"
  });
  assert.equal(direct.status, 201);
  const requestBody = { folderObjectId: "governance-root", access: { users: ["service-viewer"] } };
  const first = await harness.call("/api/knowledge-services/publish", "POST", requestBody);
  const firstBody = await first.json();
  assert.equal(first.status, 201, JSON.stringify(firstBody));
  const second = await harness.call("/api/knowledge-services/publish", "POST", requestBody);
  const secondBody = await second.json();
  assert.equal(second.status, 201, JSON.stringify(secondBody));
  assert.equal(secondBody.service.id, firstBody.service.id);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_services").get().count, 1);
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_service_versions WHERE status = 'active'").get().count, 1);
  const route = `/api/knowledge-services/${firstBody.service.id}`;
  assert.equal((await harness.call(route, "GET", undefined, "service-viewer")).status, 200);
  assert.equal((await harness.call(route, "PATCH", { agentEnabled: false })).status, 200);
  assert.equal((await harness.call(route, "GET", undefined, "service-viewer")).status, 404);
  assert.equal((await harness.call("/api/files/governance-root", "GET", undefined, "service-viewer")).status, 403);
  assert.equal((await harness.call("/api/files/governance-root", "GET", undefined, "direct-viewer")).status, 200);
  assert.equal(harness.database.prepare("SELECT role FROM knowledge_permissions WHERE id = 'governance-collaborator' AND revoked_at IS NULL").get().role, "editor");
  assert.equal(harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_index_documents").get().count, 0);
});

test("indexing failures expose a stable service error instead of raw storage details", async (t) => {
  const harness = createAccessGovernanceHarness();
  t.after(() => harness.close());
  await prepareGovernanceHandbook(harness);
  const batch = harness.d1.batch.bind(harness.d1);
  harness.d1.batch = async statements => {
    if (statements.some(statement => /DELETE FROM knowledge_index_documents/.test(statement.sql))) {
      throw new Error("sensitive-storage-error-test-fixture");
    }
    return batch(statements);
  };
  const failed = await harness.call("/api/knowledge-services/publish", "POST", { folderObjectId: "governance-root" });
  assert.equal(failed.status, 500);
  const services = await harness.call("/api/knowledge-services");
  const text = await services.text();
  assert.equal(services.status, 200);
  assert.ok(!text.includes("sensitive-storage-error-test-fixture"));
  assert.equal(JSON.parse(text).services[0].lastError, "knowledge_service_index_failed");
});

test("audit storage failure logs only error class and identifiers after a committed permission change", async (t) => {
  const harness = createAccessGovernanceHarness();
  t.after(() => harness.close());
  harness.database.exec(`CREATE TRIGGER fail_audit_insert BEFORE INSERT ON knowledge_audit_events
    BEGIN SELECT RAISE(ABORT, 'sensitive-audit-error-test-fixture'); END`);
  const logs = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args); };
  t.after(() => { console.error = original; });
  const response = await harness.call("/api/access-grants", "POST", {
    objectId: "governance-root", subjectType: "user", subjectId: "audit-viewer", role: "viewer"
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.ok(logs.some(args => args[0] === "knowledge_audit_write_failed"));
  assert.ok(!logs.flat().map(String).join(" ").includes("sensitive-audit-error-test-fixture"));
});

async function prepareGovernanceHandbook(harness) {
  const bytes = new TextEncoder().encode("# Handbook\nRead the internal documents safely.\n");
  insertObject(harness.database, { id: "governance-handbook", path: "Governance Root/handbook.md", currentVersionId: "handbook-v1", sizeBytes: bytes.length });
  insertVersion(harness.database, { id: "handbook-v1", objectId: "governance-handbook", version: 1, sizeBytes: bytes.length });
  harness.database.exec("INSERT INTO knowledge_ingestion_states (object_id, version_id, scan_status, scanner_version) VALUES ('governance-handbook', 'handbook-v1', 'clean', 'test')");
  await harness.r2.put("base/handbook-v1", bytes);
}

test("Root Owner transfer is atomic, recipient-visible, and cancelled with a deleted Root", async (t) => {
  const harness = createKnowledgeHarness({ mutationSpineV2: true, rootAclV2: true });
  t.after(() => harness.close());
  const ownerHeaders = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
    "x-workspace-user-id": "owner-1",
    "x-workspace-user-name": "Owner One"
  };
  const nextOwnerHeaders = {
    ...ownerHeaders,
    "x-workspace-user-id": "owner-2",
    "x-workspace-user-name": "Owner Two"
  };
  const createdResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "Transfer Root" })
    }),
    harness.env
  );
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  assert.equal(created.item.effectiveRole, "owner");
  assert.equal(created.item.ownerUserId, "owner-1");

  const initiateResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${created.item.id}/owner-transfer`, {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ toUserId: "owner-2" })
    }),
    harness.env
  );
  const initiated = await initiateResponse.json();
  assert.equal(initiateResponse.status, 201, JSON.stringify(initiated));
  assert.equal(initiated.transfer.status, "pending");

  const incomingListResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/owner-transfers?rootObjectId=${encodeURIComponent(created.item.id)}`,
      { headers: nextOwnerHeaders }
    ),
    harness.env
  );
  const incomingList = await incomingListResponse.json();
  assert.equal(incomingListResponse.status, 200, JSON.stringify(incomingList));
  assert.deepEqual(
    incomingList.transfers.map((transfer) => ({
      id: transfer.id,
      status: transfer.status,
      toUserId: transfer.toUserId
    })),
    [{ id: initiated.transfer.id, status: "pending", toUserId: "owner-2" }]
  );

  const unrelatedListResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/owner-transfers?rootObjectId=${encodeURIComponent(created.item.id)}`,
      {
        headers: {
          ...nextOwnerHeaders,
          "x-workspace-user-id": "owner-unrelated",
          "x-workspace-user-name": "Unrelated User"
        }
      }
    ),
    harness.env
  );
  assert.equal(unrelatedListResponse.status, 403);

  const acceptResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/owner-transfers/${initiated.transfer.id}/accept`, {
      method: "POST",
      headers: nextOwnerHeaders
    }),
    harness.env
  );
  const accepted = await acceptResponse.json();
  assert.equal(acceptResponse.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.transfer.status, "accepted");
  assert.equal(accepted.root.effectiveRole, "owner");
  assert.equal(accepted.root.ownerUserId, "owner-2");

  assert.deepEqual(
    harness.database.prepare(
      `SELECT subject_id, role
       FROM knowledge_permissions
       WHERE object_id = ? AND revoked_at IS NULL
       ORDER BY subject_id`
    ).all(created.item.id).map((row) => ({ ...row })),
    [
      { subject_id: "owner-1", role: "editor" },
      { subject_id: "owner-2", role: "owner" }
    ]
  );
  const previousOwnerManageResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${created.item.id}/collaborators`, {
      method: "PUT",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ userIds: ["collaborator-1"] })
    }),
    harness.env
  );
  assert.equal(previousOwnerManageResponse.status, 403);

  const pendingBeforeDeleteResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${created.item.id}/owner-transfer`, {
      method: "POST",
      headers: { ...nextOwnerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ toUserId: "owner-3" })
    }),
    harness.env
  );
  const pendingBeforeDelete = await pendingBeforeDeleteResponse.json();
  assert.equal(pendingBeforeDeleteResponse.status, 201, JSON.stringify(pendingBeforeDelete));
  assert.equal(pendingBeforeDelete.transfer.status, "pending");

  const deleteResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${created.item.id}`, {
      method: "DELETE",
      headers: {
        ...nextOwnerHeaders,
        "idempotency-key": "delete-root-with-pending-transfer"
      }
    }),
    harness.env
  );
  const deleted = await deleteResponse.json();
  assert.equal(deleteResponse.status, 200, JSON.stringify(deleted));
  assert.equal(
    harness.database
      .prepare("SELECT status FROM knowledge_root_owner_transfers WHERE id = ?")
      .get(pendingBeforeDelete.transfer.id).status,
    "cancelled"
  );
});

test("active Service lets Collaborators rename and delete ordinary files but protects control objects", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true, mutationSpineV2: true });
  t.after(() => harness.close());
  const ownerHeaders = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
    "x-workspace-user-id": "owner-1",
    "x-workspace-user-name": "Owner One"
  };
  const collaboratorHeaders = {
    ...ownerHeaders,
    "x-workspace-user-id": "collaborator-1",
    "x-workspace-user-name": "Collaborator One"
  };
  const rootResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "Collaborator Active Service Root" })
    }),
    harness.env
  );
  const root = await rootResponse.json();
  assert.equal(rootResponse.status, 201, JSON.stringify(root));

  const handbookForm = new FormData();
  handbookForm.set("parentObjectId", root.item.id);
  handbookForm.set("file", new File(["# Handbook"], "handbook.md", { type: "text/markdown" }));
  const handbookResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/files/upload", {
      method: "POST",
      headers: { ...ownerHeaders, "idempotency-key": "collaborator-active-handbook" },
      body: handbookForm
    }),
    harness.env
  );
  const handbook = await handbookResponse.json();
  assert.equal(handbookResponse.status, 201, JSON.stringify(handbook));

  const noteForm = new FormData();
  noteForm.set("parentObjectId", root.item.id);
  noteForm.set("file", new File(["ordinary content"], "note.md", { type: "text/markdown" }));
  const noteResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/files/upload", {
      method: "POST",
      headers: { ...ownerHeaders, "idempotency-key": "collaborator-active-note" },
      body: noteForm
    }),
    harness.env
  );
  const note = await noteResponse.json();
  assert.equal(noteResponse.status, 201, JSON.stringify(note));

  const serviceResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/knowledge-services", {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        access: { company: false, departments: [], users: ["collaborator-1"] },
        folderObjectId: root.item.id,
        name: "Collaborator Active Service"
      })
    }),
    harness.env
  );
  const service = await serviceResponse.json();
  assert.equal(serviceResponse.status, 201, JSON.stringify(service));

  const viewerListResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/knowledge-services", { headers: collaboratorHeaders }),
    harness.env
  );
  const viewerList = await viewerListResponse.json();
  assert.equal(viewerListResponse.status, 200, JSON.stringify(viewerList));
  assert.equal(viewerList.services.find((item) => item.id === service.service.id)?.effectiveRole, "viewer");

  const viewerSharedResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/shared-with-me", { headers: collaboratorHeaders }),
    harness.env
  );
  const viewerShared = await viewerSharedResponse.json();
  assert.equal(viewerSharedResponse.status, 200, JSON.stringify(viewerShared));
  assert.deepEqual(
    viewerShared.items.map((item) => ({ id: item.id, role: item.effectiveRole })),
    [{ id: root.item.id, role: "viewer" }]
  );

  const collaboratorResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${root.item.id}/collaborators`, {
      method: "PUT",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ userIds: ["collaborator-1"] })
    }),
    harness.env
  );
  const collaboratorBody = await collaboratorResponse.json();
  assert.equal(collaboratorResponse.status, 200, JSON.stringify(collaboratorBody));
  assert.equal(collaboratorBody.folder.collaboratorCount, 1);

  const collaboratorListResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/knowledge-services", { headers: ownerHeaders }),
    harness.env
  );
  const collaboratorList = await collaboratorListResponse.json();
  assert.equal(collaboratorListResponse.status, 200, JSON.stringify(collaboratorList));
  assert.deepEqual(
    collaboratorList.services.find((item) => item.id === service.service.id)?.collaboratorUserIds,
    ["collaborator-1"]
  );

  const collaboratorInfoUpdateResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/knowledge-services/${service.service.id}/info`, {
      method: "PATCH",
      headers: { ...collaboratorHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        info: {
          bestFor: ["开户门槛", "AUM 要求"],
          description: "合作银行准入与开户资料",
          keywords: ["UBS", "AUM"],
          notFor: ["Workspace 产品操作"],
          role: "回答合作银行、开户门槛和客户准入问题",
          searchHints: ["银行名称", "客户地区"]
        }
      })
    }),
    harness.env
  );
  const collaboratorInfoUpdate = await collaboratorInfoUpdateResponse.json();
  assert.equal(collaboratorInfoUpdateResponse.status, 200, JSON.stringify(collaboratorInfoUpdate));
  assert.deepEqual(collaboratorInfoUpdate.service.card, {
    bestFor: ["开户门槛", "AUM 要求"],
    description: "合作银行准入与开户资料",
    keywords: ["UBS", "AUM"],
    notFor: ["Workspace 产品操作"],
    role: "回答合作银行、开户门槛和客户准入问题",
    searchHints: ["银行名称", "客户地区"]
  });

  const collaboratorUpdatedListResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/knowledge-services", { headers: collaboratorHeaders }),
    harness.env
  );
  const collaboratorUpdatedList = await collaboratorUpdatedListResponse.json();
  assert.equal(collaboratorUpdatedListResponse.status, 200, JSON.stringify(collaboratorUpdatedList));
  assert.deepEqual(
    collaboratorUpdatedList.services.find((item) => item.id === service.service.id)?.card,
    collaboratorInfoUpdate.service.card
  );

  for (const forbiddenInfo of [
    { access: { company: true } },
    { agentEnabled: false },
    { handbookContent: "# replacement" },
    { name: "Escalated service" }
  ]) {
    const escalationResponse = await knowledgeWorker.fetch(
      new Request(`http://localhost/api/knowledge-services/${service.service.id}/info`, {
        method: "PATCH",
        headers: { ...collaboratorHeaders, "content-type": "application/json" },
        body: JSON.stringify({ info: forbiddenInfo })
      }),
      harness.env
    );
    assert.equal(escalationResponse.status, 400);
    assert.equal((await escalationResponse.json()).error, "knowledge_service_info_field_not_allowed");
  }

  const collaboratorLifecycleUpdateResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/knowledge-services/${service.service.id}`, {
      method: "PATCH",
      headers: { ...collaboratorHeaders, "content-type": "application/json" },
      body: JSON.stringify({ agentEnabled: false })
    }),
    harness.env
  );
  assert.equal(collaboratorLifecycleUpdateResponse.status, 403);

  const protectedRootDeleteResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${root.item.id}`, {
      method: "DELETE",
      headers: {
        ...collaboratorHeaders,
        "idempotency-key": "collaborator-active-root-delete"
      }
    }),
    harness.env
  );
  assert.equal(protectedRootDeleteResponse.status, 403);

  const renameResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${note.item.id}/rename`, {
      method: "POST",
      headers: {
        ...collaboratorHeaders,
        "content-type": "application/json",
        "idempotency-key": "collaborator-active-rename"
      },
      body: JSON.stringify({
        expectedCurrentVersionId: note.version.id,
        name: "renamed-note.md"
      })
    }),
    harness.env
  );
  const renamed = await renameResponse.json();
  assert.equal(renameResponse.status, 200, JSON.stringify(renamed));
  assert.equal(renamed.item.name, "renamed-note.md");

  const protectedRenameResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${handbook.item.id}/rename`, {
      method: "POST",
      headers: {
        ...collaboratorHeaders,
        "content-type": "application/json",
        "idempotency-key": "collaborator-active-protected-rename"
      },
      body: JSON.stringify({
        expectedCurrentVersionId: handbook.version.id,
        name: "renamed-handbook.md"
      })
    }),
    harness.env
  );
  assert.equal(protectedRenameResponse.status, 403);
  assert.equal((await protectedRenameResponse.json()).error, "knowledge_service_control_object_manage_denied");

  const deleteResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/objects/${note.item.id}?expectedCurrentVersionId=${encodeURIComponent(note.version.id)}`,
      {
        method: "DELETE",
        headers: {
          ...collaboratorHeaders,
          "idempotency-key": "collaborator-active-delete"
        }
      }
    ),
    harness.env
  );
  assert.equal(deleteResponse.status, 200, JSON.stringify(await deleteResponse.json()));

  const revokeCollaboratorResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${root.item.id}/collaborators`, {
      method: "PUT",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ userIds: [] })
    }),
    harness.env
  );
  assert.equal(
    revokeCollaboratorResponse.status,
    200,
    JSON.stringify(await revokeCollaboratorResponse.json())
  );
  const postRevokeListResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/knowledge-services", { headers: collaboratorHeaders }),
    harness.env
  );
  const postRevokeList = await postRevokeListResponse.json();
  assert.equal(postRevokeListResponse.status, 200, JSON.stringify(postRevokeList));
  assert.equal(
    postRevokeList.services.find((item) => item.id === service.service.id)?.effectiveRole,
    "viewer"
  );

  const rePromoteResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${root.item.id}/collaborators`, {
      method: "PUT",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ userIds: ["collaborator-1"] })
    }),
    harness.env
  );
  assert.equal(rePromoteResponse.status, 200, JSON.stringify(await rePromoteResponse.json()));
  const disableResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/knowledge-services/${service.service.id}`, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ agentEnabled: false })
    }),
    harness.env
  );
  assert.equal(disableResponse.status, 200, JSON.stringify(await disableResponse.json()));
  const collaboratorRootResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/tree?folderObjectId=${encodeURIComponent(root.item.id)}`,
      { headers: collaboratorHeaders }
    ),
    harness.env
  );
  const collaboratorRoot = await collaboratorRootResponse.json();
  assert.equal(collaboratorRootResponse.status, 200, JSON.stringify(collaboratorRoot));
  assert.ok(collaboratorRoot.items.length > 0);
  assert.ok(collaboratorRoot.items.every((item) => item.effectiveRole === "collaborator"));
});

test("Root Owner must disable an active Knowledge Service before deleting its root", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true, mutationSpineV2: true });
  t.after(() => harness.close());
  const ownerHeaders = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
    "x-workspace-user-id": "owner-1",
    "x-workspace-user-name": "Owner One"
  };
  const rootResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "Deletable Active Service" })
    }),
    harness.env
  );
  const root = await rootResponse.json();
  assert.equal(rootResponse.status, 201, JSON.stringify(root));

  const handbookForm = new FormData();
  handbookForm.set("parentObjectId", root.item.id);
  handbookForm.set("file", new File(["# Handbook"], "handbook.md", { type: "text/markdown" }));
  const handbookResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/files/upload", {
      method: "POST",
      headers: { ...ownerHeaders, "idempotency-key": "deletable-active-handbook" },
      body: handbookForm
    }),
    harness.env
  );
  assert.equal(handbookResponse.status, 201, JSON.stringify(await handbookResponse.json()));

  const serviceResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/knowledge-services", {
      method: "POST",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        access: { company: false, departments: [], users: [] },
        folderObjectId: root.item.id,
        name: "Deletable Active Service"
      })
    }),
    harness.env
  );
  const service = await serviceResponse.json();
  assert.equal(serviceResponse.status, 201, JSON.stringify(service));

  const blockedDeleteResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${root.item.id}`, {
      method: "DELETE",
      headers: { ...ownerHeaders, "idempotency-key": "block-delete-active-service-root" }
    }),
    harness.env
  );
  const blockedDelete = await blockedDeleteResponse.json();
  assert.equal(blockedDeleteResponse.status, 409, JSON.stringify(blockedDelete));
  assert.equal(blockedDelete.error, "knowledge_service_disable_before_structure_change");
  assert.deepEqual(
    {
      ...harness.database
        .prepare("SELECT status, agent_enabled, index_status FROM knowledge_services WHERE id = ?")
        .get(service.service.id)
    },
    { status: "active", agent_enabled: 1, index_status: "ready" }
  );
  assert.equal(
    harness.database
      .prepare("SELECT COUNT(*) AS count FROM knowledge_objects WHERE deleted_at IS NULL AND (id = ? OR parent_path = ?)")
      .get(root.item.id, root.item.path).count,
    2
  );

  const disableResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/knowledge-services/${service.service.id}`, {
      method: "PATCH",
      headers: { ...ownerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ agentEnabled: false })
    }),
    harness.env
  );
  assert.equal(disableResponse.status, 200, JSON.stringify(await disableResponse.json()));

  const deleteResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${root.item.id}`, {
      method: "DELETE",
      headers: { ...ownerHeaders, "idempotency-key": "delete-disabled-service-root" }
    }),
    harness.env
  );
  const deleted = await deleteResponse.json();
  assert.equal(deleteResponse.status, 200, JSON.stringify(deleted));
  assert.equal(deleted.deletedObjectId, root.item.id);
  assert.deepEqual(
    {
      ...harness.database
        .prepare("SELECT status, agent_enabled, index_status FROM knowledge_services WHERE id = ?")
        .get(service.service.id)
    },
    { status: "archived", agent_enabled: 0, index_status: "disabled" }
  );
  assert.equal(
    harness.database
      .prepare("SELECT COUNT(*) AS count FROM knowledge_objects WHERE deleted_at IS NULL AND (id = ? OR parent_path = ?)")
      .get(root.item.id, root.item.path).count,
    0
  );
});

test("E2 records PB Partner Upload/Update/Rename/Delete as Change Sets with Diff", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true, mutationSpineV2: true });
  t.after(() => harness.close());
  const headers = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
    "x-workspace-user-email": "ai_adoption@example.invalid",
    "x-workspace-user-id": "ai_adoption",
    "x-workspace-user-name": "AI Adoption"
  };
  const rootResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "PB Partner Service" })
    }),
    harness.env
  );
  const root = await rootResponse.json();
  assert.equal(rootResponse.status, 201, JSON.stringify(root));

  const nestedFolderResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "pb-records-folder" },
      body: JSON.stringify({ name: "Records", parentObjectId: root.item.id })
    }),
    harness.env
  );
  const nestedFolder = await nestedFolderResponse.json();
  assert.equal(nestedFolderResponse.status, 201, JSON.stringify(nestedFolder));

  const uploadForm = new FormData();
  uploadForm.set("parentObjectId", nestedFolder.item.id);
  uploadForm.set("file", new File(["Partner Alpha"], "partner.md", { type: "text/markdown" }));
  const uploadResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/files/upload", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "pb-create-1" },
      body: uploadForm
    }),
    harness.env
  );
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201, JSON.stringify(upload));

  const updateForm = new FormData();
  updateForm.set("file", new File(["Partner Alpha\nPartner Beta"], "partner.md", { type: "text/markdown" }));
  updateForm.set("expectedCurrentVersionId", upload.version.id);
  const updateResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/files/${upload.item.id}/versions`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "pb-update-1" },
      body: updateForm
    }),
    harness.env
  );
  const update = await updateResponse.json();
  assert.equal(updateResponse.status, 201, JSON.stringify(update));

  const staleUpdateForm = new FormData();
  staleUpdateForm.set("file", new File(["stale"], "partner.md", { type: "text/markdown" }));
  staleUpdateForm.set("expectedCurrentVersionId", upload.version.id);
  const staleUpdateResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/files/${upload.item.id}/versions`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "pb-update-stale" },
      body: staleUpdateForm
    }),
    harness.env
  );
  assert.equal(staleUpdateResponse.status, 409);

  const editResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/files/${upload.item.id}/edit`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "pb-edit-1" },
      body: JSON.stringify({
        expectedCurrentVersionId: update.version.id,
        expectedOccurrences: 1,
        newText: "Partner Gamma",
        oldText: "Partner Beta",
        operation: "replace_text"
      })
    }),
    harness.env
  );
  const edited = await editResponse.json();
  assert.equal(editResponse.status, 200, JSON.stringify(edited));
  assert.equal(edited.diffStatus, "ready");

  const renameResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${upload.item.id}/rename`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "pb-rename-1" },
      body: JSON.stringify({
        expectedCurrentVersionId: edited.versionAfterId,
        name: "partner-profile.md"
      })
    }),
    harness.env
  );
  const renamed = await renameResponse.json();
  assert.equal(renameResponse.status, 200, JSON.stringify(renamed));

  const deleteResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/objects/${upload.item.id}?expectedCurrentVersionId=${encodeURIComponent(update.version.id)}`,
      {
        method: "DELETE",
        headers: { ...headers, "idempotency-key": "pb-delete-1" }
      }
    ),
    harness.env
  );
  const deleted = await deleteResponse.json();
  assert.equal(deleteResponse.status, 409, JSON.stringify(deleted));
  const currentDeleteResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/objects/${upload.item.id}?expectedCurrentVersionId=${encodeURIComponent(edited.versionAfterId)}`,
      {
        method: "DELETE",
        headers: { ...headers, "idempotency-key": "pb-delete-2" }
      }
    ),
    harness.env
  );
  const currentDeleted = await currentDeleteResponse.json();
  assert.equal(currentDeleteResponse.status, 200, JSON.stringify(currentDeleted));

  const renameFolderResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${nestedFolder.item.id}/rename`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "pb-records-folder-rename" },
      body: JSON.stringify({ name: "Archived Records" })
    }),
    harness.env
  );
  const renamedFolder = await renameFolderResponse.json();
  assert.equal(renameFolderResponse.status, 200, JSON.stringify(renamedFolder));

  const auditListResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/audit/changes?objectId=${encodeURIComponent(root.item.id)}`, {
      headers
    }),
    harness.env
  );
  const auditList = await auditListResponse.json();
  assert.equal(auditListResponse.status, 200, JSON.stringify(auditList));
  assert.deepEqual(auditList.scope, {
    includesDescendants: true,
    kind: "folder",
    objectId: root.item.id,
    path: root.item.path
  });
  assert.equal(auditList.changes.length, 8);
  assert.ok(auditList.changes.some((change) => change.id === edited.changeSetId));
  assert.equal(
    auditList.changes.find((change) => change.id === edited.changeSetId)?.actor?.email,
    "ai_adoption@example.invalid"
  );

  const emailAuditResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/audit/changes?objectId=${encodeURIComponent(root.item.id)}&q=${encodeURIComponent("ai_adoption@example.invalid")}&limit=10`,
      { headers }
    ),
    harness.env
  );
  const emailAudit = await emailAuditResponse.json();
  assert.equal(emailAuditResponse.status, 200, JSON.stringify(emailAudit));
  assert.ok(emailAudit.changes.some((change) => change.id === edited.changeSetId));

  const nestedAuditResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/audit/changes?objectId=${encodeURIComponent(nestedFolder.item.id)}&limit=10`,
      { headers }
    ),
    harness.env
  );
  const nestedAudit = await nestedAuditResponse.json();
  assert.equal(nestedAuditResponse.status, 200, JSON.stringify(nestedAudit));
  assert.equal(nestedAudit.scope.kind, "folder");
  assert.equal(nestedAudit.scope.includesDescendants, true);
  assert.equal(nestedAudit.scope.path, renamedFolder.item.path);
  assert.equal(nestedAudit.changes.length, 7);
  assert.ok(nestedAudit.changes.some((change) => change.id === edited.changeSetId));
  assert.ok(nestedAudit.changes.some((change) => change.operation === "create"));

  const editAuditResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/audit/changes?objectId=${encodeURIComponent(root.item.id)}&category=edit&q=${encodeURIComponent("partner.md")}&limit=10`,
      { headers }
    ),
    harness.env
  );
  const editAudit = await editAuditResponse.json();
  assert.equal(editAuditResponse.status, 200, JSON.stringify(editAudit));
  assert.deepEqual(new Set(editAudit.changes.map((change) => change.operation)), new Set(["edit", "update"]));

  const fileAuditResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/audit/changes?objectId=${encodeURIComponent(upload.item.id)}&category=structure&q=${encodeURIComponent("partner-profile.md")}&limit=10`,
      { headers }
    ),
    harness.env
  );
  const fileAudit = await fileAuditResponse.json();
  assert.equal(fileAuditResponse.status, 200, JSON.stringify(fileAudit));
  assert.deepEqual(fileAudit.scope, {
    includesDescendants: false,
    kind: "file",
    objectId: upload.item.id,
    path: renamed.item.path
  });
  assert.deepEqual(fileAudit.changes.map((change) => change.operation), ["rename"]);

  const firstAuditPageResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/audit/changes?objectId=${encodeURIComponent(root.item.id)}&limit=2`,
      { headers }
    ),
    harness.env
  );
  const firstAuditPage = await firstAuditPageResponse.json();
  assert.equal(firstAuditPageResponse.status, 200, JSON.stringify(firstAuditPage));
  assert.equal(firstAuditPage.changes.length, 2);
  assert.ok(firstAuditPage.nextCursor);
  const secondAuditPageResponse = await knowledgeWorker.fetch(
    new Request(
      `http://localhost/api/audit/changes?objectId=${encodeURIComponent(root.item.id)}&limit=2&cursor=${encodeURIComponent(firstAuditPage.nextCursor)}`,
      { headers }
    ),
    harness.env
  );
  const secondAuditPage = await secondAuditPageResponse.json();
  assert.equal(secondAuditPageResponse.status, 200, JSON.stringify(secondAuditPage));
  assert.equal(secondAuditPage.changes.length, 2);
  assert.equal(
    secondAuditPage.changes.some((change) => firstAuditPage.changes.some((first) => first.id === change.id)),
    false
  );
  const auditGetResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/audit/changes/${edited.changeSetId}`, { headers }),
    harness.env
  );
  const auditGet = await auditGetResponse.json();
  assert.equal(auditGetResponse.status, 200, JSON.stringify(auditGet));
  assert.equal(auditGet.change.actor.email, "ai_adoption@example.invalid");
  assert.equal(auditGet.items[0].editOperation, "replace_text");
  const diffReadResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/audit/change-items/${edited.changeItemId}/diff`, { headers }),
    harness.env
  );
  const diffRead = await diffReadResponse.json();
  assert.equal(diffReadResponse.status, 200, JSON.stringify(diffRead));
  assert.match(diffRead.diff, /-Partner Beta/);
  assert.match(diffRead.diff, /\+Partner Gamma/);

  assert.deepEqual(
    harness.database.prepare(
      `SELECT action, diff_status
       FROM knowledge_change_items
       ORDER BY created_at, rowid`
    ).all().map((row) => ({ ...row })),
    [
      { action: "folder_create", diff_status: "not_applicable" },
      { action: "folder_create", diff_status: "not_applicable" },
      { action: "create", diff_status: "not_applicable" },
      { action: "update", diff_status: "ready" },
      { action: "edit", diff_status: "ready" },
      { action: "rename", diff_status: "not_applicable" },
      { action: "delete", diff_status: "not_applicable" },
      { action: "folder_rename", diff_status: "not_applicable" }
    ]
  );
  assert.equal(
    harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_diff_outbox WHERE status = 'pending'").get().count,
    0
  );
  assert.equal(
    harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_diff_outbox WHERE status = 'completed'").get().count,
    2
  );
  assert.equal(
    harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_change_sets WHERE item_count = 1").get().count,
    8
  );
  assert.equal(
    harness.database.prepare("SELECT COUNT(*) AS count FROM knowledge_mutation_commands WHERE status = 'committed'").get().count,
    8
  );
});

test("E4 batch edit commits one all-or-nothing Change Set under one Root", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true, mutationSpineV2: true });
  t.after(() => harness.close());
  const headers = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
    "x-workspace-user-id": "ai_adoption",
    "x-workspace-user-name": "AI Adoption"
  };
  const rootResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "batch-root" },
      body: JSON.stringify({ name: "Batch Root" })
    }),
    harness.env
  );
  const root = await rootResponse.json();
  const files = [];
  for (const [index, text] of ["Alpha", "Beta"].entries()) {
    const form = new FormData();
    form.set("parentObjectId", root.item.id);
    form.set("file", new File([text], `file-${index + 1}.md`, { type: "text/markdown" }));
    const response = await knowledgeWorker.fetch(
      new Request("http://localhost/api/files/upload", {
        method: "POST",
        headers: { ...headers, "idempotency-key": `batch-file-${index + 1}` },
        body: form
      }),
      harness.env
    );
    const file = await response.json();
    assert.equal(response.status, 201, JSON.stringify(file));
    files.push(file);
  }
  const batchResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/edit/batch", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": "batch-edit-1",
        "x-workspace-source-channel": "mcp"
      },
      body: JSON.stringify({
        allOrNothing: true,
        idempotencyKey: "batch-edit-1",
        items: files.map((file, index) => ({
          expectedCurrentVersionId: file.version.id,
          objectId: file.item.id,
          operation: "append_text",
          text: `\nUpdated ${index + 1}`
        }))
      })
    }),
    harness.env
  );
  const batch = await batchResponse.json();
  assert.equal(batchResponse.status, 200, JSON.stringify(batch));
  assert.equal(batch.itemCount, 2);
  assert.equal(
    harness.database.prepare("SELECT item_count FROM knowledge_change_sets WHERE id = ?").get(batch.changeSetId).item_count,
    2
  );
  assert.deepEqual(
    harness.database.prepare(
      "SELECT diff_status FROM knowledge_change_items WHERE change_set_id = ? ORDER BY object_id"
    ).all(batch.changeSetId).map((row) => row.diff_status),
    ["ready", "ready"]
  );
  assert.equal(
    harness.database.prepare(
      "SELECT source_channel FROM knowledge_change_sets WHERE id = ?"
    ).get(batch.changeSetId).source_channel,
    "mcp"
  );
});

test("E5 policy quarantines binary sharing and separates static from interactive HTML", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true });
  t.after(() => harness.close());
  const headers = {
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write,workspace:knowledge:share",
    "x-workspace-user-id": "owner-1",
    "x-workspace-user-name": "Owner"
  };
  const rootResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Policy Root" })
    }),
    harness.env
  );
  const root = await rootResponse.json();
  const upload = async (name, type, content) => {
    const form = new FormData();
    form.set("parentObjectId", root.item.id);
    form.set("file", new File([content], name, { type }));
    const response = await knowledgeWorker.fetch(
      new Request("http://localhost/api/files/upload", { method: "POST", headers, body: form }),
      harness.env
    );
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body.item;
  };
  const binary = await upload("archive.bin", "application/octet-stream", new Uint8Array([1, 2, 3]));
  const binaryShare = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/objects/${binary.id}/public-share`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ expiry: "24h" })
    }),
    harness.env
  );
  assert.equal(binaryShare.status, 409);
  assert.equal(
    harness.database.prepare(
      "SELECT scan_status FROM knowledge_ingestion_states WHERE object_id = ?"
    ).get(binary.id).scan_status,
    "pending"
  );

  const staticHtml = await upload(
    "static.html",
    "text/html",
    "<html><body><script>document.body.dataset.ran='1'</script><h1>Static</h1></body></html>"
  );
  const staticView = await knowledgeWorker.fetch(
    new Request(`http://localhost/view/${staticHtml.id}`, { headers }),
    harness.env
  );
  const staticPage = await staticView.text();
  assert.doesNotMatch(staticPage, /dataset\.ran/);
  assert.match(staticPage, /sandbox=""/);

  const interactiveHtml = await upload(
    "deck.html",
    "text/html",
    "<html><head><meta name=\"workspace:format\" content=\"deck\"></head><body><script>document.body.dataset.ran='1'</script></body></html>"
  );
  const interactiveView = await knowledgeWorker.fetch(
    new Request(`http://localhost/view/${interactiveHtml.id}`, { headers }),
    harness.env
  );
  const interactivePage = await interactiveView.text();
  assert.match(interactivePage, /dataset\.ran/);
  assert.match(interactivePage, /allow-scripts allow-popups/);

  const csv = await upload(
    "catalog.csv",
    "text/csv",
    'name,note\r\nAlpha,"one,two"\r\nBeta,"<script>alert(1)</script>"'
  );
  assert.equal(csv.contentKind, "csv");
  const csvView = await knowledgeWorker.fetch(
    new Request(`http://localhost/view/${csv.id}`, { headers }),
    harness.env
  );
  const csvPage = await csvView.text();
  assert.match(csvPage, /class="csvTable"/);
  assert.match(csvPage, /<th scope="col">name<\/th>/);
  assert.match(csvPage, /<td>one,two<\/td>/);
  assert.match(csvPage, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(csvPage, /<script>alert\(1\)<\/script>/);

  const pdf = await upload("report.pdf", "application/pdf", "%PDF-1.4\n");
  assert.equal(pdf.contentKind, "pdf");
  const pdfView = await knowledgeWorker.fetch(
    new Request(`http://localhost/view/${pdf.id}`, { headers }),
    harness.env
  );
  const pdfPage = await pdfView.text();
  assert.match(pdfPage, /class="pdfFrame"/);
  assert.match(pdfPage, /data:application\/pdf;base64,/);

  const policyResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/policy/effective", { headers }),
    harness.env
  );
  const policy = await policyResponse.json();
  assert.equal(policy.policy.html.ordinaryMode, "static");
  assert.equal(policy.policy.limits.fileBytes, 25_000_000);
});

test("E7 Knowledge feedback is idempotent, auditable, and triageable at Root scope", async (t) => {
  const harness = createKnowledgeHarness({ rootAclV2: true });
  t.after(() => harness.close());
  const headers = {
    "content-type": "application/json",
    "x-workspace-org-id": "org-1",
    "x-workspace-role": "member",
    "x-workspace-scopes": "workspace:knowledge:read,workspace:knowledge:write",
    "x-workspace-user-id": "ai_adoption",
    "x-workspace-user-name": "AI Adoption"
  };
  const rootResponse = await knowledgeWorker.fetch(
    new Request("http://localhost/api/folders", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "PB Feedback Root" })
    }),
    harness.env
  );
  const root = await rootResponse.json();
  assert.equal(rootResponse.status, 201, JSON.stringify(root));

  const submit = () => knowledgeWorker.fetch(
    new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: {
        ...headers,
        "idempotency-key": "pb-feedback-correction-1",
        "x-workspace-source-channel": "mcp"
      },
      body: JSON.stringify({
        context: { query: "supplier status" },
        kind: "correction",
        message: "The supplier status should be reviewed.",
        rootObjectId: root.item.id
      })
    }),
    harness.env
  );
  const firstResponse = await submit();
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 201, JSON.stringify(first));
  assert.equal(first.feedback.replayed, false);
  assert.equal(first.feedback.sourceChannel, "mcp");
  const replayResponse = await submit();
  const replay = await replayResponse.json();
  assert.equal(replayResponse.status, 200, JSON.stringify(replay));
  assert.equal(replay.feedback.id, first.feedback.id);
  assert.equal(replay.feedback.replayed, true);

  const listResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/feedback?rootObjectId=${encodeURIComponent(root.item.id)}`, {
      headers
    }),
    harness.env
  );
  const listed = await listResponse.json();
  assert.equal(listResponse.status, 200, JSON.stringify(listed));
  assert.equal(listed.feedback.length, 1);

  const updateResponse = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/feedback/${encodeURIComponent(first.feedback.id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "resolved" })
    }),
    harness.env
  );
  const updated = await updateResponse.json();
  assert.equal(updateResponse.status, 200, JSON.stringify(updated));
  assert.equal(updated.feedback.status, "resolved");
  assert.ok(updated.feedback.resolvedAt);
  assert.deepEqual(
    harness.database.prepare(
      "SELECT action FROM knowledge_audit_events WHERE action LIKE 'knowledge.feedback.%' ORDER BY created_at, rowid"
    ).all().map((row) => row.action),
    ["knowledge.feedback.submit", "knowledge.feedback.status.update"]
  );
});

test("folder editing lists only editable root folders and enforces the selected subtree at mutation time", async () => {
  const harness = createKnowledgeHarness({ rootAclV2: true, mutationSpineV2: true });
  const call = (path, options = {}) => knowledgeWorker.fetch(new Request(`http://localhost${path}`, {
    ...options,
    headers: {
      "x-workspace-user-id": "owner-1", "x-workspace-role": "member",
      "Idempotency-Key": `folder-scope-${crypto.randomUUID()}`,
      ...(options.body && !(options.body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  }), harness.env);
  try {
    insertNamespace(harness.database);
    for (const [id, path] of [["root-a", "A"], ["root-b", "B"], ["viewer-root", "Viewer"]]) {
      insertObject(harness.database, { id, path, kind: "folder" });
      harness.database.prepare(`INSERT INTO knowledge_permissions
        (id, namespace_id, object_id, subject_type, subject_id, role)
        VALUES (?, 'namespace-1', ?, 'user', ?, 'owner')`).run(`acl-${id}`, id, id === "viewer-root" ? "someone-else" : "owner-1");
    }
    insertObject(harness.database, { id: "sub-a", path: "A/Sub", kind: "folder" });
    insertObject(harness.database, { id: "file-a", path: "A/note.md", currentVersionId: "v1" });
    insertObject(harness.database, { id: "file-b", path: "B/note.md", currentVersionId: "v1" });
    const listed = await call("/api/editable-folders");
    assert.equal(listed.status, 200, await listed.clone().text());
    assert.deepEqual((await listed.json()).items.map((item) => item.id), ["root-a", "root-b"]);
    const allWritable = await call("/api/editable-folders?scope=all");
    assert.equal(allWritable.status, 200);
    assert.deepEqual((await allWritable.json()).items.map((item) => item.id), ["root-a", "sub-a", "root-b"]);
    const dynamicHeaders = { "x-workspace-folder-edit-scope": '"all"' };
    assert.equal((await call("/api/files/file-b", { headers: dynamicHeaders })).status, 200);
    assert.equal((await call("/api/tree?folderObjectId=viewer-root", { headers: dynamicHeaders })).status, 403);
    assert.equal((await call("/api/objects/root-a/rename", {
      method: "POST", headers: dynamicHeaders,
      body: JSON.stringify({ name: "Forbidden", expectedCurrentVersionId: "v1" })
    })).status, 403);
    const renameDynamicChild = await call("/api/objects/sub-a/rename", {
      method: "POST", headers: dynamicHeaders,
      body: JSON.stringify({ name: "Renamed child", expectedCurrentVersionId: "" })
    });
    assert.equal(renameDynamicChild.status, 200, await renameDynamicChild.clone().text());
    assert.equal(harness.database.prepare("SELECT path FROM knowledge_objects WHERE id = 'sub-a'").get().path, "A/Renamed child");
    const headers = { "x-workspace-folder-edit-scope": '["root-a"]' };
    const metadata = await call("/api/files/file-a", { headers });
    assert.equal(metadata.status, 200, await metadata.clone().text());
    assert.equal((await metadata.json()).item.effectiveRole, "collaborator");
    const rename = (id, name, extra = {}) => call(`/api/objects/${id}/rename`, {
      method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify({ name, expectedCurrentVersionId: "v1" })
    });
    const renamed = await rename("file-a", "updated.md");
    assert.equal(renamed.status, 200, await renamed.clone().text());
    const outside = await rename("file-b", "stolen.md");
    assert.equal(outside.status, 403);
    assert.equal((await outside.json()).error, "folder_edit_outside_scope");
    assert.equal((await rename("root-a", "Renamed root")).status, 403);
    const move = await call("/api/objects/file-a/move", {
      method: "POST", headers, body: JSON.stringify({ parentObjectId: "root-b" })
    });
    assert.equal(move.status, 403);
    const accessChange = await call("/api/objects/root-a/collaborators", {
      method: "PUT", headers, body: JSON.stringify({ userIds: ["someone-else"] })
    });
    assert.equal(accessChange.status, 403);
    assert.equal((await accessChange.json()).error, "folder_edit_content_only");
    const batch = await call("/api/edit/batch", {
      method: "POST", headers,
      body: JSON.stringify({ items: [
        { objectId: "file-a", expectedCurrentVersionId: "v1", operation: "append_text", text: "safe" },
        { objectId: "file-b", expectedCurrentVersionId: "v1", operation: "append_text", text: "escape" }
      ] })
    });
    assert.equal(batch.status, 403);
    assert.equal((await batch.json()).error, "folder_edit_outside_scope");
    assert.equal(harness.database.prepare("SELECT current_version_id FROM knowledge_objects WHERE id = 'file-a'").get().current_version_id, "v1");
    insertObject(harness.database, { id: "prefix-trap", path: "AB/note.md", currentVersionId: "v1" });
    assert.equal((await rename("prefix-trap", "escape.md")).status, 403);
    assert.equal((await rename("file-a", "bad-header.md", { "x-workspace-folder-edit-scope": "[]" })).status, 403);
    const create = await call("/api/folders", { method: "POST", headers, body: JSON.stringify({ name: "Allowed", parentObjectId: "sub-a" }) });
    assert.equal(create.status, 201, await create.clone().text());
    const missingParent = await call("/api/folders", { method: "POST", headers, body: JSON.stringify({ name: "Escape" }) });
    assert.equal(missingParent.status, 403);
    // The same Release binding cannot preserve edit rights after ACL revocation.
    harness.database.prepare("UPDATE knowledge_permissions SET subject_id = 'someone-else' WHERE id = 'acl-root-a'").run();
    assert.equal((await rename("file-a", "after-revoke.md")).status, 403);
    assert.equal(harness.database.prepare("SELECT path FROM knowledge_objects WHERE id = 'file-b'").get().path, "B/note.md");
  } finally { harness.close(); }
});

function createIndexDispatchHarness() {
  const harness = createKnowledgeHarness({ knowledgeIndexQueue: true });
  insertNamespace(harness.database);
  insertObject(harness.database, { id: "service-root", kind: "folder", path: "Service" });
  insertObject(harness.database, { id: "handbook", path: "Service/handbook.md" });
  harness.database.exec(`
    INSERT INTO knowledge_services (
      id, namespace_id, folder_object_id, handbook_object_id, name, description,
      status, agent_enabled, source_revision, index_status, created_by_user_id
    ) VALUES (
      'service-1', 'namespace-1', 'service-root', 'handbook', 'Fixture', 'Fixture',
      'active', 1, 1, 'stale', 'owner-1'
    );
  `);
  return harness;
}

function createKnowledgeHarness(options = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(options.legacySchema ? legacyKnowledgeSchema() : schema);
  const d1 = new SqliteD1(database);
  const r2 = new MemoryR2();
  const queueMessages = [];
  const env = {
    DEV_AUTH_BYPASS: "1",
    KNOWLEDGE_DB: d1,
    KNOWLEDGE_OBJECTS: r2,
    KNOWLEDGE_ORG_ID: "org-1",
    KNOWLEDGE_PUBLIC_URL: "https://knowledge.test",
    KNOWLEDGE_V2_INDEX_READ_ENABLED: options.indexReadV2 ? "1" : "0",
    KNOWLEDGE_V2_MUTATION_SPINE_ENABLED: options.mutationSpineV2 ? "1" : "0",
    KNOWLEDGE_V2_ROOT_ACL_ENABLED: options.rootAclV2 ? "1" : "0"
  };
  if (options.knowledgeIndexQueue) {
    env.KNOWLEDGE_INDEX_QUEUE = {
      async send(message) {
        queueMessages.push(message);
      }
    };
  }
  return {
    database,
    d1,
    queueMessages,
    r2,
    env,
    close() {
      database.close();
    }
  };
}

function insertNamespace(database, options = {}) {
  database.prepare(`
    INSERT INTO knowledge_namespaces (
      id, org_id, owner_user_id, kind, name, slug, r2_prefix, quota_bytes, used_bytes
    ) VALUES (?, 'org-1', ?, 'personal', 'Owner Knowledge', 'owner-knowledge', 'org/org-1/ns/namespace-1', ?, ?)
  `).run("namespace-1", options.ownerUserId ?? "owner-1", options.quotaBytes ?? 0, options.usedBytes ?? 0);
}

function insertObject(database, options) {
  const pathParts = options.path.split("/").filter(Boolean);
  const fileName = pathParts.at(-1) ?? options.path;
  const parentPath = pathParts.slice(0, -1).join("/");
  database.prepare(`
    INSERT INTO knowledge_objects (
      id, namespace_id, parent_path, path, file_name, object_kind, mime_type, content_kind,
      current_version_id, size_bytes, created_by_user_id, updated_by_user_id, deleted_at
    ) VALUES (?, 'namespace-1', ?, ?, ?, ?, ?, ?, ?, ?, 'owner-1', 'owner-1', ?)
  `).run(
    options.id,
    parentPath,
    options.path,
    fileName,
    options.kind ?? "file",
    options.kind === "folder" ? "application/x-directory" : "text/plain",
    options.kind === "folder" ? "folder" : "text",
    options.currentVersionId ?? "",
    options.sizeBytes ?? 0,
    options.deletedAt ?? null
  );
}

function insertVersion(database, options) {
  database.prepare(`
    INSERT INTO knowledge_object_versions (
      id, object_id, namespace_id, version, r2_key, mime_type, size_bytes, sha256, created_by_user_id
    ) VALUES (?, ?, 'namespace-1', ?, ?, 'text/plain', ?, 'base-sha', 'owner-1')
  `).run(options.id, options.objectId, options.version, `base/${options.id}`, options.sizeBytes);
}

async function uploadVersion(harness, objectId, bytes) {
  const form = new FormData();
  form.set("file", new File([bytes], "report.txt", { type: "text/plain" }));
  const response = await knowledgeWorker.fetch(
    new Request(`http://localhost/api/files/${objectId}/versions`, { method: "POST", body: form }),
    harness.env
  );
  return { response, body: await response.json() };
}

function formRequest(path, file, headers = {}) {
  const form = new FormData();
  form.set("file", file);
  return {
    method: "POST",
    url: `http://localhost${path}`,
    headers: new Headers(headers),
    formData: async () => form
  };
}

function oversizedFile(name, type, size, onArrayBuffer) {
  const file = new File([], name, { type });
  Object.defineProperty(file, "size", { value: size });
  file.arrayBuffer = async () => {
    onArrayBuffer();
    return new ArrayBuffer(0);
  };
  return file;
}

function setFirstZipCentralDirectoryUncompressedSize(bytes, size) {
  for (let index = 0; index <= bytes.length - 28; index += 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x01 && bytes[index + 3] === 0x02) {
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(index + 24, size, true);
      return;
    }
  }
  throw new Error("zip_central_directory_not_found");
}

function legacyKnowledgeSchema() {
  const objectTableEnd = "  deleted_at TEXT\n);\n\nCREATE TABLE IF NOT EXISTS knowledge_object_versions";
  const legacyObjectTableEnd = "  deleted_at TEXT,\n  UNIQUE(namespace_id, path)\n);\n\nCREATE TABLE IF NOT EXISTS knowledge_object_versions";
  const partialIndex = /CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_objects_unique_active_path\n  ON knowledge_objects\(namespace_id, path\)\n  WHERE deleted_at IS NULL;\n/;
  assert.ok(schema.includes(objectTableEnd));
  assert.match(schema, partialIndex);
  const beforeRootAclV2 = schema.slice(0, schema.indexOf("-- Knowledge Service V2 Root ACL invariants."));
  return beforeRootAclV2.replace(objectTableEnd, legacyObjectTableEnd).replace(partialIndex, "");
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
    this.prepareCount = 0;
    this.nextBatchFailureIndex = undefined;
    this.nextBatchCommitTransportFailure = false;
    this.nextObjectVersionLookupFailure = false;
  }

  prepare(sql) {
    this.prepareCount += 1;
    return new SqliteD1Statement(this, sql);
  }

  resetPrepareCount() {
    this.prepareCount = 0;
  }

  failNextBatchAt(index) {
    this.nextBatchFailureIndex = index;
  }

  failNextBatchAfterCommit() {
    this.nextBatchCommitTransportFailure = true;
  }

  failNextObjectVersionLookup() {
    this.nextObjectVersionLookupFailure = true;
  }

  consumeObjectVersionLookupFailure(sql) {
    if (!this.nextObjectVersionLookupFailure || !/^\s*SELECT \* FROM knowledge_object_versions WHERE id = \?\s*$/i.test(sql)) {
      return false;
    }
    this.nextObjectVersionLookupFailure = false;
    return true;
  }

  async batch(statements) {
    const failureIndex = this.nextBatchFailureIndex;
    const commitTransportFailure = this.nextBatchCommitTransportFailure;
    this.nextBatchFailureIndex = undefined;
    this.nextBatchCommitTransportFailure = false;
    this.database.exec("BEGIN IMMEDIATE");
    let results;
    try {
      results = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (index === failureIndex) {
          throw new Error("injected_d1_batch_failure");
        }
        results.push(statements[index].execute());
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (commitTransportFailure) {
      throw new Error("injected_d1_batch_transport_failure_after_commit");
    }
    return results;
  }
}

class SqliteD1Statement {
  constructor(d1, sql, bindings = []) {
    this.d1 = d1;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SqliteD1Statement(this.d1, this.sql, bindings);
  }

  async first() {
    if (this.d1.consumeObjectVersionLookupFailure(this.sql)) {
      throw new Error("injected_d1_lookup_failure");
    }
    return this.d1.database.prepare(this.sql).get(...this.bindings) ?? null;
  }

  async all() {
    return { results: this.d1.database.prepare(this.sql).all(...this.bindings) };
  }

  async run() {
    return this.execute();
  }

  execute() {
    const statement = this.d1.database.prepare(this.sql);
    if (statement.columns().length > 0) {
      const results = statement.all(...this.bindings);
      return { success: true, results, meta: { changes: results.length } };
    }
    const result = statement.run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class MemoryR2 {
  constructor() {
    this.objects = new Map();
    this.putKeys = [];
    this.getKeys = [];
    this.deletedKeys = [];
  }

  async put(key, value) {
    const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, bytes);
    this.putKeys.push(key);
  }

  async delete(key) {
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }

  async head(key) {
    const bytes = this.objects.get(key);
    return bytes
      ? { key, size: bytes.byteLength }
      : null;
  }

  async get(key) {
    this.getKeys.push(key);
    const bytes = this.objects.get(key);
    if (!bytes) {
      return null;
    }
    const copy = bytes.slice();
    return {
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      body: copy,
      key,
      size: copy.byteLength
    };
  }

  async list({ prefix = "" } = {}) {
    return {
      cursor: undefined,
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false
    };
  }
}
