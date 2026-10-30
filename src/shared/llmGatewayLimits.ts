export const DEFAULT_LLM_GATEWAY_RPM_LIMIT = 60;
export const LEGACY_DEFAULT_LLM_GATEWAY_TPM_LIMIT = 120_000;
export const DEFAULT_LLM_GATEWAY_TPM_LIMIT = 2_000_000;
export const LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION = 2;

export function shouldRepairLlmGatewayTpmLimit(value: unknown, repairVersion?: unknown) {
  const tpmLimit = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(tpmLimit) || tpmLimit <= 0) {
    return true;
  }

  const currentRepairVersion = typeof repairVersion === "number"
    ? repairVersion
    : Number(repairVersion);

  return tpmLimit === LEGACY_DEFAULT_LLM_GATEWAY_TPM_LIMIT
    && (!Number.isFinite(currentRepairVersion)
      || currentRepairVersion < LLM_GATEWAY_RATE_LIMIT_REPAIR_VERSION);
}
