import path from 'node:path';

const LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

function readEnv(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === null || v === '') return fallback;
  return v;
}

function parseLogLevel(value, fallback) {
  const v = String(value || '').toLowerCase();
  if (LOG_LEVELS.has(v)) return v;
  return fallback;
}

function normalizePrefix(prefix) {
  const v = String(prefix || '').trim();
  return v || '!';
}

export function loadConfig() {
  const prefix = normalizePrefix(readEnv('BOT_PREFIX', '!'));
  const authDir = path.resolve(process.cwd(), readEnv('BOT_AUTH_DIR', './data/auth'));
  const logLevel = parseLogLevel(readEnv('BOT_LOG_LEVEL', 'info'), 'info');
  const baileysLogLevel = parseLogLevel(readEnv('BAILEYS_LOG_LEVEL', 'warn'), 'warn');
  const pingResponse = readEnv('BOT_PING_RESPONSE', '🏓 بونج! البوت يعمل ✅');

  return {
    prefix,
    authDir,
    logLevel,
    baileysLogLevel,
    pingResponse
  };
}
