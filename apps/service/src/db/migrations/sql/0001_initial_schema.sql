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
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
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
  requester_fingerprint_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX device_authorizations_expires_at_idx ON device_authorizations (expires_at);
CREATE INDEX device_authorizations_approved_user_idx ON device_authorizations (approved_by_user_id);

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

CREATE INDEX mailings_purpose_state_idx ON mailings (purpose, state);
CREATE INDEX mailings_scheduled_at_idx ON mailings (scheduled_at);
CREATE INDEX mailings_list_id_idx ON mailings (list_id);
CREATE INDEX mailings_created_id_idx ON mailings (created_at DESC, id DESC);

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

CREATE INDEX deliveries_mailing_id_idx ON deliveries (mailing_id);
CREATE INDEX deliveries_mailing_status_idx ON deliveries (mailing_id, status);
CREATE INDEX deliveries_email_idx ON deliveries (email);
CREATE INDEX deliveries_contact_id_idx ON deliveries (contact_id);
CREATE UNIQUE INDEX deliveries_ses_message_id_idx ON deliveries (ses_message_id)
  WHERE ses_message_id IS NOT NULL;
CREATE INDEX deliveries_created_id_idx ON deliveries (created_at DESC, id DESC);

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

CREATE INDEX jobs_state_run_at_idx ON jobs (state, run_at);
CREATE INDEX jobs_locked_until_idx ON jobs (locked_until);
CREATE UNIQUE INDEX jobs_delivery_id_unique_idx ON jobs (delivery_id);

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

CREATE INDEX send_attempts_delivery_id_idx ON send_attempts (delivery_id);
CREATE INDEX send_attempts_job_id_idx ON send_attempts (job_id);
CREATE INDEX send_attempts_status_idx ON send_attempts (status);
CREATE INDEX send_attempts_ses_message_id_idx ON send_attempts (ses_message_id)
  WHERE ses_message_id IS NOT NULL;

CREATE TABLE mailing_idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  mailing_id TEXT NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX mailing_idempotency_keys_mailing_id_idx
  ON mailing_idempotency_keys (mailing_id);

CREATE TABLE ses_notifications (
  id TEXT PRIMARY KEY,
  sns_message_id TEXT NOT NULL UNIQUE,
  sns_topic_arn TEXT NOT NULL,
  sns_type TEXT NOT NULL CHECK (sns_type IN ('Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation')),
  ses_message_id TEXT,
  event_type TEXT,
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX ses_notifications_received_at_idx ON ses_notifications(received_at);

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

CREATE INDEX ses_events_event_created_idx ON ses_events(event_type, created_at);
CREATE INDEX ses_events_delivery_id_idx ON ses_events(delivery_id);
CREATE INDEX ses_events_mailing_id_idx ON ses_events(mailing_id);
CREATE INDEX ses_events_ses_message_id_idx ON ses_events(ses_message_id);
CREATE INDEX ses_events_recipient_email_idx ON ses_events(recipient_email);
CREATE INDEX ses_events_link_url_idx ON ses_events(link_url);
CREATE INDEX ses_events_created_id_idx ON ses_events (created_at DESC, id DESC);

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

CREATE INDEX ses_simulator_runs_started_at_idx ON ses_simulator_runs(started_at);
CREATE INDEX ses_simulator_runs_status_idx ON ses_simulator_runs(status);

CREATE TABLE worker_runs (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('once', 'loop')),
  released INTEGER NOT NULL,
  claimed INTEGER NOT NULL,
  succeeded INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  dead INTEGER NOT NULL,
  skipped_stale INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE INDEX worker_runs_finished_at_idx ON worker_runs(finished_at);
