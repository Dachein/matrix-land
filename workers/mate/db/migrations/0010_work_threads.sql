-- A work Thread is stable across inbox channels; Tasks remain individual executions.
CREATE TABLE mate_work_threads (
  id TEXT NOT NULL PRIMARY KEY,
  mate_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK(runtime_mode IN ('live','preview')),
  kind TEXT NOT NULL CHECK(kind IN ('task','schedule')),
  thread_code TEXT NOT NULL,
  title TEXT NOT NULL,
  schedule_id TEXT,
  active_task_id TEXT,
  legacy_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(mate_id,runtime_mode,thread_code)
);
CREATE UNIQUE INDEX idx_work_thread_schedule ON mate_work_threads(mate_id,user_id,runtime_mode,schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX idx_work_thread_activity ON mate_work_threads(mate_id,user_id,runtime_mode,updated_at DESC,id DESC);
ALTER TABLE mate_tasks ADD COLUMN thread_id TEXT;
CREATE INDEX idx_task_thread ON mate_tasks(mate_id,user_id,runtime_mode,thread_id,created_at DESC);
ALTER TABLE mate_email_messages ADD COLUMN external_message_id TEXT;
CREATE INDEX idx_email_message_reference ON mate_email_messages(mate_id,user_id,external_message_id);

-- Preserve the identity of existing email exchanges and scheduled execution series.
INSERT INTO mate_work_threads(id,mate_id,user_id,runtime_mode,kind,thread_code,title,schedule_id,created_at,updated_at)
SELECT 'thread_' || lower(hex(randomblob(16))), e.mate_id,e.user_id,'live',
  CASE WHEN r.id IS NULL THEN 'task' ELSE 'schedule' END,e.thread_code,e.subject,r.id,e.created_at,e.updated_at
FROM mate_email_threads e LEFT JOIN mate_reminders r ON r.mate_id=e.mate_id AND r.user_id=e.user_id AND r.thread_code=e.thread_code;
UPDATE mate_tasks SET thread_id=(SELECT w.id FROM mate_work_threads w
  WHERE w.mate_id=mate_tasks.mate_id AND w.user_id=mate_tasks.user_id AND w.runtime_mode=mate_tasks.runtime_mode
  AND (w.thread_code=json_extract(mate_tasks.context_json,'$.threadCode') OR w.schedule_id=json_extract(mate_tasks.context_json,'$.reminderId')))
WHERE channel IN ('email','mate_call','schedule') AND json_valid(context_json);
-- Backfill legacy inbox chains using a stable grouping key, never title matching.
INSERT INTO mate_work_threads(id,mate_id,user_id,runtime_mode,kind,thread_code,title,schedule_id,legacy_key,created_at,updated_at)
SELECT 'thread_' || lower(hex(randomblob(16))),mate_id,user_id,runtime_mode,
  CASE WHEN channel='schedule' THEN 'schedule' ELSE 'task' END,
  'LEGACY-' || lower(hex(randomblob(8))),substr(instruction,1,160),
  CASE WHEN channel='schedule' THEN json_extract(context_json,'$.reminderId') ELSE NULL END,
  CASE WHEN channel='schedule' AND json_extract(context_json,'$.reminderId') IS NOT NULL
    THEN 'schedule:' || json_extract(context_json,'$.reminderId') ELSE 'root:' || root_task_id END,min(created_at),max(updated_at)
FROM mate_tasks WHERE thread_id IS NULL AND channel IN ('email','mate_call','schedule')
GROUP BY mate_id,user_id,runtime_mode,CASE WHEN channel='schedule' AND json_extract(context_json,'$.reminderId') IS NOT NULL
  THEN 'schedule:' || json_extract(context_json,'$.reminderId') ELSE 'root:' || root_task_id END;
UPDATE mate_tasks SET thread_id=(SELECT w.id FROM mate_work_threads w
  WHERE w.mate_id=mate_tasks.mate_id AND w.user_id=mate_tasks.user_id AND w.runtime_mode=mate_tasks.runtime_mode
  AND w.legacy_key=CASE WHEN mate_tasks.channel='schedule' AND json_extract(mate_tasks.context_json,'$.reminderId') IS NOT NULL
    THEN 'schedule:' || json_extract(mate_tasks.context_json,'$.reminderId') ELSE 'root:' || mate_tasks.root_task_id END)
WHERE thread_id IS NULL AND channel IN ('email','mate_call','schedule');
