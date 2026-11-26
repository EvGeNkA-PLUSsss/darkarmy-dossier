'use strict';
/* =========================================================
   routes/system.js — админ-дашборд, бэкапы, телеметрия.
   ========================================================= */
const express = require('express');
const path = require('path');
const { execFile } = require('child_process');
const util = require('../util');

/**
 * @param {object} deps
 * @param {object} deps.cfg
 * @param {object} deps.storage
 * @param {object} deps.darcus
 * @param {object} deps.logger
 * @param {Function} deps.logChange
 * @param {Function} deps.requireSelfAdmin
 * @param {number} deps.serverStartTime
 * @param {object} deps.paths { dataDir, projectsRoot, attachDir, logFile, backupDir, rootDir }
 */
module.exports = function createSystemRouter(deps) {
  const { cfg, storage, darcus, logger, logChange, requireSelfAdmin, serverStartTime, paths } = deps;
  const router = express.Router();
  const rateLimitBackup = util.makeRateLimiter(60 * 1000, 3, 'Бэкап: слишком часто, подождите минуту');
  const rateLimitImport = util.makeRateLimiter(5 * 60 * 1000, cfg.limits.importMaxAttempts || 2, 'Импорт: слишком часто, подождите 5 минут');

  router.get('/api/admin/dashboard', requireSelfAdmin, async (req, res) => {
    const stats = storage.stats();
    const ai = darcus.loadAiConfig().ollama;
    let ping = { ok: false, error: 'не проверялось' };
    try { ping = await darcus.ollamaPing(); } catch (e) { ping.error = e.message; }
    const installed = Array.isArray(ping.models) ? ping.models : [];
    const isInstalled = (name) => installed.some(i => i === name || i === name + ':latest' || i.startsWith(name + ':'));
    const models = [
      { role: 'Чат', key: 'chatModel', name: ai.chatModel, required: true },
      { role: 'Vision/OCR', key: 'visionModel', name: ai.visionModel, required: false },
      { role: 'Эмбеддинги', key: 'embedModel', name: ai.embedModel, required: false },
      { role: 'Реранк', key: 'rerankModel', name: ai.rerankModel, required: false },
    ].map(m => ({ ...m, installed: !m.name ? true : isInstalled(m.name) }));

    res.json({
      status: 'ok',
      env: cfg.env,
      node: process.version,
      uptimeSec: Math.floor((Date.now() - serverStartTime) / 1000),
      storage: stats,
      sizes: {
        db: stats.sizeBytes,
        log: util.fileSize(paths.logFile),
        embeddings: util.fileSize(path.join(paths.dataDir, 'embeddings.json')),
        ocrCache: util.fileSize(path.join(paths.dataDir, 'ocr-cache.json')),
        attachments: util.safeDirSize(paths.attachDir),
        projects: util.safeDirSize(paths.projectsRoot),
        backups: util.safeDirSize(paths.backupDir),
      },
      backups: util.listBackups(paths.backupDir),
      ai: { reachable: !!ping.ok, error: ping.error || null, url: ai.url, models },
    });
  });

  router.post('/api/admin/backup', requireSelfAdmin, rateLimitBackup, (req, res) => {
    const includeProjects = req.body && req.body.projects === true;
    const args = [path.join(paths.rootDir, 'scripts', 'backup.js'), '--dest', paths.backupDir];
    if (!includeProjects) args.push('--no-projects');
    execFile(process.execPath, args, { cwd: paths.rootDir, timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const stderrText = String(stderr || '').trim();
          const lines = stderrText.split('\n').map(l => l.trim()).filter(l => l && l !== '}');
          // Последняя строка стека обычно "}", поэтому ищем содержательную.
          const detail = lines.find(l => /(Error|ENOENT|SQLITE|не удался|denied|no such)/i.test(l))
            || lines[lines.length - 1] || err.message;
          logger.error({ err: err.message, detail, stderr: stderrText.slice(0, 2000) }, 'backup failed');
          return res.status(500).json({ ok: false, error: detail });
        }
        logChange({ user: req.user.username, action: 'backup', details: includeProjects ? 'с проектами' : 'только метаданные' });
        res.json({ ok: true, output: String(stdout).trim().split('\n').slice(-6), backups: util.listBackups(paths.backupDir) });
      });
  });

  /* ---------- Экспорт/импорт метаданных ---------- */
  router.get('/api/admin/export', requireSelfAdmin, (req, res) => {
    const snapshot = storage.exportSnapshot();
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="darkarmy-dossier-${day}.json"`);
    res.json(snapshot);
  });

  router.post('/api/admin/import', requireSelfAdmin, rateLimitImport, (req, res) => {
    const { confirm, mode, snapshot } = req.body || {};
    if (confirm !== 'REPLACE')
      return res.status(400).json({ error: 'Подтвердите импорт: confirm = "REPLACE"' });
    try {
      const result = storage.importSnapshot(snapshot, { mode: mode === 'merge' ? 'merge' : 'replace' });
      logChange({
        user: req.user.username, action: 'admin-import',
        details: `режим ${result.mode}: пользователей ${result.users}, проектов ${result.projects}, документов ${result.documents}`,
      });
      logger.warn({ user: req.user.username, ...result }, 'metadata import');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /* ---------- Телеметрия ---------- */
  router.get('/api/telemetry', requireSelfAdmin, (req, res) => {
    const users = storage.listTelemetryUsers().map(u => {
      let lastClient = null;
      try {
        lastClient = storage.getTelemetry(u.username, 80).events.find(e => e.type === 'client-info') || null;
      } catch {}
      return { ...u, lastClient };
    });
    res.json({ users });
  });

  router.get('/api/telemetry/:username', requireSelfAdmin, (req, res) => {
    const telemetry = storage.getTelemetry(req.params.username);
    if (!telemetry.events.length) return res.status(404).json({ error: 'not found' });
    res.json({ telemetry });
  });

  router.post('/api/telemetry/:username/clear', requireSelfAdmin, (req, res) => {
    try { storage.clearTelemetry(req.params.username); res.json({ ok: true }); }
    catch { res.status(500).json({ error: 'write error' }); }
  });

  return router;
};
