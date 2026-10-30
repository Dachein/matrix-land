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

export function coverPalette(hash: number) {
  const palettes = [
    { a: "var(--brand-primary-soft)", b: "var(--brand-primary-200)", c: "var(--brand-primary)", ink: "var(--brand-primary-ink)" },
    { a: "#f5fff0", b: "#e6ffd4", c: "#6fb300", ink: "#17220f" },
    { a: "#fff6ed", b: "#ffe1c4", c: "#ff8a2a", ink: "#2f1907" },
    { a: "#f6f3ff", b: "#e7dfff", c: "#7c5cff", ink: "#1d1638" },
    { a: "#ecfbff", b: "#d0f3f8", c: "#18b7c8", ink: "#082c32" },
    { a: "#fff2f0", b: "#ffd9d3", c: "#d84a3a", ink: "#351512" }
  ];

  return palettes[hash % palettes.length];
}

export function personPalette(hash: number) {
  const palettes = [
    { a: "var(--brand-primary)", b: "var(--brand-primary-strong)", ink: "#ffffff" },
    { a: "#b8ff3d", b: "#18b7c8", ink: "#111318" },
    { a: "#ff8a2a", b: "#ffcf5a", ink: "#111318" },
    { a: "#7c5cff", b: "var(--brand-primary)", ink: "#ffffff" },
    { a: "#111318", b: "#626a78", ink: "#ffffff" }
  ];

  return palettes[hash % palettes.length];
}
