const d = require('./darcus.js');
const fs = require('fs');
const path = require('path');

// замени на свой projectId и root
const projects = [{ id: 'default', name: 'Основной', root: 'F:/Проекты/default' }];

(async () => {
  const q = 'какая машина ездила на бензине';

  const kw = d.keywordSearch(projects, q);
  console.log('--- keyword ---');
  console.log(kw.map(r => `${r.path} (score ${r.score})`).join('\n') || '(пусто)');

  const sem = await d.semanticSearch(projects, q);
  console.log('\n--- semantic ---');
  console.log(sem.map(r => `${r.path} (cos ${r.score.toFixed(3)})`).join('\n') || '(пусто)');

  const hyb = await d.ragSearch(projects, q);
  console.log('\n--- hybrid ---');
  console.log(hyb.map(r => `${r.path} (${r.score.toFixed(3)})`).join('\n') || '(пусто)');
})();