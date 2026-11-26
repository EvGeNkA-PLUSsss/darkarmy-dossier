'use strict';
/* =========================================================
   routes/bugs.js — кнопка «БАГ»: приём багов от пользователей
   и просмотр/удаление в админке.

   Хранение:
     - метаданные: документ 'bugs' в SQLite (storage.getDoc/setDoc)
     - скриншоты: data/bug-reports/<id>.<png|jpg|webp>
   ========================================================= */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('../util');

const IMG_RE = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/i;
const EXT_BY_MIME = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp' };
const MAX_SHOT_BYTES = 3 * 1024 * 1024;
const MAX_ITEMS = 300;

module.exports = function createBugsRouter(deps) {
  const { storage, requireAuth, requireSelfAdmin, logger, paths } = deps;
  const router = express.Router();
  const rateLimitBug = util.makeRateLimiter(60 * 1000, 6, 'Слишком много багов за минуту, подождите');
  const dir = path.join(paths.dataDir, 'bug-reports');

  const load = () => storage.getDoc('bugs', { items: [] });
  const save = d => storage.setDoc('bugs', d);
  const publicItem = it => ({
    id: it.id, user: it.user, description: it.description, page: it.page,
    createdAt: it.createdAt, hasScreenshot: !!it.file,
    screenshotUrl: it.file ? `/api/bugs/${encodeURIComponent(it.id)}/screenshot` : null,
  });

  router.post('/api/bugs', requireAuth, rateLimitBug, (req, res) => {
    const description = String(req.body?.description || '').trim().slice(0, 4000);
    const page = String(req.body?.page || '').slice(0, 500);
    if (description.length < 5) return res.status(400).json({ error: 'Опишите баг (минимум 5 символов)' });

    let screenshot = null;
    const rawShot = req.body?.screenshot;
    if (rawShot) {
      if (typeof rawShot !== 'string' || rawShot.length > MAX_SHOT_BYTES * 1.4)
        return res.status(413).json({ error: 'Скриншот слишком большой (макс. 3 МБ)' });
      const m = rawShot.match(IMG_RE);
      if (!m) return res.status(400).json({ error: 'Скриншот должен быть PNG/JPG/WEBP' });
      const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      if (buf.length > MAX_SHOT_BYTES) return res.status(413).json({ error: 'Скриншот слишком большой (макс. 3 МБ)' });
      const ext = EXT_BY_MIME[m[1].toLowerCase()] || 'png';
      screenshot = { buf, ext };
    }

    const id = crypto.randomUUID();
    if (screenshot) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, id + '.' + screenshot.ext), screenshot.buf);
      } catch (e) {
        logger.error({ err: e.message }, 'bug screenshot write failed');
        return res.status(500).json({ error: 'Не удалось сохранить скриншот' });
      }
    }

    const item = {
      id, user: req.user.username, description, page,
      createdAt: new Date().toISOString(),
      file: screenshot ? id + '.' + screenshot.ext : null,
      mime: screenshot ? 'image/' + (screenshot.ext === 'jpg' ? 'jpeg' : screenshot.ext) : null,
    };
    const data = load();
    data.items.push(item);
    if (data.items.length > MAX_ITEMS) data.items = data.items.slice(-MAX_ITEMS);
    save(data);

    // Уведомление админам
    try {
      const admins = storage.getUsers().filter(u => u.role === 'admin').map(u => u.username);
      for (const a of admins) {
        if (a === req.user.username) continue;
        storage.createNotification({
          username: a, type: 'bug',
          title: `🐞 Баг от ${req.user.username}`,
          body: description.slice(0, 180),
          link: 'admin:bugs',
        });
      }
    } catch {}

    logger.info({ id, user: req.user.username, page, screenshot: !!screenshot }, 'bug report');
    res.json({ ok: true, id });
  });

  router.get('/api/bugs', requireSelfAdmin, (req, res) => {
    const items = load().items.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ items: items.map(publicItem), total: items.length });
  });

  router.get('/api/bugs/:id/screenshot', requireSelfAdmin, (req, res) => {
    const item = load().items.find(i => i.id === req.params.id);
    if (!item || !item.file) return res.status(404).json({ error: 'not found' });
    const file = path.join(dir, path.basename(item.file));
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.type(item.mime || 'image/png');
    res.sendFile(file);
  });

  router.patch('/api/bugs/:id', requireSelfAdmin, (req, res) => {
    const data = load();
    const item = data.items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    const description = String(req.body?.description ?? item.description).trim().slice(0, 4000);
    if (description.length < 1) return res.status(400).json({ error: 'Пустое описание' });
    item.description = description;
    if (typeof req.body?.page === 'string') item.page = req.body.page.slice(0, 500);
    const rawShot = req.body?.screenshot;
    if (rawShot) {
      if (typeof rawShot !== 'string' || rawShot.length > MAX_SHOT_BYTES * 1.4)
        return res.status(413).json({ error: 'Скриншот слишком большой (макс. 3 МБ)' });
      const m = rawShot.match(IMG_RE);
      if (!m) return res.status(400).json({ error: 'Скриншот должен быть PNG/JPG/WEBP' });
      const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      if (buf.length > MAX_SHOT_BYTES) return res.status(413).json({ error: 'Скриншот больше 3 МБ' });
      const ext = EXT_BY_MIME[m[1].toLowerCase()] || 'png';
      try {
        fs.mkdirSync(dir, { recursive: true });
        const old = item.file ? path.join(dir, path.basename(item.file)) : null;
        const name = item.id + '.' + ext;
        fs.writeFileSync(path.join(dir, name), buf);
        if (old && old !== path.join(dir, name)) { try { fs.unlinkSync(old); } catch {} }
        item.file = name;
        item.mime = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
      } catch (e) { return res.status(500).json({ error: 'Не удалось сохранить скриншот' }); }
    }
    item.editedAt = new Date().toISOString();
    item.editedBy = req.user.username;
    save(data);
    logger.info({ id: item.id, by: req.user.username }, 'bug report edited');
    res.json({ ok: true, item: publicItem(item) });
  });

  router.delete('/api/bugs/:id', requireSelfAdmin, (req, res) => {
    const data = load();
    const idx = data.items.findIndex(i => i.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    const item = data.items[idx];
    if (item.file) {
      try { fs.unlinkSync(path.join(dir, path.basename(item.file))); } catch {}
    }
    data.items.splice(idx, 1);
    save(data);
    logger.info({ id: item.id, user: req.user.username }, 'bug report removed');
    res.json({ ok: true });
  });

  return router;
};
