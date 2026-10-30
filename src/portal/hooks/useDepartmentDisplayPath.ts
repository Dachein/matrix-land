import { useEffect, useState } from "react";

type Department = { id: string; name: string };
type DepartmentUser = {
  departmentDisplayPath?: string;
  departmentPath?: string[];
};

export function formatDepartmentDisplayPath(user: DepartmentUser, departments: Department[]): string | undefined {
  const canonical = user.departmentDisplayPath?.trim();
  if (canonical) return canonical;

  const path = (user.departmentPath ?? []).filter(Boolean);
  if (path.length < 2) return undefined;
  const names = new Map(departments.map((department) => [department.id, department.name.trim()]));
  if (path.some((id) => !names.get(id))) return undefined;
  return path.slice(1).map((id) => names.get(id)).join("/");
}

export function useDepartmentDisplayPath(user: DepartmentUser): string | undefined {
  const [departments, setDepartments] = useState<Department[]>([]);
  const pathKey = (user.departmentPath ?? []).join("|");

  useEffect(() => {
    if (user.departmentDisplayPath || (user.departmentPath?.length ?? 0) < 2) return;
    const controller = new AbortController();
    void fetch("/api/users/departments", {
      headers: { Accept: "application/json" },
      signal: controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error("auth_departments_unavailable");
      const payload = await response.json() as { departments?: Department[] };
      if (!controller.signal.aborted) setDepartments(Array.isArray(payload.departments) ? payload.departments : []);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [pathKey, user.departmentDisplayPath]);

  return formatDepartmentDisplayPath(user, departments);
}
