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

function parseBoolean(value, fallback = false) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return fallback;
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function normalizeUserJid(jid) {
  if (typeof jid !== 'string') return null;
  const trimmed = jid.trim();
  if (!trimmed) return null;

  const at = trimmed.indexOf('@');
  if (at === -1) return null;

  const userPart = trimmed.slice(0, at);
  const serverPart = trimmed.slice(at + 1).toLowerCase();
  const user = userPart.split(':')[0];

  if (!user || !serverPart) return null;
  return `${user}@${serverPart}`;
}

function normalizeAllowlistEntry(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;

  if (v.includes('@')) return normalizeUserJid(v);

  const digits = v.replace(/\D/g, '');
  if (!digits) return null;

  return normalizeUserJid(`${digits}@s.whatsapp.net`);
}

function parseAllowlist(value) {
  const v = String(value ?? '').trim();
  if (!v) return [];

  const out = [];
  const parts = v.split(/[\s,]+/).map((p) => p.trim());

  for (const p of parts) {
    if (!p) continue;
    const jid = normalizeAllowlistEntry(p);
    if (jid) out.push(jid);
  }

  return Array.from(new Set(out));
}

export function loadConfig() {
  const prefix = normalizePrefix(readEnv('BOT_PREFIX', '!'));
  const authDir = path.resolve(process.cwd(), readEnv('BOT_AUTH_DIR', './data/auth'));
  const storagePath = path.resolve(process.cwd(), readEnv('BOT_STORAGE_PATH', './data/store.json'));
  const logLevel = parseLogLevel(readEnv('BOT_LOG_LEVEL', 'info'), 'info');
  const baileysLogLevel = parseLogLevel(readEnv('BAILEYS_LOG_LEVEL', 'warn'), 'warn');
  const pingResponse = readEnv('BOT_PING_RESPONSE', '🏓 بونج! البوت يعمل ✅');

  const allowlist = parseAllowlist(readEnv('BOT_ALLOWLIST', ''));
  const requireCallerAdmin = parseBoolean(readEnv('BOT_REQUIRE_CALLER_ADMIN', 'false'), false);
  const moderationWarnCooldownMs = parsePositiveInt(
    readEnv('BOT_MOD_WARN_COOLDOWN_MS', '15000'),
    15000
  );

  return {
    prefix,
    authDir,
    storagePath,
    logLevel,
    baileysLogLevel,
    pingResponse,
    allowlist,
    requireCallerAdmin,
    moderationWarnCooldownMs
  };
}
