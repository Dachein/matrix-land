export function normalizeSingleLink(value: string) {
  const link = value.trim().split(/\s+/)[0] ?? "";
  return link.length > 0 ? link : undefined;
}

export function parseTags(value: string) {
  return Array.from(new Set(value
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
  )).slice(0, 8);
}

export function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
