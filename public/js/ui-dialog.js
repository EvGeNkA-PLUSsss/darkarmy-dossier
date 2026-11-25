// js/ui-dialog.js — [NEW] Нативные модалки вместо alert/confirm/prompt
(function () {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  let host = null;
  function ensureHost() {
    if (host) return host;
    host = document.createElement('div');
    host.className = 'ui-dialog-host';
    host.hidden = true;
    document.body.appendChild(host);
    return host;
  }
  function close() { const h = ensureHost(); h.hidden = true; h.innerHTML = ''; }

  function open({ title, body, fields = [], actions }) {
    const h = ensureHost();
    h.hidden = false;
    h.innerHTML = `
      <div class="ui-dialog-backdrop"></div>
      <div class="ui-dialog" role="dialog" aria-modal="true">
        <div class="ui-dialog-title">${esc(title || '')}</div>
        <div class="ui-dialog-body">${body || ''}</div>
        <div class="ui-dialog-actions"></div>
      </div>`;
    const bodyEl = h.querySelector('.ui-dialog-body');
    for (const f of fields) {
      const wrap = document.createElement('label');
      wrap.className = 'ui-dialog-field';
      if (f.label) wrap.innerHTML = `<span>${esc(f.label)}</span>`;
      const inp = document.createElement(f.type === 'textarea' ? 'textarea' : 'input');
      if (f.type && f.type !== 'textarea') inp.type = f.type;
      if (f.value != null) inp.value = f.value;
      if (f.placeholder) inp.placeholder = f.placeholder;
      inp.name = f.name;
      wrap.appendChild(inp);
      bodyEl.appendChild(wrap);
    }
    const actEl = h.querySelector('.ui-dialog-actions');
    return new Promise(resolve => {
      for (const a of actions) {
        const btn = document.createElement('button');
        btn.textContent = a.label;
        if (a.className) btn.className = a.className;
        btn.onclick = () => {
          const values = {};
          for (const f of fields) {
            const el = h.querySelector(`[name="${f.name}"]`);
            values[f.name] = el ? el.value : null;
          }
          close();
          resolve({ action: a.value, values });
        };
        actEl.appendChild(btn);
      }
      h.querySelector('.ui-dialog-backdrop').onclick = () => {
        const cancel = actions.find(a => a.value === 'cancel') || actions[0];
        close();
        resolve({ action: cancel.value, values: {} });
      };
      document.addEventListener('keydown', function onEsc(e) {
        if (h.hidden) { document.removeEventListener('keydown', onEsc); return; }
        if (e.key === 'Escape') { document.removeEventListener('keydown', onEsc); close(); resolve({ action: 'cancel', values: {} }); }
      });
      const first = h.querySelector('input,textarea');
      if (first) setTimeout(() => first.focus(), 20);
    });
  }

  window.uiDialog = {
    alert: (msg, title = 'Внимание') =>
      open({ title, body: `<p>${esc(String(msg))}</p>`,
             actions: [{ label: 'ОК', value: 'ok', className: 'primary' }] }),

    confirm: (msg, title = 'Подтверждение') =>
      open({ title, body: `<p>${esc(String(msg))}</p>`,
             actions: [
               { label: 'Отмена', value: 'cancel' },
               { label: 'Подтвердить', value: 'ok', className: 'primary' },
             ] }).then(r => r.action === 'ok'),

    prompt: (msg, def = '', title = 'Ввод') =>
      open({ title, body: msg ? `<p>${esc(msg)}</p>` : '',
             fields: [{ name: 'value', value: def, type: 'text' }],
             actions: [
               { label: 'Отмена', value: 'cancel' },
               { label: 'ОК', value: 'ok', className: 'primary' },
             ] }).then(r => r.action === 'ok' ? r.values.value : null),
  };

  // [UX] Глобальные переопределения — legacy-код продолжает работать.
  // Заменяет alert/confirm/prompt на нативные модалки везде, включая admin.js.
  try {
    const _alert = window.alert;
    window.alert = (m) => { window.uiDialog.alert(m); };
  } catch {}
})();