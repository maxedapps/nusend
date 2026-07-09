-- migrate:up
DROP TABLE IF EXISTS ses_feedback_recipients;
DROP TABLE IF EXISTS ses_feedback_notifications;

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

CREATE INDEX ses_notifications_received_at_idx ON ses_notifications(received_at);
CREATE INDEX ses_events_event_created_idx ON ses_events(event_type, created_at);
CREATE INDEX ses_events_delivery_id_idx ON ses_events(delivery_id);
CREATE INDEX ses_events_mailing_id_idx ON ses_events(mailing_id);
CREATE INDEX ses_events_ses_message_id_idx ON ses_events(ses_message_id);
CREATE INDEX ses_events_recipient_email_idx ON ses_events(recipient_email);
CREATE INDEX ses_events_link_url_idx ON ses_events(link_url);
CREATE INDEX ses_simulator_runs_started_at_idx ON ses_simulator_runs(started_at);
CREATE INDEX ses_simulator_runs_status_idx ON ses_simulator_runs(status);
CREATE INDEX worker_runs_finished_at_idx ON worker_runs(finished_at);

-- migrate:down
DROP TABLE IF EXISTS worker_runs;
DROP TABLE IF EXISTS ses_simulator_runs;
DROP TABLE IF EXISTS ses_events;
DROP TABLE IF EXISTS ses_notifications;

CREATE TABLE ses_feedback_notifications (
  sns_message_id TEXT PRIMARY KEY,
  sns_topic_arn TEXT NOT NULL,
  sns_type TEXT NOT NULL CHECK (sns_type IN ('Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation')),
  event_type TEXT,
  ses_message_id TEXT,
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE ses_feedback_recipients (
  id TEXT PRIMARY KEY,
  sns_message_id TEXT NOT NULL REFERENCES ses_feedback_notifications(sns_message_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  delivery_id TEXT REFERENCES deliveries(id) ON DELETE SET NULL,
  mailing_id TEXT REFERENCES mailings(id) ON DELETE SET NULL,
  ses_message_id TEXT,
  recipient_email TEXT NOT NULL COLLATE NOCASE,
  feedback_id TEXT,
  bounce_type TEXT,
  bounce_sub_type TEXT,
  complaint_feedback_type TEXT,
  diagnostic_code TEXT,
  action_taken TEXT NOT NULL CHECK (action_taken IN ('recorded', 'suppressed', 'ignored')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (sns_message_id, recipient_email, event_type)
);

CREATE INDEX ses_feedback_recipients_delivery_id_idx ON ses_feedback_recipients (delivery_id);
CREATE INDEX ses_feedback_recipients_ses_message_id_idx ON ses_feedback_recipients (ses_message_id);
CREATE INDEX ses_feedback_recipients_email_idx ON ses_feedback_recipients (recipient_email);
CREATE INDEX ses_feedback_recipients_event_created_idx ON ses_feedback_recipients (event_type, created_at);
