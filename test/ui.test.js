'use strict';
/* Юниты интерфейса: все используемые SVG-иконки объявлены, ключевые стили на месте. */
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

function symbolsOf(html) {
  return new Set([...html.matchAll(/<symbol id="i-([a-z0-9-]+)"/gi)].map(m => m[1]));
}
function iconNamesIn(js) {
  const out = new Set();
  for (const m of js.matchAll(/\bicon\('([a-z0-9-]+)'/gi)) out.add(m[1]);
  for (const m of js.matchAll(/href="#i-([a-z0-9-]+)"/gi)) out.add(m[1]);
  return out;
}

test('все SVG-иконки index.html/app.js объявлены (теги, датабаза и т.д.)', () => {
  const symbols = symbolsOf(read('index.html'));
  const used = iconNamesIn(read('index.html'));
  for (const f of ['app.js', 'js/search.js', 'js/history.js', 'js/notifications.js']) {
    for (const n of iconNamesIn(read(f))) used.add(n);
  }
  const missing = [...used].filter(n => !symbols.has(n)).sort();
  assert.deepEqual(missing, [], 'нет символов для иконок: ' + missing.join(', '));
  assert.ok(symbols.has('tag'), 'иконка «Теги» должна быть объявлена');
  assert.ok(symbols.has('database'), 'иконка «База данных» должна быть объявлена');
});

test('все SVG-иконки админки объявлены', () => {
  const symbols = symbolsOf(read('admin.html'));
  const used = iconNamesIn(read('admin.js'));
  const missing = [...used].filter(n => !symbols.has(n)).sort();
  assert.deepEqual(missing, [], 'нет символов для иконок: ' + missing.join(', '));
  assert.ok(symbols.has('loader'), 'иконка loader должна быть объявлена');
});

test('ключевые UI-стили Darcus/OCR на месте', () => {
  const css = read('style.css') + '\n' + read('design.css');
  for (const cls of ['.darcus-image-viewer', '.darcus-attach-thumb', '.chat-form .stop-btn', '#content .ocr-wrap', '.ocr-loading', '.tree-generating']) {
    assert.ok(css.includes(cls), 'нет стилей для ' + cls);
  }
  const app = read('app.js');
  assert.ok(app.includes('makeImageThumb'), 'нет генерации миниатюр для чата');
  assert.ok(app.includes('_scanJsonObject'), 'нет балансного парсера ACTION');
  assert.ok(app.includes('showOcrLoading'), 'нет индикатора распознавания OCR');
  assert.ok(app.includes('tree-generating'), 'нет служебной строки генерации Darcus');
  assert.ok(app.includes('initBugReport'), 'нет кнопки БАГ');
  assert.ok(app.includes('pickFilesForMd'), 'нет вставки файлов в Markdown');
  assert.ok(app.includes('moveProjectSelect'), 'нет перемещения между проектами');
  assert.ok(app.includes('handleTreeSelection'), 'нет массового выделения файлов');
  assert.ok(app.includes('initMarkdownDrop'), 'нет drag&drop файла в Markdown');
  assert.ok(app.includes('darcusAutoApplyOn'), 'нет режима Darcus без подтверждения');
  assert.ok(app.includes('startBrowserSpeechRecognition'), 'нет голосового ввода браузера');
  const html = read('index.html');
  assert.ok(html.includes('id="bugBtn"') && html.includes('id="bugModal"'), 'нет кнопки/модалки БАГ');
  assert.ok(html.includes('data-md="attach"'), 'нет кнопки прикрепления файла в редакторе');
  assert.ok(html.includes('id="moveProjectSelect"'), 'нет выбора проекта в перемещении');
  assert.ok(html.includes('id="darcusChatPanel"') && html.includes('id="darcusVoiceModeBtn"'), 'нет списка чатов/голосового режима');
  assert.ok(html.includes('id="darcusAutoApplyBtn"'), 'нет кнопки авто-применения Darcus');
});
