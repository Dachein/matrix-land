export type ProfileOrgSource = {
  department?: string;
  team?: string;
};

export function profileOrgDisplay(source: ProfileOrgSource) {
  const parts = (source.department ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    department: parts.join(" / "),
    fullPath: parts.join(" / "),
    team: ""
  };
}
