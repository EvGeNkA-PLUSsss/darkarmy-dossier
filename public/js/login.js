/* Вынесено из login.html ради строгого CSP (script-src 'self'). */
fetch('/api/public/contact').then(r => r.json()).then(d => {
      const a = document.getElementById('aiContactLink');
      if (a) { a.href = d.url || '/contact'; a.textContent = 'Доступ и оплата AI: ' + (d.telegram || '@AgroDeveloper'); }
    }).catch(() => {});
try {
      const t = localStorage.getItem('theme');
      if (t) document.documentElement.setAttribute('data-theme', t);
    } catch {}

    const params = new URLSearchParams(location.search);
    if (params.get('banned')) {
      document.getElementById('err').textContent = 'Вы забанены. Обратитесь к администрации.';
    }

    const f = document.getElementById('loginForm');
    f.onsubmit = async e => {
      e.preventDefault();
      const errEl = document.getElementById('err');
      errEl.textContent = '';
      const fd = new FormData(f);
      try {
        const r = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') })
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          try { localStorage.setItem('theme', data.theme || 'dark'); } catch {}
          location.href = '/';
        } else if (r.status === 429) {
          errEl.textContent = data.error || 'Слишком много попыток';
        } else if (r.status === 403 && data.error === 'banned') {
          const until = data.until ? (' до ' + new Date(data.until).toLocaleString('ru-RU')) : ' навсегда';
          errEl.textContent = 'Вы забанены' + until + (data.reason ? ('. Причина: ' + data.reason) : '');
        } else {
          errEl.textContent = 'Неверный логин или пароль';
        }
      } catch { errEl.textContent = 'Ошибка сети'; }
    };
    fetch('/api/me').then(r => r.json()).then(d => {
      if (d.user) location.href = '/';
      if (d.theme) {
        document.documentElement.setAttribute('data-theme', d.theme);
        try { localStorage.setItem('theme', d.theme); } catch {}
      }
    });
