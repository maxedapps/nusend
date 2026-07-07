-- migrate:up
CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_verified INTEGER NOT NULL,
  image TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);

CREATE TABLE sessions (
  id TEXT NOT NULL PRIMARY KEY,
  expires_at DATE NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE accounts (
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at DATE,
  refresh_token_expires_at DATE,
  scope TEXT,
  password TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);

CREATE INDEX accounts_user_id_idx ON accounts (user_id);

CREATE TABLE verifications (
  id TEXT NOT NULL PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);

CREATE INDEX verifications_identifier_idx ON verifications (identifier);

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

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX lists_name_idx ON lists (name);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX contacts_email_idx ON contacts (email);

CREATE TABLE list_memberships (
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  subscribed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unsubscribed_at TEXT,
  PRIMARY KEY (list_id, contact_id)
);

CREATE INDEX list_memberships_contact_id_idx ON list_memberships (contact_id);
CREATE INDEX list_memberships_subscribed_idx ON list_memberships (list_id, unsubscribed_at);

CREATE TABLE mailings (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('transactional', 'marketing')),
  state TEXT NOT NULL CHECK (state IN ('draft', 'scheduled', 'sending', 'paused', 'cancelled', 'completed')),
  name TEXT,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT,
  list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
  scheduled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX mailings_purpose_state_idx ON mailings (purpose, state);
CREATE INDEX mailings_scheduled_at_idx ON mailings (scheduled_at);
CREATE INDEX mailings_list_id_idx ON mailings (list_id);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  mailing_id TEXT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  vars_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX deliveries_mailing_id_idx ON deliveries (mailing_id);
CREATE INDEX deliveries_mailing_status_idx ON deliveries (mailing_id, status);
CREATE INDEX deliveries_email_idx ON deliveries (email);
CREATE INDEX deliveries_contact_id_idx ON deliveries (contact_id);

CREATE TABLE suppressions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  scope TEXT NOT NULL CHECK (scope IN ('all', 'marketing', 'list')),
  list_id TEXT REFERENCES lists(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'unsubscribe', 'manual')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((scope = 'list' AND list_id IS NOT NULL) OR (scope IN ('all', 'marketing') AND list_id IS NULL))
);

CREATE INDEX suppressions_email_idx ON suppressions (email);
CREATE UNIQUE INDEX suppressions_email_global_scope_idx ON suppressions (email, scope) WHERE list_id IS NULL;
CREATE UNIQUE INDEX suppressions_email_list_idx ON suppressions (email, list_id) WHERE scope = 'list';

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('send_delivery')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'failed', 'dead', 'cancelled')),
  run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  locked_by TEXT,
  locked_until TEXT,
  ref_id TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX jobs_state_run_at_idx ON jobs (state, run_at);
CREATE INDEX jobs_locked_until_idx ON jobs (locked_until);
CREATE INDEX jobs_kind_ref_id_idx ON jobs (kind, ref_id);

-- migrate:down
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS suppressions;
DROP TABLE IF EXISTS deliveries;
DROP TABLE IF EXISTS mailings;
DROP TABLE IF EXISTS list_memberships;
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS lists;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
