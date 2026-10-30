-- Preserve the authenticated email used for each committed Knowledge mutation.
-- Existing rows remain readable and continue to fall back to actor_user_id.
ALTER TABLE knowledge_change_sets
  ADD COLUMN actor_email TEXT NOT NULL DEFAULT '';
