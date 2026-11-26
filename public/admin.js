let me = null;
let allUsers = [];
let allPunishments = [];
let allInvites = [];
const _alert   = (m) => window.uiDialog ? window.uiDialog.alert(m) : window.alert(m);
const _confirm = async (m) => window.uiDialog ? await window.uiDialog.confirm(m) : window.confirm(m);
const _prompt  = async (m, d) => window.uiDialog ? await window.uiDialog.prompt(m, d) : window.prompt(m, d);

const icon = (name, cls='') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

(async function () {
  const r = await fetch('/api/me');
  const data = await r.json();
  if (!data.user) return location.href = '/login.html';
  if (data.user.role !== 'admin') return location.href = '/';
  me = data.user;

  applyTheme(data.theme || 'dark');

  document.getElementById('userLabel').textContent = me.username + ' · Администратор';
  document.getElementById('logoutBtn').onclick = async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  };
  document.getElementById('themeBtn').onclick = toggleTheme;

  document.querySelectorAll('.admin-tabs .tab').forEach(t =>
    t.onclick = () => switchTab(t.dataset.tab));
  document.getElementById('createUserForm').onsubmit = createUser;
  document.getElementById('dashboardRefresh').onclick = loadDashboard;
  document.getElementById('backupRunBtn').onclick = runBackup;
  document.getElementById('exportDataBtn').onclick = exportMetadata;
  document.getElementById('importDataBtn').onclick = () => document.getElementById('importDataFile').click();
  document.getElementById('importDataFile').onchange = importMetadata;
  document.getElementById('refreshChanges').onclick = loadChanges;
  document.getElementById('refreshPunishments').onclick = loadPunishments;
  document.getElementById('refreshInvites').onclick = loadInvites;
  document.getElementById('settingsForm').onsubmit = saveSettings;
  document.getElementById('chatSettingsForm').onsubmit = saveChatSettings;
  document.getElementById('usersSearch').addEventListener('input', renderUsers);
  document.getElementById('invitesSearch').addEventListener('input', renderInvites);
  document.getElementById('invitesFilter').addEventListener('change', renderInvites);
  document.getElementById('genInviteForm').onsubmit = generateInvites;
  document.getElementById('manualInviteForm').onsubmit = createManualInvite;

  // По умолчанию открываем «Обзор» (раньше показывалась вкладка «Пользователи»).
  switchTab('dashboard');

  if (me.role === 'admin') {
    document.getElementById('telemetryTab').style.display = '';
    document.getElementById('darcusTab').style.display = '';
    document.getElementById('adsTab').style.display = '';
    document.getElementById('subsTab').style.display = '';
    document.getElementById('bugsTab').style.display = '';
    document.getElementById('voiceTab').style.display = '';
    document.getElementById('refreshTelemetry').onclick = loadTelemetryUsers;
    document.getElementById('telemetrySearch').addEventListener('input', renderTelemetryUsers);
    document.getElementById('bugsRefresh').onclick = loadBugs;
    initVoiceAdmin();
    loadDarcusConfig().catch(()=>{});
    loadAdsAdmin().catch(()=>{});
    loadSubsAdmin().catch(()=>{});
    loadBugs().catch(()=>{});
  }

  // Прямая ссылка из уведомления: /admin.html#bugs
  if (location.hash === '#bugs') switchTab('bugs');

  document.addEventListener('click', e => {
    const pm = document.getElementById('punishMenu');
    if (pm && !pm.contains(e.target)) pm.style.display = 'none';
  });
  document.getElementById('punishCloseBtn').onclick =
  document.getElementById('punishCancelBtn').onclick = () =>
    document.getElementById('punishModal').style.display = 'none';
  document.getElementById('punishForm').onsubmit = submitPunishment;

  // Каждая вкладка грузится независимо: раньше один сбой API убивал всю админку.
  const tasks = [
    ['users', loadUsers], ['invites', loadInvites], ['punishments', loadPunishments],
    ['changes', loadChanges], ['settings', loadSettings],
  ];
  if (me.role === 'admin') tasks.push(['telemetry', loadTelemetryUsers]);
  for (const [name, fn] of tasks) {
    try { await fn(); }
    catch (e) { console.error('admin load', name, e); setTimeout(() => _alert('Не удалось загрузить раздел «' + name + '»: ' + e.message), 0); }
  }
})();

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const u = document.querySelector('#themeBtn use');
  if (u) u.setAttribute('href', t === 'dark' ? '#i-moon' : '#i-sun');
}
async function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    await fetch('/api/account/theme', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next })
    });
  } catch {}
}

function switchTab(name) {
  document.querySelectorAll('.admin-tabs .tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name));
  const tabs = ['dashboard','users','invites','punishments','changes','settings','telemetry','darcus','ads','subs','bugs','voice'];
  for (const id of tabs) {
    const el = document.getElementById('tab-' + id);
    if (el) el.style.display = id === name ? '' : 'none';
  }
  if (name === 'dashboard') loadDashboard();
  if (name === 'darcus') loadDarcusConfig();
  if (name === 'ads')    loadAdsAdmin();
  if (name === 'subs')   loadSubsAdmin();
  if (name === 'bugs')   loadBugs();
  if (name === 'voice')  loadVoiceAdmin();
}
window.switchTab = switchTab;

/* ============ Дашборд ============ */
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' КБ';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' МБ';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' ГБ';
}
function formatUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return `${d} д ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  return `${m} мин`;
}
async function loadDashboard() {
  const box = document.getElementById('dashboardBody');
  if (!box) return;
  box.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const r = await fetch('/api/admin/dashboard');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    renderDashboard(d);
  } catch (e) {
    box.innerHTML = `<p class="err">Не удалось загрузить состояние: ${escapeHtml(e.message)}</p>`;
  }
}
function dashRow(label, value) {
  return `<div class="dash-row"><span>${escapeHtml(label)}</span><b>${value}</b></div>`;
}
function renderDashboard(d) {
  const box = document.getElementById('dashboardBody');
  if (!box) return;
  const s = d.storage || {};
  const sz = d.sizes || {};
  const models = (d.ai && d.ai.models) || [];
  const backups = d.backups || [];

  const modelRows = models.map(m => {
    const name = m.name || '—';
    const chip = !m.name ? '<span class="dash-chip muted">не задана</span>'
      : m.installed ? '<span class="dash-chip ok">установлена</span>'
      : '<span class="dash-chip warn">отсутствует</span>';
    return `<div class="dash-row"><span>${escapeHtml(m.role)}: <code>${escapeHtml(name)}</code></span>${chip}</div>`;
  }).join('');

  const backupRows = backups.length
    ? backups.map(b => `<div class="dash-row"><span>${escapeHtml(new Date(b.createdAt).toLocaleString('ru-RU'))}${b.withProjects ? ' · с проектами' : ''}</span><b>${formatBytes(b.sizeBytes)}</b></div>`).join('')
    : '<p class="hint">Бэкапов ещё нет. Нажмите «Создать бэкап».</p>';

  box.innerHTML = `
    <div class="dash-grid">
      <div class="dash-card">
        <h3>${icon('monitor','sm')} Система</h3>
        ${dashRow('Статус', '<span class="dash-chip ok">работает</span>')}
        ${dashRow('Окружение', escapeHtml(d.env))}
        ${dashRow('Node.js', escapeHtml(d.node))}
        ${dashRow('Uptime', escapeHtml(formatUptime(d.uptimeSec || 0)))}
      </div>
      <div class="dash-card">
        <h3>${icon('database','sm')} База данных</h3>
        ${dashRow('Размер', formatBytes(s.sizeBytes))}
        ${dashRow('Пользователи', s.users ?? '—')}
        ${dashRow('Проекты', s.projects ?? '—')}
        ${dashRow('Журнал изменений', s.changes ?? '—')}
        ${dashRow('События телеметрии', s.telemetry ?? '—')}
        ${dashRow('Уведомления', s.notifications ?? '—')}
        ${dashRow('Активные сессии', s.sessions ?? '—')}
        ${dashRow('Версия схемы', s.schemaVersion ?? '—')}
      </div>
      <div class="dash-card">
        <h3>${icon('layers','sm')} Данные на диске</h3>
        ${dashRow('База', formatBytes(sz.db))}
        ${dashRow('Лог', formatBytes(sz.log))}
        ${dashRow('Эмбеддинги', formatBytes(sz.embeddings))}
        ${dashRow('OCR-кэш', formatBytes(sz.ocrCache))}
        ${dashRow('Вложения чатов', formatBytes(sz.attachments))}
        ${dashRow('Файлы проектов', formatBytes(sz.projects))}
        ${dashRow('Все бэкапы', formatBytes(sz.backups))}
      </div>
      <div class="dash-card">
        <h3>${icon('star','sm')} Darcus / Ollama</h3>
        ${dashRow('Ollama', d.ai && d.ai.reachable
          ? '<span class="dash-chip ok">доступна</span>'
          : `<span class="dash-chip warn">недоступна</span>`)}
        ${d.ai && d.ai.error ? `<p class="hint">${escapeHtml(d.ai.error)}</p>` : ''}
        ${modelRows}
        <p class="hint">Модели задаются во вкладке Darcus.</p>
      </div>
      <div class="dash-card dash-card-wide">
        <h3>${icon('download','sm')} Бэкапы <span class="hint" style="font-weight:400">(последние ${backups.length})</span></h3>
        ${backupRows}
      </div>
    </div>`;
}

async function runBackup() {
  const btn = document.getElementById('backupRunBtn');
  const box = document.getElementById('dashboardBody');
  if (!btn || btn.disabled) return;
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = icon('loader','sm') + ' Создаю…';
  try {
    const r = await fetch('/api/admin/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: false }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.statusText);
    await loadDashboard();
    await _alert('Бэкап создан.\n' + (Array.isArray(d.output) ? d.output.slice(-2).join('\n') : ''));
  } catch (e) {
    _alert('Бэкап не удался: ' + e.message);
    if (box) box.insertAdjacentHTML('afterbegin', `<p class="err">Бэкап не удался: ${escapeHtml(e.message)}</p>`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/* ============ Экспорт / импорт метаданных ============ */
async function exportMetadata() {
  try {
    const r = await fetch('/api/admin/export');
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || r.statusText);
    }
    const blob = await r.blob();
    const cd = r.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const name = (m && m[1]) || 'darkarmy-dossier-export.json';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch (e) {
    _alert('Экспорт не удался: ' + e.message);
  }
}

async function importMetadata(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  let snapshot;
  try { snapshot = JSON.parse(await file.text()); }
  catch { return _alert('Файл не является корректным JSON'); }
  if (!snapshot || snapshot.app !== 'darkarmy-dossier')
    return _alert('Это не файл экспорта DarkArmy Dossier');
  const counts = `Пользователей: ${(snapshot.users || []).length}\n` +
    `Проектов: ${(snapshot.projects || []).length}\n` +
    `Документов: ${Object.keys(snapshot.documents || {}).length}`;
  if (!await _confirm(`Импортировать метаданные?\n\n${counts}\n\nТекущие пользователи, проекты и документы будут заменены. Файлы на диске не затрагиваются.`)) return;
  if (!await _confirm('Точно заменить? Без бэкапа это не отменить.')) return;
  try {
    const r = await fetch('/api/admin/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'REPLACE', mode: 'replace', snapshot }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.statusText);
    await _alert(`Импорт завершён.\nПользователей: ${d.users}, проектов: ${d.projects}, документов: ${d.documents}`);
    await loadDashboard();
    await loadUsers().catch(() => {});
  } catch (err) {
    _alert('Импорт не удался: ' + err.message);
  }
}

/* ============ Голос: STT/TTS ============ */
function initVoiceAdmin() {
  const save = document.getElementById('voiceSave');
  if (save) save.onclick = saveVoiceAdmin;
  const iw = document.getElementById('voiceInstallWhisper');
  if (iw) iw.onclick = () => installVoice('whisper');
  const is = document.getElementById('voiceInstallSilero');
  if (is) is.onclick = () => installVoice('silero');
}
async function loadVoiceAdmin() {
  const st = document.getElementById('voiceStatus');
  try {
    const d = await (await fetch('/api/admin/voice')).json();
    const w = d.whisper || {}, t = d.tts || {};
    document.getElementById('voiceSttEngine').value = w.engine === 'faster-whisper' ? 'faster-whisper'
      : (w.binaryPath ? 'whisper.cpp' : '');
    document.getElementById('voiceWhisperModel').value = w.model || w.modelPath || '';
    document.getElementById('voiceWhisperLang').value = w.language || 'ru';
    document.getElementById('voiceTtsUrl').value = t.url || '';
    document.getElementById('voiceTtsVoice').value = t.voice || '';
    if (st) st.innerHTML = `STT: <b>${w.engine === 'faster-whisper' ? 'faster-whisper' : (w.binaryPath || 'браузер')}</b> ·
      TTS: <b>${t.url ? escapeHtml(t.url) : 'браузер'}</b> · Silero-сервер: <b>${d.sileroHealthy ? 'работает' : 'не запущен'}</b>`;
  } catch (e) { if (st) st.textContent = 'Ошибка загрузки: ' + e.message; }
}
async function saveVoiceAdmin() {
  const body = {
    whisper: {
      engine: document.getElementById('voiceSttEngine').value,
      model: document.getElementById('voiceWhisperModel').value.trim(),
      language: document.getElementById('voiceWhisperLang').value.trim() || 'ru',
    },
    tts: {
      url: document.getElementById('voiceTtsUrl').value.trim(),
      voice: document.getElementById('voiceTtsVoice').value.trim(),
    },
  };
  const r = await fetch('/api/admin/voice', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) return _alert('Не удалось сохранить настройки голоса');
  await loadVoiceAdmin();
  _alert('Настройки голоса сохранены');
}
async function installVoice(target) {
  const log = document.getElementById('voiceLog');
  if (log) log.textContent = target === 'whisper' ? 'Установка faster-whisper…' : 'Запуск Silero TTS…';
  try {
    const r = await fetch('/api/admin/voice/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    if (log) log.textContent = d.log || 'Готово';
    await loadVoiceAdmin();
  } catch (e) { if (log) log.textContent = 'Ошибка: ' + e.message; }
}

/* ============ Баг-репорты ============ */
async function loadBugs() {
  const box = document.getElementById('bugsList');
  if (!box) return;
  box.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const r = await fetch('/api/bugs');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    renderBugs(d.items || []);
    const badge = document.getElementById('bugsCount');
    if (badge) {
      const n = (d.items || []).length;
      if (n) { badge.textContent = n; badge.style.display = ''; }
      else badge.style.display = 'none';
    }
  } catch (e) {
    box.innerHTML = `<p class="err">Не удалось загрузить баги: ${escapeHtml(e.message)}</p>`;
  }
}
function renderBugs(items) {
  const box = document.getElementById('bugsList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<p class="hint">Багов нет — отлично.</p>';
    return;
  }
  box.innerHTML = '';
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'bug-card';
    const shot = it.hasScreenshot
      ? `<a class="bug-shot" href="${escapeHtml(it.screenshotUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(it.screenshotUrl)}" alt="Скриншот бага" loading="lazy"></a>`
      : '<div class="bug-shot bug-shot-empty">Без скриншота</div>';
    card.innerHTML = `
      <div class="bug-card-body">
        <div class="bug-card-head">
          <b>${escapeHtml(it.user || '—')}</b>
          <span class="muted">${new Date(it.createdAt).toLocaleString('ru-RU')}</span>
          <span class="bug-page">${escapeHtml(it.page || '')}</span>
        </div>
        <div class="bug-desc">${escapeHtml(it.description || '')}</div>
      </div>
      ${shot}
      <div class="bug-actions">
        <button type="button" data-edit="${escapeHtml(it.id)}">${icon('edit','sm')} Редактировать</button>
        <button type="button" class="danger-btn" data-del="${escapeHtml(it.id)}">${icon('trash','sm')} Исправлено / удалить</button>
      </div>`;
    card.querySelector('[data-edit]').onclick = () => openBugEditor(card, it);
    card.querySelector('[data-del]').onclick = async () => {
      if (!await _confirm('Удалить баг из списка? Скриншот тоже будет удалён.')) return;
      const r = await fetch('/api/bugs/' + encodeURIComponent(it.id), { method: 'DELETE' });
      if (!r.ok) return _alert('Не удалось удалить баг');
      await loadBugs();
    };
    box.appendChild(card);
  }
}

function openBugEditor(card, it) {
  card.innerHTML = `
    <div class="bug-card-body">
      <div class="bug-card-head"><b>${escapeHtml(it.user || '—')}</b><span class="bug-page">${escapeHtml(it.page || '')}</span></div>
      <textarea class="bug-edit-text" rows="5">${escapeHtml(it.description || '')}</textarea>
      <label class="hint">Скриншот: <input type="file" class="bug-edit-shot" accept="image/png,image/jpeg,image/webp"></label>
    </div>
    <div class="bug-actions">
      <button type="button" data-bug-cancel>Отмена</button>
      <button type="button" class="primary" data-bug-save>Сохранить</button>
    </div>`;
  card.querySelector('[data-bug-cancel]').onclick = () => loadBugs();
  card.querySelector('[data-bug-save]').onclick = async () => {
    const description = card.querySelector('.bug-edit-text').value.trim();
    if (!description) return _alert('Описание не может быть пустым');
    const file = card.querySelector('.bug-edit-shot').files[0];
    let screenshot = null;
    if (file) {
      if (file.size > 3 * 1024 * 1024) return _alert('Скриншот больше 3 МБ');
      screenshot = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('read'));
        fr.readAsDataURL(file);
      }).catch(() => null);
      if (!screenshot) return _alert('Не удалось прочитать скриншот');
    }
    const r = await fetch('/api/bugs/' + encodeURIComponent(it.id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, page: it.page, screenshot }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      return _alert('Не удалось сохранить: ' + (d.error || r.statusText));
    }
    await loadBugs();
  };
}

/* ============ Пользователи ============ */
async function loadUsers() {
  allUsers = (await (await fetch('/api/users')).json()).users;
  renderUsers();
}
function renderUsers() {
  const q = (document.getElementById('usersSearch').value || '').toLowerCase().trim();
  const filtered = q
    ? allUsers.filter(u => u.username.toLowerCase().includes(q) || u.role.toLowerCase().includes(q))
    : allUsers;
  document.getElementById('usersCount').textContent =
    q ? `Найдено: ${filtered.length} из ${allUsers.length}` : `Всего: ${allUsers.length}`;
  const tb = document.querySelector('#usersTable tbody');
  tb.innerHTML = '';
  if (!filtered.length) {
    tb.innerHTML = `<tr><td colspan="4" class="hint" style="text-align:center">Никого не найдено</td></tr>`;
    return;
  }
  for (const u of filtered) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <span class="user-tag">${escapeHtml(u.username)}
          ${u.username !== me.username ? `<button class="punish-btn" data-punish="${escapeHtml(u.username)}" title="Наказать">${icon('gavel','sm')}</button>` : ''}
        </span>
      </td>
      <td>
        <select data-id="${u.id}" class="roleSel">
          <option value="member" ${u.role==='member'?'selected':''}>Участник</option>
          <option value="admin"  ${u.role==='admin' ?'selected':''}>Администратор</option>
        </select>
      </td>
      <td>${new Date(u.createdAt).toLocaleString('ru-RU')}</td>
      <td>
        <button data-act="pwd" data-id="${u.id}">${icon('key','sm')} Пароль</button>
        ${u.id !== me.id ? `<button data-act="del" data-id="${u.id}" class="danger">${icon('trash','sm')}</button>` : ''}
      </td>
    `;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('.punish-btn').forEach(b => b.onclick = e => {
    e.stopPropagation();
    showPunishMenu(e.clientX, e.clientY, b.dataset.punish);
  });
  tb.querySelectorAll('.roleSel').forEach(sel => sel.onchange = async e => {
    const r = await fetch('/api/users/' + e.target.dataset.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: e.target.value })
    });
    if (!r.ok) alert('Ошибка: ' + (await r.json()).error);
    else {
      const u = allUsers.find(x => x.id === e.target.dataset.id);
      if (u) u.role = e.target.value;
    }
  });
  tb.querySelectorAll('button[data-act]').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    if (b.dataset.act === 'pwd') {
      const pwd = await _prompt('Новый пароль:');
      if (!pwd) return;
      if (pwd.length < 8) return alert('Пароль минимум 8 символов');
      const r = await fetch('/api/users/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
      });
      if (!r.ok) return alert('Ошибка: ' + (await r.json()).error);
      alert('Пароль обновлён');
    } else if (b.dataset.act === 'del') {
      if (!(await _confirm('Удалить пользователя?'))) return;
      const r = await fetch('/api/users/' + id, { method: 'DELETE' });
      if (!r.ok) return alert('Ошибка: ' + (await r.json()).error);
      await loadUsers();
    }
  });
}
async function createUser(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: fd.get('username'), password: fd.get('password'), role: fd.get('role'),
    }),
  });
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) return _alert('Ошибка: ' + (data.error || r.statusText));
  e.target.reset();
  await loadUsers();
}

/* ============ Приглашения ============ */
async function loadInvites() {
  const r = await fetch('/api/invites');
  if (!r.ok) return;
  const data = await r.json();
  allInvites = data.items || [];
  renderInvites();
}
function renderInvites() {
  const q = (document.getElementById('invitesSearch').value || '').toLowerCase().trim();
  const mode = document.getElementById('invitesFilter').value;
  let list = allInvites;
  if (mode === 'free') list = list.filter(c => !c.usedBy);
  if (mode === 'used') list = list.filter(c => !!c.usedBy);
  if (q) list = list.filter(c =>
    c.code.toLowerCase().includes(q) ||
    (c.note || '').toLowerCase().includes(q) ||
    (c.usedBy || '').toLowerCase().includes(q) ||
    (c.createdBy || '').toLowerCase().includes(q)
  );

  document.getElementById('invitesCount').textContent =
    `Всего: ${allInvites.length} · Показано: ${list.length}`;

  const tb = document.querySelector('#invitesTable tbody');
  tb.innerHTML = '';
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="5" class="hint" style="text-align:center">Кодов нет</td></tr>';
    return;
  }
  for (const c of list) {
    const tr = document.createElement('tr');
    const used = !!c.usedBy;
    tr.innerHTML = `
      <td>
        <code style="font-size:13px;letter-spacing:.05em;color:var(--accent);font-weight:600">${escapeHtml(c.code)}</code>
        <button data-copy="${escapeHtml(c.code)}" title="Скопировать"
          style="margin-left:6px;background:transparent;border:none;color:var(--text-dim);cursor:pointer;padding:2px 4px">
          ${icon('copy','sm')}
        </button>
      </td>
      <td>${c.note ? escapeHtml(c.note) : '<span class="muted">—</span>'}</td>
      <td>
        <div style="font-size:12px">${new Date(c.createdAt).toLocaleString('ru-RU')}</div>
        <div class="muted" style="font-size:11px">${escapeHtml(c.createdBy || '')}</div>
      </td>
      <td>
        ${used
          ? `<span class="badge revert">использован</span>
             <div class="muted" style="font-size:11px;margin-top:3px">
               ${escapeHtml(c.usedBy)} · ${new Date(c.usedAt).toLocaleString('ru-RU')}
             </div>`
          : `<span class="badge user-create">свободен</span>`}
      </td>
      <td>
        <button data-del="${escapeHtml(c.code)}" class="danger">${icon('trash','sm')}</button>
      </td>
    `;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    const code = b.dataset.copy;
    try {
      await navigator.clipboard.writeText(code);
      b.innerHTML = icon('check','sm');
      setTimeout(() => { b.innerHTML = icon('copy','sm'); }, 1200);
    } catch {
      _prompt('Скопируйте код:', code);
    }
  });
  tb.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!(await _confirm(`Удалить код ${b.dataset.del}?`))) return;
    const r = await fetch('/api/invites/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
    if (!r.ok) return alert('Ошибка');
    await loadInvites();
  });
}
async function generateInvites(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const count = parseInt(fd.get('count'), 10) || 1;
  const note = fd.get('note') || '';
  const r = await fetch('/api/invites/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count, note })
  });
  const d = await r.json();
  if (!r.ok) return alert('Ошибка: ' + (d.error || r.statusText));
  await loadInvites();
  const codes = (d.created || []).map(x => x.code).join('\n');
  if (codes) {
    try {
      await navigator.clipboard.writeText(codes);
      alert(`Создано ${d.created.length} код(ов). Скопированы в буфер:\n\n${codes}`);
    } catch {
      alert(`Создано ${d.created.length} код(ов):\n\n${codes}`);
    }
  }
  e.target.reset();
}
async function createManualInvite(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const code = String(fd.get('code') || '').trim().toUpperCase();
  const note = fd.get('note') || '';
  const r = await fetch('/api/invites', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, note })
  });
  const d = await r.json();
  if (!r.ok) return alert('Ошибка: ' + (d.error || r.statusText));
  await loadInvites();
  e.target.reset();
}

/* ============ Наказания ============ */
async function loadPunishments() {
  const r = await fetch('/api/punishments');
  const data = await r.json();
  allPunishments = data.items || [];
  renderPunishments();
}
function renderPunishments() {
  const el = document.getElementById('punishmentsList');
  const now = Date.now();
  const active = allPunishments.filter(p => !p.until || new Date(p.until).getTime() > now);
  if (!active.length) { el.innerHTML = '<p class="hint">Активных наказаний нет.</p>'; return; }
  el.innerHTML = '';
  for (const p of active) {
    const div = document.createElement('div');
    div.className = 'change-item';
    div.innerHTML = `
      <div class="change-head">
        <span class="badge ${p.type === 'ban' ? 'delete' : 'user-update'}">${p.type === 'ban' ? 'БАН' : 'МУТ'}</span>
        <b>${escapeHtml(p.username)}</b>
        <span class="muted">от ${new Date(p.createdAt).toLocaleString('ru-RU')} · ${escapeHtml(p.createdBy || '')}</span>
        <span class="muted">${p.until ? 'до ' + new Date(p.until).toLocaleString('ru-RU') : 'навсегда'}</span>
        <span class="spacer"></span>
        <button data-del="${p.id}" class="danger-btn">${icon('x','sm')} Снять</button>
      </div>
      ${p.reason ? `<div class="details">${escapeHtml(p.reason)}</div>` : ''}
    `;
    el.appendChild(div);
  }
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!(await _confirm('Снять наказание?'))) return;
    await fetch('/api/punishments/' + b.dataset.del, { method: 'DELETE' });
    await loadPunishments();
  });
}
function showPunishMenu(x, y, username) {
  const menu = document.getElementById('punishMenu');
  menu.innerHTML = '';
  menu.style.left = ''; menu.style.top = ''; menu.style.display = 'block';
  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = `${icon('gavel','sm')} ${escapeHtml(username)}`;
  menu.appendChild(title);
  menu.appendChild(punishItem(`${icon('ban','sm')} Забанить`, () => openPunish('ban', username), 'danger'));
  menu.appendChild(punishItem(`${icon('volume-x','sm')} Замутить`, () => openPunish('mute', username)));
  const sep = document.createElement('div'); sep.className = 'sep'; menu.appendChild(sep);
  menu.appendChild(punishItem(`${icon('x','sm')} Снять все наказания`, async () => {
    const r = await fetch('/api/punishments/' + encodeURIComponent(username));
    if (!r.ok) return;
    const d = await r.json();
    for (const p of (d.items || [])) await fetch('/api/punishments/' + p.id, { method: 'DELETE' });
    await loadPunishments();
  }, 'success'));
  const rect = menu.getBoundingClientRect();
  let left = x, top = y;
  if (left + rect.width  > window.innerWidth  - 8) left = window.innerWidth  - rect.width  - 8;
  if (top  + rect.height > window.innerHeight - 8) top  = window.innerHeight - rect.height - 8;
  if (left < 8) left = 8;
  if (top  < 8) top  = 8;
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
}
function punishItem(label, fn, cls='') {
  const el = document.createElement('div');
  el.className = 'item ' + cls;
  el.innerHTML = label;
  el.onclick = e => {
    e.stopPropagation();
    document.getElementById('punishMenu').style.display = 'none';
    fn();
  };
  return el;
}
function openPunish(type, username) {
  const form = document.getElementById('punishForm');
  form.reset();
  form.type.value = type;
  form.username.value = username;
  document.getElementById('punishTitle').innerHTML =
    `${icon(type === 'ban' ? 'ban' : 'volume-x','sm')} ${type === 'ban' ? 'Забанить' : 'Замутить'}`;
  document.getElementById('punishTarget').textContent = 'Пользователь: ' + username;
  document.getElementById('punishModal').style.display = 'flex';
}
async function submitPunishment(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch('/api/punishments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: fd.get('username'),
      type: fd.get('type'),
      duration: fd.get('duration'),
      reason: fd.get('reason')
    })
  });
  const d = await r.json();
  if (!r.ok) return alert('Ошибка: ' + (d.error || r.statusText));
  document.getElementById('punishModal').style.display = 'none';
  await loadPunishments();
}

/* ============ Журнал ============ */
async function loadChanges() {
  const days = document.getElementById('daysFilter').value;
  const file = document.getElementById('fileFilter').value.trim();
  const qs = new URLSearchParams();
  if (days) qs.set('days', days);
  if (file) qs.set('file', file);
  const { entries } = await (await fetch('/api/changes?' + qs)).json();
  const el = document.getElementById('changesList');
  if (!entries.length) { el.innerHTML = '<p class="hint">Изменений не найдено.</p>'; return; }
  el.innerHTML = '';
  for (const e of entries) {
    const div = document.createElement('div');
    div.className = 'change-item';
    const canRevert = !e.reverted && ['edit','upload','create','mkdir','delete','move','rename'].includes(e.action);
    div.innerHTML = `
      <div class="change-head">
        <span class="badge ${e.action}">${e.action}</span>
        <span class="user-tag"><b>${escapeHtml(e.user)}</b>
          ${e.user !== me.username ? `<button class="punish-btn" data-punish="${escapeHtml(e.user)}">${icon('gavel','sm')}</button>` : ''}
        </span>
        <span class="muted">${new Date(e.timestamp).toLocaleString('ru-RU')}</span>
        ${e.file ? `<span class="file">${escapeHtml(e.file)}</span>` : ''}
        ${e.target ? `<span class="target">→ ${escapeHtml(e.target)}</span>` : ''}
        ${e.reverted ? `<span class="badge revert">откачено</span>` : ''}
        <span class="spacer"></span>
        ${canRevert ? `<button class="revert-btn" data-id="${e.id}">${icon('refresh','sm')} Откатить</button>` : ''}
      </div>
      ${e.details ? `<div class="details">${escapeHtml(e.details)}</div>` : ''}
    `;
    el.appendChild(div);
  }
  el.querySelectorAll('.punish-btn').forEach(b => b.onclick = e => {
    e.stopPropagation();
    showPunishMenu(e.clientX, e.clientY, b.dataset.punish);
  });
  el.querySelectorAll('.revert-btn').forEach(b => b.onclick = async () => {
    if (!(await _confirm('Откатить это действие?'))) return;
    const r = await fetch('/api/revert/' + b.dataset.id, { method: 'POST' });
    let data; try { data = await r.json(); } catch { data = {}; }
    if (!r.ok) return alert('Ошибка: ' + (data.error || r.statusText));
    await loadChanges();
  });
}

/* ============ Настройки ============ */
async function loadSettings() {
  const r = await fetch('/api/settings');
  if (!r.ok) return;
  const s = await r.json();
  const upForm = document.querySelector('#settingsForm [name="uploadLimitMB"]');
  if (upForm) upForm.value = s.uploadLimitMB ?? 50;
  const chatForm = document.querySelector('#chatSettingsForm [name="generalChatMode"]');
  if (chatForm) chatForm.value = s.generalChatMode || 'everyone';
}
async function saveSettings(e) {
  e.preventDefault();
  const val = parseInt(e.target.uploadLimitMB.value, 10);
  if (!Number.isFinite(val) || val < 1) return alert('Некорректный лимит');
  const r = await fetch('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadLimitMB: val })
  });
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) return alert('Ошибка: ' + (data.error || r.statusText));
  alert('Сохранено');
}
async function saveChatSettings(e) {
  e.preventDefault();
  const mode = e.target.generalChatMode.value;
  const r = await fetch('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ generalChatMode: mode })
  });
  let data; try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) return alert('Ошибка: ' + (data.error || r.statusText));
  alert('Сохранено');
}

/* ============ Телеметрия ============ */
let telemetryUsers = [];
let telemetrySelected = null;
async function loadTelemetryUsers() {
  try {
    const r = await fetch('/api/telemetry');
    if (!r.ok) {
      document.getElementById('telemetryUsers').innerHTML =
        `<p class="err">Доступ запрещён</p>`;
      return;
    }
    const data = await r.json();
    telemetryUsers = data.users || [];
    renderTelemetryUsers();
  } catch (e) {
    document.getElementById('telemetryUsers').innerHTML =
      `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`;
  }
}
function renderTelemetryUsers() {
  const q = (document.getElementById('telemetrySearch').value || '').toLowerCase().trim();
  const filtered = q
    ? telemetryUsers.filter(u => u.username.toLowerCase().includes(q))
    : telemetryUsers;
  const box = document.getElementById('telemetryUsers');
  box.innerHTML = '';
  if (!filtered.length) { box.innerHTML = '<p class="hint">Нет данных</p>'; return; }
  for (const u of filtered) {
    const el = document.createElement('div');
    el.className = 'telemetry-user' + (u.username === telemetrySelected ? ' active' : '');
    const lastSeen = u.lastSeen ? new Date(u.lastSeen).toLocaleString('ru-RU') : '—';
    const dev = u.lastClient
      ? `<div class="telemetry-user-device">${icon('monitor','sm')} ${escapeHtml(u.lastClient.screen || '?')} · ${escapeHtml(u.lastClient.platform || '?')} · ${escapeHtml(u.lastClient.ip || '')}</div>`
      : '';
    el.innerHTML = `
      <div class="telemetry-user-name">${icon('user','sm')} ${escapeHtml(u.username)}</div>
      <div class="telemetry-user-meta">${u.events} событий · последний: ${lastSeen}</div>
      ${dev}
    `;
    el.onclick = () => { telemetrySelected = u.username; renderTelemetryUsers(); loadTelemetryEvents(u.username); };
    box.appendChild(el);
  }
}
async function loadTelemetryEvents(username) {
  const box = document.getElementById('telemetryEvents');
  box.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const r = await fetch('/api/telemetry/' + encodeURIComponent(username));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const { telemetry } = await r.json();
    renderTelemetryEvents(telemetry);
  } catch (e) {
    box.innerHTML = `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`;
  }
}
function renderTelemetryEvents(t) {
  const box = document.getElementById('telemetryEvents');
  box.innerHTML = '';
  const meta = document.createElement('div');
  meta.className = 'telemetry-meta';
  meta.innerHTML = `
    <div><b>Логин:</b> ${escapeHtml(t.username)}</div>
    <div><b>Первый визит:</b> ${new Date(t.firstSeen).toLocaleString('ru-RU')}</div>
    <div><b>Последний визит:</b> ${new Date(t.lastSeen).toLocaleString('ru-RU')}</div>
    <div><b>Всего событий:</b> ${t.events.length}</div>
  `;
  box.appendChild(meta);
  const actions = document.createElement('div');
  actions.style.margin = '10px 0';
  const clearBtn = document.createElement('button');
  clearBtn.innerHTML = icon('trash','sm') + ' Очистить события';
  clearBtn.className = 'danger-btn';
  clearBtn.onclick = async () => {
    if (!(await _confirm('Очистить телеметрию этого пользователя?'))) return;
    const r = await fetch('/api/telemetry/' + encodeURIComponent(t.username) + '/clear', { method: 'POST' });
    if (!r.ok) return alert('Ошибка');
    await loadTelemetryUsers();
    loadTelemetryEvents(t.username);
  };
  actions.appendChild(clearBtn);
  box.appendChild(actions);
  const list = document.createElement('div');
  list.className = 'telemetry-list';
  const events = (t.events || []).slice().reverse().slice(0, 500);
  for (const e of events) {
    const el = document.createElement('div');
    el.className = 'telemetry-event telemetry-' + (e.type || 'unknown');
    const ts = new Date(e.ts).toLocaleString('ru-RU');
    const ic = (n) => `<svg class="ico sm" aria-hidden="true"><use href="#i-${n}"/></svg>`;
    let body = '';
    if (e.type === 'request') body = `<b>${escapeHtml(e.method)}</b> ${escapeHtml(e.path)} → <b>${e.status}</b> · ${e.ms} мс`;
    else if (e.type === 'login') body = ic('unlock') + ' Вход';
    else if (e.type === 'logout') body = ic('lock') + ' Выход';
    else if (e.type === 'register') body = ic('user-plus') + ' Регистрация' + (e.invite ? ` (код ${escapeHtml(e.invite)})` : '');
    else if (e.type === 'password-change') body = ic('key') + ' Смена пароля';
    else if (e.type === 'self-delete') body = ic('x-circle') + ' Удалил аккаунт';
    else if (e.type === 'client-info') {
      const extra = [];
      if (e.viewport) extra.push('экран ' + e.viewport);
      if (e.lang || e.langs) extra.push('язык ' + (e.langs || e.lang));
      if (e.cores) extra.push('CPU ' + e.cores);
      if (e.memory) extra.push('RAM ' + e.memory + ' ГБ');
      if (e.touch) extra.push('touch ' + e.touch);
      if (e.connType) extra.push('сеть ' + e.connType + (e.downlink ? ' ' + e.downlink + ' Мбит/с' : ''));
      if (e.colorScheme) extra.push('тема ' + e.colorScheme);
      if (e.pwa) extra.push(e.pwa);
      body = ic('monitor') + ` ${escapeHtml(e.screen || '?')} · ${escapeHtml(e.platform || '?')} · ${escapeHtml(e.tz || '?')}` +
        (extra.length ? `<div class="telemetry-extra">${escapeHtml(extra.join(' · '))}</div>` : '');
    }
    else body = escapeHtml(e.type);
    const ip = e.ip ? `<span class="telemetry-ip">IP: ${escapeHtml(e.ip)}</span>` : '';
    const ua = e.ua ? `<div class="telemetry-ua">${escapeHtml(e.ua)}</div>` : '';
    el.innerHTML = `
      <div class="telemetry-event-head">
        <span class="telemetry-ts">${ts}</span>
        <span class="telemetry-type">${escapeHtml(e.type)}</span>
        ${ip}
      </div>
      <div class="telemetry-event-body">${body}</div>
      ${ua}
    `;
    list.appendChild(el);
  }
  box.appendChild(list);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* =========================================================
   ADMIN EXTENSIONS: Darcus, Ads, Subscriptions
   ========================================================= */

/* ---------- Darcus ---------- */
async function loadDarcusConfig() {
  try {
    const c = await (await fetch('/api/darcus/config')).json();
    const f = document.getElementById('darcusOllamaForm');
    if (!f) return;
    f.url.value = c.ollama.url;
    f.chatModel.value = c.ollama.chatModel;
    f.visionModel.value = c.ollama.visionModel;
    f.embedModel.value = c.ollama.embedModel;
    if (f.rerankModel) f.rerankModel.value = c.ollama.rerankModel || '';
    f.numCtx.value = c.ollama.numCtx;
    f.temperature.value = c.ollama.temperature;
    f.timeout.value = c.ollama.timeout;

    const pf = document.getElementById('darcusPromptsForm');
    if (pf) for (const k of ['system','chat','rephrase','shorten','fix','translate','summarize','generate_doc','ocr','vision',
  'template_readme','template_meeting','template_checklist','template_report','template_note']) {
      if (pf[k]) pf[k].value = c.prompts[k] || '';
    }
  } catch (e) { console.warn('loadDarcusConfig:', e); }
}

const _darcusOllamaForm = document.getElementById('darcusOllamaForm');
if (_darcusOllamaForm) _darcusOllamaForm.onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const body = { ollama: {
    url: f.url.value.trim(),
    chatModel: f.chatModel.value.trim(),
    visionModel: f.visionModel.value.trim(),
    embedModel: f.embedModel.value.trim(),
    numCtx: parseInt(f.numCtx.value, 10) || 4096,
    temperature: parseFloat(f.temperature.value) || 0.7,
    timeout: parseInt(f.timeout.value, 10) || 180000,
    rerankModel: f.rerankModel ? f.rerankModel.value.trim() : '',
  }};
  const r = await fetch('/api/darcus/config', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) return alert('Ошибка');
  alert('Сохранено');
};

const _darcusPromptsForm = document.getElementById('darcusPromptsForm');
if (_darcusPromptsForm) _darcusPromptsForm.onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const prompts = {};
  for (const k of ['system','chat','rephrase','shorten','fix','translate','summarize','generate_doc','ocr','vision',
  'template_readme','template_meeting','template_checklist','template_report','template_note']) {
    if (f[k]) prompts[k] = f[k].value;
  }
  const r = await fetch('/api/darcus/config', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompts })
  });
  if (!r.ok) return alert('Ошибка');
  alert('Промпты сохранены');
};

// FIX: guard против null
const _darcusTestBtn = document.getElementById('darcusTestBtn');
if (_darcusTestBtn) _darcusTestBtn.onclick = async () => {
  const msg = document.getElementById('darcusTestMsg');
  if (msg) msg.textContent = 'Проверяем…';
  const r = await fetch('/api/darcus/test', { method: 'POST' });
  const d = await r.json();
  if (msg) msg.innerHTML = d.ok
    ? icon('check-circle','sm') + ' OK. Модели: ' + (d.models || []).slice(0, 5).join(', ')
    : icon('x-circle','sm') + ' ' + escapeHtml(d.error || 'Ошибка');
};

const _darcusLoadModelsBtn = document.getElementById('darcusLoadModelsBtn');
if (_darcusLoadModelsBtn) _darcusLoadModelsBtn.onclick = async () => {
  const r = await fetch('/api/darcus/models');
  const d = await r.json();
  const list = document.getElementById('darcusModels');
  if (!list) return;
  list.innerHTML = '';
  if (d.ok) for (const m of d.models) {
    const o = document.createElement('option'); o.value = m.name; list.appendChild(o);
  } else alert(d.error || 'Ошибка');
};

const _darcusReindexBtn = document.getElementById('darcusReindexBtn');
if (_darcusReindexBtn) _darcusReindexBtn.onclick = async () => {
  const msg = document.getElementById('darcusTestMsg');
  if (msg) msg.textContent = 'Индексация… это может занять время';
  _darcusReindexBtn.disabled = true;
  const oldHtml = _darcusReindexBtn.innerHTML;
  _darcusReindexBtn.innerHTML = icon('loader','sm spin') + ' Индексация…';
  try {
    const r = await fetch('/api/darcus/reindex', { method: 'POST' });
    const d = await r.json();
    if (!r.ok || !d.ok) {
      if (msg) msg.innerHTML = icon('x-circle','sm') + ' ' + escapeHtml(d.error || r.statusText);
    } else {
      if (msg) msg.innerHTML = icon('check-circle','sm') +
        ` Готово. Проиндексировано: <b>${d.indexed}</b>, пропущено: ${d.skipped}, ошибок: ${d.errors}, всего в кэше: <b>${d.total}</b> (модель: ${escapeHtml(d.model || '—')})`;
      _alert('Индексирование завершено');
    }
  } catch (e) {
    if (msg) msg.textContent = 'Ошибка: ' + e.message;
  } finally {
    _darcusReindexBtn.disabled = false;
    _darcusReindexBtn.innerHTML = oldHtml;
  }
};

/* ---------- Реклама ---------- */
async function loadAdsAdmin() {
  try {
    const r = await fetch('/api/ads/admin/list');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    renderAdsSlots(d.slots || {});
    renderAdsGrid(d.images || []);
    renderAdsDistribution(d);
    const cnt = document.getElementById('adsCount');
    if (cnt) cnt.textContent = `${(d.images || []).length} загружено`;
  } catch (e) { console.error('loadAdsAdmin:', e); }
}
function renderAdsSlots(slots) {
  const el = document.getElementById('adsSlotsList');
  if (!el) return;
  el.innerHTML = '';
  for (const [k, s] of Object.entries(slots)) {
    const row = document.createElement('div');
    row.className = 'change-item';
    row.innerHTML = `
      <div class="change-head">
        <b>${escapeHtml(k)}</b>
        <span class="muted">${escapeHtml(s.note || '')}</span>
        <label style="margin-left:auto;display:flex;align-items:center;gap:6px">
          <input type="checkbox" ${s.enabled ? 'checked' : ''} data-slot-en="${escapeHtml(k)}"> Вкл
        </label>
        <label style="display:flex;align-items:center;gap:6px">
          Интервал: <input type="number" min="3" max="3600" value="${s.interval}" data-slot-int="${escapeHtml(k)}" style="width:80px">
        </label>
      </div>`;
    el.appendChild(row);
  }
  el.querySelectorAll('[data-slot-en]').forEach(c => c.onchange = saveSlot);
  el.querySelectorAll('[data-slot-int]').forEach(c => c.onchange = saveSlot);
  async function saveSlot() {
    const slots = {};
    el.querySelectorAll('[data-slot-en]').forEach(x => {
      const k = x.dataset.slotEn;
      slots[k] = slots[k] || {};
      slots[k].enabled = x.checked;
    });
    el.querySelectorAll('[data-slot-int]').forEach(x => {
      const k = x.dataset.slotInt;
      slots[k] = slots[k] || {};
      slots[k].interval = parseInt(x.value, 10) || 20;
    });
    await fetch('/api/ads/slots', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots })
    });
    loadAdsAdmin();
  }
}
function renderAdsGrid(images) {
  const el = document.getElementById('adsGrid');
  if (!el) return;
  el.innerHTML = '';
  if (!images.length) { el.innerHTML = '<p class="hint">Пусто</p>'; return; }
  for (const im of images) {
    const card = document.createElement('div');
    card.className = 'ads-card';
    card.innerHTML = `<img src="/api/ads/file/${encodeURIComponent(im.filename)}" alt="" loading="lazy" decoding="async">
      <div class="ads-card-meta">${escapeHtml(im.originalName)}</div>
      <label class="ads-toggle"><input type="checkbox" data-en ${im.enabled !== false ? 'checked' : ''}> Показывать</label>
      <label class="ads-toggle"><input type="checkbox" data-all ${im.allSlots ? 'checked' : ''}> На всех баннерах</label>
      <button class="danger" data-del="${im.id}">Удалить</button>`;
    el.appendChild(card);
    card.querySelector('[data-en]').onchange = async e => {
      await fetch('/api/ads/images/' + encodeURIComponent(im.id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: e.target.checked }),
      });
      loadAdsAdmin();
    };
    card.querySelector('[data-all]').onchange = async e => {
      await fetch('/api/ads/images/' + encodeURIComponent(im.id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allSlots: e.target.checked }),
      });
      loadAdsAdmin();
    };
    card.querySelector('[data-del]').onclick = async () => {
      if (!(await _confirm('Удалить картинку?'))) return;
      await fetch('/api/ads/images/' + im.id, { method: 'DELETE' });
      loadAdsAdmin();
    };
  }
}
/* Клиентская оптимизация баннера: уменьшаем до 1600px и жмём в JPEG. */
function optimizeAdImage(file, maxW = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) return reject(new Error('not raster'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        c.toBlob(b => {
          URL.revokeObjectURL(url);
          if (!b) return reject(new Error('canvas'));
          resolve(new File([b], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', quality);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}
function renderAdsDistribution(d) {
  const el = document.getElementById('adsDistribution');
  if (!el) return;
  el.innerHTML = '';
  for (const [slot, ids] of Object.entries(d.distribution || {})) {
    if (!ids.length) continue;
    const wrap = document.createElement('div');
    wrap.className = 'ads-dist-block';
    wrap.innerHTML = `<b>${escapeHtml(slot)}</b> · ${ids.length} картинок`;
    el.appendChild(wrap);
  }
}
const _adsUploadForm = document.getElementById('adsUploadForm');
if (_adsUploadForm) _adsUploadForm.onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const file = f.file.files[0];
  if (!file) return _alert('Выберите файл');
  const fd = new FormData();
  let uploadFile = file;
  // Оптимизация: большие PNG/JPEG пережимаем на клиенте до 1600px JPEG q0.85
  try {
    if (/^image\/(png|jpe?g|webp)$/i.test(file.type) && file.size > 150 * 1024)
      uploadFile = await optimizeAdImage(file);
  } catch {}
  fd.append('file', uploadFile);
  const btn = f.querySelector('button[type="submit"]');
  const oldHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Загрузка…'; }
  try {
    const r = await fetch('/api/ads/upload', { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 403) throw new Error('Только главный админ (login: admin) может загружать рекламу');
      if (r.status === 413) throw new Error('Файл больше 5 МБ');
      throw new Error(d.error || ('HTTP ' + r.status));
    }
    f.reset();
    await loadAdsAdmin();
    _alert('Реклама загружена');
  } catch (err) {
    _alert('Ошибка: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }
  }
};

/* ---------- Подписки ---------- */
async function loadSubsAdmin() {
  try {
    const r = await fetch('/api/subscriptions');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();

    const tb = document.querySelector('#subsTable tbody');
    if (tb) {
      tb.innerHTML = '';
      const active = d.active || [];
      if (!active.length) {
        tb.innerHTML = `<tr><td colspan="4" class="hint" style="text-align:center">Активных подписок нет</td></tr>`;
      } else {
        for (const a of active) {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${escapeHtml(a.username)}</td>
            <td>${a.until ? new Date(a.until).toLocaleString('ru-RU') : '∞'}</td>
            <td>${escapeHtml(a.grantedBy || '—')}</td>
            <td><button data-rev="${escapeHtml(a.username)}" class="danger">Отозвать</button></td>`;
          tb.appendChild(tr);
        }
        tb.querySelectorAll('[data-rev]').forEach(b => b.onclick = async () => {
          if (!(await _confirm('Отозвать подписку?'))) return;
          await fetch('/api/subscriptions/' + encodeURIComponent(b.dataset.rev), { method: 'DELETE' });
          loadSubsAdmin();
        });
      }
    }

    const tb2 = document.querySelector('#subsCodesTable tbody');
    if (tb2) {
      tb2.innerHTML = '';
      const codes = d.codes || [];
      if (!codes.length) {
        tb2.innerHTML = `<tr><td colspan="5" class="hint" style="text-align:center">Кодов нет</td></tr>`;
      } else {
        for (const c of codes) {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td><code>${escapeHtml(c.code)}</code></td>
            <td>${c.days}</td>
            <td>${new Date(c.createdAt).toLocaleString('ru-RU')}</td>
            <td>${c.usedBy ? '<span class="badge revert">использован</span>' : '<span class="badge user-create">свободен</span>'}</td>
            <td><button data-delcode="${escapeHtml(c.code)}" class="danger">×</button></td>`;
          tb2.appendChild(tr);
        }
        tb2.querySelectorAll('[data-delcode]').forEach(b => b.onclick = async () => {
          if (!(await _confirm('Удалить код?'))) return;
          await fetch('/api/subscriptions/codes/' + encodeURIComponent(b.dataset.delcode), { method: 'DELETE' });
          loadSubsAdmin();
        });
      }
    }
  } catch (e) { console.error('loadSubsAdmin:', e); }
}
const _subsGrantForm = document.getElementById('subsGrantForm');
if (_subsGrantForm) _subsGrantForm.onsubmit = async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch('/api/subscriptions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: fd.get('username'),
      days: parseInt(fd.get('days'), 10),
      note: fd.get('note')
    })
  });
  const d = await r.json();
  if (!r.ok) return _alert('Ошибка: ' + (d.error || r.statusText));
  e.target.reset();
  loadSubsAdmin();
};
const _subsCodesForm = document.getElementById('subsCodesForm');
if (_subsCodesForm) _subsCodesForm.onsubmit = async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const r = await fetch('/api/subscriptions/codes/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      count: parseInt(fd.get('count'), 10),
      days: parseInt(fd.get('days'), 10),
      note: fd.get('note')
    })
  });
  const d = await r.json();
  if (!r.ok) return _alert('Ошибка: ' + (d.error || r.statusText));
  const codes = (d.created || []).map(c => c.code).join('\n');
  if (codes) _alert('Создано:\n\n' + codes);
  loadSubsAdmin();
};
const _refreshSubs = document.getElementById('refreshSubs');
if (_refreshSubs) _refreshSubs.onclick = loadSubsAdmin;