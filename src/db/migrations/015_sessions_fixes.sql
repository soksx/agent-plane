-- Fix session infrastructure: add missing index, fix triggered_by constraint
-- Addresses review findings from PR #13

-- ============================================================
-- 1. Add composite index for concurrent session count check
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_sessions_tenant_status ON sessions (tenant_id, status);

-- ============================================================
-- 2. Clean up triggered_by CHECK constraint
-- ============================================================

-- Migration 014 used hardcoded constraint name guesses to drop the old
-- triggered_by CHECK. If the auto-generated name didn't match, both the
-- old constraint (blocking 'chat') and new one (allowing 'chat') may coexist.
-- Use dynamic lookup to find and drop any constraint that doesn't allow 'chat'.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE con.conrelid = 'runs'::regclass
      AND con.contype = 'c'
      AND att.attname = 'triggered_by'
      AND pg_get_constraintdef(con.oid) NOT LIKE '%chat%'
  LOOP
    EXECUTE format('ALTER TABLE runs DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
