'use strict';
/* =========================================================
   backup.js — согласованный бэкап метаданных и файлов проектов.
   SQLite-база копируется через официальный backup API (безопасно при
   работающем сервере), остальные файлы — обычным копированием.

   Использование:
     npm run backup                     # в ../backups (рядом с репозиторием)
     node scripts/backup.js --keep 14   # хранить 14 последних копий
     node scripts/backup.js --no-projects # только метаданные
   ========================================================= */
const fs = require('fs');
const path = require('path');
const { DatabaseSync, backup } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : process.argv[i + 1];
}

(async () => {
  // Явные переменные окружения приоритетнее .env (важно для тестов и CI).
  const env = { ...loadEnvFile(), ...process.env };
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const projectsRoot = path.resolve(arg('projects-root', env.PROJECTS_ROOT || 'F:/Проекты'));
  const keep = Math.max(1, parseInt(arg('keep', '7'), 10) || 7);
  const withProjects = !process.argv.includes('--no-projects');
  const destRoot = path.resolve(arg('dest', path.join(ROOT, '..', 'backups')));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(destRoot, stamp);
  fs.mkdirSync(dest, { recursive: true });

  // 1) SQLite через backup API (консистентно при работающем сервере).
  const dbFile = path.join(dataDir, 'dossier.db');
  if (fs.existsSync(dbFile)) {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      await backup(db, path.join(dest, 'dossier.db'));
      console.log('OK  dossier.db');
    } finally { db.close(); }
  } else {
    console.log('WARN dossier.db не найден — копирую только JSON-архив');
  }

  // 2) Остальные файлы метаданных (JSON-архив, конфиги, вложения, реклама).
  const skip = new Set(['dossier.db', 'dossier.db-wal', 'dossier.db-shm', 'tmp']);
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  };
  if (!fs.existsSync(dataDir)) {
    console.log('WARN каталог данных не найден: ' + dataDir + ' — пропускаю data/');
  } else {
    copyDir(dataDir, path.join(dest, 'data'));
    console.log('OK  data/');
  }

  // 3) Файлы проектов.
  if (withProjects) {
    if (fs.existsSync(projectsRoot)) {
      copyDir(projectsRoot, path.join(dest, 'projects'));
      console.log('OK  projects/');
    } else {
      console.log('WARN PROJECTS_ROOT не найден: ' + projectsRoot);
    }
  }

  // 4) Манифест и ротация.
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    dataDir, projectsRoot: withProjects ? projectsRoot : null,
    node: process.version,
  }, null, 2));

  const dirs = fs.readdirSync(destRoot, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(d.name))
    .map(d => d.name).sort();
  while (dirs.length > keep) {
    const old = dirs.shift();
    fs.rmSync(path.join(destRoot, old), { recursive: true, force: true });
    console.log('PRUNE ' + old);
  }
  console.log('Бэкап готов: ' + dest);
})().catch(e => { console.error('Бэкап не удался:', e); process.exit(1); });
