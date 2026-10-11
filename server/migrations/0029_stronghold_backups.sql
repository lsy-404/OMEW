CREATE TABLE IF NOT EXISTS stronghold_backup (
  id TEXT PRIMARY KEY,
  stronghold_id TEXT NOT NULL,
  owner_actor TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stronghold_backup_owner_created
  ON stronghold_backup(stronghold_id, owner_actor, created_at DESC);
