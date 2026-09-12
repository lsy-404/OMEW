CREATE TABLE oidc_sessions (
  session_jti TEXT PRIMARY KEY,
  localpart TEXT NOT NULL REFERENCES users(localpart) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  id_token_ciphertext TEXT,
  dpop_key_ciphertext TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX idx_oidc_sessions_localpart ON oidc_sessions(localpart);

ALTER TABLE oidc_login_completions ADD COLUMN refresh_token_ciphertext TEXT;
ALTER TABLE oidc_login_completions ADD COLUMN id_token_ciphertext TEXT;
ALTER TABLE oidc_login_completions ADD COLUMN dpop_key_ciphertext TEXT;
ALTER TABLE oidc_login_completions ADD COLUMN token_expires_at INTEGER;
