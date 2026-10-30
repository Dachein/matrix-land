import { readString } from "../http.ts";

export function normalizeAppsUserIdentifier(value: unknown) {
  return readString(value)
    .trim()
    .toLowerCase();
}

export function legacyWorkspaceEmailIdentifier(value: string | undefined) {
  const email = normalizeAppsUserIdentifier(value);
  return email.endsWith("@example.invalid")
    ? email
    : "";
}
