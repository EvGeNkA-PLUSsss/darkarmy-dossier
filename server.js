/* =========================================================
   DarkArmy Dossier — server.js
   Проекты, роли (site + project), баны/муты, чаты, вложения,
   регистрация по инвайт-кодам
   ========================================================= */
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const darcus = require('./darcus');
const extractor = require('./extract-text');
const util = require('./src/util');
const createSystemRouter = require('./src/routes/system');
const {
  safeJoin, validatePassword, decodeUploadFilename, safeFileName, isImageMime,
  makeRateLimiter, redactUrl, STATIC_ASSET_RE, sendProjectFile,
} = util;

// [SEC][NEW] Конфиг и логгер
const cfg = require('./config');
const { logger, writeAccessLog, LOG_FILE } = require('./logger');
const storage = require('./src/storage');

const app = express('+role+');
const PORT = cfg.port;

const PROJECTS_ROOT = cfg.projectsRoot;      // [SEC] вынесено в config.js
const DATA_DIR      = cfg.dataDir;           // [SEC] вынесено в config.js

const USERS_FILE         = path.join(DATA_DIR, 'users.json');
const CHANGES_FILE       = path.join(DATA_DIR, 'changes.json');
const SETTINGS_FILE      = path.join(DATA_DIR, 'settings.json');
const TMP_DIR            = path.join(DATA_DIR, 'tmp');
const CHAT_FILE          = path.join(DATA_DIR, 'chat.json');
const REQUESTS_FILE      = path.join(DATA_DIR, 'requests.json');
const REPORTS_FILE       = path.join(DATA_DIR, 'reports.json');
const TICKETS_FILE       = path.join(DATA_DIR, 'tickets.json');
const PROJECTS_FILE      = path.join(DATA_DIR, 'projects.json');
const PUNISHMENTS_FILE   = path.join(DATA_DIR, 'punishments.json');
const PROJECT_CHATS_FILE = path.join(DATA_DIR, 'project-chats.json');
const ATTACHMENTS_FILE   = path.join(DATA_DIR, 'attachments.json');
const INVITES_FILE       = path.join(DATA_DIR, 'invites.json');
const ATTACH_DIR         = path.join(DATA_DIR, 'attachments');
const ADS_FILE           = path.join(DATA_DIR, 'ads.json');
const ADS_DIR            = path.join(DATA_DIR, 'ads');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const DARCUS_CHATS_FILE  = path.join(DATA_DIR, 'darcus-chats.json');
const SHARES_FILE        = path.join(DATA_DIR, 'shares.json');
const TRASH_FILE         = path.join(DATA_DIR, 'trash.json');
const TRASH_RETENTION_DAYS = cfg.limits.trashRetentionDays;
const PROJECT_META_FILE  = path.join(DATA_DIR, 'project-meta.json');   // [NEW]

for (const d of [ADS_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
for (const d of [DATA_DIR, PROJECTS_ROOT, TMP_DIR, ATTACH_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
// Метаданные (пользователи, проекты, журнал, телеметрия, сессии) — в SQLite.
// При первом запуске сюда переносятся JSON-файлы (они остаются как архив).
storage.init({ dir: DATA_DIR });
try { for (const f of fs.readdirSync(TMP_DIR)) fs.unlinkSync(path.join(TMP_DIR, f)); } catch {}

const TEXT_EXT = util.TEXT_EXT;
const isTextFile = util.isTextFile;
// allow-list инлайн-типов и отдача файлов — в src/util.js.
const { INLINE_IMAGE_EXT, INLINE_SVG_EXT, INLINE_PDF_EXT, TEXT_PLAIN_EXT } = util;

/* ---------- JSON helpers ----------
   - атомарная запись: tmp → fsync → rename (никаких «полузаписанных» файлов);
   - перед перезаписью сохраняется .bak (одна копия);
   - при повреждении JSON пробуем восстановиться из .bak, иначе падаем явно,
     вместо тихой подмены пустым значением (это приводило к потере БД). */
function atomicWriteFile(file, content) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, content, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd); fd = null;
    if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch {} }
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function loadJSON(file, def) {
  if (!fs.existsSync(file)) return def;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const bak = file + '.bak';
    if (fs.existsSync(bak)) {
      try {
        const restored = JSON.parse(fs.readFileSync(bak, 'utf8'));
        try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()); } catch {}
        try { fs.copyFileSync(bak, file); } catch {}
        logger.warn({ file, err: e.message }, 'JSON повреждён — восстановлен из .bak');
        return restored;
      } catch {}
    }
    logger.error({ file, err: e.message }, 'JSON повреждён и резервная копия недоступна');
    throw new Error(`Повреждён файл данных: ${path.basename(file)}. Остановитесь и восстановите из бэкапа.`);
  }
}

function saveJSON(file, data) {
  try {
    atomicWriteFile(file, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error({ err: e.message, file }, 'saveJSON failed');
    throw e;
  }
}

/* ---------- Пользователи (SQLite) ---------- */
let usersCache = null;
function loadUsers() {
  if (usersCache) return usersCache;
  const list = storage.getUsers();
  if (!list.length) {
    // Первый запуск: пароль берём из ADMIN_PASSWORD, иначе генерируем случайный.
    // Пароль печатаем ТОЛЬКО в консоль (не в data/log.txt).
    const tempPassword = cfg.admin.initialPassword || crypto.randomBytes(12).toString('base64url');
    const admin = {
      id: crypto.randomUUID(), username: cfg.admin.username,
      password: bcrypt.hashSync(tempPassword, 10),
      role: 'admin', theme: 'dark', mustChangePassword: true,
      createdAt: new Date().toISOString()
    };
    storage.replaceUsers([admin]);
    console.warn('[bootstrap] Создан администратор "' + cfg.admin.username + '". Пароль: ' + tempPassword + ' — смените его после первого входа.');
    usersCache = { users: [admin] };
    return usersCache;
  }
  usersCache = { users: list };
  return usersCache;
}
const saveUsers = d => {
  storage.replaceUsers(d.users);
  usersCache = null;
};

/* ---------- Журнал (SQLite) ---------- */
const loadChanges = () => ({ entries: storage.listAllChanges() });
// Устаревший API: журнал теперь append-only в БД, полная перезапись не нужна.
const saveChanges = () => {};

// [SEC] Расширенный список чувствительных имён + уменьшенный лимит
const SENSITIVE_FILE_RE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|pfx|p12|kdbx)|id_(rsa|dsa|ecdsa|ed25519).*|.*secret.*|.*credentials.*|.*password.*|config\.json|settings\.json|users\.json|subscriptions\.json|shares\.json|invites\.json)$/i;
const MAX_LOGGED_CONTENT = cfg.limits.logContentMax;

function redactChangeContent(entry) {
  const out = { ...entry };
  const isSensitive = out.file && SENSITIVE_FILE_RE.test(out.file);
  for (const key of ['before', 'after']) {
    if (typeof out[key] !== 'string') continue;
    if (isSensitive) { out[key] = '[REDACTED: sensitive file]'; continue; }
    if (out[key].length > MAX_LOGGED_CONTENT)
      out[key] = out[key].slice(0, MAX_LOGGED_CONTENT) + '\n[...truncated]';
  }
  return out;
}

function logChange(entry) {
  return storage.appendChange(redactChangeContent(entry));
}

/* ---------- Настройки ---------- */
function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    const def = { uploadLimitMB: cfg.limits.uploadDefaultMB, generalChatMode: 'everyone' };
    try { atomicWriteFile(SETTINGS_FILE, JSON.stringify(def, null, 2)); } catch {}
    return def;
  }
  try {
    const s = loadJSON(SETTINGS_FILE, {});
    if (!s.generalChatMode) s.generalChatMode = 'everyone';
    if (s.uploadLimitMB === undefined) s.uploadLimitMB = cfg.limits.uploadDefaultMB;
    return s;
  } catch (e) {
    // Не затираем повреждённый файл дефолтом: работаем на дефолтах и громко логируем.
    logger.error({ err: e.message }, 'settings: используются значения по умолчанию');
    return { uploadLimitMB: cfg.limits.uploadDefaultMB, generalChatMode: 'everyone' };
  }
}
const saveSettings = d => atomicWriteFile(SETTINGS_FILE, JSON.stringify(d, null, 2));

/* ---------- Приглашения ---------- */
const loadInvites = () => loadJSON(INVITES_FILE, { codes: [] });
const saveInvites = d => saveJSON(INVITES_FILE, d);

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateInviteCode(len = 10) {
  let out = '';
  for (let i = 0; i < len; i++) out += INVITE_ALPHABET[crypto.randomInt(0, INVITE_ALPHABET.length)];
  return out;
}

/* ---------- Share-ссылки ---------- */
const loadShares = () => loadJSON(SHARES_FILE, { items: [] });
const saveShares = d => saveJSON(SHARES_FILE, d);
const isShareExpired = e => !!(e.expiresAt && new Date(e.expiresAt).getTime() <= Date.now());
function pruneExpiredShares() {
  const data = loadShares();
  const before = data.items.length;
  data.items = data.items.filter(it => !isShareExpired(it) || it.pinned);
  if (data.items.length !== before) saveShares(data);
  return data;
}

/* ---------- Soft-delete ---------- */
const loadTrash = () => loadJSON(TRASH_FILE, { items: [] });
const saveTrash = d => saveJSON(TRASH_FILE, d);
/* ---------- Мета проекта: теги / избранное [NEW] ---------- */
const loadProjectMeta = () => loadJSON(PROJECT_META_FILE, { projects: {} });
const saveProjectMeta = d => saveJSON(PROJECT_META_FILE, d);

function trashDirFor(project) {
  const dir = path.join(projectFolder(project), '.trash');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function purgeExpiredTrash() {
  const data = loadTrash();
  const now = Date.now();
  const keep = [];
  for (const it of data.items) {
    const age = now - new Date(it.deletedAt).getTime();
    if (age > TRASH_RETENTION_DAYS * 86400 * 1000) {
      try { fs.rmSync(it.trashPath, { recursive: true, force: true }); } catch {}
    } else keep.push(it);
  }
  if (keep.length !== data.items.length) { data.items = keep; saveTrash(data); }
  return data;
}

// [NEW] Удаление своего сообщения из общего чата.
// Админ может удалить любое. SSE-событие chat-delete синхронизирует всех.

/* ---------- Проекты (SQLite) ---------- */
let projectsCache = null;
function loadProjects() {
  if (projectsCache) return projectsCache;
  const list = storage.getProjects();
  if (!list.length) {
    const def = {
      id: 'default', name: 'Основной', folder: 'default', creator: cfg.admin.username,
      members: [{ username: cfg.admin.username, role: 'creator' }],
      createdAt: new Date().toISOString()
    };
    storage.replaceProjects([def]);
    if (!fs.existsSync(path.join(PROJECTS_ROOT, 'default')))
      fs.mkdirSync(path.join(PROJECTS_ROOT, 'default'), { recursive: true });
    projectsCache = { projects: [def] };
    return projectsCache;
  }
  projectsCache = { projects: list };
  return projectsCache;
}
const saveProjects = d => {
  storage.replaceProjects(d.projects);
  projectsCache = null;
};

function projectFolder(project) { return path.join(PROJECTS_ROOT, project.folder); }
function userProjectRole(user, project) {
  if (!project || !user) return null;
  const m = project.members.find(x => x.username === user.username);
  return m ? m.role : null;
}
const canReadProject   = (u, p) => !!(u && p && (u.role === 'admin' || !!userProjectRole(u, p)));
const canEditProject   = (u, p) => {
  if (!u || !p) return false;
  if (u.role === 'admin') return true;
  const r = userProjectRole(u, p);
  return r === 'editor' || r === 'creator';
};
const canManageProject = (u, p) => {
  if (!u || !p) return false;
  if (u.role === 'admin') return true;
  return userProjectRole(u, p) === 'creator';
};

/* ---------- Наказания ---------- */
const loadPunishments = () => loadJSON(PUNISHMENTS_FILE, { items: [] });
const savePunishments = d => saveJSON(PUNISHMENTS_FILE, d);

function getActivePunishment(username, type) {
  const now = Date.now();
  return loadPunishments().items.find(p =>
    p.username === username && p.type === type &&
    (!p.until || new Date(p.until).getTime() > now));
}
const isBanned = u => !!getActivePunishment(u, 'ban');
const isMuted  = u => !!getActivePunishment(u, 'mute');

/* ---------- Чаты / вложения ---------- */
const loadProjectChats = () => loadJSON(PROJECT_CHATS_FILE, { chats: {} });
const saveProjectChats = d => saveJSON(PROJECT_CHATS_FILE, d);
const loadAttachments  = () => loadJSON(ATTACHMENTS_FILE, { items: {} });
const saveAttachments  = d => saveJSON(ATTACHMENTS_FILE, d);

function getProjectChat(projectId) {
  const data = loadProjectChats();
  if (!data.chats[projectId]) data.chats[projectId] = { messages: [], tasks: [] };
  return { data, chat: data.chats[projectId] };
}
/* ---------- Телеметрия (SQLite, батчами) ---------- */
const telemetryQueue = new Map(); // username -> { events: [] }
let telemetryFlushTimer = null;

function flushTelemetry() {
  if (telemetryFlushTimer) { clearTimeout(telemetryFlushTimer); telemetryFlushTimer = null; }
  for (const [username, rec] of telemetryQueue) {
    if (!rec.events.length) continue;
    try { storage.appendTelemetryBatch(username, rec.events); }
    catch (e) { logger.warn({ err: e.message, user: username }, 'telemetry flush failed'); }
  }
  telemetryQueue.clear();
}

function telemetryAppend(username, event) {
  if (!username) return;
  let rec = telemetryQueue.get(username);
  if (!rec) { rec = { events: [] }; telemetryQueue.set(username, rec); }
  rec.events.push({ ts: new Date().toISOString(), ...event });
  if (!telemetryFlushTimer) {
    telemetryFlushTimer = setTimeout(flushTelemetry, cfg.limits.telemetryFlushMs);
    if (telemetryFlushTimer.unref) telemetryFlushTimer.unref();
  }
}
process.on('exit', () => { try { flushTelemetry(); } catch {} });
process.on('SIGINT', () => { try { flushTelemetry(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { flushTelemetry(); } catch {} process.exit(0); });

/* ---------- SSE ---------- */
const sseClients = new Map();
const editSessions = new Map();

function sseAdd(u, res) {
  if (!sseClients.has(u)) sseClients.set(u, new Set());
  const set = sseClients.get(u);
  // Не даём одному пользователю открыть неограниченное число потоков.
  const max = cfg.limits.maxSsePerUser || 5;
  while (set.size >= max) {
    const old = set.values().next().value;
    set.delete(old);
    try { old.end(); } catch {}
  }
  set.add(res);
}

function flushEditSession(key, sess) {
  if (sess.saveTimer) { clearTimeout(sess.saveTimer); sess.saveTimer = null; }
  try {
    const project = loadProjects().projects.find(p => p.id === sess.projectId);
    if (!project) return;
    const full = safeJoin(projectFolder(project), sess.file);
    // Пишем актуальное содержимое, а не baseline: иначе закрытая вкладка
    // молча откатывала уже автосохранённый текст.
    fs.writeFileSync(full, sess.content, 'utf8');
    logChange({ user: 'system', action: 'edit', file: sess.file, projectId: sess.projectId,
      before: sess.baseline, after: sess.content, details: 'autosave on session end' });
  } catch (e) { logger.warn({ err: e.message, key }, 'edit session flush failed'); }
}

function sseRemove(u, res) {
  const s = sseClients.get(u);
  if (!s) return;
  s.delete(res);
  if (s.size) return;
  sseClients.delete(u);
  for (const [key, sess] of editSessions) {
    if (!sess.users.has(u)) continue;
    if (sess.saveTimer) { clearTimeout(sess.saveTimer); sess.saveTimer = null; }
    sess.users.delete(u);
    if (sess.users.size === 0) {
      flushEditSession(key, sess);
      editSessions.delete(key);
    } else {
      sseSendTo([...sess.users.keys()], 'edit-users',
        { key, projectId: sess.projectId, file: sess.file, users: [...sess.users.keys()] });
    }
  }
}
function sseSendTo(users, event, data) {
  const p = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const u of users) {
    const s = sseClients.get(u);
    if (!s) continue;
    for (const res of s) { try { res.write(p); } catch {} }
  }
}
function sseBroadcast(event, data) {
  const p = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of sseClients.values())
    for (const res of s) { try { res.write(p); } catch {} }
}
function sseBroadcastExcept(event, data, exceptUsers = []) {
  const p = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [uname, set] of sseClients) {
    if (exceptUsers.includes(uname)) continue;
    for (const res of set) { try { res.write(p); } catch {} }
  }
}

/* ---------- Уведомления ---------- */
function adminUsernames() {
  try { return loadUsers().users.filter(u => u.role === 'admin').map(u => u.username); }
  catch { return []; }
}

function notifyUser(username, data) {
  if (!username) return null;
  try {
    const n = storage.createNotification({ username, ...data });
    if (n) sseSendTo([username], 'notification', { notification: n });
    return n;
  } catch (e) {
    logger.warn({ err: e.message, user: username }, 'notification failed');
    return null;
  }
}

function notifyMany(usernames, data) {
  const seen = new Set();
  for (const u of usernames) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    notifyUser(u, data);
  }
}

// Упоминания @username в тексте — уведомляем только участников этого чата/проекта.
function notifyMentions(text, allowedUsers, author, link) {
  const found = String(text || '').match(/@([A-Za-z0-9_.\-@]{3,64})/g) || [];
  if (!found.length) return;
  const allowed = new Set(allowedUsers);
  const targets = new Set();
  for (const raw of found) {
    const name = raw.slice(1);
    if (name !== author && allowed.has(name)) targets.add(name);
    if (targets.size >= 5) break;
  }
  for (const name of targets) {
    notifyUser(name, {
      type: 'mention',
      title: 'Вас упомянули в чате',
      body: `${author}: ${String(text).slice(0, 140)}`,
      link,
    });
  }
}

/* ---------- Middleware ---------- */
app.use(express.json({ limit: cfg.limits.jsonBodyMax }));
app.use(express.urlencoded({ extended: true }));

// [SEC] trust proxy — теперь из config (false по умолчанию)
app.set('trust proxy', cfg.trustProxy);

app.use(session({
  name: 'sid',
  secret: cfg.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: cfg.cookie,
  store: storage.createSessionStore(session),
}));

app.use((req, res, next) => {
  req.user = null;
  if (req.session && req.session.user) {
    const fresh = loadUsers().users.find(u => u.id === req.session.user.id);
    if (!fresh) return req.session.destroy(() => next());
    if (isBanned(fresh.username)) {
      return req.session.destroy(() => {
        if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'banned' });
        return res.redirect('/login.html?banned=1');
      });
    }
    req.session.user.role = fresh.role;
    req.session.user.username = fresh.username;
    req.user = req.session.user;
    req.user.theme = fresh.theme || 'dark';
  }
  next();
});

// [SEC] Access log через logger
app.use((req, res, next) => {
  const start = Date.now();
  const ip = req.ip || req.connection?.remoteAddress || '-';
  const ua = req.headers['user-agent'] || '-';
  const ref = req.headers['referer'] || '-';
  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const username = req.user?.username || '-';
    const role = req.user?.role || '-';
    // 304 и статика — 80% строк лога без диагностической ценности.
    const isStatic = STATIC_ASSET_RE.test(req.path) || req.path.startsWith('/api/ads/file/');
    if (status !== 304 && !isStatic) {
      writeAccessLog({
        method: req.method, url: redactUrl(req.originalUrl), status, ms,
        user: username, role, ip, ua, ref,
      });
    }
    if (username !== '-' && status !== 304 && !isStatic) {
      telemetryAppend(username, {
        type: 'request', method: req.method, path: redactUrl(req.originalUrl),
        status, ms, ip, ua,
      });
    }
  });
  next();
});

// [SEC] Усиленные security headers + CSP + HSTS
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (cfg.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  if ((req.headers.accept || '').includes('text/html')) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // Все скрипты — только локальные файлы; inline-скрипты вынесены в js/*.js.
        "script-src 'self'",
        "script-src-attr 'none'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; ')
    );
  }
  next();
});

const requireAuth = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'unauthorized' });
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
  next();
};
const requireSelfAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  // Раньше требовался ещё и логин «admin» — это ломало админку,
  // если администратора переименовали или завели второго.
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
};
const requireNotMutedGeneral = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (isMuted(req.user.username)) return res.status(403).json({ error: 'muted' });
  next();
};
const requireGeneralChatWrite = (req, res, next) => {
  const s = loadSettings();
  if (s.generalChatMode === 'admins_only' && req.user.role !== 'admin')
    return res.status(403).json({ error: 'chat-disabled' });
  next();
};

function projectGuard(level = 'read', from = 'anywhere') {
  return (req, res, next) => {
    const pid =
      (from === 'body'  ? req.body?.projectId :
       from === 'query' ? req.query?.projectId :
       (from === 'path' || from === 'params') ? req.params?.projectId :
       (req.body?.projectId || req.query?.projectId || req.params?.projectId));
    if (!pid) return res.status(400).json({ error: 'projectId required' });
    const project = loadProjects().projects.find(p => p.id === pid);
    if (!project) return res.status(404).json({ error: 'project not found' });

    let ok = false;
    if (level === 'read')    ok = canReadProject(req.user, project);
    else if (level === 'edit')   ok = canEditProject(req.user, project);
    else if (level === 'manage') ok = canManageProject(req.user, project);
    if (!ok) return res.status(403).json({ error: 'forbidden' });

    req.project = project;
    req.projectRoot = projectFolder(project);
    if (!fs.existsSync(req.projectRoot)) fs.mkdirSync(req.projectRoot, { recursive: true });
    next();
  };
}
const rateLimitLogin     = makeRateLimiter(15 * 60 * 1000, 10, 'Слишком много попыток входа. Подождите 15 минут.');
const rateLimitRegister  = makeRateLimiter(60 * 60 * 1000, 15, 'Слишком много попыток регистрации. Подождите час.');
// [SEC] Новые лимиты на дорогие endpoints
const rateLimitDarcus    = makeRateLimiter(60 * 1000, 20, 'Darcus: слишком много запросов, подождите');
const rateLimitExpensive = makeRateLimiter(60 * 1000, 30, 'Слишком много запросов');
const rateLimitUpload    = makeRateLimiter(60 * 1000, 30, 'Слишком много загрузок');

/* ---------- История версий файлов (src/routes/history.js) ---------- */
app.use(require('./src/routes/history')({ storage, requireAuth, projectGuard }));
/* ---------- Центр уведомлений (src/routes/notifications.js) ---------- */
app.use(require('./src/routes/notifications')({ storage, requireAuth }));

/* ---------- SSRF-защита ---------- */
// [SEC] Валидация URL Ollama. Блокирует metadata-сервисы и private ranges в проде.
function validateOllamaUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('Некорректный URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Разрешены только http/https');
  const host = u.hostname.toLowerCase();

  // Metadata всегда блокируем
  if (host === '169.254.169.254' || host === 'metadata.google.internal')
    throw new Error('Запрещённый хост');

  if (cfg.darcus.allowedHosts.length) {
    const allowed = cfg.darcus.allowedHosts.some(h => host === h || host.endsWith('.' + h));
    if (!allowed) throw new Error('Хост не входит в DARCUS_ALLOWED_HOSTS');
    return u.toString();
  }

  if (cfg.isProd) {
    const isPrivate =
      host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith('.local');
    if (isPrivate)
      throw new Error('В production запрещены приватные адреса. Задайте DARCUS_ALLOWED_HOSTS.');
  }
  return u.toString();
}

/* ---------- Health-check ---------- */
const SERVER_START_TIME = Date.now();
app.get('/api/health', (req, res) => {
  const checks = { dataDir: false, projectsRoot: false, users: false, db: false };
  try { checks.dataDir = fs.existsSync(DATA_DIR); } catch {}
  try { checks.projectsRoot = fs.existsSync(PROJECTS_ROOT); } catch {}
  try { checks.users = loadUsers().users.length > 0; } catch {}
  try { checks.db = storage.stats().sizeBytes > 0; } catch {}
  const ok = Object.values(checks).every(Boolean);
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    uptimeSec: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
    checks,
  });
});

app.use(createSystemRouter({
  cfg, storage, darcus, logger, logChange, requireSelfAdmin,
  serverStartTime: SERVER_START_TIME,
  paths: {
    rootDir: __dirname,
    dataDir: DATA_DIR,
    projectsRoot: PROJECTS_ROOT,
    attachDir: ATTACH_DIR,
    logFile: LOG_FILE,
    backupDir: cfg.backupDir,
  },
}));

/* ---------- Auth ---------- */
const DUMMY_HASH = bcrypt.hashSync('dummy-password-never-matches', 10);
app.post('/api/login', rateLimitLogin, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing' });
  const user = loadUsers().users.find(u => u.username === username);
  const passwordOk = bcrypt.compareSync(password, user ? user.password : DUMMY_HASH);
  if (!user || !passwordOk) return res.status(401).json({ error: 'invalid' });

  if (isBanned(user.username)) {
    const p = getActivePunishment(user.username, 'ban');
    return res.status(403).json({ error: 'banned', reason: p?.reason || '', until: p?.until || null });
  }

  const userData = { id: user.id, username: user.username, role: user.role };
  const ip = req.ip || '-';
  const ua = req.headers['user-agent'] || '-';

  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'session error' });
    req.session.user = userData;
    telemetryAppend(user.username, { type: 'login', ip, ua });
    res.json({ user: userData, theme: user.theme || 'dark' });
  });
});

app.post('/api/register', rateLimitRegister, (req, res) => {
  const { username, password, inviteCode } = req.body || {};
  if (!username || !password || !inviteCode)
    return res.status(400).json({ error: 'Заполните все поля' });

  const uname = String(username).trim();
  const pwd = String(password);
  const code = String(inviteCode).trim().toUpperCase();

  if (!/^[\w.\-@]{3,64}$/.test(uname))
    return res.status(400).json({ error: 'Логин: 3–64 символа (a-z, A-Z, 0-9, . _ - @)' });
  if (code.length < 4)
    return res.status(400).json({ error: 'Введите корректный код приглашения' });

  const pwdCheck = validatePassword(pwd, uname);
  if (!pwdCheck.ok) return res.status(400).json({ error: pwdCheck.error });

  const invites = loadInvites();
  const entry = invites.codes.find(c => c.code === code);
  if (!entry) return res.status(404).json({ error: 'Неверный код приглашения' });
  if (entry.usedBy) return res.status(409).json({ error: 'Код уже использован' });

  const data = loadUsers();
  if (data.users.some(u => u.username === uname))
    return res.status(409).json({ error: 'Логин занят' });

  entry.usedBy = uname;
  entry.usedAt = new Date().toISOString();
  saveInvites(invites);

  const user = {
    id: crypto.randomUUID(), username: uname,
    password: bcrypt.hashSync(pwd, 10),
    role: 'member', theme: 'dark', createdAt: new Date().toISOString(),
  };
  data.users.push(user);
  saveUsers(data);

  logChange({ user: uname, action: 'user-register', target: uname, details: `invite=${code}` });
  telemetryAppend(uname, { type: 'register', ip: req.ip || '-', ua: req.headers['user-agent'] || '-', invite: code });

  const userData = { id: user.id, username: user.username, role: user.role };
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'session error' });
    req.session.user = userData;
    res.json({ user: userData, theme: 'dark' });
  });
});

app.post('/api/logout', (req, res) => {
  const u = req.user?.username;
  const ip = req.ip || '-';
  const ua = req.headers['user-agent'] || '-';
  if (u) telemetryAppend(u, { type: 'logout', ip, ua });
  req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: req.user, theme: req.user.theme || 'dark', muted: isMuted(req.user.username) });
});

app.patch('/api/account/theme', requireAuth, (req, res) => {
  const { theme } = req.body || {};
  if (!['dark','light'].includes(theme)) return res.status(400).json({ error: 'bad theme' });
  const data = loadUsers();
  const u = data.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  u.theme = theme;
  saveUsers(data);
  res.json({ ok: true });
});

app.post('/api/telemetry/client', requireAuth, (req, res) => {
  const b = req.body || {};
  const f = v => String(v == null ? '' : v).slice(0, 200);
  telemetryAppend(req.user.username, {
    type: 'client-info',
    screen: f(b.screen), viewport: f(b.viewport), lang: f(b.lang),
    tz: f(b.tz), platform: f(b.platform), referrer: f(b.referrer),
    ip: req.ip || '-', ua: String(req.headers['user-agent'] || '-').slice(0, 300),
  });
  res.json({ ok: true });
});

app.post('/api/account/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (!current || !next) return res.status(400).json({ error: 'Заполните оба поля' });
  const pwdCheck = validatePassword(next, req.user.username);
  if (!pwdCheck.ok) return res.status(400).json({ error: pwdCheck.error });
  const data = loadUsers();
  const user = data.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  if (!bcrypt.compareSync(current, user.password))
    return res.status(401).json({ error: 'Неверный текущий пароль' });
  user.password = bcrypt.hashSync(next, 10);
  saveUsers(data);
  logChange({ user: req.user.username, action: 'self-password-change' });
  telemetryAppend(req.user.username, { type: 'password-change' });
  res.json({ ok: true });
});

app.delete('/api/account', requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Введите пароль' });
  const data = loadUsers();
  const idx = data.users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const user = data.users[idx];
  if (!bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Неверный пароль' });
  const admins = data.users.filter(u => u.role === 'admin');
  if (user.role === 'admin' && admins.length <= 1)
    return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
  data.users.splice(idx, 1);
  saveUsers(data);
  logChange({ user: user.username, action: 'self-delete' });
  telemetryAppend(user.username, { type: 'self-delete' });
  req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); });
});

/* ---------- Пользователи (admin) ---------- */
app.get('/api/users', requireRole('admin'), (req, res) => {
  res.json({ users: loadUsers().users.map(({ password, ...u }) => u) });
});

app.post('/api/users', requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !['member','admin'].includes(role))
    return res.status(400).json({ error: 'Проверьте поля' });
  if (!/^[\w.\-@]{3,64}$/.test(username))
    return res.status(400).json({ error: 'Логин: 3–64 символа' });
  const pwdCheck = validatePassword(password, username);
  if (!pwdCheck.ok) return res.status(400).json({ error: pwdCheck.error });
  const data = loadUsers();
  if (data.users.some(u => u.username === username))
    return res.status(409).json({ error: 'Логин занят' });
  const user = {
    id: crypto.randomUUID(), username,
    password: bcrypt.hashSync(password, 10),
    role, theme: 'dark', createdAt: new Date().toISOString(),
  };
  data.users.push(user); saveUsers(data);
  logChange({ user: req.user.username, action: 'user-create', target: username, details: `role=${role}` });
  const { password: _, ...pub } = user;
  res.json({ user: pub });
});

app.patch('/api/users/:id', requireRole('admin'), (req, res) => {
  const data = loadUsers();
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'not found' });
  const { password, role } = req.body || {};
  if (role && !['member','admin'].includes(role))
    return res.status(400).json({ error: 'Неизвестная роль' });
  if (role && user.role === 'admin' && role !== 'admin') {
    const admins = data.users.filter(u => u.role === 'admin');
    if (admins.length <= 1)
      return res.status(400).json({ error: 'Нельзя снять роль с последнего администратора' });
  }
  if (role) user.role = role;
  if (password) {
    const pwdCheck = validatePassword(password, user.username);
    if (!pwdCheck.ok) return res.status(400).json({ error: pwdCheck.error });
    user.password = bcrypt.hashSync(password, 10);
  }
  saveUsers(data);
  logChange({ user: req.user.username, action: 'user-update', target: user.username,
    details: `role=${user.role}${password ? ', password changed' : ''}` });
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
  const data = loadUsers();
  const idx = data.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (data.users[idx].id === req.user.id)
    return res.status(400).json({ error: 'cannot delete self' });
  if (data.users[idx].role === 'admin' && data.users.filter(u => u.role === 'admin').length <= 1)
    return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
  const [removed] = data.users.splice(idx, 1);
  saveUsers(data);
  logChange({ user: req.user.username, action: 'user-delete', target: removed.username });
  res.json({ ok: true });
});

/* ---------- Инвайты ---------- */
app.get('/api/invites', requireRole('admin'), (req, res) => {
  const items = loadInvites().codes.slice().sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ items });
});

app.post('/api/invites/generate', requireRole('admin'), (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 50);
  const note = String(req.body?.note || '').trim().slice(0, 200);
  const data = loadInvites();
  const created = [];
  for (let i = 0; i < count; i++) {
    let code, tries = 0;
    do { code = generateInviteCode(10); tries++; }
    while (data.codes.some(c => c.code === code) && tries < 30);
    const entry = {
      code, note, createdBy: req.user.username,
      createdAt: new Date().toISOString(),
      usedBy: null, usedAt: null,
    };
    data.codes.push(entry); created.push(entry);
  }
  saveInvites(data);
  logChange({ user: req.user.username, action: 'invite-generate', details: `count=${count}` });
  res.json({ ok: true, created });
});

app.post('/api/invites', requireRole('admin'), (req, res) => {
  let code = String(req.body?.code || '').trim().toUpperCase();
  const note = String(req.body?.note || '').trim().slice(0, 200);
  if (!code) return res.status(400).json({ error: 'Введите код' });
  if (code.length < 4 || code.length > 64)
    return res.status(400).json({ error: 'Код: 4–64 символа' });
  if (!/^[A-Z0-9\-_]+$/.test(code))
    return res.status(400).json({ error: 'Разрешены A–Z, 0–9, дефис и подчёркивание' });
  const data = loadInvites();
  if (data.codes.some(c => c.code === code))
    return res.status(409).json({ error: 'Такой код уже существует' });
  const entry = {
    code, note, createdBy: req.user.username,
    createdAt: new Date().toISOString(),
    usedBy: null, usedAt: null,
  };
  data.codes.push(entry);
  saveInvites(data);
  logChange({ user: req.user.username, action: 'invite-create', details: `code=${code}` });
  res.json({ ok: true, entry });
});

app.delete('/api/invites/:code', requireRole('admin'), (req, res) => {
  const data = loadInvites();
  const idx = data.codes.findIndex(c => c.code === req.params.code);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [removed] = data.codes.splice(idx, 1);
  saveInvites(data);
  logChange({ user: req.user.username, action: 'invite-delete', details: `code=${removed.code}` });
  res.json({ ok: true });
});

/* ---------- Наказания ---------- */
app.get('/api/punishments', requireRole('admin'), (req, res) => {
  const items = loadPunishments().items.slice().sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ items });
});

app.get('/api/punishments/:username', requireRole('admin'), (req, res) => {
  const uname = req.params.username;
  const items = loadPunishments().items.filter(p => p.username === uname);
  const now = Date.now();
  const active = items.filter(p => !p.until || new Date(p.until).getTime() > now);
  res.json({
    items, active,
    banned: active.some(p => p.type === 'ban'),
    muted: active.some(p => p.type === 'mute'),
  });
});

app.post('/api/punishments', requireRole('admin'), (req, res) => {
  const { username, type, reason, duration } = req.body || {};
  if (!username || !['ban','mute'].includes(type))
    return res.status(400).json({ error: 'Проверьте поля' });
  if (!loadUsers().users.some(u => u.username === username))
    return res.status(404).json({ error: 'Пользователь не найден' });
  if (username === req.user.username)
    return res.status(400).json({ error: 'Нельзя наказать себя' });
  let until = null;
  if (duration && duration !== 'forever') {
    const ms = parseInt(duration, 10);
    if (Number.isFinite(ms) && ms > 0) until = new Date(Date.now() + ms).toISOString();
  }
  const item = {
    id: crypto.randomUUID(), type, username,
    reason: String(reason || '').slice(0, 500),
    until, createdAt: new Date().toISOString(),
    createdBy: req.user.username,
  };
  const data = loadPunishments();
  data.items.push(item);
  savePunishments(data);
  logChange({ user: req.user.username, action: 'punish-' + type, target: username,
    details: reason ? reason : (until ? 'до ' + new Date(until).toLocaleString('ru-RU') : 'навсегда') });

  if (type === 'ban') {
    for (const [uname, set] of sseClients) {
      if (uname === username) for (const r of set) { try { r.write(`event: banned\ndata: {}\n\n`); r.end(); } catch {} }
    }
  }
  res.json({ ok: true, item });
});

app.delete('/api/punishments/:id', requireRole('admin'), (req, res) => {
  const data = loadPunishments();
  const idx = data.items.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [removed] = data.items.splice(idx, 1);
  savePunishments(data);
  logChange({ user: req.user.username, action: 'unpunish', target: removed.username,
    details: 'снято: ' + removed.type });
  res.json({ ok: true });
});

/* ---------- Проекты ---------- */
app.get('/api/projects', requireAuth, (req, res) => {
  const all = loadProjects().projects;
  const visible = req.user.role === 'admin'
    ? all
    : all.filter(p => p.members.some(m => m.username === req.user.username));
  res.json({
    projects: visible.map(p => ({
      id: p.id, name: p.name, creator: p.creator, createdAt: p.createdAt,
      myRole: req.user.role === 'admin' ? 'admin' : (p.members.find(m => m.username === req.user.username)?.role || null),
      membersCount: p.members.length,
    })),
  });
});

app.post('/api/projects', requireAuth, (req, res) => {
  let { name } = req.body || {};
  name = String(name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'Введите имя проекта' });
  const id = crypto.randomUUID();
  const folder = id;
  const project = {
    id, name, folder, creator: req.user.username,
    members: [{ username: req.user.username, role: 'creator' }],
    createdAt: new Date().toISOString(),
  };
  const data = loadProjects();
  data.projects.push(project);
  saveProjects(data);
  fs.mkdirSync(path.join(PROJECTS_ROOT, folder), { recursive: true });
  logChange({ user: req.user.username, action: 'project-create', details: `project=${name} (${id})` });
  res.json({ ok: true, project: { id, name, creator: project.creator } });
});

app.get('/api/projects/:projectId', requireAuth, (req, res) => {
  const p = loadProjects().projects.find(x => x.id === req.params.projectId);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!canReadProject(req.user, p)) return res.status(403).json({ error: 'forbidden' });
  res.json({
    project: {
      id: p.id, name: p.name, creator: p.creator, createdAt: p.createdAt,
      members: p.members,
      myRole: req.user.role === 'admin' ? 'admin' :
        (p.members.find(m => m.username === req.user.username)?.role || null),
    },
  });
});

app.patch('/api/projects/:projectId', requireAuth, (req, res) => {
  const p = loadProjects().projects.find(x => x.id === req.params.projectId);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!canManageProject(req.user, p)) return res.status(403).json({ error: 'forbidden' });
  const { name } = req.body || {};
  if (name !== undefined) {
    const n = String(name).trim().slice(0, 100);
    if (!n) return res.status(400).json({ error: 'Пустое имя' });
    p.name = n;
  }
  saveProjects(loadProjects());
  logChange({ user: req.user.username, action: 'project-update', projectId: p.id, details: `name=${p.name}` });
  res.json({ ok: true });
});

app.delete('/api/projects/:projectId', requireRole('admin'), (req, res) => {
  const data = loadProjects();
  const idx = data.projects.findIndex(x => x.id === req.params.projectId);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [removed] = data.projects.splice(idx, 1);
  saveProjects(data);
  try { fs.rmSync(projectFolder(removed), { recursive: true, force: true }); } catch {}
  logChange({ user: req.user.username, action: 'project-delete', details: `project=${removed.name} (${removed.id})` });
  res.json({ ok: true });
});

app.post('/api/projects/:projectId/members', requireAuth, (req, res) => {
  const p = loadProjects().projects.find(x => x.id === req.params.projectId);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!canManageProject(req.user, p)) return res.status(403).json({ error: 'forbidden' });
  const { username, role } = req.body || {};
  if (!username || !['member','editor','creator'].includes(role))
    return res.status(400).json({ error: 'Проверьте поля' });
  if (!loadUsers().users.some(u => u.username === username))
    return res.status(404).json({ error: 'Пользователь не найден' });
  if (p.members.some(m => m.username === username))
    return res.status(409).json({ error: 'Уже в проекте' });
  p.members.push({ username, role });
  saveProjects(loadProjects());
  logChange({ user: req.user.username, action: 'project-member-add', projectId: p.id, target: username, details: `role=${role}` });
  sseSendTo([username], 'project-update', { projectId: p.id });
  notifyUser(username, {
    type: 'project', title: 'Вас добавили в проект',
    body: `${req.user.username} добавил вас в проект «${p.name}» (роль: ${role})`,
    link: 'project:' + p.id, projectId: p.id,
  });
  res.json({ ok: true });
});

app.patch('/api/projects/:projectId/members/:username', requireAuth, (req, res) => {
  const p = loadProjects().projects.find(x => x.id === req.params.projectId);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!canManageProject(req.user, p)) return res.status(403).json({ error: 'forbidden' });
  const m = p.members.find(x => x.username === req.params.username);
  if (!m) return res.status(404).json({ error: 'not found' });
  const { role } = req.body || {};
  if (!['member','editor','creator'].includes(role)) return res.status(400).json({ error: 'bad role' });
  if (m.username === p.creator && role !== 'creator')
    return res.status(400).json({ error: 'Нельзя понизить создателя' });
  m.role = role;
  saveProjects(loadProjects());
  logChange({ user: req.user.username, action: 'project-member-role', projectId: p.id, target: m.username, details: `role=${role}` });
  sseSendTo([m.username], 'project-update', { projectId: p.id });
  res.json({ ok: true });
});

app.delete('/api/projects/:projectId/members/:username', requireAuth, (req, res) => {
  const p = loadProjects().projects.find(x => x.id === req.params.projectId);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!canManageProject(req.user, p)) return res.status(403).json({ error: 'forbidden' });
  if (req.params.username === p.creator)
    return res.status(400).json({ error: 'Нельзя удалить создателя' });
  const idx = p.members.findIndex(x => x.username === req.params.username);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  p.members.splice(idx, 1);
  saveProjects(loadProjects());
  logChange({ user: req.user.username, action: 'project-member-remove', projectId: p.id, target: req.params.username });
  sseSendTo([req.params.username], 'project-update', { projectId: p.id });
  res.json({ ok: true });
});

app.get('/api/projects/:projectId/activity', requireAuth, (req, res) => {
  const p = loadProjects().projects.find(x => x.id === req.params.projectId);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!canManageProject(req.user, p)) return res.status(403).json({ error: 'forbidden' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const entries = storage.queryChanges({ projectId: p.id, limit, offset: 0, full: false }).entries;
  res.json({ entries });
});

/* ---------- Журнал ---------- */
app.get('/api/changes', requireRole('admin'), (req, res) => {
  const { file, days, full, projectId } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || (full === '1' ? 100 : 500), 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const d = parseInt(days, 10);
  const result = storage.queryChanges({
    file: file ? String(file) : undefined,
    projectId: projectId ? String(projectId) : undefined,
    days: Number.isFinite(d) && d > 0 ? d : undefined,
    limit, offset, full: full === '1',
  });
  res.json({ entries: result.entries, total: result.total, limit, offset });
});

app.post('/api/revert/:id', requireRole('admin'), (req, res) => {
  const entry = storage.getChange(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  if (entry.reverted) return res.status(400).json({ error: 'already reverted' });
  const project = loadProjects().projects.find(p => p.id === entry.projectId);
  if (!project) return res.status(400).json({ error: 'project missing' });
  const root = projectFolder(project);
  try {
    const full = safeJoin(root, entry.file || '');
    if (entry.before === '[REDACTED: sensitive file]' || String(entry.before || '').endsWith('[...truncated]')) {
      return res.status(400).json({ error: 'Содержимое было отредактировано в журнале (секрет/большой файл) — откат недоступен' });
    }
    switch (entry.action) {
      case 'edit': fs.writeFileSync(full, entry.before ?? '', 'utf8'); break;
      case 'upload': case 'create': case 'mkdir':
        try {
          if (fs.statSync(full).isDirectory()) fs.rmSync(full, { recursive: true, force: true });
          else fs.unlinkSync(full);
        } catch {}
        break;
      case 'delete':
        if (entry.isDir) throw new Error('Восстановление папок не поддерживается — используйте Корзину');
        if (entry.before === undefined) throw new Error('Файл был удалён в Корзину — восстановите его через раздел «Корзина»');
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, entry.before, 'utf8');
        break;
      case 'move': case 'rename': {
        const oldFull = safeJoin(root, entry.from);
        fs.mkdirSync(path.dirname(oldFull), { recursive: true });
        fs.renameSync(full, oldFull);
        break;
      }
      default: return res.status(400).json({ error: 'Нельзя откатить' });
    }

    /* [PATCH #4] Кэш эмбеддингов мог содержать чанки удалённого/перезаписанного файла.
       Если revert откатывал:
         • edit   — файл перезаписан старым содержимым → чанки устарели;
         • upload — файла больше нет → чанки-призраки;
         • create — файла больше нет → чанки-призраки;
         • mkdir  — то же (но там файлов и не было);
         • delete — файл вернулся → его надо переиндексировать;
         • move / rename — файл вернулся на старый путь → чанки по newPath устарели.
       В любом из этих случаев сбрасываем оба пути. */
    try { darcus.invalidateFileCache(entry.projectId, entry.file || ''); } catch {}
    try { darcus.invalidateFileCache(entry.projectId, entry.from  || ''); } catch {}

    entry.reverted = true;
    entry.revertedAt = new Date().toISOString();
    entry.revertedBy = req.user.username;
    storage.updateChange(entry.id, {
      reverted: true, revertedAt: entry.revertedAt, revertedBy: entry.revertedBy,
    });
    logChange({ user: req.user.username, action: 'revert', projectId: entry.projectId,
      file: entry.file, target: entry.id, details: `откат «${entry.action}»` });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Настройки ---------- */
app.get('/api/settings', requireAuth, (req, res) => {
  const s = loadSettings();
  const limit = req.user.role === 'admin' ? null : s.uploadLimitMB;
  res.json({ uploadLimitMB: limit, generalChatMode: s.generalChatMode || 'everyone' });
});
app.patch('/api/settings', requireRole('admin'), (req, res) => {
  const s = loadSettings();
  const { uploadLimitMB, generalChatMode } = req.body || {};
  if (uploadLimitMB !== undefined) {
    const mb = parseInt(uploadLimitMB, 10);
    if (!Number.isFinite(mb) || mb < 1 || mb > cfg.limits.uploadMaxMB)
      return res.status(400).json({ error: 'bad limit' });
    s.uploadLimitMB = mb;
  }
  if (generalChatMode !== undefined) {
    if (!['everyone','admins_only'].includes(generalChatMode))
      return res.status(400).json({ error: 'bad chat mode' });
    s.generalChatMode = generalChatMode;
  }
  saveSettings(s);
  logChange({ user: req.user.username, action: 'settings-update',
    details: `limit=${s.uploadLimitMB} chat=${s.generalChatMode}` });
  res.json({ ok: true, settings: { uploadLimitMB: s.uploadLimitMB, generalChatMode: s.generalChatMode } });
});

/* ---------- Статика ---------- */
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Вендоренные библиотеки неизменяемы, остальное — ревалидация по ETag.
    if (/[\\/]vendor[\\/]/.test(filePath))
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else
      res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('/files/:projectId/{*filePath}', requireAuth, (req, res) => {
  const project = loadProjects().projects.find(p => p.id === req.params.projectId);
  if (!project || !canReadProject(req.user, project))
    return res.status(403).send('forbidden');
  let raw = req.params.filePath;
  if (Array.isArray(raw)) raw = raw.join('/');
  if (typeof raw !== 'string') raw = '';
  // Express 5 уже декодировал param — повторный decodeURIComponent ломал имена с «%».
  const rel = raw.replace(/^\/+/, '');
  const root = projectFolder(project);
  let full;
  try { full = safeJoin(root, rel); } catch { return res.status(400).send('bad path'); }
  fs.realpath(full, (err, real) => {
    if (err) return res.status(404).send('not found');
    if (real !== root && !real.startsWith(root + path.sep))
      return res.status(403).send('forbidden');
    fs.stat(real, (err2, st) => {
      if (err2 || !st.isFile()) return res.status(404).send('not found');
      sendProjectFile(res, real);
    });
  });
});

/* =========================================================
   SHARE-LINKS
   ========================================================= */
const rateLimitShareAccess = makeRateLimiter(60 * 1000, 60, 'Слишком много запросов');

app.get('/api/shares', requireAuth, (req, res) => {
  const data = pruneExpiredShares();
  const items = req.user.role === 'admin'
    ? data.items
    : data.items.filter(it => it.createdBy === req.user.username);
  res.json({ items });
});

app.post('/api/shares', requireAuth, projectGuard('read', 'body'), (req, res) => {
  const rel = String(req.body?.path || '');
  let full;
  try { full = safeJoin(req.projectRoot, rel); } catch { return res.status(400).json({ error: 'bad path' }); }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile())
    return res.status(404).json({ error: 'file not found' });
  const maxDays = Math.min(Math.max(parseInt(req.body?.expiresInDays, 10) || 7, 0), 365);
  const expiresAt = maxDays > 0 ? new Date(Date.now() + maxDays * 86400 * 1000).toISOString() : null;
  const data = loadShares();
  const entry = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString('base64url'),
    projectId: req.project.id,
    path: rel,
    createdBy: req.user.username,
    createdAt: new Date().toISOString(),
    expiresAt, revoked: false, accessCount: 0,
  };
  data.items.push(entry);
  saveShares(data);
  logChange({ user: req.user.username, action: 'share-create', file: rel, projectId: req.project.id,
    details: `expires=${expiresAt || 'never'}` });
  res.json({ ok: true, share: entry, url: `/s/${entry.token}` });
});

app.delete('/api/shares/:id', requireAuth, (req, res) => {
  const data = loadShares();
  const entry = data.items.find(it => it.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  if (entry.createdBy !== req.user.username && req.user.role !== 'admin')
    return res.status(403).json({ error: 'forbidden' });
  entry.revoked = true;
  saveShares(data);
  logChange({ user: req.user.username, action: 'share-revoke', target: entry.id, file: entry.path });
  res.json({ ok: true });
});

app.get('/s/:token', rateLimitShareAccess, (req, res) => {
  const data = loadShares();
  const entry = data.items.find(it => it.token === req.params.token);
  if (!entry || entry.revoked) return res.status(404).send('Ссылка не найдена или отозвана');
  if (isShareExpired(entry)) return res.status(410).send('Срок действия ссылки истёк');
  const project = loadProjects().projects.find(p => p.id === entry.projectId);
  if (!project) return res.status(404).send('Проект не найден');
  let full;
  try { full = safeJoin(projectFolder(project), entry.path); } catch { return res.status(400).send('bad path'); }
  fs.realpath(full, (err, real) => {
    const root = projectFolder(project);
    if (err || (real !== root && !real.startsWith(root + path.sep)))
      return res.status(404).send('Файл не найден');
    fs.stat(real, (err2, st) => {
      if (err2 || !st.isFile()) return res.status(404).send('Файл не найден');
      entry.accessCount = (entry.accessCount || 0) + 1;
      entry.lastAccessAt = new Date().toISOString();
      saveShares(data);
      sendProjectFile(res, real);
    });
  });
});

/* ---------- Дерево ---------- */
app.get('/api/tree', requireAuth, projectGuard('read'), (req, res) => {
  try { res.json({ tree: buildTree(req.projectRoot) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
function buildTree(dir, root) {
  root = root || dir;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) items.push({ name: e.name, path: rel, isDir: true, children: buildTree(full, root) });
    else if (e.isFile()) items.push({ name: e.name, path: rel, isDir: false });
  }
  items.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);
  return items;
}

/* =========================================================
   [NEW] Гибридный поиск: keyword + семантика.
   Возвращает массив записей, отсортированный по объединённому скору.
   Единица измерения скора — 0..1, где 1 = идеальное совпадение.
   ========================================================= */
async function hybridSearchProject(root, projectId, projectName, q, opts = {}) {
  const MAX_FILE_SIZE = 20 * 1024 * 1024;
  const MAX_PER_PROJECT = opts.maxPerProject || 100;
  const IMG_OCR_EXT = ['png','jpg','jpeg','gif','webp','bmp'];
  const ocrCache = darcus.loadOcrCache();
  const found = new Map();   // path → запись

  /* ---------- 1) KEYWORD ---------- */
  async function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const rel  = path.relative(root, full).split(path.sep).join('/');
      const nameMatch = e.name.toLowerCase().includes(q);

      if (nameMatch) {
        const cur = found.get(rel) || { path: rel, name: e.name,
          type: e.isDirectory() ? 'dir' : 'file', kwScore: 0 };
        cur.kwScore = Math.max(cur.kwScore, 1.0);
        found.set(rel, cur);
      }

      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.isFile()) continue;

      const ext = e.name.split('.').pop().toLowerCase();

      // Картинки — по OCR-кэшу
      if (IMG_OCR_EXT.includes(ext)) {
        const hash = darcus.getFileSha1(full);
        if (!hash) continue;
        const item = ocrCache.items && ocrCache.items[hash];
        if (!item) continue;
        const ocr = [item.description, item.text].filter(Boolean).join('\n');
        if (!ocr) continue;
        const idx = ocr.toLowerCase().indexOf(q);
        if (idx < 0) continue;
        const start = Math.max(0, idx - 60);
        const end   = Math.min(ocr.length, idx + q.length + 60);
        const snippet = (start > 0 ? '…' : '') +
          ocr.slice(start, end).replace(/\s+/g, ' ') +
          (end < ocr.length ? '…' : '');
        const cur = found.get(rel) || { path: rel, name: e.name,
          type: 'file', kwScore: 0 };
        cur.kwScore = Math.max(cur.kwScore, 0.8);
        cur.snippet = snippet;
        cur.isImage = true;
        found.set(rel, cur);
        continue;
      }

      // Текстовые + Office + PDF — через extractor
      if (!extractor.isExtractable(ext)) continue;
      try {
        const st = fs.statSync(full);
        if (st.size > MAX_FILE_SIZE) continue;
        const content = extractor.isTextExt(ext)
          ? fs.readFileSync(full, 'utf8')
          : await extractor.extractText(full, ext);
        const idx = content.toLowerCase().indexOf(q);
        if (idx < 0) continue;
        const start = Math.max(0, idx - 60);
        const end   = Math.min(content.length, idx + q.length + 60);
        const snippet = (start > 0 ? '…' : '') +
          content.slice(start, end).replace(/\s+/g, ' ') +
          (end < content.length ? '…' : '');
        const cur = found.get(rel) || { path: rel, name: e.name,
          type: 'file', kwScore: 0 };
        cur.kwScore = Math.max(cur.kwScore, 0.7);
        cur.snippet = snippet;
        found.set(rel, cur);
      } catch {}
    }
  }
  try { await walk(root); } catch {}

  /* ---------- 2) SEMANTIC ---------- */
  try {
    const semProjects = [{ id: projectId, name: projectName, root }];
    const sem = await darcus.semanticSearch(semProjects, q, {
      maxChunks: 40,
      minScore: 0.35,
    });
    for (const s of sem) {
      const cur = found.get(s.path) || { path: s.path,
        name: s.path.split('/').pop(), type: 'file', kwScore: 0 };
      cur.semScore = Math.max(cur.semScore || 0, s.score);
      if (!cur.snippet) {
        cur.snippet = (s.content || '').slice(0, 200).replace(/\s+/g, ' ');
      }
      found.set(s.path, cur);
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'hybridSearch: semantic failed');
  }

  /* ---------- 3) РАНЖИРОВАНИЕ ---------- */
  const arr = [...found.values()].map(r => {
    const kw  = r.kwScore  || 0;
    const sem = r.semScore || 0;
    r.score = kw * 0.5 + sem * 0.5 + (kw > 0 && sem > 0 ? 0.15 : 0);
    r.matchType =
      (kw >= 0.9 && sem > 0) ? 'both' :
      (kw >= 0.9)            ? 'name' :
      (kw > 0 && r.isImage)  ? 'image' :
      (kw > 0)               ? 'content' :
                               'semantic';
    return r;
  });
  arr.sort((a, b) => b.score - a.score);
  return arr.slice(0, MAX_PER_PROJECT);
}

/* ---------- Поиск ---------- */
app.get('/api/search', requireAuth, rateLimitExpensive, projectGuard('read'), async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json({ results: [], query: q });

  try {
    const results = await hybridSearchProject(
      req.projectRoot,
      req.project.id,
      req.project.name,
      q,
      { maxPerProject: 100 }
    );
    // Все записи уже имеют поля type, path, name, snippet, matchType, score
    res.json({ results, query: q });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search-all', requireAuth, rateLimitExpensive, async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json({ results: [], query: q });

  const MAX_RESULTS = 150;
  const allProjects = loadProjects().projects;
  const results = [];

  for (const project of allProjects) {
    if (results.length >= MAX_RESULTS) break;
    if (!canReadProject(req.user, project)) continue;
    const root = projectFolder(project);
    if (!fs.existsSync(root)) continue;

    try {
      const part = await hybridSearchProject(
        root,
        project.id,
        project.name,
        q,
        { maxPerProject: 50 }
      );
      for (const r of part) {
        results.push({
          ...r,
          projectId:   project.id,
          projectName: project.name,
        });
      }
    } catch (e) {
      logger.warn({ err: e.message, projectId: project.id }, 'search-all: hybrid failed');
    }
  }

  // Глобальная сортировка по объединённому скору.
  // Файл, найденный и по слову, и по смыслу, всплывёт наверх.
  results.sort((a, b) => b.score - a.score);
  res.json({ results: results.slice(0, MAX_RESULTS), query: q });
});

/* ---------- Raw ---------- */
app.get('/api/raw', requireAuth, projectGuard('read'), (req, res) => {
  const rel = req.query.path || '';
  let full; try { full = safeJoin(req.projectRoot, rel); } catch { return res.status(403).end(); }
  fs.realpath(full, (err, real) => {
    if (err || !real.startsWith(req.projectRoot + path.sep)) return res.status(404).end();
    try { res.type('text/plain; charset=utf-8').send(fs.readFileSync(real, 'utf8')); }
    catch { res.status(404).end(); }
  });
});

/* ---------- CRUD ---------- */
app.post('/api/create', requireAuth, projectGuard('edit', 'body'), (req, res) => {
  let { dir = '', name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Введите имя' });
  if (!name.toLowerCase().endsWith('.md')) name += '.md';
  name = name.replace(/[<>:"|?*\x00-\x1f\/\\]/g, '_').trim();
  if (!name || name === '.md') return res.status(400).json({ error: 'Некорректное имя' });
  let dirFull; try { dirFull = safeJoin(req.projectRoot, dir); } catch { return res.status(403).json({ error: 'forbidden' }); }
  if (!fs.existsSync(dirFull)) fs.mkdirSync(dirFull, { recursive: true });
  const full = path.join(dirFull, name);
  const rel = path.relative(req.projectRoot, full).split(path.sep).join('/');
  if (fs.existsSync(full)) return res.json({ ok: true, path: rel, existed: true });
  fs.writeFileSync(full, `# ${name.replace(/\.md$/i, '')}\n\n`, 'utf8');
  logChange({ user: req.user.username, action: 'create', file: rel, projectId: req.project.id });
  res.json({ ok: true, path: rel });
});

app.post('/api/mkdir', requireAuth, projectGuard('edit', 'body'), (req, res) => {
  let { dir = '', name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Введите имя' });
  name = name.replace(/[<>:"|?*\x00-\x1f\/\\]/g, '_').trim();
  if (!name) return res.status(400).json({ error: 'Некорректное имя' });
  let dirFull; try { dirFull = safeJoin(req.projectRoot, dir); } catch { return res.status(403).json({ error: 'forbidden' }); }
  const full = path.join(dirFull, name);
  if (fs.existsSync(full)) return res.status(409).json({ error: 'Папка уже существует' });
  fs.mkdirSync(full, { recursive: true });
  const rel = path.relative(req.projectRoot, full).split(path.sep).join('/');
  logChange({ user: req.user.username, action: 'mkdir', file: rel, projectId: req.project.id });
  res.json({ ok: true, path: rel });
});

app.post('/api/rename', requireAuth, projectGuard('edit', 'body'), (req, res) => {
  const { path: rel, newName } = req.body || {};
  if (!rel || !newName || typeof newName !== 'string')
    return res.status(400).json({ error: 'bad input' });
  let full; try { full = safeJoin(req.projectRoot, rel); } catch { return res.status(403).json({ error: 'forbidden' }); }
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  let name = newName.replace(/[<>:"|?*\x00-\x1f\/\\]/g, '_').trim();
  if (!name) return res.status(400).json({ error: 'Некорректное имя' });
  const dir = path.dirname(full);
  const target = path.join(dir, name);
  if (target === full) return res.json({ ok: true, path: rel });
  if (fs.existsSync(target)) return res.status(409).json({ error: 'Уже существует' });
  fs.renameSync(full, target);
  const newRel = path.relative(req.projectRoot, target).split(path.sep).join('/');
  // Старый путь больше не существует — выкидываем его чанки из семантического кэша.
  try { darcus.invalidateFileCache(req.project.id, rel); } catch {}
  logChange({ user: req.user.username, action: 'rename', file: newRel, from: rel, projectId: req.project.id });
  res.json({ ok: true, path: newRel });
});

/* ---------- Прямая запись содержимого файла (для ACTION-блоков Darcus) ---------- */
app.post('/api/write', requireAuth, projectGuard('edit', 'body'), (req, res) => {
  const { file, content } = req.body || {};
  if (!file || typeof file !== 'string' || typeof content !== 'string')
    return res.status(400).json({ error: 'bad input' });
  if (!isTextFile(file)) return res.status(400).json({ error: 'Только текстовые файлы' });
  if (content.length > cfg.limits.editContentMax)
    return res.status(413).json({ error: 'Слишком большой файл' });

  let full;
  try { full = safeJoin(req.projectRoot, file); }
  catch { return res.status(403).json({ error: 'forbidden' }); }

  let before = '';
  try { if (fs.existsSync(full)) before = fs.readFileSync(full, 'utf8'); } catch {}

  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Не удалось записать: ' + e.message });
  }

  logChange({ user: req.user.username, action: 'edit', file, before, after: content, projectId: req.project.id });
  try { refreshEmbedIndex(req.project.id, file, full); } catch {}
  res.json({ ok: true, path: file });
});

app.delete('/api/delete', requireAuth, projectGuard('edit', 'query'), (req, res) => {
  const rel = req.query.path || '';
  let full; try { full = safeJoin(req.projectRoot, rel); } catch { return res.status(403).json({ error: 'forbidden' }); }
  let st;
  try { st = fs.statSync(full); } catch { return res.status(404).json({ error: 'not found' }); }
  const trashId = crypto.randomUUID();
  const trashDir = trashDirFor(req.project);
  const trashPath = path.join(trashDir, trashId + '__' + path.basename(full));
  try { fs.renameSync(full, trashPath); }
  catch (e) { return res.status(500).json({ error: 'Не удалось удалить: ' + e.message }); }
  const data = loadTrash();
  data.items.push({
    id: trashId, projectId: req.project.id, originalPath: rel, trashPath,
    isDir: st.isDirectory(), deletedBy: req.user.username,
    deletedAt: new Date().toISOString(),
  });
  saveTrash(data);
  logChange({ user: req.user.username, action: 'delete', file: rel, isDir: st.isDirectory(),
    projectId: req.project.id, details: `в корзину (${TRASH_RETENTION_DAYS} дн.)` });
  try { darcus.invalidateFileCache(req.project.id, rel); } catch {}
  res.json({ ok: true, trashId });
});

/* ---------- Корзина ---------- */
app.get('/api/trash', requireAuth, projectGuard('read', 'query'), (req, res) => {
  const data = purgeExpiredTrash();
  const items = data.items.filter(it => it.projectId === req.project.id);
  res.json({ items, retentionDays: TRASH_RETENTION_DAYS });
});

app.post('/api/trash/:id/restore', requireAuth, (req, res) => {
  const data = loadTrash();
  const item = data.items.find(it => it.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const project = loadProjects().projects.find(p => p.id === item.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (!canEditProject(req.user, project)) return res.status(403).json({ error: 'forbidden' });
  let dest;
  try { dest = safeJoin(projectFolder(project), item.originalPath); } catch { return res.status(400).json({ error: 'bad path' }); }
  if (fs.existsSync(dest)) return res.status(409).json({ error: 'На исходном месте уже есть файл с таким именем' });
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(item.trashPath, dest);
  } catch (e) { return res.status(500).json({ error: 'Не удалось восстановить: ' + e.message }); }
  // Файл вернулся на исходное место — сразу переиндексируем его.
  try { darcus.invalidateFileCache(project.id, item.originalPath); } catch {}
  try { refreshEmbedIndex(project.id, item.originalPath, dest); } catch {}
  data.items = data.items.filter(it => it.id !== item.id);
  saveTrash(data);
  logChange({ user: req.user.username, action: 'restore', file: item.originalPath, projectId: project.id });
  res.json({ ok: true });
});

app.delete('/api/trash/:id', requireAuth, (req, res) => {
  const data = loadTrash();
  const item = data.items.find(it => it.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const project = loadProjects().projects.find(p => p.id === item.projectId);
  if (project && !canEditProject(req.user, project)) return res.status(403).json({ error: 'forbidden' });
  try { fs.rmSync(item.trashPath, { recursive: true, force: true }); } catch {}
  try { darcus.invalidateFileCache(item.projectId, item.originalPath); } catch {}
  data.items = data.items.filter(it => it.id !== item.id);
  saveTrash(data);
  logChange({ user: req.user.username, action: 'trash-purge', file: item.originalPath, projectId: item.projectId });
  res.json({ ok: true });
});

function listRecursive(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listRecursive(full));
    else out.push(full);
  }
  return out;
}

app.post('/api/move', requireAuth, projectGuard('edit', 'body'), (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'bad input' });
  let fromFull, toFull;
  try { fromFull = safeJoin(req.projectRoot, from); toFull = safeJoin(req.projectRoot, to); }
  catch { return res.status(403).json({ error: 'forbidden' }); }
  if (!fs.existsSync(fromFull)) return res.status(404).json({ error: 'not found' });
  if (toFull.startsWith(fromFull + path.sep) || toFull === fromFull)
    return res.status(400).json({ error: 'invalid target' });
  const toDir = path.dirname(toFull);
  if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
  let finalTo = toFull;
  if (fs.existsSync(finalTo)) {
    const ext = path.extname(finalTo);
    const base = path.basename(finalTo, ext);
    let i = 1;
    while (fs.existsSync(finalTo)) { finalTo = path.join(toDir, `${base} (${i})${ext}`); i++; }
  }
  fs.renameSync(fromFull, finalTo);
  const relFrom = path.relative(req.projectRoot, fromFull).split(path.sep).join('/');
  const relTo = path.relative(req.projectRoot, finalTo).split(path.sep).join('/');
  // Старый путь протух — инвалидируем; по новому пути файл будет проиндексирован
  // при следующем проходе (или вручную через /api/darcus/reindex).
  try { darcus.invalidateFileCache(req.project.id, relFrom); } catch {}
  logChange({ user: req.user.username, action: 'move', file: relTo, from: relFrom, projectId: req.project.id });
  res.json({ ok: true, path: relTo });
});

/* ---------- Upload ---------- */
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

// Если запрос отклонён после того, как multer уже записал файл (403/404/400),
// удаляем временный файл. Раньше data/tmp забивался мусором до рестарта.
function cleanupRejectedUpload(req, res, next) {
  res.on('finish', () => {
    if (res.statusCode >= 400 && req.file && req.file.path) {
      fs.unlink(req.file.path, () => {});
    }
  });
  next();
}

app.post('/api/upload', requireAuth, rateLimitUpload,
  (req, res, next) => {
    // Отсекаем заведомо большие запросы до записи на диск.
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (Number.isFinite(len) && len > 0) {
      const s = loadSettings();
      const limitMB = req.user.role === 'admin' ? cfg.limits.uploadMaxMB : s.uploadLimitMB;
      const hardCap = (limitMB + 1) * 1024 * 1024; // +1 МБ на multipart-обёртку
      if (len > hardCap)
        return res.status(413).json({ error: `Файл превышает лимит ${limitMB} МБ.` });
    }
    next();
  },
  (req, res, next) => upload.single('file')(req, res, err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ error: 'Файл превышает жёсткий лимит сервера' });
      return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
    }
    next();
  }),
  cleanupRejectedUpload,
  projectGuard('edit', 'body'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const cleanup = () => fs.unlink(req.file.path, () => {});
    const s = loadSettings();
    const limitBytes = req.user.role === 'admin' ? Infinity : s.uploadLimitMB * 1024 * 1024;
    if (req.file.size > limitBytes) {
      cleanup();
      const sizeMB = (req.file.size / 1024 / 1024).toFixed(1);
      return res.status(413).json({ error: `Файл ${sizeMB} МБ превышает лимит ${s.uploadLimitMB} МБ.` });
    }
    const dir = String(req.body.dir || '').replace(/\\/g, '/').replace(/^\/+/, '');
    let dirFull; try { dirFull = safeJoin(req.projectRoot, dir); } catch { cleanup(); return res.status(403).json({ error: 'forbidden' }); }
    if (!fs.existsSync(dirFull)) fs.mkdirSync(dirFull, { recursive: true });
    let name = decodeUploadFilename(req.file.originalname);
    name = path.basename(name).replace(/[<>:"|?*\x00-\x1f]/g, '_').trim() || 'file';
    let target = path.join(dirFull, name);
    if (fs.existsSync(target)) {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let i = 1;
      while (fs.existsSync(target)) { target = path.join(dirFull, `${base} (${i})${ext}`); i++; }
    }
    fs.rename(req.file.path, target, err => {
      if (err) { cleanup(); return res.status(500).json({ error: err.message }); }
      const rel = path.relative(req.projectRoot, target).split(path.sep).join('/');
      logChange({ user: req.user.username, action: 'upload', file: rel, projectId: req.project.id,
        details: `size=${(req.file.size / 1024).toFixed(1)} KB` });
      try { queueImageAnalysis(req.project.id, rel, path.join(req.projectRoot, rel)); } catch {}
      try { refreshEmbedIndex(req.project.id, rel, path.join(req.projectRoot, rel)); } catch {}
      res.json({ ok: true, path: rel });
    });
  });

/* ---------- Resolve ---------- */
app.get('/api/resolve', requireAuth, projectGuard('read'), (req, res) => {
  const root = req.projectRoot;
  const from = String(req.query.from || '').replace(/\\/g, '/');
  const name = req.query.name || '';
  if (!name || name.includes('..') || name.includes('\0'))
    return res.status(400).json({ error: 'bad name' });
  const candidates = [];
  if (from) candidates.push(path.join(from, name));
  for (const sub of ['', 'attachments', '_attachments', 'images', 'files', 'Вложения', 'att']) {
    if (from) candidates.push(path.join(from, sub, name));
    candidates.push(path.join(sub, name));
  }
  for (const rel of candidates) {
    let full; try { full = safeJoin(root, rel); } catch { continue; }
    try {
      const real = fs.realpathSync(full);
      if (real !== root && !real.startsWith(root + path.sep)) continue;
      if (fs.statSync(real).isFile())
        return res.json({ path: path.relative(root, real).split(path.sep).join('/') });
    } catch {}
  }
  const found = findFile(root, name, 6);
  if (found) return res.json({ path: path.relative(root, found).split(path.sep).join('/') });
  res.status(404).json({ error: 'not found' });
});
function findFile(dir, name, depth) {
  if (depth < 0) return null;
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of es) if (e.isFile() && !e.name.startsWith('.') && e.name === name)
    return path.join(dir, e.name);
  for (const e of es) if (e.isDirectory() && !e.name.startsWith('.')) {
    const r = findFile(path.join(dir, e.name), name, depth - 1);
    if (r) return r;
  }
  return null;
}

/* ---------- SSE ---------- */
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const u = req.user.username;
  res.write(`retry: 3000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ user: u })}\n\n`);
  sseAdd(u, res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseRemove(u, res); });
});

/* ---------- Общий чат ---------- */
app.delete('/api/chat/message/:id', requireAuth, (req, res) => {
  const me = req.user.username;
  const data = loadJSON(CHAT_FILE, { messages: [] });
  const idx = data.messages.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const msg = data.messages[idx];
  if (msg.to !== 'general') return res.status(400).json({ error: 'wrong chat' });
  if (msg.from !== me && req.user.role !== 'admin')
    return res.status(403).json({ error: 'forbidden' });

  data.messages.splice(idx, 1);
  saveJSON(CHAT_FILE, data);

  telemetryAppend(me, { type: 'chat-message-delete', id: msg.id, from: msg.from });
  sseBroadcast('chat-delete', { messageId: msg.id });
  res.json({ ok: true });
});

app.get('/api/chat/general', requireAuth, (req, res) => {
  const msgs = loadJSON(CHAT_FILE, { messages: [] }).messages.filter(m => m.to === 'general');
  res.json({ messages: msgs.slice(-300) });
});

app.post('/api/chat/send', requireAuth, requireNotMutedGeneral, requireGeneralChatWrite, (req, res) => {
  const me = req.user.username;
  let { text, attachments } = req.body || {};
  text = String(text || '').slice(0, 4000);
  const atts = Array.isArray(attachments) ? attachments.slice(0, 10) : [];
  if (!text.trim() && !atts.length)
    return res.status(400).json({ error: 'Пустое сообщение' });
  const msg = {
    id: crypto.randomUUID(), from: me, to: 'general',
    text: text.trim(), attachments: atts,
    timestamp: new Date().toISOString(),
  };
  const data = loadJSON(CHAT_FILE, { messages: [] });
  data.messages.push(msg);
  if (data.messages.length > 1000) data.messages = data.messages.slice(-1000);
  saveJSON(CHAT_FILE, data);
  sseBroadcast('chat', { message: msg });
  notifyMentions(msg.text, loadUsers().users.map(u => u.username), me, 'chat:general');
  res.json({ ok: true, message: msg });
});

/* ---------- Тикеты ---------- */
app.get('/api/tickets', requireAuth, (req, res) => {
  const me = req.user;
  const all = loadJSON(TICKETS_FILE, { tickets: [] }).tickets;
  const list = me.role === 'admin' ? all : all.filter(t => t.from === me.username);
  const sorted = list.slice().sort((a, b) => {
    const order = { open: 0, in_progress: 1, closed: 2 };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  res.json({ tickets: sorted });
});

app.post('/api/tickets', requireAuth, (req, res) => {
  const me = req.user.username;
  let { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim())
    return res.status(400).json({ error: 'Опишите проблему' });
  text = text.trim().slice(0, 4000);
  const data = loadJSON(TICKETS_FILE, { tickets: [] });
  const existing = data.tickets.find(t => t.from === me && t.status !== 'closed');
  if (existing)
    return res.status(409).json({ error: 'У вас уже есть открытое обращение', ticketId: existing.id });
  const ticket = {
    id: crypto.randomUUID(), from: me, subject: text.slice(0, 60),
    messages: [{ id: crypto.randomUUID(), from: me, role: 'user', text, timestamp: new Date().toISOString() }],
    status: 'open', createdAt: new Date().toISOString(),
  };
  data.tickets.push(ticket);
  saveJSON(TICKETS_FILE, data);
  const admins = loadUsers().users.filter(u => u.role === 'admin').map(u => u.username);
  sseSendTo(admins, 'ticket-new', { ticket });
  notifyMany(admins.filter(a => a !== me), {
    type: 'ticket', title: 'Новое обращение в поддержку',
    body: `${me}: ${text.slice(0, 160)}`, link: 'ticket:' + ticket.id,
  });
  res.json({ ok: true, ticket });
});

app.get('/api/tickets/:id', requireAuth, (req, res) => {
  const me = req.user;
  const data = loadJSON(TICKETS_FILE, { tickets: [] });
  const t = data.tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (me.role !== 'admin' && t.from !== me.username)
    return res.status(403).json({ error: 'forbidden' });
  res.json({ ticket: t });
});

app.post('/api/tickets/:id/messages', requireAuth, (req, res) => {
  const me = req.user;
  const data = loadJSON(TICKETS_FILE, { tickets: [] });
  const t = data.tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (me.role !== 'admin' && t.from !== me.username)
    return res.status(403).json({ error: 'forbidden' });
  if (t.status === 'closed') return res.status(400).json({ error: 'Тикет закрыт' });
  let { text, attachments } = req.body || {};
  text = String(text || '').slice(0, 4000);
  const atts = Array.isArray(attachments) ? attachments.slice(0, 10) : [];
  if (!text.trim() && !atts.length)
    return res.status(400).json({ error: 'Пустое сообщение' });
  const msg = {
    id: crypto.randomUUID(), from: me.username,
    role: me.role === 'admin' ? 'support' : 'user',
    text: text.trim(), attachments: atts,
    timestamp: new Date().toISOString(),
  };
  t.messages.push(msg);
  saveJSON(TICKETS_FILE, data);
  const recipients = new Set([t.from]);
  const admins = loadUsers().users.filter(u => u.role === 'admin').map(u => u.username);
  for (const a of admins) recipients.add(a);
  sseSendTo([...recipients], 'ticket-message', { ticketId: t.id, message: msg });
  if (me.role === 'admin' && t.from !== me.username) {
    notifyUser(t.from, {
      type: 'ticket', title: 'Ответ в обращении',
      body: `${me.username}: ${msg.text.slice(0, 160)}`, link: 'ticket:' + t.id,
    });
  } else if (me.role !== 'admin') {
    notifyMany(admins.filter(a => a !== me.username), {
      type: 'ticket', title: 'Сообщение в обращении',
      body: `${me.username}: ${msg.text.slice(0, 160)}`, link: 'ticket:' + t.id,
    });
  }
  res.json({ ok: true, message: msg });
});

app.post('/api/tickets/:id/accept', requireRole('admin'), (req, res) => {
  const data = loadJSON(TICKETS_FILE, { tickets: [] });
  const t = data.tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.status === 'closed') return res.status(400).json({ error: 'Тикет закрыт' });
  if (t.status === 'in_progress') return res.status(400).json({ error: 'Уже принят' });
  t.status = 'in_progress';
  t.acceptedBy = req.user.username;
  t.acceptedAt = new Date().toISOString();
  const sysMsg = {
    id: crypto.randomUUID(), from: req.user.username, role: 'system',
    text: `Администратор ${req.user.username} принял ваш тикет`,
    timestamp: new Date().toISOString(),
  };
  t.messages.push(sysMsg);
  saveJSON(TICKETS_FILE, data);
  const recipients = new Set([t.from]);
  const admins = loadUsers().users.filter(u => u.role === 'admin').map(u => u.username);
  for (const a of admins) recipients.add(a);
  sseSendTo([...recipients], 'ticket-status', { ticketId: t.id, status: t.status });
  sseSendTo([...recipients], 'ticket-message', { ticketId: t.id, message: sysMsg });
  notifyUser(t.from, {
    type: 'ticket', title: 'Обращение принято',
    body: `Администратор ${req.user.username} взял ваш тикет в работу`,
    link: 'ticket:' + t.id,
  });
  res.json({ ok: true, ticket: t });
});

app.post('/api/tickets/:id/close', requireRole('admin'), (req, res) => {
  const data = loadJSON(TICKETS_FILE, { tickets: [] });
  const t = data.tickets.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (t.status === 'closed') return res.status(400).json({ error: 'Уже закрыт' });
  t.status = 'closed';
  t.closedBy = req.user.username;
  t.closedAt = new Date().toISOString();
  const sysMsg = {
    id: crypto.randomUUID(), from: req.user.username, role: 'system',
    text: `Тикет закрыт администратором ${req.user.username}`,
    timestamp: new Date().toISOString(),
  };
  t.messages.push(sysMsg);
  saveJSON(TICKETS_FILE, data);
  const recipients = new Set([t.from]);
  const admins = loadUsers().users.filter(u => u.role === 'admin').map(u => u.username);
  for (const a of admins) recipients.add(a);
  sseSendTo([...recipients], 'ticket-status', { ticketId: t.id, status: t.status });
  sseSendTo([...recipients], 'ticket-message', { ticketId: t.id, message: sysMsg });
  notifyUser(t.from, {
    type: 'ticket', title: 'Обращение закрыто',
    body: `Тикет закрыт администратором ${req.user.username}`,
    link: 'ticket:' + t.id,
  });
  res.json({ ok: true, ticket: t });
});

/* ---------- Запросы ---------- */
app.get('/api/requests', requireRole('admin'), (req, res) => {
  res.json({ items: loadJSON(REQUESTS_FILE, { items: [] }).items.slice().reverse() });
});

app.post('/api/requests', requireAuth, projectGuard('read', 'body'), (req, res) => {
  const me = req.user.username;
  let { text, file } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim())
    return res.status(400).json({ error: 'Пустой запрос' });
  if (!file || typeof file !== 'string')
    return res.status(400).json({ error: 'Запрос должен быть привязан к файлу' });
  text = text.trim().slice(0, 4000);
  file = file.trim().slice(0, 500);
  let full; try { full = safeJoin(req.projectRoot, file); } catch { return res.status(400).json({ error: 'Файл не найден' }); }
  if (!fs.existsSync(full)) return res.status(400).json({ error: 'Файл не найден' });
  const item = {
    id: crypto.randomUUID(), from: me, file, projectId: req.project.id,
    text, timestamp: new Date().toISOString(), status: 'open',
  };
  const data = loadJSON(REQUESTS_FILE, { items: [] });
  data.items.push(item);
  saveJSON(REQUESTS_FILE, data);
  const admins = loadUsers().users.filter(u => u.role === 'admin').map(u => u.username);
  sseSendTo(admins, 'request', { item });
  const targets = new Set(admins);
  if (req.project.creator && req.project.creator !== me) targets.add(req.project.creator);
  targets.delete(me);
  notifyMany([...targets], {
    type: 'request', title: 'Запрос на изменение файла',
    body: `${me} · ${file}: ${text.slice(0, 140)}`,
    link: 'file:' + req.project.id + ':' + file, projectId: req.project.id,
  });
  res.json({ ok: true, item });
});

app.post('/api/requests/:id/close', requireRole('admin'), (req, res) => {
  const data = loadJSON(REQUESTS_FILE, { items: [] });
  const item = data.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  item.status = 'closed';
  item.closedBy = req.user.username;
  item.closedAt = new Date().toISOString();
  saveJSON(REQUESTS_FILE, data);
  notifyUser(item.from, {
    type: 'request', title: 'Запрос обработан',
    body: `Ваш запрос по файлу ${item.file} закрыт`,
    link: 'file:' + item.projectId + ':' + item.file, projectId: item.projectId,
  });
  res.json({ ok: true });
});

/* ---------- Жалобы ---------- */
app.post('/api/reports', requireAuth, projectGuard('read', 'body'), (req, res) => {
  const me = req.user.username;
  let { reason, file } = req.body || {};
  if (!reason || typeof reason !== 'string' || !reason.trim())
    return res.status(400).json({ error: 'Опишите проблему' });
  reason = reason.trim().slice(0, 4000);
  if (!file || typeof file !== 'string' || !file.trim())
    return res.status(400).json({ error: 'Жалоба должна быть привязана к файлу' });
  const filePath = file.trim().slice(0, 500);
  let full; try { full = safeJoin(req.projectRoot, filePath); } catch { return res.status(400).json({ error: 'Файл не найден' }); }
  if (!fs.existsSync(full)) return res.status(400).json({ error: 'Файл не найден' });
  const item = {
    id: crypto.randomUUID(), from: me, reason, file: filePath,
    projectId: req.project.id,
    timestamp: new Date().toISOString(), status: 'open',
  };
  const data = loadJSON(REPORTS_FILE, { items: [] });
  data.items.push(item);
  saveJSON(REPORTS_FILE, data);
  const admins = loadUsers().users.filter(u => u.role === 'admin').map(u => u.username);
  sseSendTo(admins, 'report', { item });
  notifyMany(admins.filter(a => a !== me), {
    type: 'report', title: 'Новая жалоба',
    body: `${me} · ${filePath}: ${reason.slice(0, 140)}`,
    link: 'file:' + req.project.id + ':' + filePath, projectId: req.project.id,
  });
  res.json({ ok: true });
});

app.get('/api/reports', requireRole('admin'), (req, res) => {
  res.json({ items: loadJSON(REPORTS_FILE, { items: [] }).items.slice().reverse() });
});

app.post('/api/reports/:id/resolve', requireRole('admin'), (req, res) => {
  const data = loadJSON(REPORTS_FILE, { items: [] });
  const item = data.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  item.status = 'resolved';
  item.resolvedBy = req.user.username;
  item.resolvedAt = new Date().toISOString();
  saveJSON(REPORTS_FILE, data);
  notifyUser(item.from, {
    type: 'report', title: 'Жалоба рассмотрена',
    body: `Жалоба на файл ${item.file} рассмотрена администратором`,
    link: 'file:' + item.projectId + ':' + item.file, projectId: item.projectId,
  });
  res.json({ ok: true });
});

/* ---------- Совместное редактирование ---------- */
function editKey(projectId, file) { return projectId + '::' + file; }

function getOrCreateSession(key, project, file) {
  let s = editSessions.get(key);
  if (!s) {
    const root = projectFolder(project);
    const full = safeJoin(root, file);
    if (!fs.existsSync(full)) throw new Error('not found');
    const baseline = fs.readFileSync(full, 'utf8');
    s = { baseline, content: baseline, users: new Map(), saveTimer: null, projectId: project.id, file };
    editSessions.set(key, s);
  }
  return s;
}
function scheduleSessionSave(key) {
  const s = editSessions.get(key);
  if (!s) return;
  if (s.saveTimer) clearTimeout(s.saveTimer);
  s.saveTimer = setTimeout(() => {
    const project = loadProjects().projects.find(p => p.id === s.projectId);
    if (!project) return;
    try {
      const full = safeJoin(projectFolder(project), s.file);
      fs.writeFileSync(full, s.content, 'utf8');
    } catch (e) { logger.error({ err: e.message }, 'schedule save failed'); }
    s.saveTimer = null;
  }, 500);
}

app.post('/api/edit/join', requireAuth, projectGuard('edit', 'body'), (req, res) => {
  const { file } = req.body || {};
  if (!file) return res.status(400).json({ error: 'no file' });
  if (!isTextFile(file)) return res.status(400).json({ error: 'Только текстовые файлы' });
  const full = safeJoin(req.projectRoot, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
  const key = editKey(req.project.id, file);
  const s = getOrCreateSession(key, req.project, file);
  s.users.set(req.user.username, { joinedAt: Date.now() });
  const usersList = [...s.users.keys()];
  sseSendTo(usersList, 'edit-users', { key, projectId: req.project.id, file, users: usersList });
  res.json({ baseline: s.baseline, content: s.content, users: usersList });
});

app.post('/api/edit/change', requireAuth, projectGuard('edit', 'body'), (req, res) => {
  const { file, content } = req.body || {};
  if (!file || typeof content !== 'string')
    return res.status(400).json({ error: 'bad input' });
  if (!isTextFile(file)) return res.status(400).json({ error: 'Только текстовые файлы' });
  if (content.length > cfg.limits.editContentMax) return res.status(413).json({ error: 'too big' });
  const key = editKey(req.project.id, file);
  const s = editSessions.get(key);
  if (!s) return res.status(410).json({ error: 'session ended' });
  s.content = content;
  scheduleSessionSave(key);
  // Только участники этой сессии, а не все SSE-клиенты сервера.
  sseSendTo([...s.users.keys()], 'edit-change',
    { key, projectId: req.project.id, file, content, from: req.user.username });
  res.json({ ok: true });
});

app.post('/api/edit/save', requireAuth, projectGuard('edit', 'body'), (req, res) => {
  const { file, content } = req.body || {};
  if (!file || typeof content !== 'string')
    return res.status(400).json({ error: 'bad input' });
  if (!isTextFile(file)) return res.status(400).json({ error: 'Только текстовые файлы' });
  const key = editKey(req.project.id, file);
  const s = editSessions.get(key);
  if (!s) return res.status(410).json({ error: 'session ended' });
  if (s.saveTimer) { clearTimeout(s.saveTimer); s.saveTimer = null; }
  const before = s.baseline;
  s.content = content;
  s.baseline = content;
  const full = safeJoin(req.projectRoot, file);
  fs.writeFileSync(full, content, 'utf8');
  logChange({ user: req.user.username, action: 'edit', file, before, after: content, projectId: req.project.id });
  try { refreshEmbedIndex(req.project.id, file, full); } catch {}
  s.users.delete(req.user.username);
  const usersList = [...s.users.keys()];
  sseSendTo(usersList, 'edit-users', { key, projectId: req.project.id, file, users: usersList });
  sseSendTo(usersList, 'edit-saved', { key, projectId: req.project.id, file, by: req.user.username });
  if (s.users.size === 0) editSessions.delete(key);
  res.json({ ok: true });
});

app.post('/api/edit/leave', requireAuth, projectGuard('edit', 'body'), (req, res) => {
  const { file, projectId } = req.body || {};
  if (!file || !projectId) return res.status(400).json({ error: 'no file' });
  const key = editKey(projectId, file);
  const s = editSessions.get(key);
  if (!s) return res.json({ ok: true });
  s.users.delete(req.user.username);
  if (s.users.size === 0) {
    // Сохраняем то, что пользователь набрал (а не baseline): иначе закрытие
    // вкладки/обрыв сети молча откатывали уже автосохранённый текст.
    flushEditSession(key, s);
    editSessions.delete(key);
  } else {
    const usersList = [...s.users.keys()];
    sseSendTo(usersList, 'edit-users', { key, projectId, file, users: usersList });
  }
  res.json({ ok: true });
});

/* ---------- Чат проекта + задачи ---------- */
// [NEW] Удаление сообщения в проектном чате
app.delete('/api/chat/project/:projectId/message/:id',
  requireAuth, projectGuard('read', 'params'),
  (req, res) => {
    const { data, chat } = getProjectChat(req.project.id);
    const idx = chat.messages.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const msg = chat.messages[idx];
    const isAdmin = req.user.role === 'admin';
    const isProjectCreator = req.project.creator === req.user.username;
    const isOwner = msg.from === req.user.username;
    if (!isAdmin && !isProjectCreator && !isOwner)
      return res.status(403).json({ error: 'forbidden' });
    chat.messages.splice(idx, 1);
    saveProjectChats(data);
    const recipients = req.project.members.map(m => m.username);
    sseSendTo([...new Set(recipients)], 'chat-project-delete', {
      projectId: req.project.id, messageId: msg.id,
    });
    logChange({
      user: req.user.username, action: 'chat-project-delete',
      projectId: req.project.id, target: msg.from,
      details: 'удалено сообщение',
    });
    res.json({ ok: true });
  });
app.get('/api/chat/project/:projectId', requireAuth, (req, res) => {
  const project = loadProjects().projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (!canReadProject(req.user, project)) return res.status(403).json({ error: 'forbidden' });
  const { chat } = getProjectChat(project.id);
  res.json({
    messages: chat.messages.slice(-300),
    tasks: chat.tasks.slice(-100),
    project: { id: project.id, name: project.name },
  });
});

app.post('/api/chat/project/:projectId/send',
  requireAuth, projectGuard('read', 'params'),
  (req, res) => {
    let { text, attachments } = req.body || {};
    text = String(text || '').slice(0, 4000);
    const atts = Array.isArray(attachments) ? attachments.slice(0, 10) : [];
    if (!text.trim() && !atts.length)
      return res.status(400).json({ error: 'Пустое сообщение' });
    const { data, chat } = getProjectChat(req.project.id);
    const msg = {
      id: crypto.randomUUID(),
      from: req.user.username,
      text: text.trim(),
      attachments: atts,
      timestamp: new Date().toISOString(),
    };
    chat.messages.push(msg);
    if (chat.messages.length > 3000) chat.messages = chat.messages.slice(-3000);
    saveProjectChats(data);
    const recipients = req.project.members.map(m => m.username);
    sseSendTo([...new Set(recipients)], 'chat-project', { projectId: req.project.id, message: msg });
    notifyMentions(msg.text, req.project.members.map(m => m.username), req.user.username,
      'chat:project:' + req.project.id);
    res.json({ ok: true, message: msg });
  });

app.get('/api/projects/:projectId/tasks', requireAuth, projectGuard('read', 'params'), (req, res) => {
  const { chat } = getProjectChat(req.project.id);
  res.json({ tasks: chat.tasks });
});

app.post('/api/projects/:projectId/tasks', requireAuth, projectGuard('read', 'params'), (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Пустая задача' });
  const { data, chat } = getProjectChat(req.project.id);
  const task = {
    id: crypto.randomUUID(), text, done: false,
    createdBy: req.user.username,
    createdAt: new Date().toISOString(),
  };
  chat.tasks.push(task);
  if (chat.tasks.length > 500) chat.tasks = chat.tasks.slice(-500);
  saveProjectChats(data);
  const recipients = req.project.members.map(m => m.username);
  sseSendTo([...new Set(recipients)], 'project-task', { projectId: req.project.id, task, op: 'add' });
  res.json({ ok: true, task });
});

app.patch('/api/projects/:projectId/tasks/:taskId', requireAuth, projectGuard('read', 'params'), (req, res) => {
  const { data, chat } = getProjectChat(req.project.id);
  const task = chat.tasks.find(t => t.id === req.params.taskId);
  if (!task) return res.status(404).json({ error: 'not found' });
  const { done } = req.body || {};
  if (typeof done === 'boolean') {
    task.done = done;
    task.doneBy = done ? req.user.username : null;
    task.doneAt = done ? new Date().toISOString() : null;
  }
  saveProjectChats(data);
  const recipients = req.project.members.map(m => m.username);
  sseSendTo([...new Set(recipients)], 'project-task', { projectId: req.project.id, task, op: 'update' });
  res.json({ ok: true, task });
});

app.delete('/api/projects/:projectId/tasks/:taskId', requireAuth, projectGuard('read', 'params'), (req, res) => {
  const { data, chat } = getProjectChat(req.project.id);
  const idx = chat.tasks.findIndex(t => t.id === req.params.taskId);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const task = chat.tasks[idx];
  const isAdmin = req.user.role === 'admin';
  const isProjectCreator = req.project.creator === req.user.username;
  const isTaskCreator = task.createdBy === req.user.username;
  if (!isAdmin && !isProjectCreator && !isTaskCreator)
    return res.status(403).json({ error: 'forbidden' });
  chat.tasks.splice(idx, 1);
  saveProjectChats(data);
  const recipients = req.project.members.map(m => m.username);
  sseSendTo([...new Set(recipients)], 'project-task', { projectId: req.project.id, taskId: task.id, op: 'delete' });
  res.json({ ok: true });
});

/* ---------- Вложения ---------- */
const ATTACH_BLOCKED_EXT = ['exe','bat','cmd','sh','ps1','vbs','jar','msi','app','dll','scr','com','pif','hta','cpl'];
const attachmentUpload = multer({
  dest: ATTACH_DIR,
  limits: { fileSize: cfg.limits.attachmentMaxBytes },
  fileFilter: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').slice(1).toLowerCase();
    if (ATTACH_BLOCKED_EXT.includes(ext)) return cb(new Error('Запрещённый тип файла'));
    cb(null, true);
  },
});

app.post('/api/chat/attach',
  requireAuth,
  (req, res, next) => attachmentUpload.single('file')(req, res, err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ error: 'Файл больше 25 МБ' });
      return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
    }
    next();
  }),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const id = crypto.randomUUID();
    const origName = decodeUploadFilename(req.file.originalname);
    const safe = safeFileName(origName);
    const mime = req.file.mimetype || 'application/octet-stream';
    const isImg = isImageMime(mime, safe);
    // Контекст вложения: general | project:<id> | ticket:<id>.
    // Нужен, чтобы не отдавать чужие вложения по id (IDOR).
    const rawScope = String(req.body?.scope || '').slice(0, 120);
    const scope = /^(general|project|ticket):?[A-Za-z0-9_-]*$/.test(rawScope) ? rawScope : 'general';
    const att = {
      id,
      storedName: req.file.filename,
      originalName: safe,
      size: req.file.size,
      mime,
      kind: isImg ? 'image' : 'file',
      scope,
      uploadedBy: req.user.username,
      uploadedAt: new Date().toISOString(),
    };
    const data = loadAttachments();
    data.items[id] = att;
    const ids = Object.keys(data.items);
    if (ids.length > 5000) {
      ids.slice(0, ids.length - 5000).forEach(x => {
        const old = data.items[x];
        try { fs.unlinkSync(path.join(ATTACH_DIR, old.storedName)); } catch {}
        delete data.items[x];
      });
    }
    saveAttachments(data);
    telemetryAppend(req.user.username, { type: 'attach-upload', size: att.size, mime });
    try {
      // [SEC] Не запускаем OCR автоматически для аттачментов чата —
      // чтобы не тратить GPU-ресурсы на всё, что заливают пользователи.
      if (isImg && cfg.ocr?.autoOnAttachments) {
        queueImageAnalysis('__attach__', id, path.join(ATTACH_DIR, att.storedName));
      }
    } catch {}
    res.json({
      id, name: att.originalName, size: att.size, kind: att.kind, mime: att.mime,
      url: '/api/chat/attach/' + id,
    });
  });

// [SEC] Харденинг MIME: Content-Type берём из extension, а не из client-controlled mime
const SAFE_INLINE_IMAGE_EXT = new Set(['png','jpg','jpeg','gif','webp','bmp','ico']); // svg — НЕ инлайн
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
};

app.get('/api/chat/attach/:id', requireAuth, (req, res) => {
  const data = loadAttachments();
  const att = data.items[req.params.id];
  if (!att) return res.status(404).end();
  const full = path.join(ATTACH_DIR, att.storedName);
  if (!fs.existsSync(full)) return res.status(404).end();

  // Доступ: владелец, администратор или тот, кто вправе видеть контейнер
  // (общий чат / проект / тикет). Раньше любой авторизованный читал чужой файл по id.
  const isAdmin = req.user.role === 'admin';
  const isOwner = att.uploadedBy === req.user.username;
  let allowed = isAdmin || isOwner;
  if (!allowed && att.scope) {
    if (att.scope === 'general') {
      allowed = true;
    } else if (att.scope.startsWith('project:')) {
      const project = loadProjects().projects.find(p => p.id === att.scope.slice('project:'.length));
      allowed = canReadProject(req.user, project);
    } else if (att.scope.startsWith('ticket:')) {
      const ticket = loadJSON(TICKETS_FILE, { tickets: [] }).tickets
        .find(t => t.id === att.scope.slice('ticket:'.length));
      allowed = !!ticket && (ticket.from === req.user.username || ticket.acceptedBy === req.user.username);
    }
  }
  if (!allowed) {
    telemetryAppend(req.user.username, { type: 'attach-access-denied', attId: att.id });
    return res.status(403).end();
  }

  const ext = (path.extname(att.originalName).slice(1) || '').toLowerCase();
  const inlineOk = SAFE_INLINE_IMAGE_EXT.has(ext);

  // [SEC] Content-Type НЕ берём из att.mime (client-controlled).
  const ctype = inlineOk ? (MIME_BY_EXT[ext] || 'application/octet-stream') : 'application/octet-stream';

  res.setHeader('Content-Type', ctype);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition',
    inlineOk
      ? `inline; filename*=UTF-8''${encodeURIComponent(att.originalName)}`
      : `attachment; filename*=UTF-8''${encodeURIComponent(att.originalName)}`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.sendFile(full);
});

app.post('/api/projects/:projectId/attach-file',
  requireAuth,
  projectGuard('edit', 'params'),
  (req, res) => {
    const { attachmentId, dir = '' } = req.body || {};
    if (!attachmentId) return res.status(400).json({ error: 'attachmentId required' });
    const data = loadAttachments();
    const att = data.items[attachmentId];
    if (!att) return res.status(404).json({ error: 'attachment not found' });
    // Копировать в проект можно только своё вложение, вложение из этого же
    // проекта или (для админа) любое. Иначе это IDOR-кража чужого файла.
    const isAdmin = req.user.role === 'admin';
    const isOwner = att.uploadedBy === req.user.username;
    const sameProject = att.scope === 'project:' + req.project.id;
    if (!isAdmin && !isOwner && !sameProject)
      return res.status(403).json({ error: 'forbidden' });
    const src = path.join(ATTACH_DIR, att.storedName);
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'file missing' });
    let dirFull; try { dirFull = safeJoin(req.projectRoot, dir); } catch {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!fs.existsSync(dirFull)) fs.mkdirSync(dirFull, { recursive: true });
    let name = att.originalName;
    let target = path.join(dirFull, name);
    if (fs.existsSync(target)) {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let i = 1;
      while (fs.existsSync(target)) { target = path.join(dirFull, `${base} (${i})${ext}`); i++; }
    }
    fs.copyFileSync(src, target);
    const rel = path.relative(req.projectRoot, target).split(path.sep).join('/');
    logChange({ user: req.user.username, action: 'upload', file: rel, projectId: req.project.id,
      details: `из чата: ${att.originalName}` });

    // запускаем OCR + эмбеддинг в фоне для картинок/Office
    try { queueImageAnalysis(req.project.id, rel, target); } catch {}
    try { refreshEmbedIndex(req.project.id, rel, target); } catch {}

    res.json({ ok: true, path: rel });
  });

/* ---------- ADS ---------- *//* ---------- ADS ---------- */
const DEFAULT_ADS = {
  slots: {
    'topbar':         { enabled: true, interval: 15, note: 'Под топбаром' },
    'sidebar-top':    { enabled: true, interval: 20, note: 'Верх сайдбара' },
    'sidebar-bottom': { enabled: true, interval: 20, note: 'Низ сайдбара' },
    'chat-top':       { enabled: true, interval: 25, note: 'Над чатом' },
    'filebar':        { enabled: true, interval: 15, note: 'Под файлбаром' },
    'empty-viewer':   { enabled: true, interval: 15, note: 'В пустом просмотрщике' },
  },
  images: [],
};
function loadAds() {
  if (!fs.existsSync(ADS_FILE)) {
    atomicWriteFile(ADS_FILE, JSON.stringify(DEFAULT_ADS, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_ADS));
  }
  try {
    const a = JSON.parse(fs.readFileSync(ADS_FILE, 'utf8'));
    a.slots  = { ...DEFAULT_ADS.slots, ...(a.slots || {}) };
    a.images = Array.isArray(a.images) ? a.images : [];
    return a;
  } catch { return JSON.parse(JSON.stringify(DEFAULT_ADS)); }
}
function saveAds(a) { atomicWriteFile(ADS_FILE, JSON.stringify(a, null, 2)); }

function adsDistribute() {
  const a = loadAds();
  const enabled = Object.entries(a.slots).filter(([,s]) => s.enabled).map(([k]) => k);
  const imgIds = a.images.map(i => i.id);
  const map = {};
  for (const k of enabled) map[k] = [];
  if (enabled.length && imgIds.length) {
    imgIds.forEach((id, i) => map[enabled[i % enabled.length]].push(id));
  }
  return { slots: a.slots, images: a.images, distribution: map };
}

app.get('/api/ads/serve', requireAuth, (req, res) => {
  res.json(adsDistribute());
});

const adsUpload = multer({ dest: ADS_DIR, limits: { fileSize: 5 * 1024 * 1024 } });
app.post('/api/ads/upload', requireSelfAdmin,
  (req, res, next) => adsUpload.single('file')(req, res, err => err ? res.status(400).json({error:err.message}) : next()),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const ext = (path.extname(req.file.originalname) || '.png').toLowerCase();
    if (!['.png','.jpg','.jpeg','.gif','.webp','.svg'].includes(ext))
      return res.status(400).json({ error: 'Только изображения' });
    const newName = req.file.filename + ext;
    fs.renameSync(req.file.path, path.join(ADS_DIR, newName));
    const a = loadAds();
    const entry = {
      id: crypto.randomUUID(),
      filename: newName,
      originalName: safeFileName(req.file.originalname),
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
    };
    a.images.push(entry);
    // [FIX] Лимит снят. Отдельная защита от гигантского мусора — 5000 файлов.
    if (a.images.length > 5000) {
      const removed = a.images.splice(0, a.images.length - 5000);
      for (const r of removed) try { fs.unlinkSync(path.join(ADS_DIR, r.filename)); } catch {}
    }
    saveAds(a);
    res.json({ ok: true, image: entry });
  });

app.delete('/api/ads/images/:id', requireSelfAdmin, (req, res) => {
  const a = loadAds();
  const idx = a.images.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const [rm] = a.images.splice(idx, 1);
  try { fs.unlinkSync(path.join(ADS_DIR, rm.filename)); } catch {}
  saveAds(a);
  res.json({ ok: true });
});

app.patch('/api/ads/slots', requireSelfAdmin, (req, res) => {
  const a = loadAds();
  const { slots } = req.body || {};
  if (!slots || typeof slots !== 'object') return res.status(400).json({ error: 'bad' });
  for (const [k, v] of Object.entries(slots)) {
    if (!a.slots[k]) continue;
    if (typeof v.enabled === 'boolean') a.slots[k].enabled = v.enabled;
    if (Number.isFinite(+v.interval) && +v.interval >= 3) a.slots[k].interval = +v.interval;
  }
  saveAds(a);
  res.json({ ok: true, slots: a.slots });
});

app.get('/api/ads/file/:filename', requireAuth, (req, res) => {
  const safe = path.basename(req.params.filename);
  const full = path.join(ADS_DIR, safe);
  if (!fs.existsSync(full)) return res.status(404).end();
  const ext = path.extname(safe).slice(1).toLowerCase();
  if (ext === 'svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  res.sendFile(full);
});

app.get('/api/ads/admin/list', requireSelfAdmin, (req, res) => {
  res.json(adsDistribute());
});

/* ---------- Подписки ---------- */
const DEFAULT_SUBS = { active: [], codes: [] };
function loadSubs() {
  if (!fs.existsSync(SUBSCRIPTIONS_FILE)) {
    atomicWriteFile(SUBSCRIPTIONS_FILE, JSON.stringify(DEFAULT_SUBS, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_SUBS));
  }
  try {
    const s = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8'));
    s.active = Array.isArray(s.active) ? s.active : [];
    s.codes  = Array.isArray(s.codes)  ? s.codes  : [];
    return s;
  } catch { return JSON.parse(JSON.stringify(DEFAULT_SUBS)); }
}
function saveSubs(s) { atomicWriteFile(SUBSCRIPTIONS_FILE, JSON.stringify(s, null, 2)); }

function isSubscribed(username) {
  if (!username) return false;
  const s = loadSubs();
  const rec = s.active.find(a => a.username === username);
  if (!rec) return false;
  if (rec.until && new Date(rec.until).getTime() < Date.now()) return false;
  return true;
}
function getSubscription(username) {
  const s = loadSubs();
  const rec = s.active.find(a => a.username === username);
  if (!rec) return null;
  if (rec.until && new Date(rec.until).getTime() < Date.now()) return null;
  return rec;
}

const requireSubscription = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  // Администраторы сервиса имеют доступ к Darcus без отдельной подписки.
  if (req.user.role === 'admin') return next();
  if (!isSubscribed(req.user.username))
    return res.status(403).json({ error: 'subscription-required' });
  next();
};

app.get('/api/me/subscription', requireAuth, (req, res) => {
  const rec = getSubscription(req.user.username);
  res.json({
    active: !!rec,
    until: rec?.until || null,
    grantedBy: rec?.grantedBy || null,
    forceAdmin: req.user.username === 'admin',
  });
});

app.post('/api/me/subscription/activate', requireAuth, (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'Введите код' });
  const s = loadSubs();
  const c = s.codes.find(x => x.code === code);
  if (!c) return res.status(404).json({ error: 'Неверный код' });
  if (c.usedBy) return res.status(409).json({ error: 'Код уже использован' });
  const days = Math.max(1, parseInt(c.days, 10) || 30);
  const until = new Date(Date.now() + days * 86400000).toISOString();
  const existing = s.active.find(a => a.username === req.user.username);
  if (existing) {
    existing.until = until;
    existing.grantedBy = 'code:' + code;
    existing.grantedAt = new Date().toISOString();
  } else {
    s.active.push({
      username: req.user.username,
      until,
      grantedBy: 'code:' + code,
      grantedAt: new Date().toISOString(),
    });
  }
  c.usedBy = req.user.username;
  c.usedAt = new Date().toISOString();
  saveSubs(s);
  logChange({ user: req.user.username, action: 'subscription-activate', details: `code=${code}, days=${days}` });
  res.json({ ok: true, until });
});

app.get('/api/subscriptions', requireSelfAdmin, (req, res) => {
  const s = loadSubs();
  const now = Date.now();
  const active = s.active.filter(a => !a.until || new Date(a.until).getTime() > now);
  res.json({ active, codes: s.codes });
});

app.post('/api/subscriptions', requireSelfAdmin, (req, res) => {
  const { username, days, note } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  if (!loadUsers().users.some(u => u.username === username))
    return res.status(404).json({ error: 'Пользователь не найден' });
  const d = Math.max(1, parseInt(days, 10) || 30);
  const until = new Date(Date.now() + d * 86400000).toISOString();
  const s = loadSubs();
  const ex = s.active.find(a => a.username === username);
  if (ex) { ex.until = until; ex.grantedBy = req.user.username; ex.grantedAt = new Date().toISOString(); ex.note = note || ''; }
  else s.active.push({ username, until, grantedBy: req.user.username, grantedAt: new Date().toISOString(), note: note || '' });
  saveSubs(s);
  logChange({ user: req.user.username, action: 'subscription-grant', target: username, details: `days=${d}` });
  res.json({ ok: true });
});

app.delete('/api/subscriptions/:username', requireSelfAdmin, (req, res) => {
  const s = loadSubs();
  const idx = s.active.findIndex(a => a.username === req.params.username);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  s.active.splice(idx, 1);
  saveSubs(s);
  logChange({ user: req.user.username, action: 'subscription-revoke', target: req.params.username });
  res.json({ ok: true });
});

app.post('/api/subscriptions/codes/generate', requireSelfAdmin, (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 50);
  const days  = Math.max(1, parseInt(req.body?.days, 10) || 30);
  const note  = String(req.body?.note || '').trim().slice(0, 200);
  const s = loadSubs();
  const created = [];
  for (let i = 0; i < count; i++) {
    let code, tries = 0;
    do { code = 'DAI-' + generateInviteCode(10); tries++; }
    while (s.codes.some(c => c.code === code) && tries < 20);
    const entry = { code, days, note, createdBy: req.user.username, createdAt: new Date().toISOString(), usedBy: null, usedAt: null };
    s.codes.push(entry); created.push(entry);
  }
  saveSubs(s);
  logChange({ user: req.user.username, action: 'subscription-codes', details: `count=${count}, days=${days}` });
  res.json({ ok: true, created });
});

app.delete('/api/subscriptions/codes/:code', requireSelfAdmin, (req, res) => {
  const s = loadSubs();
  const idx = s.codes.findIndex(c => c.code === req.params.code);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  s.codes.splice(idx, 1);
  saveSubs(s);
  res.json({ ok: true });
});

/* ---------- Darcus: config ---------- */
// Публичная (для авторизованных) часть конфига — только названия стилей ответа.
app.get('/api/darcus/styles', requireAuth, (req, res) => {
  const cfgAi = darcus.loadAiConfig();
  const presets = cfgAi.stylePresets || {};
  res.json({
    presets: Object.fromEntries(Object.entries(presets).map(([k, v]) => [k, { label: (v && v.label) || k }])),
  });
});

app.get('/api/darcus/config', requireSelfAdmin, (req, res) => {
  res.json(darcus.loadAiConfig());
});

// [SEC] PATCH — валидируем URL перед сохранением
app.patch('/api/darcus/config', requireSelfAdmin, (req, res) => {
  const cfgAi = darcus.loadAiConfig();
  const b = req.body || {};
  if (b.ollama && typeof b.ollama === 'object') {
    if (b.ollama.url) {
      try { validateOllamaUrl(String(b.ollama.url)); }
      catch (e) { return res.status(400).json({ error: 'URL: ' + e.message }); }
    }
    cfgAi.ollama = { ...cfgAi.ollama, ...b.ollama };
  }
  if (b.prompts && typeof b.prompts === 'object')
    cfgAi.prompts = { ...cfgAi.prompts, ...b.prompts };
  if (b.search && typeof b.search === 'object')
    cfgAi.search = { ...cfgAi.search, ...b.search };
  if (b.ocr && typeof b.ocr === 'object')
    cfgAi.ocr = { ...cfgAi.ocr, ...b.ocr };
  darcus.saveAiConfig(cfgAi);
  logChange({ user: req.user.username, action: 'darcus-config-update' });
  res.json({ ok: true, config: cfgAi });
});

// [SEC] test — URL НЕ принимается из body, только из конфига (после валидации)
app.post('/api/darcus/test', requireSelfAdmin, rateLimitDarcus, async (req, res) => {
  const cfgAi = darcus.loadAiConfig();
  try { validateOllamaUrl(cfgAi.ollama.url); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  const r = await darcus.ollamaPing();
  res.json(r);
});

/* =========================================================
   [NEW] Ручной запуск полной переиндексации эмбеддингов.
   ========================================================= */
app.post('/api/darcus/reindex', requireSelfAdmin, rateLimitDarcus, async (req, res) => {
  try {
    const projects = getAccessibleProjects(req.user);
    const result = await darcus.indexProjects(projects);
    logChange({ user: req.user.username, action: 'darcus-reindex',
      details: `indexed=${result.indexed} skipped=${result.skipped} errors=${result.errors}` });
    res.json(result);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// [SEC] models — валидируем URL перед HTTP-запросом
app.get('/api/darcus/models', requireSelfAdmin, rateLimitDarcus, async (req, res) => {
  const cfgAi = darcus.loadAiConfig();
  try { validateOllamaUrl(cfgAi.ollama.url); }
  catch (e) { return res.json({ ok: false, error: e.message }); }
  try {
    const raw = await new Promise((resolve, reject) => {
      const u = new URL(cfgAi.ollama.url.replace(/\/$/, '') + '/api/tags');
      const lib = u.protocol === 'https:' ? require('https') : require('http');
      const port = u.port || (u.protocol === 'https:' ? 443 : 80);
      const req2 = lib.get({ hostname: u.hostname, port, path: u.pathname, timeout: 4000 }, r => {
        let b = ''; r.on('data', d => b += d); r.on('end', () => resolve(b));
      });
      req2.on('error', reject); req2.on('timeout', () => req2.destroy(new Error('timeout')));
    });
    const j = JSON.parse(raw);
    res.json({ ok: true, models: (j.models || []).map(m => ({ name: m.name, size: m.size })) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------- Darcus: рабочие ручки ---------- */
function getAccessibleProjects(user) {
  const all = loadProjects().projects;
  const visible = user.role === 'admin' ? all : all.filter(p => p.members.some(m => m.username === user.username));
  return visible.map(p => ({ id: p.id, name: p.name, root: projectFolder(p), project: p }));
}

app.post('/api/darcus/chat', requireAuth, requireSubscription, rateLimitDarcus, async (req, res) => {
  const { query, history, projectId, chatId, attachments, editingFile, stylePreset } = req.body || {};

  // [SEC] Валидация входа
  const q = (typeof query === 'string' ? query : '').trim();
  if (q.length > cfg.limits.darcusQueryMax)
    return res.status(413).json({ error: 'Слишком длинный запрос' });

  const safeHistory = Array.isArray(history)
    ? history.slice(-cfg.limits.darcusHistoryMax)
        .filter(m => m && typeof m.content === 'string')
        .map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content.slice(0, cfg.limits.darcusHistoryItemMax),
        }))
    : [];

  let safeAtts;
  try {
    safeAtts = Array.isArray(attachments)
      ? attachments.slice(0, cfg.limits.darcusAttachmentsMax).map(a => {
          const data = typeof a.data === 'string' ? a.data : '';
          if (data.length > cfg.limits.darcusAttachmentBytesMax * 1.4)
            throw new Error('Вложение слишком большое');
          return {
            name: String(a.name || 'file').slice(0, 200),
            kind: a.kind === 'image' ? 'image' : 'file',
            mime: String(a.mime || '').slice(0, 100),
            size: parseInt(a.size, 10) || 0,
            data,
          };
        })
      : [];
  } catch (e) { return res.status(413).json({ error: e.message }); }

  const hasAtts = safeAtts.length > 0;
  if (!q && !hasAtts)
    return res.status(400).json({ error: 'Пустой запрос' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`retry: 3000\n\n`);

  const projects = getAccessibleProjects(req.user);

  // Если клиент закрыл вкладку/оборвал соединение — останавливаем генерацию,
  // чтобы Ollama не держала GPU и сокет бесконечно.
  let ollamaReq = null;
  let clientGone = false;
  const onClientClose = () => {
    clientGone = true;
    if (ollamaReq) { try { ollamaReq.destroy(new Error('client disconnected')); } catch {} }
  };
  req.on('close', onClientClose);

  try {
  const result = await darcus.darcusAsk({
    user: req.user,
    projects,
    projectId: projectId || null,
    history: safeHistory,
    query: q,
    attachments: safeAtts,
    editingFile: typeof editingFile === 'string' ? editingFile.slice(0, 500) : '', // [NEW]
    stylePreset: typeof stylePreset === 'string' ? stylePreset.slice(0, 40) : 'default',
    onChunk: (piece) => {
      if (clientGone) return;
      try { res.write(`event: chunk\ndata: ${JSON.stringify({ text: piece })}\n\n`); } catch {}
    },
    onRequest: (r) => { ollamaReq = r; if (clientGone) { try { r.destroy(); } catch {} } },
  });

    if (chatId) {
      const d = loadDarcusChats();
      if (!d.chats[req.user.username]) d.chats[req.user.username] = [];
      const list = d.chats[req.user.username];
      const chat = list.find(c => c.id === chatId);
      if (chat) {
        const userMsg = {
          id: crypto.randomUUID(), role: 'user', content: q,
          timestamp: new Date().toISOString(),
          attachments: safeAtts.map(a => ({ name: a.name, kind: a.kind, mime: a.mime, size: a.size })),
        };
        const aiMsg = {
          id: crypto.randomUUID(), role: 'assistant', content: result.answer,
          timestamp: new Date().toISOString(),
          sources: result.sources, web: result.web, wiki: result.wiki,
        };
        chat.messages.push(userMsg, aiMsg);
        if (chat.messages.length > 200) chat.messages = chat.messages.slice(-200);
        if (chat.title === 'Новый чат' && chat.messages.length) {
          chat.title = q.slice(0, 60) || '📎 Вложение';
        }
        chat.updatedAt = new Date().toISOString();
        saveDarcusChats(d);
      }
    }

    res.write(`event: done\ndata: ${JSON.stringify({ sources: result.sources, web: result.web, wiki: result.wiki })}\n\n`);
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
});

app.post('/api/darcus/rewrite', requireAuth, requireSubscription, rateLimitDarcus, async (req, res) => {
  const { mode, text, file, projectId } = req.body || {};
  if (!['rephrase', 'shorten', 'fix', 'translate'].includes(mode))
    return res.status(400).json({ error: 'bad mode' });
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'empty' });
  if (text.length > cfg.limits.darcusQueryMax) return res.status(413).json({ error: 'too long' });

  const cfgAi = darcus.loadAiConfig();
  const project = loadProjects().projects.find(p => p.id === projectId);
  const lang = String(req.body?.lang || 'en').slice(0, 20);
  const subs = darcus.buildSubs({
    username: req.user.username, role: req.user.role,
    project: project?.name || '', file: file || '', mode, lang,
  });
  const prompt = darcus.applySubs(cfgAi.prompts[mode], { ...subs, text });
  try {
    const out = await darcus.ollamaChat([
      { role: 'system', content: darcus.applySubs(cfgAi.prompts.system, subs) },
      { role: 'user',   content: prompt },
    ], {});
    res.json({ ok: true, text: out.trim() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Суммаризация документа ---------- */
const summaryCache = new Map();
app.post('/api/darcus/summarize', requireAuth, requireSubscription, rateLimitDarcus, async (req, res) => {
  const { projectId, path: rel } = req.body || {};
  if (!projectId || !rel) return res.status(400).json({ error: 'projectId и path обязательны' });
  const project = loadProjects().projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (!canReadProject(req.user, project)) return res.status(403).json({ error: 'forbidden' });

  let full;
  try { full = safeJoin(projectFolder(project), String(rel)); }
  catch { return res.status(400).json({ error: 'bad path' }); }
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });

  const hash = darcus.getFileSha1(full);
  if (hash && summaryCache.has(hash)) {
    const c = summaryCache.get(hash);
    if (Date.now() - c.ts < 24 * 3600 * 1000)
      return res.json({ ok: true, item: c.item, cached: true });
  }

  try {
    const ext = (String(rel).split('.').pop() || '').toLowerCase();
    let text = '';
    if (extractor.isImgExt(ext)) {
      const ocr = darcus.loadOcrCache();
      const it = hash && ocr.items && ocr.items[hash];
      text = it ? [it.description, it.text].filter(Boolean).join('\n') : '';
    } else if (extractor.isExtractable(ext)) {
      const st = fs.statSync(full);
      if (st.size > 20 * 1024 * 1024) return res.status(413).json({ error: 'файл слишком большой' });
      text = await extractor.extractText(full, ext);
    } else {
      return res.status(400).json({ error: 'формат не поддерживается' });
    }
    if (!text.trim()) return res.status(400).json({ error: 'нет текстового содержимого' });

    const item = await darcus.summarizeContent(text);
    item.analyzedAt = new Date().toISOString();
    if (hash) summaryCache.set(hash, { item, ts: Date.now() });
    logChange({ user: req.user.username, action: 'darcus-summarize', file: rel, projectId });
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- TTS прокси ---------- */
app.post('/api/darcus/tts', requireAuth, requireSubscription, rateLimitDarcus, async (req, res) => {
  const { text, voice, format } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'empty' });
  if (text.length > 5000) return res.status(413).json({ error: 'слишком длинный текст' });
  try {
    const { buffer, contentType } = await darcus.ttsSynthesize(text, { voice, format });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Whisper STT ---------- */
const rateLimitTranscribe = makeRateLimiter(60 * 1000, 10, 'Слишком много запросов распознавания');
app.post(
  '/api/darcus/transcribe',
  requireAuth, requireSubscription, rateLimitTranscribe,
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '10mb' }),
  async (req, res) => {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'no audio' });
    try {
      const out = await darcus.transcribeAudio(req.body, { language: 'ru' });
      res.json({ ok: true, text: out.text });
    } catch (e) { res.status(500).json({ error: e.message }); }
  }
);

app.post('/api/darcus/generate-doc', requireAuth, requireSubscription, rateLimitDarcus, async (req, res) => {
  const { prompt: userPrompt, template, projectId, dir = '', name } = req.body || {};
  if (!userPrompt || typeof userPrompt !== 'string') return res.status(400).json({ error: 'empty' });
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });

  const project = loadProjects().projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (!canEditProject(req.user, project)) return res.status(403).json({ error: 'forbidden' });

  const cfgAi = darcus.loadAiConfig();
  const projects = getAccessibleProjects(req.user);
  const rag = await darcus.ragSearch(projects, userPrompt, { maxChunks: 6 });
  const context = rag.map(r => `[${r.projectName}/${r.path}]\n${r.content.slice(0, 600)}`).join('\n\n---\n\n');

  const templateText = template && cfgAi.prompts['template_' + template] ? cfgAi.prompts['template_' + template] : '—';
  const subs = darcus.buildSubs({
    username: req.user.username, role: req.user.role,
    project: project.name, mode: 'generate_doc',
  });
  const sysPrompt = darcus.applySubs(cfgAi.prompts.system, subs);
  const prompt = darcus.applySubs(cfgAi.prompts.generate_doc, {
    ...subs, prompt: userPrompt, template: templateText, context,
  });
  try {
    const md = await darcus.ollamaChat([
      { role: 'system', content: sysPrompt },
      { role: 'user',   content: prompt },
    ], { temperature: 0.8 });
    let fileName = String(name).trim();
    if (!fileName.toLowerCase().endsWith('.md')) fileName += '.md';
    fileName = fileName.replace(/[<>:"|?*\x00-\x1f\/\\]/g, '_').slice(0, 100);
    const dirFull = safeJoin(projectFolder(project), dir);
    if (!fs.existsSync(dirFull)) fs.mkdirSync(dirFull, { recursive: true });
    let target = path.join(dirFull, fileName);
    if (fs.existsSync(target)) {
      const base = path.basename(fileName, '.md');
      let i = 1;
      while (fs.existsSync(target)) { target = path.join(dirFull, `${base} (${i}).md`); i++; }
    }
    fs.writeFileSync(target, md, 'utf8');
    const rel = path.relative(projectFolder(project), target).split(path.sep).join('/');
    logChange({ user: req.user.username, action: 'create', file: rel, projectId: project.id, details: 'Darcus auto-generated' });
    res.json({ ok: true, path: rel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- OCR ---------- */
app.get('/api/darcus/image-info', requireAuth, projectGuard('read', 'query'), (req, res) => {
  const rel = String(req.query.path || '');
  let full;
  try { full = safeJoin(req.projectRoot, rel); }
  catch { return res.json({ item: null }); }
  if (!fs.existsSync(full)) return res.json({ item: null });
  // [FIX] ключ кеша — SHA-1 содержимого, чтобы move/rename не сбрасывали OCR
  const hash = darcus.getFileSha1(full);
  if (!hash) return res.json({ item: null });
  const cache = darcus.loadOcrCache();
  const item = cache.items[hash] || null;
  res.json({ item });
});

app.post('/api/darcus/image-analyze', requireAuth, requireSubscription, rateLimitDarcus, projectGuard('read', 'body'), async (req, res) => {
  const rel = String(req.body?.path || '');
  let abs;
  try { abs = safeJoin(req.projectRoot, rel); }
  catch { return res.status(400).json({ error: 'bad path' }); }
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });
  const ext = rel.split('.').pop().toLowerCase();
  if (!['png','jpg','jpeg','gif','webp','bmp'].includes(ext))
    return res.status(400).json({ error: 'not image' });
  try {
    const [ocr, vision] = await Promise.all([darcus.ocrImage(abs), darcus.describeImage(abs)]);
    const err = vision.error || ocr.error || null;
    const item = {
      text: vision.text || ocr.text || '',
      description: vision.description || '',
      boxes: vision.boxes || [],
      analyzedAt: new Date().toISOString(),
    };
    if (err) return res.status(502).json({ error: 'Модель не смогла проанализировать изображение: ' + err });
    const hash = darcus.getFileSha1(abs);
    if (hash) {
      const cache = darcus.loadOcrCache();
      cache.items[hash] = item;    // ← [FIX] ключ = sha1, только успешный результат
      darcus.saveOcrCache(cache);
    }
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// [SEC] OCR — только для файлов проектов, НЕ для аттачментов чата,
// и только если autoOnUpload=true в конфиге.
function queueImageAnalysis(projectId, rel, abs) {
  const cfgAi = darcus.loadAiConfig();
  if (!cfgAi.ocr.autoOnUpload) return;
  // __attach__ — сырые аттачменты чата (лежат вне проекта). Не тратим GPU.
  // Но: при копировании в проект attach-file теперь вызывает с реальным projectId.
  if (projectId === '__attach__') return;

  const ext = (rel.split('.').pop() || '').toLowerCase();
  if (!['png','jpg','jpeg','gif','webp','bmp'].includes(ext)) return;

  const hash = darcus.getFileSha1(abs);
  if (!hash) return;
  const cache = darcus.loadOcrCache();
  if (cache.items[hash]) return;

  (async () => {
    try {
      const [ocr, vision] = await Promise.all([darcus.ocrImage(abs), darcus.describeImage(abs)]);
      const item = {
        text: vision.text || ocr.text || '',
        description: vision.description || '',
        boxes: vision.boxes || [],
        analyzedAt: new Date().toISOString(),
        error: vision.error || ocr.error || null,
      };
      const c2 = darcus.loadOcrCache();
      // Ошибку не кэшируем: иначе файл больше никогда не переанализируется
      // (старый код проверял только наличие записи по хэшу).
      if (!item.error) {
        c2.items[hash] = item;
        darcus.saveOcrCache(c2);
        logger.info({ rel, textLen: item.text.length, descLen: item.description.length }, 'OCR ok');
      } else {
        logger.warn({ rel, err: item.error }, 'OCR failed (не кэшируем)');
      }

      // ← NEW: после успешного OCR — построить эмбеддинг из описания+текста
      if (!item.error && projectId && projectId !== '__attach__') {
        try { refreshEmbedIndex(projectId, rel, abs); } catch {}
      }
    } catch (e) { logger.error({ err: e.message }, 'bg OCR failed'); }
  })();
}

/* =========================================================
   [NEW] Индексация эмбеддингов для одного файла (в фоне).
   Не блокирует HTTP-ответ, не влияет на скорость save/upload.
   ========================================================= */
function refreshEmbedIndex(projectId, rel, absPath) {
  try { darcus.invalidateFileCache(projectId, rel); } catch {}
  if (!absPath || !fs.existsSync(absPath)) return;
  setImmediate(() => {
    darcus.indexFile(projectId, absPath, rel).catch(e =>
      logger.warn({ err: e.message, projectId, rel }, 'embed index (file) failed'));
  });
}

/* =========================================================
   [FIX] Одноразовая миграция OCR-кеша: старые ключи «projectId::rel»
   → новые «sha1» (устойчивые к перемещению/переименованию).
   ========================================================= */
function migrateOcrCacheIfNeeded() {
  try {
    const cache = darcus.loadOcrCache();
    if (!cache.items || typeof cache.items !== 'object') return;
    const projects = loadProjects().projects;
    const folderByPid = new Map(projects.map(p => [p.id, p.folder]));
    let migrated = 0, dropped = 0;
    for (const key of Object.keys(cache.items)) {
      if (key.indexOf('::') === -1) continue;   // уже sha1
      const idx = key.indexOf('::');
      const pid = key.slice(0, idx);
      const rel = key.slice(idx + 2);
      const folder = folderByPid.get(pid);
      if (!folder) { delete cache.items[key]; dropped++; continue; }
      const abs = path.join(PROJECTS_ROOT, folder, rel);
      // Пропускаем слишком большие файлы, чтобы не тормозить старт
      try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > 20 * 1024 * 1024) {
          delete cache.items[key]; dropped++; continue;
        }
      } catch { delete cache.items[key]; dropped++; continue; }
      const hash = darcus.getFileSha1(abs);
      if (!hash) { delete cache.items[key]; dropped++; continue; }
      cache.items[hash] = cache.items[key];
      delete cache.items[key];
      migrated++;
    }
    if (migrated || dropped) {
      darcus.saveOcrCache(cache);
      logger.info({ migrated, dropped }, 'OCR cache migrated to content-hash keys');
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'OCR cache migration failed');
  }
}

/* ---------- Darcus: чаты ---------- */
function loadDarcusChats() {
  try { return JSON.parse(fs.readFileSync(DARCUS_CHATS_FILE, 'utf8')); }
  catch { return { chats: {} }; }
}
function saveDarcusChats(d) {
  try { atomicWriteFile(DARCUS_CHATS_FILE, JSON.stringify(d, null, 2)); } catch {}
}
function getUserChats(username) {
  const d = loadDarcusChats();
  if (!d.chats[username]) d.chats[username] = [];
  return d.chats[username];
}

app.get('/api/darcus/chats', requireAuth, (req, res) => {
  const list = getUserChats(req.user.username).map(c => ({
    id: c.id, title: c.title,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
    messagesCount: (c.messages || []).length,
  })).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ chats: list });
});

app.post('/api/darcus/chats', requireAuth, (req, res) => {
  const d = loadDarcusChats();
  if (!d.chats[req.user.username]) d.chats[req.user.username] = [];
  if (d.chats[req.user.username].length >= 50)
    return res.status(400).json({ error: 'Максимум 50 чатов' });
  const chat = {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  d.chats[req.user.username].push(chat);
  saveDarcusChats(d);
  res.json({ chat });
});

app.get('/api/darcus/chats/:id', requireAuth, (req, res) => {
  const list = getUserChats(req.user.username);
  const chat = list.find(c => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  res.json({ chat });
});

app.delete('/api/darcus/chats/:id', requireAuth, (req, res) => {
  const d = loadDarcusChats();
  const list = d.chats[req.user.username] || [];
  const idx = list.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  list.splice(idx, 1);
  saveDarcusChats(d);
  res.json({ ok: true });
});

app.patch('/api/darcus/chats/:id', requireAuth, (req, res) => {
  const d = loadDarcusChats();
  const list = d.chats[req.user.username] || [];
  const chat = list.find(c => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const title = String(req.body?.title || '').trim().slice(0, 100);
  if (title) chat.title = title;
  chat.updatedAt = new Date().toISOString();
  saveDarcusChats(d);
  res.json({ ok: true, chat });
});

/* =========================================================
   [NEW] Мета проекта: теги и избранное
   ========================================================= */

app.get('/api/projects/:projectId/meta',
  requireAuth, projectGuard('read', 'params'),
  (req, res) => {
    const data = loadProjectMeta();
    const meta = data.projects[req.project.id] || { tags: {}, favorites: {} };
    res.json({
      tags: meta.tags || {},
      favorites: meta.favorites || {},
    });
  });

app.post('/api/projects/:projectId/favorite',
  requireAuth, projectGuard('read', 'params'),
  (req, res) => {
    const rel = String(req.body?.path || '');
    if (!rel) return res.status(400).json({ error: 'path required' });

    // Проверяем, что файл вообще существует
    let full;
    try { full = safeJoin(req.projectRoot, rel); }
    catch { return res.status(400).json({ error: 'bad path' }); }
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });

    const data = loadProjectMeta();
    if (!data.projects[req.project.id])
      data.projects[req.project.id] = { tags: {}, favorites: {} };
    const meta = data.projects[req.project.id];
    meta.favorites = meta.favorites || {};

    if (meta.favorites[rel]) delete meta.favorites[rel];
    else meta.favorites[rel] = true;

    saveProjectMeta(data);
    res.json({ ok: true, favorite: !!meta.favorites[rel] });
  });

app.post('/api/projects/:projectId/tags',
  requireAuth, projectGuard('read', 'params'),
  (req, res) => {
    const rel = String(req.body?.path || '');
    if (!rel) return res.status(400).json({ error: 'path required' });

    const rawTags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const tags = rawTags
      .map(t => String(t || '').trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 8);

    let full;
    try { full = safeJoin(req.projectRoot, rel); }
    catch { return res.status(400).json({ error: 'bad path' }); }
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });

    const data = loadProjectMeta();
    if (!data.projects[req.project.id])
      data.projects[req.project.id] = { tags: {}, favorites: {} };
    const meta = data.projects[req.project.id];
    meta.tags = meta.tags || {};

    if (tags.length) meta.tags[rel] = tags;
    else delete meta.tags[rel];

    saveProjectMeta(data);
    res.json({ ok: true, tags });
  });

/* ---------- Global error handler ---------- */
app.use((err, req, res, next) => {
  try { logger.error({ err: err.message, stack: err.stack, url: req.originalUrl }, 'unhandled error'); } catch {}
  if (res.headersSent) return next(err);
  // body-parser и multer кладут корректный HTTP-статус в err.status/statusCode.
  const status = Number.isInteger(err.status) ? err.status
    : Number.isInteger(err.statusCode) ? err.statusCode
    : 500;
  const isJsonApi = req.path.startsWith('/api/');
  if (isJsonApi) {
    return res.status(status).json({
      error: status === 413 ? 'Слишком большой запрос'
        : status === 400 ? 'Некорректный запрос'
        : 'internal error',
      code: err.code || undefined,
    });
  }
  res.status(status).send(status === 413 ? 'Payload Too Large' : status === 400 ? 'Bad Request' : 'Internal Server Error');
});

process.on('unhandledRejection', (reason) => {
  try { logger.error({ err: String((reason && reason.stack) || reason) }, 'unhandledRejection'); } catch {}
});
process.on('uncaughtException', (err) => {
  try { logger.error({ err: err.message, stack: err.stack }, 'uncaughtException'); } catch {}
  // Процесс в неопределённом состоянии: лучше упасть и перезапуститься, чем
  // продолжать обслуживать запросы с повреждённым состоянием.
  try { flushTelemetry(); } catch {}
  process.exit(1);
});

/* ---------- Старт ---------- */
function startServer() {
  return app.listen(PORT, cfg.bindHost, () => {
    loadUsers();
    loadProjects();
    migrateOcrCacheIfNeeded();

    // Мягкий прогрев индекса эмбеддингов.
    setTimeout(() => {
      try {
        const all = loadProjects().projects.map(p => ({
          id: p.id, name: p.name, root: projectFolder(p), project: p,
        }));
        darcus.indexProjects(all, { maxChunksPerRun: 200 })
          .then(r => r.ok
            ? logger.info(r, 'embed: startup index pass done')
            : logger.warn(r, 'embed: startup index skipped'))
          .catch(e => logger.warn({ err: e.message }, 'embed: startup index error'));
      } catch {}
    }, 20_000);

    logger.info({ port: PORT, bindHost: cfg.bindHost, projectsRoot: PROJECTS_ROOT, logFile: LOG_FILE, env: cfg.env }, 'DarkArmy Dossier started');
    console.log(`DarkArmy Dossier: http://${cfg.bindHost}:${PORT}`);
    console.log(`Проекты: ${PROJECTS_ROOT}`);
    console.log(`Лог: ${LOG_FILE}`);
  });
}

if (require.main === module) startServer();

module.exports = {
  app, startServer, safeJoin, loadJSON, atomicWriteFile, sendProjectFile,
  validatePassword, decodeUploadFilename, safeFileName,
};
