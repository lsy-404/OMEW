# Archive, search, and backup operations

## Room history and search

Room history remains ordered by `seq`. A RoomDO alarm archives eligible rows into immutable gzip NDJSON objects at 10,000 items per shard, writes the D1 archive index and search source rows, then removes only those item rows from the hot SQLite table. Re-running an interrupted archive uses the same object key and replaces the D1 range/search rows before deleting hot rows. `meta.next_seq`, dedupe records, edits, tombstones, reactions, and section post indexes stay in the room database.

Section root posts stay in the room database so the post feed and its bump ordering remain directly readable. Replies can move to archive shards; post detail merges hot and archived replies. Reactions remain hot-only as specified by the protocol.

Search is room-scoped and uses D1 FTS5 for archived items plus a bounded recent scan of hot items. The search endpoint uses the same stronghold visibility, membership, and restricted-room checks as history. Current tombstones suppress archived matches, and edit overlays replace the displayed search text.

The left post pane searches the selected section; the chat pane searches the selected channel. Search hits open the containing post or load and scroll to the matching chat message/reply. History responses include `next_before` and `has_more`; the cursor advances by scanned sequence so a run of deleted cold rows cannot look like the end of history.

## Owner room snapshots

The stronghold owner can use these authenticated endpoints for a room:

```text
POST /api/stronghold/{id}/rooms/{resId}/backups
GET  /api/stronghold/{id}/rooms/{resId}/backups/{backupId}
POST /api/stronghold/{id}/rooms/{resId}/restore  {"backup_id":"..."}
```

The first endpoint snapshots the room's complete RoomDO SQLite tables to a gzip NDJSON object in the configured R2 bucket and records the owner, original room key, digest, and length in D1. The GET endpoint streams that file only to the same room's current owner. Restore accepts only a backup registered for the same stable room key. It stages and validates the snapshot, then atomically restores it only when the RoomDO has no items, tombstones, edits, dedupe records, post indexes, reactions, or subscriptions. If new writes arrive while the backup is being read, the final empty-room check rejects the restore without replacing those writes.

These snapshots cover the RoomDO database. Cold archive objects remain in R2 and their range/search metadata remains in D1, so disaster recovery also requires the original R2 archive objects and a D1 dump. Room snapshots are not portable between rooms or deployments.

## Stronghold governance snapshots

Stronghold governance state is a separate Durable Object database. Its snapshot includes the complete SQL columns and rows from `config`, `room`, `member`, `ban`, and `tip`, plus `member_migration` and `control_event` when those tables exist. It preserves the original stronghold ID, owner membership, room registration, restrictions, bans, and tips. Restore validates the complete gzip stream, digest, table allowlist, schema columns, owner row, and stronghold identity before writing; it only accepts a target whose governance tables are empty.

For a full recovery, restore the D1 database and R2 bucket, then restore the StrongholdDO governance snapshot before restoring each RoomDO snapshot. Use the original stronghold ID and instance domain. Configure the recovered instance in multi mode before starting Workers so single-mode auto-bootstrap cannot create replacement state. Preserve `DEV_TOKEN_SECRET` and the other service secrets used by the deployment. Stronghold governance snapshots do not contain room messages or archive shard bodies; RoomDO snapshots and the original R2 archive objects are still required.

## D1 export and restore

D1's `wrangler d1 export` does not export a database containing virtual tables. The project script works around that limitation by exporting the ordinary D1 tables individually. `archive_document` is the durable source for archived search text; the script rebuilds the FTS5 index after importing it.

Quiesce writes to the instance while exporting the individual tables so the files describe one operational point. Keep the R2 bucket available or mirror it separately; D1 data alone does not contain archive shard bodies.

```sh
scripts/backup-d1.sh dump ./backup/d1
```

To restore, point `OMEW_D1_DATABASE` at a new empty D1 database, make its binding available in the Wrangler configuration, then run:

```sh
OMEW_D1_DATABASE=openmew-restore scripts/backup-d1.sh restore ./backup/d1
```

The script requires typing the target database name, applies the repository's current D1 migrations, and imports each ordinary table. Restore into an existing populated database is unsupported. The command requires Cloudflare credentials with D1 access.

For recovery within D1's available point-in-time window, Wrangler also provides `pnpm exec wrangler d1 time-travel restore <database> --remote --timestamp <time>`.
