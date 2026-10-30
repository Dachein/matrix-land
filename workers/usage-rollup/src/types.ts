// The live scheduled Worker owns the environment contract.
export type { Env } from "../../gateway/src/types.ts";
export type LiteLlmAdminFetch = (path: string) => Promise<unknown>;
