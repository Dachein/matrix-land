import { configuredServiceUrl } from "../../../../src/shared/requiredConfiguration.ts";
import { WorkspaceMailProvisioner } from "../../../../sdk/mail/index.ts";
import { workspaceMailRequest } from "../../../../src/shared/workspaceMailClient.ts";
import { encryptSecretValue, decryptSecretValue } from "../core/auth";
import { HttpError, type Env, type Principal } from "../core/types";
import { randomToken } from "../core/utils";
import type { AppsAppSecretRow } from "../db/rows";

/** One app grant, shared by all versions of that app; never a platform signing key. */
export async function syncAppMail(
  env: Env,
  principal: Principal,
  app: { id: string; org_id: string; name: string; owner_user_id: string;status?:string },
) {
  if (!env.WORKSPACE_MAIL) {
    if (env.DEV_AUTH_BYPASS === "1") return;
    throw new HttpError(503, "workspace_mail_service_not_configured");
  }
  const resources = (
    await env.APPS_DB.prepare(
      "SELECT type,resource_name FROM apps_app_resources WHERE app_id=? AND type IN ('email_sending','email_routing')",
    )
      .bind(app.id)
      .all<{ type: string; resource_name: string }>()
  ).results;
  const receive = resources.some((r) => r.type === "email_routing"),
    send = resources.some((r) => r.type === "email_sending");
  const old = await env.APPS_DB.prepare(
    "SELECT * FROM apps_app_secrets WHERE app_id=? AND environment='production' AND name='WORKSPACE_MAIL_TOKEN'",
  )
    .bind(app.id)
    .first<AppsAppSecretRow>();
  const token =
    old?.cipher_text && old.cipher_iv
      ? await decryptSecretValue(env, {
          algorithm: old.algorithm,
          cipherIv: old.cipher_iv,
          cipherText: old.cipher_text,
        })
      : `fmail_${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const sender = await env.APPS_DB.prepare(
    "SELECT value FROM apps_app_env_vars WHERE app_id=? AND name='WORKSPACE_EMAIL_FROM' AND environment='production' AND target='runtime'",
  )
    .bind(app.id)
    .first<{ value: string }>();
  const trigger = await env.APPS_DB.prepare("SELECT value FROM apps_app_env_vars WHERE app_id=? AND name='WORKSPACE_MAIL_TRIGGER_ENABLED' AND environment='production' AND target='runtime'").bind(app.id).first<{value:string}>();
  let response: Response = new Response(null, { status: 503 });
  const client = new WorkspaceMailProvisioner(async (path, body) => {
    response = await workspaceMailRequest(
      env,
      {
        userId: app.owner_user_id,
        orgId: app.org_id,
        appId: app.id,
        scopes: ["mail:app-provision"],
      },
      path,
      body,
    );
    return response.clone().json();
  });
  await client.configureApp({
    appId: app.id,
    name: app.name,
    token,
    receive,
    send,
    triggerEnabled: receive && trigger?.value === "1",
    inbox: resources.find((r) => r.type === "email_routing")?.resource_name,
    sender: sender?.value,
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) {
    await env.APPS_DB.prepare(
      "UPDATE apps_app_resources SET status='failed' WHERE app_id=? AND type IN ('email_sending','email_routing')",
    )
      .bind(app.id)
      .run();
    throw new HttpError(
      response.status,
      payload.error || "app_mailbox_provisioning_failed",
    );
  }
  await env.APPS_DB.prepare(
    "UPDATE apps_app_resources SET status='ready' WHERE app_id=? AND type IN ('email_sending','email_routing')",
  )
    .bind(app.id)
    .run();
  const now = new Date().toISOString();
  if (!receive && !send) {
    await env.APPS_DB.batch([
      env.APPS_DB.prepare(
        "DELETE FROM apps_app_secrets WHERE app_id=? AND name='WORKSPACE_MAIL_TOKEN'",
      ).bind(app.id),
      env.APPS_DB.prepare(
        "DELETE FROM apps_app_env_vars WHERE app_id=? AND name='WORKSPACE_MAIL_ENDPOINT'",
      ).bind(app.id),
    ]);
    return;
  }
  // Provision the SDK without breaking the already-published source's native EMAIL calls.
  // The app author clears this flag after deploying the SDK integration.
  if(!old && app.status==='published')await env.APPS_DB.prepare(`INSERT INTO apps_app_env_vars(id,app_id,org_id,name,target,environment,value,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'WORKSPACE_MAIL_LEGACY_NATIVE_EMAIL','runtime','production','1',?,?,?,?) ON CONFLICT(app_id,environment,target,name) DO NOTHING`).bind(`env_${randomToken(12)}`,app.id,app.org_id,principal.sub,principal.sub,now,now).run();
  const encrypted = await encryptSecretValue(env, token);
  await env.APPS_DB.prepare(`INSERT INTO apps_app_env_vars(id,app_id,org_id,name,target,environment,value,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'WORKSPACE_APP_ID','runtime','production',?,?,?,?,?) ON CONFLICT(app_id,environment,target,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(`env_${randomToken(12)}`,app.id,app.org_id,app.id,principal.sub,principal.sub,now,now).run();
  await env.APPS_DB.batch([
    env.APPS_DB.prepare(
      `INSERT INTO apps_app_secrets(id,app_id,org_id,name,environment,description,required,status,cipher_text,cipher_iv,algorithm,configured_by,configured_at,declared_by,created_at,updated_at) VALUES(?,?,?,'WORKSPACE_MAIL_TOKEN','production','Workspace Mail app-scoped credential',1,'configured',?,?,?,?,?,?,?,?) ON CONFLICT(app_id,environment,name) DO UPDATE SET status='configured',cipher_text=excluded.cipher_text,cipher_iv=excluded.cipher_iv,algorithm=excluded.algorithm,configured_by=excluded.configured_by,configured_at=excluded.configured_at,updated_at=excluded.updated_at`,
    ).bind(
      `sec_${randomToken(12)}`,
      app.id,
      app.org_id,
      encrypted.cipherText,
      encrypted.cipherIv,
      encrypted.algorithm,
      principal.sub,
      now,
      principal.sub,
      now,
      now,
    ),
    env.APPS_DB.prepare(
      `INSERT INTO apps_app_env_vars(id,app_id,org_id,name,target,environment,value,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'WORKSPACE_MAIL_ENDPOINT','runtime','production',?,?,?,?,?) ON CONFLICT(app_id,environment,target,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    ).bind(
      `env_${randomToken(12)}`,
      app.id,
      app.org_id,
      configuredServiceUrl(env.WORKSPACE_MAIL_URL,"WORKSPACE_MAIL_URL"),
      principal.sub,
      principal.sub,
      now,
      now,
    ),
  ]);
}

export async function revokeAppMail(
  env: Env,
  app: { id: string; org_id: string; owner_user_id: string },
) {
  if (!env.WORKSPACE_MAIL) return;
  const response = await workspaceMailRequest(
    env,
    {
      userId: app.owner_user_id,
      orgId: app.org_id,
      appId: app.id,
      scopes: ["mail:app-provision"],
    },
    "/internal/apps/revoke",
    {},
  );
  if (!response.ok) throw new HttpError(503, "app_mail_revocation_failed");
}
