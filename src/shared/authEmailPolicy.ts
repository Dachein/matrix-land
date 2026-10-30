export type AuthEmailPolicyMode = "open" | "company_email_only";

export type AuthEmailPolicy = {
  allowedDomains: string[];
  mode: AuthEmailPolicyMode;
  updatedAt: string;
  updatedByUserId: string | null;
};

type EmailPolicyDatabase = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

type EmailPolicyRow = {
  allowed_domains_json: string;
  mode: string;
  updated_at: string;
  updated_by_user_id: string | null;
};

export async function readAuthEmailPolicy(database: EmailPolicyDatabase): Promise<AuthEmailPolicy> {
  const row = await database.prepare(`
    SELECT mode, allowed_domains_json, updated_at, updated_by_user_id
    FROM auth_login_email_policy WHERE id = 1 LIMIT 1
  `).bind().first<EmailPolicyRow>();

  if (!row) throw new Error("auth_email_policy_not_configured");

  return {
    allowedDomains: normalizeEmailDomains(parseDomains(row.allowed_domains_json)),
    mode: row.mode === "open" ? "open" : "company_email_only",
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id
  };
}

export async function updateAuthEmailPolicy(
  database: EmailPolicyDatabase,
  policy: { allowedDomains: string[]; mode: AuthEmailPolicyMode; updatedByUserId: string }
) {
  await database.prepare(`
    INSERT INTO auth_login_email_policy (id, mode, allowed_domains_json, updated_by_user_id, updated_at)
    VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      mode = excluded.mode,
      allowed_domains_json = excluded.allowed_domains_json,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = CURRENT_TIMESTAMP
  `).bind(policy.mode, JSON.stringify(policy.allowedDomains), policy.updatedByUserId).run();
  return readAuthEmailPolicy(database);
}

export function isEmailAllowedByPolicy(policy: Pick<AuthEmailPolicy, "allowedDomains" | "mode">, email: unknown) {
  if (policy.mode === "open") return true;
  const normalizedEmail = normalizeEmailAddress(email);
  const separator = normalizedEmail.lastIndexOf("@");
  return separator > 0 && policy.allowedDomains.includes(normalizedEmail.slice(separator + 1));
}

export function normalizeEmailDomains(value: unknown): string[] {
  const input = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,;]+/)
      : [];
  const normalized = input
    .map((item) => String(item ?? "").trim().toLowerCase().replace(/^@/, ""))
    .filter((domain) => isValidEmailDomain(domain));
  return [...new Set(normalized)].sort();
}

export function isValidEmailDomain(value: string) {
  if (!value || value.length > 253 || value.startsWith(".") || value.endsWith(".")) return false;
  return value.split(".").every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

export function normalizeEmailAddress(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^@\s]+@[^@\s]+$/.test(email) ? email : "";
}

function parseDomains(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
