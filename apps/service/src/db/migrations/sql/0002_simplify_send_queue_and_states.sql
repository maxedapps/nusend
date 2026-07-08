-- migrate:up
PRAGMA defer_foreign_keys = ON;

ALTER TABLE mailing_idempotency_keys RENAME TO mailing_idempotency_keys_old;
ALTER TABLE send_attempts RENAME TO send_attempts_old;
ALTER TABLE jobs RENAME TO jobs_old;
ALTER TABLE deliveries RENAME TO deliveries_old;
ALTER TABLE mailings RENAME TO mailings_old;

DROP INDEX IF EXISTS mailing_idempotency_keys_mailing_id_idx;
DROP INDEX IF EXISTS send_attempts_delivery_id_idx;
DROP INDEX IF EXISTS send_attempts_job_id_idx;
DROP INDEX IF EXISTS send_attempts_status_idx;
DROP INDEX IF EXISTS send_attempts_ses_message_id_idx;
DROP INDEX IF EXISTS jobs_state_run_at_idx;
DROP INDEX IF EXISTS jobs_locked_until_idx;
DROP INDEX IF EXISTS jobs_kind_ref_id_idx;
DROP INDEX IF EXISTS deliveries_mailing_id_idx;
DROP INDEX IF EXISTS deliveries_mailing_status_idx;
DROP INDEX IF EXISTS deliveries_email_idx;
DROP INDEX IF EXISTS deliveries_contact_id_idx;
DROP INDEX IF EXISTS deliveries_ses_message_id_idx;
DROP INDEX IF EXISTS mailings_purpose_state_idx;
DROP INDEX IF EXISTS mailings_scheduled_at_idx;
DROP INDEX IF EXISTS mailings_list_id_idx;

CREATE TABLE mailings (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('transactional', 'marketing')),
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'sending', 'completed')),
  name TEXT,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT,
  list_id TEXT REFERENCES lists(id) ON DELETE SET NULL,
  scheduled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  mailing_id TEXT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  vars_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  ses_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'dead')),
  run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  locked_by TEXT,
  locked_until TEXT,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE send_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'ambiguous')),
  ses_message_id TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  UNIQUE (delivery_id, attempt_no)
);

CREATE TABLE mailing_idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  mailing_id TEXT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO mailings (id, purpose, state, name, subject, html, text, list_id, scheduled_at, created_at, updated_at)
SELECT id, purpose, state, name, subject, html, text, list_id, scheduled_at, created_at, updated_at
FROM mailings_old;

INSERT INTO deliveries (id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error, created_at, updated_at)
SELECT id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error, created_at, updated_at
FROM deliveries_old;

INSERT INTO jobs (id, state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id, last_error, created_at, updated_at)
SELECT id, state, run_at, attempts, max_attempts, locked_by, locked_until, ref_id, last_error, created_at, updated_at
FROM jobs_old;

INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message, started_at, finished_at)
SELECT id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message, started_at, finished_at
FROM send_attempts_old;

INSERT INTO mailing_idempotency_keys (key, request_hash, mailing_id, response_json, created_at)
SELECT key, request_hash, mailing_id, response_json, created_at
FROM mailing_idempotency_keys_old;

DROP TABLE mailing_idempotency_keys_old;
DROP TABLE send_attempts_old;
DROP TABLE jobs_old;
DROP TABLE deliveries_old;
DROP TABLE mailings_old;

CREATE INDEX mailings_purpose_state_idx ON mailings (purpose, state);
CREATE INDEX mailings_scheduled_at_idx ON mailings (scheduled_at);
CREATE INDEX mailings_list_id_idx ON mailings (list_id);
CREATE INDEX deliveries_mailing_id_idx ON deliveries (mailing_id);
CREATE INDEX deliveries_mailing_status_idx ON deliveries (mailing_id, status);
CREATE INDEX deliveries_email_idx ON deliveries (email);
CREATE INDEX deliveries_contact_id_idx ON deliveries (contact_id);
CREATE UNIQUE INDEX deliveries_ses_message_id_idx ON deliveries (ses_message_id)
  WHERE ses_message_id IS NOT NULL;
CREATE INDEX jobs_state_run_at_idx ON jobs (state, run_at);
CREATE INDEX jobs_locked_until_idx ON jobs (locked_until);
CREATE INDEX jobs_delivery_id_idx ON jobs (delivery_id);
CREATE INDEX send_attempts_delivery_id_idx ON send_attempts (delivery_id);
CREATE INDEX send_attempts_job_id_idx ON send_attempts (job_id);
CREATE INDEX send_attempts_status_idx ON send_attempts (status);
CREATE INDEX send_attempts_ses_message_id_idx ON send_attempts (ses_message_id)
  WHERE ses_message_id IS NOT NULL;
CREATE INDEX mailing_idempotency_keys_mailing_id_idx
  ON mailing_idempotency_keys (mailing_id);

-- migrate:down
PRAGMA defer_foreign_keys = ON;

ALTER TABLE mailing_idempotency_keys RENAME TO mailing_idempotency_keys_old;
ALTER TABLE send_attempts RENAME TO send_attempts_old;
ALTER TABLE jobs RENAME TO jobs_old;
ALTER TABLE deliveries RENAME TO deliveries_old;
ALTER TABLE mailings RENAME TO mailings_old;

DROP INDEX IF EXISTS mailing_idempotency_keys_mailing_id_idx;
DROP INDEX IF EXISTS send_attempts_delivery_id_idx;
DROP INDEX IF EXISTS send_attempts_job_id_idx;
DROP INDEX IF EXISTS send_attempts_status_idx;
DROP INDEX IF EXISTS send_attempts_ses_message_id_idx;
DROP INDEX IF EXISTS jobs_state_run_at_idx;
DROP INDEX IF EXISTS jobs_locked_until_idx;
DROP INDEX IF EXISTS jobs_delivery_id_idx;
DROP INDEX IF EXISTS deliveries_mailing_id_idx;
DROP INDEX IF EXISTS deliveries_mailing_status_idx;
DROP INDEX IF EXISTS deliveries_email_idx;
DROP INDEX IF EXISTS deliveries_contact_id_idx;
DROP INDEX IF EXISTS deliveries_ses_message_id_idx;
DROP INDEX IF EXISTS mailings_purpose_state_idx;
DROP INDEX IF EXISTS mailings_scheduled_at_idx;
DROP INDEX IF EXISTS mailings_list_id_idx;

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

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  mailing_id TEXT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  vars_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed', 'cancelled')),
  ses_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

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

CREATE TABLE send_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'ambiguous')),
  ses_message_id TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  UNIQUE (delivery_id, attempt_no)
);

CREATE TABLE mailing_idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  mailing_id TEXT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO mailings (id, purpose, state, name, subject, html, text, list_id, scheduled_at, created_at, updated_at)
SELECT id, purpose, state, name, subject, html, text, list_id, scheduled_at, created_at, updated_at
FROM mailings_old;

INSERT INTO deliveries (id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error, created_at, updated_at)
SELECT id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error, created_at, updated_at
FROM deliveries_old;

INSERT INTO jobs (id, kind, state, run_at, attempts, max_attempts, locked_by, locked_until, ref_id, last_error, created_at, updated_at)
SELECT id, 'send_delivery', state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id, last_error, created_at, updated_at
FROM jobs_old;

INSERT INTO send_attempts (id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message, started_at, finished_at)
SELECT id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message, started_at, finished_at
FROM send_attempts_old;

INSERT INTO mailing_idempotency_keys (key, request_hash, mailing_id, response_json, created_at)
SELECT key, request_hash, mailing_id, response_json, created_at
FROM mailing_idempotency_keys_old;

DROP TABLE mailing_idempotency_keys_old;
DROP TABLE send_attempts_old;
DROP TABLE jobs_old;
DROP TABLE deliveries_old;
DROP TABLE mailings_old;

CREATE INDEX mailings_purpose_state_idx ON mailings (purpose, state);
CREATE INDEX mailings_scheduled_at_idx ON mailings (scheduled_at);
CREATE INDEX mailings_list_id_idx ON mailings (list_id);
CREATE INDEX deliveries_mailing_id_idx ON deliveries (mailing_id);
CREATE INDEX deliveries_mailing_status_idx ON deliveries (mailing_id, status);
CREATE INDEX deliveries_email_idx ON deliveries (email);
CREATE INDEX deliveries_contact_id_idx ON deliveries (contact_id);
CREATE UNIQUE INDEX deliveries_ses_message_id_idx ON deliveries (ses_message_id)
  WHERE ses_message_id IS NOT NULL;
CREATE INDEX jobs_state_run_at_idx ON jobs (state, run_at);
CREATE INDEX jobs_locked_until_idx ON jobs (locked_until);
CREATE INDEX jobs_kind_ref_id_idx ON jobs (kind, ref_id);
CREATE INDEX send_attempts_delivery_id_idx ON send_attempts (delivery_id);
CREATE INDEX send_attempts_job_id_idx ON send_attempts (job_id);
CREATE INDEX send_attempts_status_idx ON send_attempts (status);
CREATE INDEX send_attempts_ses_message_id_idx ON send_attempts (ses_message_id)
  WHERE ses_message_id IS NOT NULL;
CREATE INDEX mailing_idempotency_keys_mailing_id_idx
  ON mailing_idempotency_keys (mailing_id);
