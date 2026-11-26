/* DarkArmy Dossier landing page */
(() => {
  const HOSTED = 'https://147-45-78-20.sslip.io:8443/';
  for (const id of ['hostedCta', 'finalHosted']) {
    const a = document.getElementById(id);
    if (a) a.href = HOSTED;
  }
  // Stars / particles
  const canvas = document.getElementById('stars');
  if (canvas && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, pts = [];
    const resize = () => {
      w = canvas.width = innerWidth * devicePixelRatio;
      h = canvas.height = innerHeight * devicePixelRatio;
      canvas.style.width = innerWidth + 'px';
      canvas.style.height = innerHeight + 'px';
      const n = Math.min(110, Math.round(innerWidth / 13));
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        r: (Math.random() * 1.4 + .3) * devicePixelRatio,
        s: (Math.random() * .18 + .04) * devicePixelRatio,
        a: Math.random() * .6 + .12,
      }));
    };
    resize(); addEventListener('resize', resize);
    let mx = -1, my = -1;
    addEventListener('pointermove', e => { mx = e.clientX * devicePixelRatio; my = e.clientY * devicePixelRatio; }, { passive: true });
    const tick = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of pts) {
        p.y += p.s;
        if (p.y > h + 4) { p.y = -4; p.x = Math.random() * w; }
        const dx = p.x - mx, dy = p.y - my, d2 = dx * dx + dy * dy;
        const near = mx >= 0 && d2 < (140 * devicePixelRatio) ** 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (near ? 1.8 : 1), 0, Math.PI * 2);
        ctx.fillStyle = near ? 'rgba(255,90,110,.85)' : `rgba(210,220,240,${p.a})`;
        ctx.fill();
      }
      requestAnimationFrame(tick);
    };
    tick();
  }
  // Reveal on scroll
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: .12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  // Counters
  const countEls = document.querySelectorAll('.stat b[data-count]');
  const cio = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target, target = +el.dataset.count, t0 = performance.now();
      const step = now => {
        const p = Math.min(1, (now - t0) / 900);
        el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      cio.unobserve(el);
    }
  }, { threshold: .5 });
  countEls.forEach(el => cio.observe(el));
  // Copy
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const old = btn.textContent; btn.textContent = 'copied ✓';
        setTimeout(() => { btn.textContent = old; }, 1600);
      } catch {}
    });
  });
  // Smooth anchor offset
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href');
      if (id.length < 2) return;
      const el = document.querySelector(id);
      if (!el) return;
      e.preventDefault();
      window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 70, behavior: 'smooth' });
    });
  });
})();
