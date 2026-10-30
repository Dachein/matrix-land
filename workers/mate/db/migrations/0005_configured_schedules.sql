PRAGMA foreign_keys = ON;

-- Release-managed schedules are still private reminders partitioned by
-- mateId x ownerUserId. These pointers let a newer immutable Release
-- update or pause its configured jobs without recognizing any named Mate.
ALTER TABLE mate_reminders ADD COLUMN managed_release_id TEXT;
ALTER TABLE mate_reminders ADD COLUMN managed_job_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mate_reminders_managed_job
  ON mate_reminders(mate_id, user_id, managed_job_id, status);
