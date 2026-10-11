CREATE TABLE IF NOT EXISTS own_signing_keys (
  instance TEXT NOT NULL, key_id TEXT NOT NULL, public_key TEXT NOT NULL,
  private_ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', retired_at INTEGER,
  prev_key_id TEXT, continuity_sig TEXT, revoked_at INTEGER, revocation_sig TEXT,
  PRIMARY KEY(instance, key_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS own_active_key ON own_signing_keys(instance) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS federation_blocklist (origin TEXT PRIMARY KEY, blocked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS federation_rate (bucket TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS federation_seen (origin TEXT NOT NULL, id TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(origin, id));
CREATE INDEX IF NOT EXISTS federation_seen_expiry ON federation_seen(expires_at);
CREATE TABLE IF NOT EXISTS federation_sessions (jti TEXT PRIMARY KEY, actor TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS federation_assertions (origin TEXT NOT NULL, jti TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(origin, jti));
CREATE TABLE IF NOT EXISTS federation_rooms (origin TEXT NOT NULL, room TEXT NOT NULL, high_water INTEGER NOT NULL DEFAULT 0, subscribed_until INTEGER NOT NULL,subscriber TEXT NOT NULL DEFAULT '',last_backfill INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'public', PRIMARY KEY(origin, room));
CREATE TABLE IF NOT EXISTS federation_events (origin TEXT NOT NULL, room TEXT NOT NULL, seq INTEGER NOT NULL, r2_key TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(origin, room, seq));
CREATE TABLE IF NOT EXISTS federation_items (origin TEXT NOT NULL, room TEXT NOT NULL, seq INTEGER NOT NULL, parent_seq INTEGER, root_seq INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL, r2_key TEXT NOT NULL, edit_key TEXT, edit_seq INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(origin,room,seq));
CREATE TABLE IF NOT EXISTS federation_ephemeral (origin TEXT NOT NULL, room TEXT NOT NULL, type TEXT NOT NULL, target INTEGER NOT NULL, version INTEGER NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY(origin, room, type, target));
CREATE TABLE IF NOT EXISTS federation_delivery (id TEXT NOT NULL, peer TEXT NOT NULL, envelope TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(id, peer));
CREATE TABLE IF NOT EXISTS federation_local_profile (actor TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, digest TEXT NOT NULL DEFAULT '', moved_to TEXT, aliases TEXT NOT NULL DEFAULT '[]', key_history TEXT NOT NULL DEFAULT '[]',ownership_entry TEXT);
CREATE TABLE IF NOT EXISTS ownership_pins (actor TEXT NOT NULL, key_id TEXT NOT NULL, public_key TEXT NOT NULL, created_at INTEGER NOT NULL, prev_key_id TEXT, continuity_sig TEXT, PRIMARY KEY(actor, key_id));
CREATE TABLE IF NOT EXISTS migration_challenges (nonce TEXT PRIMARY KEY, old_actor TEXT NOT NULL, new_actor TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE IF NOT EXISTS account_migrations (old_actor TEXT PRIMARY KEY, new_actor TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, proof TEXT NOT NULL, announcement_id TEXT, accepted_at INTEGER NOT NULL, effective_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS migration_edges (old_actor TEXT NOT NULL, new_actor TEXT NOT NULL, peer TEXT NOT NULL, state TEXT NOT NULL, challenge TEXT, proof TEXT, error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(old_actor, peer));
CREATE TABLE IF NOT EXISTS actor_aliases (old_actor TEXT PRIMARY KEY, new_actor TEXT NOT NULL, moved_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS migration_announcements (old_actor TEXT PRIMARY KEY, new_actor TEXT NOT NULL, id TEXT NOT NULL, mode TEXT NOT NULL, ts INTEGER NOT NULL, effective_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS federation_host_subscriptions (peer TEXT NOT NULL,room TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(peer,room));
