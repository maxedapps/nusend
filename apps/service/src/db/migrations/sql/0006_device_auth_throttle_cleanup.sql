-- migrate:up
ALTER TABLE device_authorizations DROP COLUMN user_code_attempts;
ALTER TABLE device_authorizations DROP COLUMN last_user_code_attempt_at;

-- migrate:down
ALTER TABLE device_authorizations ADD COLUMN user_code_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_authorizations ADD COLUMN last_user_code_attempt_at TEXT;
