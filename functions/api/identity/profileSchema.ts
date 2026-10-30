import { hasTableColumn } from "../persistence/schema.ts";

export type UserProfileColumns = {
  avatarUrl: boolean;
  departmentId: boolean;
  departmentPathJson: boolean;
};

export async function userProfileColumns(db: D1Database): Promise<UserProfileColumns> {
  return {
    avatarUrl: await hasTableColumn(db, "users", "avatar_url"),
    departmentId: await hasTableColumn(db, "user_identity_profiles", "department_id"),
    departmentPathJson: await hasTableColumn(db, "user_identity_profiles", "department_path_json")
  };
}

export async function hasUserRolesTable(db: D1Database) {
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_roles' LIMIT 1")
      .first<{ name: string }>();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}
