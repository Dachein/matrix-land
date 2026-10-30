import type { MateModelPolicy } from "./mate.ts";

export const WORKSPACE_MATE_DEEPSEEK_FLASH_MODEL = "tencent-deepseek-v4.1-flash";
export const WORKSPACE_MATE_DEFAULT_MODELS = [
  "cf-openai-gpt-6-luna",
  "cf-anthropic-claude-haiku-5.5",
  WORKSPACE_MATE_DEEPSEEK_FLASH_MODEL
] as const;
/** Upgrade inherited defaults only; custom models/defaults remain owner-controlled. */
export function upgradedDefaultMateModelPolicy(policy: MateModelPolicy): MateModelPolicy | undefined {
  const inherited = new Set<string>(WORKSPACE_MATE_DEFAULT_MODELS.slice(0, 2));
  if (policy?.defaultModel !== WORKSPACE_MATE_DEFAULT_MODELS[0] || !Array.isArray(policy.allowedModels)
    || !policy.allowedModels.includes(WORKSPACE_MATE_DEFAULT_MODELS[0])
    || !policy.allowedModels.every(model => inherited.has(model))) return undefined;
  return { ...policy, allowUserSelection: true, allowedModels: [...WORKSPACE_MATE_DEFAULT_MODELS] };
}
