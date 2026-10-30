import { loadRuntimeDefinition } from "./controlPlane.ts";
import { concludeTask, readTask } from "./storage.ts";
import { executeConfiguredTask } from "./taskExecutor.ts";
import { RuntimeHttpError, type RuntimeEnv, type RuntimeMode, type RuntimePrincipal } from "./types.ts";

type BackgroundTask = {
  mateId: string;
  taskId: string;
  mode: RuntimeMode;
  principal: RuntimePrincipal;
  started?: boolean;
};

const JOB_KEY = "task";
// A watchdog survives an isolate restart. Interrupted tool execution must not
// be replayed automatically, since a tool may already have applied its effect.
const WATCHDOG_MS = 660_000;

export async function enqueueBackgroundTask(env: RuntimeEnv, job: BackgroundTask) {
  const namespace = env.MATE_TASK_RUNNER;
  if (!namespace) throw new RuntimeHttpError(503, "background_task_runner_not_configured");
  const id = namespace.idFromName(JSON.stringify([job.mateId, job.principal.userId, job.mode, job.taskId]));
  const response = await namespace.get(id).fetch(new Request("https://task-runner.internal/enqueue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job)
  }));
  if (!response.ok) throw new RuntimeHttpError(503, "background_task_enqueue_failed");
}

/** One durable alarm per Task; admission is only through the authenticated Runtime. */
export class MateTaskRunner {
  private ctx: DurableObjectState;
  private env: RuntimeEnv;

  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/enqueue") {
      return new Response(null, { status: 404 });
    }
    const job = await request.json() as BackgroundTask;
    await this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.ctx.storage.get<BackgroundTask>(JOB_KEY);
      if (!existing) await this.ctx.storage.put(JOB_KEY, job);
      // Retrying admission never replaces an existing execution/watchdog alarm.
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + 100);
    });
    return new Response(null, { status: 202 });
  }

  async alarm() {
    const job = await this.ctx.storage.get<BackgroundTask>(JOB_KEY);
    if (!job) return;
    const { mateId, taskId, mode, principal } = job;
    const task = await readTask(this.env.RUNTIME_DB, mateId, principal, mode, taskId);
    if (task.status === "running" && job.started) {
      await this.fail(job, "background_task_interrupted");
    } else if (task.status === "queued") {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
      try {
        // Recheck invocation access and the active Release when the alarm runs.
        const definition = await loadRuntimeDefinition(this.env, principal, mateId, mode);
        await this.ctx.storage.put(JOB_KEY, { ...job, started: true });
        await executeConfiguredTask(this.env, definition, principal, mode, taskId);
      } catch (error) {
        if (error instanceof RuntimeHttpError && error.code === "thread_busy") {
          await this.ctx.storage.put(JOB_KEY, { ...job, started: false });
          await this.ctx.storage.setAlarm(Date.now() + 2_000);
          return;
        }
        const current = await readTask(this.env.RUNTIME_DB, mateId, principal, mode, taskId);
        if ((current.status === "queued" || current.status === "running")
          && !(error instanceof RuntimeHttpError && error.code === "task_not_queued")) {
          await this.fail(job, error instanceof RuntimeHttpError ? error.code : "background_task_execution_failed");
        }
      }
    }
    // Completed/failed/cancelled/waiting-for-approval Tasks are never replayed.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete(JOB_KEY);
  }

  private async fail(job: BackgroundTask, code: string) {
    await concludeTask(this.env.RUNTIME_DB, job.mateId, job.principal.userId, job.mode, job.taskId, {
      outcome: "failed", errorCode: code, summary: `Task failed (${code}).`,
      actions: [], artifacts: [], failures: [{ code }], followUps: [], pendingApprovals: []
    });
  }
}
