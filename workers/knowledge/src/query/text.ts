export function readLimit(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

export function searchTerms(query: string) {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).map((term) => term.trim()).filter(Boolean);
  return terms.length > 0 ? Array.from(new Set(terms)) : [query.toLowerCase()];
}

export function scoreSearchText(value: string, terms: string[]) {
  const text = value.toLowerCase();
  return terms.reduce((score, term) => {
    let count = 0;
    let index = text.indexOf(term);
    while (index >= 0 && count < 20) {
      count += 1;
      index = text.indexOf(term, index + Math.max(term.length, 1));
    }
    return score + count;
  }, 0);
}

export function bestSnippet(value: string, terms: string[]) {
  const text = value.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const firstIndex = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstIndex - 90);
  const end = Math.min(text.length, firstIndex + 220);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

export function stripMarkup(value: string) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}
