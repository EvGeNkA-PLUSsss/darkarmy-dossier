'use strict';
/* Юнит-тесты базовых функций, от которых зависит безопасность файлов и паролей. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'da-unit-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');
process.env.SESSION_SECRET = 'unit-secret';
process.env.ADMIN_PASSWORD = 'UnitTest123!Pass';
process.env.NODE_ENV = 'test';

const { safeJoin, atomicWriteFile, loadJSON, validatePassword, decodeUploadFilename, safeFileName } =
  require('../server');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('safeJoin: обычные и кириллические пути', () => {
  const root = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(root, 'Вложенная папка'), { recursive: true });
  assert.equal(safeJoin(root, 'a/b.txt'), path.join(root, 'a/b.txt'));
  assert.equal(safeJoin(root, 'Вложенная папка/файл.md'), path.join(root, 'Вложенная папка/файл.md'));
  assert.equal(safeJoin(root, '/leading-slash.md'), path.join(root, 'leading-slash.md'));
});

test('safeJoin: блокирует traversal, абсолютные пути и NUL', () => {
  const root = path.join(tmp, 'proj2');
  fs.mkdirSync(root, { recursive: true });
  assert.throws(() => safeJoin(root, '../outside.txt'));
  assert.throws(() => safeJoin(root, '..\\outside.txt'));
  assert.throws(() => safeJoin(root, 'a\\..\\..\\outside.txt'));
  assert.throws(() => safeJoin(root, 'a/../../outside.txt'));
  assert.throws(() => safeJoin(root, '\0evil'));
  // абсолютный путь внутри root остаётся внутри root (не выходит наружу)
  const inside = safeJoin(root, path.join(root, 'inner.md'));
  assert.ok(inside.startsWith(root));
});

test('atomicWriteFile + loadJSON восстанавливает .bak при повреждении', () => {
  const file = path.join(tmp, 'data', 'test.json');
  atomicWriteFile(file, JSON.stringify({ items: [1] }));
  assert.deepEqual(loadJSON(file, null), { items: [1] });
  atomicWriteFile(file, JSON.stringify({ items: [1, 2] })); // создаст .bak с первой версией
  fs.writeFileSync(file, '{ broken json', 'utf8');
  const restored = loadJSON(file, null);
  assert.deepEqual(restored, { items: [1] });
  assert.ok(fs.existsSync(file + '.bak'));
});

test('loadJSON: явная ошибка вместо пустого дефолта, если нет .bak', () => {
  const file = path.join(tmp, 'data', 'broken.json');
  fs.writeFileSync(file, '{ nope', 'utf8');
  assert.throws(() => loadJSON(file, { safe: true }), /Повреждён файл данных/);
});

test('валидация паролей', () => {
  assert.equal(validatePassword('short', 'user').ok, false);
  assert.equal(validatePassword('12345678', 'user').ok, false);
  assert.equal(validatePassword('qwertyuiop', 'user').ok, false);
  assert.equal(validatePassword('password123', 'user').ok, false);
  assert.equal(validatePassword('aaaaaaaaaaa', 'user').ok, false);
  assert.equal(validatePassword('MyLogin123', 'mylogin').ok, false);
  assert.equal(validatePassword('CorrectHorse9Battery', 'user').ok, true);
});

test('decodeUploadFilename: latin1-UTF8 из multipart', () => {
  const broken = Buffer.from('Отчёт.docx', 'utf8').toString('latin1');
  assert.equal(decodeUploadFilename(broken), 'Отчёт.docx');
  assert.equal(decodeUploadFilename('plain.txt'), 'plain.txt');
});

test('safeFileName: вырезает опасные символы и пути', () => {
  assert.equal(safeFileName('..\\..\\evil.txt'), 'evil.txt');
  assert.equal(safeFileName('../../evil.txt'), 'evil.txt');
  assert.equal(safeFileName('C:\\temp\\file.md'), 'file.md');
  assert.equal(safeFileName('a<b>c.txt'), 'a_b_c.txt');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName('..'), 'file');
});
