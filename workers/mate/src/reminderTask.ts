import { sendMateProactiveEmail } from "./emailDelivery.ts";
import { attachEmailThreadTask, recordOutboundEmail, setReminderThreadCode } from "./inboxStorage.ts";
import { readWorkThread } from "./workThreads.ts";
import { executeConfiguredTask } from "./taskExecutor.ts";
import { readTask } from "./storage.ts";
import { RuntimeHttpError, type RuntimeDefinition, type RuntimeEnv, type RuntimePrincipal } from "./types.ts";

/** A reminder is a timed Agent invocation plus result delivery. */
export async function executeReminderTask(
  env: RuntimeEnv, definition: RuntimeDefinition, principal: RuntimePrincipal, taskId: string,
  reminder: { deliverEmail?: boolean; id: string; threadCode?: string; title: string }
) {
  let result: Awaited<ReturnType<typeof executeConfiguredTask>>;
  try { result=await executeConfiguredTask(env,definition,principal,"live",taskId); }
  catch(error) {
    const task=await readTask(env.RUNTIME_DB,definition.mate.id,principal,"live",taskId);
    if(task.status!=="failed") throw error;
    result={task};
  }
  const task = result.task as Record<string, any>;
  const thread = await readWorkThread(env.RUNTIME_DB,{mateId:definition.mate.id,userId:principal.userId,mode:"live"},task.threadId);
  await attachEmailThreadTask(env.RUNTIME_DB, definition.mate.id, principal.userId, thread.threadCode, taskId);
  if (reminder.threadCode !== thread.threadCode) await setReminderThreadCode(env.RUNTIME_DB, definition.mate.id, principal.userId, reminder.id, thread.threadCode);
  let delivery:{status:string}|undefined;
  if (reminder.deliverEmail !== false && principal.email) {
    try { delivery=await sendMateProactiveEmail(env,definition,principal,{
      body:String(task.conclusion?.summary || reminder.title),subject:thread.title,taskId,threadCode:thread.threadCode,to:principal.email
    }); }
    catch(error) {
      await recordOutboundEmail(env.RUNTIME_DB,{mateId:definition.mate.id,userId:principal.userId,taskId,threadCode:thread.threadCode,
        envelopeFrom:definition.mate.workEmail || "",envelopeTo:principal.email,subject:thread.title,messageDigest:`receipt_configuration_${taskId}`,status:"failed"});
      delivery={status:"failed"};
    }
  }
  if(task.status==="failed") throw new RuntimeHttpError(502,"scheduled_task_failed");
  return {...result,...(delivery ? {delivery} : {})};
}
