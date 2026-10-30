import { handleMateRuntimeRequest } from "./index.ts";
import { runMailInboxTick } from "./mailTrigger.ts";
import { runMateScheduledTick } from "./scheduler.ts";
import type { RuntimeEnv } from "./types.ts";

export { MateChatAgent } from "./chatAgent.ts";
export { MateWeixinGateway } from "./weixinGateway.ts";
export { MateTaskRunner } from "./taskRunner.ts";

export default {
  fetch(request: Request, env: RuntimeEnv) {
    return handleMateRuntimeRequest(request, env);
  },
  scheduled(controller: ScheduledController, env: RuntimeEnv) {
    return Promise.all([controller.scheduledTime % 300_000 === 0 ? runMateScheduledTick(env, controller.scheduledTime) : Promise.resolve(),runMailInboxTick(env)]);
  }
};
