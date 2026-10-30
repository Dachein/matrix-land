// Retired deployment compatibility entry. The live Worker owns this job.
import { runModelHealthCheck } from "../../gateway/src/jobs/modelHealth.ts";
import type { Env } from "../../gateway/src/types.ts";
export * from "../../gateway/src/jobs/modelHealth.ts";

export default {
  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(runModelHealthCheck(env, new Date(controller.scheduledTime)));
  }
};
