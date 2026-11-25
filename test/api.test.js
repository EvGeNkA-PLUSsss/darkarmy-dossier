'use strict';
/* API-тесты: безопасность отдачи файлов, права, админ-инварианты, пагинация. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'da-api-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');
process.env.BACKUP_DIR = path.join(tmp, 'backups');
process.env.SESSION_SECRET = 'api-secret';
process.env.LOGIN_MAX_ATTEMPTS = '1000';
process.env.IMPORT_MAX_ATTEMPTS = '1000';
process.env.ADMIN_PASSWORD = 'AdminTest123!Pass';
process.env.NODE_ENV = 'test';

const { app } = require('../server');

let server;
let base;

function makeClient() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async request(url, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (cookie) headers.cookie = cookie;
      const res = await fetch(base + url, { ...opts, headers, redirect: 'manual' });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setCookies.length) cookie = setCookies.map(c => c.split(';')[0]).join('; ');
      return res;
    },
    async json(url, opts = {}) {
      const res = await this.request(url, opts);
      let body = null;
      try { body = await res.json(); } catch {}
      return { res, body };
    },
    async login(username, password) {
      const { res } = await this.json('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(res.status, 200, 'логин должен проходить');
    },
  };
}

const admin = makeClient();
let adminId = '';

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
  await admin.login('admin', 'AdminTest123!Pass');
  const me = await admin.json('/api/me');
  adminId = me.body.user.id;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('health отвечает ok', async () => {
  const { res, body } = await admin.json('/api/health');
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
});

test('version отдаёт версию и build для автообновления вкладок', async () => {
  const { res, body } = await admin.json('/api/version');
  assert.equal(res.status, 200);
  assert.equal(typeof body.version, 'string');
  assert.ok(body.build && String(body.build).length > 0);
});

test('без авторизации закрыты дерево, файлы и админ-API', async () => {
  const anon = makeClient();
  assert.equal((await anon.request('/api/tree?projectId=default')).status, 401);
  assert.equal((await anon.request('/files/default/x.md')).status, 401);
  assert.equal((await anon.request('/api/users')).status, 401);
  assert.equal((await anon.request('/api/admin/dashboard')).status, 401);
});

test('админ-дашборд: состояние системы, хранилище и модели', async () => {
  const { res, body } = await admin.json('/api/admin/dashboard');
  assert.equal(res.status, 200);
  assert.ok(body.storage && Number.isInteger(body.storage.users));
  assert.ok(body.storage.users >= 1);
  assert.ok(body.sizes && body.sizes.db > 0);
  assert.ok(body.ai && Array.isArray(body.ai.models));
  assert.ok(Array.isArray(body.backups));
});

test('дашборд и бэкап недоступны обычному участнику', async () => {
  // Пользователь создаётся здесь же, чтобы тест не зависел от порядка файлов.
  await admin.json('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'member2', password: 'MemberTest123!', role: 'member' }),
  });
  const member = makeClient();
  await member.login('member2', 'MemberTest123!');
  assert.equal((await member.request('/api/admin/dashboard')).status, 403);
  assert.equal((await member.request('/api/admin/backup', { method: 'POST' })).status, 403);
});

test('бэкап из админки создаёт копию и возвращает список', async () => {
  const { res, body } = await admin.json('/api/admin/backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: false }),
  });
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.backups) && body.backups.length >= 1);
  assert.ok(body.backups[0].sizeBytes > 0);
  const backupDir = path.join(process.env.BACKUP_DIR, body.backups[0].name);
  assert.ok(fs.existsSync(path.join(backupDir, 'manifest.json')));
  // Бэкап должен брать данные тестового окружения (DATA_DIR), а не реальный data/.
  assert.ok(fs.existsSync(path.join(backupDir, 'dossier.db')), 'в бэкапе нет dossier.db');
  assert.ok(fs.existsSync(path.join(backupDir, 'data')), 'в бэкапе нет data/');
});

test('загрузка .shtml хранится как text/plain и не исполняется', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['<script>document.title="XSS"</script>'], { type: 'text/html' }), 'poc.shtml');
  fd.append('projectId', 'default');
  const up = await admin.json('/api/upload', { method: 'POST', body: fd });
  assert.equal(up.res.status, 200, JSON.stringify(up.body));
  const file = await admin.request('/files/default/poc.shtml');
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-type') || '', /^text\/plain/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
});

test('неизвестное расширение отдаётся как attachment', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['binary'], { type: 'application/octet-stream' }), 'payload.exe');
  fd.append('projectId', 'default');
  const up = await admin.json('/api/upload', { method: 'POST', body: fd });
  assert.equal(up.res.status, 200, JSON.stringify(up.body));
  const file = await admin.request('/files/default/payload.exe');
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition') || '', /attachment/);
});

test('share-ссылка на .html тоже отдаёт text/plain', async () => {
  const created = await admin.json('/api/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'poc.shtml', projectId: 'default', expiresInDays: 1 }),
  });
  assert.equal(created.res.status, 200);
  const share = await fetch(base + created.body.url);
  assert.equal(share.status, 200);
  assert.match(share.headers.get('content-type') || '', /^text\/plain/);
});

test('имена с % не ломаются двойным декодированием', async () => {
  const created = await admin.json('/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'default', dir: '', name: '100%.md' }),
  });
  assert.equal(created.res.status, 200);
  const file = await admin.request('/files/default/100%25.md');
  assert.equal(file.status, 200);
});

test('последнего администратора нельзя понизить или удалить', async () => {
  const patch = await admin.json('/api/users/' + adminId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'member' }),
  });
  assert.equal(patch.res.status, 400);
  const del = await admin.request('/api/users/' + adminId, { method: 'DELETE' });
  assert.equal(del.status, 400);
});

test('участник без членства в проекте не читает дерево и не пишет файлы', async () => {
  const created = await admin.json('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'member1', password: 'MemberTest123!', role: 'member' }),
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));

  const member = makeClient();
  await member.login('member1', 'MemberTest123!');
  assert.equal((await member.request('/api/tree?projectId=default')).status, 403);
  const write = await member.json('/api/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'default', file: 'hack.md', content: 'x' }),
  });
  assert.equal(write.res.status, 403);
});

test('вложение с проектной областью не отдаётся чужому пользователю', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['secret'], { type: 'text/plain' }), 'secret.txt');
  fd.append('scope', 'project:default');
  const up = await admin.json('/api/chat/attach', { method: 'POST', body: fd });
  assert.equal(up.res.status, 200, JSON.stringify(up.body));

  const member = makeClient();
  await member.login('member1', 'MemberTest123!');
  const stolen = await member.request('/api/chat/attach/' + up.body.id);
  assert.equal(stolen.status, 403);
  // владелец и админ доступ имеют
  assert.equal((await admin.request('/api/chat/attach/' + up.body.id)).status, 200);
});

test('журнал изменений отдаётся с пагинацией', async () => {
  const { res, body } = await admin.json('/api/changes?full=1&limit=1&offset=0');
  assert.equal(res.status, 200);
  assert.ok(Number.isInteger(body.total));
  assert.ok(body.entries.length <= 1);
  assert.equal(body.limit, 1);
});

test('страница отдаётся с CSP без inline-скриптов и CDN', async () => {
  const res = await admin.request('/login.html', { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline.*script-src|script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(csp, /cdn\.jsdelivr/);
});

test('история версий: список, содержимое версии и скачивание', async () => {
  // Две записи файла → две версии в журнале.
  for (const content of ['# Версия 1\nстрока\n', '# Версия 2\nстрока\nновая строка\n']) {
    const r = await admin.json('/api/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'default', file: 'history-test.md', content }),
    });
    assert.equal(r.res.status, 200, JSON.stringify(r.body));
  }
  const list = await admin.json('/api/files/default/history?path=history-test.md&limit=10');
  assert.equal(list.res.status, 200, JSON.stringify(list.body));
  assert.ok(list.body.total >= 2, 'должно быть минимум две версии');
  assert.equal(list.body.entries[0].file, 'history-test.md');
  assert.equal(list.body.entries[0].before, undefined, 'список не должен тянуть содержимое');

  const version = await admin.json('/api/files/default/history/' + list.body.entries[0].id);
  assert.equal(version.res.status, 200);
  assert.match(version.body.version.after, /Версия 2/);
  assert.match(version.body.version.before, /Версия 1/);

  const dl = await admin.request('/api/files/default/history/' + list.body.entries[0].id + '/download?side=before');
  assert.equal(dl.status, 200);
  assert.match(await dl.text(), /Версия 1/);

  assert.equal((await admin.request('/api/files/default/history/nonexistent')).status, 404);
});

test('история версий доступна участнику проекта, но не постороннему', async () => {
  // member1 уже создан выше; добавляем его в проект как участника с правом чтения.
  const add = await admin.json('/api/projects/default/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'member1', role: 'member' }),
  });
  assert.ok([200, 409].includes(add.res.status), JSON.stringify(add.body));

  const member = makeClient();
  await member.login('member1', 'MemberTest123!');
  assert.equal((await member.request('/api/files/default/history?path=history-test.md')).status, 200);

  const stranger = makeClient();
  await stranger.login('member2', 'MemberTest123!');
  assert.equal((await stranger.request('/api/files/default/history?path=history-test.md')).status, 403);
});

test('уведомления: тикет создаёт уведомление админу, прочтение уменьшает счётчик', async () => {
  const member = makeClient();
  await member.login('member1', 'MemberTest123!');
  const t = await member.json('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Тестовое обращение для уведомления' }),
  });
  // у member1 мог уже быть открытый тикет от прошлых прогонов
  assert.ok([200, 409].includes(t.res.status), JSON.stringify(t.body));

  const notif = await admin.json('/api/notifications?limit=20');
  assert.equal(notif.res.status, 200);
  assert.ok(notif.body.unread >= 1, 'у админа должно быть непрочитанное уведомление');
  const ticketNotif = notif.body.items.find(n => n.type === 'ticket');
  assert.ok(ticketNotif, 'должно быть уведомление о тикете');
  assert.ok(ticketNotif.link.startsWith('ticket:'));

  const read = await admin.json('/api/notifications/' + ticketNotif.id + '/read', { method: 'POST' });
  assert.equal(read.res.status, 200);
  assert.ok(read.body.notification.readAt);

  const count = await admin.json('/api/notifications/unread-count');
  assert.equal(count.res.status, 200);
  assert.ok(count.body.unread < notif.body.unread);

  // Чужое уведомление нельзя прочитать/увидеть
  const stranger = makeClient();
  await stranger.login('member2', 'MemberTest123!');
  const strangerRead = await stranger.request('/api/notifications/' + ticketNotif.id + '/read', { method: 'POST' });
  assert.equal(strangerRead.status, 404);
  const strangerList = await stranger.json('/api/notifications');
  assert.ok(!strangerList.body.items.some(n => n.id === ticketNotif.id));
});

test('уведомления: упоминание @логин в общем чате', async () => {
  const sent = await admin.json('/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '@member1 проверка упоминания' }),
  });
  assert.equal(sent.res.status, 200, JSON.stringify(sent.body));

  const member = makeClient();
  await member.login('member1', 'MemberTest123!');
  const list = await member.json('/api/notifications?limit=20');
  assert.equal(list.res.status, 200);
  assert.ok(list.body.items.some(n => n.type === 'mention' && n.body.includes('проверка упоминания')));

  const all = await member.json('/api/notifications/read-all', { method: 'POST' });
  assert.equal(all.res.status, 200);
  assert.ok(all.body.changed >= 1);
  const after = await member.json('/api/notifications/unread-count');
  assert.equal(after.body.unread, 0);
});

test('стили Darcus доступны пользователю, полный конфиг — только админу', async () => {
  const member = makeClient();
  await member.login('member2', 'MemberTest123!');
  const styles = await member.json('/api/darcus/styles');
  assert.equal(styles.res.status, 200);
  assert.ok(styles.body.presets && typeof styles.body.presets === 'object');
  assert.equal((await member.request('/api/darcus/config')).status, 403);
  assert.equal((await admin.request('/api/darcus/config')).status, 200);
});

test('глобальный поиск: проекты, сообщения, задачи и люди с учётом доступа', async () => {
  // задача в проектном чате
  const taskAdd = await admin.json('/api/projects/default/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Уникальная задача про поиск Zeta' }),
  });
  assert.equal(taskAdd.res.status, 200, JSON.stringify(taskAdd.body));
  // сообщение в проектном чате
  await admin.json('/api/chat/project/default/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Проектное сообщение Zeta для поиска' }),
  });

  const adminHits = await admin.json('/api/search/entities?q=Zeta');
  assert.equal(adminHits.res.status, 200);
  assert.ok(adminHits.body.tasks.some(t => t.text.includes('Zeta') && t.projectId === 'default'));
  assert.ok(adminHits.body.messages.some(m => m.chat === 'project' && m.text.includes('Zeta')));

  const byProject = await admin.json('/api/search/entities?q=' + encodeURIComponent('Основ'));
  assert.ok(byProject.body.projects.some(p => p.id === 'default'));

  // member1 — участник проекта: видит проектное сообщение; member2 — нет
  const member1 = makeClient();
  await member1.login('member1', 'MemberTest123!');
  const m1 = await member1.json('/api/search/entities?q=Zeta');
  assert.ok(m1.body.messages.some(m => m.chat === 'project'));

  const member2 = makeClient();
  await member2.login('member2', 'MemberTest123!');
  const m2 = await member2.json('/api/search/entities?q=Zeta');
  assert.ok(!m2.body.messages.some(m => m.chat === 'project' && m.projectId === 'default'));
  const proj2 = await member2.json('/api/search/entities?q=' + encodeURIComponent('Основ'));
  assert.equal(proj2.body.projects.length, 0, 'посторонний не должен видеть проекты');

  // короткий запрос — пустой ответ без ошибки
  const short = await admin.json('/api/search/entities?q=a');
  assert.equal(short.res.status, 200);
  assert.deepEqual(short.body.messages, []);
});

test('канбан задач: статусы, порядок, исполнитель и совместимость с done', async () => {
  const created = await admin.json('/api/projects/default/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Канбан-задача', status: 'doing', assignee: 'member1' }),
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  const task = created.body.task;
  assert.equal(task.status, 'doing');
  assert.equal(task.done, false);
  assert.equal(task.assignee, 'member1');

  const toDone = await admin.json('/api/projects/default/tasks/' + task.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done', order: 0 }),
  });
  assert.equal(toDone.res.status, 200);
  assert.equal(toDone.body.task.status, 'done');
  assert.equal(toDone.body.task.done, true);
  assert.ok(toDone.body.task.doneBy);
  assert.equal(toDone.body.task.order, 0);

  const back = await admin.json('/api/projects/default/tasks/' + task.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'todo' }),
  });
  assert.equal(back.body.task.status, 'todo');
  assert.equal(back.body.task.done, false);
  assert.equal(back.body.task.doneAt, null);

  const legacy = await admin.json('/api/projects/default/tasks/' + task.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: true }),
  });
  assert.equal(legacy.body.task.status, 'done');

  const invalid = await admin.json('/api/projects/default/tasks/' + task.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'blocked' }),
  });
  assert.equal(invalid.res.status, 400);

  const list = await admin.json('/api/projects/default/tasks');
  const found = list.body.tasks.find(t => t.id === task.id);
  assert.ok(found, 'задача должна быть в списке');
  assert.ok(['todo', 'doing', 'done'].includes(found.status));
  assert.equal(typeof found.order, 'number');
});

test('экспорт/импорт: только админ, проверка формата и подтверждения', async () => {
  const member = makeClient();
  await member.login('member2', 'MemberTest123!');
  assert.equal((await member.request('/api/admin/export')).status, 403);

  const exp = await admin.request('/api/admin/export');
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition') || '', /attachment/);
  const snapshot = await exp.json();
  assert.equal(snapshot.app, 'darkarmy-dossier');
  assert.equal(snapshot.version, 1);
  assert.ok(Array.isArray(snapshot.users) && snapshot.users.length >= 2);
  assert.ok(Array.isArray(snapshot.projects));
  assert.ok(snapshot.documents && typeof snapshot.documents === 'object');

  // подтверждение обязательно
  const noConfirm = await admin.json('/api/admin/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  });
  assert.equal(noConfirm.res.status, 400);

  // чужой формат
  const wrong = await admin.json('/api/admin/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'REPLACE', snapshot: { app: 'other', version: 1, users: [] } }),
  });
  assert.equal(wrong.res.status, 400);

  // снимок без администратора запрещён
  const noAdmin = await admin.json('/api/admin/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'REPLACE', snapshot: { app: 'darkarmy-dossier', version: 1, users: [{ id: 'u1', username: 'x', role: 'user' }], projects: [], documents: {} } }),
  });
  assert.equal(noAdmin.res.status, 400);

  // валидный импорт (roundtrip экспорта)
  const imported = await admin.json('/api/admin/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'REPLACE', mode: 'replace', snapshot }),
  });
  assert.equal(imported.res.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.users, snapshot.users.length);
  assert.equal(imported.body.projects, snapshot.projects.length);

  // после замены пользователей текущая сессия админа продолжает работать
  const me = await admin.json('/api/me');
  assert.equal(me.res.status, 200);
  assert.equal(me.body.user.username, 'admin');
});
