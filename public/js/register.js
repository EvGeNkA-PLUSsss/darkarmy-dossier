/* Вынесено из register.html ради строгого CSP (script-src 'self'). */
try {
    const t = localStorage.getItem('theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch {}

  // Автоподстановка кода из ?invite=XXXX
  (function () {
    const p = new URLSearchParams(location.search);
    const code = p.get('invite');
    if (code) {
      const inp = document.querySelector('[name="inviteCode"]');
      if (inp) inp.value = code.toUpperCase();
    }
  })();

  /* --- Живая проверка силы пароля (зеркало серверной) --- */
  const COMMON = new Set([
    'password','password1','password123','passw0rd','p@ssw0rd','qwerty','qwerty123','qwertyuiop',
    '123456','1234567','12345678','123456789','1234567890','111111','123123','123321','000000',
    'abc123','abcd1234','letmein','welcome','welcome1','admin','admin123','administrator','root',
    'toor','test','test123','testtest','qazwsx','qazwsxedc','zaq12wsx','1q2w3e4r','1qaz2wsx',
    'iloveyou','monkey','dragon','sunshine','princess','football','baseball','superman','batman',
    'master','shadow','michael','jennifer','trustno1','hello','hello123','pass','pass123',
    'darkarmy','dossier','darkarmy123','qwerty1','asdfgh','asdfghjkl','zxcvbn','zxcvbnm','qwe123'
  ]);
  function validatePassword(pwd, username) {
    pwd = String(pwd || '');
    username = String(username || '').trim();
    if (pwd.length < 8) return 'Пароль должен быть минимум 8 символов';
    if (pwd.length > 200) return 'Пароль слишком длинный (макс. 200 символов)';
    if (!/[a-zа-яё]/.test(pwd)) return 'Пароль должен содержать строчную букву';
    if (!/[A-ZА-ЯЁ]/.test(pwd)) return 'Пароль должен содержать заглавную букву';
    if (!/[0-9]/.test(pwd)) return 'Пароль должен содержать цифру';
    if (/^(.)\1+$/.test(pwd)) return 'Пароль не должен состоять из одного символа';
    const lower = pwd.toLowerCase();
    const seqs = ['0123456789','9876543210','abcdefghijklmnopqrstuvwxyz',
                  'zyxwvutsrqponmlkjihgfedcba','qwertyuiop','poiuytrewq','asdfghjkl','lkjhgfdsa',
                  'zxcvbnm','mnbvcxz'];
    for (const s of seqs) if (s.includes(lower)) return 'Пароль не должен быть последовательностью';
    if (COMMON.has(lower)) return 'Такой пароль слишком распространён';
    if (username) {
      const u = username.toLowerCase();
      if (u.length >= 3 && lower.includes(u)) return 'Пароль не должен содержать логин';
      if (lower === u) return 'Пароль не должен совпадать с логином';
    }
    return null;
  }
  function scorePassword(pwd) {
    let score = 0;
    if (pwd.length >= 8) score++;
    if (pwd.length >= 12) score++;
    if (/[a-zа-яё]/.test(pwd)) score++;
    if (/[A-ZА-ЯЁ]/.test(pwd)) score++;
    if (/[0-9]/.test(pwd)) score++;
    if (/[^A-Za-z0-9А-Яа-яЁё]/.test(pwd)) score++;
    return score; // 0..6
  }

  const pwdInput = document.querySelector('[name="password"]');
  const unameInput = document.querySelector('[name="username"]');
  const meter = document.createElement('div');
  meter.className = 'pwd-meter';
  meter.innerHTML = `
    <div class="pwd-meter-bar"><span></span></div>
    <div class="pwd-meter-text"></div>
  `;
  pwdInput.parentNode.insertBefore(meter, pwdInput.nextSibling);

  function updateMeter() {
    const pwd = pwdInput.value || '';
    const uname = unameInput.value || '';
    const bar = meter.querySelector('.pwd-meter-bar span');
    const text = meter.querySelector('.pwd-meter-text');

    if (!pwd) {
      bar.style.width = '0';
      bar.className = '';
      text.textContent = '';
      return;
    }

    const err = validatePassword(pwd, uname);
    const score = scorePassword(pwd);

    if (err) {
      bar.style.width = '100%';
      bar.className = 'weak';
      text.textContent = err;
      text.className = 'pwd-meter-text weak';
      return;
    }

    let label, cls;
    if (score <= 3) { label = 'Слабый'; cls = 'weak'; }
    else if (score <= 4) { label = 'Средний'; cls = 'medium'; }
    else { label = 'Сильный'; cls = 'strong'; }

    bar.style.width = (score / 6 * 100) + '%';
    bar.className = cls;
    text.textContent = 'Пароль: ' + label;
    text.className = 'pwd-meter-text ' + cls;
  }
  pwdInput.addEventListener('input', updateMeter);
  unameInput.addEventListener('input', updateMeter);

  /* --- Отправка --- */
  const f = document.getElementById('registerForm');
  f.onsubmit = async e => {
    e.preventDefault();
    const errEl = document.getElementById('err');
    errEl.textContent = '';
    const fd = new FormData(f);

    // Быстрая клиентская проверка (сервер всё равно проверит)
    const localErr = validatePassword(fd.get('password'), fd.get('username'));
    if (localErr) { errEl.textContent = localErr; return; }

    try {
      const r = await fetch('/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: fd.get('username'),
          password: fd.get('password'),
          inviteCode: fd.get('inviteCode')
        })
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        try { localStorage.setItem('theme', data.theme || 'dark'); } catch {}
        location.href = '/';
      } else if (r.status === 429) {
        errEl.textContent = data.error || 'Слишком много попыток';
      } else {
        errEl.textContent = data.error || 'Ошибка регистрации';
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
