import {
  deliverPublicationPublicationProjection,
  type PublicationPublicationDeliveryResult,
  type PublicationPublicationProjection,
  type PublicationPublicationStatus
} from "./authSync.ts";

export type PublicationPublicationEnv = {
  AUTH_SERVICE_TOKEN?: string;
  AUTH_WORKER_URL?: string;
};

type PublicationPublicationOutboxRow = {
  attemptCount: number;
  desiredStatus: PublicationPublicationStatus;
  endpointPath: string;
  id: string;
  listingId: string;
  lastRequestId: string;
  payloadJson: string;
  state: "pending" | "processing" | "completed" | "failed" | "superseded";
  targetId: string;
  targetKind: "app" | "resource" | "none";
};

export type PublicationPublicationProcessingResult = {
  delivery?: PublicationPublicationDeliveryResult;
  jobId: string;
  publicationStatus: "synced" | "pending" | "failed" | "not_required";
  state: "completed" | "failed" | "missing" | "superseded";
};

export async function publicationPublicationOutboxStatements(
  db: D1Database,
  input: {
    desiredStatus: PublicationPublicationStatus;
    listingId: string;
    projection: PublicationPublicationProjection;
    requestId?: string;
  }
) {
  const payloadJson = JSON.stringify(input.projection);
  const payloadHash = await sha256Hex(payloadJson);
  const jobKeyHash = await sha256Hex(
    `${input.listingId}\n${input.desiredStatus}\n${payloadHash}`
  );
  const jobId = `market-pub-${jobKeyHash}`;
  return {
    jobId,
    statements: [
      db
        .prepare(
          `
          UPDATE publication_publication_outbox
          SET state = 'superseded',
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP,
              completed_at = CURRENT_TIMESTAMP
          WHERE listing_id = ?
            AND state IN ('pending', 'failed')
          `
        )
        .bind(input.listingId),
      db
        .prepare(
          `
          INSERT INTO publication_publication_outbox (
            id,
            listing_id,
            target_kind,
            target_id,
            desired_status,
            endpoint_path,
            payload_json,
            payload_hash,
            state,
            attempt_count,
            next_attempt_at,
            last_request_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, CURRENT_TIMESTAMP, ?)
          ON CONFLICT(listing_id, desired_status, payload_hash) DO UPDATE SET
            state = 'pending',
            next_attempt_at = CURRENT_TIMESTAMP,
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error_code = '',
            last_http_status = NULL,
            last_request_id = excluded.last_request_id,
            completed_at = NULL,
            updated_at = CURRENT_TIMESTAMP
          `
        )
        .bind(
          jobId,
          input.listingId,
          input.projection.kind,
          input.projection.targetId,
          input.desiredStatus,
          input.projection.endpointPath,
          payloadJson,
          payloadHash,
          sanitizeRequestId(input.requestId)
        )
    ]
  };
}

export async function processPublicationPublicationJob(
  db: D1Database,
  env: PublicationPublicationEnv,
  jobId: string,
  dependencies: {
    clock?: () => Date;
    fetch?: typeof fetch;
    randomUUID?: () => string;
  } = {}
): Promise<PublicationPublicationProcessingResult> {
  const clock = dependencies.clock ?? (() => new Date());
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const job = await readPublicationPublicationJob(db, jobId);
  if (!job) {
    return { jobId, publicationStatus: "pending", state: "missing" };
  }
  if (job.state === "completed") {
    return {
      jobId,
      publicationStatus: "synced",
      state: "completed"
    };
  }
  if (job.state === "superseded") {
    return { jobId, publicationStatus: "pending", state: "superseded" };
  }

  const listing = await db
    .prepare(
      `
      SELECT desired_status AS desiredStatus
      FROM publication_listings
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(job.listingId)
    .first<{ desiredStatus?: string }>();
  if (!listing || listing.desiredStatus !== job.desiredStatus) {
    await markPublicationPublicationJobSuperseded(db, job.id);
    return { jobId, publicationStatus: "pending", state: "superseded" };
  }

  const leaseToken = randomUUID();
  const claimed = await db
    .prepare(
      `
      UPDATE publication_publication_outbox
      SET state = 'processing',
          attempt_count = attempt_count + 1,
          lease_token = ?,
          lease_expires_at = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND (
          (state IN ('pending', 'failed') AND next_attempt_at <= ?)
          OR (state = 'processing' AND lease_expires_at <= ?)
        )
      `
    )
    .bind(
      leaseToken,
      new Date(clock().getTime() + 120_000).toISOString(),
      job.id,
      clock().toISOString(),
      clock().toISOString()
    )
    .run();
  if (readD1Changes(claimed) === 0) {
    return { jobId, publicationStatus: "pending", state: "failed" };
  }

  const projection = parsePublicationPublicationProjection(job.payloadJson);
  const delivery = projection
    ? await deliverPublicationPublicationProjection(
      env,
      projection,
      { fetch: dependencies.fetch },
      job.lastRequestId || jobId
    )
    : {
      errorCode: "invalid_publication_projection",
      publicationStatus: "failed",
      requestId: jobId,
      success: false
    } satisfies PublicationPublicationDeliveryResult;

  if (delivery.success) {
    await db.batch([
      db
        .prepare(
          `
          UPDATE publication_publication_outbox
          SET state = 'completed',
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error_code = '',
              last_http_status = NULL,
              last_request_id = ?,
              completed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND lease_token = ?
          `
        )
        .bind("requestId" in delivery ? delivery.requestId : "", job.id, leaseToken),
      db
        .prepare(
          `
          UPDATE publication_listings
          SET effective_status = ?,
              publication_status = ?,
              publication_error_code = '',
              publication_updated_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND desired_status = ?
          `
        )
        .bind(job.desiredStatus, delivery.publicationStatus, job.listingId, job.desiredStatus)
    ]);
    return {
      delivery,
      jobId,
      publicationStatus: delivery.publicationStatus,
      state: "completed"
    };
  }

  const nextAttemptAt = new Date(
    clock().getTime() + retryDelaySeconds(job.attemptCount + 1) * 1000
  ).toISOString();
  await db.batch([
    db
      .prepare(
        `
        UPDATE publication_publication_outbox
        SET state = 'failed',
            next_attempt_at = ?,
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error_code = ?,
            last_http_status = ?,
            last_request_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND lease_token = ?
        `
      )
      .bind(
        nextAttemptAt,
        delivery.errorCode,
        delivery.httpStatus ?? null,
        delivery.requestId,
        job.id,
        leaseToken
      ),
    db
      .prepare(
        `
        UPDATE publication_listings
        SET publication_status = ?,
            publication_error_code = ?,
            publication_updated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND desired_status = ?
        `
      )
      .bind(delivery.publicationStatus, delivery.errorCode, job.listingId, job.desiredStatus)
  ]);
  return {
    delivery,
    jobId,
    publicationStatus: delivery.publicationStatus,
    state: "failed"
  };
}

export async function processPublicationPublicationOutbox(
  db: D1Database,
  env: PublicationPublicationEnv,
  options: {
    limit?: number;
    clock?: () => Date;
    fetch?: typeof fetch;
    randomUUID?: () => string;
  } = {}
) {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 20)));
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const rows = await db
    .prepare(
      `
      SELECT id
      FROM publication_publication_outbox
      WHERE (state IN ('pending', 'failed') AND next_attempt_at <= ?)
         OR (state = 'processing' AND lease_expires_at <= ?)
      ORDER BY created_at, id
      LIMIT ?
      `
    )
    .bind(now, now, limit)
    .all<{ id: string }>();
  const results: PublicationPublicationProcessingResult[] = [];
  for (const row of rows.results ?? []) {
    results.push(await processPublicationPublicationJob(db, env, row.id, options));
  }
  return results;
}

export async function retryPublicationPublication(
  db: D1Database,
  listingId: string
) {
  const job = await db
    .prepare(
      `
      SELECT id
      FROM publication_publication_outbox
      WHERE listing_id = ?
        AND state IN ('pending', 'failed')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      `
    )
    .bind(listingId)
    .first<{ id: string }>();
  if (!job) {
    return undefined;
  }
  const result = await db
    .prepare(
      `
      UPDATE publication_publication_outbox
      SET state = 'pending',
          next_attempt_at = CURRENT_TIMESTAMP,
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
    .bind(job.id)
    .run();
  return readD1Changes(result) > 0 ? job.id : undefined;
}

export async function readPublicationPublicationHealth(db: D1Database) {
  const rows = await db
    .prepare(
      `
      SELECT
        state,
        COUNT(*) AS count,
        MIN(created_at) AS oldestCreatedAt
      FROM publication_publication_outbox
      WHERE state IN ('pending', 'processing', 'failed')
      GROUP BY state
      ORDER BY state
      `
    )
    .all<{ count: number; oldestCreatedAt?: string; state: string }>();
  return rows.results ?? [];
}

async function readPublicationPublicationJob(db: D1Database, jobId: string) {
  return db
    .prepare(
      `
      SELECT
        id,
        listing_id AS listingId,
        target_kind AS targetKind,
        target_id AS targetId,
        desired_status AS desiredStatus,
        endpoint_path AS endpointPath,
        payload_json AS payloadJson,
        state,
        attempt_count AS attemptCount,
        last_request_id AS lastRequestId
      FROM publication_publication_outbox
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(jobId)
    .first<PublicationPublicationOutboxRow>();
}

function parsePublicationPublicationProjection(value: string): PublicationPublicationProjection | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const kind = parsed.kind;
    const targetId = typeof parsed.targetId === "string" ? parsed.targetId : "";
    const endpointPath = parsed.endpointPath;
    const payload = parsed.payload;
    if (!targetId || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    if (kind === "none" && endpointPath === "") {
      const reason = (payload as Record<string, unknown>).reason;
      if (reason === "app_not_found" || reason === "workspace_auth_disabled" || reason === "resource_not_required") {
        return { endpointPath: "", kind, payload: { reason }, targetId };
      }
      return undefined;
    }
    if (
      (kind === "app" && endpointPath === "/v1/admin/apps")
      || (kind === "resource" && endpointPath === "/v1/admin/resources")
    ) {
      return {
        endpointPath,
        kind,
        payload: payload as Record<string, unknown>,
        targetId
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function markPublicationPublicationJobSuperseded(db: D1Database, jobId: string) {
  await db
    .prepare(
      `
      UPDATE publication_publication_outbox
      SET state = 'superseded',
          lease_token = NULL,
          lease_expires_at = NULL,
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `
    )
    .bind(jobId)
    .run();
}

function retryDelaySeconds(attemptCount: number) {
  return Math.min(3600, 5 * (2 ** Math.max(0, Math.min(attemptCount - 1, 10))));
}

function sanitizeRequestId(value: unknown) {
  const requestId = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:/-]{1,128}$/.test(requestId) ? requestId : "";
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readD1Changes(result: D1Result<unknown>) {
  const changes = Number(result.meta?.changes ?? 0);
  return Number.isFinite(changes) ? changes : 0;
}
