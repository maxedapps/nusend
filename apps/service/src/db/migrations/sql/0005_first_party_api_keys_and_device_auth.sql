-- migrate:up
DROP TABLE IF EXISTS api_keys;

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_preview TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  rotated_from_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);
CREATE INDEX api_keys_revoked_at_idx ON api_keys (revoked_at);
CREATE INDEX api_keys_last_used_at_idx ON api_keys (last_used_at);

CREATE TABLE device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL UNIQUE,
  user_code_preview TEXT NOT NULL,
  requested_permissions_json TEXT NOT NULL,
  client_name TEXT NOT NULL,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  approved_at TEXT,
  denied_at TEXT,
  consumed_at TEXT,
  expires_at TEXT NOT NULL,
  poll_count INTEGER NOT NULL DEFAULT 0,
  last_poll_at TEXT,
  user_code_attempts INTEGER NOT NULL DEFAULT 0,
  last_user_code_attempt_at TEXT,
  requester_fingerprint_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX device_authorizations_expires_at_idx ON device_authorizations (expires_at);
CREATE INDEX device_authorizations_approved_user_idx ON device_authorizations (approved_by_user_id);

-- migrate:down
DROP TABLE IF EXISTS device_authorizations;
DROP TABLE IF EXISTS api_keys;

CREATE TABLE api_keys (
  id TEXT NOT NULL PRIMARY KEY,
  config_id TEXT NOT NULL,
  name TEXT,
  start TEXT,
  reference_id TEXT NOT NULL,
  prefix TEXT,
  key TEXT NOT NULL,
  refill_interval INTEGER,
  refill_amount INTEGER,
  last_refill_at DATE,
  enabled INTEGER,
  rate_limit_enabled INTEGER,
  rate_limit_time_window INTEGER,
  rate_limit_max INTEGER,
  request_count INTEGER,
  remaining INTEGER,
  last_request DATE,
  expires_at DATE,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL,
  permissions TEXT,
  metadata TEXT
);

CREATE INDEX api_keys_config_id_idx ON api_keys (config_id);
CREATE INDEX api_keys_reference_id_idx ON api_keys (reference_id);
CREATE INDEX api_keys_key_idx ON api_keys (key);
