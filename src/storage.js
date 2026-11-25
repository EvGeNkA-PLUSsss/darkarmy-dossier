'use strict';
/* =========================================================
   storage.js — слой хранения метаданных на SQLite (node:sqlite).
   При первом запуске переносит пользователей/проекты/журнал/телеметрию
   из JSON в БД, оставляя JSON как архив (и делая резервную копию).
   ========================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dataDir = null;

const SCHEMA_VERSION = 1;

function nowIso() { return new Date().toISOString(); }

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function init({ dir }) {
  if (db) return db;
  dataDir = path.resolve(dir);
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'dossier.db');
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS changes (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL, action TEXT, actor TEXT,
      file TEXT, project_id TEXT, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changes_ts ON changes(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_changes_file ON changes(file);
    CREATE INDEX IF NOT EXISTS idx_changes_project ON changes(project_id);
    CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_user_ts ON telemetry(username, ts DESC);
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
  `);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  migrateFromJson();
  return db;
}

/* ---------- Миграция JSON → SQLite ---------- */
function readJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const bak = file + '.bak';
    if (fs.existsSync(bak)) {
      try { return JSON.parse(fs.readFileSync(bak, 'utf8')); } catch {}
    }
    throw new Error('Не удалось прочитать ' + path.basename(file) + ' для миграции: ' + e.message);
  }
}

function metaGet(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function metaSet(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function migrateFromJson() {
  if (metaGet('json_migrated') === '1') return;
  const usersFile = path.join(dataDir, 'users.json');
  const projectsFile = path.join(dataDir, 'projects.json');
  const changesFile = path.join(dataDir, 'changes.json');
  const telemetryDir = path.join(dataDir, 'telemetry');
  const hasAny = fs.existsSync(usersFile) || fs.existsSync(projectsFile) ||
    fs.existsSync(changesFile) || fs.existsSync(telemetryDir);
  if (!hasAny) { metaSet('json_migrated', '1'); return; }

  // Резервная копия перед миграцией — JSON не удаляем, он остаётся архивом.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dataDir, 'backup-pre-sqlite-' + stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const copyIfExists = (src, dstName) => {
    try { if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, dstName)); } catch {}
  };
  copyIfExists(usersFile, 'users.json');
  copyIfExists(projectsFile, 'projects.json');
  copyIfExists(changesFile, 'changes.json');
  fs.writeFileSync(path.join(backupDir, 'README.txt'),
    'Резервная копия JSON перед миграцией в SQLite (' + new Date().toISOString() + ').\n' +
    'Данные перенесены в dossier.db; JSON оставлены как архив.\n', 'utf8');

  const users = readJsonSafe(usersFile, { users: [] }).users || [];
  const projects = readJsonSafe(projectsFile, { projects: [] }).projects || [];
  const changes = readJsonSafe(changesFile, { entries: [] }).entries || [];
  let telemetryEvents = 0;

  tx(() => {
    for (const u of users) {
      if (!u || !u.id || !u.username) continue;
      db.prepare('INSERT OR IGNORE INTO users (id, username, payload) VALUES (?, ?, ?)')
        .run(u.id, u.username, JSON.stringify(u));
    }
    for (const p of projects) {
      if (!p || !p.id) continue;
      db.prepare('INSERT OR IGNORE INTO projects (id, payload) VALUES (?, ?)')
        .run(p.id, JSON.stringify(p));
    }
    for (const e of changes) {
      if (!e || !e.id) continue;
      db.prepare(`INSERT OR IGNORE INTO changes (id, ts, action, actor, file, project_id, payload)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(e.id, e.timestamp || nowIso(), e.action || null, e.user || null,
             e.file || null, e.projectId || null, JSON.stringify(e));
    }
    if (fs.existsSync(telemetryDir)) {
      for (const f of fs.readdirSync(telemetryDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(telemetryDir, f), 'utf8'));
          const username = d.username || f.replace(/\.json$/, '');
          for (const ev of (d.events || [])) {
            db.prepare('INSERT INTO telemetry (username, ts, payload) VALUES (?, ?, ?)')
              .run(username, ev.ts || nowIso(), JSON.stringify(ev));
            telemetryEvents++;
          }
        } catch {}
      }
    }
  });
  trimChanges();
  for (const row of listTelemetryUsers()) trimTelemetry(row.username);
  metaSet('json_migrated', '1');
  metaSet('json_migrated_at', nowIso());
  console.log(`[storage] JSON → SQLite: пользователей ${users.length}, проектов ${projects.length}, ` +
    `записей журнала ${changes.length}, событий телеметрии ${telemetryEvents}. ` +
    `Резервная копия: ${backupDir}`);
}

/* ---------- Пользователи ---------- */
function getUsers() {
  return db.prepare('SELECT payload FROM users ORDER BY rowid').all().map(r => JSON.parse(r.payload));
}
function replaceUsers(users) {
  tx(() => {
    db.exec('DELETE FROM users');
    const stmt = db.prepare('INSERT INTO users (id, username, payload) VALUES (?, ?, ?)');
    for (const u of users) stmt.run(u.id, u.username, JSON.stringify(u));
  });
}
function findUserByUsername(username) {
  const row = db.prepare('SELECT payload FROM users WHERE username = ?').get(username);
  return row ? JSON.parse(row.payload) : null;
}
function findUserById(id) {
  const row = db.prepare('SELECT payload FROM users WHERE id = ?').get(id);
  return row ? JSON.parse(row.payload) : null;
}
function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/* ---------- Проекты ---------- */
function getProjects() {
  return db.prepare('SELECT payload FROM projects ORDER BY rowid').all().map(r => JSON.parse(r.payload));
}
function replaceProjects(projects) {
  tx(() => {
    db.exec('DELETE FROM projects');
    const stmt = db.prepare('INSERT INTO projects (id, payload) VALUES (?, ?)');
    for (const p of projects) stmt.run(p.id, JSON.stringify(p));
  });
}

/* ---------- Журнал изменений ---------- */
function appendChange(entry) {
  const e = { id: entry.id || crypto.randomUUID(), timestamp: entry.timestamp || nowIso(), ...entry };
  db.prepare(`INSERT INTO changes (id, ts, action, actor, file, project_id, payload)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(e.id, e.timestamp, e.action || null, e.user || null,
         e.file || null, e.projectId || null, JSON.stringify(e));
  trimChanges();
  return e;
}
function trimChanges() {
  const max = 5000;
  const count = db.prepare('SELECT COUNT(*) AS n FROM changes').get().n;
  if (count <= max) return;
  db.prepare(`DELETE FROM changes WHERE id IN (
    SELECT id FROM changes ORDER BY ts ASC LIMIT ?)`).run(count - max);
}
function getChange(id) {
  const row = db.prepare('SELECT payload FROM changes WHERE id = ?').get(id);
  return row ? JSON.parse(row.payload) : null;
}
function updateChange(id, patch) {
  const cur = getChange(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  db.prepare('UPDATE changes SET payload = ?, action = ?, file = ?, project_id = ? WHERE id = ?')
    .run(JSON.stringify(next), next.action || null, next.file || null, next.projectId || null, id);
  return next;
}
function queryChanges({ file, projectId, days, limit = 500, offset = 0, full = false } = {}) {
  const where = [];
  const params = [];
  if (file) { where.push('file = ?'); params.push(file); }
  if (projectId) { where.push('project_id = ?'); params.push(projectId); }
  if (days) {
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
    where.push('ts >= ?'); params.push(since);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) AS n FROM changes ' + whereSql).get(...params).n;
  const rows = db.prepare('SELECT payload FROM changes ' + whereSql + ' ORDER BY ts DESC LIMIT ? OFFSET ?')
    .all(...params, limit, offset);
  let entries = rows.map(r => JSON.parse(r.payload));
  if (!full) entries = entries.map(({ before, after, ...rest }) => rest);
  return { entries, total };
}
function listAllChanges() {
  return db.prepare('SELECT payload FROM changes ORDER BY ts DESC').all().map(r => JSON.parse(r.payload));
}

/* ---------- Телеметрия ---------- */
function appendTelemetryBatch(username, events) {
  if (!username || !events.length) return;
  tx(() => {
    const stmt = db.prepare('INSERT INTO telemetry (username, ts, payload) VALUES (?, ?, ?)');
    for (const ev of events) stmt.run(username, ev.ts || nowIso(), JSON.stringify(ev));
  });
  trimTelemetry(username);
}
function trimTelemetry(username) {
  const max = 2000;
  const count = db.prepare('SELECT COUNT(*) AS n FROM telemetry WHERE username = ?').get(username).n;
  if (count <= max) return;
  db.prepare(`DELETE FROM telemetry WHERE id IN (
    SELECT id FROM telemetry WHERE username = ? ORDER BY ts ASC LIMIT ?)`).run(username, count - max);
}
function listTelemetryUsers() {
  return db.prepare(`SELECT username, COUNT(*) AS events, MAX(ts) AS lastSeen
                     FROM telemetry GROUP BY username ORDER BY lastSeen DESC`).all();
}
function getTelemetry(username, limit = 5000) {
  const rows = db.prepare('SELECT payload FROM telemetry WHERE username = ? ORDER BY ts DESC LIMIT ?')
    .all(username, limit);
  const events = rows.map(r => JSON.parse(r.payload));
  const first = db.prepare('SELECT ts FROM telemetry WHERE username = ? ORDER BY ts ASC LIMIT 1').get(username);
  return {
    username,
    events,
    firstSeen: first ? first.ts : null,
    lastSeen: events[0]?.ts || null,
  };
}
function clearTelemetry(username) {
  db.prepare('DELETE FROM telemetry WHERE username = ?').run(username);
}

/* ---------- Сессии (express-session store) ---------- */
function createSessionStore(expressSession) {
  class SqliteSessionStore extends expressSession.Store {
    constructor() {
      super();
      this.cleanupTimer = setInterval(() => this.clearExpired(), 15 * 60 * 1000);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
    get(sid, cb) {
      try {
        const row = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
        if (!row) return cb(null, null);
        if (row.expires <= Date.now()) { this.destroy(sid, () => {}); return cb(null, null); }
        cb(null, JSON.parse(row.sess));
      } catch (e) { cb(e); }
    }
    set(sid, sess, cb) {
      try {
        const expires = sess && sess.cookie && sess.cookie.expires
          ? new Date(sess.cookie.expires).getTime()
          : Date.now() + 7 * 86400 * 1000;
        db.prepare(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
                    ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`)
          .run(sid, JSON.stringify(sess), expires);
        cb && cb(null);
      } catch (e) { cb && cb(e); }
    }
    touch(sid, sess, cb) {
      try {
        const expires = sess && sess.cookie && sess.cookie.expires
          ? new Date(sess.cookie.expires).getTime()
          : Date.now() + 7 * 86400 * 1000;
        db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid);
        cb && cb(null);
      } catch (e) { cb && cb(e); }
    }
    destroy(sid, cb) {
      try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); }
      catch (e) { cb && cb(e); }
    }
    clearExpired() {
      try { db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()); } catch {}
    }
    length(cb) {
      try { cb(null, db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n); } catch (e) { cb(e); }
    }
  }
  return new SqliteSessionStore();
}

/* ---------- Диагностика ---------- */
function stats() {
  const file = path.join(dataDir, 'dossier.db');
  return {
    dbFile: file,
    sizeBytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    users: countUsers(),
    projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
    changes: db.prepare('SELECT COUNT(*) AS n FROM changes').get().n,
    telemetry: db.prepare('SELECT COUNT(*) AS n FROM telemetry').get().n,
    sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    schemaVersion: Number(metaGet('schema_version') || 0),
    jsonMigratedAt: metaGet('json_migrated_at'),
  };
}

function close() {
  if (db) { try { db.close(); } catch {} db = null; }
}

module.exports = {
  init, close, stats,
  getUsers, replaceUsers, findUserByUsername, findUserById, countUsers,
  getProjects, replaceProjects,
  appendChange, getChange, updateChange, queryChanges, listAllChanges,
  appendTelemetryBatch, listTelemetryUsers, getTelemetry, clearTelemetry,
  createSessionStore,
};
