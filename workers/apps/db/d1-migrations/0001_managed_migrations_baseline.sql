-- Wrangler-managed migration baseline for workspace-apps.
--
-- The production database already contains the schema changes preserved under
-- db/migrations/. Those files predate Wrangler's d1_migrations ledger and must
-- not be replayed. Future schema changes belong in this directory.
SELECT 1;
