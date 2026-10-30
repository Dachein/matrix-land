import {
  clientBasicAuthHeader,
  WorkspaceAuthSdkError,
  normalizeAuthConfig,
  type AuthUser,
  type WorkspaceAuthFetch
} from "./types.ts";

export type WorkspaceDirectoryConfig = {
  appId: string;
  appSecret: string;
  authOrigin: string;
  fetcher?: WorkspaceAuthFetch;
};

export type WorkspaceDirectoryDepartment = {
  externalId?: string;
  id: string;
  name: string;
  parentId?: string;
  path: string[];
  status: "active";
};

export type WorkspaceDirectoryPerson = Pick<
  AuthUser,
  "department" | "departmentId" | "departmentPath" | "email" | "id" | "jobTitle" | "name" | "team" | "teamId" | "teamPath"
>;

export type WorkspaceDirectoryListOptions = {
  limit?: number;
  q?: string;
};

export type WorkspaceDirectoryPeopleOptions = WorkspaceDirectoryListOptions & {
  departmentId?: string;
  includeDescendants?: boolean;
};

export type WorkspaceDirectoryReadScope = "app" | "company";

export type WorkspaceDirectoryDepartmentList = {
  appId: string;
  count: number;
  directoryReadScope: WorkspaceDirectoryReadScope;
  departments: WorkspaceDirectoryDepartment[];
  hasMore: boolean;
  policyFiltered: boolean;
  requestId?: string;
};

export type WorkspaceDirectoryPeopleList = {
  appId: string;
  count: number;
  directoryReadScope: WorkspaceDirectoryReadScope;
  hasMore: boolean;
  people: WorkspaceDirectoryPerson[];
  policyFiltered: boolean;
  requestId?: string;
};

export type WorkspaceDirectoryPersonResult = {
  appId: string;
  directoryReadScope: WorkspaceDirectoryReadScope;
  person: WorkspaceDirectoryPerson;
  policyFiltered: boolean;
  requestId?: string;
};

export type WorkspaceDirectoryAccessCheck = {
  allowed: boolean;
  appId: string;
  decision: "allow" | "deny";
  policyVersion: string;
  reason: string;
  requestId?: string;
  systemRolePolicyVersion?: string;
  systemRoles: string[];
  user: WorkspaceDirectoryPerson;
};

type NormalizedDirectoryConfig = {
  appId: string;
  appSecret: string;
  authOrigin: string;
  fetcher: WorkspaceAuthFetch;
};

/**
 * Server-only client for the Workspace organization directory. The App's independently
 * configured directoryReadScope controls whether results use App admission or the
 * active company directory; checkAccess always continues to evaluate App admission.
 * Never construct this class in browser code because it uses the App client secret.
 */
export class WorkspaceAuthDirectory {
  private readonly config: NormalizedDirectoryConfig;

  constructor(config: WorkspaceDirectoryConfig) {
    const normalized = normalizeAuthConfig({
      appSecret: config.appSecret,
      authOrigin: config.authOrigin,
      clientId: config.appId,
      fetcher: config.fetcher
    });
    const appSecret = config.appSecret.trim();
    if (!appSecret) {
      throw new WorkspaceAuthSdkError("missing_app_secret");
    }
    this.config = {
      appId: normalized.clientId,
      appSecret,
      authOrigin: normalized.authOrigin,
      fetcher: normalized.fetcher
    };
  }

  listDepartments(options: WorkspaceDirectoryListOptions = {}) {
    return this.get<WorkspaceDirectoryDepartmentList>("/v1/app-directory/departments", options);
  }

  listPeople(options: WorkspaceDirectoryPeopleOptions = {}) {
    return this.get<WorkspaceDirectoryPeopleList>("/v1/app-directory/people", options);
  }

  getPerson(userId: string) {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw new WorkspaceAuthSdkError("missing_user_id");
    }
    return this.request<WorkspaceDirectoryPersonResult>(
      `/v1/app-directory/people/${encodeURIComponent(normalizedUserId)}`
    );
  }

  checkAccess(userId: string) {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw new WorkspaceAuthSdkError("missing_user_id");
    }
    return this.request<WorkspaceDirectoryAccessCheck>("/v1/app-directory/access/check", {
      body: JSON.stringify({ userId: normalizedUserId }),
      method: "POST"
    });
  }

  private get<T>(path: string, options: WorkspaceDirectoryPeopleOptions) {
    const url = new URL(path, this.config.authOrigin);
    if (options.q?.trim()) url.searchParams.set("q", options.q.trim());
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.departmentId?.trim()) url.searchParams.set("departmentId", options.departmentId.trim());
    if (options.includeDescendants !== undefined) {
      url.searchParams.set("includeDescendants", String(options.includeDescendants));
    }
    return this.request<T>(url.pathname + url.search);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", clientBasicAuthHeader(this.config.appId, this.config.appSecret));
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await this.config.fetcher(`${this.config.authOrigin}${path}`, { ...init, headers });
    const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok) {
      const code = typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.code === "string" ? payload.code : "auth_directory_request_failed";
      throw new WorkspaceAuthSdkError(code, code, response.status, payload);
    }
    return payload as T;
  }
}

export type DepartmentAccessOptions = {
  includeDescendants?: boolean;
};

/** Checks immutable Workspace department ids/path; display names are never authorization inputs. */
export function hasDepartmentAccess(
  user: Pick<AuthUser, "departmentId" | "departmentPath">,
  allowedDepartmentIds: string[],
  options: DepartmentAccessOptions = {}
) {
  const allowed = new Set(allowedDepartmentIds.map(normalizeId).filter(Boolean));
  if (allowed.size === 0) return false;
  const currentDepartment = normalizeId(user.departmentId);
  if (options.includeDescendants === false) {
    return Boolean(currentDepartment && allowed.has(currentDepartment));
  }
  const lineage = new Set([
    currentDepartment,
    ...(user.departmentPath ?? []).map(normalizeId)
  ].filter(Boolean));
  return Array.from(allowed).some((departmentId) => lineage.has(departmentId));
}

export function requireDepartmentAccess(
  user: Pick<AuthUser, "departmentId" | "departmentPath">,
  allowedDepartmentIds: string[],
  options: DepartmentAccessOptions = {}
) {
  if (!hasDepartmentAccess(user, allowedDepartmentIds, options)) {
    throw new WorkspaceAuthSdkError("department_access_denied", "Department access denied", 403, {
      allowedDepartmentIds,
      departmentId: user.departmentId
    });
  }
}

function normalizeId(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}
