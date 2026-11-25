/* =========================================================
   Центр уведомлений — вынесено из app.js (этап разбиения монолита).
   Загружается до app.js; использует общие глобальные функции
   (state, icon, escapeHtml, showToast и т.д.) во время выполнения.
   ========================================================= */

/* =========================================================
   Центр уведомлений
   ========================================================= */
let notifModalEl = null;
let notifState = { items: [], unread: 0 };

function setNotifBadge(n) {
  notifState.unread = n | 0;
  const b = document.getElementById('notifBadge');
  if (!b) return;
  if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = ''; }
  else b.style.display = 'none';
  const btn = document.getElementById('notifBtn');
  if (btn) btn.title = n > 0 ? `Уведомления (${n} новых)` : 'Уведомления';
}

async function loadNotificationCount() {
  try {
    const r = await fetch('/api/notifications/unread-count');
    if (!r.ok) return;
    const d = await r.json();
    setNotifBadge(d.unread || 0);
  } catch {}
}

function notifIcon(type) {
  return ({ ticket: 'message-square', request: 'edit', report: 'warning', mention: 'message', project: 'layers' })[type] || 'bell';
}

function initNotifications() {
  const btn = document.getElementById('notifBtn');
  if (btn) btn.onclick = () => openNotifications();
  loadNotificationCount();
}

function ensureNotifModal() {
  if (notifModalEl) return notifModalEl;
  const el = document.createElement('div');
  el.className = 'modal';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="modal-inner notif-modal-inner">
      <div class="modal-head">
        <span>Уведомления</span>
        <div class="notif-head-actions">
          <button type="button" id="notifReadAll" title="Прочитать все">Прочитать все</button>
          <button type="button" data-close title="Закрыть">${icon('x')}</button>
        </div>
      </div>
      <div id="notifList" class="notif-list"><p class="hint">Загрузка…</p></div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) el.style.display = 'none'; });
  notifModalEl = el;
  el.querySelector('#notifReadAll').onclick = async () => {
    try { await fetch('/api/notifications/read-all', { method: 'POST' }); } catch {}
    await openNotifications();
    loadNotificationCount();
  };
  return el;
}

async function openNotifications() {
  const el = ensureNotifModal();
  el.style.display = 'flex';
  const list = document.getElementById('notifList');
  list.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const r = await fetch('/api/notifications?limit=50');
    const d = await r.json();
    notifState.items = d.items || [];
    setNotifBadge(d.unread || 0);
    renderNotifications();
  } catch (e) {
    list.innerHTML = `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`;
  }
}

function notifTime(iso) {
  const d = new Date(iso);
  const now = Date.now();
  const diff = Math.max(0, now - d.getTime());
  if (diff < 60000) return 'только что';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч назад';
  return d.toLocaleString('ru-RU');
}

function renderNotifications() {
  const list = document.getElementById('notifList');
  if (!notifState.items.length) {
    list.innerHTML = '<p class="hint notif-empty">Пока нет уведомлений.</p>';
    return;
  }
  list.innerHTML = '';
  for (const item of notifState.items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'notif-item' + (item.readAt ? '' : ' unread');
    row.innerHTML = `
      <span class="notif-ico">${icon(notifIcon(item.type), 'sm')}</span>
      <span class="notif-main">
        <span class="notif-title">${escapeHtml(item.title)}</span>
        ${item.body ? `<span class="notif-body">${escapeHtml(item.body)}</span>` : ''}
        <span class="notif-time">${escapeHtml(notifTime(item.createdAt))}</span>
      </span>`;
    row.onclick = () => openNotification(item);
    list.appendChild(row);
  }
}

async function openNotification(item) {
  try {
    if (!item.readAt) {
      await fetch('/api/notifications/' + encodeURIComponent(item.id) + '/read', { method: 'POST' });
      item.readAt = new Date().toISOString();
      setNotifBadge(Math.max(0, notifState.unread - 1));
      renderNotifications();
    }
  } catch {}
  if (notifModalEl) notifModalEl.style.display = 'none';
  const link = item.link || '';
  try {
    if (link.startsWith('ticket:')) {
      const id = link.slice('ticket:'.length);
      await loadTickets(); openChatTab('support'); toggleChat(true); openTicket(id);
    } else if (link.startsWith('chat:project:')) {
      const pid = link.slice('chat:project:'.length);
      if (pid && pid !== state.projectId) await switchProject(pid);
      openChatTab('project'); toggleChat(true);
    } else if (link === 'chat:general') {
      openChatTab('general'); toggleChat(true);
    } else if (link.startsWith('file:')) {
      const rest = link.slice('file:'.length);
      const sep = rest.indexOf(':');
      const pid = sep >= 0 ? rest.slice(0, sep) : '';
      const path = sep >= 0 ? rest.slice(sep + 1) : rest;
      if (pid && pid !== state.projectId) await switchProject(pid);
      if (path) await openFile(path);
    } else if (link.startsWith('project:')) {
      const pid = link.slice('project:'.length);
      if (pid) await switchProject(pid);
    }
  } catch (e) { showToast('Не удалось открыть: ' + e.message); }
}
