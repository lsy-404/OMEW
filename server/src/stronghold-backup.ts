import { createHash } from "node:crypto";
import { gzipJsonLines, putArchiveStream, readGzipJsonLines } from "./archive";

const BASE_TABLES = ["config", "room", "member", "ban", "tip"] as const;
const OPTIONAL_TABLES = ["member_migration", "control_event"] as const;
const TABLES = new Set<string>([...BASE_TABLES, ...OPTIONAL_TABLES]);
const SNAPSHOT_TABLE = "stronghold_backup_snapshot";
const RESTORE_TABLE = "stronghold_restore_stage";

export interface StrongholdSnapshotResult {
  r2_key: string;
  sha256: string;
  bytes: number;
}

function validId(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function existingTables(state: DurableObjectState): string[] {
  const names = new Set(state.storage.sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).toArray().map((row) => row.name));
  return [...BASE_TABLES, ...OPTIONAL_TABLES].filter((name) => names.has(name));
}

function ensureStageTables(state: DurableObjectState): void {
  state.storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
      backup_id TEXT NOT NULL, row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL, row_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stronghold_backup_snapshot ON ${SNAPSHOT_TABLE}(backup_id, row_id);
    CREATE TABLE IF NOT EXISTS ${RESTORE_TABLE} (
      backup_id TEXT NOT NULL, row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL, row_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stronghold_restore_stage ON ${RESTORE_TABLE}(backup_id, row_id);
  `);
}

export async function exportStrongholdSnapshot(
  state: DurableObjectState,
  env: Env,
  id: string,
  backupId: string,
): Promise<StrongholdSnapshotResult> {
  if (!validId(backupId)) throw new Error("invalid backup id");
  ensureStageTables(state);
  const sql = state.storage.sql;
  const tables = existingTables(state);
  if (!BASE_TABLES.every((name) => tables.includes(name))) throw new Error("stronghold schema is incomplete");
  const columns = Object.fromEntries(tables.map((table) => [
    table,
    sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((column) => column.name),
  ]));
  const configId = sql.exec<{ id: string }>("SELECT id FROM config LIMIT 1").toArray()[0]?.id;
  if (configId !== id) throw new Error("stronghold identity mismatch");
  sql.exec(`DELETE FROM ${SNAPSHOT_TABLE} WHERE backup_id = ?`, backupId);
  state.storage.transactionSync(() => {
    for (const table of tables) {
      const jsonArgs = columns[table]!.map((column) => `\'${column}\', "${column}"`).join(", ");
      sql.exec(
        `INSERT INTO ${SNAPSHOT_TABLE} (backup_id, table_name, row_json) ` +
        `SELECT ?, ?, json_object(${jsonArgs}) FROM ${table}`,
        backupId, table,
      );
    }
  });

  const key = `backups/strongholds/${encodeURIComponent(id)}/${backupId}.ndjson.gz`;
  let headerPending = true;
  let lastRowId = 0;
  const staged: { row_id: number; table_name: string; row_json: string }[] = [];
  const header = JSON.stringify({ type: "snapshot", schema: 1, stronghold_id: id, tables, columns, created_at: Date.now() });
  const compressed = gzipJsonLines(async () => {
    if (headerPending) { headerPending = false; return header; }
    if (!staged.length) staged.push(...sql.exec<{ row_id: number; table_name: string; row_json: string }>(
      `SELECT row_id, table_name, row_json FROM ${SNAPSHOT_TABLE} WHERE backup_id = ? AND row_id > ? ORDER BY row_id LIMIT 100`,
      backupId, lastRowId,
    ).toArray());
    const record = staged.shift();
    if (!record) return null;
    lastRowId = record.row_id;
    return JSON.stringify({ type: "row", table: record.table_name, data: JSON.parse(record.row_json) });
  });
  try {
    await putArchiveStream(env.MEDIA, key, compressed.stream, id, 0, 0);
    const object = await env.MEDIA.head(key);
    if (!object) throw new Error("stronghold snapshot write did not complete");
    return { r2_key: key, sha256: compressed.getHash(), bytes: object.size };
  } finally {
    sql.exec(`DELETE FROM ${SNAPSHOT_TABLE} WHERE backup_id = ?`, backupId);
  }
}

export async function restoreStrongholdSnapshot(
  state: DurableObjectState,
  env: Env,
  id: string,
  backupId: string,
  r2Key: string,
  expectedSha256: string,
): Promise<number> {
  if (!validId(backupId)) throw new Error("invalid backup id");
  if (!r2Key.startsWith(`backups/strongholds/${encodeURIComponent(id)}/`) || !r2Key.endsWith(`/${backupId}.ndjson.gz`)) {
    throw new Error("stronghold snapshot key mismatch");
  }
  ensureStageTables(state);
  const sql = state.storage.sql;
  const available = new Set(existingTables(state));
  const object = await env.MEDIA.get(r2Key);
  if (!object?.body) throw new Error("stronghold snapshot not found");
  let headerSeen = false;
  let snapshotTables: string[] = [];
  let snapshotColumns: Record<string, string[]> = {};
  let rows = 0;
  const digest = createHash("sha256");
  sql.exec(`DELETE FROM ${RESTORE_TABLE} WHERE backup_id = ?`, backupId);
  try {
    const verifiedBody = object.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { digest.update(chunk); controller.enqueue(chunk); },
    }));
    await readGzipJsonLines(verifiedBody, (record) => {
      if (!headerSeen) {
        const candidateTables = record.tables;
        const candidateColumns = record.columns;
        if (record.type !== "snapshot" || record.schema !== 1 || record.stronghold_id !== id ||
            !Array.isArray(candidateTables) || !candidateTables.every((table): table is string =>
              typeof table === "string" && TABLES.has(table) && available.has(table)
            ) || !BASE_TABLES.every((table) => candidateTables.includes(table)) ||
            new Set(candidateTables).size !== candidateTables.length || !candidateColumns ||
            typeof candidateColumns !== "object" || Array.isArray(candidateColumns)) {
          throw new Error("invalid stronghold snapshot header");
        }
        snapshotTables = candidateTables;
        snapshotColumns = candidateColumns as Record<string, string[]>;
        for (const table of snapshotTables) {
          const actual = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((column) => column.name);
          const source = snapshotColumns[table];
          if (!Array.isArray(source) || source.length !== actual.length || source.some((column, index) => column !== actual[index])) {
            throw new Error("stronghold snapshot schema mismatch");
          }
        }
        headerSeen = true;
        return;
      }
      const table = record.table;
      const data = record.data;
      if (record.type !== "row" || typeof table !== "string" || !TABLES.has(table) ||
          !snapshotTables.includes(table) || !data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("invalid stronghold snapshot row");
      }
      const names = Object.keys(data as Record<string, unknown>);
      const columns = snapshotColumns[table]!;
      if (names.length !== columns.length || names.some((name) => !columns.includes(name))) {
        throw new Error("invalid stronghold snapshot columns");
      }
      sql.exec(`INSERT INTO ${RESTORE_TABLE} (backup_id, table_name, row_json) VALUES (?, ?, ?)`, backupId, table, JSON.stringify(data));
      rows++;
    });
    if (!headerSeen) throw new Error("stronghold snapshot header missing");
    if (digest.digest("hex") !== expectedSha256) throw new Error("stronghold snapshot checksum mismatch");
    const stagedConfig = sql.exec<{ row_json: string }>(
      `SELECT row_json FROM ${RESTORE_TABLE} WHERE backup_id = ? AND table_name = 'config'`, backupId,
    ).toArray();
    const configs = stagedConfig.map((row) => JSON.parse(row.row_json) as { id?: unknown; owner_actor?: unknown });
    if (configs.length !== 1 || configs[0]!.id !== id || typeof configs[0]!.owner_actor !== "string") {
      throw new Error("stronghold snapshot config invalid");
    }
    const ownerActor = configs[0]!.owner_actor;
    const owner = sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${RESTORE_TABLE} WHERE backup_id = ? AND table_name = 'member' AND json_extract(row_json, '$.actor') = ? AND json_extract(row_json, '$.role') = 'owner'`,
      backupId, ownerActor,
    ).one().count;
    if (owner !== 1) throw new Error("stronghold snapshot owner missing");

    state.storage.transactionSync(() => {
      const nonEmpty = snapshotTables.some((table) => sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count > 0);
      if (nonEmpty) throw new Error("stronghold restore target is not empty");
      for (const table of snapshotTables) {
        const columns = snapshotColumns[table]!;
        const quoted = columns.map((column) => `"${column}"`).join(", ");
        const values = columns.map((column) => `json_extract(row_json, '$.${column}')`).join(", ");
        sql.exec(
          `INSERT INTO ${table} (${quoted}) SELECT ${values} FROM ${RESTORE_TABLE} WHERE backup_id = ? AND table_name = ? ORDER BY row_id`,
          backupId, table,
        );
      }
    });
    return rows;
  } finally {
    sql.exec(`DELETE FROM ${RESTORE_TABLE} WHERE backup_id = ?`, backupId);
  }
}
