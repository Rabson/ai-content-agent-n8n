CREATE TABLE IF NOT EXISTS content_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  topic TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_runs_status ON content_runs (status);
CREATE INDEX IF NOT EXISTS idx_content_runs_updated_at ON content_runs (updated_at DESC);

CREATE TABLE IF NOT EXISTS content_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_events_run_id ON content_events (run_id);
CREATE INDEX IF NOT EXISTS idx_content_events_created_at ON content_events (created_at DESC);
