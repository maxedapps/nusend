-- migrate:up
PRAGMA defer_foreign_keys = ON;

ALTER TABLE send_attempts RENAME TO send_attempts_old;
ALTER TABLE jobs RENAME TO jobs_old;
ALTER TABLE ses_events RENAME TO ses_events_old;
ALTER TABLE ses_simulator_runs RENAME TO ses_simulator_runs_old;
ALTER TABLE deliveries RENAME TO deliveries_old;

DROP INDEX IF EXISTS send_attempts_delivery_id_idx;
DROP INDEX IF EXISTS send_attempts_job_id_idx;
DROP INDEX IF EXISTS send_attempts_status_idx;
DROP INDEX IF EXISTS send_attempts_ses_message_id_idx;
DROP INDEX IF EXISTS jobs_state_run_at_idx;
DROP INDEX IF EXISTS jobs_locked_until_idx;
DROP INDEX IF EXISTS jobs_delivery_id_idx;
DROP INDEX IF EXISTS jobs_delivery_id_unique_idx;
DROP INDEX IF EXISTS ses_events_event_created_idx;
DROP INDEX IF EXISTS ses_events_delivery_id_idx;
DROP INDEX IF EXISTS ses_events_mailing_id_idx;
DROP INDEX IF EXISTS ses_events_ses_message_id_idx;
DROP INDEX IF EXISTS ses_events_recipient_email_idx;
DROP INDEX IF EXISTS ses_events_link_url_idx;
DROP INDEX IF EXISTS ses_events_created_id_idx;
DROP INDEX IF EXISTS ses_simulator_runs_started_at_idx;
DROP INDEX IF EXISTS ses_simulator_runs_status_idx;
DROP INDEX IF EXISTS deliveries_mailing_id_idx;
DROP INDEX IF EXISTS deliveries_mailing_status_idx;
DROP INDEX IF EXISTS deliveries_email_idx;
DROP INDEX IF EXISTS deliveries_contact_id_idx;
DROP INDEX IF EXISTS deliveries_ses_message_id_idx;
DROP INDEX IF EXISTS deliveries_created_id_idx;

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  mailing_id TEXT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  vars_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed', 'ambiguous')),
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

CREATE TABLE ses_events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  notification_id TEXT NOT NULL REFERENCES ses_notifications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'Send',
    'Rendering Failure',
    'Reject',
    'Delivery',
    'DeliveryDelay',
    'Bounce',
    'Complaint',
    'Subscription',
    'Open',
    'Click',
    'Unknown'
  )),
  delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
  mailing_id TEXT REFERENCES mailings(id) ON DELETE SET NULL,
  ses_message_id TEXT,
  recipient_email TEXT COLLATE NOCASE,
  action_taken TEXT NOT NULL CHECK (action_taken IN ('recorded', 'suppressed', 'ignored')),
  occurred_at TEXT,
  bounce_type TEXT,
  bounce_sub_type TEXT,
  complaint_feedback_type TEXT,
  feedback_id TEXT,
  diagnostic_code TEXT,
  reject_reason TEXT,
  delivery_delay_type TEXT,
  link_url TEXT,
  link_tags_json TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE ses_simulator_runs (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL CHECK (scenario IN ('success', 'bounce', 'complaint', 'ooto', 'suppressionlist')),
  mode TEXT NOT NULL CHECK (mode IN ('send_acceptance', 'end_to_end')),
  purpose TEXT NOT NULL CHECK (purpose IN ('transactional', 'marketing')),
  mailing_id TEXT REFERENCES mailings(id) ON DELETE SET NULL,
  delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  target_base_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('started', 'sent', 'validated', 'failed', 'timed_out', 'ambiguous')),
  expected_event_type TEXT,
  expected_suppression_reason TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

INSERT INTO deliveries (
  id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error,
  created_at, updated_at
)
SELECT
  d.id,
  d.mailing_id,
  d.email,
  d.contact_id,
  d.vars_json,
  CASE
    WHEN d.status = 'failed' AND latest.status = 'ambiguous' AND latest.ses_message_id IS NOT NULL
      AND (d.ses_message_id IS NULL OR d.ses_message_id = latest.ses_message_id)
      THEN 'sent'
    WHEN d.status = 'failed' AND latest.status = 'ambiguous'
      THEN 'ambiguous'
    ELSE d.status
  END,
  CASE
    WHEN d.status = 'failed' AND latest.status = 'ambiguous' AND latest.ses_message_id IS NOT NULL
      AND (d.ses_message_id IS NULL OR d.ses_message_id = latest.ses_message_id)
      THEN latest.ses_message_id
    ELSE d.ses_message_id
  END,
  CASE
    WHEN d.status = 'failed' AND latest.status = 'ambiguous' AND latest.ses_message_id IS NOT NULL
      AND (d.ses_message_id IS NULL OR d.ses_message_id = latest.ses_message_id)
      THEN NULL
    ELSE d.last_error
  END,
  d.created_at,
  d.updated_at
FROM deliveries_old d
LEFT JOIN send_attempts_old latest
  ON latest.delivery_id = d.id
 AND latest.attempt_no = (
   SELECT MAX(candidate.attempt_no)
   FROM send_attempts_old candidate
   WHERE candidate.delivery_id = d.id
 );

INSERT INTO jobs (
  id, state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id,
  last_error, created_at, updated_at
)
SELECT
  id, state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id,
  last_error, created_at, updated_at
FROM jobs_old;

INSERT INTO send_attempts (
  id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message,
  started_at, finished_at
)
SELECT
  a.id,
  a.delivery_id,
  a.job_id,
  a.attempt_no,
  CASE
    WHEN a.status = 'ambiguous'
      AND a.attempt_no = (
        SELECT MAX(candidate.attempt_no)
        FROM send_attempts_old candidate
        WHERE candidate.delivery_id = a.delivery_id
      )
      AND a.ses_message_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM deliveries_old d
        WHERE d.id = a.delivery_id
          AND d.status = 'failed'
          AND (d.ses_message_id IS NULL OR d.ses_message_id = a.ses_message_id)
      )
      THEN 'succeeded'
    ELSE a.status
  END,
  a.ses_message_id,
  CASE
    WHEN a.status = 'ambiguous'
      AND a.attempt_no = (
        SELECT MAX(candidate.attempt_no)
        FROM send_attempts_old candidate
        WHERE candidate.delivery_id = a.delivery_id
      )
      AND a.ses_message_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM deliveries_old d
        WHERE d.id = a.delivery_id
          AND d.status = 'failed'
          AND (d.ses_message_id IS NULL OR d.ses_message_id = a.ses_message_id)
      )
      THEN NULL
    ELSE a.error_message
  END,
  a.started_at,
  a.finished_at
FROM send_attempts_old a;

INSERT INTO ses_events (
  id, dedupe_key, notification_id, event_type, delivery_id, mailing_id, ses_message_id,
  recipient_email, action_taken, occurred_at, bounce_type, bounce_sub_type,
  complaint_feedback_type, feedback_id, diagnostic_code, reject_reason,
  delivery_delay_type, link_url, link_tags_json, ip_address, user_agent, created_at
)
SELECT
  id, dedupe_key, notification_id, event_type, delivery_id, mailing_id, ses_message_id,
  recipient_email, action_taken, occurred_at, bounce_type, bounce_sub_type,
  complaint_feedback_type, feedback_id, diagnostic_code, reject_reason,
  delivery_delay_type, link_url, link_tags_json, ip_address, user_agent, created_at
FROM ses_events_old;

INSERT INTO ses_simulator_runs (
  id, scenario, mode, purpose, mailing_id, delivery_id, recipient_email, target_base_url,
  status, expected_event_type, expected_suppression_reason, error_message, started_at, finished_at
)
SELECT
  r.id,
  r.scenario,
  r.mode,
  r.purpose,
  r.mailing_id,
  r.delivery_id,
  r.recipient_email,
  r.target_base_url,
  CASE
    WHEN r.status = 'failed'
      AND old_delivery.status = 'failed'
      AND latest.status = 'ambiguous'
      AND latest.ses_message_id IS NOT NULL
      AND (old_delivery.ses_message_id IS NULL OR old_delivery.ses_message_id = latest.ses_message_id)
      THEN 'sent'
    WHEN r.status = 'failed'
      AND old_delivery.status = 'failed'
      AND latest.status = 'ambiguous'
      THEN 'ambiguous'
    ELSE r.status
  END,
  r.expected_event_type,
  r.expected_suppression_reason,
  CASE
    WHEN r.status = 'failed'
      AND old_delivery.status = 'failed'
      AND latest.status = 'ambiguous'
      AND latest.ses_message_id IS NOT NULL
      AND (old_delivery.ses_message_id IS NULL OR old_delivery.ses_message_id = latest.ses_message_id)
      THEN NULL
    ELSE r.error_message
  END,
  r.started_at,
  r.finished_at
FROM ses_simulator_runs_old r
LEFT JOIN deliveries_old old_delivery ON old_delivery.id = r.delivery_id
LEFT JOIN send_attempts_old latest
  ON latest.delivery_id = old_delivery.id
 AND latest.attempt_no = (
   SELECT MAX(candidate.attempt_no)
   FROM send_attempts_old candidate
   WHERE candidate.delivery_id = old_delivery.id
 );

UPDATE suppressions AS s
SET reason = CASE
  WHEN EXISTS (
    SELECT 1
    FROM ses_events e
    WHERE e.recipient_email = s.email COLLATE NOCASE
      AND e.action_taken = 'suppressed'
      AND e.event_type = 'Complaint'
  ) THEN 'complaint'
  ELSE 'bounce'
END
WHERE s.scope = 'all'
  AND s.reason = 'manual'
  AND (
    EXISTS (
      SELECT 1
      FROM ses_events e
      WHERE e.recipient_email = s.email COLLATE NOCASE
        AND e.action_taken = 'suppressed'
        AND e.event_type = 'Complaint'
    )
    OR EXISTS (
      SELECT 1
      FROM ses_events e
      WHERE e.recipient_email = s.email COLLATE NOCASE
        AND e.action_taken = 'suppressed'
        AND e.event_type = 'Bounce'
        AND e.bounce_type = 'Permanent'
    )
  );

DROP TABLE send_attempts_old;
DROP TABLE jobs_old;
DROP TABLE ses_events_old;
DROP TABLE ses_simulator_runs_old;
DROP TABLE deliveries_old;

CREATE INDEX deliveries_mailing_id_idx ON deliveries (mailing_id);
CREATE INDEX deliveries_mailing_status_idx ON deliveries (mailing_id, status);
CREATE INDEX deliveries_email_idx ON deliveries (email);
CREATE INDEX deliveries_contact_id_idx ON deliveries (contact_id);
CREATE UNIQUE INDEX deliveries_ses_message_id_idx ON deliveries (ses_message_id)
  WHERE ses_message_id IS NOT NULL;
CREATE INDEX deliveries_created_id_idx ON deliveries (created_at DESC, id DESC);
CREATE INDEX jobs_state_run_at_idx ON jobs (state, run_at);
CREATE INDEX jobs_locked_until_idx ON jobs (locked_until);
CREATE INDEX jobs_delivery_id_idx ON jobs (delivery_id);
CREATE UNIQUE INDEX jobs_delivery_id_unique_idx ON jobs (delivery_id);
CREATE INDEX send_attempts_delivery_id_idx ON send_attempts (delivery_id);
CREATE INDEX send_attempts_job_id_idx ON send_attempts (job_id);
CREATE INDEX send_attempts_status_idx ON send_attempts (status);
CREATE INDEX send_attempts_ses_message_id_idx ON send_attempts (ses_message_id)
  WHERE ses_message_id IS NOT NULL;
CREATE INDEX ses_events_event_created_idx ON ses_events(event_type, created_at);
CREATE INDEX ses_events_delivery_id_idx ON ses_events(delivery_id);
CREATE INDEX ses_events_mailing_id_idx ON ses_events(mailing_id);
CREATE INDEX ses_events_ses_message_id_idx ON ses_events(ses_message_id);
CREATE INDEX ses_events_recipient_email_idx ON ses_events(recipient_email);
CREATE INDEX ses_events_link_url_idx ON ses_events(link_url);
CREATE INDEX ses_events_created_id_idx ON ses_events (created_at DESC, id DESC);
CREATE INDEX ses_simulator_runs_started_at_idx ON ses_simulator_runs(started_at);
CREATE INDEX ses_simulator_runs_status_idx ON ses_simulator_runs(status);

-- migrate:down
-- Lossy by design: delivery/simulator ambiguity did not exist before 0009 and maps to failed.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE send_attempts RENAME TO send_attempts_old;
ALTER TABLE jobs RENAME TO jobs_old;
ALTER TABLE ses_events RENAME TO ses_events_old;
ALTER TABLE ses_simulator_runs RENAME TO ses_simulator_runs_old;
ALTER TABLE deliveries RENAME TO deliveries_old;

DROP INDEX IF EXISTS send_attempts_delivery_id_idx;
DROP INDEX IF EXISTS send_attempts_job_id_idx;
DROP INDEX IF EXISTS send_attempts_status_idx;
DROP INDEX IF EXISTS send_attempts_ses_message_id_idx;
DROP INDEX IF EXISTS jobs_state_run_at_idx;
DROP INDEX IF EXISTS jobs_locked_until_idx;
DROP INDEX IF EXISTS jobs_delivery_id_idx;
DROP INDEX IF EXISTS jobs_delivery_id_unique_idx;
DROP INDEX IF EXISTS ses_events_event_created_idx;
DROP INDEX IF EXISTS ses_events_delivery_id_idx;
DROP INDEX IF EXISTS ses_events_mailing_id_idx;
DROP INDEX IF EXISTS ses_events_ses_message_id_idx;
DROP INDEX IF EXISTS ses_events_recipient_email_idx;
DROP INDEX IF EXISTS ses_events_link_url_idx;
DROP INDEX IF EXISTS ses_events_created_id_idx;
DROP INDEX IF EXISTS ses_simulator_runs_started_at_idx;
DROP INDEX IF EXISTS ses_simulator_runs_status_idx;
DROP INDEX IF EXISTS deliveries_mailing_id_idx;
DROP INDEX IF EXISTS deliveries_mailing_status_idx;
DROP INDEX IF EXISTS deliveries_email_idx;
DROP INDEX IF EXISTS deliveries_contact_id_idx;
DROP INDEX IF EXISTS deliveries_ses_message_id_idx;
DROP INDEX IF EXISTS deliveries_created_id_idx;

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

CREATE TABLE ses_events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  notification_id TEXT NOT NULL REFERENCES ses_notifications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'Send',
    'Rendering Failure',
    'Reject',
    'Delivery',
    'DeliveryDelay',
    'Bounce',
    'Complaint',
    'Subscription',
    'Open',
    'Click',
    'Unknown'
  )),
  delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
  mailing_id TEXT REFERENCES mailings(id) ON DELETE SET NULL,
  ses_message_id TEXT,
  recipient_email TEXT COLLATE NOCASE,
  action_taken TEXT NOT NULL CHECK (action_taken IN ('recorded', 'suppressed', 'ignored')),
  occurred_at TEXT,
  bounce_type TEXT,
  bounce_sub_type TEXT,
  complaint_feedback_type TEXT,
  feedback_id TEXT,
  diagnostic_code TEXT,
  reject_reason TEXT,
  delivery_delay_type TEXT,
  link_url TEXT,
  link_tags_json TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE ses_simulator_runs (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL CHECK (scenario IN ('success', 'bounce', 'complaint', 'ooto', 'suppressionlist')),
  mode TEXT NOT NULL CHECK (mode IN ('send_acceptance', 'end_to_end')),
  purpose TEXT NOT NULL CHECK (purpose IN ('transactional', 'marketing')),
  mailing_id TEXT REFERENCES mailings(id) ON DELETE SET NULL,
  delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
  recipient_email TEXT NOT NULL,
  target_base_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('started', 'sent', 'validated', 'failed', 'timed_out')),
  expected_event_type TEXT,
  expected_suppression_reason TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

INSERT INTO deliveries (
  id, mailing_id, email, contact_id, vars_json, status, ses_message_id, last_error,
  created_at, updated_at
)
SELECT
  id, mailing_id, email, contact_id, vars_json,
  CASE WHEN status = 'ambiguous' THEN 'failed' ELSE status END,
  ses_message_id, last_error, created_at, updated_at
FROM deliveries_old;

INSERT INTO jobs (
  id, state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id,
  last_error, created_at, updated_at
)
SELECT
  id, state, run_at, attempts, max_attempts, locked_by, locked_until, delivery_id,
  last_error, created_at, updated_at
FROM jobs_old;

INSERT INTO send_attempts (
  id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message,
  started_at, finished_at
)
SELECT
  id, delivery_id, job_id, attempt_no, status, ses_message_id, error_message,
  started_at, finished_at
FROM send_attempts_old;

INSERT INTO ses_events (
  id, dedupe_key, notification_id, event_type, delivery_id, mailing_id, ses_message_id,
  recipient_email, action_taken, occurred_at, bounce_type, bounce_sub_type,
  complaint_feedback_type, feedback_id, diagnostic_code, reject_reason,
  delivery_delay_type, link_url, link_tags_json, ip_address, user_agent, created_at
)
SELECT
  id, dedupe_key, notification_id, event_type, delivery_id, mailing_id, ses_message_id,
  recipient_email, action_taken, occurred_at, bounce_type, bounce_sub_type,
  complaint_feedback_type, feedback_id, diagnostic_code, reject_reason,
  delivery_delay_type, link_url, link_tags_json, ip_address, user_agent, created_at
FROM ses_events_old;

INSERT INTO ses_simulator_runs (
  id, scenario, mode, purpose, mailing_id, delivery_id, recipient_email, target_base_url,
  status, expected_event_type, expected_suppression_reason, error_message, started_at, finished_at
)
SELECT
  id, scenario, mode, purpose, mailing_id, delivery_id, recipient_email, target_base_url,
  CASE WHEN status = 'ambiguous' THEN 'failed' ELSE status END,
  expected_event_type, expected_suppression_reason, error_message, started_at, finished_at
FROM ses_simulator_runs_old;

DROP TABLE send_attempts_old;
DROP TABLE jobs_old;
DROP TABLE ses_events_old;
DROP TABLE ses_simulator_runs_old;
DROP TABLE deliveries_old;

CREATE INDEX deliveries_mailing_id_idx ON deliveries (mailing_id);
CREATE INDEX deliveries_mailing_status_idx ON deliveries (mailing_id, status);
CREATE INDEX deliveries_email_idx ON deliveries (email);
CREATE INDEX deliveries_contact_id_idx ON deliveries (contact_id);
CREATE UNIQUE INDEX deliveries_ses_message_id_idx ON deliveries (ses_message_id)
  WHERE ses_message_id IS NOT NULL;
CREATE INDEX deliveries_created_id_idx ON deliveries (created_at DESC, id DESC);
CREATE INDEX jobs_state_run_at_idx ON jobs (state, run_at);
CREATE INDEX jobs_locked_until_idx ON jobs (locked_until);
CREATE INDEX jobs_delivery_id_idx ON jobs (delivery_id);
CREATE UNIQUE INDEX jobs_delivery_id_unique_idx ON jobs (delivery_id);
CREATE INDEX send_attempts_delivery_id_idx ON send_attempts (delivery_id);
CREATE INDEX send_attempts_job_id_idx ON send_attempts (job_id);
CREATE INDEX send_attempts_status_idx ON send_attempts (status);
CREATE INDEX send_attempts_ses_message_id_idx ON send_attempts (ses_message_id)
  WHERE ses_message_id IS NOT NULL;
CREATE INDEX ses_events_event_created_idx ON ses_events(event_type, created_at);
CREATE INDEX ses_events_delivery_id_idx ON ses_events(delivery_id);
CREATE INDEX ses_events_mailing_id_idx ON ses_events(mailing_id);
CREATE INDEX ses_events_ses_message_id_idx ON ses_events(ses_message_id);
CREATE INDEX ses_events_recipient_email_idx ON ses_events(recipient_email);
CREATE INDEX ses_events_link_url_idx ON ses_events(link_url);
CREATE INDEX ses_events_created_id_idx ON ses_events (created_at DESC, id DESC);
CREATE INDEX ses_simulator_runs_started_at_idx ON ses_simulator_runs(started_at);
CREATE INDEX ses_simulator_runs_status_idx ON ses_simulator_runs(status);
