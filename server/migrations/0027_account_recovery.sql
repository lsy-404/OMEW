ALTER TABLE users ADD COLUMN sessions_revoked_at INTEGER;

CREATE TABLE account_action_tokens (
  token_hash TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('email_verification', 'password_reset')),
  localpart TEXT,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_account_action_tokens_expiry ON account_action_tokens(expires_at);
CREATE INDEX idx_account_action_tokens_account ON account_action_tokens(action, localpart);

CREATE TABLE account_action_limits (
  action TEXT NOT NULL CHECK (action IN ('email_verification', 'password_reset')),
  identity_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (action, identity_hash)
);

CREATE INDEX idx_account_action_limits_window ON account_action_limits(window_start);
