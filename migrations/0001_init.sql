CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);

CREATE UNIQUE INDEX api_keys_key_hash_idx ON api_keys (key_hash);
CREATE INDEX api_keys_revoked_at_idx ON api_keys (revoked_at);

CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX lists_name_idx ON lists (name);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  attrs_json TEXT,
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

-- Workflow states (mailings.state, deliveries.status, jobs.kind, jobs.state) are
-- intentionally not CHECK-constrained: SQLite cannot alter CHECKs without table
-- rebuilds. They are validated in TypeScript instead.
CREATE TABLE mailings (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('transactional', 'marketing')),
  state TEXT NOT NULL,
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
  status TEXT NOT NULL,
  ses_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Expansion/dispatch retries are at-least-once; this index is the durable
-- defense against duplicate deliveries for the same mailing+recipient.
CREATE UNIQUE INDEX deliveries_mailing_email_idx ON deliveries (mailing_id, email);
CREATE INDEX deliveries_mailing_status_idx ON deliveries (mailing_id, status);
CREATE INDEX deliveries_email_idx ON deliveries (email);
CREATE INDEX deliveries_contact_id_idx ON deliveries (contact_id);
CREATE UNIQUE INDEX deliveries_ses_message_id_idx ON deliveries (ses_message_id) WHERE ses_message_id IS NOT NULL;

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
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
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

CREATE INDEX jobs_state_priority_run_at_idx ON jobs (state, priority DESC, run_at);
CREATE INDEX jobs_locked_until_idx ON jobs (locked_until);
CREATE INDEX jobs_kind_ref_id_idx ON jobs (kind, ref_id);

CREATE TABLE send_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'ambiguous')),
  ses_message_id TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);

CREATE INDEX send_attempts_job_id_idx ON send_attempts (job_id);
CREATE UNIQUE INDEX send_attempts_delivery_attempt_no_idx ON send_attempts (delivery_id, attempt_no);

CREATE TABLE ses_events (
  id TEXT PRIMARY KEY,
  sns_message_id TEXT NOT NULL,
  ses_message_id TEXT,
  event_type TEXT NOT NULL,
  delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
  raw_json TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX ses_events_sns_message_id_idx ON ses_events (sns_message_id);
CREATE INDEX ses_events_ses_message_id_idx ON ses_events (ses_message_id);
CREATE INDEX ses_events_delivery_id_idx ON ses_events (delivery_id);
CREATE INDEX ses_events_event_type_idx ON ses_events (event_type);
