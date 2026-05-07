-- azure-mcp initial schema.
--
-- Three tables, deliberately minimal. Postgres runs this once when its
-- data volume is first created (docker-entrypoint-initdb.d). For schema
-- changes after first boot, add a migration via node-pg-migrate from
-- the backend (added at the polish step).

-- gen_random_uuid() lives in pgcrypto; available by default on PG 13+
-- but enabling explicitly is harmless and makes the file portable.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── projects ───────────────────────────────────────────────────────
-- One row per named workspace. The `name` is what appears as the
-- `azure-mcp-project` tag on every resource we deploy.
CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── deployments ────────────────────────────────────────────────────
-- Append-only history. We never UPDATE or DELETE rows here except to
-- patch `status` / `error` once a live deployment finishes.
CREATE TABLE IF NOT EXISTS deployments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 'bicep-reviewed' or 'live-mcp'
  mode        TEXT NOT NULL CHECK (mode IN ('bicep-reviewed', 'live-mcp')),
  -- The user prompt that triggered this deployment.
  prompt      TEXT NOT NULL,
  -- The generated Bicep template, if mode = 'bicep-reviewed'.
  bicep       TEXT,
  -- The MCP tool-call sequence as JSON: [{name, args, result, error}, ...]
  tool_calls  JSONB,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'partial')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployments_project_created
  ON deployments(project_id, created_at DESC);

-- ── templates ──────────────────────────────────────────────────────
-- User-named Bicep snippets saved from previous deployments.
CREATE TABLE IF NOT EXISTS templates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT UNIQUE NOT NULL,
  description          TEXT,
  bicep                TEXT NOT NULL,
  source_deployment_id UUID REFERENCES deployments(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── trigger to keep projects.updated_at fresh on UPDATE ────────────
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION trg_set_updated_at();

-- ── schedules ──────────────────────────────────────────────────────
-- Cron-driven push or teardown of a saved template. The backend's
-- scheduler loads enabled rows into in-memory cron tasks at boot and
-- on every CRUD mutation via /api/schedules.
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

-- ── topologies ────────────────────────────────────────────────────
-- Many topologies per project. Each is draft (designed, not pushed),
-- live (successfully pushed), or destroyed (was live, Azure resources
-- have been torn down). Resources are tagged with both
-- azure-mcp-project AND azure-mcp-topology-id so per-topology destroy
-- is precise.
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
