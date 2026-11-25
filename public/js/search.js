/* =========================================================
   Поиск (файлы/сущности) — вынесено из app.js (этап разбиения монолита).
   Загружается до app.js; использует общие глобальные функции
   (state, icon, escapeHtml, showToast и т.д.) во время выполнения.
   ========================================================= */

/* Search */
function initSearch() {
  const modalEl = document.getElementById('searchModal');
  const input   = document.getElementById('searchInput');
  const results = document.getElementById('searchResults');
  const closeBtn = document.getElementById('searchCloseBtn');
  const allBox = document.getElementById('searchAllProjects');
  document.getElementById('searchBtn').onclick = () => {
    modalEl.style.display = 'flex'; input.value = '';
    results.innerHTML = '<p class="hint">Введите минимум 2 символа</p>';
    setTimeout(() => input.focus(), 50);
  };
  closeBtn.onclick = () => modalEl.style.display = 'none';
  modalEl.addEventListener('click', e => { if (e.target === modalEl) modalEl.style.display = 'none'; });
  let timer = null;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 350); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); runSearch(); } });
  allBox.addEventListener('change', () => { if (input.value.trim().length >= 2) runSearch(); });
  async function runSearch() {
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = '<p class="hint">Введите минимум 2 символа</p>'; return; }
    results.innerHTML = '<p class="hint">Поиск…</p>';
    try {
      const all = allBox.checked;
      const fileUrl = all ? `/api/search-all?q=${encodeURIComponent(q)}`
        : `/api/search?projectId=${encodeURIComponent(state.projectId)}&q=${encodeURIComponent(q)}`;
      // Файлы ищем в текущем/всех проектах; проекты, сообщения, задачи и людей — всегда глобально.
      const [fileRes, entRes] = await Promise.all([
        fetch(fileUrl),
        fetch(`/api/search/entities?q=${encodeURIComponent(q)}`),
      ]);
      const fileData = await fileRes.json().catch(() => ({}));
      if (!fileRes.ok) throw new Error(fileData.error || fileRes.statusText);
      const entData = entRes.ok ? await entRes.json().catch(() => ({})) : {};
      renderSearchResults(fileData.results || [], q, all, entData);
    } catch (e) { results.innerHTML = `<p class="err">Ошибка: ${escapeHtml(e.message)}</p>`; }
  }

  function entityRow(iconName, titleHtml, subHtml, onClick, extraClass = '') {
    const el = document.createElement('div');
    el.className = 'search-item search-entity ' + extraClass;
    el.innerHTML = `
      <div class="search-item-body">
        <div class="search-item-content">
          <div class="search-item-head">
            <span class="icon">${icon(iconName, 'sm')}</span>
            <span class="path">${titleHtml}</span>
          </div>
          ${subHtml ? `<div class="search-snippet">${subHtml}</div>` : ''}
        </div>
      </div>`;
    el.onclick = onClick;
    return el;
  }

  function addEntitySection(title, items, buildRow) {
    if (!items.length) return;
    const head = document.createElement('div');
    head.className = 'search-section-head';
    head.textContent = `${title} · ${items.length}`;
    results.appendChild(head);
    for (const it of items) results.appendChild(buildRow(it));
  }

  function renderSearchResults(list, q, showProject, entities) {
    const ent = entities || {};
    const projects = ent.projects || [];
    const messages = ent.messages || [];
    const tasks = ent.tasks || [];
    const users = ent.users || [];
    const totalEntities = projects.length + messages.length + tasks.length + users.length;
    if (!list.length && !totalEntities) { results.innerHTML = '<p class="hint">Ничего не найдено</p>'; return; }

    results.innerHTML = '';
    const summary = document.createElement('p'); summary.className = 'hint search-summary';
    summary.textContent = `Файлы: ${list.length} · Проекты: ${projects.length} · Сообщения: ${messages.length} · Задачи: ${tasks.length} · Люди: ${users.length}`;
    results.appendChild(summary);

    addEntitySection('Проекты', projects, (p) =>
      entityRow('layers', highlightPath(p.name, q), 'Перейти к проекту', async () => {
        modalEl.style.display = 'none';
        await switchProject(p.id);
      }, 'entity-project'));

    addEntitySection('Сообщения', messages, (m) =>
      entityRow('message', `${escapeHtml(m.from || '—')} <span class="search-entity-scope">${m.chat === 'general' ? 'общий чат' : escapeHtml(m.projectName || 'чат проекта')}</span>`,
        highlightSnippet(m.text, q), async () => {
          modalEl.style.display = 'none';
          if (m.chat === 'general') { openChatTab('general'); toggleChat(true); }
          else {
            if (m.projectId && m.projectId !== state.projectId) await switchProject(m.projectId);
            openChatTab('project'); toggleChat(true);
          }
        }, 'entity-message'));

    addEntitySection('Задачи', tasks, (t) =>
      entityRow(t.done ? 'check-circle' : 'square', escapeHtml(t.text.slice(0, 120)) + (t.done ? ' <span class="search-entity-scope">выполнена</span>' : ''),
        escapeHtml(t.projectName || ''), async () => {
          modalEl.style.display = 'none';
          if (t.projectId && t.projectId !== state.projectId) await switchProject(t.projectId);
          openChatTab('project'); toggleChat(true);
        }, 'entity-task'));

    addEntitySection('Люди', users, (u) =>
      entityRow('user', highlightPath(u.username, q), 'Участник DarkArmy', () => {}, 'entity-user'));

    if (!list.length) return;
    const filesHead = document.createElement('div');
    filesHead.className = 'search-section-head';
    filesHead.textContent = `Файлы · ${list.length}`;
    results.appendChild(filesHead);
    for (const item of list) {
      const el = document.createElement('div');
      el.className = 'search-item';
      const iconHtml = item.type === 'dir' ? icon('folder','sm') : fileIcon(item.name);
      const pathHtml = highlightPath(item.path, q);
      const snippetHtml = item.snippet ? highlightSnippet(item.snippet, q) : '';
      const badge =
        item.matchType === 'both'     ? '<span class="search-badge both">слово + смысл</span>' :
        item.matchType === 'name'     ? '<span class="search-badge">имя</span>' :
        item.matchType === 'image'    ? '<span class="search-badge image">картинка</span>' :
        item.matchType === 'semantic' ? '<span class="search-badge semantic">смысл</span>' :
                                        '<span class="search-badge content">содержимое</span>';
      const projBadge = showProject && item.projectName ? `<span class="search-project-badge">${icon('layers','sm')} ${escapeHtml(item.projectName)}</span>` : '';

      let thumbHtml = '';
      if (item.isImage) {
        const pid = item.projectId || state.projectId;
        if (pid) {
          const src = '/files/' + pid + '/' + item.path.split('/').map(encodeURIComponent).join('/');
          thumbHtml = `<img class="search-thumb" src="${src}" alt="" loading="lazy">`;
        }
      }

      el.innerHTML = `
        <div class="search-item-body">
          ${thumbHtml}
          <div class="search-item-content">
            <div class="search-item-head">
              <span class="icon">${iconHtml}</span>
              <span class="path">${pathHtml}</span>
              ${badge}${projBadge}
              ${typeof item.score === 'number' ? `<span class="search-score" title="Релевантность">${Math.round(item.score * 100)}%</span>` : ''}
            </div>
            ${snippetHtml ? `<div class="search-snippet">${snippetHtml}</div>` : ''}
          </div>
        </div>`;
      el.onclick = async () => {
        modalEl.style.display = 'none';
        if (item.projectId && item.projectId !== state.projectId) await switchProject(item.projectId);
        if (item.type === 'dir') { state.expanded.add(item.path); renderTree(); } else openFile(item.path);
      };
      results.appendChild(el);
    }
  }
}
function highlightSnippet(text, q) {
  const esc = escapeHtml(text);
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return esc.replace(re, '<mark>$1</mark>');
}
function highlightPath(p, q) {
  const esc = escapeHtml(p);
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return esc.replace(re, '<mark>$1</mark>');
}
