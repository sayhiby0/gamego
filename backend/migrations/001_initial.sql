-- GameGo-only D1 database. Times are Unix milliseconds; costs are RMB micro-units.
-- No prompts, chat messages, model responses, raw emails or provider keys belong here.
CREATE TABLE IF NOT EXISTS auth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_states_expiry ON auth_states(expires_at);

CREATE TABLE IF NOT EXISTS exchanges (
  code_hash TEXT PRIMARY KEY NOT NULL,
  challenge TEXT NOT NULL,
  subject TEXT NOT NULL,
  identity_hashes TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS exchanges_expiry ON exchanges(expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  subject TEXT NOT NULL,
  identity_hashes TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS allowlist (
  email_hash TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('content', 'agent')),
  month TEXT NOT NULL CHECK (
    month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12'
  ),
  model TEXT NOT NULL,
  price_version TEXT NOT NULL,
  upper_micros INTEGER NOT NULL CHECK (
    typeof(upper_micros) = 'integer'
    AND upper_micros BETWEEN 0 AND 9007199254740991
  ),
  charged_micros INTEGER NOT NULL CHECK (
    typeof(charged_micros) = 'integer'
    AND charged_micros BETWEEN 0 AND upper_micros
  ),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (length(status) BETWEEN 1 AND 32),
  created_at INTEGER NOT NULL,
  owner TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_budget ON usage(channel, month, charged_micros);
CREATE INDEX IF NOT EXISTS usage_retention ON usage(created_at);

-- Only archived detail contributes here: never count the same charge in both tables.
-- Keep model / price version provenance, but discard per-request identity on archival.
CREATE TABLE IF NOT EXISTS usage_monthly (
  channel TEXT NOT NULL CHECK (channel IN ('content', 'agent')),
  month TEXT NOT NULL CHECK (
    month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12'
  ),
  model TEXT NOT NULL,
  price_version TEXT NOT NULL,
  charged_micros INTEGER NOT NULL CHECK (
    typeof(charged_micros) = 'integer' AND charged_micros >= 0
  ),
  request_count INTEGER NOT NULL CHECK (
    typeof(request_count) = 'integer' AND request_count > 0
  ),
  PRIMARY KEY (channel, month, model, price_version)
);
CREATE INDEX IF NOT EXISTS usage_monthly_retention ON usage_monthly(month);

CREATE TABLE IF NOT EXISTS job_leases (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS job_leases_expiry ON job_leases(expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL CHECK (typeof(count) = 'integer' AND count >= 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);

-- Public-content cache only; never cache Agent conversations or reports.
CREATE TABLE IF NOT EXISTS content_cache (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS content_cache_expiry ON content_cache(expires_at);

-- Per-material content deduplication; never consumes the three Agent job slots.
CREATE TABLE IF NOT EXISTS content_leases (
  cache_id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS content_leases_expiry ON content_leases(expires_at);
