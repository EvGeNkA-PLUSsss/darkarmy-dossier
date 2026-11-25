// logger.js — [NEW] pino + fallback с ротацией
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const LOG_DIR = cfg.dataDir;
const LOG_FILE = path.join(LOG_DIR, 'log.txt');
const LOG_MAX = cfg.limits.logFileMaxBytes;
const LOG_KEEP = 5;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

let pino = null;
try { pino = require('pino'); } catch { /* optional */ }

let logCount = 0;
function rotate() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= LOG_MAX) return;
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const from = LOG_FILE + '.' + i;
      const to = LOG_FILE + '.' + (i + 1);
      if (fs.existsSync(from)) { try { fs.renameSync(from, to); } catch {} }
    }
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
  } catch {}
}

function fallback(level, obj, msg) {
  if (typeof obj === 'string') { msg = obj; obj = {}; }
  const line = JSON.stringify({ time: new Date().toISOString(), level, ...obj, msg: msg || '' });
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
    if (++logCount % 100 === 0) rotate();
  } catch {}
}

let logger;
if (pino) {
  const dest = pino.destination({ dest: LOG_FILE, sync: false, mkdir: true });
  logger = pino({ level: process.env.LOG_LEVEL || 'info', base: null, timestamp: pino.stdTimeFunctions.isoTime }, dest);
} else {
  logger = {
    info: (o, m) => fallback('INFO', o, m),
    warn: (o, m) => fallback('WARN', o, m),
    error: (o, m) => fallback('ERROR', o, m),
    debug: (o, m) => fallback('DEBUG', o, m),
  };
}

function writeAccessLog(entry) { logger.info(entry, 'http'); }

module.exports = { logger, writeAccessLog, LOG_FILE };