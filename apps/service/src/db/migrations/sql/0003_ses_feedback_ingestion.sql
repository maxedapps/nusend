-- migrate:up
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

-- migrate:down
DROP TABLE IF EXISTS ses_feedback_recipients;
DROP TABLE IF EXISTS ses_feedback_notifications;
