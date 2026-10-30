// Bound transcript output without losing the source links needed by the UI.
// The model and its checkpoint retain the original tool result.
export function chatToolPreview(output: unknown, allowance: number): unknown {
  const serialized = JSON.stringify(output) ?? "null";
  if (serialized.length <= allowance) return output;
  const source = record(output);
  if (Array.isArray(source.results)) {
    const compact: Record<string, unknown> = { truncated: true, results: [] };
    for (const key of ["provider", "searchProvider", "query", "requestId", "count"]) {
      const value = source[key];
      if (typeof value === "string") compact[key] = value.slice(0, 500);
      else if (typeof value === "number" && Number.isFinite(value)) compact[key] = value;
    }
    const results = compact.results as Record<string, string>[];
    for (const entry of source.results.slice(0, 10)) {
      const result = record(entry);
      if (typeof result.url !== "string") continue;
      const item = { title: typeof result.title === "string" ? result.title.slice(0, 300) : "", url: result.url };
      results.push(item);
      if (JSON.stringify(compact).length > allowance) results.pop();
    }
    if (JSON.stringify(compact).length <= allowance) return compact;
  }
  const base = { truncated: true, preview: "" };
  if (JSON.stringify(base).length > allowance) return { truncated: true };
  let start = 0;
  let end = Math.min(serialized.length, allowance);
  while (start < end) {
    const middle = Math.ceil((start + end) / 2);
    if (JSON.stringify({ ...base, preview: serialized.slice(0, middle) }).length <= allowance) start = middle;
    else end = middle - 1;
  }
  return { ...base, preview: serialized.slice(0, start) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
