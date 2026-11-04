export function hashText(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

export function personInitials(value: string) {
  const parts = value
    .trim()
    .split(/[\s.@_-]+/)
    .filter(Boolean)
    .slice(0, 2);

  return (parts.map((part) => part[0]).join("") || "AI").toUpperCase();
}

export function coverInitials(value: string) {
  const parts = value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .slice(0, 2);

  return (parts.map((part) => part[0]).join("") || "AI").toUpperCase();
}

export function deriveCoverMarkers(title: string, description: string, category: string) {
  const stopWords = new Set(["with", "from", "into", "and", "the", "for", "this", "that", "internal"]);
  const words = `${category} ${title} ${description}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !stopWords.has(word));

  return Array.from(new Set(words)).slice(0, 3);
}

// Identity decoration is deterministic and uses semantic colors, including enterprise branding.
const identityTones = ["action", "accent", "info", "success", "warning", "data-violet"] as const;
export function coverPalette(hash: number) {
  const tone = identityTones[hash % identityTones.length];
  return {
    a: `color-mix(in srgb, var(--fw-color-${tone}) 7%, var(--fw-color-raised))`,
    b: `color-mix(in srgb, var(--fw-color-${tone}) 18%, var(--fw-color-raised))`,
    c: `var(--fw-color-${tone})`,
    ink: "var(--fw-color-text)"
  };
}

export function personPalette(hash: number) {
  const palette = coverPalette(hash);
  return { a: palette.a, b: palette.b, ink: palette.ink };
}
