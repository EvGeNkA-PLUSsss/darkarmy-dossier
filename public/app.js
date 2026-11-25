/* =========================================================
   DarkArmy Dossier — app.js
   ========================================================= */
if (typeof marked === 'undefined') {
  window.marked = { parse: t => `<pre>${String(t||'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre>` };
}
function escapeHtmlText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function sanitize(html) {
  if (typeof DOMPurify !== 'undefined') {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'rel'],
      FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'math', 'base'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcdoc'],
    });
  }
  // Fail-closed: если санитайзер не загрузился, показываем текст, а не «починенный»
  // регулярками HTML (такой fallback обходится и создаёт ложное чувство защиты).
  return '<pre class="plain-fallback">' + escapeHtmlText(html) + '</pre>';
}
const _scriptCache = new Map();
function loadScriptOnce(src) {
  if (_scriptCache.has(src)) return _scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
    document.head.appendChild(s);
  });
  _scriptCache.set(src, p);
  return p;
}
function mdToHtml(text) {
  try {
    const raw = (typeof marked !== 'undefined' && typeof marked.parse === 'function')
      ? marked.parse(text || '', { breaks: true, gfm: true, headerIds: false, mangle: false })
      : (typeof marked === 'function' ? marked(text || '', { breaks: true, gfm: true }) : '');
    return sanitize(raw);
  } catch {
    return `<pre>${String(text || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre>`;
  }
}
function icon(name, cls = '') {
  return `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}
/* Человеческие подписи ролей: в API/данных остаются английские ключи. */
const PROJECT_ROLE_LABELS = { creator: 'Создатель', editor: 'Редактор', member: 'Участник' };
const SITE_ROLE_LABELS = { admin: 'Администратор', member: 'Участник' };
const projectRoleLabel = r => PROJECT_ROLE_LABELS[r] || r || '—';
const siteRoleLabel = r => SITE_ROLE_LABELS[r] || r || '—';

/* =========================================================
   [NEW] Обёртки uiDialog — все alert/confirm/prompt через модалки
   ========================================================= */
const dlA = (msg, title) => (window.uiDialog?.alert ? window.uiDialog.alert(msg, title) : window.alert(msg));
const dlC = async (msg, title) => (window.uiDialog?.confirm ? await window.uiDialog.confirm(msg, title) : window.confirm(msg));
const dlP = async (msg, def = '', title) => (window.uiDialog?.prompt ? await window.uiDialog.prompt(msg, def, title) : window.prompt(msg, def));

/* [NEW] Голосовой ввод через Whisper */
let _mediaRecorder = null, _mediaChunks = [], _recordingBtn = null;
let _browserRec = null, _browserRecActive = false;

async function loadVoiceCaps() {
  try {
    const d = await fetchJson('/api/darcus/capabilities');
    state.voiceCaps = d;
  } catch { state.voiceCaps = { stt: false, tts: false, lang: 'ru' }; }
}
function getBrowserSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
function startBrowserSpeechRecognition(btn) {
  const SR = getBrowserSpeechRecognition();
  if (!SR) return dlA('Распознавание речи не настроено: установите Whisper (WHISPER_BIN/WHISPER_MODEL) или используйте Chrome/Edge с поддержкой Web Speech API.', 'Голосовой ввод недоступен');
  if (_browserRecActive) { try { _browserRec.stop(); } catch {} return; }
  try {
    const rec = new SR();
    _browserRec = rec; _browserRecActive = true;
    rec.lang = ((state.voiceCaps && state.voiceCaps.lang) || 'ru') + '-RU';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    const orig = btn.innerHTML;
    btn.dataset._origHtml = orig;
    btn.innerHTML = icon('square','sm');
    btn.classList.add('recording');
    const finish = () => {
      _browserRecActive = false;
      btn.classList.remove('recording');
      btn.innerHTML = orig;
    };
    rec.onresult = e => {
      const text = (e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript || '').trim();
      if (!text) return;
      const inp = document.getElementById(btn.dataset.mic || 'darcusInput');
      if (inp) {
        inp.value = (inp.value ? inp.value.trimEnd() + ' ' : '') + text;
        inp.dispatchEvent(new Event('input'));
        try { autoGrowResize(inp); } catch {}
        inp.focus();
        if ((btn.dataset.mic || '') === 'darcusInput' && darcusVoiceModeOn()) {
          const form = document.getElementById('darcusForm');
          if (form) setTimeout(() => form.requestSubmit(), 80);
        }
      }
      showToast('Распознано: ' + text.slice(0, 80));
    };
    rec.onerror = e => {
      const map = { 'not-allowed': 'Доступ к микрофону запрещён. Разрешите его в настройках сайта.', 'no-speech': 'Речь не распознана — попробуйте ещё раз.', 'network': 'Нет связи с сервисом распознавания (Web Speech API).' };
      dlA(map[e.error] || 'Ошибка распознавания: ' + e.error, 'Голосовой ввод');
    };
    rec.onend = finish;
    rec.start();
  } catch (e) {
    _browserRecActive = false;
    btn.classList.remove('recording');
    dlA('Не удалось включить микрофон: ' + (e.message || e.name), 'Голосовой ввод');
  }
}
async function initVoiceInput() {
  document.querySelectorAll('[data-mic]').forEach(btn => {
    if (btn._micBound) return;
    btn._micBound = true;
    btn.onclick = () => toggleRecording(btn);
  });
  loadVoiceCaps().catch(()=>{});
}

async function toggleRecording(btn) {
  if (_browserRecActive && _browserRec) { try { _browserRec.stop(); } catch {} return; }
  if (_mediaRecorder && _mediaRecorder.state === 'recording') {
    _mediaRecorder.stop();
    return;
  }
  if (!window.isSecureContext) {
    // HTTP в локальной сети: getUserMedia недоступен, но нативный диктофон телефона
    // можно открыть через <input capture> — запись уйдёт на серверный Whisper.
    if (state.voiceCaps && state.voiceCaps.stt) return recordViaNativeCapture(btn);
    return dlA('Микрофон в браузере доступен только по HTTPS или на localhost. На этом ПК откройте http://127.0.0.1:7561, с телефона — https://' + location.hostname + ':7562 (примите сертификат). Также можно включить серверный Whisper в админке: тогда запись пойдёт через системный диктофон.', 'Микрофон недоступен');
  }
  // Если серверный Whisper не настроен — используем распознавание браузера (Chrome/Edge).
  if (state.voiceCaps && !state.voiceCaps.stt && getBrowserSpeechRecognition()) {
    return startBrowserSpeechRecognition(btn);
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return dlA('Браузер не поддерживает запись с микрофона. Откройте страницу в современном Chrome/Edge/Firefox.', 'Микрофон недоступен');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';
    _mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    _mediaChunks = [];
    _recordingBtn = btn;

    _mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) _mediaChunks.push(e.data); };
    _mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording');
      btn.innerHTML = btn.dataset._origHtml || icon('microphone','sm');
      const blob = new Blob(_mediaChunks, { type: mime });
      _mediaRecorder = null;
      if (blob.size > 100) await sendAudioForTranscribe(blob, btn.dataset.mic, btn);
    };

    btn.dataset._origHtml = btn.innerHTML;
    btn.innerHTML = icon('square','sm');
    btn.classList.add('recording');
    _mediaRecorder.start();
    // авт-стоп через 60 сек
    setTimeout(() => { if (_mediaRecorder && _mediaRecorder.state === 'recording') _mediaRecorder.stop(); }, 60000);
  } catch (e) {
    const msg = e && e.name === 'NotAllowedError'
      ? 'Доступ к микрофону запрещён. Разрешите его в настройках сайта (иконка замка/микрофона в адресной строке).'
      : 'Нет доступа к микрофону: ' + (e.message || e.name || 'неизвестная ошибка');
    dlA(msg, 'Микрофон недоступен');
  }
}

function recordViaNativeCapture(btn) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'audio/*';
  inp.capture = 'microphone';
  inp.style.display = 'none';
  document.body.appendChild(inp);
  showToast('Откроется диктофон — запишите голосовое');
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    document.body.removeChild(inp);
    if (!f) return;
    await sendAudioForTranscribe(f, btn.dataset.mic || 'darcusInput', btn);
  };
  inp.click();
}

async function sendAudioForTranscribe(blob, targetInputId, btn) {  if (btn) { btn.disabled = true; btn.innerHTML = icon('loader','sm spin'); }
  try {
    const r = await fetch('/api/darcus/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.statusText);
    const inp = document.getElementById(targetInputId);
    if (inp) {
      inp.value = (inp.value ? inp.value.trimEnd() + ' ' : '') + (d.text || '');
      inp.dispatchEvent(new Event('input'));
      try { autoGrowResize(inp); } catch {}
      inp.focus();
      // Голосовой режим: распознанный текст сразу отправляем в Darcus.
      if (targetInputId === 'darcusInput' && darcusVoiceModeOn() && (d.text || '').trim()) {
        const form = document.getElementById('darcusForm');
        if (form) setTimeout(() => form.requestSubmit(), 80);
      }
    }
    showToast('Распознано: ' + (d.text || '').slice(0, 80));
  } catch (e) {
    dlA('Ошибка распознавания: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset._origHtml || icon('microphone','sm'); }
  }
}

/* ---------- Голосовой режим Darcus ---------- */
function darcusVoiceModeOn() { return localStorage.getItem('darcusVoiceMode') === '1'; }
function updateVoiceModeBtn() {
  const btn = document.getElementById('darcusVoiceModeBtn');
  if (!btn) return;
  btn.classList.toggle('active', darcusVoiceModeOn());
  btn.title = darcusVoiceModeOn()
    ? 'Голосовой режим включён: ответы озвучиваются, запрос можно надиктовать'
    : 'Голосовой режим: ответы озвучиваются, микрофон сам отправляет запрос';
}
function setDarcusVoiceMode(on) {
  localStorage.setItem('darcusVoiceMode', on ? '1' : '0');
  updateVoiceModeBtn();
  if (on) {
    if (!window.isSecureContext)
      dlA('Голосовой режим включён, ответы будут озвучиваться. Запись с микрофона в этом браузере недоступна по HTTP — откройте Dossier по HTTPS или на localhost.', 'Голосовой режим');
    else showToast('Голосовой режим включён');
  } else {
    stopAllTts();
    showToast('Голосовой режим выключен');
  }
}

/* ---------- Darcus: авто-применение действий ---------- */
function darcusAutoApplyOn() { return localStorage.getItem('darcusAutoApply') === '1'; }
function updateDarcusAutoApplyBtn() {
  const b = document.getElementById('darcusAutoApplyBtn');
  if (!b) return;
  b.classList.toggle('active', darcusAutoApplyOn());
  b.title = darcusAutoApplyOn()
    ? 'Авто-применение включено: Darcus меняет файлы без подтверждения'
    : 'Применять действия Darcus без подтверждения';
}
function setDarcusAutoApply(on) {
  localStorage.setItem('darcusAutoApply', on ? '1' : '0');
  updateDarcusAutoApplyBtn();
  showToast(on ? 'Darcus: действия без подтверждения' : 'Darcus: подтверждение включено');
}

/* ---------- State ---------- */
const state = {
  user: null, muted: false, theme: 'dark',
  projectId: null, projects: [], currentProject: null,
  tree: [], expanded: new Set(), currentFile: null,
  selected: new Set(), lastSelectedPath: null,
  showChanges: false, editorPreviewVisible: true,
  chatOpen: false, chatTab: 'general',
  chatCache: { general: [] }, projectMessages: [], projectTasks: [],
  pendingAttachments: { general: [], project: [], ticket: [] },
  currentTicketId: null, tickets: [], ticketCache: {},
  editingFile: null, editUsers: [], editorChangeTimer: null,
  applyingRemote: false, draggingPath: null, punishTarget: null,
  darcusChats: [], darcusCurrentChatId: null,
  darcus: { messages: [], streaming: false, streamingId: null, attachments: [], abortController: null },
  inlineEditFile: null,
  subscription: { active: false, until: null, forceAdmin: false },
  adsData: null, adsTimers: new Map(),
  adsDebug: (localStorage.getItem('showAds') === '1'),
  ttsAudio: null,
  ttsAudioUrl: null,
  ttsSource: null,
  voiceCaps: null,
  /* [NEW] tags/favorites */
  meta: { tags: {}, favorites: {} },

  /* [NEW] TTS */
  ttsSpeakingId: null,

  /* [NEW] Open editors per project (persist on project switch) */
  lastFileByProject: (() => { try { return JSON.parse(localStorage.getItem('lastFileByProject')||'{}'); } catch { return {}; } })(),

  /* [NEW] Pending file action from AI */
  pendingAiAction: null,

  /* [FIX] Открытые редакторы + черновики между переключениями */
  drafts: (() => { try { return JSON.parse(localStorage.getItem('da_drafts') || '{}'); } catch { return {}; } })(),
  openEditors: (() => { try { return JSON.parse(localStorage.getItem('da_openEditors') || '{}'); } catch { return {}; } })(),
};

const listEl       = document.getElementById('tree');
const contentEl    = document.getElementById('content');
const filebarEl    = document.getElementById('filebar');
const fileNameEl   = document.getElementById('fileName');
const editBtn      = document.getElementById('editBtn');
const uploadBtn    = document.getElementById('uploadBtn');
const uploadInput  = document.getElementById('uploadInput');
const newFileBtn   = document.getElementById('newFileBtn');
const newFolderBtn = document.getElementById('newFolderBtn');
const changesBtn   = document.getElementById('changesToggleBtn');
const modal        = document.getElementById('editorModal');
const area         = document.getElementById('editorArea');
const previewEl    = document.getElementById('editorPreview');
const ctxMenu      = document.getElementById('ctxMenu');
const punishMenu   = document.getElementById('punishMenu');

const chatPanel         = document.getElementById('chatPanel');
const chatMsgBox        = document.getElementById('chatMessages');
const chatInput         = document.getElementById('chatInput');
const chatForm          = document.getElementById('chatForm');
const ticketListEl      = document.getElementById('ticketList');
const ticketMessagesEl  = document.getElementById('ticketMessages');
const ticketForm        = document.getElementById('ticketForm');
const ticketInput       = document.getElementById('ticketInput');
const ticketChatTitle   = document.getElementById('ticketChatTitle');
const ticketChatStatus  = document.getElementById('ticketChatStatus');
const ticketChatActions = document.getElementById('ticketChatActions');

const IMG_EXT    = ['png','jpg','jpeg','gif','svg','webp','bmp','ico'];
const EDITABLE   = ['md','markdown','txt','js','json','css','html','xml','csv','log','yml','yaml','ts','sh','env','ini','conf'];
const DOCX_EXT   = ['docx'];
const XLSX_EXT   = ['xlsx','xls','ods'];
const OFFICE_EXT = ['doc','ppt','pptx','odt','odp','rtf'];
const PDF_EXT    = ['pdf'];
const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

/* [NEW] Автообновление интерфейса: после рестарта сервера вкладка сама
   перезагрузится, чтобы не работать со старыми app.js/design.css. */
function initVersionWatch() {
  let initial = null;
  let reloading = false;
  const check = async () => {
    if (reloading) return;
    try {
      const r = await fetch('/api/version', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const v = d.build || d.version;
      if (!initial) { initial = v; return; }
      if (v && v !== initial) {
        reloading = true;
        try { showToast('Интерфейс обновлён — перезагружаю…'); } catch {}
        setTimeout(() => location.reload(), 800);
      }
    } catch {}
  };
  check();
  setInterval(check, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

/* =========================================================
   Init
   ========================================================= */
(async function init() {
  try {
    const meR = await fetch('/api/me');
    const meData = await meR.json();
    if (!meData.user) return location.href = '/login.html';
    state.user = meData.user;
    state.muted = !!meData.muted;
    state.theme = meData.theme || 'dark';
    applyTheme(state.theme);

    const roleName = { member: 'Участник', admin: 'Администратор' };
    const ul = document.getElementById('userLabel');
    if (ul) { ul.textContent = state.user.username; ul.title = `${state.user.username} · ${roleName[state.user.role]}`; }
    if (state.user.role === 'admin') { const al = document.getElementById('adminLink'); if (al) al.style.display = ''; }

    const lb = document.getElementById('logoutBtn');
    if (lb) lb.onclick = async () => {
      if (evtSource) evtSource.close();
      await fetch('/api/logout', { method: 'POST' });
      location.href = '/login.html';
    };
    document.getElementById('themeBtn').onclick = toggleTheme;

    document.addEventListener('click', e => {
      if (ctxMenu && !ctxMenu.contains(e.target)) ctxMenu.style.display = 'none';
      if (punishMenu && !punishMenu.contains(e.target)) punishMenu.style.display = 'none';
    });

    // [UX] Меню открывается свайпом (см. initSwipeSidebar), но на телефоне
    // должна быть и явная кнопка: свайп от края конфликтует с системным back.
    try { initSwipeSidebar(); } catch (e) { console.error('swipe', e); }
    const menuBtn = document.getElementById('menuBtn');
    if (menuBtn) menuBtn.onclick = () => {
      const open = document.body.classList.toggle('sidebar-open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const bk = document.getElementById('sidebarBackdrop');
    if (bk) bk.onclick = () => document.body.classList.remove('sidebar-open');
    const tb = document.getElementById('trashBtn');
    if (tb) tb.onclick = openTrashModal;

    initProjectDropdown();
    document.getElementById('projectMenuBtn').onclick = openProjectMenu;
    document.getElementById('projectAddBtn').onclick = () => {
      const m = document.getElementById('newProjectModal');
      document.getElementById('newProjectForm').reset();
      closeProjectDropdown();
      m.style.display = 'flex';
    };
    document.getElementById('newProjectCloseBtn').onclick =
    document.getElementById('newProjectCancelBtn').onclick = () =>
      document.getElementById('newProjectModal').style.display = 'none';
    document.getElementById('newProjectForm').onsubmit = createProject;
    document.getElementById('projectCloseBtn').onclick =
      () => document.getElementById('projectModal').style.display = 'none';
    document.querySelectorAll('#projectTabs .proj-tab').forEach(t =>
      t.onclick = () => renderProjectTab(t.dataset.tab));

    document.getElementById('punishCloseBtn').onclick =
    document.getElementById('punishCancelBtn').onclick = () =>
      document.getElementById('punishModal').style.display = 'none';
    document.getElementById('punishForm').onsubmit = submitPunishment;

    initLightbox();

    const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`init ${name}:`, e); } };
    safe('chat', initChat);
    safe('chat-drop', initChatDropTargets);
    safe('paste-upload', initPasteUploads);
    safe('requests', initRequests);
    safe('inbox', initInbox);
    safe('notifications', initNotifications);
    safe('reports', initReports);
    safe('profile', initProfile);
    safe('move', initMove);
    safe('dnd', initDragAndDrop);
    safe('search', initSearch);
    safe('history', initHistory);
    safe('tts', initTts);
    safe('selection-menu', initSelectionMenu);
    safe('print', initPrint);
  safe('version-watch', initVersionWatch);

    try { connectSSE(); } catch (e) { console.error('SSE failed:', e); }

    await loadProjects();
    if (state.projects.length) {
      const saved = localStorage.getItem('lastProject');
      const pid = state.projects.find(p => p.id === saved)?.id || state.projects[0].id;
      await switchProject(pid);
    } else renderEmptyProjects();

    sendClientTelemetry();
    startRoleWatcher();
    console.log('Init complete for', state.user.username);
  } catch (e) {
    console.error('Init failed:', e);
    document.body.innerHTML = `<pre style="padding:20px;color:#f88">Ошибка инициализации: ${e.message}\n\n${e.stack}</pre>`;
  }
})();

/* =========================================================
   Тема
   ========================================================= */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const use = document.querySelector('#themeBtn use');
  if (use) use.setAttribute('href', theme === 'dark' ? '#i-moon' : '#i-sun');
}
async function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  state.theme = next; applyTheme(next);
  try { await fetch('/api/account/theme', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: next }) }); } catch {}
}

/* Toast */
function showToast(text) {
  if (typeof text !== 'string' || !text.trim()) return;
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = text;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('toast-out'); setTimeout(() => el.remove(), 260); }, 2600);
}

/* Lightbox */
function initLightbox() {
  const lb = document.getElementById('lightboxModal'); if (!lb) return;
  document.getElementById('lightboxClose').onclick = () => lb.style.display = 'none';
  lb.addEventListener('click', e => { if (e.target === lb) lb.style.display = 'none'; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && lb.style.display !== 'none') lb.style.display = 'none'; });
}
function openLightbox(src) {
  const lb = document.getElementById('lightboxModal'), img = document.getElementById('lightboxImg');
  if (!lb || !img) return;
  img.src = src; lb.style.display = 'flex';
}

/* [NEW] Meta (tags/favorites) */
async function loadMeta() {
  if (!state.projectId) { state.meta = state.meta || { tags: {}, favorites: {} }; return; }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(state.projectId)}/meta`);
    if (r.ok) state.meta = await r.json();
  } catch {}
  state.meta = state.meta || { tags: {}, favorites: {} };
}

/* =========================================================
   Проекты
   ========================================================= */
function initProjectDropdown() {
  const btn = document.getElementById('projectDropdownBtn');
  const panel = document.getElementById('projectDropdownPanel');
  const search = document.getElementById('projectSearchInput');
  btn.onclick = e => { e.stopPropagation(); const open = !panel.hidden; open ? closeProjectDropdown() : openProjectDropdown(); };
  panel.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => closeProjectDropdown());
  search.addEventListener('input', renderProjectList);
}
function openProjectDropdown() {
  document.getElementById('projectDropdownPanel').hidden = false;
  document.getElementById('projectDropdown').classList.add('open');
  const s = document.getElementById('projectSearchInput');
  s.value = ''; renderProjectList(); setTimeout(() => s.focus(), 20);
}
function closeProjectDropdown() {
  const p = document.getElementById('projectDropdownPanel'); if (p) p.hidden = true;
  const d = document.getElementById('projectDropdown'); if (d) d.classList.remove('open');
}
function renderProjectList() {
  const q = (document.getElementById('projectSearchInput').value || '').toLowerCase().trim();
  const list = document.getElementById('projectList');
  list.innerHTML = '';
  const filtered = q ? state.projects.filter(p => p.name.toLowerCase().includes(q)) : state.projects;
  if (!filtered.length) { list.innerHTML = '<div class="project-list-empty">Ничего не найдено</div>'; return; }
  for (const p of filtered) {
    const el = document.createElement('div');
    el.className = 'project-list-item' + (p.id === state.projectId ? ' active' : '');
    el.innerHTML = `${icon('layers','sm')}<span class="proj-name">${escapeHtml(p.name)}</span>${p.myRole ? `<span class="proj-role">${escapeHtml(projectRoleLabel(p.myRole))}</span>` : ''}`;
    el.onclick = () => { closeProjectDropdown(); switchProject(p.id); };
    list.appendChild(el);
  }
}
async function loadProjects() {
  const r = await fetch('/api/projects');
  const data = await r.json();
  state.projects = data.projects || [];
  renderProjectList();
  const cur = state.projects.find(p => p.id === state.projectId);
  const nameEl = document.getElementById('projectDropdownName');
  if (nameEl) nameEl.textContent = cur ? cur.name : '—';
}
async function switchProject(id) {
  
  if (!id || id === state.projectId) return;
  // Закрываем inline-редактор ДО смены projectId: иначе /api/edit/leave уходил
  // уже с новым проектом, черновик сохранялся под чужим ключом, а в редакторе
  // мог остаться текст файла из старого проекта (и затереть одноимённый файл).
  if (state.inlineEditFile) {
    try { await leaveInlineEditorSilent(); } catch {}
  }
  // [NEW] Сохраняем открытый файл для текущего проекта
  if (state.projectId && state.currentFile) {
    state.lastFileByProject[state.projectId] = state.currentFile;
    try { localStorage.setItem('lastFileByProject', JSON.stringify(state.lastFileByProject)); } catch {}
  }
  // [FIX] Сохраняем черновик открытого редактора, но НЕ закрываем сессию
  if (state.inlineEditFile) {
    const areaEl = document.getElementById('inlineArea');
    if (areaEl) {
      const key = state.projectId + '::' + state.inlineEditFile;
      state.drafts[key] = areaEl.value;
      state.openEditors[key] = true;
      _persistDrafts();
    }
  }
  state.projectId = id;
  localStorage.setItem('lastProject', id);
  const r = await fetch('/api/projects/' + id);
  if (!r.ok) { renderEmptyProjects(); return; }  const { project } = await r.json();
  state.currentProject = project;
  state.currentFile = null; state.expanded = new Set();
  resetViewer();
  await loadTree();
  await loadMeta();
  await updateUploadLabel();
  updateProjectMenuAvailability();
  const nameEl = document.getElementById('projectDropdownName');
  if (nameEl) nameEl.textContent = project.name;
  const role = project.myRole;
  const canEdit = state.user.role === 'admin' || role === 'editor' || role === 'creator';
  if (uploadBtn) uploadBtn.style.display = canEdit ? '' : 'none';
  if (newFileBtn) newFileBtn.style.display = canEdit ? '' : 'none';
  if (newFolderBtn) newFolderBtn.style.display = canEdit ? '' : 'none';
  if (changesBtn) changesBtn.style.display = 'none';
  const ib = document.getElementById('inboxBtn');
  if (ib) ib.style.display = state.user.role === 'admin' ? '' : 'none';
  if (state.chatTab === 'project') await loadProjectChat();
  updateDarcusGenAvailability();

  // [FIX] Восстанавливаем последний открытый файл этого проекта
  const lastFile = state.lastFileByProject[id];
  if (lastFile) {
    try { await openFile(lastFile); } catch {}
  }
}
function renderEmptyProjects() {
  listEl.innerHTML = '<p class="hint">Нет доступных проектов. Создайте новый.</p>';
  filebarEl.style.display = 'none';
  contentEl.innerHTML = '<p class="hint">Нет проектов</p>';
  const nameEl = document.getElementById('projectDropdownName');
  if (nameEl) nameEl.textContent = '—';
  state.projectId = null; state.currentProject = null;
  updateDarcusGenAvailability();
}
// «Darcus — создать» доступна только при выбранном проекте.
function updateDarcusGenAvailability() {
  const btn = document.getElementById('darcusGenBtn');
  if (!btn) return;
  const has = !!state.projectId;
  btn.style.display = has ? '' : 'none';
  btn.disabled = !has;
  if (btn.title !== undefined) btn.title = has ? 'Создать документ через Darcus' : 'Сначала выберите проект';
}
function updateProjectMenuAvailability() {
  const b = document.getElementById('projectMenuBtn'); if (b) b.disabled = !state.currentProject;
}
async function createProject(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: fd.get('name') }) });
  const data = await r.json();
  if (!r.ok) return dlA('Ошибка: ' + (data.error || r.statusText));
  document.getElementById('newProjectModal').style.display = 'none';
  await loadProjects();
  await switchProject(data.project.id);
}

/* =========================================================
   Меню проекта
   ========================================================= */
function openProjectMenu() {
  if (!state.currentProject) return;
  const modal = document.getElementById('projectModal');
  document.getElementById('projectModalTitle').innerHTML = `${icon('layers','sm')} ${escapeHtml(state.currentProject.name)}`;
  const tabs = document.getElementById('projectTabs');
  const isCreator = state.user.role === 'admin' || state.currentProject.myRole === 'creator';
  tabs.querySelector('[data-tab="activity"]').style.display = isCreator ? '' : 'none';
  document.querySelectorAll('#projectTabs .proj-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'members'));
  renderProjectTab('members');
  modal.style.display = 'flex';
}
function renderProjectTab(tab) {
  document.querySelectorAll('#projectTabs .proj-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const body = document.getElementById('projectBody'); body.innerHTML = '';
  const p = state.currentProject; if (!p) return;
  const isAdmin = state.user.role === 'admin';
  const isCreator = isAdmin || p.myRole === 'creator';
  if (tab === 'members') renderProjectMembers(body, p, isCreator);
  else if (tab === 'settings') renderProjectSettings(body, p, isCreator, isAdmin);
  else if (tab === 'activity') renderProjectActivity(body, p);
}
function renderProjectMembers(body, p, canManage) {
  if (canManage) {
    const addWrap = document.createElement('div');
    addWrap.className = 'member-row';
    addWrap.innerHTML = `
      <input id="projAddUser" placeholder="Логин" style="flex:1;padding:8px 10px;background:var(--code-bg);border:1px solid var(--border);border-radius:6px;color:var(--text)">
      <select id="projAddRole"><option value="member">Участник</option><option value="editor">Редактор</option><option value="creator">Создатель</option></select>
      <button id="projAddBtn" class="primary"><svg class="ico sm"><use href="#i-user-plus"/></svg> Добавить</button>`;
    body.appendChild(addWrap);
    addWrap.querySelector('#projAddBtn').onclick = async () => {
      const u = addWrap.querySelector('#projAddUser').value.trim();
      const r = addWrap.querySelector('#projAddRole').value;
      if (!u) return;
      const res = await fetch(`/api/projects/${p.id}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, role: r }) });
      const d = await res.json();
      if (!res.ok) return dlA('Ошибка: ' + (d.error || res.statusText));
      await reloadCurrentProject();
    };
  }
  for (const m of p.members) {
    const row = document.createElement('div');
    row.className = 'member-row';
    const isCreatorRow = m.username === p.creator;
    row.innerHTML = `
      <span class="name">${icon('user','sm')} ${escapeHtml(m.username)} ${isCreatorRow ? '<span class="creator-badge">Создатель</span>' : ''}</span>
      ${canManage && !isCreatorRow ? `
        <select data-u="${escapeHtml(m.username)}"><option value="member" ${m.role==='member'?'selected':''}>Участник</option><option value="editor" ${m.role==='editor'?'selected':''}>Редактор</option><option value="creator" ${m.role==='creator'?'selected':''}>Создатель</option></select>
        <button class="danger" data-remove="${escapeHtml(m.username)}">${icon('trash','sm')}</button>` : `<span class="muted" style="font-size:12px">${escapeHtml(projectRoleLabel(m.role))}</span>`}`;
    body.appendChild(row);
    if (canManage && !isCreatorRow) {
      row.querySelector('select').onchange = async e => {
        const r = await fetch(`/api/projects/${p.id}/members/${encodeURIComponent(m.username)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: e.target.value }) });
        const d = await r.json();
        if (!r.ok) return dlA('Ошибка: ' + (d.error || r.statusText));
        await reloadCurrentProject();
      };
      row.querySelector('[data-remove]').onclick = async () => {
        if (!(await dlC(`Удалить ${m.username} из проекта?`))) return;
        const r = await fetch(`/api/projects/${p.id}/members/${encodeURIComponent(m.username)}`, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok) return dlA('Ошибка: ' + (d.error || r.statusText));
        await reloadCurrentProject();
      };
    }
  }
}
function renderProjectSettings(body, p, canManage, isAdmin) {
  if (!canManage) { body.innerHTML = '<p class="hint">Только создатель может изменять настройки.</p>'; return; }
  body.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
      <input id="projName" value="${escapeHtml(p.name)}" maxlength="100" style="flex:1;padding:10px 12px;background:var(--code-bg);border:1px solid var(--border);border-radius:8px;color:var(--text)">
      <button id="projSave" class="primary" style="padding:10px 16px;background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:6px;cursor:pointer">${icon('save','sm')} Сохранить</button></div>`;
  body.querySelector('#projSave').onclick = async () => {
    const name = body.querySelector('#projName').value.trim();
    if (!name) return;
    const r = await fetch('/api/projects/' + p.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await r.json();
    if (!r.ok) return dlA('Ошибка: ' + (d.error || r.statusText));
    await reloadCurrentProject();
  };
  if (isAdmin) {
    const danger = document.createElement('div');
    danger.style = 'margin-top:24px;padding-top:16px;border-top:1px solid var(--border)';
    danger.innerHTML = `
      <h3 style="font-size:14px;color:var(--danger-fg);margin-bottom:8px">Опасная зона</h3>
      <p class="hint" style="margin-bottom:10px">Удаление проекта необратимо. Все файлы будут стёрты.</p>
      <button id="projDelete" class="danger-btn">${icon('trash','sm')} Удалить проект</button>`;
    body.appendChild(danger);
    danger.querySelector('#projDelete').onclick = async () => {
      if (!(await dlC(`Удалить проект «${p.name}»? Это действие необратимо.`))) return;
      if (!(await dlC('Точно удалить ВСЕ файлы проекта?'))) return;
      const r = await fetch('/api/projects/' + p.id, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) return dlA('Ошибка: ' + (d.error || r.statusText));
      document.getElementById('projectModal').style.display = 'none';
      state.projectId = null;
      await loadProjects();
      if (state.projects.length) await switchProject(state.projects[0].id); else renderEmptyProjects();
    };
  }
}
async function renderProjectActivity(body, p) {
  body.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const r = await fetch(`/api/projects/${p.id}/activity?limit=50`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const { entries } = await r.json();
    if (!entries.length) { body.innerHTML = '<p class="hint">Пока нет действий.</p>'; return; }
    body.innerHTML = '';
    for (const e of entries) {
      const el = document.createElement('div');
      el.className = 'activity-item';
      el.innerHTML = `<div class="head"><span class="badge ${e.action}">${e.action}</span><b>${escapeHtml(e.user || '')}</b><span class="muted">${new Date(e.timestamp).toLocaleString('ru-RU')}</span>${e.file ? `<span class="file">${escapeHtml(e.file)}</span>` : ''}</div>${e.details ? `<div class="details">${escapeHtml(e.details)}</div>` : ''}`;
      body.appendChild(el);
    }
  } catch (e) { body.innerHTML = `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`; }
}
async function reloadCurrentProject() {
  if (!state.projectId) return;
  const r = await fetch('/api/projects/' + state.projectId);
  if (r.ok) { const { project } = await r.json(); state.currentProject = project; }
  await loadProjects();
  const tab = document.querySelector('#projectTabs .proj-tab.active')?.dataset.tab || 'members';
  renderProjectTab(tab);
}
async function updateUploadLabel() {
  try {
    const s = await (await fetch('/api/settings')).json();
    if (state.user.role === 'admin') uploadBtn.innerHTML = `${icon('upload','sm')} Загрузить`;
    else if (s.uploadLimitMB) uploadBtn.innerHTML = `${icon('upload','sm')} Загрузить`;
    else uploadBtn.innerHTML = `${icon('upload','sm')} Загрузить`;
    // Лимит — в подсказке, чтобы длинная подпись не обрезалась в узком сайдбаре.
    uploadBtn.title = (state.user.role !== 'admin' && s.uploadLimitMB)
      ? `Загрузить файл с компьютера (до ${s.uploadLimitMB} МБ)`
      : 'Загрузить файл с компьютера';
  } catch {}
}

/* SSE + telemetry */
function sendClientTelemetry() {
  try {
    fetch('/api/telemetry/client', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      screen: `${screen.width}x${screen.height}`, viewport: `${window.innerWidth}x${window.innerHeight}`,
      lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: navigator.platform, referrer: document.referrer
    })}).catch(() => {});
  } catch {}
}
function startRoleWatcher() {
  // Раньше опрашивали /api/me каждые 30 секунд (8251 запрос в логе за месяц).
  // Роль/бан меняются редко — 5 минут и только для активной вкладки достаточно.
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const r = await fetch('/api/me');
      const { user, muted } = await r.json();
      if (!user) return location.href = '/login.html';
      if (user.role !== state.user.role || user.username !== state.user.username) location.reload();
      state.muted = !!muted;
    } catch {}
  }, 5 * 60 * 1000);
}

let evtSource = null;
const unread = { chat: 0, tickets: 0, requests: 0, reports: 0, project: 0 };

function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/api/events');
  evtSource.addEventListener('banned', () => { dlA('Вы забанены'); location.href = '/login.html?banned=1'; });
  evtSource.addEventListener('chat', e => { const { message } = JSON.parse(e.data); handleIncomingChat(message); });
  // [NEW] Удаление сообщения другим клиентом/устройством — синхронизируем UI
  evtSource.addEventListener('chat-delete', e => {
    const { messageId } = JSON.parse(e.data);
    state.chatCache.general = (state.chatCache.general || []).filter(m => m.id !== messageId);
    if (state.chatOpen && state.chatTab === 'general') renderGeneralMessages();
  });
  evtSource.addEventListener('chat-project-delete', e => {
    const { projectId, messageId } = JSON.parse(e.data);
    if (projectId !== state.projectId) return;
    state.projectMessages = (state.projectMessages || []).filter(m => m.id !== messageId);
    if (state.chatOpen && state.chatTab === 'project') renderProjectMessages();
  });
  evtSource.addEventListener('chat-project', e => {
    const { projectId, message } = JSON.parse(e.data);
    if (projectId !== state.projectId) return;
    if (state.projectMessages.some(m => m.id === message.id)) return;
    state.projectMessages.push(message);
    const active = state.chatOpen && state.chatTab === 'project';
    if (active) { const empty = document.getElementById('projectMessages').querySelector('.chat-empty'); if (empty) empty.remove(); renderProjectMessages(); }
    else if (message.from !== state.user.username) { unread.project = (unread.project || 0) + 1; updateChatBadge(); }
  });
  evtSource.addEventListener('project-task', e => {
    const { projectId, task, taskId, op } = JSON.parse(e.data);
    if (projectId !== state.projectId) return;
    if (op === 'add') { if (!state.projectTasks.some(t => t.id === task.id)) state.projectTasks.push(task); }
    else if (op === 'update') { const i = state.projectTasks.findIndex(t => t.id === task.id); if (i >= 0) state.projectTasks[i] = task; }
    else if (op === 'delete') { state.projectTasks = state.projectTasks.filter(t => t.id !== taskId); }
    renderProjectTasks();
  });
  evtSource.addEventListener('edit-change', e => {
    const { projectId, file, content, from } = JSON.parse(e.data);
    if (projectId !== state.projectId || file !== state.editingFile) return;
    if (from === state.user.username) return;
    const s1 = area.selectionStart, s2 = area.selectionEnd;
    state.applyingRemote = true;
    area.value = content;
    try { area.selectionStart = Math.min(s1, content.length); area.selectionEnd = Math.min(s2, content.length); } catch {}
    state.applyingRemote = false;
    updatePreview();
  });
  evtSource.addEventListener('edit-users', e => {
    const { projectId, file, users } = JSON.parse(e.data);
    if (projectId !== state.projectId || file !== state.editingFile) return;
    state.editUsers = users || []; updateEditorUsersUI();
  });
  evtSource.addEventListener('edit-saved', e => {
    const { projectId, file, by } = JSON.parse(e.data);
    if (projectId !== state.projectId || file !== state.editingFile) return;
    showToast(`${by} зафиксировал изменения`);
  });
  evtSource.addEventListener('request', () => { if (state.user.role !== 'admin') return; unread.requests++; updateInboxBadge(); });
  evtSource.addEventListener('notification', e => {
    let notification = null;
    try { notification = JSON.parse(e.data).notification; } catch {}
    if (!notification) return;
    setNotifBadge(notifState.unread + 1);
    if (notifModalEl && notifModalEl.style.display !== 'none') {
      notifState.items.unshift(notification);
      if (notifState.items.length > 100) notifState.items.length = 100;
      renderNotifications();
    }
    showToast(notification.title + (notification.body ? ': ' + notification.body.slice(0, 90) : ''));
  });
  evtSource.addEventListener('report', () => { if (state.user.role !== 'admin') return; unread.reports++; updateInboxBadge(); });
  evtSource.addEventListener('ticket-new', () => { if (state.user.role !== 'admin') return; unread.tickets++; updateChatBadge(); });
  evtSource.addEventListener('ticket-message', e => {
    const { ticketId, message } = JSON.parse(e.data);
    const isMine = message.from === state.user.username;
    if (!state.ticketCache[ticketId]) state.ticketCache[ticketId] = [];
    if (!state.ticketCache[ticketId].some(m => m.id === message.id)) state.ticketCache[ticketId].push(message);
    const active = state.chatOpen && state.chatTab === 'support' && state.currentTicketId === ticketId;
    if (active) renderTicketMessages();
    if (!isMine && !active) { unread.tickets++; updateChatBadge(); }
  });
  evtSource.addEventListener('ticket-status', () => { loadTickets().then(() => { if (state.currentTicketId) openTicket(state.currentTicketId); }); });
  evtSource.addEventListener('project-update', () => {
    loadProjects().then(() => {
      if (state.projectId) {
        const p = state.projects.find(x => x.id === state.projectId);
        if (!p) { if (state.projects.length) switchProject(state.projects[0].id); else renderEmptyProjects(); }
      }
    });
  });
  evtSource.onerror = () => { setTimeout(() => { if (evtSource.readyState === EventSource.CLOSED) connectSSE(); }, 5000); };
}
function updateChatBadge() {
  const b = document.getElementById('chatBadge');
  const n = (unread.chat || 0) + (unread.tickets || 0) + (unread.project || 0);
  if (b) { if (n) { b.textContent = n; b.style.display = ''; } else b.style.display = 'none'; }
  const set = (id, val) => { const el = document.getElementById(id); if (!el) return; if (val) { el.textContent = val; el.style.display = ''; } else el.style.display = 'none'; };
  set('tabGeneralBadge', unread.chat); set('tabProjectBadge', unread.project); set('tabSupportBadge', unread.tickets);
}
function updateInboxBadge() {
  const b = document.getElementById('inboxBadge'); if (!b) return;
  const n = unread.requests + unread.reports;
  if (n) { b.textContent = n; b.style.display = ''; } else b.style.display = 'none';
}

/* =========================================================
   Дерево
   ========================================================= */
async function loadTree() {
  if (!state.projectId) return;
  const r = await fetch('/api/tree?projectId=' + encodeURIComponent(state.projectId));
  if (r.status === 401) return location.href = '/login.html';
  if (!r.ok) { listEl.innerHTML = '<p class="hint">Нет доступа</p>'; return; }
  const { tree } = await r.json(); state.tree = tree; renderTree();
}
function renderTree() {
  listEl.innerHTML = '';
  const pname = state.currentProject ? state.currentProject.name : 'проект';
  const rootRow = document.createElement('div');
  rootRow.className = 'tree-row tree-root';
  rootRow.dataset.path = ''; rootRow.dataset.isDir = '1';
  rootRow.innerHTML = `<span class="arrow"></span><span class="icon">${icon('home','sm')}</span><span class="name">Корень: ${escapeHtml(pname)}</span>`;
  rootRow.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); showCtxMenu(e.pageX, e.pageY, { name: 'Корень', path: '', isDir: true }, 'root'); };
  listEl.appendChild(rootRow);
  if (!state.tree.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.innerHTML = `<div class="tree-empty-icon">${icon('folder','sm')}</div>
      <div class="tree-empty-title">Проект пуст</div>
      <div class="tree-empty-hint">Перетащите файлы сюда<br>или создайте первый файл</div>
      <button type="button" class="tree-empty-btn">${icon('plus','sm')} Создать файл</button>`;
    const goCreate = () => { const b = document.getElementById('newFileBtn'); if (b) b.click(); };
    empty.querySelector('.tree-empty-btn').onclick = goCreate;
    empty.addEventListener('dragover', e => { e.preventDefault(); empty.classList.add('drag-over'); });
    empty.addEventListener('dragleave', () => empty.classList.remove('drag-over'));
    empty.addEventListener('drop', async e => {
      e.preventDefault(); empty.classList.remove('drag-over');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) await uploadFilesToRoot(files);
    });
    listEl.appendChild(empty);
    renderBulkBar();
    return;
  }
  renderNodes(state.tree, listEl, 0);
  renderBulkBar();
}
/* ---------- Массовое выделение файлов ---------- */
function visibleTreePaths() {
  return [...document.querySelectorAll('#tree .tree-row[data-path]')]
    .map(r => r.dataset.path).filter(p => p);
}
function setTreeSelectedRow(path, on) {
  const row = listEl.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
  if (row) row.classList.toggle('selected', on);
}
function clearTreeSelection() {
  state.selected.clear(); state.lastSelectedPath = null;
  document.querySelectorAll('#tree .tree-row.selected').forEach(r => r.classList.remove('selected'));
  renderBulkBar();
}
function handleTreeSelection(e, n) {
  e.stopPropagation(); e.preventDefault();
  const paths = visibleTreePaths();
  const idx = paths.indexOf(n.path);
  if (e.shiftKey && state.lastSelectedPath != null) {
    const start = paths.indexOf(state.lastSelectedPath);
    if (start >= 0 && idx >= 0) {
      const [a, b] = start < idx ? [start, idx] : [idx, start];
      for (let i = a; i <= b; i++) state.selected.add(paths[i]);
      paths.slice(a, b + 1).forEach(p => setTreeSelectedRow(p, true));
    }
  } else {
    if (state.selected.has(n.path)) state.selected.delete(n.path);
    else state.selected.add(n.path);
    setTreeSelectedRow(n.path, state.selected.has(n.path));
    state.lastSelectedPath = n.path;
  }
  renderBulkBar();
}
function pruneTreeSelection() {
  const existing = new Set(visibleTreePaths());
  for (const p of [...state.selected]) if (!existing.has(p)) state.selected.delete(p);
  document.querySelectorAll('#tree .tree-row.selected').forEach(r => {
    if (!state.selected.has(r.dataset.path)) r.classList.remove('selected');
  });
}
function renderBulkBar() {
  // Никакой «дурацкой» панели поверх дерева: обычное выделение, как в редакторе.
  // Открытый файл считается выделенным (подсветка active), Ctrl/Shift — диапазон.
  pruneTreeSelection();
}
async function bulkDeleteSelected() {
  const paths = [...state.selected];
  if (!paths.length) return;
  if (!(await dlC(`Удалить выбранные файлы/папки (${paths.length})?`))) return;
  for (const p of paths) {
    try {
      await fetch(`/api/delete?path=${encodeURIComponent(p)}&projectId=${encodeURIComponent(state.projectId)}`, { method: 'DELETE' });
    } catch {}
  }
  clearTreeSelection(); await loadTree(); showToast(`Удалено: ${paths.length}`);
}
async function bulkMoveSelected() {
  const paths = [...state.selected];
  if (!paths.length) return;
  const dir = (await dlP('Куда переместить выбранные? Папка в проекте (пусто = корень):', '', 'Массовое перемещение')) ?? '';
  if (dir === null) return;
  for (const p of paths) {
    const base = p.split('/').pop();
    const to = dir ? dir.replace(/\/+$/, '') + '/' + base : base;
    try {
      await fetch('/api/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: p, to, projectId: state.projectId }),
      });
    } catch {}
  }
  clearTreeSelection(); await loadTree(); showToast(`Перемещено: ${paths.length}`);
}
function insertMarkdownForProjectPath(areaEl, relPath) {
  if (!areaEl || !relPath) return;
  const name = relPath.split('/').pop();
  const url = '/files/' + state.projectId + '/' + relPath.split('/').map(encodeURIComponent).join('/');
  const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
  const md = isImg ? `![${name}](${url})` : `[${name}](${url})`;
  const s = areaEl.selectionStart ?? areaEl.value.length;
  const e = areaEl.selectionEnd ?? areaEl.value.length;
  areaEl.value = areaEl.value.slice(0, s) + md + areaEl.value.slice(e);
  areaEl.selectionStart = areaEl.selectionEnd = s + md.length;
  areaEl.dispatchEvent(new Event('input', { bubbles: true }));
  areaEl.focus();
  try { if (areaEl.id === 'inlineArea') inlineUpdatePreview(); else updatePreview(); } catch {}
}
function initTreeShortcuts() {
  if (document._treeShortcuts) return;
  document._treeShortcuts = true;
  document.addEventListener('keydown', e => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    if (e.key === 'Escape' && state.selected.size) { clearTreeSelection(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected.size && canEditCurrentProject()) {
      e.preventDefault(); bulkDeleteSelected();
    }
  });
}
function initMarkdownDrop() {
  for (const id of ['inlineArea', 'editorArea']) {
    const area = document.getElementById(id);
    if (!area || area._mdDropBound) continue;
    area._mdDropBound = true;
    area.addEventListener('dragover', e => {
      const types = e.dataTransfer && e.dataTransfer.types || [];
      if ([...types].some(t => t === 'application/x-da-project-path' || t === 'text/plain')) {
        e.preventDefault(); area.classList.add('drop-target');
      }
    });
    area.addEventListener('dragleave', () => area.classList.remove('drop-target'));
    area.addEventListener('drop', e => {
      area.classList.remove('drop-target');
      const p = e.dataTransfer.getData('application/x-da-project-path') || e.dataTransfer.getData('text/plain');
      if (!p || p.includes('\n')) return;
      e.preventDefault();
      insertMarkdownForProjectPath(area, p);
    });
  }
}
function canEditCurrentProject() {
  const p = state.currentProject; if (!p) return false;
  if (state.user.role === 'admin') return true;
  return p.myRole === 'editor' || p.myRole === 'creator';
}
function renderNodes(nodes, container, depth) {
  const canEdit = canEditCurrentProject();
  for (const n of nodes) {
    if (n && n.generating) {
      // Служебная строка «Darcus генерирует…» — не файл: не кликается,
      // не открывается и не запрашивает несуществующий путь.
      const gen = document.createElement('div');
      gen.className = 'tree-row tree-generating';
      gen.style.paddingLeft = (8 + depth * 16) + 'px';
      gen.innerHTML = `<span class="arrow"></span><span class="icon">${icon('loader','sm spin')}</span><span class="name">${escapeHtml(n.name || 'Darcus генерирует…')}</span>`;
      container.appendChild(gen);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'tree-row' + (state.currentFile === n.path ? ' active' : '') + (state.selected.has(n.path) ? ' selected' : '');
    row.style.paddingLeft = (8 + depth * 16) + 'px';
    row.dataset.path = n.path; row.dataset.isDir = n.isDir ? '1' : '0';
    const isFav = !!(state.meta && state.meta.favorites && state.meta.favorites[n.path]);
    const tags = (state.meta && state.meta.tags && state.meta.tags[n.path]) || [];
    const tagHtml = tags.length ? `<span class="tag-chip">${escapeHtml(tags[0])}</span>` : '';
    if (n.isDir) {
      const expanded = state.expanded.has(n.path);
      row.innerHTML = `<span class="arrow">${expanded ? '▾' : '▸'}</span><span class="icon">${icon('folder','sm')}</span><span class="name">${escapeHtml(n.name)}</span>${isFav ? icon('star','sm') : ''}${tagHtml}`;
      row.onclick = e => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey || e.shiftKey) return handleTreeSelection(e, n);
        if (state.selected.size) clearTreeSelection();
        state.expanded.has(n.path) ? state.expanded.delete(n.path) : state.expanded.add(n.path); renderTree();
      };
      row.oncontextmenu = e => { e.preventDefault(); showCtxMenu(e.pageX, e.pageY, n, 'dir'); };
      if (canEdit) { row.draggable = true; row.dataset.draggable = '1'; }
      attachLongPress(row, (x, y) => showCtxMenu(x, y, n, 'dir'));
      container.appendChild(row);
      if (expanded) {
        const sub = document.createElement('div'); sub.className = 'tree-sub';
        renderNodes(n.children || [], sub, depth + 1);
        container.appendChild(sub);
      }
    } else {
      row.innerHTML = `<span class="arrow"></span><span class="icon">${fileIcon(n.name)}</span><span class="name">${escapeHtml(n.name)}</span>${isFav ? icon('star','sm') : ''}${tagHtml}`;
      // Файл можно перетащить в Markdown даже без прав редактирования (только ссылка).
      row.draggable = true; row.dataset.draggable = '1';
      row.onclick = e => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey || e.shiftKey) return handleTreeSelection(e, n);
        if (state.selected.size) clearTreeSelection();
        openFile(n.path);
      };
      row.oncontextmenu = e => { e.preventDefault(); showCtxMenu(e.pageX, e.pageY, n, 'file'); };
      attachLongPress(row, (x, y) => showCtxMenu(x, y, n, 'file'));
      container.appendChild(row);
    }
  }
}
function attachLongPress(el, cb) {
  let timer = null;
  el.addEventListener('touchstart', e => { const t = e.touches[0]; timer = setTimeout(() => cb(t.clientX, t.clientY), 500); }, { passive: true });
  el.addEventListener('touchend', () => clearTimeout(timer));
  el.addEventListener('touchmove', () => clearTimeout(timer));
  el.addEventListener('touchcancel', () => clearTimeout(timer));
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'md' || ext === 'markdown') return icon('file-text','sm');
  if (IMG_EXT.includes(ext)) return icon('image','sm');
  if (['doc','docx','rtf','odt'].includes(ext)) return icon('doc','sm');
  if (['xls','xlsx','ods','csv'].includes(ext)) return icon('sheet','sm');
  if (['ppt','pptx','odp'].includes(ext)) return icon('doc','sm');
  if (ext === 'pdf') return icon('pdf','sm');
  return icon('file','sm');
}

/* [NEW] Tags / favorites API */
async function toggleFavorite(path) {
  if (!state.projectId) return;
  try {
    const r = await fetch(`/api/projects/${state.projectId}/favorite`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path })
    });
    if (!r.ok) return;
    const d = await r.json();
    state.meta = state.meta || { tags: {}, favorites: {} };
    if (d.favorite) state.meta.favorites[path] = true; else delete state.meta.favorites[path];
    renderTree();
  } catch {}
}
async function setFileTags(path, tags) {
  if (!state.projectId) return;
  try {
    const r = await fetch(`/api/projects/${state.projectId}/tags`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, tags })
    });
    if (!r.ok) return;
    const d = await r.json();
    state.meta = state.meta || { tags: {}, favorites: {} };
    if (d.tags?.length) state.meta.tags[path] = d.tags; else delete state.meta.tags[path];
    renderTree();
  } catch {}
}

/* =========================================================
   Drag & Drop
   ========================================================= */
function initDragAndDrop() {
  const tree = document.getElementById('tree'); if (!tree) return;
  const emptyImg = new Image();
  emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  tree.addEventListener('dragstart', e => {
    const row = e.target.closest('.tree-row');
    if (!row || row.dataset.draggable !== '1') return;
    const path = row.dataset.path; if (!path) { e.preventDefault(); return; }
    const isFile = row.dataset.isDir === '0';
    const name = (row.querySelector('.name')?.textContent || path.split('/').pop()).trim();
    e.dataTransfer.setData('text/plain', path);
    e.dataTransfer.setData('application/x-da-project-path', path);
    e.dataTransfer.effectAllowed = 'copyMove';
    if (isFile) {
      try { const absUrl = new URL('/files/' + state.projectId + '/' + encodePath(path), location.origin).href; e.dataTransfer.setData('DownloadURL', `application/octet-stream:${name}:${absUrl}`); } catch {}
    }
    try { e.dataTransfer.setDragImage(emptyImg, 0, 0); } catch {}
    state.draggingPath = path; row.classList.add('dragging');
  });
  tree.addEventListener('dragend', () => {
    state.draggingPath = null;
    tree.querySelectorAll('.dragging, .drop-target').forEach(el => el.classList.remove('dragging', 'drop-target'));
  });
  tree.addEventListener('dragover', e => {
    const row = e.target.closest('.tree-row'); if (!row) return;
    e.preventDefault(); e.stopPropagation();
    const types = Array.from(e.dataTransfer.types || []);
    if (types.includes('Files') || types.includes('application/x-da-attach')) e.dataTransfer.dropEffect = 'copy';
    else if (types.includes('application/x-da-project-path') || types.includes('text/plain')) e.dataTransfer.dropEffect = 'move';
    else e.dataTransfer.dropEffect = 'copy';
    if (row.classList.contains('drop-target')) return;
    tree.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    row.classList.add('drop-target');
  });
  tree.addEventListener('dragleave', e => {
    const row = e.target.closest('.tree-row'); if (!row) return;
    const rel = e.relatedTarget; if (rel && row.contains(rel)) return;
    row.classList.remove('drop-target');
  });
  tree.addEventListener('drop', async e => {
    const row = e.target.closest('.tree-row'); if (!row) return;
    e.preventDefault(); e.stopPropagation();
    const targetIsDir = row.dataset.isDir === '1';
    let targetDir = row.dataset.path;
    if (!targetIsDir && targetDir) { const idx = targetDir.lastIndexOf('/'); targetDir = idx >= 0 ? targetDir.substring(0, idx) : ''; }
    tree.querySelectorAll('.dragging, .drop-target').forEach(el => el.classList.remove('dragging', 'drop-target'));
    if (e.dataTransfer.files && e.dataTransfer.files.length) { await uploadFilesFromDrop(Array.from(e.dataTransfer.files), targetDir); return; }
    let attachRaw = '';
    try { attachRaw = e.dataTransfer.getData('application/x-da-attach') || ''; } catch {}
    if (!attachRaw) { try { const tp = e.dataTransfer.getData('text/plain') || ''; if (tp.startsWith('DA_ATTACH:')) attachRaw = JSON.stringify({ id: tp.slice('DA_ATTACH:'.length) }); } catch {} }
    if (attachRaw) {
      try {
        const att = JSON.parse(attachRaw);
        if (att && att.id) {
          const r = await fetch(`/api/projects/${state.projectId}/attach-file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attachmentId: att.id, dir: targetDir }) });
          const d = await r.json();
          if (!r.ok) return dlA('Ошибка: ' + (d.error || r.statusText));
          showToast('Добавлено: ' + d.path);
          await loadTree();
        }
      } catch (err) { console.error(err); }
      return;
    }
    let src = '';
    try { src = e.dataTransfer.getData('application/x-da-project-path') || ''; } catch {}
    if (!src) try { src = e.dataTransfer.getData('text/plain') || ''; } catch {}
    if (!src) src = state.draggingPath || '';
    if (!src || !targetIsDir) return;
    const paths = (state.selected.size > 1 && state.selected.has(src)) ? [...state.selected] : [src];
    for (const p of paths) {
      const fname = p.split('/').pop();
      const to = targetDir ? (targetDir + '/' + fname) : fname;
      if (p === to) continue;
      if (targetDir === p || (targetDir && targetDir.startsWith(p + '/'))) continue;
      await moveItem(p, to);
    }
    if (paths.length > 1) clearTreeSelection();
  });
}
async function uploadFilesFromDrop(files, dir) {
  if (!state.projectId) return dlA('Проект не выбран');
  if (!canEditCurrentProject()) return dlA('Нет прав на загрузку');
  for (const f of files) {
    const fd = new FormData();
    fd.append('file', f); fd.append('dir', dir || ''); fd.append('projectId', state.projectId);
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!r.ok) { const d = await r.json().catch(()=>({})); dlA(`Не удалось загрузить «${f.name}»: ${d.error || r.statusText}`); }
    } catch (e) { dlA(`Сеть: ${e.message}`); }
  }
  if (dir) state.expanded.add(dir);
  await loadTree();
}

/* Чат drop targets */
function initChatDropTargets() {
  const targets = { general: document.getElementById('chatViewGeneral'), project: document.getElementById('chatViewProject'), ticket: document.getElementById('chatViewSupportChat') };
  for (const [key, view] of Object.entries(targets)) {
    if (!view) continue;
    view.addEventListener('dragover', e => {
      const types = Array.from(e.dataTransfer.types || []);
      const hasProjectFile = types.includes('application/x-da-project-path') || types.includes('text/plain');
      const hasInternalAttach = types.includes('application/x-da-attach');
      if (!hasProjectFile || hasInternalAttach) return;
      if (types.includes('Files')) return;
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy';
      view.classList.add('dragover-accept');
    });
    view.addEventListener('dragleave', e => { const rel = e.relatedTarget; if (rel && view.contains(rel)) return; view.classList.remove('dragover-accept'); });
    view.addEventListener('drop', async e => {
      view.classList.remove('dragover-accept');
      let path = '';
      try { path = e.dataTransfer.getData('application/x-da-project-path') || ''; } catch {}
      if (!path) try { path = e.dataTransfer.getData('text/plain') || ''; } catch {}
      if (!path || path.startsWith('DA_ATTACH:')) return;
      if (path.includes('\n') || path.length > 500) return;
      e.preventDefault(); e.stopPropagation();
      try {
        const url = '/files/' + state.projectId + '/' + encodePath(path);
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const name = path.split('/').pop();
        const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
        await uploadFileAsAttachment(key, file);
      } catch (err) { dlA('Не удалось прикрепить: ' + err.message); }
    });
  }
}
function initPasteUploads() {
  document.addEventListener('paste', async e => {
    if (!state.chatOpen) return;
    const target = e.target; if (!target) return;
    let key = null;
    if (target.id === 'chatInput') key = 'general';
    else if (target.id === 'projectChatInput') key = 'project';
    else if (target.id === 'ticketInput') key = 'ticket';
    else if (target.closest && target.closest('#chatPanel')) key = state.chatTab === 'support' ? 'ticket' : state.chatTab === 'project' ? 'project' : 'general';
    else return;
    const items = e.clipboardData && e.clipboardData.items; if (!items) return;
    const files = [];
    for (const item of items) if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push(f); }
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await uploadFileAsAttachment(key, f);
  });
}

/* Move modal */
const moveState = { source: null, target: null, expanded: new Set(), targetProjectId: null, tree: null };
function editableProjects() {
  return (state.projects || []).filter(p =>
    state.user.role === 'admin' || p.myRole === 'creator' || p.myRole === 'editor');
}
function openMoveModal(node) {
  moveState.source = node; moveState.target = null; moveState.expanded = new Set();
  moveState.targetProjectId = state.projectId;
  moveState.tree = state.tree;
  const sel = document.getElementById('moveProjectSelect');
  if (sel) {
    const projects = editableProjects();
    sel.innerHTML = projects.map(p =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.id === state.projectId ? ' (текущий)' : ''}</option>`
    ).join('') || `<option value="${escapeHtml(state.projectId)}">${escapeHtml(state.currentProject ? state.currentProject.name : '—')}</option>`;
    sel.value = state.projectId;
  }
  for (const n of (moveState.tree || [])) if (n.isDir) moveState.expanded.add(n.path);
  document.getElementById('moveSource').textContent = `Перемещаем: ${node.path || '(корень)'}`;
  renderMoveTree();
  document.getElementById('moveConfirmBtn').disabled = true;
  document.getElementById('moveModal').style.display = 'flex';
}
function filterForMove(nodes, exclude) {
  const out = [];
  for (const n of nodes) {
    if (!n.isDir) continue;
    if (exclude) { if (n.path === exclude) continue; if (n.path.startsWith(exclude + '/')) continue; }
    out.push({ ...n, children: filterForMove(n.children || [], exclude) });
  }
  return out;
}
function renderMoveTree() {
  const treeEl = document.getElementById('moveTree'); treeEl.innerHTML = '';
  const proj = (state.projects || []).find(p => p.id === moveState.targetProjectId);
  const rootName = proj ? proj.name : 'Корень';
  treeEl.appendChild(buildMoveRow({ name: rootName, path: '', isDir: true, children: [] }, 0, true));
  const exclude = moveState.targetProjectId === state.projectId ? (moveState.source?.path || '') : '';
  renderMoveNodes(filterForMove(moveState.tree || [], exclude), treeEl, 1);
}
function renderMoveNodes(nodes, container, depth) {
  for (const n of nodes) {
    container.appendChild(buildMoveRow(n, depth, false));
    if (moveState.expanded.has(n.path) && n.children?.length) renderMoveNodes(n.children, container, depth + 1);
  }
}
function buildMoveRow(node, depth, isRoot) {
  const row = document.createElement('div');
  row.className = 'move-row';
  row.style.paddingLeft = (10 + depth * 18) + 'px';
  row.dataset.path = node.path;
  if (moveState.target === node.path) row.classList.add('active');
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = moveState.expanded.has(node.path);
  row.innerHTML = `<span class="move-arrow${hasChildren ? '' : ' empty'}">${hasChildren ? (isExpanded ? '▾' : '▸') : ''}</span><span class="move-icon">${isRoot ? icon('home','sm') : icon('folder','sm')}</span><span class="move-name">${escapeHtml(node.name)}</span>`;
  const arrow = row.querySelector('.move-arrow');
  arrow.onclick = e => { e.stopPropagation(); if (!hasChildren) return; if (moveState.expanded.has(node.path)) moveState.expanded.delete(node.path); else moveState.expanded.add(node.path); renderMoveTree(); };
  row.onclick = () => { moveState.target = node.path; document.querySelectorAll('.move-row').forEach(r => r.classList.remove('active')); row.classList.add('active'); document.getElementById('moveConfirmBtn').disabled = false; };
  return row;
}
function initMove() {
  const modalEl = document.getElementById('moveModal');
  document.getElementById('moveCloseBtn').onclick =
  document.getElementById('moveCancelBtn').onclick = () => { modalEl.style.display = 'none'; moveState.source = null; };
  modalEl.addEventListener('click', e => { if (e.target === modalEl) { modalEl.style.display = 'none'; moveState.source = null; } });
  const sel = document.getElementById('moveProjectSelect');
  if (sel) sel.onchange = async () => {
    moveState.targetProjectId = sel.value;
    moveState.target = null;
    document.getElementById('moveConfirmBtn').disabled = true;
    if (sel.value === state.projectId) {
      moveState.tree = state.tree;
    } else {
      document.getElementById('moveTree').innerHTML = '<p class="hint">Загрузка…</p>';
      try {
        const r = await fetch('/api/tree?projectId=' + encodeURIComponent(sel.value));
        const d = await r.json().catch(() => ({}));
        moveState.tree = r.ok ? (d.tree || []) : [];
      } catch { moveState.tree = []; }
    }
    moveState.expanded = new Set();
    for (const n of (moveState.tree || [])) if (n.isDir) moveState.expanded.add(n.path);
    renderMoveTree();
  };
  document.getElementById('moveConfirmBtn').onclick = async () => {
    if (!moveState.source || moveState.target === null) return;
    const src = moveState.source.path;
    const fname = src.split('/').pop();
    const to = moveState.target ? (moveState.target + '/' + fname) : fname;
    if (to === src && moveState.targetProjectId === state.projectId) return;
    if (moveState.targetProjectId === state.projectId &&
        (moveState.target === src || (moveState.target && moveState.target.startsWith(src + '/')))) return;
    const ok = await moveItem(src, to, moveState.targetProjectId);
    if (!ok) return;
    modalEl.style.display = 'none'; moveState.source = null; moveState.target = null;
  };
}

/* Context menu */
function showCtxMenu(x, y, node, kind) {
  ctxMenu.innerHTML = '';
  ctxMenu.style.left = ''; ctxMenu.style.top = '';
  ctxMenu.style.display = 'block';
  if (!isMobile()) {
    const rect = ctxMenu.getBoundingClientRect();
    let left = x, top = y;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
    if (left < 8) left = 8; if (top < 8) top = 8;
    ctxMenu.style.left = left + 'px'; ctxMenu.style.top = top + 'px';
  }
  const canEdit = canEditCurrentProject();
  if (kind === 'root') {
    if (canEdit) {
      ctxMenu.appendChild(menuItem(icon('plus','sm')+' Новый файл', () => { state.currentFile = null; newFileBtn.click(); }));
      ctxMenu.appendChild(menuItem(icon('folder-plus','sm')+' Новая папка', () => { state.currentFile = null; newFolderBtn.click(); }));
      ctxMenu.appendChild(sep());
      ctxMenu.appendChild(menuItem(icon('upload','sm')+' Загрузить файл', () => { state.currentFile = null; uploadInput.click(); }));
    } else ctxMenu.appendChild(menuItem('— только просмотр —', () => {}, 'disabled'));
    return;
  }
  if (kind === 'file') {
    ctxMenu.appendChild(menuItem(icon('folder','sm')+' Открыть', () => openFile(node.path)));
    if (canEdit && node.path.toLowerCase().endsWith('.md')) ctxMenu.appendChild(menuItem(icon('edit','sm')+' Редактировать', () => openEditor(node.path)));
    ctxMenu.appendChild(menuItem(icon('download','sm')+' Скачать', () => window.open('/files/' + state.projectId + '/' + encodePath(node.path), '_blank')));
    ctxMenu.appendChild(menuItem(icon('link','sm')+' Поделиться…', () => openShareModal(node.path)));
    const isFav = !!(state.meta.favorites && state.meta.favorites[node.path]);
    ctxMenu.appendChild(menuItem(icon('star','sm') + (isFav ? ' Убрать из избранного' : ' В избранное'), () => toggleFavorite(node.path)));
    ctxMenu.appendChild(menuItem(icon('tag','sm')+' Теги…', () => openTagsModal(node.path)));
    ctxMenu.appendChild(sep());
    ctxMenu.appendChild(menuItem(icon('edit','sm')+' Запрос на изменение', () => { openFile(node.path); setTimeout(() => openRequestModal(), 100); }));
    ctxMenu.appendChild(menuItem(icon('warning','sm')+' Пожаловаться', () => openReportModal(node.path)));
    if (canEdit) {
      ctxMenu.appendChild(sep());
      ctxMenu.appendChild(menuItem(icon('folder','sm')+' Переместить в…', () => openMoveModal(node)));
      ctxMenu.appendChild(menuItem(icon('edit','sm')+' Переименовать', () => renameNode(node)));
      ctxMenu.appendChild(menuItem(icon('trash','sm')+' Удалить', () => deleteNode(node), 'danger'));
    }
    return;
  }
  ctxMenu.appendChild(menuItem(icon('folder','sm')+' Открыть', () => { state.expanded.add(node.path); renderTree(); }));
  if (canEdit) {
    ctxMenu.appendChild(menuItem(icon('plus','sm')+' Файл', () => { state.expanded.add(node.path); state.currentFile = node.path + '/__dummy__'; newFileBtn.click(); }));
    ctxMenu.appendChild(menuItem(icon('folder-plus','sm')+' Папка', () => { state.expanded.add(node.path); state.currentFile = node.path + '/__dummy__'; newFolderBtn.click(); }));
    ctxMenu.appendChild(sep());
    ctxMenu.appendChild(menuItem(icon('folder','sm')+' Переместить в…', () => openMoveModal(node)));
    ctxMenu.appendChild(menuItem(icon('edit','sm')+' Переименовать', () => renameNode(node)));
    ctxMenu.appendChild(menuItem(icon('trash','sm')+' Удалить', () => deleteNode(node), 'danger'));
  }
}
function menuItem(label, fn, cls = '') {
  const el = document.createElement('div');
  el.className = 'ctx-item ' + cls;
  el.innerHTML = label;
  el.onclick = e => { e.stopPropagation(); ctxMenu.style.display = 'none'; fn(); };
  return el;
}
function sep() { const el = document.createElement('div'); el.className = 'ctx-sep'; return el; }

/* [NEW] Tags modal */
async function openTagsModal(path) {
  const current = (state.meta.tags && state.meta.tags[path]) || [];
  const v = await dlP('Теги через запятую:', current.join(', '), 'Теги файла');
  if (v === null) return;
  const tags = String(v).split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
  await setFileTags(path, tags);
}

/* Attach context menu */
function showAttachCtxMenu(x, y, att) {
  ctxMenu.innerHTML = '';
  ctxMenu.style.left = ''; ctxMenu.style.top = '';
  ctxMenu.style.display = 'block';
  const dlItem = document.createElement('div');
  dlItem.className = 'ctx-item';
  dlItem.innerHTML = `${icon('download','sm')} Скачать`;
  dlItem.onclick = () => {
    ctxMenu.style.display = 'none';
    const a = document.createElement('a'); a.href = att.url; a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  };
  ctxMenu.appendChild(dlItem);
  if (state.projectId && canEditCurrentProject()) {
    const addItem = document.createElement('div');
    addItem.className = 'ctx-item';
    addItem.innerHTML = `${icon('folder-down','sm')} Добавить в текущий проект`;
    addItem.onclick = async () => {
      ctxMenu.style.display = 'none';
      const r = await fetch(`/api/projects/${state.projectId}/attach-file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attachmentId: att.id, dir: currentDir() }) });
      const d = await r.json();
      if (!r.ok) return dlA('Ошибка: ' + (d.error || r.statusText));
      showToast('Добавлено в проект: ' + d.path);
      await loadTree();
    };
    ctxMenu.appendChild(addItem);
  }
  if (!isMobile()) {
    const rect = ctxMenu.getBoundingClientRect();
    let left = x, top = y;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
    if (left < 8) left = 8; if (top < 8) top = 8;
    ctxMenu.style.left = left + 'px'; ctxMenu.style.top = top + 'px';
  } else {
    ctxMenu.style.left = '0'; ctxMenu.style.right = '0';
    ctxMenu.style.top = 'auto'; ctxMenu.style.bottom = '0'; ctxMenu.style.width = '100%';
  }
}

/* Punishment */
function showPunishMenu(x, y, username) {
  if (state.user.role !== 'admin') return;
  punishMenu.innerHTML = '';
  punishMenu.style.left = ''; punishMenu.style.top = '';
  punishMenu.style.display = 'block';
  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = `${icon('gavel','sm')} ${escapeHtml(username)}`;
  punishMenu.appendChild(title);
  punishMenu.appendChild(punishItem(icon('ban','sm')+' Забанить', () => openPunish('ban', username), 'danger'));
  punishMenu.appendChild(punishItem(icon('volume-x','sm')+' Замутить', () => openPunish('mute', username)));
  const sepEl = document.createElement('div'); sepEl.className = 'sep'; punishMenu.appendChild(sepEl);
  punishMenu.appendChild(punishItem(icon('check','sm')+' Снять бан', async () => { await clearPunishments(username, 'ban'); }, 'success'));
  punishMenu.appendChild(punishItem(icon('check','sm')+' Снять мут', async () => { await clearPunishments(username, 'mute'); }, 'success'));
  if (!isMobile()) {
    const rect = punishMenu.getBoundingClientRect();
    let left = x, top = y;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
    if (left < 8) left = 8; if (top < 8) top = 8;
    punishMenu.style.left = left + 'px'; punishMenu.style.top = top + 'px';
  } else {
    punishMenu.style.left = '0'; punishMenu.style.right = '0';
    punishMenu.style.top = 'auto'; punishMenu.style.bottom = '0'; punishMenu.style.width = '100%';
  }
}
function punishItem(label, fn, cls='') {
  const el = document.createElement('div');
  el.className = 'item ' + cls;
  el.innerHTML = label;
  el.onclick = e => { e.stopPropagation(); punishMenu.style.display = 'none'; fn(); };
  return el;
}
function openPunish(type, username) {
  const form = document.getElementById('punishForm');
  form.reset(); form.type.value = type; form.username.value = username;
  document.getElementById('punishTitle').innerHTML = `${icon(type === 'ban' ? 'ban' : 'volume-x','sm')} ${type === 'ban' ? 'Забанить' : 'Замутить'}`;
  document.getElementById('punishTarget').textContent = 'Пользователь: ' + username;
  const submit = document.getElementById('punishSubmit');
  submit.className = type === 'ban' ? 'danger-btn' : 'primary';
  submit.innerHTML = `${icon('gavel','sm')} Применить`;
  document.getElementById('punishModal').style.display = 'flex';
}
async function submitPunishment(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch('/api/punishments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    username: fd.get('username'), type: fd.get('type'), duration: fd.get('duration'), reason: fd.get('reason')
  }) });
  const d = await r.json();
  if (!r.ok) return dlA('Ошибка: ' + (d.error || r.statusText));
  document.getElementById('punishModal').style.display = 'none';
}
async function clearPunishments(username, type) {
  const r = await fetch('/api/punishments/' + encodeURIComponent(username));
  if (!r.ok) return;
  const data = await r.json();
  const active = (data.items || []).filter(p => p.type === type);
  for (const p of active) await fetch('/api/punishments/' + p.id, { method: 'DELETE' });
}

/* Rename / Delete / Move */
async function renameNode(node) {
  const name = await dlP(`Новое имя для «${node.name}»:`, node.name, 'Переименовать');
  if (!name || !name.trim() || name.trim() === node.name) return;
  const r = await fetch('/api/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: node.path, newName: name.trim(), projectId: state.projectId }) });
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) return dlA('Ошибка: ' + (data.error || r.statusText));
  if (state.currentFile === node.path) { state.currentFile = data.path; fileNameEl.textContent = data.path; }
  await loadTree();
}
async function deleteNode(node) {
  if (!(await dlC(`Удалить «${node.path}»?`))) return;
  const r = await fetch(`/api/delete?path=${encodeURIComponent(node.path)}&projectId=${encodeURIComponent(state.projectId)}`, { method: 'DELETE' });
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) return dlA('Ошибка: ' + (data.error || r.statusText));
  if (state.currentFile === node.path) resetViewer();
  await loadTree();
}
async function moveItem(from, to, targetProjectId) {
  if (!from || !to || (from === to && (!targetProjectId || targetProjectId === state.projectId))) return false;
  try {
    const body = { from, to, projectId: state.projectId };
    if (targetProjectId && targetProjectId !== state.projectId) body.targetProjectId = targetProjectId;
    const r = await fetch('/api/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data; try { data = await r.json(); } catch { data = {}; }
    if (!r.ok) { dlA('Не удалось переместить: ' + (data.error || r.statusText)); return false; }
    if (data.movedToProject) {
      showToast(`Перемещено в проект «${data.projectName}»`);
      if (state.currentFile === from) resetViewer();
    } else if (state.currentFile === from) {
      state.currentFile = data.path;
    }
    await loadTree();
    return true;
  } catch (e) { dlA('Ошибка сети: ' + e.message); return false; }
}

/* =========================================================
   Просмотр
   ========================================================= */
const encodePath = p => p.split('/').map(encodeURIComponent).join('/');
function fileUrl(p) { return '/files/' + state.projectId + '/' + encodePath(p); }

async function openFile(p) {
  // [FIX] Сохраняем содержимое предыдущего редактора в черновик (не закрываем сессию)
  if (state.inlineEditFile && state.inlineEditFile !== p) {
    const areaEl = document.getElementById('inlineArea');
    if (areaEl) {
      const key = state.projectId + '::' + state.inlineEditFile;
      state.drafts[key] = areaEl.value;
      state.openEditors[key] = true;
      _persistDrafts();
    }
    await leaveInlineEditorSilent();
  }
  state.currentFile = p;
  state.showChanges = false;
  changesBtn.classList.remove('active');
  renderTree();
  if (isMobile()) document.body.classList.remove('sidebar-open');
  const scrollArea = document.getElementById('scrollArea');
  if (scrollArea) scrollArea.scrollTop = 0;
  filebarEl.style.display = ''; fileNameEl.textContent = p;
  await renderFileContent();

  // [FIX] Если для этого файла есть черновик — открываем редактор с ним
  const key = state.projectId + '::' + p;
  if (state.openEditors[key]) {
    try { await openEditorForInline(p); } catch {}
  }
}

async function renderFileContent() {
  const p = state.currentFile; if (!p) return;
  // [FIX] чистим старую панель суммаризации
  document.querySelectorAll('#content .summary-panel').forEach(x => x.remove());

  // [FIX] управление видимостью кнопки «Кратко»
  const sumBtn = document.getElementById('summarizeBtn');
  if (sumBtn) {
    const SUMMARIZABLE = ['md','markdown','txt','docx','pdf','xlsx','xls','ods','pptx','ppt','odp','odt',
                          'js','json','ts','html','css','xml','csv','yml','yaml','log',
                          'png','jpg','jpeg','webp','bmp'];
    sumBtn.style.display = SUMMARIZABLE.includes(p.split('.').pop().toLowerCase()) ? '' : 'none';
  }
  contentEl.classList.remove('content-full');
  const ext = p.split('.').pop().toLowerCase();
  const url = fileUrl(p);
  const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
  const canEdit = EDITABLE.includes(ext) && canEditCurrentProject();
  editBtn.style.display = canEdit ? '' : 'none';
  editBtn.onclick = () => canEdit && openInlineEditor(p);

  /* ============================================================
     [FIX] Проверяем существование файла ДО рендера.
     Раньше при 404 сервер отдавал текст "not found", а markdown-
     рендер превращал его в <p>not found</p>. Теперь ловим честно.
     ============================================================ */
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) {
      if (head.status === 404) {
        contentEl.innerHTML =
          `<p class="err">Файл не найден: <b>${escapeHtml(p)}</b></p>` +
          `<p class="hint">Возможно, он был удалён или переименован. Обновите дерево.</p>`;
        state.currentFile = null;
        if (state.projectId) {
          delete state.lastFileByProject[state.projectId];
          try { localStorage.setItem('lastFileByProject', JSON.stringify(state.lastFileByProject)); } catch {}
        }
        if (filebarEl) filebarEl.style.display = 'none';
        showToast(`Файл «${p}» больше не существует — дерево обновлено`);
        await loadTree();
        return;
      }
      throw new Error(`HTTP ${head.status}`);
    }
  } catch (e) {
    contentEl.innerHTML = `<p class="err">Ошибка загрузки: ${escapeHtml(e.message)}</p>`;
    return;
  }

  try {
    if (IMG_EXT.includes(ext)) {
      contentEl.innerHTML = `<img src="${url}" alt="">`;
    } else if (ext === 'md' || ext === 'markdown') {
      let text = await (await fetch(url)).text();
      text = await preprocessMarkdown(text, dir);
      contentEl.innerHTML = sanitize(mdToHtml(text));
      wrapTables();
    } else if (EDITABLE.includes(ext)) {
      const text = await (await fetch(url)).text();
      contentEl.innerHTML = '';
      const pre = document.createElement('pre');
      pre.textContent = text;
      contentEl.appendChild(pre);
    } else if (PDF_EXT.includes(ext)) {
      contentEl.classList.add('content-full');
      contentEl.innerHTML = `<iframe class="pdf-frame" src="${url}"></iframe>`;
    } else if (DOCX_EXT.includes(ext)) {
      await renderDocx(url);
    } else if (XLSX_EXT.includes(ext)) {
      await renderXlsx(url);
    } else if (OFFICE_EXT.includes(ext)) {
      renderOfficeFallback(url);
    } else {
      contentEl.innerHTML =
        `<p>Предпросмотр недоступен. ` +
        `<a href="${url}" target="_blank" rel="noopener">Открыть файл</a></p>`;
    }
  } catch (e) {
    contentEl.innerHTML = `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`;
  }

  /* ---- OCR-обвязка для картинок: без изменений ---- */
  const ex2 = (p.split('.').pop() || '').toLowerCase();
  if (['png','jpg','jpeg','gif','webp','bmp','svg'].includes(ex2)) {
    setTimeout(() => {
      const img = document.querySelector('#content > img');
      if (img && !img.parentElement.classList.contains('ocr-wrap')) {
        const wrap = document.createElement('div'); wrap.className = 'ocr-wrap';
        img.parentNode.insertBefore(wrap, img);
        wrap.appendChild(img);
      }
      loadOcrInfo(p).then(renderOcrOverlay);
    }, 50);
  } else {
    const btn = document.getElementById('ocrToggleBtn');
    if (btn) btn.style.display = 'none';
    document.querySelectorAll('#content .ocr-panel').forEach(x => x.remove());
  }
}
function resetViewer() {
  state.currentFile = null; state.showChanges = false;
  filebarEl.style.display = 'none';
  contentEl.classList.remove('content-full');
  contentEl.innerHTML = '<p class="hint">Выберите файл слева</p>';
  renderTree();
}

/* Office */
async function renderDocx(url) {
  if (typeof mammoth === 'undefined') {
    try { await loadScriptOnce('vendor/mammoth.browser.min.js'); }
    catch (e) { contentEl.innerHTML = `<p class="err">Не удалось загрузить просмотрщик DOCX: ${escapeHtmlText(e.message)}</p>`; return; }
  }
  contentEl.classList.add('content-full');
  contentEl.innerHTML = `<div class="office-loading">${icon('loader','spin')} Загрузка DOCX…</div>`;
  const buf = await (await fetch(url)).arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  contentEl.innerHTML = `<div class="office-preview markdown-body">${sanitize(result.value)}</div>`;
  wrapTables();
}
async function renderXlsx(url) {
  if (typeof XLSX === 'undefined') {
    try { await loadScriptOnce('vendor/xlsx.full.min.js'); }
    catch (e) { contentEl.innerHTML = `<p class="err">Не удалось загрузить просмотрщик XLSX: ${escapeHtmlText(e.message)}</p>`; return; }
  }
  contentEl.classList.add('content-full');
  contentEl.innerHTML = `<div class="office-loading">${icon('loader','spin')} Загрузка XLSX…</div>`;
  const buf = await (await fetch(url)).arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const tabs = wb.SheetNames.map((name, i) => `<button class="sheet-tab ${i === 0 ? 'active' : ''}" data-i="${i}">${escapeHtml(name)}</button>`).join('');
  contentEl.innerHTML = `<div class="xlsx-tabs">${tabs}</div><div id="xlsx-body" class="xlsx-body"></div>`;
  const renderSheet = i => {
    const ws = wb.Sheets[wb.SheetNames[i]];
    const html = XLSX.utils.sheet_to_html(ws, { editable: false });
    // sheet_to_html НЕ экранирует значения ячеек в data-атрибутах: без sanitize
    // это stored XSS через загруженный .xlsx (payload выходит из data-v).
    document.getElementById('xlsx-body').innerHTML = `<div class="xlsx-wrap">${sanitize(html)}</div>`;
    contentEl.querySelectorAll('.sheet-tab').forEach(b => b.classList.toggle('active', +b.dataset.i === i));
  };
  contentEl.querySelectorAll('.sheet-tab').forEach(b => b.onclick = () => renderSheet(+b.dataset.i));
  renderSheet(0);
}
function renderOfficeFallback(url) {
  // Внешний view.officeapps.live.com отправлял внутренний URL файла на сторонний
  // сервис и в локальной сети всё равно не работал. Предлагаем скачать.
  contentEl.classList.add('content-full');
  contentEl.innerHTML = `<div class="office-fallback">
    <p>Предпросмотр этого формата недоступен.</p>
    <a class="btn primary" href="${encodeURI(url)}" download>Скачать файл</a>
  </div>`;
}

/* Markdown */
function wrapTables(root = contentEl) {
  root.querySelectorAll('table').forEach(t => {
    if (t.parentNode?.classList?.contains('table-wrap')) return;
    const wrap = document.createElement('div'); wrap.className = 'table-wrap';
    t.parentNode.insertBefore(wrap, t); wrap.appendChild(t);
  });
}
const resolveCache = new Map();
async function preprocessMarkdown(text, dir) {
  text = text.replace(/!\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]/g, (_, f, a) => `![${(a || f).trim()}](__WIKI__${f.trim()})`);
  const needed = new Set();
  const re = /!\[[^\]]*\]\(([^)]+)\)/g; let m;
  while ((m = re.exec(text))) {
    let src = m[1].trim();
    if (src.startsWith('http') || src.startsWith('data:') || src.startsWith('/')) continue;
    src = src.replace(/^__WIKI__/, '').split(/\s+"/)[0];
    needed.add(src);
  }
  const map = {};
  await Promise.all([...needed].map(async name => {
    const key = state.projectId + '::' + dir + '::' + name;
    if (resolveCache.has(key)) { map[name] = resolveCache.get(key); return; }
    try {
      const r = await fetch(`/api/resolve?projectId=${encodeURIComponent(state.projectId)}&from=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`);
      if (!r.ok) throw 0;
      const d = await r.json();
      const url = fileUrl(d.path); map[name] = url; resolveCache.set(key, url);
    } catch { map[name] = null; }
  }));
  return text.replace(/!\[([^\]]*)\]\((__WIKI__)?([^)]+)\)/g, (full, alt, _, src) => {
    src = src.trim();
    if (src.startsWith('http') || src.startsWith('data:') || src.startsWith('/')) return full;
    const key = src.split(/\s+"/)[0];
    if (map[key]) return `![${alt}](${map[key]})`;
    return `![${alt || key}]()`;
  });
}


/* =========================================================
   Редактор
   ========================================================= */
async function openEditor(p) {
  if (!p) return;
  if (state.editingFile && state.editingFile !== p) {
    if (!(await dlC(`У вас открыт редактор «${state.editingFile}».\nЗакрыть его (без сохранения) и открыть «${p}»?`))) return;
    await leaveEditorSession();
  }
  try {
    const r = await fetch('/api/edit/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: p, projectId: state.projectId }) });
    if (!r.ok) { let d; try { d = await r.json(); } catch {} return dlA('Не удалось открыть: ' + ((d && d.error) || r.statusText)); }
    const { content, users } = await r.json();
    area.value = content; state.editingFile = p; state.editUsers = users || [];
    if (area._resetInfPad)   area._resetInfPad();
  } catch (e) { return dlA('Ошибка: ' + e.message); }
  // [NEW] Сброс бесконечного скролла для нового файла
  if (area._resetInfPad) area._resetInfPad();
  document.getElementById('editorTitle').textContent = 'Редактор: ' + p;
  modal.style.display = 'flex';
  updateEditorUsersUI();
  await updatePreview();
  area.focus();
}
async function leaveEditorSession() {
  if (!state.editingFile) return;
  const file = state.editingFile; state.editingFile = null; state.editUsers = [];
  try { await fetch('/api/edit/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, projectId: state.projectId }) }); } catch {}
  updateEditorUsersUI();
}
function updateEditorUsersUI() {
  const el = document.getElementById('editorUsers'); if (!el) return;
  const others = (state.editUsers || []).filter(u => u !== state.user.username);
  if (!others.length) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = ''; el.innerHTML = icon('users','sm') + ' ' + escapeHtml(others.join(', '));
}
let previewTimer = null;
area.addEventListener('input', () => {
  clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 300);
  if (!state.editingFile || state.applyingRemote) return;
  clearTimeout(state.editorChangeTimer);
  state.editorChangeTimer = setTimeout(sendEditorChange, 200);
});
async function sendEditorChange() {
  if (!state.editingFile) return;
  try { await fetch('/api/edit/change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: state.editingFile, content: area.value, projectId: state.projectId }) }); } catch {}
}
document.getElementById('previewToggle').onclick = () => {
  state.editorPreviewVisible = !state.editorPreviewVisible;
  document.querySelector('.editor-body').classList.toggle('no-preview', !state.editorPreviewVisible);
  document.querySelector('.editor-body').classList.toggle('has-preview', state.editorPreviewVisible);
};
document.querySelectorAll('.editor-toolbar button[data-md]').forEach(b => b.onclick = () => insertMd(b.dataset.md));
/* Вставка изображений/файлов в Markdown: выбор файла → загрузка в проект →
   готовая Markdown-ссылка на /files/<project>/<path>. */
function mdDirForFile() {
  const f = state.inlineEditFile || state.editingFile || state.currentFile || '';
  return f.includes('/') ? f.substring(0, f.lastIndexOf('/')) : '';
}
function pickFilesForMd(accept) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    if (accept) inp.accept = accept;
    inp.onchange = () => resolve([...(inp.files || [])]);
    inp.click();
  });
}
async function uploadMdFiles(files) {
  const dir = mdDirForFile();
  const lines = [];
  for (const f of files) {
    const fd = new FormData();
    fd.append('file', f); fd.append('dir', dir); fd.append('projectId', state.projectId);
    let r, d = {};
    try {
      r = await fetch('/api/upload', { method: 'POST', body: fd });
      d = await r.json().catch(() => ({}));
    } catch (e) { showToast('Не удалось загрузить «' + f.name + '»: ' + e.message); continue; }
    if (!r.ok) { showToast('Не удалось загрузить «' + f.name + '»: ' + (d.error || r.statusText)); continue; }
    const url = '/files/' + encodeURIComponent(state.projectId) + '/' +
      d.path.split('/').map(encodeURIComponent).join('/');
    const isImg = (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name);
    lines.push(isImg ? `![${f.name}](${url})` : `[${f.name}](${url})`);
  }
  if (lines.length) { try { await loadTree(); } catch {} }
  return lines.join('\n');
}

async function insertMd(type) {
  const start = area.selectionStart, end = area.selectionEnd;  const val = area.value, sel = val.substring(start, end);
  const before = val.substring(0, start), after = val.substring(end);
  let insert = '';
  const block = t => '\n\n' + t + '\n\n';
  switch (type) {
    case 'h1': insert = block('# '   + (sel || 'Заголовок 1')); break;
    case 'h2': insert = block('## '  + (sel || 'Заголовок 2')); break;
    case 'h3': insert = block('### ' + (sel || 'Заголовок 3')); break;
    case 'bold': insert = '**' + (sel || 'жирный') + '**'; break;
    case 'italic': insert = '*' + (sel || 'курсив') + '*'; break;
    case 'strike': insert = '~~' + (sel || 'зачёркнутый') + '~~'; break;
    case 'code': insert = '`' + (sel || 'код') + '`'; break;
    case 'ul': insert = block((sel || 'пункт').split('\n').map(l => '- ' + l).join('\n')); break;
    case 'ol': insert = block((sel || 'пункт').split('\n').map((l, i) => (i+1) + '. ' + l).join('\n')); break;
    case 'quote': insert = block((sel || 'цитата').split('\n').map(l => '> ' + l).join('\n')); break;
    case 'link': { const url = await dlP('URL:', 'https://', 'Ссылка'); if (!url) return; insert = `[${sel || 'текст'}](${url})`; break; }
    case 'image': {
      const files = await pickFilesForMd('image/*');
      if (!files.length) return;
      const md = await uploadMdFiles(files);
      insert = md ? '\n\n' + md + '\n\n' : '';
      break;
    }
    case 'attach': {
      const files = await pickFilesForMd();
      if (!files.length) return;
      const md = await uploadMdFiles(files);
      insert = md ? '\n\n' + md + '\n\n' : '';
      break;
    }
    case 'hr': insert = '\n\n---\n\n'; break;
    case 'codeblock': insert = '\n\n```\n' + (sel || 'код') + '\n```\n\n'; break;
    case 'table': {
      const cols = parseInt(await dlP('Столбцов:', '3', 'Таблица'), 10);
      if (!cols || cols < 1 || cols > 20) return;
      const rows = parseInt(await dlP('Строк:', '2', 'Таблица'), 10);
      if (isNaN(rows) || rows < 0 || rows > 50) return;
      const header = '| ' + Array.from({length: cols}, (_, i) => `Столбец ${i+1}`).join(' | ') + ' |';
      const sepRow = '|' + Array.from({length: cols}, () => '---').join('|') + '|';
      const body = Array.from({length: rows}, () => '| ' + Array.from({length: cols}, () => '  ').join(' | ') + ' |').join('\n');
      insert = '\n\n' + header + '\n' + sepRow + (body ? '\n' + body : '') + '\n\n'; break;
    }
  }
  area.value = before + insert + after; area.focus();
  area.selectionStart = area.selectionEnd = start + insert.length;
  updatePreview();
}
async function updatePreview() {
  if (!state.editorPreviewVisible) return;
  const text = area.value || '';
  let processed = text;
  if (state.currentFile) {
    const dir = state.currentFile.includes('/') ? state.currentFile.substring(0, state.currentFile.lastIndexOf('/')) : '';
    try { processed = await preprocessMarkdown(text, dir); } catch {}
  }
  try {
    previewEl.innerHTML = sanitize(mdToHtml(processed));
    wrapTables(previewEl);
    previewEl.querySelectorAll('img').forEach(img => { img.onerror = () => { img.classList.add('img-broken'); img.alt = 'Не найдено: ' + (img.alt || ''); }; });
  } catch (e) { previewEl.innerHTML = `<p class="err">Ошибка предпросмотра: ${escapeHtml(e.message)}</p>`; }
}
document.getElementById('cancelBtn').onclick = async () => {
  const hadFile = state.editingFile;
  await leaveEditorSession();
  modal.style.display = 'none';
  if (hadFile) { await loadTree(); if (state.currentFile === hadFile) await openFile(hadFile); }
};
document.getElementById('saveBtn').onclick = async () => {
  if (!state.editingFile) return;
  const file = state.editingFile; const content = area.value;
  const r = await fetch('/api/edit/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, content, projectId: state.projectId }) });
  if (!r.ok) { let d; try { d = await r.json(); } catch {} return dlA('Ошибка сохранения: ' + ((d && d.error) || r.statusText)); }
  state.editingFile = null; state.editUsers = [];
  updateEditorUsersUI(); modal.style.display = 'none';
  await loadTree();
  if (state.currentFile === file) await openFile(file);
};
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (modal.style.display !== 'none') document.getElementById('cancelBtn').click();
    // Закрываем все остальные модалки/оверлеи, включая динамические
    // (корзина, шары, палитра команд, контекстные меню, lightbox).
    document.querySelectorAll('.modal, .lightbox, .ctx-menu, .punish-menu').forEach(el => {
      if (el.style.display && el.style.display !== 'none') el.style.display = 'none';
    });
    document.body.classList.remove('sidebar-open');
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault(); document.getElementById('searchBtn').click();
  }
});
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey; if (!mod) return;
  if (e.key.toLowerCase() === 'k') { e.preventDefault(); openCommandPalette(); return; }
  if (e.key.toLowerCase() === 'b') { e.preventDefault(); document.body.classList.toggle('sidebar-open'); return; }
  if (e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (modal.style.display !== 'none') document.getElementById('saveBtn').click();
    else if (state.inlineEditFile) saveInlineEditor();
    return;
  }
});

/* Command palette */
let cmdPaletteEl = null;
function commandList() {
  const cmds = [
    { label: 'Поиск по файлам', icon: 'search', run: () => document.getElementById('searchBtn').click() },
    { label: 'Новый файл', icon: 'plus', run: () => newFileBtn.click() },
    { label: 'Новая папка', icon: 'folder-plus', run: () => newFolderBtn.click() },
    { label: 'Загрузить файл', icon: 'upload', run: () => uploadInput.click() },
    { label: 'Переключить сайдбар', icon: 'menu', run: () => document.body.classList.toggle('sidebar-open') },
    { label: 'Корзина', icon: 'trash', run: () => openTrashModal() },
    { label: 'Переключить тему', icon: 'sun', run: () => toggleTheme() },
    { label: 'Выйти', icon: 'logout', run: () => document.getElementById('logoutBtn')?.click() },
    { label: 'Кратко о файле (AI)', icon: 'sparkles', run: () => doSummarize() },
  ];
  if (state.user?.role === 'admin') cmds.push({ label: 'Админ-панель', icon: 'shield', run: () => location.href = '/admin.html' });
  return cmds;
}
function ensureCommandPalette() {
  if (cmdPaletteEl) return cmdPaletteEl;
  const el = document.createElement('div');
  el.className = 'modal'; el.style.display = 'none';
  el.innerHTML = `<div class="modal-inner small-modal" style="max-width:480px"><div class="modal-head"><span>${icon('search','sm')} Команды</span><button type="button" data-close>${icon('x')}</button></div><div class="simple-form"><input id="cmdPaletteInput" placeholder="Начните вводить команду…" autocomplete="off"><div id="cmdPaletteList" style="max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:2px"></div></div></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) el.style.display = 'none'; });
  cmdPaletteEl = el; return el;
}
function openCommandPalette() {
  const el = ensureCommandPalette();
  el.style.display = 'flex';
  const input = el.querySelector('#cmdPaletteInput');
  const listEl = el.querySelector('#cmdPaletteList');
  input.value = '';
  function render(filter = '') {
    const f = filter.trim().toLowerCase();
    const items = commandList().filter(c => c.label.toLowerCase().includes(f));
    listEl.innerHTML = '';
    if (!items.length) { listEl.innerHTML = '<p class="hint">Ничего не найдено</p>'; return; }
    for (const c of items) {
      const row = document.createElement('div');
      row.className = 'ctx-item'; row.style.cursor = 'pointer';
      row.innerHTML = `${icon(c.icon, 'sm')} ${escapeHtml(c.label)}`;
      row.onclick = () => { el.style.display = 'none'; c.run(); };
      listEl.appendChild(row);
    }
  }
  input.oninput = () => render(input.value);
  input.onkeydown = ev => { if (ev.key === 'Escape') el.style.display = 'none'; };
  render(); setTimeout(() => input.focus(), 30);
}

/* =========================================================
   Создание файла/папки, upload
   ========================================================= */
function currentDir() {
  if (!state.currentFile) return '';
  return state.currentFile.includes('/') ? state.currentFile.substring(0, state.currentFile.lastIndexOf('/')) : '';
}
newFileBtn.onclick = async () => {
  const name = await dlP('Имя нового файла (.md):', 'Новый файл.md', 'Новый файл');
  if (!name || !name.trim()) return;
  const dir = currentDir();
  const r = await fetch('/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir, name: name.trim(), projectId: state.projectId }) });
  let data; try { data = await r.json(); } catch {}
  if (!r.ok) return dlA('Ошибка: ' + ((data && data.error) || r.statusText));
  if (dir) state.expanded.add(dir);
  await loadTree();
  await openFile(data.path);
};
newFolderBtn.onclick = async () => {
  const name = await dlP('Имя новой папки:', 'Новая папка', 'Новая папка');
  if (!name || !name.trim()) return;
  const dir = currentDir();
  const r = await fetch('/api/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir, name: name.trim(), projectId: state.projectId }) });
  let data; try { data = await r.json(); } catch {}
  if (!r.ok) return dlA('Ошибка: ' + ((data && data.error) || r.statusText));
  if (dir) state.expanded.add(dir);
  state.expanded.add(data.path);
  await loadTree();
};
uploadBtn.onclick = () => uploadInput.click();
async function uploadFilesToRoot(files) {
  if (!state.projectId) return;
  let last = null;
  for (const f of files) {
    const fd = new FormData(); fd.append('file', f); fd.append('dir', ''); fd.append('projectId', state.projectId);
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showToast(`«${f.name}»: ${d.error || r.statusText}`); continue; }
      last = d.path;
    } catch (e) { showToast(`«${f.name}»: ${e.message}`); }
  }
  await loadTree();
  if (last) try { await openFile(last); } catch {}
}
uploadInput.onchange = async () => {
  const f = uploadInput.files[0]; if (!f) return;
  try {
    const s = await (await fetch('/api/settings')).json();
    if (s.uploadLimitMB !== null && s.uploadLimitMB !== undefined) {
      const limitBytes = s.uploadLimitMB * 1024 * 1024;
      if (f.size > limitBytes) {
        const sizeMB = (f.size / 1024 / 1024).toFixed(1);
        dlA(`Файл «${f.name}» размером ${sizeMB} МБ превышает лимит ${s.uploadLimitMB} МБ.`);
        uploadInput.value = ''; return;
      }
    }
  } catch {}
  const dir = currentDir();
  const fd = new FormData(); fd.append('file', f); fd.append('dir', dir); fd.append('projectId', state.projectId);
  uploadBtn.disabled = true;
  const old = uploadBtn.innerHTML;
  uploadBtn.innerHTML = `${icon('loader','sm spin')}…`;
  try {
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    let data; try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error((data && data.error) || `Ошибка сервера (${r.status})`);
    if (dir) state.expanded.add(dir);
    await loadTree(); await openFile(data.path);
  } catch (e) { dlA('Не удалось загрузить файл:\n' + e.message); }
  finally { uploadInput.value = ''; uploadBtn.disabled = false; uploadBtn.innerHTML = old; }
};

/* =========================================================
   ЧАТ
   ========================================================= */
function initChat() {
  document.getElementById('chatBtn').onclick = () => toggleChat(true);
  document.getElementById('chatPanelClose').onclick = () => toggleChat(false);
  document.querySelectorAll('.chat-tab').forEach(t => t.onclick = () => openChatTab(t.dataset.tab));

  chatForm.onsubmit = async e => {
    e.preventDefault();
    if (chatForm._sending) return;
    const text = chatInput.value.trim();
    const atts = state.pendingAttachments.general.slice();
    if (!text && !atts.length) return;
    chatForm._sending = true;
    try {
      const r = await fetch('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, attachments: atts }) });
      if (!r.ok) {
        const d = await r.json().catch(()=>({}));
        if (d.error === 'chat-disabled') return dlA('Общий чат отключён администрацией');
        if (d.error === 'muted') return dlA('Вы заглушены и не можете писать в общий чат');
        return showToast('Не отправлено: ' + (d.error || r.statusText));
      }
      // Очищаем только после успешной отправки — иначе при ошибке сети
      // пользователь терял набранный текст и уже приложенные файлы.
      chatInput.value = ''; resetTextarea(chatInput); clearPendingAttachments('general');
    } catch { showToast('Не отправлено: ошибка сети. Текст сохранён.'); }
    finally { chatForm._sending = false; }
  };
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatForm.requestSubmit(); } });
  autoGrow(chatInput);

  const projForm = document.getElementById('projectChatForm');
  const projInput = document.getElementById('projectChatInput');
  projForm.onsubmit = async e => {
    e.preventDefault();
    if (!state.projectId || projForm._sending) return;
    const text = projInput.value.trim();
    const atts = state.pendingAttachments.project.slice();
    if (!text && !atts.length) return;
    projForm._sending = true;
    try {
      const r = await fetch(`/api/chat/project/${state.projectId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, attachments: atts }) });
      if (!r.ok) { const d = await r.json().catch(()=>({})); return showToast('Не отправлено: ' + (d.error || r.statusText)); }
      projInput.value = ''; resetTextarea(projInput); clearPendingAttachments('project');
    } catch { showToast('Не отправлено: ошибка сети. Текст сохранён.'); }
    finally { projForm._sending = false; }
  };
  projInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); projForm.requestSubmit(); } });
  autoGrow(projInput);

  document.getElementById('newTicketBtn').onclick = () => openNewTicketModal();
  document.getElementById('ticketBackBtn').onclick = () => { state.currentTicketId = null; renderChatTabView(); };
  ticketForm.onsubmit = async e => {
    e.preventDefault();
    if (ticketForm._sending) return;
    const text = ticketInput.value.trim();
    const atts = state.pendingAttachments.ticket.slice();
    if ((!text && !atts.length) || !state.currentTicketId) return;
    ticketForm._sending = true;
    try {
      const r = await fetch('/api/tickets/' + state.currentTicketId + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, attachments: atts }) });
      if (!r.ok) { const d = await r.json().catch(()=>({})); return showToast('Не отправлено: ' + (d.error || r.statusText)); }
      ticketInput.value = ''; resetTextarea(ticketInput); clearPendingAttachments('ticket');
    } catch { showToast('Не отправлено: ошибка сети. Текст сохранён.'); }
    finally { ticketForm._sending = false; }
  };
  ticketInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ticketForm.requestSubmit(); } });
  autoGrow(ticketInput);

  document.getElementById('addTaskForm').onsubmit = async e => {
    e.preventDefault();
    const inp = document.getElementById('newTaskInput');
    const text = inp.value.trim();
    if (!text || !state.projectId) return;
    inp.value = '';
    await createTask(text, 'todo');
  };
  const tasksToggleBtn = document.getElementById('toggleTasksBtn');
  if (tasksToggleBtn) tasksToggleBtn.onclick = () => document.querySelector('.project-tasks-block').classList.toggle('collapsed');
  const tasksBoardBtn = document.getElementById('tasksBoardBtn');
  if (tasksBoardBtn) tasksBoardBtn.onclick = openTasksBoard;

  document.querySelectorAll('.attach-btn').forEach(btn => {
    btn.onclick = () => { const key = btn.dataset.attach; document.querySelector(`.attach-input[data-attach-input="${key}"]`).click(); };
  });
  document.querySelectorAll('.attach-input').forEach(inp => {
    inp.onchange = () => uploadAttachFromInput(inp.dataset.attachInput, inp.files[0]);
  });

  const ntm = document.getElementById('newTicketModal');
  document.getElementById('newTicketCloseBtn').onclick =
  document.getElementById('newTicketCancelBtn').onclick = () => ntm.style.display = 'none';
  document.getElementById('newTicketForm').onsubmit = async e => {
    e.preventDefault();
    const text = new FormData(e.target).get('text');
    const r = await fetch('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    let d; try { d = await r.json(); } catch {}
    if (!r.ok) {
      if (r.status === 409 && d.ticketId) {
        ntm.style.display = 'none'; e.target.reset();
        await loadTickets(); openChatTab('support'); toggleChat(true); openTicket(d.ticketId); return;
      }
      return showToast('Ошибка: ' + ((d && d.error) || r.statusText));
    }
    ntm.style.display = 'none'; e.target.reset();
    await loadTickets(); openChatTab('support'); toggleChat(true); openTicket(d.ticket.id);
  };
}

/* Вложения */
async function uploadFileAsAttachment(key, file) {
  if (!file) return;
  const MAX = 25 * 1024 * 1024;
  if (file.size > MAX) return dlA('Файл больше 25 МБ');
  const fd = new FormData(); fd.append('file', file);
  // Контекст вложения: сервер проверит доступ по нему (IDOR-защита).
  let scope = 'general';
  if (key === 'project' && state.projectId) scope = 'project:' + state.projectId;
  else if (key === 'ticket' && state.currentTicketId) scope = 'ticket:' + state.currentTicketId;
  fd.append('scope', scope);
  try {
    const r = await fetch('/api/chat/attach', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok) return dlA('Ошибка: ' + (d.error || r.statusText));
    state.pendingAttachments[key] = state.pendingAttachments[key] || [];
    state.pendingAttachments[key].push({ id: d.id, name: d.name, size: d.size, kind: d.kind, mime: d.mime, url: d.url });
    renderPendingAttachments(key);
  } catch (e) { dlA('Ошибка сети: ' + e.message); }
}
async function uploadAttachFromInput(key, file) {
  if (!file) return;
  await uploadFileAsAttachment(key, file);
  const inp = document.querySelector(`.attach-input[data-attach-input="${key}"]`);
  if (inp) inp.value = '';
}
function renderPendingAttachments(key) {
  const form = { general: chatForm, project: document.getElementById('projectChatForm'), ticket: ticketForm }[key];
  if (!form) return;
  let prev = form.parentNode.querySelector('.attach-preview');
  const atts = state.pendingAttachments[key] || [];
  if (!atts.length) { if (prev) prev.remove(); return; }
  if (!prev) { prev = document.createElement('div'); prev.className = 'attach-preview'; form.parentNode.insertBefore(prev, form); }
  prev.innerHTML = atts.map(a => `<span>${icon('paperclip','sm')} ${escapeHtml(a.name)}</span>`).join('') + `<button type="button" title="Очистить">${icon('x','sm')}</button>`;
  prev.querySelector('button').onclick = () => { state.pendingAttachments[key] = []; renderPendingAttachments(key); };
}
function clearPendingAttachments(key) { state.pendingAttachments[key] = []; renderPendingAttachments(key); }
function openNewTicketModal() {
  const modalEl = document.getElementById('newTicketModal');
  const form = document.getElementById('newTicketForm');
  if (!modalEl || !form) return;
  form.reset(); modalEl.style.display = 'flex';
  const ta = form.querySelector('textarea'); if (ta) ta.focus();
}

function autoGrow(el) {
  if (!el || el._autoGrowBound) return;
  el._autoGrowBound = true;
  el.addEventListener('input', () => autoGrowResize(el));
}
function autoGrowResize(el) {
  if (!el) return;
  const MIN = 38, MAX = 200;
  el.style.height = 'auto';
  const sh = el.scrollHeight;
  const target = Math.max(MIN, Math.min(sh, MAX));
  el.style.height = target + 'px';
  el.style.overflowY = sh > MAX ? 'auto' : 'hidden';
}
function resetTextarea(el) {
  if (!el) return;
  el.style.height = ''; el.style.overflowY = '';
  requestAnimationFrame(() => autoGrowResize(el));
}

function toggleChat(open) {
  state.chatOpen = open;
  chatPanel.classList.toggle('open', open);
  if (open) {
    if (state.chatTab === 'general') { unread.chat = 0; loadGeneralMessages(); }
    else if (state.chatTab === 'support') { unread.tickets = 0; loadTickets().then(renderChatTabView); }
    else if (state.chatTab === 'project') { unread.project = 0; loadProjectChat(); }
    updateChatBadge();
  }
}
function openChatTab(tab) {
  state.chatTab = tab;
  document.querySelectorAll('.chat-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  if (tab === 'general') { unread.chat = 0; loadGeneralMessages(); }
  else if (tab === 'support') { unread.tickets = 0; loadTickets().then(() => renderChatTabView()); }
  else if (tab === 'project') { unread.project = 0; loadProjectChat(); }
  else if (tab === 'darcus') { if (typeof loadSubscription === 'function') loadSubscription().then(() => refreshDarcusView()); }
  updateChatBadge(); renderChatTabView();
}
function renderChatTabView() {
  for (const id of ['chatViewGeneral','chatViewProject','chatViewSupportList','chatViewSupportChat','chatViewDarcus']) {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  }
  if (state.chatTab === 'general') document.getElementById('chatViewGeneral').style.display = '';
  else if (state.chatTab === 'project') document.getElementById('chatViewProject').style.display = '';
  else if (state.chatTab === 'support') {
    if (state.currentTicketId) {
      document.getElementById('chatViewSupportChat').style.display = '';
      renderTicketMessages(); renderTicketActions();
      const t = state.tickets.find(x => x.id === state.currentTicketId);
      if (t) {
        ticketChatTitle.textContent = state.user.role === 'admin' ? `${t.from} · ${t.subject || 'Обращение'}` : (t.subject || 'Обращение');
        const statusMap = { open: 'Открыт', in_progress: 'В работе', closed: 'Закрыт' };
        ticketChatStatus.textContent = statusMap[t.status] || '';
        ticketChatStatus.className = 'ticket-status ' + t.status;
      }
    } else { document.getElementById('chatViewSupportList').style.display = ''; renderTicketList(); }
  } else if (state.chatTab === 'darcus') {
    document.getElementById('chatViewDarcus').style.display = '';
    if (typeof refreshDarcusView === 'function') refreshDarcusView();
  }
}
async function loadGeneralMessages() {
  if (!chatMsgBox) return;
  try {
    const r = await fetch('/api/chat/general');
    const { messages } = await r.json();
    state.chatCache.general = messages; renderGeneralMessages();
  } catch { chatMsgBox.innerHTML = '<div class="chat-empty">Ошибка загрузки</div>'; }
}
function renderGeneralMessages() {
  const msgs = state.chatCache.general || [];
  chatMsgBox.innerHTML = '';
  if (!msgs.length) { chatMsgBox.innerHTML = '<div class="chat-empty">Пока нет сообщений. Напишите первым!</div>'; return; }
  let lastDate = '';
  for (const m of msgs) {
    const d = new Date(m.timestamp).toDateString();
    if (d !== lastDate) { lastDate = d; chatMsgBox.appendChild(buildDateSep(m.timestamp)); }
    chatMsgBox.appendChild(buildMsgEl(m, 'general'));
  }
  chatMsgBox.scrollTop = chatMsgBox.scrollHeight;
}
function handleIncomingChat(m) {
  if (!state.chatCache.general) state.chatCache.general = [];
  if (!state.chatCache.general.some(x => x.id === m.id)) state.chatCache.general.push(m);
  const active = state.chatOpen && state.chatTab === 'general';
  if (active) {
    const empty = chatMsgBox.querySelector('.chat-empty'); if (empty) empty.remove();
    if (!chatMsgBox.querySelector(`[data-id="${m.id}"]`)) { chatMsgBox.appendChild(buildMsgEl(m, 'general')); chatMsgBox.scrollTop = chatMsgBox.scrollHeight; }
  } else if (m.from !== state.user.username) { unread.chat++; updateChatBadge(); }
}
function buildDateSep(ts) {
  const el = document.createElement('div'); el.className = 'chat-date-sep';
  const d = new Date(ts);
  const today = new Date(); const yest = new Date(); yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === today.toDateString()) el.textContent = 'Сегодня';
  else if (d.toDateString() === yest.toDateString()) el.textContent = 'Вчера';
  else el.textContent = d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' });
  return el;
}
function buildMsgEl(m, ctx = 'general') {
  const el = document.createElement('div');
  const mine = m.from === state.user.username;
  el.className = 'chat-msg' + (mine ? ' mine' : '') + (m.role === 'system' ? ' system' : '');
  el.dataset.id = m.id;
  if (m.role === 'system') { el.innerHTML = `<div class="sys-text">${escapeHtml(m.text)}</div>`; return el; }
  const time = new Date(m.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  let name = m.from;
  if (ctx === 'ticket' && m.role === 'support') name = 'Поддержка';
  const canPunish = state.user.role === 'admin' && !mine;
  const meta = mine ? '' : `<span class="meta">${escapeHtml(name)}${canPunish ? ` <button class="punish-btn punish-btn-inline" data-punish="${escapeHtml(m.from)}" title="Наказать">${icon('gavel','sm')}</button>` : ''}</span>`;

  let attHtml = '';
  if (Array.isArray(m.attachments) && m.attachments.length) {
    attHtml = '<div class="attachments">';
    for (const a of m.attachments) {
      if (a.kind === 'image') {
        attHtml += `<div class="attach-thumb" draggable="true" data-open="${escapeHtml(a.url)}" data-att-id="${escapeHtml(a.id)}" data-att-name="${escapeHtml(a.name)}" data-att-url="${escapeHtml(a.url)}" data-att-mime="${escapeHtml(a.mime || 'image/*')}"><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name)}" draggable="false"></div>`;
      } else {
        attHtml += `<div class="attach-card" draggable="true" data-att-id="${escapeHtml(a.id)}" data-att-name="${escapeHtml(a.name)}" data-att-url="${escapeHtml(a.url)}" data-att-mime="${escapeHtml(a.mime || 'application/octet-stream')}" data-att-kind="file"><div class="row">${icon('file','sm')}<span class="fname">${escapeHtml(a.name)}</span><span class="fsize">${formatBytes(a.size)}</span></div><div class="hint" style="font-size:10.5px;opacity:.7">ПКМ — меню</div></div>`;
      }
    }
    attHtml += '</div>';
  }

  el.innerHTML = `
    ${meta}
    <div class="bubble">
      ${m.text ? `<span class="text">${escapeHtml(m.text)}</span>` : ''}
      <span class="time">${time}${mine ? ' ✓' : ''}</span>
      ${attHtml}
      <div class="msg-actions">
        ${m.text ? `<button type="button" class="msg-copy-btn" title="Скопировать"><svg class="ico sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` : ''}
        ${m.text ? `<button type="button" class="msg-tts-btn" title="Озвучить" data-tts-id="${escapeHtml(m.id)}"><svg class="ico sm"><use href="#i-volume"/></svg></button>` : ''}
        ${m.text ? `<button type="button" class="msg-tts-btn" title="Скопировать в чат" data-send-ai="${escapeHtml(m.id)}" style="display:none"></button>` : ''}
        ${(mine && (ctx === 'general' || ctx === 'project')) ? `<button type="button" class="msg-del-btn" title="Удалить" data-del="${escapeHtml(m.id)}" data-ctx="${escapeHtml(ctx)}">${icon('trash','sm')}</button>` : ''}
        ${(!mine && state.user.role === 'admin' && (ctx === 'general' || ctx === 'project')) ? `<button type="button" class="msg-del-btn" title="Удалить (админ)" data-del="${escapeHtml(m.id)}" data-ctx="${escapeHtml(ctx)}">${icon('trash','sm')}</button>` : ''}
      </div>
    </div>`;

  const copyBtn = el.querySelector('.msg-copy-btn');
  if (copyBtn) copyBtn.onclick = ev => {
    ev.stopPropagation();
    navigator.clipboard.writeText(m.text).then(() => showToast('Сообщение скопировано')).catch(() => showToast('Не удалось скопировать'));
  };
  const ttsBtn = el.querySelector('.msg-tts-btn[data-tts-id]');
  if (ttsBtn) ttsBtn.onclick = ev => {
    ev.stopPropagation();
    toggleSpeakMessage(m.id, m.text, ttsBtn);
  };

  const delBtn = el.querySelector('.msg-del-btn');
  if (delBtn) delBtn.onclick = async ev => {
    ev.stopPropagation();
    if (!(await dlC('Удалить это сообщение?'))) return;
    const ctx = delBtn.dataset.ctx || 'general';
    try {
      const url = ctx === 'project'
        ? `/api/chat/project/${encodeURIComponent(state.projectId)}/message/${encodeURIComponent(m.id)}`
        : `/api/chat/message/${encodeURIComponent(m.id)}`;
      const r = await fetch(url, { method: 'DELETE' });
      if (!r.ok) {
        let d = {}; try { d = await r.json(); } catch {}
        return showToast('Не удалось удалить: ' + (d.error || r.statusText));
      }
      if (ctx === 'project') {
        state.projectMessages = (state.projectMessages || []).filter(x => x.id !== m.id);
        renderProjectMessages();
      } else {
        state.chatCache.general = (state.chatCache.general || []).filter(x => x.id !== m.id);
        renderGeneralMessages();
      }
    } catch (e) { showToast('Ошибка сети: ' + e.message); }
  };
  const pb = el.querySelector('[data-punish]');
  if (pb) pb.onclick = ev => { ev.stopPropagation(); showPunishMenu(ev.clientX, ev.clientY, pb.dataset.punish); };

  el.querySelectorAll('.attach-thumb').forEach(t => {
    t.addEventListener('click', () => { if (t.dataset.justDragged === '1') { t.dataset.justDragged = '0'; return; } openLightbox(t.dataset.open); });
    t.addEventListener('contextmenu', ev => { ev.preventDefault(); showAttachCtxMenu(ev.clientX, ev.clientY, { id: t.dataset.attId, name: t.dataset.attName, url: t.dataset.attUrl }); });
    t.addEventListener('dragstart', ev => {
      ev.dataTransfer.effectAllowed = 'copyMove';
      try { ev.dataTransfer.setData('application/x-da-attach', JSON.stringify({ id: t.dataset.attId, name: t.dataset.attName })); } catch {}
      try { ev.dataTransfer.setData('text/plain', 'DA_ATTACH:' + t.dataset.attId); } catch {}
      try { const absUrl = new URL(t.dataset.attUrl, location.origin).href; ev.dataTransfer.setData('DownloadURL', `${t.dataset.attMime || 'image/*'}:${t.dataset.attName}:${absUrl}`); ev.dataTransfer.setData('text/uri-list', absUrl); } catch {}
      t.classList.add('dragging');
    });
    t.addEventListener('dragend', () => { t.classList.remove('dragging'); t.dataset.justDragged = '1'; setTimeout(() => { t.dataset.justDragged = '0'; }, 50); });
  });
  el.querySelectorAll('.attach-card').forEach(c => {
    c.querySelectorAll('*').forEach(ch => ch.setAttribute('draggable', 'false'));
    c.addEventListener('contextmenu', ev => { ev.preventDefault(); showAttachCtxMenu(ev.clientX, ev.clientY, { id: c.dataset.attId, name: c.dataset.attName, url: c.dataset.attUrl }); });
    c.addEventListener('dragstart', ev => {
      ev.dataTransfer.effectAllowed = 'copyMove';
      try { ev.dataTransfer.setData('application/x-da-attach', JSON.stringify({ id: c.dataset.attId, name: c.dataset.attName })); } catch {}
      try { ev.dataTransfer.setData('text/plain', 'DA_ATTACH:' + c.dataset.attId); } catch {}
      try { const absUrl = new URL(c.dataset.attUrl, location.origin).href; ev.dataTransfer.setData('DownloadURL', `${c.dataset.attMime || 'application/octet-stream'}:${c.dataset.attName}:${absUrl}`); } catch {}
      c.classList.add('dragging');
    });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
  });
  return el;
}
function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + ' Б';
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' КБ';
  return (n/1024/1024).toFixed(2) + ' МБ';
}

/* Project chat + tasks */
async function loadProjectChat() {
  if (!state.projectId) return;
  const box = document.getElementById('projectMessages');
  box.innerHTML = '<div class="chat-empty">Загрузка…</div>';
  try {
    const r = await fetch(`/api/chat/project/${encodeURIComponent(state.projectId)}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    state.projectMessages = data.messages || [];
    state.projectTasks = data.tasks || [];
    renderProjectTasks(); renderProjectMessages();
  } catch (e) { box.innerHTML = `<div class="chat-empty">Ошибка: ${escapeHtml(e.message)}</div>`; }
}
const TASK_COLS = [
  { key: 'todo', label: 'К выполнению' },
  { key: 'doing', label: 'В работе' },
  { key: 'done', label: 'Готово' },
];

function taskStatus(t) { return t.status || (t.done ? 'done' : 'todo'); }
function taskStatusLabel(s) { return ({ todo: 'к выполнению', doing: 'в работе', done: 'готово' })[s] || s; }

async function patchTask(id, body) {
  const r = await fetch(`/api/projects/${state.projectId}/tasks/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) { let d; try { d = await r.json(); } catch {} ; showToast('Задача не обновлена: ' + ((d && d.error) || r.statusText)); return null; }
  const { task } = await r.json();
  const i = state.projectTasks.findIndex(x => x.id === task.id);
  if (i >= 0) state.projectTasks[i] = task;
  return task;
}
async function createTask(text, status = 'todo', assignee = null) {
  const r = await fetch(`/api/projects/${state.projectId}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, status, assignee }),
  });
  if (!r.ok) { let d; try { d = await r.json(); } catch {} ; showToast('Задача не создана: ' + ((d && d.error) || r.statusText)); return null; }
  const { task } = await r.json();
  if (!state.projectTasks.some(t => t.id === task.id)) state.projectTasks.push(task);
  renderProjectTasks();
  return task;
}
async function deleteTask(id) {
  if (!(await dlC('Удалить задачу?'))) return;
  const r = await fetch(`/api/projects/${state.projectId}/tasks/${id}`, { method: 'DELETE' });
  if (!r.ok) return showToast('Не удалось удалить задачу');
  state.projectTasks = state.projectTasks.filter(x => x.id !== id);
  renderProjectTasks();
}
async function moveTaskTo(id, status) {
  const column = (state.projectTasks || []).filter(t => taskStatus(t) === status && t.id !== id);
  const order = column.reduce((m, t) => Math.max(m, Number(t.order) || 0), -1) + 1;
  const task = await patchTask(id, { status, order });
  if (task) renderProjectTasks();
}
async function editTask(t) {
  const text = await dlP('Текст задачи:', t.text, 'Редактировать задачу');
  if (text == null) return;
  const assignee = await dlP('Исполнитель (логин или пусто):', t.assignee || '', 'Исполнитель');
  if (assignee == null) return;
  const task = await patchTask(t.id, { text: text.trim() || t.text, assignee: assignee.trim() || null });
  if (task) renderProjectTasks();
}

let tasksBoardEl = null;
function ensureTasksBoardModal() {
  if (tasksBoardEl) return tasksBoardEl;
  const el = document.createElement('div');
  el.className = 'modal';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="modal-inner tasks-board-inner">
      <div class="modal-head">
        <span>${icon('layers','sm')} Доска задач · <span id="tasksBoardProject"></span></span>
        <button type="button" data-close title="Закрыть">${icon('x')}</button>
      </div>
      <div id="tasksBoardColumns" class="tasks-board-columns"></div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) el.style.display = 'none'; });
  tasksBoardEl = el;
  return el;
}
function openTasksBoard() {
  if (!state.projectId) return;
  const el = ensureTasksBoardModal();
  const nameEl = el.querySelector('#tasksBoardProject');
  if (nameEl) nameEl.textContent = state.currentProject ? state.currentProject.name : '';
  el.style.display = 'flex';
  renderProjectKanban();
}
function renderProjectKanban() {
  const box = document.getElementById('tasksBoardColumns');
  if (!box) return;
  box.innerHTML = '';
  const tasks = state.projectTasks || [];
  for (const col of TASK_COLS) {
    const colTasks = tasks.filter(t => taskStatus(t) === col.key)
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const colEl = document.createElement('div');
    colEl.className = 'kanban-col';
    colEl.dataset.status = col.key;
    colEl.innerHTML = `
      <div class="kanban-col-head">
        <span>${col.label}</span><b>${colTasks.length}</b>
        <button type="button" class="kanban-add" title="Добавить задачу">${icon('plus','sm')}</button>
      </div>
      <div class="kanban-cards"></div>`;
    const cards = colEl.querySelector('.kanban-cards');
    for (const t of colTasks) cards.appendChild(buildKanbanCard(t));
    if (!colTasks.length) {
      const empty = document.createElement('div');
      empty.className = 'kanban-empty';
      empty.textContent = 'Перетащите задачу сюда или нажмите +';
      cards.appendChild(empty);
    }
    colEl.addEventListener('dragover', e => { e.preventDefault(); colEl.classList.add('drag-over'); });
    colEl.addEventListener('dragleave', e => { if (!colEl.contains(e.relatedTarget)) colEl.classList.remove('drag-over'); });
    colEl.addEventListener('drop', async e => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (id) await moveTaskTo(id, col.key);
    });
    colEl.querySelector('.kanban-add').onclick = async () => {
      const text = await dlP('Новая задача:', '', 'Задача');
      if (text && text.trim()) await createTask(text.trim(), col.key);
    };
    box.appendChild(colEl);
  }
}

function buildKanbanCard(t) {
  const el = document.createElement('div');
  el.className = 'kanban-card' + (taskStatus(t) === 'done' ? ' done' : '');
  el.draggable = true;
  el.dataset.id = t.id;
  const canDel = state.user.role === 'admin' || (state.currentProject && state.currentProject.creator === state.user.username) || t.createdBy === state.user.username;
  el.innerHTML = `
    <div class="kanban-card-text">${escapeHtml(t.text)}</div>
    <div class="kanban-card-meta">
      ${t.assignee ? `<span class="kanban-assignee">${icon('user','sm')} ${escapeHtml(t.assignee)}</span>` : ''}
      <span class="kanban-created">${escapeHtml(t.createdBy || '')}</span>
      <span class="kanban-actions">
        <button type="button" data-act="edit" title="Редактировать">${icon('edit','sm')}</button>
        ${canDel ? `<button type="button" data-act="del" title="Удалить">${icon('trash-2','sm')}</button>` : ''}
      </span>
    </div>`;
  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', t.id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.querySelector('[data-act="edit"]').onclick = e => { e.stopPropagation(); editTask(t); };
  const del = el.querySelector('[data-act="del"]');
  if (del) del.onclick = e => { e.stopPropagation(); deleteTask(t.id); };
  el.addEventListener('dblclick', () => editTask(t));
  return el;
}

function renderProjectTasks() {
  // Канбан живёт в отдельной модалке; если она открыта — обновляем и её.
  if (tasksBoardEl && tasksBoardEl.style.display !== 'none') renderProjectKanban();
  const list = document.getElementById('projectTasksList');
  if (!list) return;
  const tasks = state.projectTasks || [];
  list.style.display = '';
  list.innerHTML = '';
  if (!tasks.length) { list.innerHTML = '<div class="chat-empty" style="padding:6px 0;margin:0;font-size:12px">Задач пока нет</div>'; return; }
  for (const t of tasks) {
    const el = document.createElement('div');
    const status = taskStatus(t);
    el.className = 'task-item' + (status === 'done' ? ' done' : '');
    const canDel = state.user.role === 'admin' || (state.currentProject && state.currentProject.creator === state.user.username) || t.createdBy === state.user.username;
    el.innerHTML = `<button class="task-toggle" title="${status === 'done' ? 'Вернуть' : 'Готово'}">${status === 'done' ? icon('check-square','sm') : icon('square','sm')}</button><div class="task-body"><div class="task-text">${escapeHtml(t.text)}</div><div class="task-meta">${t.assignee ? icon('user','sm') + ' ' + escapeHtml(t.assignee) + ' · ' : ''}${escapeHtml(taskStatusLabel(status))} · ${escapeHtml(t.createdBy || '')} · ${new Date(t.createdAt).toLocaleString('ru-RU')}${status === 'done' ? ` · ${icon('check','sm')}` : ''}</div></div>${canDel ? `<button class="task-del" title="Удалить">${icon('trash-2','sm')}</button>` : ''}`;
    el.querySelector('.task-toggle').onclick = async () => {
      const task = await patchTask(t.id, { done: status !== 'done' });
      if (task) renderProjectTasks();
    };
    const delBtn = el.querySelector('.task-del');
    if (delBtn) delBtn.onclick = () => deleteTask(t.id);
    list.appendChild(el);
  }
}
function renderProjectMessages() {
  const box = document.getElementById('projectMessages'); if (!box) return;
  box.innerHTML = '';
  const msgs = state.projectMessages || [];
  if (!msgs.length) { box.innerHTML = '<div class="chat-empty">Пока нет сообщений</div>'; return; }
  let lastDate = '';
  for (const m of msgs) {
    const d = new Date(m.timestamp).toDateString();
    if (d !== lastDate) { lastDate = d; box.appendChild(buildDateSep(m.timestamp)); }
    box.appendChild(buildMsgEl(m, 'project'));
  }
  box.scrollTop = box.scrollHeight;
}

/* Tickets */
async function loadTickets() {
  try {
    const r = await fetch('/api/tickets');
    const { tickets } = await r.json();
    state.tickets = tickets || [];
    for (const t of state.tickets) if (!state.ticketCache[t.id]) state.ticketCache[t.id] = t.messages || [];
    if (state.chatTab === 'support' && !state.currentTicketId) renderTicketList();
  } catch {}
}
function renderTicketList() {
  const list = state.tickets;
  ticketListEl.innerHTML = '';
  if (!list.length) { ticketListEl.innerHTML = '<div class="chat-empty">Обращений пока нет</div>'; return; }
  for (const t of list) {
    const el = document.createElement('div');
    el.className = 'ticket-item' + (t.id === state.currentTicketId ? ' active' : '');
    el.dataset.id = t.id;
    const last = (state.ticketCache[t.id] || t.messages || []).slice(-1)[0];
    const preview = last ? last.text : '—';
    const time = new Date(t.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const statusLabel = { open: 'Открыт', in_progress: 'В работе', closed: 'Закрыт' }[t.status] || '';
    const title = state.user.role === 'admin' ? `${t.from} · ${t.subject || ''}` : (t.subject || 'Обращение');
    el.innerHTML = `<div class="ticket-item-head"><div class="ticket-item-title">${escapeHtml(title)}</div><div class="ticket-item-time">${time}</div></div><div class="ticket-item-preview">${escapeHtml(preview).slice(0, 100)}</div><div class="ticket-item-status ${t.status}">${statusLabel}</div>`;
    el.onclick = () => openTicket(t.id);
    ticketListEl.appendChild(el);
  }
}
async function openTicket(id) {
  state.currentTicketId = id;
  renderChatTabView();
  try {
    const r = await fetch('/api/tickets/' + id);
    if (!r.ok) throw new Error('not found');
    const { ticket } = await r.json();
    state.ticketCache[id] = ticket.messages || [];
    renderTicketMessages(); renderTicketActions(ticket);
    ticketChatTitle.textContent = state.user.role === 'admin' ? `${ticket.from} · ${ticket.subject || 'Обращение'}` : (ticket.subject || 'Обращение');
    const statusMap = { open: 'Открыт', in_progress: 'В работе', closed: 'Закрыт' };
    ticketChatStatus.textContent = statusMap[ticket.status] || '';
    ticketChatStatus.className = 'ticket-status ' + ticket.status;
    const idx = state.tickets.findIndex(x => x.id === id); if (idx >= 0) state.tickets[idx] = ticket;
  } catch (e) { ticketMessagesEl.innerHTML = `<div class="chat-empty">Ошибка: ${escapeHtml(e.message)}</div>`; }
}
function renderTicketMessages() {
  const msgs = state.ticketCache[state.currentTicketId] || [];
  ticketMessagesEl.innerHTML = '';
  if (!msgs.length) { ticketMessagesEl.innerHTML = '<div class="chat-empty">Сообщений нет</div>'; return; }
  let lastDate = '';
  for (const m of msgs) {
    const d = new Date(m.timestamp).toDateString();
    if (d !== lastDate) { lastDate = d; ticketMessagesEl.appendChild(buildDateSep(m.timestamp)); }
    ticketMessagesEl.appendChild(buildMsgEl(m, 'ticket'));
  }
  ticketMessagesEl.scrollTop = ticketMessagesEl.scrollHeight;
}
function renderTicketActions(ticket) {
  ticketChatActions.innerHTML = '';
  if (!ticket) ticket = state.tickets.find(x => x.id === state.currentTicketId);
  if (!ticket) return;
  if (state.user.role === 'admin') {
    if (ticket.status === 'open') {
      const b = document.createElement('button');
      b.className = 'primary';
      b.innerHTML = icon('check','sm') + ' Принять в работу';
      b.onclick = async () => { const r = await fetch('/api/tickets/' + ticket.id + '/accept', { method: 'POST' }); if (!r.ok) return; await openTicket(ticket.id); await loadTickets(); };
      ticketChatActions.appendChild(b);
    }
    if (ticket.status !== 'closed') {
      const b = document.createElement('button');
      b.className = 'danger-btn';
      b.innerHTML = icon('lock','sm') + ' Закрыть тикет';
      b.onclick = async () => {
        if (!(await dlC('Закрыть тикет?'))) return;
        const r = await fetch('/api/tickets/' + ticket.id + '/close', { method: 'POST' });
        if (!r.ok) return;
        await openTicket(ticket.id); await loadTickets();
      };
      ticketChatActions.appendChild(b);
    }
  }
  if (ticket.status === 'closed') ticketForm.style.display = 'none';
  else ticketForm.style.display = '';
}

/* Requests / reports / inbox */
function initRequests() {
  const modalEl = document.getElementById('requestModal');
  const close   = document.getElementById('requestCloseBtn');
  const cancel  = document.getElementById('requestCancelBtn');
  const form    = document.getElementById('requestForm');
  document.getElementById('requestFileBtn').onclick = () => { if (!state.currentFile) return; openRequestModal(); };
  close.onclick = cancel.onclick = () => modalEl.style.display = 'none';
  modalEl.addEventListener('click', e => { if (e.target === modalEl) modalEl.style.display = 'none'; });
  form.onsubmit = async e => {
    e.preventDefault();
    const text = new FormData(form).get('text');
    if (!state.currentFile) return;
    const r = await fetch('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, file: state.currentFile, projectId: state.projectId }) });
    let d; try { d = await r.json(); } catch {}
    if (!r.ok) return dlA('Ошибка: ' + ((d && d.error) || r.statusText));
    modalEl.style.display = 'none';
  };
}
function openRequestModal() {
  if (!state.currentFile) return;
  document.getElementById('requestFileLabel').textContent = state.currentFile;
  const form = document.getElementById('requestForm');
  form.reset();
  document.getElementById('requestModal').style.display = 'flex';
  form.querySelector('textarea').focus();
}
function initReports() {
  const modalEl = document.getElementById('reportModal');
  const close   = document.getElementById('reportCloseBtn');
  const cancel  = document.getElementById('reportCancelBtn');
  const form    = document.getElementById('reportForm');
  const reportFileBtn = document.getElementById('reportFileBtn');

  if (reportFileBtn) {
    reportFileBtn.onclick = () => {
      if (!state.currentFile) return;
      openReportModal(state.currentFile);
    };
  }
  if (close) close.onclick = () => { if (modalEl) modalEl.style.display = 'none'; };
  if (cancel) cancel.onclick = () => { if (modalEl) modalEl.style.display = 'none'; };
  if (modalEl) modalEl.addEventListener('click', e => {
    if (e.target === modalEl) modalEl.style.display = 'none';
  });
  if (form) form.onsubmit = async e => {
    e.preventDefault();
    const reason = new FormData(form).get('reason');
    // Путь берём из модалки: жалоба из контекстного меню могла относиться
    // к другому файлу, чем открыт в просмотрщике.
    const file = state.reportFilePath || state.currentFile || '';
    const r = await fetch('/api/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, file, projectId: state.projectId })
    });
    let d; try { d = await r.json(); } catch {}
    if (!r.ok) return dlA('Ошибка: ' + ((d && d.error) || r.statusText));
    if (modalEl) modalEl.style.display = 'none';
  };
}

/* Trash */
let trashModalEl = null;
function ensureTrashModal() {
  if (trashModalEl) return trashModalEl;
  const el = document.createElement('div');
  el.className = 'modal'; el.style.display = 'none';
  el.innerHTML = `<div class="modal-inner small-modal"><div class="modal-head"><span>${icon('trash','sm')} Корзина</span><button type="button" data-close>${icon('x')}</button></div><div class="simple-form"><p class="hint" id="trashRetentionHint" style="margin-top:0">Файлы хранятся ограниченное время.</p><div id="trashList" style="display:flex;flex-direction:column;gap:8px;max-height:400px;overflow:auto"></div></div></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) el.style.display = 'none'; });
  trashModalEl = el; return el;
}
async function openTrashModal() {
  if (!state.projectId) return;
  const el = ensureTrashModal();
  el.style.display = 'flex'; await refreshTrash();
}
async function refreshTrash() {
  const el = ensureTrashModal();
  const listEl = el.querySelector('#trashList');
  listEl.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const r = await fetch('/api/trash?projectId=' + encodeURIComponent(state.projectId));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const { items, retentionDays } = await r.json();
    el.querySelector('#trashRetentionHint').textContent = `Файлы удаляются безвозвратно через ${retentionDays} дн. после перемещения в корзину.`;
    if (!items.length) { listEl.innerHTML = '<p class="hint">Корзина пуста</p>'; return; }
    listEl.innerHTML = '';
    for (const it of items.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt))) listEl.appendChild(buildTrashRow(it));
  } catch (e) { listEl.innerHTML = `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`; }
}
function buildTrashRow(it) {
  const row = document.createElement('div');
  row.className = 'inbox-item';
  const when = new Date(it.deletedAt).toLocaleString('ru-RU');
  row.innerHTML = `<div class="file-line">${it.isDir ? icon('folder','sm') : icon('file','sm')}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(it.originalPath)}</span></div><div class="head" style="margin-bottom:0">Удалил(а) ${escapeHtml(it.deletedBy)} · ${escapeHtml(when)}</div><div class="actions"><button type="button" data-act="restore">${icon('refresh','sm')} Восстановить</button><button type="button" data-act="purge" class="danger-btn">${icon('trash-2','sm')} Удалить навсегда</button></div>`;
  row.querySelector('[data-act="restore"]').onclick = async () => {
    const r = await fetch('/api/trash/' + it.id + '/restore', { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (r.ok) { showToast('Восстановлено'); await refreshTrash(); await loadTree(); }
    else showToast('Ошибка: ' + (data.error || r.statusText));
  };
  row.querySelector('[data-act="purge"]').onclick = async () => {
    if (!(await dlC(`Удалить «${it.originalPath}» навсегда? Это необратимо.`))) return;
    const r = await fetch('/api/trash/' + it.id, { method: 'DELETE' });
    if (r.ok) { showToast('Удалено навсегда'); await refreshTrash(); }
    else showToast('Не удалось удалить');
  };
  return row;
}


/* Share */
let shareModalEl = null;
function ensureShareModal() {
  if (shareModalEl) return shareModalEl;
  const el = document.createElement('div');
  el.className = 'modal'; el.style.display = 'none';
  el.innerHTML = `<div class="modal-inner small-modal"><div class="modal-head"><span>${icon('link','sm')} Поделиться файлом</span><button type="button" data-close>${icon('x')}</button></div><div class="simple-form"><p class="hint" style="margin:0">Файл: <b id="shareFileLabel">—</b></p><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><select id="shareExpirySelect" style="flex:1;min-width:140px"><option value="1">Истекает через 1 день</option><option value="7" selected>Истекает через 7 дней</option><option value="30">Истекает через 30 дней</option><option value="0">Без ограничения срока</option></select><div class="form-actions" style="margin:0"><button type="button" id="shareCreateBtn" class="primary">${icon('link','sm')} Создать ссылку</button></div></div><div id="shareList" style="display:flex;flex-direction:column;gap:8px;max-height:300px;overflow:auto"></div></div></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) el.style.display = 'none'; });
  shareModalEl = el; return el;
}
async function openShareModal(filePath) {
  const el = ensureShareModal();
  el.querySelector('#shareFileLabel').textContent = filePath;
  el.style.display = 'flex';
  const listEl = el.querySelector('#shareList');
  const createBtn = el.querySelector('#shareCreateBtn');
  const expirySelect = el.querySelector('#shareExpirySelect');
  async function refresh() {
    listEl.innerHTML = '<p class="hint">Загрузка…</p>';
    try {
      const r = await fetch('/api/shares');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const { items } = await r.json();
      const forFile = items.filter(it => it.projectId === state.projectId && it.path === filePath && !it.revoked);
      if (!forFile.length) { listEl.innerHTML = '<p class="hint">Активных ссылок нет</p>'; return; }
      listEl.innerHTML = '';
      for (const s of forFile) listEl.appendChild(buildShareRow(s, refresh));
    } catch (e) { listEl.innerHTML = `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`; }
  }
  createBtn.onclick = async () => {
    createBtn.disabled = true;
    try {
      const r = await fetch('/api/shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: state.projectId, path: filePath, expiresInDays: parseInt(expirySelect.value, 10) }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Ошибка создания ссылки');
      await navigator.clipboard.writeText(location.origin + data.url).catch(() => {});
      showToast('Ссылка создана и скопирована в буфер обмена');
      await refresh();
    } catch (e) { showToast('Ошибка: ' + e.message); }
    finally { createBtn.disabled = false; }
  };
  await refresh();
}
function buildShareRow(s, onChange) {
  const row = document.createElement('div');
  row.className = 'inbox-item';
  const fullUrl = location.origin + '/s/' + s.token;
  const expires = s.expiresAt ? new Date(s.expiresAt).toLocaleString('ru-RU') : 'бессрочно';
  row.innerHTML = `<div class="file-line" style="justify-content:space-between"><code style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${escapeHtml(fullUrl)}</code></div><div class="head" style="margin-bottom:0">До: ${escapeHtml(expires)} · Открытий: ${s.accessCount || 0}</div><div class="actions"><button type="button" data-act="copy">${icon('link','sm')} Копировать</button><button type="button" data-act="revoke" class="danger-btn">${icon('trash','sm')} Отозвать</button></div>`;
  row.querySelector('[data-act="copy"]').onclick = () => navigator.clipboard.writeText(fullUrl).then(() => showToast('Скопировано')).catch(() => {});
  row.querySelector('[data-act="revoke"]').onclick = async () => {
    if (!(await dlC('Отозвать эту ссылку? Она перестанет работать.'))) return;
    const r = await fetch('/api/shares/' + s.id, { method: 'DELETE' });
    if (r.ok) { showToast('Ссылка отозвана'); onChange(); }
    else showToast('Не удалось отозвать ссылку');
  };
  return row;
}
function openReportModal(filePath) {
  const path = filePath || state.currentFile || '';
  state.reportFilePath = path;
  document.getElementById('reportFileLabel').textContent = path || '—';
  const form = document.getElementById('reportForm');
  form.reset();
  document.getElementById('reportModal').style.display = 'flex';
  form.querySelector('textarea').focus();
}
let inboxTab = 'requests';
function initInbox() {
  const btn = document.getElementById('inboxBtn');
  const modalEl = document.getElementById('inboxModal');
  const close = document.getElementById('inboxCloseBtn');
  if (!btn) return;
  btn.onclick = () => openInbox('requests');
  close.onclick = () => modalEl.style.display = 'none';
  modalEl.addEventListener('click', e => { if (e.target === modalEl) modalEl.style.display = 'none'; });
  document.querySelectorAll('.inbox-tab').forEach(t => {
    if (t.dataset.tab === 'reports' && state.user.role === 'admin') t.style.display = '';
    t.onclick = () => openInbox(t.dataset.tab);
  });
}
async function openInbox(tab) {
  inboxTab = tab || 'requests';
  document.querySelectorAll('.inbox-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === inboxTab));
  document.getElementById('inboxModal').style.display = 'flex';
  document.getElementById('inboxTitle').innerHTML = inboxTab === 'requests' ? `${icon('edit','sm')} Запросы на изменения` : `${icon('warning','sm')} Жалобы`;
  if (inboxTab === 'requests') unread.requests = 0;
  if (inboxTab === 'reports')  unread.reports = 0;
  updateInboxBadge();
  const url = inboxTab === 'requests' ? '/api/requests' : '/api/reports';
  const list = document.getElementById('inboxList');
  list.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const { items } = await r.json();
    if (!items.length) { list.innerHTML = `<p class="hint">Здесь пока пусто.</p>`; return; }
    list.innerHTML = '';
    for (const it of items) list.appendChild(buildInboxItem(it, inboxTab));
  } catch (e) { list.innerHTML = `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`; }
}
function buildInboxItem(it, tab) {
  const el = document.createElement('div');
  el.className = 'inbox-item';
  if (it.status === 'closed' || it.status === 'resolved') el.classList.add('closed');
  const when = new Date(it.timestamp).toLocaleString('ru-RU');
  const text = tab === 'requests' ? it.text : it.reason;
  const closedNote = it.status === 'closed' ? `<span>${icon('check','sm')} закрыто ${escapeHtml(it.closedBy || '')}</span>` : it.status === 'resolved' ? `<span>${icon('check','sm')} решено ${escapeHtml(it.resolvedBy || '')}</span>` : '';
  const filePath = it.file || '';
  const fileHtml = filePath ? `<div class="file-line">${icon('file','sm')} <a href="#" class="file-link" data-file="${escapeHtml(filePath)}">${escapeHtml(filePath)}</a></div>` : `<div class="file-line" style="color:var(--danger-fg)">${icon('warning','sm')} Файл не указан</div>`;
  const fromTag = state.user.role === 'admin' ? `<span class="who">${escapeHtml(it.from)} <button class="punish-btn" data-punish="${escapeHtml(it.from)}">${icon('gavel','sm')}</button></span>` : `<span class="who">${escapeHtml(it.from)}</span>`;
  el.innerHTML = `<div class="head">${fromTag}<span>${when}</span>${closedNote}</div>${fileHtml}<div class="text">${escapeHtml(text)}</div>`;
  const pb = el.querySelector('[data-punish]');
  if (pb) pb.onclick = ev => { ev.stopPropagation(); showPunishMenu(ev.clientX, ev.clientY, pb.dataset.punish); };
  el.querySelectorAll('.file-link').forEach(a => {
    a.onclick = async ev => {
      ev.preventDefault();
      document.getElementById('inboxModal').style.display = 'none';
      if (it.projectId && it.projectId !== state.projectId) await switchProject(it.projectId);
      openFile(a.dataset.file);
    };
  });
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (filePath) {
    const openBtn = document.createElement('button');
    openBtn.innerHTML = icon('folder','sm') + ' Открыть файл';
    openBtn.onclick = async () => {
      document.getElementById('inboxModal').style.display = 'none';
      if (it.projectId && it.projectId !== state.projectId) await switchProject(it.projectId);
      openFile(filePath);
    };
    actions.appendChild(openBtn);
  }
  if (it.status === 'open') {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'primary';
    closeBtn.innerHTML = icon('check','sm') + (tab === 'requests' ? ' Закрыть' : ' Решено');
    closeBtn.onclick = async () => {
      const url = tab === 'requests' ? `/api/requests/${it.id}/close` : `/api/reports/${it.id}/resolve`;
      const r = await fetch(url, { method: 'POST' });
      if (!r.ok) return;
      openInbox(tab);
    };
    actions.appendChild(closeBtn);
  }
  el.appendChild(actions);
  return el;
}

/* Profile */
function initProfile() {
  const modalEl = document.getElementById('profileModal');
  document.getElementById('profileBtn').onclick = () => {
    document.getElementById('profileUsername').textContent = state.user.username;
    const roleName = { member: 'Участник', admin: 'Администратор' };
    document.getElementById('profileRole').textContent = roleName[state.user.role];
    modalEl.style.display = 'flex';
  };
  document.getElementById('profileCloseBtn').onclick = () => modalEl.style.display = 'none';
  modalEl.addEventListener('click', e => { if (e.target === modalEl) modalEl.style.display = 'none'; });
  document.getElementById('passwordForm').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await fetch('/api/account/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: fd.get('current'), next: fd.get('next') }) });
    let d; try { d = await r.json(); } catch {}
    if (!r.ok) return dlA('Ошибка: ' + ((d && d.error) || r.statusText));
    e.target.reset();
  };
  document.getElementById('deleteAccountForm').onsubmit = async e => {
    e.preventDefault();
    if (!(await dlC('Удалить аккаунт? Действие необратимо.'))) return;
    if (!(await dlC('Точно? Все ваши данные будут удалены.'))) return;
    const fd = new FormData(e.target);
    const r = await fetch('/api/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: fd.get('password') }) });
    let d; try { d = await r.json(); } catch {}
    if (!r.ok) return dlA('Ошибка: ' + ((d && d.error) || r.statusText));
    if (evtSource) evtSource.close();
    location.href = '/login.html';
  };
}

/* Utilities */
window.addEventListener('beforeunload', () => {
  if (!state.editingFile) return;
  try { fetch('/api/edit/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: state.editingFile, projectId: state.projectId }), keepalive: true }); } catch {}
});
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* DARCUS + ADS + SUBSCRIPTION + INLINE EDITOR */
async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  let d = null; try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error((d && d.error) || r.statusText);
  return d;
}
async function loadSubscription() {
  try { const d = await fetchJson('/api/me/subscription'); state.subscription = d; } catch {}
}
async function activateSubscription(code) {
  try {
    await fetchJson('/api/me/subscription/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    await loadSubscription(); return true;
  } catch (e) { dlA(e.message); return false; }
}

/* Ads */
async function initAds() {
  const isAdmin = state.user?.role === 'admin';
  if (isAdmin && !state.adsDebug) return;
  try {
    const d = await fetchJson('/api/ads/serve');
    state.adsData = d;
    if (!d.images?.length) return;
    for (const [slot, ids] of Object.entries(d.distribution || {})) {
      const el = document.querySelector(`.ad-slot[data-slot="${slot}"]`);
      if (!el) continue;
      if (!d.slots[slot]?.enabled) continue;
      el.classList.add('enabled');
      const list = ids.map(id => d.images.find(x => x.id === id)).filter(Boolean);
      if (!list.length) continue;
      let idx = Math.floor(Math.random() * list.length);
      const show = () => {
        el.innerHTML = '';
        const img = document.createElement('img');
        img.src = '/api/ads/file/' + encodeURIComponent(list[idx].filename);
        img.alt = list[idx].originalName || 'ad'; img.loading = 'lazy';
        el.appendChild(img); idx = (idx + 1) % list.length;
      };
      show();
      const interval = (d.slots[slot].interval || 20) * 1000;
      const t = setInterval(show, interval);
      state.adsTimers.set(slot, t);
    }
  } catch (e) { console.warn('ads:', e.message); }
}
function toggleAdsDebug(on) {
  state.adsDebug = !!on;
  try { localStorage.setItem('showAds', on ? '1' : '0'); } catch {}
  if (on) initAds();
  else {
    for (const t of state.adsTimers.values()) clearInterval(t);
    state.adsTimers.clear();
    document.querySelectorAll('.ad-slot').forEach(el => { el.classList.remove('enabled'); el.innerHTML = ''; });
  }
}

/* Darcus chat */
function initDarcus() {
  const form = document.getElementById('darcusForm');
  const input = document.getElementById('darcusInput');
  const attachBtn = document.getElementById('darcusAttachBtn');
  const attachInput = document.getElementById('darcusAttachInput');
  if (!form) return;

  attachBtn.onclick = () => attachInput.click();
  attachInput.onchange = async () => {
    for (const f of attachInput.files) {
      const isImage = f.type.startsWith('image/');
      const a = { file: f, name: f.name, size: f.size, kind: isImage ? 'image' : 'file', mime: f.type || '' };
      if (isImage) a.thumb = await makeImageThumb(f);
      state.darcus.attachments.push(a);
    }
    attachInput.value = ''; renderDarcusAttachments();
  };

  form.onsubmit = async e => {
    e.preventDefault();
    if (state.darcus.streaming) return;
    const text = input.value.trim();
    const atts = state.darcus.attachments.slice();
    if (!text && !atts.length) return;
    input.value = ''; input.style.height = '';
    state.darcus.attachments = []; renderDarcusAttachments();
    await sendDarcusQuery(text, atts);
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      e.preventDefault(); e.stopPropagation();
      const s = input.selectionStart, e2 = input.selectionEnd;
      input.value = input.value.slice(0, s) + '\n' + input.value.slice(e2);
      input.selectionStart = input.selectionEnd = s + 1;
      input.dispatchEvent(new Event('input'));
      autoGrowResize(input);
    } else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      form.requestSubmit();
    }
  }, true);
  autoGrow(input);

  document.getElementById('darcusActivateBtn').onclick = async () => {
    const code = document.getElementById('darcusCodeInput').value.trim();
    if (!code) return;
    if (await activateSubscription(code)) {
      document.getElementById('darcusLockMsg').innerHTML = icon('check-circle','sm') + ' Подписка активирована';
      refreshDarcusView();
    }
  };

  const chatPickerBtn = document.getElementById('darcusChatSelectBtn');
  if (chatPickerBtn) chatPickerBtn.onclick = (e) => { e.stopPropagation(); toggleDarcusChatPanel(); };
  const chatSearch = document.getElementById('darcusChatSearch');
  if (chatSearch) chatSearch.oninput = () => renderDarcusChatSelect();
  const chatDeleteAll = document.getElementById('darcusChatDeleteAll');
  if (chatDeleteAll) chatDeleteAll.onclick = deleteAllDarcusChats;
  document.addEventListener('click', e => {
    const panel = document.getElementById('darcusChatPanel');
    const bar = document.getElementById('darcusChatsBar');
    if (panel && !panel.hidden && !panel.contains(e.target) && bar && !bar.contains(e.target)) panel.hidden = true;
  });
  const newBtn = document.getElementById('darcusChatNewBtn');
  if (newBtn) newBtn.onclick = () => createDarcusChat();
  const delBtn = document.getElementById('darcusChatDelBtn');
  if (delBtn) delBtn.onclick = () => deleteDarcusChat();
  const voiceBtn = document.getElementById('darcusVoiceModeBtn');
  if (voiceBtn) { updateVoiceModeBtn(); voiceBtn.onclick = () => { closeDarcusChatPanel(); setDarcusVoiceMode(!darcusVoiceModeOn()); }; }
  const autoBtn = document.getElementById('darcusAutoApplyBtn');
  if (autoBtn) { updateDarcusAutoApplyBtn(); autoBtn.onclick = () => { closeDarcusChatPanel(); setDarcusAutoApply(!darcusAutoApplyOn()); }; }

  /* [NEW] Stop button — добавляем динамически */
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.id = 'darcusStopBtn';
  stopBtn.className = 'stop-btn';
  stopBtn.title = 'Остановить генерацию';
  stopBtn.setAttribute('aria-label', 'Остановить генерацию');
  // Только иконка: в узкой панели чата текст «Стоп» наезжал на поле ввода.
  stopBtn.innerHTML = icon('square','sm');
  stopBtn.style.display = 'none';
  stopBtn.onclick = () => {
    if (state.darcus.abortController) {
      state.darcus.abortController.abort();
      showToast('Генерация остановлена');
    }
  };
  // FIX: вставляем ВНУТРЬ формы, перед кнопкой отправки — не вылазит за поле ввода
  const sendBtn = form.querySelector('button[type="submit"]');
  if (sendBtn) form.insertBefore(stopBtn, sendBtn);
  else form.appendChild(stopBtn);

  loadDarcusChats().then(() => { if (state.darcusChats.length) openDarcusChat(state.darcusChats[0].id); });
}
function renderDarcusAttachments() {
  const box = document.getElementById('darcusAttachPreview'); if (!box) return;
  const list = state.darcus.attachments;
  if (!list.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = '';
  box.innerHTML = list.map(a => a.kind === 'image' && a.thumb
    ? `<span class="darcus-attach-thumb"><img src="${a.thumb}" alt="${escapeHtml(a.name)}"></span>`
    : `<span>${icon('paperclip','sm')} ${escapeHtml(a.name)}</span>`).join('') +
    `<button type="button" id="darcusAttachClear">${icon('x','sm')}</button>`;
  document.getElementById('darcusAttachClear').onclick = () => { state.darcus.attachments = []; renderDarcusAttachments(); };
}

// Миниатюра изображения для истории чата (data URL, без сервера).
function makeImageThumb(file, max = 480, quality = 0.72) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      } catch { resolve(''); }
      finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
    img.src = url;
  });
}

function openDarcusImageViewer(src, name) {
  let el = document.getElementById('darcusImageViewer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'darcusImageViewer';
    el.className = 'darcus-image-viewer';
    el.innerHTML = '<img alt=""><button type="button" data-close title="Закрыть">×</button>';
    el.addEventListener('click', e => {
      if (e.target === el || e.target.closest('[data-close]')) el.style.display = 'none';
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && el.style.display === 'flex') el.style.display = 'none';
    });
    document.body.appendChild(el);
  }
  el.querySelector('img').src = src;
  el.querySelector('img').alt = name || '';
  el.style.display = 'flex';
}
function refreshDarcusView() {
  const lockEl = document.getElementById('darcusLock');
  const msgEl = document.getElementById('darcusMessages');
  const form = document.getElementById('darcusForm');
  const badge = document.getElementById('darcusSubBadge');
  if (!lockEl) return;
  const has = state.subscription.active || state.subscription.forceAdmin;
  lockEl.style.display = has ? 'none' : '';
  msgEl.style.display  = has ? '' : 'none';
  form.style.display   = has ? '' : 'none';
  badge.textContent = has ? (state.subscription.until ? 'до ' + new Date(state.subscription.until).toLocaleDateString('ru-RU') : 'активна') : 'нужна подписка';
  if (has && !state.darcus.messages.length) msgEl.innerHTML = '<div class="chat-empty">Задайте вопрос — Darcus поищет в файлах, интернете и Википедии.</div>';
}
async function loadDarcusChats() {
  try { const d = await fetchJson('/api/darcus/chats'); state.darcusChats = d.chats || []; renderDarcusChatSelect(); }
  catch (e) { console.warn('loadDarcusChats', e); }
}
function renderDarcusChatSelect() {
  const list = document.getElementById('darcusChatList');
  const titleEl = document.getElementById('darcusChatTitle');
  const chats = state.darcusChats || [];
  const cur = chats.find(c => c.id === state.darcusCurrentChatId);
  if (titleEl) titleEl.textContent = cur ? (cur.title || 'Чат') : 'Новый чат';
  if (!list) return;
  const q = (document.getElementById('darcusChatSearch')?.value || '').trim().toLowerCase();
  const filtered = q ? chats.filter(c => (c.title || '').toLowerCase().includes(q)) : chats;
  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = '<div class="darcus-chat-empty">' + (q ? 'Ничего не найдено' : 'Чатов пока нет') + '</div>';
    return;
  }
  for (const c of filtered) {
    const item = document.createElement('div');
    item.className = 'darcus-chat-item' + (c.id === state.darcusCurrentChatId ? ' active' : '');
    item.innerHTML = `<span class="darcus-chat-item-title">${escapeHtml((c.title || 'Чат').slice(0, 80))}</span>
      <span class="darcus-chat-item-meta">${c.messagesCount || 0} сообщ.</span>`;
    item.onclick = () => { closeDarcusChatPanel(); openDarcusChat(c.id); };
    list.appendChild(item);
  }
}
function toggleDarcusChatPanel() {
  const panel = document.getElementById('darcusChatPanel');
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    renderDarcusChatSelect();
    setTimeout(() => document.getElementById('darcusChatSearch')?.focus(), 30);
  }
}
function closeDarcusChatPanel() {
  const panel = document.getElementById('darcusChatPanel');
  if (panel) panel.hidden = true;
}
async function deleteAllDarcusChats() {
  if (!(await dlC('Удалить все ваши чаты Darcus? Это необратимо.'))) return;
  try {
    const d = await fetchJson('/api/darcus/chats', { method: 'DELETE' });
    state.darcusChats = []; state.darcusCurrentChatId = null; state.darcus.messages = [];
    closeDarcusChatPanel();
    renderDarcusChatSelect(); renderDarcusMessages(); refreshDarcusView();
    showToast('Все чаты удалены' + (d.removed ? ` (${d.removed})` : ''));
  } catch (e) { dlA('Не удалось удалить чаты: ' + e.message); }
}
async function createDarcusChat() {
  try {
    const d = await fetchJson('/api/darcus/chats', { method: 'POST' });
    state.darcusCurrentChatId = d.chat.id; state.darcus.messages = [];
    closeDarcusChatPanel();
    await loadDarcusChats();
    if (d.reused) { try { const full = await fetchJson('/api/darcus/chats/' + encodeURIComponent(d.chat.id)); state.darcus.messages = (full.chat.messages || []).map(m => ({ id: m.id, role: m.role, content: m.content, attachments: m.attachments || [], sources: m.sources || [], web: m.web || [], wiki: m.wiki || [] })); } catch {} }
    renderDarcusMessages(); refreshDarcusView();
  } catch (e) { dlA('Не удалось создать чат: ' + e.message); }
}
async function deleteDarcusChat() {
  const id = state.darcusCurrentChatId; if (!id) return;
  if (!(await dlC('Удалить этот чат?'))) return;
  try {
    await fetchJson('/api/darcus/chats/' + encodeURIComponent(id), { method: 'DELETE' });
    state.darcusCurrentChatId = null; state.darcus.messages = [];
    await loadDarcusChats();
    if (state.darcusChats.length) await openDarcusChat(state.darcusChats[0].id);
    else { renderDarcusMessages(); refreshDarcusView(); }
  } catch (e) { dlA('Ошибка: ' + e.message); }
}
async function openDarcusChat(id) {
  try {
    const d = await fetchJson('/api/darcus/chats/' + encodeURIComponent(id));
    state.darcusCurrentChatId = id;
    closeDarcusChatPanel();
    state.darcus.messages = (d.chat.messages || []).map(m => ({
      id: m.id, role: m.role, content: m.content,
      attachments: m.attachments || [],
      sources: m.sources || [], web: m.web || [], wiki: m.wiki || []
    }));
    renderDarcusChatSelect(); renderDarcusMessages(); refreshDarcusView();
  } catch (e) { console.warn(e); }
}
function renderDarcusMessages() {
  const box = document.getElementById('darcusMessages'); if (!box) return;
  box.innerHTML = '';
  if (!state.darcus.messages.length) { box.innerHTML = '<div class="chat-empty">…</div>'; return; }
  let shown = 0;
  for (const m of state.darcus.messages) {
    const el = buildDarcusMsgEl(m);
    const isStreaming = state.darcus.streamingId === m.id;
    if (el.dataset.empty === '1' && !isStreaming) continue;
    box.appendChild(el);
    shown++;
  }
  if (!shown) box.innerHTML = '<div class="chat-empty">Пустой ответ. Задайте вопрос ещё раз.</div>';
  box.scrollTop = box.scrollHeight;
}
function buildDarcusMsgEl(m) {
  const el = document.createElement('div');
  const mine = m.role === 'user';
  el.className = 'chat-msg darcus' + (mine ? ' mine' : '');
  el.dataset.id = m.id;
  if (mine) {
    let attHtml = '';
    if (Array.isArray(m.attachments) && m.attachments.length) {
      attHtml = '<div class="attachments">' + m.attachments.map(a => {
        if (a.kind === 'image' && a.thumb)
          return `<div class="attach-thumb" data-darcus-img="1" title="${escapeHtml(a.name)}"><img src="${a.thumb}" alt="${escapeHtml(a.name)}"></div>`;
        if (a.kind === 'image')
          return `<div class="attach-card">${icon('image','sm')} <span class="fname">${escapeHtml(a.name)}</span></div>`;
        return `<div class="attach-card">${icon('file','sm')} <span class="fname">${escapeHtml(a.name)}</span></div>`;
      }).join('') + '</div>';
    }
    el.innerHTML = `<div class="bubble"><span class="text">${escapeHtml(m.content || '')}</span>${attHtml}</div>`;
    const imgEl = el.querySelector('.attach-thumb[data-darcus-img] img');
    if (imgEl) {
      const box = el.querySelector('.attach-thumb[data-darcus-img]');
      box.onclick = () => openDarcusImageViewer(imgEl.src, m.attachments.find(a => a.kind === 'image')?.name || '');
    }
    return el;
  }
  const stripped = stripAiActions(m.content || '');
  const isEmpty = !stripped.trim();
  // [FIX] Пока текста нет — показываем лёгкий плейсхолдер вместо пустоты
  const html = isEmpty
    ? '<span class="darcus-typing"><i></i><i></i><i></i></span>'
    : sanitize(mdToHtml(stripped));
  let sources = '';
  if (m.sources?.length || m.web?.length || m.wiki?.length) {
    const parts = [];
    for (const s of (m.sources || []).slice(0, 5)) parts.push(`<span>${icon('file-doc','sm')} ${escapeHtml(s.projectName)}/${escapeHtml(s.path)}</span>`);
    for (const w of (m.web || []).slice(0, 3)) parts.push(`<a href="${escapeHtml(w.url)}" target="_blank" rel="noopener">${icon('globe','sm')} ${escapeHtml(w.title)}</a>`);
    for (const w of (m.wiki || []).slice(0, 2)) parts.push(`<a href="${escapeHtml(w.url)}" target="_blank" rel="noopener">${icon('book','sm')} ${escapeHtml(w.title)}</a>`);
    sources = `<div class="darcus-sources">${parts.join(' · ')}</div>`;
  }
  el.innerHTML = `<div class="bubble"><div class="md-body">${html}</div>${sources}<div class="msg-actions">
    <button type="button" class="msg-copy-btn" title="Скопировать ответ">${icon('copy','sm')}</button>
    <button type="button" class="msg-tts-btn" title="Озвучить"><svg class="ico sm"><use href="#i-volume"/></svg></button>
  </div></div>`;
  if (isEmpty) el.dataset.empty = '1';
  // [FIX] Пока пусто — не показываем кнопки Копировать/Озвучить, они бессмысленны
  if (isEmpty) {
    const acts = el.querySelector('.msg-actions');
    if (acts) acts.style.display = 'none';
  }
  const copyBtn = el.querySelector('.msg-copy-btn');
  if (copyBtn) copyBtn.onclick = ev => {
    ev.stopPropagation();
    navigator.clipboard.writeText(stripAiActions(m.content || '')).then(
      () => showToast('Скопировано'),
      () => showToast('Не удалось скопировать')
    );
  };
  const ttsBtn = el.querySelector('.msg-tts-btn');
  if (ttsBtn) ttsBtn.onclick = ev => {
    ev.stopPropagation();
    // Убираем markdown-разметку и ACTION-блок для озвучки
    const plain = stripAiActions(String(m.content || ''))
      .replace(/```[\s\S]*?```/g, ' (блок кода) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[#*_>~\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    toggleSpeakMessage(m.id, plain, ttsBtn);
  };
  return el;
}
async function sendDarcusQuery(query, attachments) {
  if (!state.darcusCurrentChatId) await createDarcusChat();
  const history = state.darcus.messages.filter(m => m.content).slice(-12).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
  const atts = attachments || [];
  const userMsg = { id: crypto.randomUUID(), role: 'user', content: query, attachments: atts.map(a => ({ name: a.name, kind: a.kind, mime: a.mime, size: a.size, thumb: a.thumb || null })) };
  const msgEl = { id: crypto.randomUUID(), role: 'assistant', content: '', sources: [], web: [], wiki: [] };
  state.darcus.messages.push(userMsg, msgEl);
  state.darcus.streaming = true;
  state.darcus.streamingId = msgEl.id;
  renderDarcusMessages();
  const stopBtn = document.getElementById('darcusStopBtn');
  if (stopBtn) stopBtn.style.display = '';

  const box = document.getElementById('darcusMessages');
  const last = box.lastElementChild;
  const mdBody = last.querySelector('.md-body');

  const payload = [];
  for (const a of atts) {
    try {
      const buf = await a.file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      const b64 = btoa(bin);
      payload.push({ name: a.name, kind: a.kind, mime: a.mime || a.file.type || '', size: a.size, data: b64, thumb: a.thumb || null });
    } catch (e) { console.warn('attach read err', e); }
  }

  const ac = new AbortController();
  state.darcus.abortController = ac;

  try {
    const resp = await fetch('/api/darcus/chat', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query, history,
        projectId: state.projectId,
        chatId: state.darcusCurrentChatId,
        attachments: payload,
        editingFile: state.inlineEditFile || state.currentFile || '', // [NEW]
        stylePreset: localStorage.getItem('darcusStyle') || 'default',
      }),
      signal: ac.signal
    });
    if (!resp.ok) { const d = await resp.json().catch(() => ({})); throw new Error(d.error || resp.statusText); }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    last.classList.add('darcus-cursor');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!block.trim()) continue;
        const evM = block.match(/^event:\s*(.+)$/m);
        const dataM = block.match(/^data:\s*(.+)$/m);
        if (!dataM) continue;
        const ev = evM ? evM[1].trim() : 'message';
        let data = null; try { data = JSON.parse(dataM[1]); } catch { continue; }
        if (ev === 'chunk') {
          msgEl.content += data.text;
          mdBody.innerHTML = sanitize(mdToHtml(stripAiActions(msgEl.content)));
          box.scrollTop = box.scrollHeight;
        } else if (ev === 'done') {
          msgEl.sources = data.sources || []; msgEl.web = data.web || []; msgEl.wiki = data.wiki || [];
        } else if (ev === 'error') {
          msgEl.content += `\n\nОшибка: ${data.error}`;
          mdBody.innerHTML = sanitize(mdToHtml(stripAiActions(msgEl.content)));
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') { msgEl.content += '\n\n_(остановлено)_'; }
    else msgEl.content = 'Ошибка: ' + e.message;
    mdBody.innerHTML = sanitize(mdToHtml(stripAiActions(msgEl.content)));
  } finally {
    last.classList.remove('darcus-cursor');
    state.darcus.streaming = false;
    state.darcus.streamingId = null;
    state.darcus.abortController = null;
    if (stopBtn) stopBtn.style.display = 'none';
    renderDarcusMessages();
    loadDarcusChats().catch(()=>{});
    // Голосовой режим: озвучиваем последний ответ Darcus, но НЕ служебные
    // подтверждения действий (создание/удаление файлов и т.п.).
    if (darcusVoiceModeOn()) {
      const lastMsg = [...state.darcus.messages].reverse().find(m => m.role !== 'user' && (m.content || '').trim());
      const hasActions = lastMsg && extractAiActions(lastMsg.content || '').length > 0;
      if (lastMsg && !hasActions) setTimeout(() => {
        try { toggleSpeakMessage(lastMsg.id, lastMsg.content || '', null); } catch {}
      }, 350);
    }
    // [NEW] Обработка запросов ИИ на изменение файлов
    try { await handleAiActionsFromAnswer(msgEl.content); } catch (e) { console.warn('ai-action', e); }
  }
}

/* Inline editor */
async function openInlineEditor(file) {
  if (!file) return;
  // Повторный клик «Ред.» по уже открытому файлу не должен перечитывать
  // содержимое с сервера — это стирало набранный, но не сохранённый текст.
  if (state.inlineEditFile === file) {
    const areaEl = document.getElementById('inlineArea');
    if (areaEl) areaEl.focus();
    return;
  }
  if (state.inlineEditFile && state.inlineEditFile !== file) {
    if (!(await dlC(`Уже открыт редактор «${state.inlineEditFile}». Закрыть без сохранения?`))) return;
    await leaveInlineEditor();
  }
  await openEditorForInline(file);
}
async function openEditorForInline(file) {
  try {
    const r = await fetch('/api/edit/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, projectId: state.projectId })
    });
    if (!r.ok) {
      let d; try { d = await r.json(); } catch {}
      return dlA('Не удалось открыть: ' + ((d && d.error) || r.statusText));
    }
    const { content } = await r.json();
    const ed = document.getElementById('inlineEditor');
    const areaEl = document.getElementById('inlineArea');
    // [FIX] Если есть черновик — используем его
    const key = state.projectId + '::' + file;
    const draft = state.drafts[key];
    areaEl.value = draft != null ? draft : content;
    state.openEditors[key] = true;
    _persistDrafts();
    ed.style.display = 'flex';
    document.getElementById('content').style.display = 'none';
    state.inlineEditFile = file;
    // Пока идёт редактирование, повторная кнопка «Ред.» не нужна и опасна.
    if (editBtn) editBtn.style.display = 'none';
    if (areaEl._resetInfPad) areaEl._resetInfPad();
    // [NEW] Сброс бесконечного скролла для нового файла
    if (areaEl._resetInfPad) areaEl._resetInfPad();
    injectInlineButtons(); inlineUpdatePreview(); areaEl.focus();
  } catch (e) { dlA('Ошибка: ' + e.message); }
}
function injectInlineButtons() {
  const bar = document.querySelector('#filebar .filebar-actions'); if (!bar) return;
  if (document.getElementById('inlineSaveBtn')) return;
  const save = document.createElement('button');
  save.id = 'inlineSaveBtn'; save.className = 'primary';
  save.innerHTML = icon('save','sm') + ' <span class="hide-mobile">Сохранить</span>';
  save.onclick = saveInlineEditor;
  const cancel = document.createElement('button');
  cancel.id = 'inlineCancelBtn'; cancel.innerHTML = icon('x','sm');
  cancel.onclick = () => leaveInlineEditor(true);
  bar.insertBefore(save, bar.firstChild);
  bar.insertBefore(cancel, save.nextSibling);
}
function removeInlineButtons() {
  document.getElementById('inlineSaveBtn')?.remove();
  document.getElementById('inlineCancelBtn')?.remove();
}
async function saveInlineEditor() {
  const file = state.inlineEditFile; if (!file) return;
  const key = state.projectId + '::' + file;
  const areaEl = document.getElementById('inlineArea');
  const content = areaEl.value;
  try {
    const r = await fetch('/api/edit/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, content, projectId: state.projectId }) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return dlA('Ошибка сохранения: ' + (d.error || r.statusText)); }
    // Черновик удаляем только после успешного сохранения.
    delete state.drafts[key];
    delete state.openEditors[key];
    _persistDrafts();
    state.inlineEditFile = null;
    document.getElementById('inlineEditor').style.display = 'none';
    document.getElementById('content').style.display = '';
    removeInlineButtons();
    restoreEditButton();
    await loadTree();
    await openFile(file);
  } catch (e) { dlA('Ошибка: ' + e.message); }
}
async function leaveInlineEditorSilent() {
  const file = state.inlineEditFile; if (!file) return;
  const key = state.projectId + '::' + file;
  try { await fetch('/api/edit/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, projectId: state.projectId }) }); } catch {}
  state.inlineEditFile = null;
  document.getElementById('inlineEditor').style.display = 'none';
  document.getElementById('content').style.display = '';
  removeInlineButtons();
  restoreEditButton();
}
function restoreEditButton() {
  if (!editBtn) return;
  editBtn.style.display = canEditCurrentProject() ? '' : 'none';
}
async function leaveInlineEditor(confirmIt) {
  const file = state.inlineEditFile; if (!file) return;
  const key = state.projectId + '::' + file;
  if (confirmIt && !(await dlC('Закрыть без сохранения?'))) return;
  // Черновик удаляем только после подтверждения, а не до него.
  delete state.drafts[key];
  delete state.openEditors[key];
  _persistDrafts();
  try { await fetch('/api/edit/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, projectId: state.projectId }) }); } catch {}
  state.inlineEditFile = null;
  document.getElementById('inlineEditor').style.display = 'none';
  document.getElementById('content').style.display = '';
  removeInlineButtons();
  restoreEditButton();
  if (state.currentFile === file) await openFile(file);
}
function inlineUpdatePreview() {
  const areaEl = document.getElementById('inlineArea');
  const preview = document.getElementById('inlinePreview');
  if (!areaEl || !preview) return;
  const text = areaEl.value || '';
  preview.innerHTML = sanitize(mdToHtml(text));
  wrapTables(preview);
}
function initInlineEditor() {
  const areaEl = document.getElementById('inlineArea'); if (!areaEl) return;
  areaEl.addEventListener('input', () => {
    clearTimeout(areaEl._prevT); areaEl._prevT = setTimeout(inlineUpdatePreview, 300);
    clearTimeout(areaEl._chT);
    areaEl._chT = setTimeout(async () => {
      if (!state.inlineEditFile) return;
      try { await fetch('/api/edit/change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: state.inlineEditFile, content: areaEl.value, projectId: state.projectId }) }); } catch {}
    }, 250);
  });
  document.querySelectorAll('#inlineEditor .inline-editor-toolbar button[data-md]').forEach(b => b.onclick = () => inlineInsertMd(b.dataset.md));
  document.getElementById('inlinePreviewToggle').onclick = () => document.getElementById('inlineEditor').classList.toggle('no-preview');

  document.querySelectorAll('#inlineEditor .inline-editor-toolbar button[data-ai]').forEach(b => {
    if (b.dataset.ai === 'translate') return;
    b.onclick = () => inlineAiTransform(b.dataset.ai);
  });
  document.querySelectorAll('#inlineEditor .inline-editor-toolbar button[data-ai="translate"]').forEach(b => {
    b.onclick = () => runTranslate(document.getElementById('inlineArea'), state.inlineEditFile, b);
  });
}
async function inlineInsertMd(type) {
  const areaEl = document.getElementById('inlineArea'); if (!areaEl) return;
  const s = areaEl.selectionStart, e = areaEl.selectionEnd;
  const v = areaEl.value, sel = v.substring(s, e);
  const before = v.substring(0, s), after = v.substring(e);
  let ins = '';
  const block = t => '\n\n' + t + '\n\n';
  switch (type) {
    case 'h1': ins = block('# '   + (sel || 'Заголовок 1')); break;
    case 'h2': ins = block('## '  + (sel || 'Заголовок 2')); break;
    case 'h3': ins = block('### ' + (sel || 'Заголовок 3')); break;
    case 'bold': ins = '**' + (sel || 'жирный') + '**'; break;
    case 'italic': ins = '*' + (sel || 'курсив') + '*'; break;
    case 'strike': ins = '~~' + (sel || 'зачёркнутый') + '~~'; break;
    case 'code': ins = '`' + (sel || 'код') + '`'; break;
    case 'ul': ins = block((sel || 'пункт').split('\n').map(l => '- ' + l).join('\n')); break;
    case 'ol': ins = block((sel || 'пункт').split('\n').map((l,i)=>(i+1)+'. '+l).join('\n')); break;
    case 'quote': ins = block((sel || 'цитата').split('\n').map(l => '> ' + l).join('\n')); break;
    case 'link': { const u = await dlP('URL:', 'https://', 'Ссылка'); if (!u) return; ins = `[${sel||'текст'}](${u})`; break; }
    case 'image': {
      const files = await pickFilesForMd('image/*');
      if (!files.length) return;
      const md = await uploadMdFiles(files);
      ins = md ? '\n\n' + md + '\n\n' : '';
      break;
    }
    case 'attach': {
      const files = await pickFilesForMd();
      if (!files.length) return;
      const md = await uploadMdFiles(files);
      ins = md ? '\n\n' + md + '\n\n' : '';
      break;
    }
    case 'hr': ins = '\n\n---\n\n'; break;
    case 'codeblock': ins = '\n\n```\n' + (sel || 'код') + '\n```\n\n'; break;
    case 'table': {
      const c = parseInt(await dlP('Столбцов:', '3', 'Таблица'), 10) || 3;
      const r = parseInt(await dlP('Строк:', '2', 'Таблица'), 10) || 2;
      const h = '| ' + Array.from({length:c},(_,i)=>`Столбец ${i+1}`).join(' | ') + ' |';
      const sep2 = '|' + Array.from({length:c},()=>'---').join('|') + '|';
      const b = Array.from({length:r},()=> '| ' + Array.from({length:c},()=>'  ').join(' | ') + ' |').join('\n');
      ins = '\n\n' + h + '\n' + sep2 + (b ? '\n' + b : '') + '\n\n'; break;
    }
  }
  areaEl.value = before + ins + after; areaEl.focus();
  areaEl.selectionStart = areaEl.selectionEnd = s + ins.length;
  inlineUpdatePreview();
}
async function inlineAiTransform(mode) {
  if (!state.subscription.active && !state.subscription.forceAdmin) return dlA('Функция доступна по подписке Dark Army Intelligence');
  const areaEl = document.getElementById('inlineArea'); if (!areaEl) return;
  const s = areaEl.selectionStart, e = areaEl.selectionEnd;
  const hasSel = s !== e;
  const text = hasSel ? areaEl.value.substring(s, e) : areaEl.value;
  if (!text.trim()) return dlA('Нечего обрабатывать');
  const btn = document.querySelector(`#inlineEditor [data-ai="${mode}"]`);
  const prev = btn.innerHTML;
  btn.innerHTML = icon('loader','sm spin'); btn.disabled = true;
  try {
    const r = await fetch('/api/darcus/rewrite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, text, file: state.inlineEditFile, projectId: state.projectId }) });
    const d = await r.json();
    if (!r.ok) {
      if (d.error === 'subscription-required') return dlA('Нужна подписка Dark Army Intelligence');
      throw new Error(d.error || r.statusText);
    }
    const out = d.text || '';
    if (hasSel) areaEl.value = areaEl.value.substring(0, s) + out + areaEl.value.substring(e);
    else areaEl.value = out;
    inlineUpdatePreview();
  } catch (err) { dlA('Darcus: ' + err.message); }
  finally { btn.innerHTML = prev; btn.disabled = false; }
}

/* [NEW] Суммаризация текущего файла */
async function doSummarize() {
  if (!state.currentFile) return;
  const btn = document.getElementById('summarizeBtn');
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = icon('loader','sm spin') + ' Анализ…';
  try {
    const r = await fetch('/api/darcus/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: state.projectId, path: state.currentFile }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.statusText);
    renderSummaryPanel(d.item, state.currentFile, d.cached);
  } catch (e) {
    dlA('Не удалось суммаризировать: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function renderSummaryPanel(item, filePath, cached) {
  document.querySelectorAll('#content .summary-panel').forEach(x => x.remove());
  const panel = document.createElement('div');
  panel.className = 'summary-panel';
  panel.innerHTML = `
    <div class="summary-head">
      <b>${icon('sparkles','sm')} Кратко о документе ${cached ? '<span class="muted">(кэш)</span>' : ''}</b>
      <button class="summary-close" title="Закрыть">${icon('x','sm')}</button>
    </div>
    <div class="summary-body">
      <div class="summary-tldr"><b>TL;DR:</b> ${escapeHtml(item.tldr || '—')}</div>
      ${item.points && item.points.length
        ? `<div class="summary-points"><b>Ключевые тезисы:</b><ul>${item.points.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul></div>`
        : ''}
      ${item.entities && item.entities.length
        ? `<div class="summary-entities"><b>Упоминания:</b> ${item.entities.map(e => `<span class="entity-chip">${escapeHtml(e)}</span>`).join('')}</div>`
        : ''}
    </div>`;
  document.getElementById('content').appendChild(panel);
  panel.querySelector('.summary-close').onclick = () => panel.remove();
}

/* [NEW] Стили ответов Darcus */
async function loadStylePresets() {
  try {
    // Полный конфиг Darcus — только для админа; пользователям доступны лишь названия стилей.
    const cfg = await (await fetch('/api/darcus/styles')).json();
    const sel = document.getElementById('darcusStylePreset');
    if (!sel || !cfg.presets) return;
    sel.innerHTML = Object.entries(cfg.presets)
      .map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml((v && v.label) || k)}</option>`)
      .join('');
    sel.value = localStorage.getItem('darcusStyle') || 'default';
    sel.onchange = () => localStorage.setItem('darcusStyle', sel.value);
  } catch {}
}

/* [NEW] Перевод в редакторе */
async function runTranslate(textArea, fileRef, btn) {
  // [FIX] фиксированный список языков
  const LANGS = [
    { code: 'en', label: 'English' },
    { code: 'de', label: 'Deutsch' },
    { code: 'fr', label: 'Français' },
    { code: 'es', label: 'Español' },
    { code: 'it', label: 'Italiano' },
    { code: 'pt', label: 'Português' },
    { code: 'zh', label: '中文' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'ru', label: 'Русский' },
  ];

  // Диалог выбора языка через uiDialog
  const choice = await new Promise(resolve => {
    if (!window.uiDialog) {
      const inp = window.prompt(
        'Язык перевода:\n' + LANGS.map(l => `${l.code} — ${l.label}`).join('\n'),
        'en'
      );
      resolve(inp);
      return;
    }
    const host = document.createElement('div');
    host.className = 'ui-dialog-host';
    host.innerHTML = `
      <div class="ui-dialog-backdrop"></div>
      <div class="ui-dialog" role="dialog">
        <div class="ui-dialog-title">Перевод</div>
        <div class="ui-dialog-body">
          <p>Выберите язык, на который перевести текст:</p>
          <select id="_langSelect" style="width:100%;padding:9px 11px;background:var(--code-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:14px">
            ${LANGS.map(l => `<option value="${l.code}">${l.label} (${l.code})</option>`).join('')}
          </select>
        </div>
        <div class="ui-dialog-actions">
          <button data-cancel>Отмена</button>
          <button data-ok class="primary">Перевести</button>
        </div>
      </div>`;
    document.body.appendChild(host);
    const close = (v) => { host.remove(); resolve(v); };
    host.querySelector('[data-cancel]').onclick = () => close(null);
    host.querySelector('[data-ok]').onclick     = () => close(host.querySelector('#_langSelect').value);
    host.querySelector('.ui-dialog-backdrop').onclick = () => close(null);
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onEsc); close(null); }
    });
  });

  if (!choice) return;
  const lang = String(choice).trim().slice(0, 20);

  const s = textArea.selectionStart, e = textArea.selectionEnd;
  const hasSel = s !== e;
  const text = hasSel ? textArea.value.substring(s, e) : textArea.value;
  if (!text.trim()) return dlA('Нечего переводить');

  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = icon('loader','sm spin');
  try {
    const r = await fetch('/api/darcus/rewrite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'translate', text, file: fileRef, projectId: state.projectId, lang }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    if (hasSel) textArea.value = textArea.value.substring(0, s) + (d.text || '') + textArea.value.substring(e);
    else textArea.value = d.text || '';
    textArea.dispatchEvent(new Event('input'));
  } catch (err) { dlA('Перевод: ' + err.message); }
  finally { btn.disabled = false; btn.innerHTML = orig; }
}
/* OCR */
let ocrState = { path: null, data: null, visible: false };
function removeOcrLoading() {
  document.querySelectorAll('#content .ocr-loading').forEach(el => el.remove());
}
function showOcrLoading() {
  removeOcrLoading();
  const wrap = document.querySelector('#content .ocr-wrap') || document.getElementById('content');
  if (!wrap || !wrap.parentNode) return null;
  const panel = document.createElement('div');
  panel.className = 'ocr-panel ocr-loading';
  panel.innerHTML = `${icon('loader','sm spin')} Darcus распознаёт текст…`;
  wrap.parentNode.insertBefore(panel, wrap.nextSibling);
  return panel;
}
async function loadOcrInfo(path) {
  try {
    const d = await fetchJson(`/api/darcus/image-info?projectId=${encodeURIComponent(state.projectId)}&path=${encodeURIComponent(path)}`);
    const hasText = !!(d.item && (d.item.text || d.item.description));
    ocrState = { path, data: d.item, visible: hasText };
    const btn = document.getElementById('ocrToggleBtn');
    if (hasText) { if (btn) btn.style.display = ''; removeOcrLoading(); }
    else {
      if (btn) btn.style.display = 'none';
      // Сразу показываем, что OCR идёт: на слабом ПК это 10-20 секунд.
      const loading = showOcrLoading();
      fetchJson('/api/darcus/image-analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, projectId: state.projectId }) })
        .then(res => {
          if (!loading || loading.isConnected) removeOcrLoading();
          if (res && res.item && state.currentFile === path) {
            const ok = !!(res.item.text || res.item.description);
            ocrState = { path, data: res.item, visible: ok };
            if (btn && ok) btn.style.display = '';
            if (ok) renderOcrOverlay();
          }
        }).catch(err => {
          removeOcrLoading();
          // Показываем причину, почему OCR не сработал (модель/таймаут), а не молчим.
          if (state.currentFile !== path) return;
          const wrap = document.querySelector('#content .ocr-wrap') || document.getElementById('content');
          if (!wrap) return;
          const panel = document.createElement('div');
          panel.className = 'ocr-panel ocr-error';
          panel.textContent = 'OCR: ' + (err && err.message ? err.message : 'не удалось распознать изображение');
          wrap.parentNode.insertBefore(panel, wrap.nextSibling);
        });
    }
  } catch {
    ocrState = { path: null, data: null, visible: false };
    const btn = document.getElementById('ocrToggleBtn'); if (btn) btn.style.display = 'none';
  }
}
function renderOcrOverlay() {
  const btn = document.getElementById('ocrToggleBtn');
  if (!ocrState.data) return;
  const wrap = document.querySelector('#content .ocr-wrap'); if (!wrap) return;
  wrap.querySelectorAll('.ocr-box').forEach(b => b.remove());
  document.querySelectorAll('#content .ocr-panel').forEach(p => p.remove());
  if (!ocrState.visible) { if (btn) btn.classList.remove('active'); return; }
  if (btn) btn.classList.add('active');
  const img = wrap.querySelector('img'); if (!img) return;
  const place = () => {
    wrap.querySelectorAll('.ocr-box').forEach(b => b.remove());
    if (Array.isArray(ocrState.data.boxes)) {
      for (const bx of ocrState.data.boxes) {
        if (!bx || typeof bx.x !== 'number') continue;
        const el = document.createElement('div');
        el.className = 'ocr-box'; el.textContent = bx.text || '';
        el.style.left   = (bx.x * 100) + '%';
        el.style.top    = (bx.y * 100) + '%';
        el.style.width  = ((bx.w || 0.2) * 100) + '%';
        el.style.height = ((bx.h || 0.05) * 100) + '%';
        wrap.appendChild(el);
      }
    }
  };
  if (img.complete) place(); else img.onload = place;
  window.addEventListener('resize', place, { once: true });
  if (ocrState.data.text) {
    const panel = document.createElement('div');
    panel.className = 'ocr-panel';
    panel.innerHTML = `<div><b>${icon('file-text','sm')} Распознанный текст</b><button class="ocr-copy-btn" id="ocrCopyBtn">Скопировать</button></div><div style="margin-top:8px">${escapeHtml(ocrState.data.text)}</div>`;
    document.getElementById('content').appendChild(panel);
    document.getElementById('ocrCopyBtn').onclick = () => {
      navigator.clipboard.writeText(ocrState.data.text).then(() => {
        document.getElementById('ocrCopyBtn').innerHTML = icon('check','sm') + ' Скопировано';
        setTimeout(() => { try { document.getElementById('ocrCopyBtn').textContent = 'Скопировать'; } catch {} }, 1200);
      });
    };
  }
  if (ocrState.data.description) {
    const panel = document.createElement('div');
    panel.className = 'ocr-panel';
    panel.innerHTML = `<b>${icon('brain','sm')} Описание от Darcus</b><div style="margin-top:6px">${escapeHtml(ocrState.data.description)}</div>`;
    document.getElementById('content').appendChild(panel);
  }
}
function initOcrToggle() {
  const btn = document.getElementById('ocrToggleBtn'); if (!btn) return;
  btn.onclick = () => { if (!ocrState.data) return; ocrState.visible = !ocrState.visible; renderOcrOverlay(); };
}

/* Darcus gen */
function initDarcusGen() {
  const btn = document.getElementById('darcusGenBtn');
  const modalEl = document.getElementById('darcusGenModal');
  const form = document.getElementById('darcusGenForm');
  if (!btn) return;
  const close = () => modalEl.style.display = 'none';
  document.getElementById('darcusGenCloseBtn').onclick = close;
  document.getElementById('darcusGenCancelBtn').onclick = close;
  btn.onclick = () => {
    if (!state.subscription.active && !state.subscription.forceAdmin) return dlA('Функция доступна по подписке Dark Army Intelligence');
    form.reset(); modalEl.style.display = 'flex';
    form.querySelector('[name="name"]').focus();
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get('name') || '').trim();
    const prompt = String(fd.get('prompt') || '').trim();
    const template = fd.get('template') || '';
    if (!name || !prompt) return;
    close();
    const placeholderPath = 'Darcus генерирует…';
    state.tree.push({ name: 'Darcus…', path: placeholderPath, isDir: false, generating: true });
    renderTree();
    try {
      const r = await fetch('/api/darcus/generate-doc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, prompt, template, projectId: state.projectId, dir: currentDir() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      state.tree = state.tree.filter(n => n.path !== placeholderPath);
      await loadTree();
      if (d.path) await openFile(d.path);
    } catch (err) {
      state.tree = state.tree.filter(n => n.path !== placeholderPath);
      renderTree();
      dlA('Darcus: ' + err.message);
    }
  };
}

/* Profile ext */
function initProfileExt() {
  const box = document.getElementById('profileModal'); if (!box) return;
  const status = document.getElementById('profileSubStatus');
  const line   = document.getElementById('profileSubLine');
  const actBox = document.getElementById('profileSubActivate');
  const actBtn = document.getElementById('profileSubActivateBtn');
  const codeInp= document.getElementById('profileSubCode');
  const adsChk = document.getElementById('profileShowAds');
  if (adsChk) { adsChk.checked = state.adsDebug; adsChk.onchange = () => toggleAdsDebug(adsChk.checked); }
  const origBtn = document.getElementById('profileBtn');
  if (origBtn && !origBtn._extHooked) {
    origBtn._extHooked = true;
    const orig = origBtn.onclick;
    origBtn.onclick = (e) => {
      if (orig) try { orig(e); } catch {}
      const has = state.subscription.active || state.subscription.forceAdmin;
      status.textContent = has ? (state.subscription.until ? 'активна до ' + new Date(state.subscription.until).toLocaleDateString('ru-RU') : 'активна') : 'нет';
      line.style.display = '';
      actBox.style.display = has ? 'none' : 'flex';
      adsChk.parentElement.style.display = (state.user?.role === 'admin') ? 'flex' : 'none';
    };
  }
  if (actBtn) actBtn.onclick = async () => {
    const code = (codeInp.value || '').trim();
    if (!code) return;
    if (await activateSubscription(code)) { status.textContent = 'активна'; actBox.style.display = 'none'; }
  };
}

/* =========================================================
   Кнопка «БАГ» — отправка баг-репорта со скриншотом
   ========================================================= */
function initBugReport() {
  const btn = document.getElementById('bugBtn');
  const modal = document.getElementById('bugModal');
  const form = document.getElementById('bugForm');
  if (!btn || !modal || !form) return;
  const fileInput = document.getElementById('bugScreenshot');
  const preview = document.getElementById('bugShotPreview');
  const shotName = document.getElementById('bugShotName');
  let screenshotData = null;

  const resetShot = () => {
    screenshotData = null;
    if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    if (fileInput) fileInput.value = '';
    if (shotName) shotName.textContent = 'PNG/JPG/WEBP до 3 МБ, можно вставить из буфера (Ctrl+V)';
  };
  const readFile = (file) => new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('Это не изображение'));
    if (file.size > 3 * 1024 * 1024) return reject(new Error('Скриншот больше 3 МБ'));
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('Не удалось прочитать файл'));
    fr.readAsDataURL(file);
  });
  const applyFile = async (file) => {
    try {
      screenshotData = await readFile(file);
      if (preview) {
        preview.style.display = '';
        preview.innerHTML = `<img src="${screenshotData}" alt="Скриншот бага"><button type="button" id="bugShotRemove" title="Убрать">×</button>`;
        const rm = document.getElementById('bugShotRemove');
        if (rm) rm.onclick = resetShot;
      }
      if (shotName) shotName.textContent = file.name;
    } catch (e) { dlA(e.message); }
  };

  btn.onclick = () => { form.reset(); resetShot(); modal.style.display = 'flex'; setTimeout(() => form.querySelector('textarea').focus(), 50); };
  document.getElementById('bugCloseBtn').onclick =
  document.getElementById('bugCancelBtn').onclick = () => { modal.style.display = 'none'; };
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
  document.getElementById('bugAttachBtn').onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files[0]) applyFile(fileInput.files[0]); };
  form.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) { e.preventDefault(); applyFile(f); break; } }
    }
  });
  form.onsubmit = async e => {
    e.preventDefault();
    const description = String(form.description.value || '').trim();
    if (description.length < 5) return dlA('Опишите баг (минимум 5 символов)');
    const submit = form.querySelector('button[type=submit]');
    const old = submit.textContent;
    submit.disabled = true; submit.textContent = 'Отправка…';
    try {
      const r = await fetch('/api/bugs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, page: location.pathname + location.search, screenshot: screenshotData }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      modal.style.display = 'none';
      showToast('Баг отправлен — спасибо!');
    } catch (err) { dlA('Не удалось отправить баг: ' + err.message); }
    finally { submit.disabled = false; submit.textContent = old; }
  };
}

/* Init extensions */
async function initExtensions() {
  await loadSubscription();
  loadStylePresets();                    // [NEW]
  initTts();
  initVoiceInput();                      // [FIX] один раз
  initDarcus();
  initInlineEditor();
  initOcrToggle();
  initDarcusGen();
  initBugReport();
  initMarkdownDrop();
  initTreeShortcuts();
  initProfileExt();
  initAds();
  // [FIX] Привязка кнопки «Кратко»
  const sumBtnEl = document.getElementById('summarizeBtn');
  if (sumBtnEl) sumBtnEl.addEventListener('click', doSummarize);

  const eb = document.getElementById('editBtn');
  if (eb) {
    eb.onclick = () => {
      const file = state.currentFile; if (!file) return;
      const ext = (file.split('.').pop() || '').toLowerCase();
      if (!EDITABLE.includes(ext)) return;
      if (!canEditCurrentProject()) return;
      openInlineEditor(file);
    };
  }
  const dt = document.querySelector('.chat-tab[data-tab="darcus"]');
  if (dt) dt.addEventListener('click', () => { setTimeout(refreshDarcusView, 20); });

  const dgb = document.getElementById('darcusGenBtn'); if (dgb) updateDarcusGenAvailability();

  // [FIX] AI-кнопки в модалке редактора (rephrase/shorten/fix) — отдельно,
  // и translate — отдельно, без вложенных forEach
  document.querySelectorAll('#editorModal .editor-toolbar button[data-ai]').forEach(b => {
    if (b.dataset.ai === 'translate') return;   // обрабатываем ниже
    b.onclick = async () => {
      if (!state.subscription.active && !state.subscription.forceAdmin) {
        return dlA('Функция доступна по подписке Dark Army Intelligence');
      }
      const areaEl = document.getElementById('editorArea');
      if (!areaEl) return;
      const s = areaEl.selectionStart, e = areaEl.selectionEnd;
      const hasSel = s !== e;
      const text = hasSel ? areaEl.value.substring(s, e) : areaEl.value;
      if (!text.trim()) return dlA('Нечего обрабатывать');
      const prev = b.innerHTML;
      b.innerHTML = icon('loader','sm spin'); b.disabled = true;
      try {
        const r = await fetch('/api/darcus/rewrite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: b.dataset.ai, text,
            file: state.editingFile, projectId: state.projectId,
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || r.statusText);
        if (hasSel) areaEl.value = areaEl.value.substring(0, s) + (d.text || '') + areaEl.value.substring(e);
        else areaEl.value = d.text || '';
        areaEl.dispatchEvent(new Event('input'));
      } catch (err) { dlA('Darcus: ' + err.message); }
      finally { b.innerHTML = prev; b.disabled = false; }
    };
  });

  document.querySelectorAll('#editorModal .editor-toolbar button[data-ai="translate"]').forEach(b => {
    b.onclick = () => runTranslate(document.getElementById('editorArea'), state.editingFile, b);
  });

  const pairs = [
    { el: document.getElementById('chatInput'),       form: document.getElementById('chatForm') },
    { el: document.getElementById('projectChatInput'), form: document.getElementById('projectChatForm') },
    { el: document.getElementById('ticketInput'),      form: document.getElementById('ticketForm') }
  ];
  for (const it of pairs) {
    if (!it.el || !it.form) continue;
    if (it.el._enterBound) continue;
    it.el._enterBound = true;
    it.el.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.shiftKey)) {
        e.preventDefault(); e.stopPropagation();
        const s = it.el.selectionStart, e2 = it.el.selectionEnd;
        it.el.value = it.el.value.slice(0, s) + '\n' + it.el.value.slice(e2);
        it.el.selectionStart = it.el.selectionEnd = s + 1;
        it.el.dispatchEvent(new Event('input'));
        autoGrowResize(it.el);
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        it.form.requestSubmit();
      }
    }, true);
  }

  document.querySelectorAll('.chat-form textarea').forEach(el => {
    el.addEventListener('paste', () => setTimeout(() => autoGrowResize(el), 0));
  });
}
setTimeout(() => { try { initExtensions(); } catch (e) { console.error('ext:', e); } }, 500);
setTimeout(() => { try { initUndoRedo(); } catch (e) { console.error('undo:', e); } }, 800);
setTimeout(() => { try { initInfiniteScrollEditors(); } catch (e) { console.error('infScroll:', e); } }, 900);

/* =========================================================
   [NEW] TTS (SpeechSynthesis — встроенный движок браузера)
   ========================================================= */
function initTts() {
  // Останавливаем озвучку при уходе со страницы
  window.addEventListener('beforeunload', () => {
    try { speechSynthesis.cancel(); } catch {}
    try { stopAllTts(); } catch {}
  });
  // Разблокируем Web Audio по первому жесту пользователя: иначе Chrome
  // блокирует auto-play и мы слышим запасной «робот» браузера.
  const unlock = () => { try { unlockTtsAudio(); } catch {} };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
}
let _ttsCtx = null, _ttsSource = null;
function unlockTtsAudio() {
  try {
    if (!_ttsCtx) _ttsCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ttsCtx.state === 'suspended') _ttsCtx.resume().catch(() => {});
  } catch {}
  return _ttsCtx;
}

function _findRuVoice() {
  if (!('speechSynthesis' in window)) return null;
  const vs = speechSynthesis.getVoices();
  return vs.find(v => /ru[-_]RU/i.test(v.lang)) ||
         vs.find(v => /^ru/i.test(v.lang)) || null;
}

/* [NEW] Озвучка: сначала пробуем серверный TTS (Supertonic 3), при ошибке — SpeechSynthesis */
function cleanTextForTts(text) {
  let t = String(text || '');
  try { t = stripAiActions(t); } catch {}
  // Служебную плашку действия не озвучиваем.
  t = t.replace(/<div[^>]*darcus-action-done[^>]*>[\s\S]*?<\/div>/gi, ' ')
       .replace(/<[^>]+>/g, ' ')
       .replace(/```[\s\S]*?```/g, ' ')
       .replace(/`[^`]*`/g, ' ')
       .replace(/https?:\/\/\S+/g, ' ')
       .replace(/[*#>_~|]+/g, ' ')
       .replace(/\s+/g, ' ').trim();
  return t;
}
async function toggleSpeakMessage(id, text, btnEl) {
  text = cleanTextForTts(text);
  if (!text) { showToast('Нечего озвучивать'); return; }
  if (state.ttsSpeakingId === id) { stopAllTts(); return; }
  stopAllTts();

  if (btnEl) {
    btnEl.classList.add('speaking');
    btnEl.dataset._origHtml = btnEl.innerHTML;
    btnEl.innerHTML = icon('loader','sm spin');
  }
  try {
    const r = await fetch('/api/darcus/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text || '').slice(0, 5000) }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || r.statusText);
    }
    const buffer = await r.arrayBuffer();
    const ctx = unlockTtsAudio();
    if (!ctx) throw new Error('Web Audio недоступен');
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    if (ctx.state === 'suspended')
      throw new Error('AUTOPLAY: нажмите динамик ещё раз — браузер заблокировал автозапуск');
    const audioBuf = await new Promise((resolve, reject) =>
      ctx.decodeAudioData(buffer.slice(0), resolve, reject));
    stopAllTts();
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    src.onended = () => stopAllTts();
    state.ttsSource = src;
    state.ttsSpeakingId = id;
    src.start(0);
    if (btnEl) btnEl.innerHTML = '<svg class="ico sm"><use href="#i-volume-off"/></svg>';
  } catch (e) {
    if (btnEl) btnEl.innerHTML = btnEl.dataset._origHtml || '';
    const msg = String(e && e.message || e);
    if (msg.startsWith('AUTOPLAY:')) {
      showToast(msg.slice('AUTOPLAY:'.length).trim());
      return;
    }
    // Браузерный синтез оставляем только если серверный TTS вообще не настроен.
    if (state.voiceCaps && state.voiceCaps.tts === false) { _speakWithBrowser(id, text, btnEl); return; }
    showToast('Silero TTS недоступен: ' + msg.slice(0, 120));
  }
}

function stopAllTts() {
  if (state.ttsSource) { try { state.ttsSource.stop(); } catch {} state.ttsSource = null; }
  state.ttsAudio = null;
  if (state.ttsAudioUrl) { try { URL.revokeObjectURL(state.ttsAudioUrl); } catch {} state.ttsAudioUrl = null; }
  try { speechSynthesis.cancel(); } catch {}
  state.ttsSpeakingId = null;
  document.querySelectorAll('.msg-tts-btn.speaking').forEach(b => {
    b.classList.remove('speaking');
    if (b.dataset._origHtml) { b.innerHTML = b.dataset._origHtml; delete b.dataset._origHtml; }
    else b.innerHTML = '<svg class="ico sm"><use href="#i-volume"/></svg>';
  });
}

function _speakWithBrowser(id, text, btnEl) {
  if (!('speechSynthesis' in window)) { showToast('TTS недоступен'); return; }
  const u = new SpeechSynthesisUtterance(String(text || '').slice(0, 4000));
  const v = _findRuVoice();
  if (v) u.voice = v;
  u.lang = (v && v.lang) || 'ru-RU';
  u.onend = u.onerror = () => stopAllTts();
  state.ttsSpeakingId = id;
  if (btnEl) {
    btnEl.classList.add('speaking');
    btnEl.innerHTML = '<svg class="ico sm"><use href="#i-volume-off"/></svg>';
  }
  speechSynthesis.speak(u);
}

/* =========================================================
   [NEW] Меню при выделении текста
   ========================================================= */
let selMenuEl = null;
function ensureSelMenu() {
  if (selMenuEl) return selMenuEl;
  selMenuEl = document.createElement('div');
  selMenuEl.className = 'sel-menu';
  selMenuEl.style.display = 'none';
  document.body.appendChild(selMenuEl);
  return selMenuEl;
}
function hideSelMenu() {
  if (selMenuEl) selMenuEl.style.display = 'none';
}

function initSelectionMenu() {
  const menu = ensureSelMenu();

  // [FIX] Меню открывается ТОЛЬКО правой кнопкой (contextmenu) и только если есть выделение
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (e.target.closest('.sel-menu')) return;
    const sel = window.getSelection();
    const text = sel ? String(sel).trim() : '';
    if (!text || text.length < 1) {
      // Нет выделения — не перехватываем, отдаём браузеру
      return;
    }
    e.preventDefault();
    showSelMenu(e.clientX, e.clientY, text);
  });

  // Закрываем при клике вне
  document.addEventListener('mousedown', (e) => {
    if (!menu.contains(e.target)) hideSelMenu();
  });
  document.addEventListener('scroll', hideSelMenu, true);
  window.addEventListener('resize', hideSelMenu);
}

function showSelMenu(x, y, text) {
  const menu = ensureSelMenu();
  menu.innerHTML = '';
  const isMobile = window.matchMedia('(max-width: 900px)').matches;

  const mk = (label, iconName, fn, cls = '') => {
    const el = document.createElement('div');
    el.className = 'sel-item ' + cls;
    el.innerHTML = `${iconName ? icon(iconName, 'sm') : ''} ${escapeHtml(label)}`;
    el.onmousedown = el.ontouchstart = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      hideSelMenu();
      try { fn(); } catch (e) { console.error(e); }
    };
    return el;
  };

  menu.appendChild(mk('Скопировать', 'copy', () => {
    navigator.clipboard.writeText(text).then(
      () => showToast('Скопировано'),
      () => showToast('Не удалось скопировать')
    );
  }));

  // Озвучить выделенное
  menu.appendChild(mk('Озвучить', 'volume', () => {
    const id = 'sel-' + Date.now();
    toggleSpeakMessage(id, text, null);
  }));

  // Отправить в открытый чат (вставляет текст в поле ввода)
  menu.appendChild(mk('В чат', 'message-square', () => {
    sendSelectionToChat(text);
  }));

  // Отправить в Darcus как запрос
  const sepEl1 = document.createElement('div'); sepEl1.className = 'sel-sep'; menu.appendChild(sepEl1);
  menu.appendChild(mk('Спросить у Darcus', 'star', () => {
    sendSelectionToDarcus(text);
  }));

  // Отправить в редактор (в позицию курсора если редактор открыт)
  if (state.inlineEditFile || state.editingFile) {
    const sepEl2 = document.createElement('div'); sepEl2.className = 'sel-sep'; menu.appendChild(sepEl2);
    menu.appendChild(mk('Вставить в редактор', 'edit', () => {
      insertTextIntoActiveEditor(text);
    }));
  }

  // Создать файл из выделенного (если есть права)
  if (state.projectId && canEditCurrentProject()) {
    menu.appendChild(mk('Сохранить как файл', 'file-text', async () => {
      const name = await dlP('Имя файла (.md):', 'Заметка ' + new Date().toLocaleDateString('ru-RU') + '.md', 'Новый файл');
      if (!name || !name.trim()) return;
      const dir = currentDir();
      const r = await fetch('/api/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, name: name.trim(), projectId: state.projectId })
      });
      const d = await r.json();
      if (!r.ok) return dlA('Ошибка: ' + (d.error || r.statusText));
      // Записываем содержимое
      await fetch('/api/edit/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: d.path, content: text, projectId: state.projectId })
      }).catch(()=>{});
      if (dir) state.expanded.add(dir);
      await loadTree();
      await openFile(d.path);
    }));
  }

  menu.style.display = 'block';
  if (!isMobile) {
    const rect = menu.getBoundingClientRect();
    let left = x, top = y + 8;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - rect.height - 8);
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
  } else {
    menu.style.left = '8px';
    menu.style.right = '8px';
    menu.style.top = 'auto';
    menu.style.bottom = 'calc(12px + env(safe-area-inset-bottom))';
  }
}

function sendSelectionToChat(text) {
  if (!state.chatOpen) toggleChat(true);
  // [FIX] Если открыт Darcus или другой чат — переключаемся на общий
  if (state.chatTab === 'darcus' || state.chatTab === 'support') {
    openChatTab('general');
    setTimeout(() => injectToChatInput('chatInput', text), 120);
  } else if (state.chatTab === 'project') {
    setTimeout(() => injectToChatInput('projectChatInput', text), 60);
  } else {
    setTimeout(() => injectToChatInput('chatInput', text), 60);
  }
}

function injectToChatInput(inputId, text) {
  const target = document.getElementById(inputId);
  if (!target) return;
  const prefix = target.value ? target.value + '\n' : '';
  target.value = prefix + text;
  target.dispatchEvent(new Event('input'));
  try { autoGrowResize(target); } catch {}
  target.focus();
  try { target.selectionStart = target.selectionEnd = target.value.length; } catch {}
}

function sendSelectionToDarcus(text) {
  if (!state.chatOpen) toggleChat(true);
  openChatTab('darcus');
  setTimeout(() => {
    const inp = document.getElementById('darcusInput');
    if (!inp) return;
    inp.value = text;
    inp.dispatchEvent(new Event('input'));
    try { autoGrowResize(inp); } catch {}
    inp.focus();
  }, 200);
}

function insertTextIntoActiveEditor(text) {
  const inlineArea = document.getElementById('inlineArea');
  const modalArea = document.getElementById('editorArea');
  const target = (state.inlineEditFile && inlineArea) ? inlineArea
                : (state.editingFile && modalArea) ? modalArea
                : null;
  if (!target) { showToast('Редактор не открыт'); return; }
  const s = target.selectionStart ?? target.value.length;
  const e = target.selectionEnd ?? target.value.length;
  target.value = target.value.slice(0, s) + text + target.value.slice(e);
  target.selectionStart = target.selectionEnd = s + text.length;
  target.dispatchEvent(new Event('input'));
  target.focus();
  showToast('Вставлено в редактор');
}

/* =========================================================
   [NEW] Свайп для открытия/закрытия сайдбара
   ========================================================= */
function initSwipeSidebar() {
  let startX = 0, startY = 0, tracking = false, isOpen = false, lastX = 0;
  const EDGE = 40;           // зона от края
  const MIN_SWIPE = 60;      // минимальная длина свайпа

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; lastX = startX;
    isOpen = document.body.classList.contains('sidebar-open');
    // Начинаем только от левого края (открыть) или в любом месте поверх открытого сайдбара (закрыть)
    if (isOpen && startX < window.innerWidth * 0.85) { tracking = true; }
    else if (!isOpen && startX < EDGE) { tracking = true; }
    else { tracking = false; }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    lastX = t.clientX;
    // Если движение больше вертикальное — не мешаем скроллу
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12 && Math.abs(dx) < 20) {
      tracking = false;
      return;
    }
    document.body.classList.add('sidebar-swiping');
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    document.body.classList.remove('sidebar-swiping');
    const dx = lastX - startX;
    if (isOpen) {
      if (dx < -MIN_SWIPE) document.body.classList.remove('sidebar-open');
    } else {
      if (dx > MIN_SWIPE) document.body.classList.add('sidebar-open');
    }
  }, { passive: true });
}

/* =========================================================
   [NEW] Печать текущего документа
   ========================================================= */
function initPrint() {
  const btn = document.getElementById('printBtn');
  if (!btn) return;
  btn.onclick = () => doPrint();
}

function doPrint() {
  // Если открыт инлайн-редактор — печатаем preview
  const inlineOpen = document.getElementById('inlineEditor')?.style.display !== 'none';
  const modalOpen  = document.getElementById('editorModal')?.style.display !== 'none' &&
                     document.getElementById('editorModal')?.style.display !== '';

  // Соберём содержимое
  let html = '';
  let title = 'Документ';

  if (inlineOpen) {
    const prev = document.getElementById('inlinePreview');
    html = prev ? prev.innerHTML : '';
    title = state.inlineEditFile || 'Документ';
  } else if (modalOpen) {
    const prev = document.getElementById('editorPreview');
    html = prev ? prev.innerHTML : '';
    title = state.editingFile || 'Документ';
  } else if (state.currentFile) {
    const content = document.getElementById('content');
    html = content ? content.innerHTML : '';
    title = state.currentFile;
  } else {
    showToast('Нечего печатать');
    return;
  }

  // Санитизируем на всякий случай
  html = sanitize(html);

  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { showToast('Разрешите всплывающие окна для печати'); return; }
  w.document.open();
  w.document.write(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111;background:#fff;padding:24px;max-width:900px;margin:0 auto;line-height:1.6;font-size:14px}
  h1,h2,h3{color:#000;margin:16px 0 8px;line-height:1.25}
  h1{border-bottom:1px solid #ccc;padding-bottom:6px}
  pre{background:#f5f5f5;border:1px solid #ddd;border-radius:6px;padding:12px;overflow:auto;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
  code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:12.5px}
  pre code{background:none;padding:0}
  table{border-collapse:collapse;width:100%;margin:12px 0}
  th,td{border:1px solid #999;padding:6px 8px;text-align:left;font-size:13px}
  th{background:#f0f0f0}
  img{max-width:100%;height:auto}
  blockquote{border-left:3px solid #888;padding-left:12px;margin:10px 0;color:#555}
  a{color:#0645ad}
  @media print{body{padding:0}}
</style></head><body>${html}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch {} }, 300);
}

/* =========================================================
   [FIX v2] Распознаём и ACTION, и <<>>…<<>>, и <<<ACTION>>>…<<<END ACTION>>>
   ========================================================= */
const AI_ACTION_RE = /<{2,3}\s*(?:ACTION\s*)?>{2,3}\s*(\{[\s\S]*?\})\s*<{2,3}\s*(?:END\s+ACTION\s*)?>{2,3}/gi;
const AI_ACTION_TYPES = new Set(['create', 'edit', 'mkdir', 'delete', 'move', 'rename']);
const AI_ACTION_LABELS = {
  create: 'создал файл',
  edit:   'изменил файл',
  mkdir:  'создал папку',
  delete: 'удалил',
  move:   'переместил',
  rename: 'переименовал',
};

function _parseActionObj(raw) {
  try {
    const j = JSON.parse(String(raw).trim());
    if (j && typeof j.type === 'string' && AI_ACTION_TYPES.has(j.type.toLowerCase())) return j;
  } catch {}
  return null;
}

// Достаём ровно один JSON-объект, корректно пропуская строки и экранирование.
// Раньше regex `\{[\s\S]*?\}` обрывался на первой `}` внутри content, и
// ACTION-блок не выполнялся (файл создавался с сырым JSON внутри).
function _scanJsonObject(text) {
  const s = String(text || '');
  let i = s.indexOf('{');
  if (i < 0) return null;
  if (s.slice(0, i).trim().replace(/^```(?:json)?/i, '').trim()) return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = i; p < s.length; p++) {
    const ch = s[p];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { json: s.slice(i, p + 1), end: p + 1 };
    }
  }
  return null;
}

function extractAiActions(text) {
  const out = [];
  if (!text) return out;
  const markerRe = /<{2,3}\s*ACTION\s*>{2,3}/gi;
  let m;
  while ((m = markerRe.exec(text)) !== null) {
    const tail = text.slice(m.index + m[0].length).replace(/^\s*```(?:json)?\s*/i, '');
    const scanned = _scanJsonObject(tail);
    if (!scanned) continue;
    const j = _parseActionObj(scanned.json);
    if (j) out.push(j);
    markerRe.lastIndex = m.index + m[0].length + scanned.end;
  }
  return out;
}

async function handleAiActionsFromAnswer(text) {
  if (!text || !state.projectId) return;
  const actions = extractAiActions(text);
  for (const act of actions) {
    await runAiAction(act);
  }
}

/* =========================================================
   [FIX] Реальное выполнение ACTION-ов от Darcus
   ========================================================= */
async function runAiAction(act) {
  if (!act || !state.projectId) return;

  const type  = String(act.type || '').toLowerCase();
  const path  = String(act.path || '').trim().replace(/^\/+/, '');
  const content = typeof act.content === 'string' ? act.content : '';

  // [FIX] move/rename не имеют act.path — у них from/to и newName
  const from = String(act.from || '').trim().replace(/^\/+/, '');
  const to   = String(act.to   || '').trim().replace(/^\/+/, '');
  const newName = String(act.newName || '').trim();

  if (type === 'move') {
    if (!from || !to) return;
  } else if (type === 'rename') {
    if (!path || !newName) return;
  } else {
    if (!path) return;
  }

  const LBL = {
    create: 'создать файл',
    edit:   'изменить файл',
    mkdir:  'создать папку',
    delete: 'удалить',
    move:   'переместить',
    rename: 'переименовать',  
  };
  const label = LBL[type] || `выполнить «${type}»`;

  // Подтверждение пользователя (либо авто-режим из настроек Darcus)
  let preview = '';
  if ((type === 'create' || type === 'edit') && content) {
    preview = '\n\nСодержимое (начало):\n' + content.slice(0, 400) + (content.length > 400 ? '\n…' : '');
  }
  const ok = darcusAutoApplyOn() ? true : await dlC(
    `Darcus предлагает ${label}:\n\n${path || from + ' → ' + to}${preview}\n\nПрименить действие?`,
    'Действие Darcus — подтверждение'
  );
  if (!ok) return;

  try {
    if (type === 'create') {
      const dir  = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
      const name = path.split('/').pop();

      // 1) создаём файл-заглушку
      const r1 = await fetch('/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, name, projectId: state.projectId }),
      });
      const d1 = await r1.json().catch(() => ({}));
      if (!r1.ok) throw new Error(d1.error || r1.statusText);

      // 2) записываем содержимое
      if (content) {
        // Пытаемся через /api/write (не требует edit-сессии).
        // /api/edit/save тоже сработает, но он привязан к сессии соредактора.
        const r2 = await fetch('/api/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file: d1.path, content, projectId: state.projectId }),
        });
        if (!r2.ok) {
          const d2 = await r2.json().catch(() => ({}));
          throw new Error(d2.error || r2.statusText);
        }
      }

      if (dir) state.expanded.add(dir);
      await loadTree();
      await openFile(d1.path);
      showToast('Darcus создал файл: ' + d1.path);
      return;
    }

    if (type === 'edit') {
      const r = await fetch('/api/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: path, content, projectId: state.projectId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);

      await loadTree();
      if (state.currentFile === path) await openFile(path);
      showToast('Darcus изменил файл: ' + path);
      return;
    }

    if (type === 'mkdir') {
      const dir  = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
      const name = path.split('/').pop();
      const r = await fetch('/api/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, name, projectId: state.projectId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      state.expanded.add(d.path);
      await loadTree();
      showToast('Darcus создал папку: ' + d.path);
      return;
    }

    if (type === 'delete') {
      const r = await fetch(
        `/api/delete?path=${encodeURIComponent(path)}&projectId=${encodeURIComponent(state.projectId)}`,
        { method: 'DELETE' }
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      if (state.currentFile === path) resetViewer();
      await loadTree();
      showToast('Darcus удалил: ' + path);
      return;
    }
    if (type === 'move') {
      if (!from || !to) throw new Error('move: нужны поля from и to');
      const r = await fetch('/api/move', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, projectId: state.projectId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      if (state.currentFile === from) state.currentFile = d.path;
      await loadTree();
      showToast('Darcus переместил: ' + d.path);
      return;
    }

    if (type === 'rename') {
      const p  = String(act.path || '').trim().replace(/^\/+/, '');
      const nn = String(act.newName || act.to || '').trim();
      if (!p || !nn) throw new Error('rename: нужны path и newName');
      const r = await fetch('/api/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p, newName: nn, projectId: state.projectId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      if (state.currentFile === p) state.currentFile = d.path;
      await loadTree();
      showToast('Darcus переименовал: ' + d.path);
      return;
    }
    dlA('Неизвестный тип действия: ' + type);
  } catch (e) {
    dlA('Darcus: ' + e.message);
  }
}

/* =========================================================
   [NEW] Undo/Redo стек для редакторов (Ctrl+Z / Ctrl+Y)
   ========================================================= */
const _undoStack = new WeakMap(); // textarea -> { stack, index, max }
const UNDO_MAX = 100;
const UNDO_DEBOUNCE_MS = 500;

function _ensureUndo(el) {
  let rec = _undoStack.get(el);
  if (!rec) {
    rec = { stack: [el.value], index: 0, timer: null, lastLen: el.value.length };
    _undoStack.set(el, rec);
  }
  return rec;
}

function _pushUndo(el) {
  const rec = _ensureUndo(el);
  const cur = rec.stack[rec.index] ?? '';
  if (cur === el.value) return;
  // Обрезаем forward-историю
  rec.stack = rec.stack.slice(0, rec.index + 1);
  rec.stack.push(el.value);
  if (rec.stack.length > UNDO_MAX) rec.stack.shift();
  rec.index = rec.stack.length - 1;
}

function _debouncePush(el) {
  const rec = _ensureUndo(el);
  clearTimeout(rec.timer);
  rec.timer = setTimeout(() => _pushUndo(el), UNDO_DEBOUNCE_MS);
}

function _undo(el) {
  const rec = _ensureUndo(el);
  if (rec.index <= 0) return false;
  rec.index--;
  el.value = rec.stack[rec.index];
  el.selectionStart = el.selectionEnd = el.value.length;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function _redo(el) {
  const rec = _ensureUndo(el);
  if (rec.index >= rec.stack.length - 1) return false;
  rec.index++;
  el.value = rec.stack[rec.index];
  el.selectionStart = el.selectionEnd = el.value.length;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function initUndoRedo() {
  const ids = ['editorArea', 'inlineArea'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el || el._undoBound) continue;
    el._undoBound = true;
    el.addEventListener('input', () => _debouncePush(el));
    el.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { if (_undo(el)) { e.preventDefault(); e.stopPropagation(); } }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { if (_redo(el)) { e.preventDefault(); e.stopPropagation(); } }
    }, true);
  }
}

function _persistDrafts() {
  try {
    // Ограничим размер, чтобы не раздувать localStorage
    const entries = Object.entries(state.drafts || {});
    const trimmed = {};
    for (const [k, v] of entries.slice(-40)) trimmed[k] = String(v).slice(0, 100_000);
    state.drafts = trimmed;
    localStorage.setItem('da_drafts', JSON.stringify(trimmed));
    localStorage.setItem('da_openEditors', JSON.stringify(state.openEditors || {}));
  } catch (e) { console.warn('persistDrafts', e); }
}

/* =========================================================
   [FIX] Скрываем ACTION-блок в сообщениях ИИ + заменяем заглушкой
   ========================================================= */
function stripAiActions(text) {
  if (!text) return '';
  let s = String(text).replace(/<\|[^|>]{0,80}\|>/g, '');
  const labels = {
    create: 'создал файл', edit: 'изменил файл', mkdir: 'создал папку',
    delete: 'удалил', move: 'переместил', rename: 'переименовал',
  };
  const markerRe = /<{2,3}\s*ACTION\s*>{2,3}/gi;
  let out = '', last = 0, m;
  while ((m = markerRe.exec(s)) !== null) {
    out += s.slice(last, m.index);
    const tail = s.slice(m.index + m[0].length).replace(/^\s*```(?:json)?\s*/i, '');
    const scanned = _scanJsonObject(tail);
    let label = 'выполнил действие';
    let path = '';
    if (scanned) {
      const j = _parseActionObj(scanned.json);
      if (j) {
        label = labels[j.type] || label;
        path = String(j.path || j.to || '').slice(0, 200);
      }
    }
    let consumed = m[0].length + (scanned ? scanned.end : 0);
    const rest = s.slice(m.index + consumed);
    const em = rest.match(/<{2,3}\s*END\s*ACTION\s*>{2,3}/i);
    if (em) consumed += em.index + em[0].length;
    out += `\n\n<div class="darcus-action-done">✅ <b>Darcus ${label}</b>${path ? ': <code>' + escapeHtml(path) + '</code>' : ''}</div>\n\n`;
    last = m.index + consumed;
    markerRe.lastIndex = last;
  }
  out += s.slice(last);
  // Остатки маркеров без JSON + незакрытые хвосты.
  return out.replace(/<{2,3}\s*(?:END\s+)?ACTION\s*>{2,3}[\s\S]*$/gi, '')
            .replace(/^[\s\S]*<{2,3}\s*END\s*ACTION\s*>{2,3}/i, '')
            .trim();
}

/* =========================================================
   [FIX v2] Бесконечный скролл вниз для textarea редакторов
   Слушаем wheel / touchmove / keydown — не scroll,
   потому что scroll не срабатывает, когда уже внизу.
   ========================================================= */
function initInfiniteScrollTextarea(el, opts = {}) {
  if (!el || el._infBound) return;
  el._infBound = true;

  const step   = opts.step   || Math.round(window.innerHeight * 0.35);
  const maxPad = opts.maxPad || 50000;

  const basePad = parseFloat(getComputedStyle(el).paddingBottom) || 0;
  let pad = 0;

  const apply = () => { el.style.paddingBottom = (basePad + pad) + 'px'; };
  apply();

  const atBottom = () => (el.scrollHeight - el.scrollTop - el.clientHeight) <= 2;

  const grow = (n = step) => {
    if (pad >= maxPad) return false;
    pad = Math.min(maxPad, pad + n);
    apply();
    // Небольшая пауза, чтобы reflow точно применился
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return true;
  };

  // 1) Колесо мыши — основной триггер на десктопе
  el.addEventListener('wheel', (e) => {
    if (e.deltaY <= 0) return;          // крутят вверх — не трогаем
    if (!atBottom()) return;            // ещё есть куда скроллить
    e.preventDefault();
    grow();
  }, { passive: false });

  // 2) Тач на мобилке
  let touchY = 0;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchY = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const cy = e.touches[0].clientY;
    const dy = cy - touchY;
    touchY = cy;
    if (dy >= 0) return;                // палец вниз — это скролл вверх
    if (!atBottom()) return;
    grow();
  }, { passive: true });

  // 3) Клавиатура: PageDown / стрелка вниз / Ctrl+End
  el.addEventListener('keydown', (e) => {
    const nav = e.key === 'PageDown'
             || e.key === 'ArrowDown'
             || (e.ctrlKey && e.key === 'End');
    if (!nav) return;
    setTimeout(() => { if (atBottom()) grow(); }, 0);
  });

  // Сброс накопленного padding (вызывается при открытии нового файла)
  el._resetInfPad = () => { pad = 0; apply(); };

  console.log('[infScroll] bound to', el.id);
}

function initInfiniteScrollEditors() {
  const a = document.getElementById('inlineArea');
  const b = document.getElementById('editorArea');
  console.log('[infScroll] init, inlineArea =', !!a, 'editorArea =', !!b);
  initInfiniteScrollTextarea(a);
  initInfiniteScrollTextarea(b);
}