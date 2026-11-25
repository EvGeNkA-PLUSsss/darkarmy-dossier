'use strict';
/* =========================================================
   util.js — общие утилиты: пути, имена файлов, пароли,
   rate-limit, отдача файлов, размеры каталогов, редакция логов.
   ========================================================= */
const fs = require('fs');
const path = require('path');

const TEXT_EXT = ['md', 'markdown', 'txt', 'js', 'json', 'css', 'html', 'xml', 'csv', 'log', 'yml', 'yaml', 'ts', 'sh', 'env', 'ini', 'conf'];
const isTextFile = n => TEXT_EXT.includes(String(n).split('.').pop().toLowerCase());

const INLINE_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);
const INLINE_SVG_EXT = new Set(['svg']);
const INLINE_PDF_EXT = new Set(['pdf']);
const TEXT_PLAIN_EXT = new Set([
  'md', 'markdown', 'txt', 'csv', 'log', 'json', 'yml', 'yaml', 'ini', 'conf', 'sh', 'env',
  'html', 'htm', 'shtml', 'xhtml', 'xht', 'xml', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'vbs', 'hta', 'chm', 'jar', 'swf', 'css', 'svgz', 'bat', 'ps1', 'py', 'sql',
]);

/* ---------- Пути ---------- */
function safeJoin(root, rel) {
  if (typeof rel !== 'string') throw new Error('bad path');
  if (rel.includes('\0')) throw new Error('bad path');
  // API использует только '/' как разделитель. Windows-разделители нормализуем,
  // чтобы traversal вроде "..\\outside.txt" блокировался на любой ОС.
  const normalized = rel.replace(/\\/g, '/');
  const full = path.resolve(root, normalized.replace(/^\/+/, ''));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('forbidden');
  return full;
}

/* ---------- Имена файлов из multipart ---------- */
function decodeUploadFilename(name) {
  const raw = String(name || 'file');
  // Если в строке уже есть настоящий Unicode (не только латинский-1) — не трогаем.
  let hasHighUnicode = false;
  for (const ch of raw) {
    if (ch.codePointAt(0) > 0xFF) { hasHighUnicode = true; break; }
  }
  if (hasHighUnicode) return raw;
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) return decoded;
  } catch {}
  return raw;
}

function safeFileName(name) {
  // Приводим оба типа разделителей: на Linux обратный слэш не является
  // разделителем, из-за чего "../../evil.txt" превращался в ".._.._evil.txt".
  const base = path.basename(String(name || 'file').replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 200);
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
}

function isImageMime(mime, name) {
  if (mime && mime.startsWith('image/')) return true;
  const ext = (path.extname(name) || '').slice(1).toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext);
}

/* ---------- Пароли ---------- */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty', 'qwerty123', 'qwertyuiop',
  '123456', '1234567', '12345678', '123456789', '1234567890', '111111', '123123', '123321', '000000',
  'abc123', 'abcd1234', 'letmein', 'welcome', 'welcome1', 'admin', 'admin123', 'administrator', 'root',
  'toor', 'test', 'test123', 'testtest', 'qazwsx', 'qazwsxedc', 'zaq12wsx', '1q2w3e4r', '1qaz2wsx',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman',
  'master', 'shadow', 'michael', 'jennifer', 'trustno1', 'hello', 'hello123', 'pass', 'pass123',
  'darkarmy', 'dossier', 'darkarmy123', 'qwerty1', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'qwe123',
  'polniy_p1zdets', '1234', '4321', '0987654321', '987654321', 'super', 'google', 'facebook'
]);

function validatePassword(password, username = '') {
  const pwd = String(password || '');
  const uname = String(username || '').trim();
  if (pwd.length < 8) return { ok: false, error: 'Пароль должен быть минимум 8 символов' };
  if (pwd.length > 200) return { ok: false, error: 'Пароль слишком длинный (макс. 200 символов)' };
  if (!/[a-zа-яё]/.test(pwd)) return { ok: false, error: 'Пароль должен содержать строчную букву' };
  if (!/[A-ZА-ЯЁ]/.test(pwd)) return { ok: false, error: 'Пароль должен содержать заглавную букву' };
  if (!/[0-9]/.test(pwd)) return { ok: false, error: 'Пароль должен содержать цифру' };
  if (/^(.)\1+$/.test(pwd)) return { ok: false, error: 'Пароль не должен состоять из одного символа' };
  const lower = pwd.toLowerCase();
  const seqs = ['0123456789', '9876543210', 'abcdefghijklmnopqrstuvwxyz',
    'zyxwvutsrqponmlkjihgfedcba', 'qwertyuiop', 'poiuytrewq', 'asdfghjkl', 'lkjhgfdsa',
    'zxcvbnm', 'mnbvcxz', 'йцукенгшщзхъ', 'ячсмитьбю'];
  for (const s of seqs) if (s.includes(lower)) return { ok: false, error: 'Пароль не должен быть последовательностью' };
  if (COMMON_PASSWORDS.has(lower)) return { ok: false, error: 'Такой пароль слишком распространён' };
  if (uname) {
    const u = uname.toLowerCase();
    if (u.length >= 3 && lower.includes(u)) return { ok: false, error: 'Пароль не должен содержать логин' };
    if (lower === u) return { ok: false, error: 'Пароль не должен совпадать с логином' };
  }
  return { ok: true };
}

/* ---------- Rate limit ---------- */
function makeRateLimiter(windowMs, max, msg) {
  const map = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of map) if (now - v.first > windowMs * 2) map.delete(k);
  }, Math.max(windowMs, 60_000));
  if (cleanup.unref) cleanup.unref();

  return (req, res, next) => {
    // Ключ привязан к username (если авторизован) — иначе к IP.
    const key = req.user?.username ? `u:${req.user.username}` : `ip:${req.ip || 'unknown'}`;
    const now = Date.now();
    const rec = map.get(key) || { count: 0, first: now };
    if (now - rec.first > windowMs) { rec.count = 0; rec.first = now; }
    rec.count++;
    map.set(key, rec);
    if (rec.count > max)
      return res.status(429).json({ error: msg || 'Слишком много попыток. Подождите.' });
    next();
  };
}

/* ---------- Логи ---------- */
const STATIC_ASSET_RE = /\.(js|css|png|jpe?g|gif|webp|bmp|svg|ico|woff2?|ttf|eot|map)$/i;

function redactUrl(url) {
  // share-токены и прочие секреты не должны оседать в логах
  return String(url)
    .replace(/^\/s\/[^/?#]+/, '/s/[redacted]')
    .replace(/([?&](?:token|invite|code|secret)=)[^&#]+/gi, '$1[redacted]');
}

/* ---------- Отдача файлов проекта ---------- */
function sendProjectFile(res, realPath) {
  const ext = path.extname(realPath).slice(1).toLowerCase();
  const base = path.basename(realPath);
  const disposition = (type) => `${type}; filename*=UTF-8''${encodeURIComponent(base)}`;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (INLINE_IMAGE_EXT.has(ext)) return res.sendFile(realPath);

  if (INLINE_SVG_EXT.has(ext)) {
    // SVG может содержать скрипты: отдаём инлайн только с закрытым CSP.
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    return res.sendFile(realPath);
  }

  if (INLINE_PDF_EXT.has(ext)) {
    res.setHeader('Content-Type', 'application/pdf');
    return res.sendFile(realPath);
  }

  if (TEXT_PLAIN_EXT.has(ext)) {
    // HTML/JS/SVGZ и прочее «рискованное» — только как текст, без исполнения.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', disposition('inline'));
    return res.sendFile(realPath);
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', disposition('attachment'));
  return res.sendFile(realPath);
}

/* ---------- Размеры / бэкапы ---------- */
function safeDirSize(dir, depth = 0) {
  if (depth > 4) return 0;
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += safeDirSize(full, depth + 1);
      else total += fs.statSync(full).size;
    } catch {}
  }
  return total;
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function listBackups(backupDir) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(d.name))
      .map(d => d.name)
      .sort().reverse();
  } catch {}
  return dirs.slice(0, 10).map(name => {
    const full = path.join(backupDir, name);
    let info = {};
    try { info = JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8')); } catch {}
    return {
      name,
      sizeBytes: safeDirSize(full),
      createdAt: info.createdAt || name,
      withProjects: !!info.projectsRoot,
    };
  });
}

module.exports = {
  TEXT_EXT, isTextFile,
  INLINE_IMAGE_EXT, INLINE_SVG_EXT, INLINE_PDF_EXT, TEXT_PLAIN_EXT,
  safeJoin, decodeUploadFilename, safeFileName, isImageMime,
  validatePassword, COMMON_PASSWORDS,
  makeRateLimiter,
  STATIC_ASSET_RE, redactUrl,
  sendProjectFile,
  safeDirSize, fileSize, listBackups,
};
