export interface D1ExportState {
  signedUrl: string;
  status: string;
  error: string;
  bookmark: string;
}

export function readD1ExportState(value: unknown): D1ExportState {
  const envelope = record(value);
  const payload = record(envelope.result);
  const completedResult = record(payload.result);

  return {
    signedUrl: text(completedResult.signed_url || payload.signed_url),
    status: text(payload.status),
    error: text(payload.error),
    bookmark: text(payload.at_bookmark || payload.current_bookmark || payload.bookmark)
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
