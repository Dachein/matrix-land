import { findOrCreateEmailThread, subjectWithThreadCode, threadCodeFromSubject } from "./inboxStorage.ts";
import { RuntimeHttpError, type RuntimeMode } from "./types.ts";

type Scope = { mateId: string; userId: string; mode: RuntimeMode };
export type WorkThread = { id: string; threadCode: string; mateCallId: string; title: string; kind: "task" | "schedule"; scheduleId?: string; createdAt: string; updatedAt: string; activeTaskId?: string };
const columns = `id,thread_code AS threadCode,title,kind,schedule_id AS scheduleId,created_at AS createdAt,updated_at AS updatedAt,active_task_id AS activeTaskId`;
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function canonicalThreadTitle(value: string) {
  return value.replace(/^(?:(?:re|fw|fwd):\s*)+/ig, "").replace(/\[[A-Z0-9_-]+[- ][A-Z0-9]{4}\]\s*/ig, "").replace(/\[[A-Z0-9]{4}\]\s*/ig, "").replace(/[\r\n]+/g, " ").trim().slice(0,160) || "未命名任务";
}
function decorate(row: Omit<WorkThread,"mateCallId">, mateId: string): WorkThread {
  return { ...row, mateCallId: row.threadCode.startsWith("LEGACY-") ? row.id : subjectWithThreadCode("",row.threadCode,mateId).split("]")[0].slice(1) };
}
function codeFromIdentifier(value: string, mateId: string) {
  return threadCodeFromSubject(value.startsWith("[") ? value : `[${value}]`,mateId);
}
export async function readWorkThread(db: D1Database, scope: Scope, identifier: string) {
  if (!identifier || identifier.length > 180) throw new RuntimeHttpError(400,"thread_id_invalid");
  const row = await db.prepare(`SELECT ${columns} FROM mate_work_threads WHERE mate_id=? AND user_id=? AND runtime_mode=? AND (id=? OR thread_code=?) LIMIT 1`)
    .bind(scope.mateId,scope.userId,scope.mode,identifier,codeFromIdentifier(identifier,scope.mateId)).first<Omit<WorkThread,"mateCallId">>();
  if (!row) throw new RuntimeHttpError(404,"thread_not_found");
  if(row.threadCode.startsWith("LEGACY-") && scope.mode==="live") {
    const alias=await findOrCreateEmailThread(db,{mateId:scope.mateId,userId:scope.userId,subject:row.title});
    await db.prepare(`UPDATE mate_work_threads SET thread_code=? WHERE id=? AND thread_code=?`).bind(alias.threadCode,row.id,row.threadCode).run();
    return readWorkThread(db,scope,row.id);
  }
  return decorate(row,scope.mateId);
}
export async function ensureWorkThread(db: D1Database, scope: Scope, input: { identifier?: string; title: string; scheduleId?: string; threadCode?: string }) {
  if (input.identifier) return readWorkThread(db,scope,input.identifier);
  if (input.scheduleId) {
    const row = await db.prepare(`SELECT ${columns} FROM mate_work_threads WHERE mate_id=? AND user_id=? AND runtime_mode=? AND schedule_id=?`)
      .bind(scope.mateId,scope.userId,scope.mode,input.scheduleId).first<Omit<WorkThread,"mateCallId">>();
    if (row) return readWorkThread(db,scope,row.id);
  }
  if (input.threadCode) {
    try { return await readWorkThread(db,scope,input.threadCode); }
    catch(error) { if (!(error instanceof RuntimeHttpError && error.code === "thread_not_found")) throw error; }
  }
  const title = canonicalThreadTitle(input.title);
  for (let attempt=0;attempt<32;attempt++) {
    const threadCode = scope.mode === "live"
      ? (await findOrCreateEmailThread(db,{ mateId:scope.mateId,userId:scope.userId,subject:title,requestedCode:input.threadCode })).threadCode
      : Array.from(crypto.getRandomValues(new Uint8Array(4)),byte=>alphabet[byte % alphabet.length]).join("");
    const id=`thread_${crypto.randomUUID()}`;
    const now=new Date().toISOString();
    try {
      await db.prepare(`INSERT INTO mate_work_threads(id,mate_id,user_id,runtime_mode,kind,thread_code,title,schedule_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .bind(id,scope.mateId,scope.userId,scope.mode,input.scheduleId ? "schedule" : "task",threadCode,title,input.scheduleId || null,now,now).run();
      return readWorkThread(db,scope,id);
    } catch(error) {
      if (!String(error).toLowerCase().includes("unique")) throw error;
      if (input.scheduleId) {
        const row=await db.prepare(`SELECT id FROM mate_work_threads WHERE mate_id=? AND user_id=? AND runtime_mode=? AND schedule_id=?`).bind(scope.mateId,scope.userId,scope.mode,input.scheduleId).first<{id:string}>();
        if (row) return readWorkThread(db,scope,row.id);
      }
      if (input.threadCode) return readWorkThread(db,scope,threadCode);
    }
  }
  throw new RuntimeHttpError(503,"thread_code_exhausted");
}
export async function currentThreadConclusion(db:D1Database,scope:Scope,conclusion:Record<string,any>) {
  const pending=Array.isArray(conclusion.pendingApprovals) ? conclusion.pendingApprovals : [];
  const ids=[...new Set(pending.map(item=>String(item.approvalId || "")).filter(Boolean))].slice(0,50);
  if(!ids.length) return conclusion;
  const rows=await db.prepare(`SELECT id,status FROM mate_approvals WHERE mate_id=? AND user_id=? AND runtime_mode=? AND id IN (${ids.map(()=>"?").join(",")})`)
    .bind(scope.mateId,scope.userId,scope.mode,...ids).all<{id:string;status:string}>();
  const states=new Map((rows.results || []).map(row=>[row.id,row.status]));
  return {...conclusion,pendingApprovals:pending.filter(item=>!states.has(item.approvalId) || states.get(item.approvalId)==="pending"),approvalDecisions:(rows.results || []).filter(row=>row.status!=="pending")};
}
export async function listWorkThreads(db:D1Database,scope:Scope,kind="task",cursor?:string|null) {
  if (kind!=="task" && kind!=="schedule") throw new RuntimeHttpError(400,"thread_kind_invalid");
  let after:{updatedAt:string;id:string}|undefined;
  if(cursor) { try { after=JSON.parse(cursor); if(!after || typeof after.updatedAt!=="string" || typeof after.id!=="string" || cursor.length>400) throw Error(); } catch { throw new RuntimeHttpError(400,"thread_cursor_invalid"); } }
  const rows=await db.prepare(`SELECT w.*,
      (SELECT instruction FROM mate_tasks t WHERE t.thread_id=w.id ORDER BY t.created_at ASC,t.rowid ASC LIMIT 1) AS initialInstruction,
      (SELECT channel FROM mate_tasks t WHERE t.thread_id=w.id ORDER BY t.created_at ASC,t.rowid ASC LIMIT 1) AS initialChannel,
      (SELECT status FROM mate_tasks t WHERE t.thread_id=w.id ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) AS latestStatus,
      (SELECT channel FROM mate_tasks t WHERE t.thread_id=w.id ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) AS latestChannel,
      (SELECT instruction FROM mate_tasks t WHERE t.thread_id=w.id ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) AS latestInstruction,
      (SELECT conclusion_json FROM mate_tasks t WHERE t.thread_id=w.id ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) AS latestConclusion,
      (SELECT count(*) FROM mate_tasks t WHERE t.thread_id=w.id) AS taskCount
    FROM mate_work_threads w WHERE mate_id=? AND user_id=? AND runtime_mode=? AND kind=? AND EXISTS(SELECT 1 FROM mate_tasks t WHERE t.thread_id=w.id)
    ${after ? "AND (updated_at < ? OR (updated_at=? AND id<?))" : ""} ORDER BY updated_at DESC,id DESC LIMIT 51`)
    .bind(scope.mateId,scope.userId,scope.mode,kind,...(after ? [after.updatedAt,after.updatedAt,after.id] : [])).all<Record<string,any>>();
  const page=(rows.results||[]).slice(0,50);
  const last=page.at(-1);
  return {threads:await Promise.all(page.map(async row=>{
    const conclusion=row.latestConclusion ? await currentThreadConclusion(db,scope,JSON.parse(row.latestConclusion)) : undefined;
    return {...await readWorkThread(db,scope,row.id),status:conclusion?.pendingApprovals?.length ? "waiting_for_approval" : row.latestStatus || "queued",channel:row.latestChannel,initialChannel:row.initialChannel,initialInstruction:row.initialInstruction,titleIsInstruction:row.initialChannel!=="email" && row.title===canonicalThreadTitle(row.initialInstruction || ""),preview:conclusion?.summary || row.latestInstruction,taskCount:row.taskCount};
  })),nextCursor:(rows.results?.length||0)>50 && last ? JSON.stringify({updatedAt:last.updated_at,id:last.id}) : null};
}
export async function findThreadByEmailReferences(db:D1Database,scope:Scope,references:string) {
  const ids=references.match(/<[^<>\s]{1,500}>/g)?.slice(-100).reverse() || [];
  for(const id of ids) {
    const row=await db.prepare(`SELECT thread_code AS code FROM mate_email_messages WHERE mate_id=? AND user_id=? AND external_message_id=? ORDER BY created_at DESC LIMIT 1`)
      .bind(scope.mateId,scope.userId,id).first<{code:string}>();
    if(row) return ensureWorkThread(db,scope,{threadCode:row.code,title:"Email reply"});
  }
}
export async function workThreadConversation(db:D1Database,scope:Scope,taskId:string,threadId?:string) {
  if(!threadId) return [];
  await readWorkThread(db,scope,threadId);
  // The entire record remains in storage. Bound the model context to recent turns.
  const rows=await db.prepare(`SELECT instruction,conclusion_json AS conclusion FROM mate_tasks WHERE mate_id=? AND user_id=? AND runtime_mode=? AND thread_id=? AND rowid<(SELECT rowid FROM mate_tasks WHERE mate_id=? AND user_id=? AND runtime_mode=? AND id=?) ORDER BY rowid DESC LIMIT 40`)
    .bind(scope.mateId,scope.userId,scope.mode,threadId,scope.mateId,scope.userId,scope.mode,taskId).all<{instruction:string;conclusion?:string}>();
  let budget=60_000;
  const turns:Array<{role:"user"|"assistant";content:string}>=[];
  for(const row of rows.results||[]) {
    const conclusion=row.conclusion ? await currentThreadConclusion(db,scope,JSON.parse(row.conclusion)) : undefined;
    const reply=conclusion ? `${conclusion.summary}\n${conclusion.approvalDecisions?.length ? `Approval records (verify tool outcome if needed): ${JSON.stringify(conclusion.approvalDecisions)}` : ""}\n${conclusion.artifacts?.length ? `Deliverables (metadata; verify contents with tools): ${JSON.stringify(conclusion.artifacts)}` : ""}` : "Execution has not concluded yet.";
    const request=row.instruction.slice(0,12000); const response=reply.slice(0,12000);
    if(budget<request.length+response.length) break;
    budget-=request.length+response.length;
    turns.unshift({role:"user",content:request},{role:"assistant",content:response});
  }
  return turns;
}
