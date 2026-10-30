export function sanitizeAllowedModels(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value
    .map((item) => readString(item).trim())
    .filter(Boolean)
  )).slice(0, 24);
}

export function normalizeGatewayUsagePurpose(value: unknown): "agent" | "app" {
  return value === "app" ? "app" : "agent";
}

export function readMoneyLimit(value: unknown) {
  const number = Number(value ?? 0);

  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }

  return Math.min(Math.round(number * 10000) / 10000, 1_000_000);
}

export function readPercentLimit(value: unknown) {
  const number = Number(value ?? 100);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 100;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
