import { readOptionalString, readString } from "../values.ts";

export function profileDetailsFromRow(row: Record<string, unknown>) {
  const profileJson = profileJsonObject(row.profileJson);
  const departmentPath = readJsonStringList(row.departmentPathJson);
  const departmentId = readOptionalString(row.departmentId);

  return {
    department: readOptionalString(row.department),
    ...(departmentId ? { departmentId } : {}),
    ...(departmentPath.length > 0 ? { departmentPath } : {}),
    jobTitle: readOptionalString(row.jobTitle),
    bio: readOptionalString(profileJson.bio),
    location: readOptionalString(profileJson.location)
  };
}

export function profileJsonObject(value: unknown) {
  return readJsonObject(value);
}

function readJsonObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function readJsonStringList(value: unknown) {
  try {
    const parsed = JSON.parse(readString(value)) as unknown;
    return Array.isArray(parsed)
      ? parsed.map((item) => readString(item).trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}
