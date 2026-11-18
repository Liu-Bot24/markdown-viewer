// SQLite schema for the search index (better-sqlite3, WAL: one writer thread, readers elsewhere).
import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

export function openDb(file, { readonly = false } = {}) {
  const db = new Database(file, { readonly, fileMustExist: readonly });
  db.pragma('busy_timeout = 5000');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    migrate(db);
  }
  db.pragma('cache_size = -16000');
  return db;
}

function migrate(db) {
  const v = db.pragma('user_version', { simple: true });
  if (v === SCHEMA_VERSION) return;
  if (v !== 0) {
    // older layout: start over (the index is derived data)
    for (const t of ['msgs_fts', 'msgs', 'files', 'dirs', 'meta']) db.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS dirs (
      vpath TEXT PRIMARY KEY,
      parent TEXT,
      mtime REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dirs_parent ON dirs(parent);
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      vpath TEXT NOT NULL UNIQUE,
      dir TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime REAL NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      rows INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS files_dir ON files(dir);
    CREATE TABLE IF NOT EXISTS msgs (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL,
      anchor TEXT,
      ts TEXT,
      sender TEXT,
      sender_id TEXT,
      type TEXT,
      text TEXT
    );
    CREATE INDEX IF NOT EXISTS msgs_file ON msgs(file_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS msgs_fts USING fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 0');
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function getMeta(db, k, def = null) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return r ? JSON.parse(r.v) : def;
}

export function setMeta(db, k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
}

/** [lo, hi) bounds selecting every vpath under `prefix` ("/root/a" -> "/root/a/" .. "/root/a0"). */
export function prefixRange(prefix) {
  const p = prefix.replace(/\/+$/, '');
  return [p + '/', p + '0'];
}
