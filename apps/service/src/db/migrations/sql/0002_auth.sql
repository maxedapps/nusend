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
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_organization_id TEXT
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

CREATE TABLE organizations (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  created_at DATE NOT NULL,
  metadata TEXT
);

CREATE TABLE organization_members (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at DATE NOT NULL
);

CREATE INDEX organization_members_organization_id_idx ON organization_members (organization_id);
CREATE INDEX organization_members_user_id_idx ON organization_members (user_id);
CREATE UNIQUE INDEX organization_members_org_user_uidx ON organization_members (organization_id, user_id);

CREATE TABLE organization_invitations (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT,
  status TEXT NOT NULL,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX organization_invitations_organization_id_idx ON organization_invitations (organization_id);
CREATE INDEX organization_invitations_email_idx ON organization_invitations (email);

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

-- migrate:down
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS organization_invitations;
DROP TABLE IF EXISTS organization_members;
DROP TABLE IF EXISTS organizations;
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
