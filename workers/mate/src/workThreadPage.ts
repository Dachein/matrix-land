import { taskFromRow } from "./storage.ts";
import { currentThreadConclusion, readWorkThread } from "./workThreads.ts";
import { RuntimeHttpError, type RuntimeMode } from "./types.ts";

export async function readWorkThreadPage(db:D1Database,scope:{mateId:string;userId:string;mode:RuntimeMode},identifier:string,cursor?:string|null) {
  const thread=await readWorkThread(db,scope,identifier);
  let before:number|undefined;
  if(cursor) { before=Number(cursor); if(!Number.isSafeInteger(before) || before<=0) throw new RuntimeHttpError(400,"thread_cursor_invalid"); }
  const rows=await db.prepare(`SELECT *,rowid AS position FROM mate_tasks WHERE mate_id=? AND user_id=? AND runtime_mode=? AND thread_id=? ${before ? "AND rowid<?" : ""} ORDER BY rowid DESC LIMIT 51`)
    .bind(scope.mateId,scope.userId,scope.mode,thread.id,...(before ? [before] : [])).all<any>();
  const page=(rows.results||[]).slice(0,50);
  const deliveries=scope.mode === "live" ? (await db.prepare(`SELECT task_id AS taskId,direction,status,subject,envelope_from AS fromEmail,envelope_to AS toEmail,created_at AS createdAt FROM mate_email_messages WHERE mate_id=? AND user_id=? AND thread_code=? AND task_id IN (${page.map(()=>"?").join(",") || "NULL"}) ORDER BY created_at DESC`)
    .bind(scope.mateId,scope.userId,thread.threadCode,...page.map(row=>row.id)).all()).results || [] : [];
  const tasks=await Promise.all(page.map(async row=>{
    const task=taskFromRow(row);
    return {...task,conclusion:task.conclusion ? await currentThreadConclusion(db,scope,task.conclusion as Record<string,any>) : undefined};
  }));
  return {thread,tasks,deliveries,nextCursor:(rows.results?.length||0)>50 ? String(page.at(-1)?.position) : null};
}
