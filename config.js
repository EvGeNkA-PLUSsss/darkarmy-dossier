// config.js — Единая точка конфигурации
'use strict';
const path = require('path');
const crypto = require('crypto');

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProd) throw new Error('SESSION_SECRET обязателен в production. Задайте через env.');
  console.warn('[config] SESSION_SECRET не задан — генерирую временный. Сессии не выживут рестарт.');
  sessionSecret = crypto.randomBytes(32).toString('hex');
}

const trustProxy = process.env.TRUST_PROXY
  ? (Number.isFinite(+process.env.TRUST_PROXY) ? +process.env.TRUST_PROXY : process.env.TRUST_PROXY)
  : false;

module.exports = {
  env,
  isProd,
  port: parseInt(process.env.PORT, 10) || 7561,
  projectsRoot: path.resolve(process.env.PROJECTS_ROOT || 'F:/Проекты'),
  dataDir: path.join(__dirname, 'data'),
  sessionSecret,
  trustProxy,
  cookie: {
    secure: isProd,
    sameSite: 'strict',
    httpOnly: true,
    maxAge: 7 * 24 * 3600 * 1000,
  },
  limits: {
    uploadDefaultMB: 50,
    uploadMaxMB: 100_000,
    attachmentMaxBytes: 25 * 1024 * 1024,
    jsonBodyMax: '20mb',
    editContentMax: 5 * 1024 * 1024,
    darcusQueryMax: 8_000,
    darcusHistoryMax: 12,
    darcusHistoryItemMax: 8_000,
    darcusAttachmentsMax: 6,
    darcusAttachmentBytesMax: 4 * 1024 * 1024,
    trashRetentionDays: 14,
    logMaxEntries: 5_000,
    logContentMax: 32 * 1024,
    logFileMaxBytes: 10 * 1024 * 1024,
  },
  darcus: {
    allowedHosts: (process.env.DARCUS_ALLOWED_HOSTS || '')
      .split(',').map(s => s.trim()).filter(Boolean),
  },
  whisper: {
    binaryPath: process.env.WHISPER_BIN    || '',
    modelPath:  process.env.WHISPER_MODEL  || '',
    language:   process.env.WHISPER_LANG   || 'ru',
  },
  tts: {
    url:    process.env.TTS_URL    || '',
    voice:  process.env.TTS_VOICE  || 'default',
    format: process.env.TTS_FORMAT || 'wav',
  },
};