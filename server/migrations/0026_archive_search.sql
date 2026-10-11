-- Archive search and room-scoped backup metadata.
ALTER TABLE archive_index ADD COLUMN content_sha256 TEXT;
ALTER TABLE archive_index ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS archive_document (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  do_key TEXT NOT NULL,
  seq TEXT NOT NULL,
  text,
  actor TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  root_seq TEXT NOT NULL,
  UNIQUE(do_key, seq)
);
CREATE INDEX IF NOT EXISTS idx_archive_document_room_seq ON archive_document(do_key, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS archive_search USING fts5(
  do_key UNINDEXED,
  seq UNINDEXED,
  text,
  actor UNINDEXED,
  ts UNINDEXED,
  kind UNINDEXED,
  root_seq UNINDEXED,
  content = 'archive_document',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS room_backup (
  id TEXT PRIMARY KEY,
  do_key TEXT NOT NULL,
  owner_actor TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS room_backup_room_owner ON room_backup(do_key, owner_actor, created_at DESC);
