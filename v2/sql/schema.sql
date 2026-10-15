-- v2 Postgres schema. Row updates, never a 110MB JSON dump.
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS stage_health (
  stage TEXT PRIMARY KEY,
  last_ok_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  in_flight_since TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT,
  status TEXT,
  client_id INTEGER,
  min_time_btwn_emails INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  from_name TEXT,
  client_id INTEGER,
  campaign_ids INTEGER[] NOT NULL DEFAULT '{}',
  tags TEXT[] NOT NULL DEFAULT '{}',
  smtp_ok BOOLEAN,
  imap_ok BOOLEAN,
  message_per_day INTEGER,
  warmup_blocked BOOLEAN,
  created_at TIMESTAMPTZ,
  warmup_started_at TIMESTAMPTZ,
  signature TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at TIMESTAMPTZ NOT NULL,
  campaign_count INTEGER NOT NULL DEFAULT 0,
  account_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS findings (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  campaign_id INTEGER,
  account_id INTEGER,
  email TEXT,
  detail TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS findings_kind_at ON findings (kind, at DESC);
CREATE INDEX IF NOT EXISTS findings_campaign ON findings (campaign_id);

CREATE TABLE IF NOT EXISTS intended_actions (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind TEXT NOT NULL,
  campaign_id INTEGER,
  account_id INTEGER,
  email TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  executed BOOLEAN NOT NULL DEFAULT FALSE,
  shadowed BOOLEAN NOT NULL DEFAULT TRUE,
  write_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_reason TEXT
);
CREATE INDEX IF NOT EXISTS intended_actions_kind_at ON intended_actions (kind, at DESC);
CREATE INDEX IF NOT EXISTS intended_actions_campaign ON intended_actions (campaign_id);

CREATE TABLE IF NOT EXISTS placement_scores (
  campaign_id INTEGER PRIMARY KEY,
  campaign_name TEXT,
  source TEXT NOT NULL,
  test_id TEXT NOT NULL,
  inbox_percent DOUBLE PRECISION NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL,
  fleet_emails_scored INTEGER NOT NULL DEFAULT 0,
  released_emails_ignored INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS isolation_suspects (
  campaign_id INTEGER PRIMARY KEY,
  campaign_name TEXT,
  source TEXT NOT NULL,
  test_id TEXT,
  queued_at TIMESTAMPTZ NOT NULL,
  evaluated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS isolation_runs (
  id TEXT PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  teardown_started BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS isolation_runs_campaign ON isolation_runs (campaign_id, started_at DESC);

CREATE TABLE IF NOT EXISTS copy_canary_tests (
  campaign_id INTEGER PRIMARY KEY,
  test_id TEXT,
  test_name TEXT NOT NULL,
  listed_duplicates INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS generic_seats (
  account_id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  assigned_client_id INTEGER,
  assigned_pod TEXT,
  assigned_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS holds (
  account_id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inboxkit_seat_ends (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  cancel_date DATE,
  lapsed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spend_asks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id INTEGER,
  amount_usd DOUBLE PRECISION,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS comparison_reports (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  report JSONB NOT NULL
);
