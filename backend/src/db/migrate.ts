// Idempotent on-startup schema migration. db/init.sql runs once when
// Postgres bootstraps an empty data volume; this runs every time the
// backend starts and only adds tables / columns that don't already
// exist. New tables added after first install go here.

import { pool } from "./pool.js";

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    -- Schedules: cron-driven push or teardown of a saved template.
    CREATE TABLE IF NOT EXISTS schedules (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      template_id     UUID REFERENCES templates(id) ON DELETE CASCADE,
      action          TEXT NOT NULL CHECK (action IN ('push', 'teardown')),
      cron            TEXT NOT NULL,
      enabled         BOOLEAN NOT NULL DEFAULT TRUE,
      last_run_at     TIMESTAMPTZ,
      last_run_status TEXT,
      last_run_error  TEXT,
      next_run_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_project ON schedules(project_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled) WHERE enabled = TRUE;

    -- Topologies: a project can hold many. Each is draft (designed,
    -- not pushed), live (successfully pushed), failed (push attempted
    -- but errored), or destroyed (was live, Azure resources have been
    -- torn down).
    CREATE TABLE IF NOT EXISTS topologies (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('draft', 'live', 'failed', 'destroyed')) DEFAULT 'draft',
      topology        JSONB,
      bicep           TEXT,
      pushed_at       TIMESTAMPTZ,
      destroyed_at    TIMESTAMPTZ,
      pushed_deployment_id UUID REFERENCES deployments(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_topologies_project ON topologies(project_id);
    CREATE INDEX IF NOT EXISTS idx_topologies_updated ON topologies(project_id, updated_at DESC);

    DROP TRIGGER IF EXISTS topologies_set_updated_at ON topologies;
    CREATE TRIGGER topologies_set_updated_at
      BEFORE UPDATE ON topologies
      FOR EACH ROW
      EXECUTE FUNCTION trg_set_updated_at();
  `);

  // Ensure the status CHECK constraint allows 'failed'. Older schema
  // had only ('draft','live','destroyed'); existing tables need to
  // have the constraint replaced.
  await pool.query(`
    DO $$
    DECLARE c_name text;
    BEGIN
      SELECT conname INTO c_name
      FROM pg_constraint
      WHERE conrelid = 'topologies'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%status%';
      IF c_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE topologies DROP CONSTRAINT %I', c_name);
      END IF;
      ALTER TABLE topologies
        ADD CONSTRAINT topologies_status_check
        CHECK (status IN ('draft', 'live', 'failed', 'destroyed'));
    END
    $$;
  `);

  // GitHub-sync columns on projects. github_repo is "owner/name" once
  // set; null means the project hasn't been synced yet. github_synced_at
  // is the wall-clock of the last successful sync.
  await pool.query(`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_synced_at TIMESTAMPTZ;
  `);

  // Same shape on topologies — per-topology sync writes the topology's
  // own bicep + canvas JSON + screenshot to its own repo, separate
  // from the project-level repo. Once set we keep the same name so
  // re-syncs update the existing repo rather than churn names.
  await pool.query(`
    ALTER TABLE topologies ADD COLUMN IF NOT EXISTS github_repo TEXT;
    ALTER TABLE topologies ADD COLUMN IF NOT EXISTS github_synced_at TIMESTAMPTZ;
  `);

  // Capture the canvas-state JSON alongside the Bicep when saving a
  // template. Loading a template can then render the canvas directly
  // from saved data — no need to round-trip through Claude to derive
  // a <topology> marker from the raw Bicep.
  await pool.query(`
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS topology JSONB;
  `);

  // Multi-cloud: each project is single-cloud (Azure or AWS).
  // Defaults to 'azure' for backward-compat with rows created before
  // this column existed. Topologies inherit cloud from their project
  // — we mirror it onto topologies for fast filtering on the rail.
  await pool.query(`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS cloud TEXT NOT NULL DEFAULT 'azure';
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'projects_cloud_check' AND conrelid = 'projects'::regclass
      ) THEN
        ALTER TABLE projects
          ADD CONSTRAINT projects_cloud_check CHECK (cloud IN ('azure','aws'));
      END IF;
    END
    $$;
  `);
  await pool.query(`
    ALTER TABLE topologies ADD COLUMN IF NOT EXISTS cloud TEXT;
  `);
  // Backfill any topology rows that existed before the column was
  // added, populating from their parent project.
  await pool.query(`
    UPDATE topologies t SET cloud = p.cloud
    FROM projects p
    WHERE t.project_id = p.id AND t.cloud IS NULL;
  `);
  // eslint-disable-next-line no-console
  console.log("[db] migrations applied");
}
