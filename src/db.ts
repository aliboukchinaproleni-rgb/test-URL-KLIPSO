import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

const file = resolve(config.databaseFile);
mkdirSync(dirname(file), { recursive: true });

export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  client     TEXT,
  owner      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS endpoints (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('front','back')),
  label            TEXT,
  url              TEXT NOT NULL,
  priority         TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P1','P2','P3')),
  method           TEXT NOT NULL DEFAULT 'GET' CHECK (method IN ('GET','HEAD')),
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  timeout_ms       INTEGER NOT NULL DEFAULT 10000,
  slow_ms          INTEGER NOT NULL DEFAULT 3000,
  expected_status  INTEGER NOT NULL DEFAULT 200,
  keyword_expect   TEXT,
  keyword_forbid   TEXT,
  auth_user        TEXT,
  auth_pass        TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_endpoints_project ON endpoints(project_id);

CREATE TABLE IF NOT EXISTS endpoint_state (
  endpoint_id          INTEGER PRIMARY KEY REFERENCES endpoints(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'unknown',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at      TEXT,
  last_ok_at           TEXT,
  last_response_ms     INTEGER,
  last_http_status     INTEGER,
  last_error           TEXT,
  next_check_at        TEXT NOT NULL DEFAULT (datetime('now')),
  cert_expires_at      TEXT,
  cert_checked_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_state_next_check ON endpoint_state(next_check_at);

CREATE TABLE IF NOT EXISTS checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id    INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  checked_at     TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL,
  http_status    INTEGER,
  response_ms    INTEGER,
  error          TEXT,
  cert_days_left INTEGER
);
CREATE INDEX IF NOT EXISTS idx_checks_endpoint_time ON checks(endpoint_id, checked_at DESC);

-- Agrégats journaliers : survivent à la purge du détail.
CREATE TABLE IF NOT EXISTS daily_stats (
  endpoint_id   INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  day           TEXT NOT NULL,
  total_checks  INTEGER NOT NULL DEFAULT 0,
  failed_checks INTEGER NOT NULL DEFAULT 0,
  slow_checks   INTEGER NOT NULL DEFAULT 0,
  sum_ms        INTEGER NOT NULL DEFAULT 0,
  max_ms        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (endpoint_id, day)
);

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  resolved_at TEXT,
  cause       TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_endpoint ON incidents(endpoint_id, started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Purge le détail ancien ; les agrégats journaliers restent disponibles. */
export function purgeOldChecks(): number {
  const result = db
    .prepare(`DELETE FROM checks WHERE checked_at < datetime('now', ?)`)
    .run(`-${config.retentionDays} days`);
  return result.changes;
}
