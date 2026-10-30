import type { AccessTargetDepartment, AccessTargetUser } from "./accessTargets";

export type AccessTargetDirectory = {
  departments: AccessTargetDepartment[];
  users: AccessTargetUser[];
};

export async function loadAccessTargetDirectory(fetcher: typeof fetch = fetch): Promise<AccessTargetDirectory> {
  const responses = await Promise.all([
    fetcher("/api/users/directory?purpose=access&status=active&status=invited&limit=1000"),
    fetcher("/api/users/departments")
  ]);
  if (responses.some((response) => !response.ok)) throw new Error("access_targets_unavailable");
  const [people, organization] = await Promise.all(responses.map((response) => response.json())) as Array<Record<string, unknown>>;
  if (!people || !organization || !Array.isArray(people.users) || !Array.isArray(organization.departments)
    || people.users.length >= 1000 || organization.departments.length >= 1000
    || people.users.some((user: AccessTargetUser) => !user?.id || !user.email)
    || organization.departments.some((department: AccessTargetDepartment) => !department?.id || !department.name)) {
    throw new Error("access_targets_incomplete");
  }
  return { departments: organization.departments, users: people.users };
}
