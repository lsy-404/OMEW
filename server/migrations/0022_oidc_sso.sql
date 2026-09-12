CREATE TABLE oidc_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  localpart TEXT NOT NULL REFERENCES users(localpart),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, subject),
  UNIQUE (localpart)
);

CREATE TABLE oidc_login_completions (
  code_hash TEXT PRIMARY KEY,
  localpart TEXT NOT NULL REFERENCES users(localpart),
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_oidc_login_completions_exp ON oidc_login_completions(expires_at);
