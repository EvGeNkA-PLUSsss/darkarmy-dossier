'use strict';
/* =========================================================
   routes/history.js — история версий файлов и diff.
   Доступ: участник проекта (read). Содержимое before/after уже
   редактируется журналом (секреты/большие файлы).
   ========================================================= */
const express = require('express');

module.exports = function createHistoryRouter(deps) {
  const { storage, requireAuth, projectGuard } = deps;
  const router = express.Router();

  function clampInt(v, def, min, max) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(n, min), max);
  }

  // Список версий конкретного файла (без before/after — они тяжёлые).
  router.get('/api/files/:projectId/history', requireAuth, projectGuard('read', 'params'), (req, res) => {
    const rel = String(req.query.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) return res.status(400).json({ error: 'path required' });
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 100000);
    const result = storage.queryChanges({
      projectId: req.project.id, file: rel, limit, offset, full: false,
    });
    res.json({ path: rel, entries: result.entries, total: result.total, limit, offset });
  });

  // Одна версия с содержимым — для diff.
  router.get('/api/files/:projectId/history/:changeId', requireAuth, projectGuard('read', 'params'), (req, res) => {
    const entry = storage.getChange(req.params.changeId);
    if (!entry || entry.projectId !== req.project.id)
      return res.status(404).json({ error: 'not found' });
    res.json({
      version: {
        id: entry.id,
        timestamp: entry.timestamp,
        user: entry.user,
        action: entry.action,
        file: entry.file,
        before: typeof entry.before === 'string' ? entry.before : null,
        after: typeof entry.after === 'string' ? entry.after : null,
        truncated: typeof entry.before === 'string' && entry.before.endsWith('[...truncated]'),
      },
    });
  });

  // Скачать сохранённую версию (до/после изменения).
  router.get('/api/files/:projectId/history/:changeId/download', requireAuth, projectGuard('read', 'params'), (req, res) => {
    const entry = storage.getChange(req.params.changeId);
    if (!entry || entry.projectId !== req.project.id)
      return res.status(404).json({ error: 'not found' });
    const side = req.query.side === 'after' ? 'after' : 'before';
    const text = typeof entry[side] === 'string' ? entry[side] : '';
    if (!text) return res.status(404).json({ error: 'no content for this version' });
    const base = String(entry.file || 'version').split('/').pop() || 'version';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(base + '.' + side + '.txt')}`);
    res.send(text);
  });

  return router;
};
