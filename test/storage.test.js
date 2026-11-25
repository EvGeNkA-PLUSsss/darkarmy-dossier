'use strict';
/* Тесты слоя хранения: миграция JSON → SQLite, сессии, журнал. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('express-session');

const storage = require('../src/storage');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'da-storage-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(path.join(dataDir, 'telemetry'), { recursive: true });

const now = new Date().toISOString();
fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify({
  users: [
    { id: 'u1', username: 'admin', password: 'hash1', role: 'admin', theme: 'dark', createdAt: now },
    { id: 'u2', username: 'user2', password: 'hash2', role: 'member', theme: 'dark', createdAt: now },
  ],
}), 'utf8');
fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
  projects: [{ id: 'p1', name: 'Основной', folder: 'p1', creator: 'admin', members: [{ username: 'admin', role: 'creator' }], createdAt: now }],
}), 'utf8');
fs.writeFileSync(path.join(dataDir, 'changes.json'), JSON.stringify({
  entries: [
    { id: 'c1', timestamp: now, user: 'admin', action: 'create', file: 'a.md', projectId: 'p1', after: 'hello' },
    { id: 'c2', timestamp: now, user: 'admin', action: 'edit', file: 'a.md', projectId: 'p1', before: 'hello', after: 'world' },
  ],
}), 'utf8');
fs.writeFileSync(path.join(dataDir, 'telemetry', 'admin.json'), JSON.stringify({
  username: 'admin', firstSeen: now, lastSeen: now,
  events: [{ ts: now, type: 'login' }, { ts: now, type: 'request' }, { ts: now, type: 'request' }],
}), 'utf8');
// JSON-документы, которые должны переехать в таблицу documents
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ uploadLimitMB: 42, generalChatMode: 'everyone' }), 'utf8');
fs.writeFileSync(path.join(dataDir, 'invites.json'), JSON.stringify({ codes: [{ code: 'TESTCODE', usedBy: null }] }), 'utf8');
fs.writeFileSync(path.join(dataDir, 'chat.json'), JSON.stringify({ messages: [{ id: 'm1', from: 'admin', to: 'general', text: 'hello' }] }), 'utf8');

test.after(() => {
  storage.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('миграция JSON → SQLite переносит пользователей, проекты, журнал и телеметрию', () => {
  storage.init({ dir: dataDir });
  assert.equal(storage.getUsers().length, 2);
  assert.equal(storage.getUsers().find(u => u.username === 'admin').role, 'admin');
  assert.equal(storage.getProjects().length, 1);
  assert.equal(storage.getProjects()[0].name, 'Основной');
  assert.equal(storage.queryChanges({ full: true }).total, 2);
  assert.equal(storage.getTelemetry('admin').events.length, 3);
  const stats = storage.stats();
  assert.equal(stats.users, 2);
  assert.equal(stats.changes, 2);
  assert.ok(stats.sizeBytes > 0);
  // JSON остаются архивом + есть резервная копия перед миграцией
  assert.ok(fs.existsSync(path.join(dataDir, 'users.json')));
  const backups = fs.readdirSync(dataDir).filter(f => f.startsWith('backup-pre-sqlite-'));
  assert.equal(backups.length, 1);
});

test('документы JSON → SQLite: настройки, инвайты, чат; запись поверх', () => {
  assert.equal(storage.getDoc('settings', {}).uploadLimitMB, 42);
  assert.equal(storage.getDoc('invites', {}).codes[0].code, 'TESTCODE');
  assert.equal(storage.getDoc('chat', {}).messages[0].text, 'hello');
  storage.setDoc('settings', { uploadLimitMB: 7 });
  assert.equal(storage.getDoc('settings', {}).uploadLimitMB, 7);
  // отсутствующий документ возвращает дефолт и не падает
  assert.deepEqual(storage.getDoc('trash', { items: [] }), { items: [] });
  const backups = fs.readdirSync(dataDir).filter(f => f.startsWith('backup-pre-docs-'));
  assert.equal(backups.length, 1);
});

test('повторный запуск не дублирует данные (миграция идемпотентна)', () => {
  storage.close();
  storage.init({ dir: dataDir });
  assert.equal(storage.getUsers().length, 2);
  assert.equal(storage.getProjects().length, 1);
  assert.equal(storage.queryChanges({}).total, 2);
});

test('журнал: добавление, фильтры, пагинация, обновление revert-флага', () => {
  const e = storage.appendChange({ user: 'admin', action: 'edit', file: 'b.md', projectId: 'p1', before: 'x', after: 'y' });
  assert.ok(e.id);
  const byFile = storage.queryChanges({ file: 'b.md', full: true });
  assert.equal(byFile.total, 1);
  assert.equal(byFile.entries[0].after, 'y');
  const page = storage.queryChanges({ limit: 1, offset: 0 });
  assert.equal(page.entries.length, 1);
  assert.ok(page.total >= 3);
  const updated = storage.updateChange(e.id, { reverted: true, revertedBy: 'admin' });
  assert.equal(updated.reverted, true);
  assert.equal(storage.getChange(e.id).reverted, true);
});

test('телеметрия: батч, лимит, очистка', () => {
  storage.appendTelemetryBatch('user2', [
    { ts: now, type: 'login' },
    { ts: now, type: 'request', path: '/api/me' },
  ]);
  const t = storage.getTelemetry('user2');
  assert.equal(t.events.length, 2);
  assert.ok(storage.listTelemetryUsers().some(u => u.username === 'user2'));
  storage.clearTelemetry('user2');
  assert.equal(storage.getTelemetry('user2').events.length, 0);
});

test('сессии сохраняются в SQLite и переживают пересоздание store', async () => {
  const store1 = storage.createSessionStore(session);
  const sess = { cookie: { expires: new Date(Date.now() + 3600000) }, user: { id: 'u1', username: 'admin', role: 'admin' } };
  await new Promise((resolve, reject) => store1.set('sid-test-1', sess, e => e ? reject(e) : resolve()));
  const store2 = storage.createSessionStore(session);
  const loaded = await new Promise((resolve, reject) => store2.get('sid-test-1', (e, s) => e ? reject(e) : resolve(s)));
  assert.equal(loaded.user.username, 'admin');
  await new Promise((resolve, reject) => store2.destroy('sid-test-1', e => e ? reject(e) : resolve()));
  const after = await new Promise((resolve, reject) => store2.get('sid-test-1', (e, s) => e ? reject(e) : resolve(s)));
  assert.equal(after, null);
});
