CREATE TABLE IF NOT EXISTS destinations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  simulator_mode TEXT NOT NULL CHECK (simulator_mode IN ('healthy', 'retry_then_recover', 'rate_limited', 'slow', 'always_fails', 'exhaust_retries')),
  simulator_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  encrypted_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_runs (
  id UUID PRIMARY KEY,
  scenario TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  concurrency INTEGER NOT NULL,
  max_p95_ms INTEGER NOT NULL DEFAULT 1000,
  max_error_rate NUMERIC(5,2) NOT NULL DEFAULT 5,
  destination_ids TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  run_id UUID REFERENCES test_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deliveries (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'retry_scheduled', 'succeeded', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_http_status INTEGER,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ,
  replayed_from_delivery_id UUID REFERENCES deliveries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE deliveries ALTER COLUMN status SET DEFAULT 'queued';

CREATE INDEX IF NOT EXISTS deliveries_status_updated_idx ON deliveries(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS deliveries_destination_status_idx ON deliveries(destination_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS deliveries_event_idx ON deliveries(event_id);
CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id,created_at);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  response_status INTEGER,
  response_excerpt TEXT,
  error_category TEXT,
  duration_ms INTEGER,
  retry_delay_ms INTEGER,
  UNIQUE(delivery_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS outbox (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL UNIQUE REFERENCES deliveries(id) ON DELETE CASCADE,
  published_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receiver_observations (
  destination_id TEXT NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(destination_id, event_id)
);
