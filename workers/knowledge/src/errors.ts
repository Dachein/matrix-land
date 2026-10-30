export function safeErrorName(error: unknown) {
  if (error instanceof Error) {
    return error.name || "Error";
  }
  return typeof error;
}

export function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "";
}
