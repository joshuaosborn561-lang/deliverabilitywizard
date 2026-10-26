-- v2 Postgres schema. Row updates, never a 110MB JSON dump.
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS stage_health (
  stage TEXT PRIMARY KEY,
  last_ok_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  in_flight_since TIMESTAMPTZ,
  last_skip_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_campaigns (
  id INTEGER PRIMARY KEY,
  name TEXT,
  status TEXT,
  client_id INTEGER,
  min_time_btwn_emails INTEGER,
  canon_settings JSONB,
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
CREATE INDEX IF NOT EXISTS intended_actions_pending
  ON intended_actions (kind, campaign_id, account_id)
  WHERE executed = false;

CREATE TABLE IF NOT EXISTS placement_scores (
  campaign_id INTEGER NOT NULL,
  campaign_name TEXT,
  source TEXT NOT NULL,
  test_id TEXT NOT NULL,
  inbox_percent DOUBLE PRECISION NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL,
  fleet_emails_scored INTEGER NOT NULL DEFAULT 0,
  released_emails_ignored INTEGER NOT NULL DEFAULT 0,
  canary_kind TEXT,
  failure_class TEXT,
  PRIMARY KEY (campaign_id, source)
);
-- Existing DBs may still have campaign_id-only PK. migrate() applies an
-- idempotent unique index on (campaign_id, source) as separate statements.

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

ALTER TABLE placement_scores ADD COLUMN IF NOT EXISTS canary_kind TEXT;
ALTER TABLE placement_scores ADD COLUMN IF NOT EXISTS failure_class TEXT;
ALTER TABLE inventory_campaigns ADD COLUMN IF NOT EXISTS canon_settings JSONB;
ALTER TABLE stage_health ADD COLUMN IF NOT EXISTS last_skip_reason TEXT;

-- D273: only g_to_g / ms_to_ms are scored. g_to_ms / ms_to_g stay as unused columns.
CREATE TABLE IF NOT EXISTS esp_inbox_rates (
  campaign_id INTEGER NOT NULL,
  day DATE NOT NULL,
  campaign_name TEXT,
  g_to_g DOUBLE PRECISION,
  g_to_ms DOUBLE PRECISION,
  ms_to_g DOUBLE PRECISION,
  ms_to_ms DOUBLE PRECISION,
  test_id TEXT,
  source TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, day)
);

CREATE TABLE IF NOT EXISTS qa_runs (
  id TEXT PRIMARY KEY,
  scheduled_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  campaign_id INTEGER,
  detail TEXT,
  findings JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS qa_runs_scheduled ON qa_runs (scheduled_at DESC);

CREATE TABLE IF NOT EXISTS qa_leases (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS terl_substitutions (
  campaign_id INTEGER NOT NULL,
  stopped_account_id INTEGER NOT NULL,
  stopped_email TEXT NOT NULL,
  substitute_account_id INTEGER,
  substitute_email TEXT,
  client_id INTEGER,
  tenant TEXT NOT NULL,
  stopped_at TIMESTAMPTZ NOT NULL,
  restore_after TIMESTAMPTZ NOT NULL,
  restored_at TIMESTAMPTZ,
  no_substitute BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (campaign_id, stopped_account_id)
);

CREATE TABLE IF NOT EXISTS smartlead_limiter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tokens_used INTEGER NOT NULL DEFAULT 0,
  inflight INTEGER NOT NULL DEFAULT 0,
  paused_until TIMESTAMPTZ,
  slot_held_since TIMESTAMPTZ
);
INSERT INTO smartlead_limiter (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Scrub leaked api_key / token query params from stored error text.
-- JS migrate() also rewrites rows through safeErrorText (path-only, no host).
UPDATE stage_health
SET last_error = regexp_replace(
  last_error,
  '([?&](api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret|password|authorization|auth)=)[^&[:space:]]+',
  '\1REDACTED',
  'gi'
)
WHERE last_error IS NOT NULL
  AND last_error ~* '(api[_-]?key|access[_-]?token|token|secret|password)=';

UPDATE findings
SET detail = regexp_replace(
  detail,
  '([?&](api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret|password|authorization|auth)=)[^&[:space:]]+',
  '\1REDACTED',
  'gi'
)
WHERE detail ~* '(api[_-]?key|access[_-]?token|token|secret|password)=';

-- D303 — mailbox rest-then-burn ledger (rest_count + history in record).
CREATE TABLE IF NOT EXISTS mailbox_rests (
  email TEXT PRIMARY KEY,
  record JSONB NOT NULL,
  status TEXT NOT NULL,
  rest_count INTEGER NOT NULL DEFAULT 0,
  rest_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- D303 — generics record which seat they cover (rest cover included).
ALTER TABLE generic_seats ADD COLUMN IF NOT EXISTS covering_for JSONB;
