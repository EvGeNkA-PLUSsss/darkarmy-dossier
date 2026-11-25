'use strict';
/* =========================================================
   routes/notifications.js — центр уведомлений пользователя.
   ========================================================= */
const express = require('express');

module.exports = function createNotificationsRouter(deps) {
  const { storage, requireAuth } = deps;
  const router = express.Router();

  router.get('/api/notifications', requireAuth, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const result = storage.listNotifications(req.user.username, { limit, unreadOnly });
    res.json({ items: result.items, unread: result.unread });
  });

  router.get('/api/notifications/unread-count', requireAuth, (req, res) => {
    const result = storage.listNotifications(req.user.username, { limit: 1 });
    res.json({ unread: result.unread });
  });

  router.post('/api/notifications/read-all', requireAuth, (req, res) => {
    const changed = storage.markAllNotificationsRead(req.user.username);
    res.json({ ok: true, changed });
  });

  router.post('/api/notifications/:id/read', requireAuth, (req, res) => {
    const item = storage.markNotificationRead(req.user.username, req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, notification: item });
  });

  router.delete('/api/notifications', requireAuth, (req, res) => {
    storage.clearNotifications(req.user.username);
    res.json({ ok: true });
  });

  return router;
};
