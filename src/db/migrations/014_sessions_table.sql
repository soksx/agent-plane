-- Persistent Chat Sessions
-- Adds a sessions table for multi-turn conversations with sandbox kept alive.
-- Each session message creates a run with triggered_by = 'chat'.

-- ============================================================
-- 1. Create sessions table
-- ============================================================

CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  agent_id        UUID NOT NULL,
  sandbox_id      TEXT,                    -- NULL when sandbox is stopped
  sdk_session_id  TEXT,                    -- captured from SDK init message
  session_blob_url TEXT,                   -- Vercel Blob URL for backed-up session file
  status          TEXT NOT NULL DEFAULT 'creating'
                  CHECK (status IN ('creating', 'active', 'idle', 'stopped')),
  message_count   INT NOT NULL DEFAULT 0,
  last_backup_at  TIMESTAMPTZ,            -- track stale backups
  idle_since      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,

  -- Composite FK: prevent sessions referencing agent from different tenant
  CONSTRAINT fk_sessions_agent_tenant FOREIGN KEY (agent_id, tenant_id)
    REFERENCES agents(id, tenant_id) ON DELETE CASCADE
);

-- ============================================================
-- 2. Indexes
-- ============================================================

-- Tenant-scoped queries
CREATE INDEX idx_sessions_tenant ON sessions (tenant_id);

-- Agent-scoped queries (list sessions for an agent)
CREATE INDEX idx_sessions_agent ON sessions (agent_id);

-- Cleanup cron: find idle sessions past threshold
CREATE INDEX idx_sessions_idle ON sessions (status, idle_since)
  WHERE status = 'idle';

-- ============================================================
-- 3. RLS
-- ============================================================

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sessions
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ============================================================
-- 4. Triggers
-- ============================================================

CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 5. Grant permissions to app_user
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app_user;

-- ============================================================
-- 6. Add session_id FK on runs
-- ============================================================

ALTER TABLE runs ADD COLUMN IF NOT EXISTS session_id UUID;

-- Use NOT VALID to avoid ACCESS EXCLUSIVE lock on large runs table,
-- then validate separately (only takes SHARE UPDATE EXCLUSIVE lock).
ALTER TABLE runs ADD CONSTRAINT fk_runs_session
  FOREIGN KEY (session_id)
  REFERENCES sessions(id)
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE runs VALIDATE CONSTRAINT fk_runs_session;

-- Index for looking up runs by session
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs (session_id) WHERE session_id IS NOT NULL;

-- ============================================================
-- 7. Update triggered_by CHECK to include 'chat'
-- ============================================================

-- The triggered_by column was added with an inline unnamed CHECK in migration 010.
-- Postgres auto-generates the constraint name. We need to find it dynamically.
-- Common auto-generated name: runs_triggered_by_check
-- If this DROP does nothing (wrong name), the next ALTER will fail when
-- inserting 'chat' values because the old constraint still blocks it.

-- Try the most likely auto-generated name first
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_triggered_by_check;

-- Also try the column-based naming convention Postgres sometimes uses
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_triggered_by_check1;

ALTER TABLE runs ADD CONSTRAINT runs_triggered_by_check
  CHECK (triggered_by IN ('api', 'schedule', 'playground', 'chat'))
  NOT VALID;

ALTER TABLE runs VALIDATE CONSTRAINT runs_triggered_by_check;
