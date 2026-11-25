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
process.env.SESSION_SECRET = 'api-secret';
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

test('без авторизации закрыты дерево, файлы и админ-API', async () => {
  const anon = makeClient();
  assert.equal((await anon.request('/api/tree?projectId=default')).status, 401);
  assert.equal((await anon.request('/files/default/x.md')).status, 401);
  assert.equal((await anon.request('/api/users')).status, 401);
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
