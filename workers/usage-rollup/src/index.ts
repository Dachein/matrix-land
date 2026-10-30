// Retired deployment compatibility entry. The live Worker owns this job.
import { runTokenUsageRollup } from "../../gateway/src/jobs/usageRollup.ts";
import type { Env } from "../../gateway/src/types.ts";
export * from "../../gateway/src/jobs/usageRollup.ts";

export default {
  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(runTokenUsageRollup(env, new Date(controller.scheduledTime)));
  }
};
