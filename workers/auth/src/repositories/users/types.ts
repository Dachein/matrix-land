import type { WorkspaceUser } from "../../types.ts";

// Employee persistence and status types.
export type AuthUserRow = {
  department_id: string | null;
  department_name: string;
  department_path_json: string;
  email: string;
  id: string;
  job_title: string;
  name: string;
  provider: string | null;
  provider_subject: string | null;
  role: string;
  source: string;
  status: string;
  team_id: string | null;
  team_name: string;
  team_path_json: string;
};

export type AuthUserListRow = AuthUserRow & {
  created_at: string;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
};

export type UserSnapshotInput = WorkspaceUser & {
  departmentName?: string;
  confirmedUserId?: string;
  allowUninvitedLogin?: boolean;
  provider?: string;
  providerSubject?: string;
  source?: string;
  teamName?: string;
};

export type ListAuthUsersInput = {
  departmentId?: string;
  includeDescendants?: boolean;
  limit?: number;
  q?: string;
  statuses?: string[];
};

export const AUTH_USER_STATUSES = ["active", "inactive", "invited", "suspended"] as const;

export type AuthUserStatus = typeof AUTH_USER_STATUSES[number];
