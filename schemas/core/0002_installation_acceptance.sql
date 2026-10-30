CREATE TABLE workspace_acceptance (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('model-call','entra-login')),
 release TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','passed','failed')),
 started_at INTEGER NOT NULL,
 completed_at INTEGER,
 detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX workspace_acceptance_recent ON workspace_acceptance(kind,started_at DESC);
