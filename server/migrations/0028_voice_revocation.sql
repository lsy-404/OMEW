CREATE TABLE IF NOT EXISTS voice_revocations (
  job_key TEXT PRIMARY KEY,
  room_ref TEXT NOT NULL,
  actor TEXT,
  revoke_token_ts INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_revocations_due
  ON voice_revocations(next_attempt_at);
