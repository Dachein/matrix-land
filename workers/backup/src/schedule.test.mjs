import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAppOwnerOrAdmin } from "./access.ts";
import { defaultBackupPolicy, resolvePolicyForTrigger } from "./policy.ts";
import { nextRunAt, normalizeComplianceRetention, normalizeSchedule } from "./schedule.ts";
import { BACKUP_JOB_INSERT_SQL } from "./statements.ts";
import { readD1ExportState } from "./cloudflare.ts";
import { strFromU8, unzipSync } from "fflate";
import { BackupZipArchive, backupArchiveFilename, d1ArchivePath, r2ArchivePath } from "./archive.ts";

describe("backup opt-in policy", () => {
  it("keeps every app disabled until an owner explicitly enables backups", () => {
    assert.deepEqual(defaultBackupPolicy("app_existing"), {
      appId: "app_existing",
      enabled: false,
      frequency: "weekly",
      scheduleTime: "00:00",
      scheduleTimezone: "Asia/Hong_Kong",
      scheduleWeekday: 1,
      scheduleMonthday: 1,
      complianceRetentionEnabled: false,
      complianceRetentionYears: 7,
      localCopyLimit: 10
    });
  });

  it("allows a manual backup without enabling an automated policy", () => {
    assert.deepEqual(resolvePolicyForTrigger(null, "manual", "org_workspace"), {
      org_id: "org_workspace",
      backup_node_id: null,
      compliance_retention_enabled: 0,
      compliance_retention_years: 7
    });
    assert.equal(resolvePolicyForTrigger({ enabled: 0 }, "manual", "org_workspace").enabled, 0);
    assert.equal(resolvePolicyForTrigger({ enabled: 0 }, "scheduled", "org_workspace"), null);
  });

  it("allows only the owner or an administrator to create an app-level manual backup", () => {
    assert.equal(isAppOwnerOrAdmin({ sub: "owner@example.com", role: "user" }, "owner@example.com"), true);
    assert.equal(isAppOwnerOrAdmin({ sub: "admin@example.com", role: "admin" }, "owner@example.com"), true);
    assert.equal(isAppOwnerOrAdmin({ sub: "collaborator@example.com", role: "user" }, "owner@example.com"), false);
  });

  it("keeps backup job SQL placeholders aligned with its bind arguments", () => {
    assert.equal(BACKUP_JOB_INSERT_SQL.match(/\?/g)?.length, 16);
  });
});

describe("backup schedule", () => {
  it("defaults to a weekly Hong Kong schedule", () => {
    assert.deepEqual(normalizeSchedule({}), {
      frequency: "weekly", scheduleTime: "00:00", scheduleTimezone: "Asia/Hong_Kong",
      scheduleWeekday: 1, scheduleMonthday: 1
    });
  });

  it("computes the next weekly run in the fixed Hong Kong timezone", () => {
    const schedule = normalizeSchedule({ frequency: "weekly", scheduleTime: "14:30", scheduleTimezone: "Asia/Singapore", scheduleWeekday: 1 });
    assert.equal(schedule.scheduleTime, "00:00");
    assert.equal(nextRunAt(schedule, new Date("2026-08-09T00:00:00.000Z")), "2026-08-09T16:00:00.000Z");
  });

  it("computes the next daily run", () => {
    const schedule = normalizeSchedule({ frequency: "daily", scheduleTime: "23:59" });
    assert.equal(nextRunAt(schedule, new Date("2026-08-09T19:00:00.000Z")), "2026-08-10T16:00:00.000Z");
  });

  it("accepts every standard day of month from 1 through 31", () => {
    assert.equal(normalizeSchedule({ frequency: "monthly", scheduleMonthday: 31 }).scheduleMonthday, 31);
    assert.equal(normalizeSchedule({ frequency: "monthly", scheduleMonthday: 32 }).scheduleMonthday, 1);
  });

  it("runs a 29th, 30th, or 31st schedule on February's final day", () => {
    for (const scheduleMonthday of [29, 30, 31]) {
      const schedule = normalizeSchedule({ frequency: "monthly", scheduleTime: "02:00", scheduleMonthday });
      assert.equal(nextRunAt(schedule, new Date("2027-02-01T00:00:00.000Z")), "2027-02-27T16:00:00.000Z");
    }
  });

  it("uses February 29 in a leap year and April 30 for a 31st schedule", () => {
    const schedule = normalizeSchedule({ frequency: "monthly", scheduleTime: "02:00", scheduleMonthday: 31 });
    assert.equal(nextRunAt(schedule, new Date("2028-02-01T00:00:00.000Z")), "2028-02-28T16:00:00.000Z");
    assert.equal(nextRunAt(schedule, new Date("2027-04-01T00:00:00.000Z")), "2027-04-29T16:00:00.000Z");
  });
});

describe("backup compliance retention", () => {
  it("defaults to disabled with a seven-year value ready for opt-in", () => {
    assert.deepEqual(normalizeComplianceRetention({}), {
      complianceRetentionEnabled: false,
      complianceRetentionYears: 7
    });
  });

  it("accepts three, seven, and bounded custom year values", () => {
    assert.equal(normalizeComplianceRetention({ complianceRetentionEnabled: true, complianceRetentionYears: 3 }).complianceRetentionYears, 3);
    assert.equal(normalizeComplianceRetention({ complianceRetentionEnabled: true, complianceRetentionYears: 7 }).complianceRetentionYears, 7);
    assert.equal(normalizeComplianceRetention({ complianceRetentionEnabled: true, complianceRetentionYears: 12 }).complianceRetentionYears, 12);
    assert.equal(normalizeComplianceRetention({ complianceRetentionEnabled: true, complianceRetentionYears: 120 }).complianceRetentionYears, 7);
  });
});

describe("Cloudflare D1 export responses", () => {
  it("reads the signed URL from Cloudflare's nested completed result", () => {
    assert.deepEqual(readD1ExportState({
      result: {
        status: "complete",
        at_bookmark: "bookmark-1",
        result: { signed_url: "https://example.com/database.sql" }
      }
    }), {
      signedUrl: "https://example.com/database.sql",
      status: "complete",
      error: "",
      bookmark: "bookmark-1"
    });
  });

  it("keeps compatibility with a top-level signed URL", () => {
    assert.equal(readD1ExportState({ result: { signed_url: "https://example.com/legacy.sql" } }).signedUrl, "https://example.com/legacy.sql");
  });
});

describe("ZIP backup archives", () => {
  it("stores D1, R2, and the manifest as one downloadable ZIP object", async () => {
    const bucket = new FakeR2Bucket();
    const filename = backupArchiveFilename("workbuddy-request", "2026-08-10T00:00:00.000Z", "bjob_123");
    const archive = await BackupZipArchive.create(bucket, `org/app/job/${filename}`, filename, new Date("2026-08-10T00:00:00.000Z"));
    await archive.addStream(d1ArchivePath("apps-workbuddy-request-db"), new Blob(["CREATE TABLE requests (id TEXT);"]).stream());
    const objectPath = r2ArchivePath("workbuddy-files", "../documents/account statement.pdf");
    await archive.addStream(objectPath, new Blob(["statement-data"]).stream());
    await archive.addText("manifest.json", JSON.stringify({ version: 2, format: "workspace-backup-zip" }));
    const stored = await archive.finish();

    assert.equal(filename, "workbuddy-request-2026-08-10-bjob_123.zip");
    assert.equal(stored.size, bucket.objects.get(archive.key).byteLength);
    assert.equal(bucket.options.httpMetadata.contentType, "application/zip");
    assert.match(bucket.options.httpMetadata.contentDisposition, /workbuddy-request-2026-08-10-bjob_123\.zip/);

    const files = unzipSync(bucket.objects.get(archive.key));
    assert.equal(strFromU8(files["d1/apps-workbuddy-request-db.sql"]), "CREATE TABLE requests (id TEXT);");
    assert.equal(strFromU8(files["r2/workbuddy-files/%2E%2E/documents/account statement.pdf"]), "statement-data");
    assert.deepEqual(JSON.parse(strFromU8(files["manifest.json"])), { version: 2, format: "workspace-backup-zip" });
    assert.equal(Object.keys(files).some((path) => path.split("/").includes("..")), false);
  });
});

class FakeR2Bucket {
  objects = new Map();
  options = {};

  async createMultipartUpload(key, options) {
    this.options = options;
    const parts = new Map();
    return {
      key,
      uploadId: "upload-1",
      uploadPart: async (partNumber, value) => {
        const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
        parts.set(partNumber, bytes);
        return { partNumber, etag: `etag-${partNumber}` };
      },
      abort: async () => undefined,
      complete: async (uploadedParts) => {
        const size = uploadedParts.reduce((total, part) => total + parts.get(part.partNumber).byteLength, 0);
        const output = new Uint8Array(size);
        let offset = 0;
        for (const part of uploadedParts) {
          const bytes = parts.get(part.partNumber);
          output.set(bytes, offset);
          offset += bytes.byteLength;
        }
        this.objects.set(key, output);
        return { key, size };
      }
    };
  }
}
