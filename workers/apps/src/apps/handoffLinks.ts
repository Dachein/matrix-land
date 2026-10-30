import type { AppsApp } from "../../../../src/shared/types";
import { audit } from "../core/audit";
import { HttpError, type Env, type Principal } from "../core/types";
import { platformOrigin } from "../runtime/urls";

const HANDOFF_LINK_TTL_SECONDS = 900;
const HANDOFF_LINK_PREFIX = "lh_";

type HandoffLinkRow = {
  app_id: string;
  org_id: string;
  org_slug: string;
  actor_user_id: string;
  expires_at: string;
};

export async function issueHandoffLink(env: Env, principal: Principal, app: AppsApp) {
  await ensureHandoffLinksTable(env.APPS_DB);

  const token = `${HANDOFF_LINK_PREFIX}${randomBase64Url(18)}`;
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + HANDOFF_LINK_TTL_SECONDS * 1000);

  await env.APPS_DB
    .prepare(
      `
      INSERT INTO apps_handoff_links (
        id,
        token_hash,
        app_id,
        org_id,
        org_slug,
        actor_user_id,
        scopes_json,
        expires_at,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      `hl_${randomBase64Url(12)}`,
      tokenHash,
      app.id,
      principal.orgId,
      principal.orgSlug,
      principal.sub,
      JSON.stringify(["apps:apps:handoff"]),
      expiresAt.toISOString(),
      now.toISOString()
    )
    .run();

  await audit(env.APPS_DB, principal, "issued apps handoff link", "apps_app", app.id, {
    appId: app.id,
    scopes: ["apps:apps:handoff"],
    expiresAt: Math.floor(expiresAt.getTime() / 1000),
    tokenFormat: "opaque"
  });

  return {
    expiresAt: Math.floor(expiresAt.getTime() / 1000),
    scopes: ["apps:apps:handoff"],
    tokenType: "handoff",
    ttlSeconds: HANDOFF_LINK_TTL_SECONDS,
    url: `${platformOrigin(env)}/apps/${encodeURIComponent(app.id)}/handoff.md?h=${encodeURIComponent(token)}`
  };
}

export async function resolveHandoffLinkPrincipal(env: Env, token: string): Promise<Principal> {
  if (!token.startsWith(HANDOFF_LINK_PREFIX)) {
    throw new HttpError(401, "invalid_handoff_link");
  }

  await ensureHandoffLinksTable(env.APPS_DB);
  const tokenHash = await sha256Hex(token);
  const row = await env.APPS_DB
    .prepare(
      `
      SELECT app_id, org_id, org_slug, actor_user_id, expires_at
      FROM apps_handoff_links
      WHERE token_hash = ?
      LIMIT 1
      `
    )
    .bind(tokenHash)
    .first<HandoffLinkRow>();

  if (!row) {
    throw new HttpError(401, "invalid_handoff_link");
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new HttpError(401, "handoff_link_expired");
  }

  await env.APPS_DB
    .prepare("UPDATE apps_handoff_links SET last_used_at = ? WHERE token_hash = ?")
    .bind(new Date().toISOString(), tokenHash)
    .run();

  return {
    appId: row.app_id,
    orgId: row.org_id,
    orgSlug: row.org_slug,
    scopes: ["apps:apps:handoff"],
    sub: row.actor_user_id,
    tokenType: "apps_handoff"
  };
}

function ensureHandoffLinksTable(db: D1Database) {
  return db.batch([
    db.prepare(
      `
      CREATE TABLE IF NOT EXISTS apps_handoff_links (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        app_id TEXT NOT NULL REFERENCES apps_apps(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL,
        org_slug TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL DEFAULT '["apps:apps:handoff"]',
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        created_at TEXT NOT NULL
      )
      `
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_apps_handoff_links_app ON apps_handoff_links(app_id, expires_at)")
  ]);
}

function randomBase64Url(bytes: number) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
