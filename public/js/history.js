/* =========================================================
   История версий и diff — вынесено из app.js (этап разбиения монолита).
   Загружается до app.js; использует общие глобальные функции
   (state, icon, escapeHtml, showToast и т.д.) во время выполнения.
   ========================================================= */

/* =========================================================
   История версий файла + diff
   ========================================================= */
let historyModalEl = null;
let historyState = { file: null, entries: [], activeId: null };

function ensureHistoryModal() {
  if (historyModalEl) return historyModalEl;
  const el = document.createElement('div');
  el.className = 'modal';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="modal-inner history-modal-inner">
      <div class="modal-head">
        <span id="historyTitle">История версий</span>
        <button type="button" data-close title="Закрыть">${icon('x')}</button>
      </div>
      <div class="history-body">
        <div id="historyList" class="history-list"><p class="hint">Загрузка…</p></div>
        <div id="historyDiff" class="history-diff"><p class="hint">Выберите версию слева, чтобы увидеть изменения.</p></div>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) el.style.display = 'none'; });
  historyModalEl = el;
  return el;
}

function initHistory() {
  const btn = document.getElementById('historyBtn');
  if (btn) btn.onclick = () => openHistoryModal();
}

async function openHistoryModal() {
  if (!state.projectId || !state.currentFile) return;
  const el = ensureHistoryModal();
  el.style.display = 'flex';
  historyState = { file: state.currentFile, entries: [], activeId: null };
  document.getElementById('historyTitle').textContent = 'История: ' + state.currentFile;
  document.getElementById('historyList').innerHTML = '<p class="hint">Загрузка…</p>';
  document.getElementById('historyDiff').innerHTML = '<p class="hint">Выберите версию слева, чтобы увидеть изменения.</p>';
  try {
    const r = await fetch(`/api/files/${encodeURIComponent(state.projectId)}/history?path=${encodeURIComponent(state.currentFile)}&limit=100`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.statusText);
    historyState.entries = d.entries || [];
    renderHistoryList(d.total || 0);
  } catch (e) {
    document.getElementById('historyList').innerHTML = `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`;
  }
}

function historyActionLabel(action) {
  return ({
    create: 'создан', edit: 'изменён', upload: 'загружен', delete: 'удалён',
    move: 'перемещён', rename: 'переименован', revert: 'откат', mkdir: 'создана папка',
  })[action] || action || 'изменение';
}

function renderHistoryList(total) {
  const box = document.getElementById('historyList');
  if (!historyState.entries.length) {
    box.innerHTML = '<p class="hint">Для этого файла пока нет сохранённых версий.</p>';
    return;
  }
  box.innerHTML = `<p class="hint history-total">Версий: ${total}${total > historyState.entries.length ? ` (показаны последние ${historyState.entries.length})` : ''}</p>`;
  for (const e of historyState.entries) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-item';
    const when = new Date(e.timestamp).toLocaleString('ru-RU');
    row.innerHTML = `
      <span class="history-when">${escapeHtml(when)}</span>
      <span class="history-meta">${escapeHtml(historyActionLabel(e.action))} · ${escapeHtml(e.user || '—')}</span>`;
    row.onclick = () => loadHistoryVersion(e.id, row);
    box.appendChild(row);
  }
}

async function loadHistoryVersion(id, rowEl) {
  document.querySelectorAll('.history-item').forEach(b => b.classList.remove('active'));
  if (rowEl) rowEl.classList.add('active');
  historyState.activeId = id;
  const box = document.getElementById('historyDiff');
  box.innerHTML = '<p class="hint">Загрузка версии…</p>';
  try {
    const r = await fetch(`/api/files/${encodeURIComponent(state.projectId)}/history/${encodeURIComponent(id)}`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.statusText);
    renderHistoryDiff(d.version);
  } catch (e) {
    box.innerHTML = `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`;
  }
}

function diffLines(beforeText, afterText) {
  const a = String(beforeText == null ? '' : beforeText).split('\n');
  const b = String(afterText == null ? '' : afterText).split('\n');
  const MAX = 1200;
  if (a.length > MAX || b.length > MAX || a.length * b.length > 2_000_000) {
    return [
      ...a.map(t => ({ type: 'del', text: t })),
      ...b.map(t => ({ type: 'add', text: t })),
    ];
  }
  // LCS через динамическое программирование по строкам.
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i++] }); }
  while (j < m) { out.push({ type: 'add', text: b[j++] }); }
  return out;
}

function renderHistoryDiff(v) {
  const box = document.getElementById('historyDiff');
  if (!v) { box.innerHTML = '<p class="hint">Версия не найдена.</p>'; return; }
  const before = v.before, after = v.after;
  if (before == null && after == null) {
    box.innerHTML = '<p class="hint">Для этой операции нет сохранённого содержимого (например, переименование или удаление).</p>';
    return;
  }
  const lines = diffLines(before, after);
  const added = lines.filter(l => l.type === 'add').length;
  const removed = lines.filter(l => l.type === 'del').length;
  const dl = [
    before != null ? `<a class="history-dl" href="/api/files/${encodeURIComponent(state.projectId)}/history/${encodeURIComponent(v.id)}/download?side=before">Скачать «до»</a>` : '',
    after != null ? `<a class="history-dl" href="/api/files/${encodeURIComponent(state.projectId)}/history/${encodeURIComponent(v.id)}/download?side=after">Скачать «после»</a>` : '',
  ].filter(Boolean).join('');
  const MAX_SHOW = 600;
  const shown = lines.slice(0, MAX_SHOW);
  const html = shown.map(l => {
    const sign = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
    return `<span class="diff-line diff-${l.type}">${sign} ${escapeHtml(l.text || ' ')}</span>`;
  }).join('');
  box.innerHTML = `
    <div class="history-diff-head">
      <span>${escapeHtml(new Date(v.timestamp).toLocaleString('ru-RU'))} · ${escapeHtml(historyActionLabel(v.action))} · ${escapeHtml(v.user || '—')}</span>
      <span class="diff-stat"><b class="add">+${added}</b> <b class="del">−${removed}</b></span>
    </div>
    ${v.truncated ? '<p class="hint">Содержимое было обрезано в журнале (большой файл или секрет).</p>' : ''}
    <pre class="diff-view">${html}${lines.length > MAX_SHOW ? `\n… ещё ${lines.length - MAX_SHOW} строк` : ''}</pre>
    <div class="history-dl-row">${dl}</div>`;
}
