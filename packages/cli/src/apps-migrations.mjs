import { createHash } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { callMcpTool } from "./mcp-client.mjs";
import { mcpToolPayload } from "./mcp-result.mjs";
import { analyzeMigrationStatement, parseMigrationStatements } from "./migration-sql.mjs";

const MAX_MIGRATION_BYTES = 80_000;
const MAX_MIGRATION_FILES = 500;

export async function planAppsMigrations(store, input, options = {}) {
  return publicMigrationPlan(await buildMigrationPlan(store, input, options));
}

async function buildMigrationPlan(store, input, options) {
  const local = await readMigrationDirectory(input.directory, { tablePrefix: input.tablePrefix });
  const remote = mcpToolPayload(await callMcpTool(store, "apps_database", { action: "migrations_list", appId: input.appId }, options));
  const applied = new Map((remote.migrations ?? []).map((migration) => [String(migration.version), migration]));
  const migrations = local.map((migration) => {
    const existing = applied.get(migration.version);
    if (!existing) return { ...migration, status: "pending" };
    if (!existing.contentSha256) return { ...migration, status: "applied_unverified", remote: existing };
    return existing.contentSha256 === migration.contentSha256
      ? { ...migration, status: "applied", remote: existing }
      : { ...migration, status: "drift", remote: existing };
  });
  const pendingDataMigrations = migrations.filter((item) => item.status === "pending" && item.impact.dataStatementCount > 0);
  return {
    appId: input.appId,
    directory: resolve(input.directory || "migrations"),
    migrations,
    summary: {
      applied: migrations.filter((item) => item.status === "applied").length,
      appliedUnverified: migrations.filter((item) => item.status === "applied_unverified").length,
      dataMigrationCount: migrations.filter((item) => item.impact.dataStatementCount > 0).length,
      dataMutationTypes: Array.from(new Set(migrations.flatMap((item) => item.impact.dataMutationTypes))).sort(),
      dataStatementCount: migrations.reduce((total, item) => total + item.impact.dataStatementCount, 0),
      drift: migrations.filter((item) => item.status === "drift").length,
      pending: migrations.filter((item) => item.status === "pending").length,
      pendingDataMigrationCount: pendingDataMigrations.length,
      requiresDataMigrationApproval: pendingDataMigrations.length > 0
    }
  };
}

export async function applyAppsMigrations(store, input, options = {}) {
  const plan = await buildMigrationPlan(store, input, options);
  const drift = plan.migrations.filter((migration) => migration.status === "drift");
  if (drift.length > 0) {
    throw new Error(`Migration drift detected: ${drift.map((item) => item.fileName).join(", ")}`);
  }
  const pendingDataMigrations = plan.migrations.filter((migration) => migration.status === "pending" && migration.impact.dataStatementCount > 0);
  if (pendingDataMigrations.length > 0 && !input.allowDataMigrations) {
    throw new Error(
      `Pending data migrations require separate approval: ${pendingDataMigrations.map((item) => item.fileName).join(", ")}. ` +
      "Review the plan, obtain explicit approval, then rerun apply with --allow-data-migrations."
    );
  }
  if (pendingDataMigrations.length > 0 && !String(input.tablePrefix ?? "").trim()) {
    throw new Error("Data migrations require an explicit --table-prefix so App-owned table targets can be verified locally and by MCP");
  }

  const applied = [];
  for (const migration of plan.migrations.filter((item) => item.status === "pending")) {
    const result = mcpToolPayload(await callMcpTool(store, "apps_database", {
      action: "migration_apply",
      appId: input.appId,
      allowDataMigrations: migration.impact.dataStatementCount > 0 && input.allowDataMigrations === true,
      contentSha256: migration.contentSha256,
      fileName: migration.fileName,
      sql: migration.sql,
      tablePrefix: input.tablePrefix,
      version: migration.version
    }, options));
    applied.push(result.migration);
  }

  return {
    appId: input.appId,
    applied,
    appliedCount: applied.length,
    plan: {
      directory: plan.directory,
      summary: plan.summary
    }
  };
}

function publicMigrationPlan(plan) {
  return {
    ...plan,
    migrations: plan.migrations.map(({ sql: _sql, ...migration }) => migration)
  };
}

async function readMigrationDirectory(directory, options = {}) {
  const root = resolve(directory || "migrations");
  const stat = await lstat(root).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Migration directory is not a directory: ${root}`);
  const handle = await opendir(root);
  const entries = [];
  for await (const entry of handle) entries.push(entry);
  const sqlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));
  const unexpectedLinks = entries.filter((entry) => entry.isSymbolicLink());
  if (unexpectedLinks.length > 0) throw new Error(`Migration directory contains symbolic links: ${unexpectedLinks.map((entry) => entry.name).join(", ")}`);
  sqlFiles.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (sqlFiles.length === 0) throw new Error(`Migration directory contains no .sql files: ${root}`);
  if (sqlFiles.length > MAX_MIGRATION_FILES) throw new Error(`Migration directory contains more than ${MAX_MIGRATION_FILES} SQL files`);

  const migrations = [];
  const versions = new Set();
  for (const entry of sqlFiles) {
    const version = entry.name.slice(0, -4);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(version)) {
      throw new Error(`Invalid migration filename: ${entry.name}`);
    }
    if (versions.has(version)) throw new Error(`Duplicate migration version: ${version}`);
    versions.add(version);
    const sql = await readFile(join(root, entry.name), "utf8");
    const sizeBytes = Buffer.byteLength(sql);
    if (sizeBytes === 0) throw new Error(`Migration file is empty: ${entry.name}`);
    if (sizeBytes > MAX_MIGRATION_BYTES) throw new Error(`Migration file exceeds ${MAX_MIGRATION_BYTES} bytes: ${entry.name}`);
    const impact = analyzeAppsMigrationSql(sql, entry.name, options);
    migrations.push({
      contentSha256: createHash("sha256").update(sql).digest("hex"),
      fileName: entry.name,
      impact,
      sizeBytes,
      sql,
      version
    });
  }
  return migrations;
}

export function analyzeAppsMigrationSql(sql, fileName = "migration.sql", options = {}) {
  const statements = parseMigrationStatements(sql);
  if (statements.length === 0) throw new Error(`Migration file contains no SQL statements: ${fileName}`);
  const analyses = [];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    try {
      analyses.push(analyzeMigrationStatement(statement, options));
    } catch (error) {
      const kind = statement.replace(/^\s+/, "").match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? "UNKNOWN";
      throw new Error(
        `Unsupported App D1 migration statement in ${fileName} at statement ${index + 1} (${kind}). ` +
        `${error instanceof Error ? error.message : "Statement failed validation"}. ` +
        "Allowed schema statements are CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and ALTER TABLE ADD COLUMN. " +
        "Controlled data statements are INSERT ... VALUES [ON CONFLICT], plus UPDATE or DELETE with WHERE.",
        { cause: error }
      );
    }
  }
  const data = analyses.filter((item) => item.category === "data");
  return {
    dataMutationTypes: Array.from(new Set(data.map((item) => item.type))).sort(),
    dataStatementCount: data.length,
    dataTables: Array.from(new Set(data.map((item) => item.table))).sort(),
    requiresDataMigrationApproval: data.length > 0,
    schemaStatementCount: analyses.length - data.length,
    statementCount: analyses.length,
    statementTypes: analyses.map((item) => item.type)
  };
}

export const validateAppsMigrationSql = analyzeAppsMigrationSql;
