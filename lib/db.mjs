import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'freetotalk.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 4000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  karma INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- lat/lng are stored ROUNDED (about 100 m grid) — the exact spot is never saved.
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  cat TEXT NOT NULL,
  text TEXT NOT NULL,
  image TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  up INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'live',   -- live | hidden (auto/admin) | removed
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_geo ON posts(lat, lng);
CREATE INDEX IF NOT EXISTS posts_exp ON posts(expires_at);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  reports INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'live',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_post ON replies(post_id);

CREATE TABLE IF NOT EXISTS votes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  v INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,          -- post | reply
  target_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, target_id, user_id)
);

-- "blocker no longer sees anything written by blocked"
CREATE TABLE IF NOT EXISTS blocks (
  blocker INTEGER NOT NULL,
  blocked INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- A ban follows the phone itself (hashed device id from the app), not just the anonymous cookie.
CREATE TABLE IF NOT EXISTS banned_devices (device_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
`);
try { db.exec('ALTER TABLE users ADD COLUMN device_hash TEXT'); } catch { /* already there */ }
// Personal recovery code (stored only as a hash) + extra logins on other phones.
try { db.exec('ALTER TABLE users ADD COLUMN code_hash TEXT'); } catch { /* already there */ }
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_code ON users(code_hash)');
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`);
// Locked messages: readable only by people who physically reach the spot (then stay open for them).
try { db.exec('ALTER TABLE posts ADD COLUMN locked INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
db.exec(`CREATE TABLE IF NOT EXISTS unlocks (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS users_device ON users(device_hash)');

export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const DEFAULTS = {
  // Test spots let you try the app without real GPS (needed while the site is on plain http).
  testMode: '1',
  postTtlHours: '24',
  reportsToHide: '3',
  downvotesToHide: '5',
  postsPerHour: '5',
  repliesPerHour: '30',
  // Words that block a post/reply. Edit freely from /admin (one per line).
  bannedWords: '',
};
for (const [k, v] of Object.entries(DEFAULTS)) run('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)', k, v);

export function getSettings() {
  const s = {};
  for (const r of all('SELECT key, value FROM settings')) s[r.key] = r.value;
  return s;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}
