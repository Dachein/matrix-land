export const SKILL_PRODUCT_KINDS = ["vanilla", "knowledge", "app"] as const;

export type SkillProductKind = typeof SKILL_PRODUCT_KINDS[number];
export type WorkspaceSkillKind = SkillProductKind;

export type SkillStandardAction =
  | "handbook.read"
  | "package.download"
  | "search"
  | "grep"
  | "file.read"
  | "api.call";

export const VANILLA_SKILL_ACTIONS: SkillStandardAction[] = ["handbook.read", "package.download"];
export const KNOWLEDGE_SKILL_ACTIONS: SkillStandardAction[] = ["handbook.read", "search", "grep", "file.read"];
export const APP_SKILL_ACTIONS: SkillStandardAction[] = ["handbook.read", "api.call"];

export function normalizeSkillProductKind(value: unknown): SkillProductKind {
  const kind = String(value ?? "").trim().toLowerCase();
  if (kind === "knowledge" || kind === "app" || kind === "vanilla") {
    return kind;
  }
  return "vanilla";
}

export function skillActionsForKind(kind: SkillProductKind): SkillStandardAction[] {
  if (kind === "knowledge") {
    return [...KNOWLEDGE_SKILL_ACTIONS];
  }
  if (kind === "app") {
    return [...APP_SKILL_ACTIONS];
  }
  return [...VANILLA_SKILL_ACTIONS];
}
