import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { buildPublicationPublicationProjection } from "./authSync.ts";
import {
  publicationPublicationOutboxStatements,
  processPublicationPublicationJob,
  retryPublicationPublication
} from "./publicationOutbox.ts";

class SqliteD1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SqliteD1Statement(this.database, this.sql, bindings);
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.bindings) };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.bindings) ?? null;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: result.changes } };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function createPublicationDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../../../db/schema.sql", import.meta.url), "utf8"));
  sqlite.exec(`
    INSERT INTO teams (id, name, slug)
    VALUES ('team-1', 'AI Adoption', 'ai-adoption');

    INSERT INTO users (id, team_id, name, email)
    VALUES ('user-1', 'team-1', 'Ada', 'ada@example.test');

    INSERT INTO apps (
      id,
      owner_team_id,
      publisher_user_id,
      name,
      slug,
      description,
      launch_url,
      callback_url,
      sdk_status,
      status,
      uses_workspace_auth
    ) VALUES (
      'app-1',
      'team-1',
      'user-1',
      'Operations App',
      'operations-app',
      'Operations',
      'https://ops.example.test',
      'https://ops.example.test/auth/workspace/callback',
      'connected',
      'pending_review',
      1
    );

    INSERT INTO publication_listings (
      id,
      listing_type,
      target_id,
      created_by_user_id,
      name,
      slug,
      status,
      desired_status,
      effective_status,
      publication_status
    ) VALUES (
      'listing-app-1',
      'app',
      'app-1',
      'user-1',
      'Operations App',
      'operations-app-listing',
      'pending_review',
      'pending_review',
      'pending_review',
      'synced'
    );
  `);
  return { db: new SqliteD1(sqlite), sqlite };
}

async function enqueueStatus(db, desiredStatus, requestId) {
  const projection = await buildPublicationPublicationProjection(db, {
    createdByUserId: "user-1",
    desiredStatus,
    listingId: "listing-app-1",
    listingName: "Operations App",
    listingType: "app",
    targetId: "app-1",
    visibility: "company"
  });
  const outbox = await publicationPublicationOutboxStatements(db, {
    desiredStatus,
    listingId: "listing-app-1",
    projection,
    requestId
  });
  await db.batch([
    db
      .prepare(
        `
        UPDATE publication_listings
        SET status = ?,
            desired_status = ?,
            publication_status = 'pending'
        WHERE id = 'listing-app-1'
        `
      )
      .bind(desiredStatus, desiredStatus),
    ...outbox.statements
  ]);
  return outbox.jobId;
}

describe("publication publication outbox", () => {
  it("builds an Auth publication projection for a APPS App without a Portal apps row", async () => {
    const { db, sqlite } = createPublicationDb();
    try {
      const projection = await buildPublicationPublicationProjection(db, {
        builderSnapshot: {
          appsVerified: {
            app: {
              accessTargets: ["department:research"],
              collaboratorUserIds: ["collaborator-1"],
              id: "apps-app-1",
              loginRequired: true,
              manifest: {
                auth: {
                  callbackUrls: { production: "https://academy.example.test/auth/workspace/callback" }
                }
              },
              name: "APPS Academy",
              ownerUserId: "owner-1",
              productionUrl: "https://academy.example.test",
              visibility: "team"
            }
          }
        },
        createdByUserId: "publisher-1",
        desiredStatus: "listed",
        listingId: "listing-apps-app-1",
        listingName: "Reviewed APPS Academy",
        listingType: "app",
        targetId: "apps-app-1",
        targetPlane: "apps",
        visibility: "company"
      });

      assert.deepEqual(projection, {
        endpointPath: "/v1/admin/apps",
        kind: "app",
        payload: {
          accessMode: "targeted",
          accessTargets: ["user:collaborator-1", "department:research"],
          businessOwnerUserId: "owner-1",
          callbackUrls: ["https://academy.example.test/auth/workspace/callback"],
          id: "apps-app-1",
          launchUrl: "https://academy.example.test",
          name: "Reviewed APPS Academy",
          publisherUserId: "owner-1",
          sdkStatus: "connected",
          status: "listed"
        },
        targetId: "apps-app-1"
      });
    } finally {
      sqlite.close();
    }
  });

  it("keeps effective state unchanged after Auth failure and converges on retry", async () => {
    const { db, sqlite } = createPublicationDb();
    try {
      const jobId = await enqueueStatus(db, "listed", "review-request-1");
      const failedAt = new Date(Date.now() + 60_000);
      const failed = await processPublicationPublicationJob(
        db,
        {
          AUTH_SERVICE_TOKEN: "service-token",
          AUTH_WORKER_URL: "https://auth.example.test"
        },
        jobId,
        {
          clock: () => failedAt,
          async fetch() {
            return new Response("private upstream failure", {
              status: 503,
              headers: { "x-request-id": "auth-503" }
            });
          },
          randomUUID: () => "lease-1"
        }
      );

      assert.equal(failed.publicationStatus, "failed");
      assert.deepEqual(
        { ...sqlite.prepare(`
          SELECT status, desired_status, effective_status, publication_status, publication_error_code
          FROM publication_listings
          WHERE id = 'listing-app-1'
        `).get() },
        {
          status: "listed",
          desired_status: "listed",
          effective_status: "pending_review",
          publication_status: "failed",
          publication_error_code: "auth_worker_rejected_projection"
        }
      );

      const retryJobId = await retryPublicationPublication(db, "listing-app-1");
      assert.equal(retryJobId, jobId);
      const deliveredBodies = [];
      const succeeded = await processPublicationPublicationJob(
        db,
        {
          AUTH_SERVICE_TOKEN: "service-token",
          AUTH_WORKER_URL: "https://auth.example.test"
        },
        jobId,
        {
          clock: () => new Date(failedAt.getTime() + 5 * 60_000),
          async fetch(_input, init) {
            deliveredBodies.push(JSON.parse(init.body));
            return new Response("{}", { status: 200 });
          },
          randomUUID: () => "lease-2"
        }
      );

      assert.equal(succeeded.publicationStatus, "synced");
      assert.equal(deliveredBodies[0].status, "listed");
      assert.deepEqual(
        { ...sqlite.prepare(`
          SELECT desired_status, effective_status, publication_status
          FROM publication_listings
          WHERE id = 'listing-app-1'
        `).get() },
        {
          desired_status: "listed",
          effective_status: "listed",
          publication_status: "synced"
        }
      );
    } finally {
      sqlite.close();
    }
  });

  it("supersedes an obsolete job before delivery and preserves its immutable payload", async () => {
    const { db, sqlite } = createPublicationDb();
    try {
      const listedJobId = await enqueueStatus(db, "listed", "listed-request");
      const listedPayload = sqlite
        .prepare("SELECT payload_json FROM publication_publication_outbox WHERE id = ?")
        .get(listedJobId).payload_json;
      const delistedJobId = await enqueueStatus(db, "delisted", "delisted-request");
      let fetchCalls = 0;
      const obsolete = await processPublicationPublicationJob(
        db,
        {
          AUTH_SERVICE_TOKEN: "service-token",
          AUTH_WORKER_URL: "https://auth.example.test"
        },
        listedJobId,
        {
          async fetch() {
            fetchCalls += 1;
            return new Response("{}", { status: 200 });
          }
        }
      );

      assert.equal(obsolete.state, "superseded");
      assert.equal(fetchCalls, 0);
      assert.equal(
        sqlite.prepare("SELECT payload_json FROM publication_publication_outbox WHERE id = ?").get(listedJobId).payload_json,
        listedPayload
      );
      assert.equal(
        sqlite.prepare("SELECT state FROM publication_publication_outbox WHERE id = ?").get(delistedJobId).state,
        "pending"
      );
    } finally {
      sqlite.close();
    }
  });

  it("re-delivers a previously completed projection when a listing returns to that status", async () => {
    const { db, sqlite } = createPublicationDb();
    try {
      const deliveredStatuses = [];
      const deliver = async (jobId, lease) => processPublicationPublicationJob(
        db,
        {
          AUTH_SERVICE_TOKEN: "service-token",
          AUTH_WORKER_URL: "https://auth.example.test"
        },
        jobId,
        {
          async fetch(_input, init) {
            deliveredStatuses.push(JSON.parse(init.body).status);
            return new Response("{}", { status: 200 });
          },
          randomUUID: () => lease
        }
      );

      const firstListedJobId = await enqueueStatus(db, "listed", "listed-first");
      assert.equal((await deliver(firstListedJobId, "lease-listed-first")).state, "completed");
      const delistedJobId = await enqueueStatus(db, "delisted", "delisted");
      assert.equal((await deliver(delistedJobId, "lease-delisted")).state, "completed");

      const secondListedJobId = await enqueueStatus(db, "listed", "listed-second");
      assert.equal(secondListedJobId, firstListedJobId);
      assert.equal(
        sqlite.prepare("SELECT state FROM publication_publication_outbox WHERE id = ?").get(secondListedJobId).state,
        "pending"
      );
      assert.equal((await deliver(secondListedJobId, "lease-listed-second")).state, "completed");
      assert.deepEqual(deliveredStatuses, ["listed", "delisted", "listed"]);
      assert.deepEqual(
        { ...sqlite.prepare(`
          SELECT desired_status, effective_status, publication_status
          FROM publication_listings
          WHERE id = 'listing-app-1'
        `).get() },
        {
          desired_status: "listed",
          effective_status: "listed",
          publication_status: "synced"
        }
      );
    } finally {
      sqlite.close();
    }
  });
});
