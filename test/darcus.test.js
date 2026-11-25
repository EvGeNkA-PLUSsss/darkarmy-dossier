'use strict';
/* Юниты Darcus: детекция vision-моделей, очистка ответов и генерация документа.
   Внешняя Ollama не вызывается. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'da-darcus-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.PROJECTS_ROOT = path.join(tmp, 'projects');
process.env.SESSION_SECRET = 'darcus-test-secret';
const darcus = require('../darcus');

test('isVisionModel: распознаёт qwen2.5vl, llava, gemma4 и не путает текстовые модели', () => {
  for (const m of ['qwen2.5vl:3b', 'qwen25vl:7b', 'qwen2.5-vl', 'llava:13b', 'gemma4:e4b',
                   'minicpm-v', 'pixtral-12b', 'llama3.2-vision:11b']) {
    assert.equal(darcus.isVisionModel(m), true, m);
  }
  for (const m of ['nomic-embed-text', 'qwen2.5:7b', 'llama3:8b', '']) {
    assert.equal(darcus.isVisionModel(m), false, m);
  }
});

test('stripSpecialTokens: служебные токены Ollama не попадают в ответ', () => {
  assert.equal(darcus.stripSpecialTokens('<|img|>Привет, <|file|a.png|>мир'), 'Привет, мир');
  assert.equal(darcus.stripSpecialTokens('обычный текст'), 'обычный текст');
  assert.equal(darcus.stripSpecialTokens(null), '');
});

test('cleanGeneratedMarkdown: убирает ACTION-блок, обёртки и вступление', () => {
  const raw = 'Создаю файл `test_file.md` в соответствии с вашим запросом.\n\n' +
    '<<<ACTION>>>\n{"type":"create","path":"test_file.md","content":"# тест"}\n<<<END ACTION>>>';
  assert.equal(darcus.cleanGeneratedMarkdown(raw), '');

  const raw2 = 'Вот документ:\n```markdown\n# Заголовок\n\nТекст\n```';
  assert.equal(darcus.cleanGeneratedMarkdown(raw2), '# Заголовок\n\nТекст');

  const raw3 = '<<<ACTION>>>\n{"type":"create","path":"a.md","content":"x"}\n<<<END ACTION>>>\n# Чистый документ\n\nСтрока';
  assert.equal(darcus.cleanGeneratedMarkdown(raw3), '# Чистый документ\n\nСтрока');
});

test('loadAiConfig: новые промпты (vision_chat, generate_doc_system) доступны', () => {
  const cfg = darcus.loadAiConfig();
  assert.ok(cfg.prompts.vision_chat.includes('{query}'));
  assert.ok(cfg.prompts.generate_doc_system.length > 10);
  assert.ok(cfg.prompts.generate_doc.includes('ТОЛЬКО содержимое'));
});
