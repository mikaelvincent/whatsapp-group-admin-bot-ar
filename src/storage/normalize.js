import { DEFAULT_WELCOME_TEMPLATE, MAX_WELCOME_TEMPLATE_CHARS, STORE_VERSION } from './constants.js';
import { isGroupJid, normalizeUserJid } from './ids.js';

function normalizeBannedWord(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  return v.replace(/\s+/g, ' ');
}

function normalizeWelcomeTemplate(value) {
  const raw = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!raw) return DEFAULT_WELCOME_TEMPLATE;
  if (raw.length <= MAX_WELCOME_TEMPLATE_CHARS) return raw;
  return raw.slice(0, MAX_WELCOME_TEMPLATE_CHARS);
}

function uniq(list) {
  return Array.from(new Set(list));
}

function normalizeAllowlist(list) {
  return uniq((Array.isArray(list) ? list : []).map(normalizeUserJid).filter(Boolean));
}

function uniqBannedWords(list) {
  const out = [];
  const seen = new Set();

  for (const raw of Array.isArray(list) ? list : []) {
    const v = normalizeBannedWord(raw);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }

  return out;
}

function normalizeMuteEntry(value, now) {
  if (value === null || value === undefined) return { until: null };

  if (typeof value === 'number' || typeof value === 'string') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= now) return null;
    return { until: n };
  }

  const v = value && typeof value === 'object' ? value : null;
  if (!v) return null;

  if (!Object.prototype.hasOwnProperty.call(v, 'until')) return { until: null };

  if (v.until === null || v.until === undefined) return { until: null };

  const until = Number(v.until);
  if (!Number.isFinite(until) || until <= now) return null;
  return { until };
}

function normalizeMuteMap(value, now) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};

  for (const [k, v] of Object.entries(src)) {
    const jid = normalizeUserJid(k);
    if (!jid) continue;

    const entry = normalizeMuteEntry(v, now);
    if (!entry) continue;

    out[jid] = entry;
  }

  return out;
}

function normalizeStoreData(value) {
  const v = value && typeof value === 'object' ? value : null;
  const groups = v && typeof v.groups === 'object' && v.groups ? v.groups : {};
  const allowlist = v && Array.isArray(v.allowlist) ? v.allowlist : [];
  return { version: STORE_VERSION, groups, allowlist: normalizeAllowlist(allowlist) };
}

function ensureModerationConfig(g) {
  if (!g.moderation || typeof g.moderation !== 'object') g.moderation = {};
  const m = g.moderation;

  if (typeof m.antiLink !== 'boolean') m.antiLink = false;
  if (typeof m.filterEnabled !== 'boolean') m.filterEnabled = false;
  if (typeof m.antiImage !== 'boolean') m.antiImage = false;
  if (typeof m.antiSticker !== 'boolean') m.antiSticker = false;
  if (typeof m.exemptAllowlisted !== 'boolean') m.exemptAllowlisted = true;
  if (typeof m.exemptAdmins !== 'boolean') m.exemptAdmins = true;

  return m;
}

function ensureWelcomeConfig(g) {
  if (!g.welcome || typeof g.welcome !== 'object') g.welcome = {};
  const w = g.welcome;

  if (typeof w.enabled !== 'boolean') w.enabled = false;
  w.template = normalizeWelcomeTemplate(w.template);

  return w;
}

function ensureGroup(data, groupJid) {
  if (!isGroupJid(groupJid)) return null;
  if (!data.groups[groupJid] || typeof data.groups[groupJid] !== 'object') data.groups[groupJid] = {};
  const g = data.groups[groupJid];

  if (!Array.isArray(g.bans)) g.bans = [];
  g.bans = uniq(g.bans.map(normalizeUserJid).filter(Boolean));

  ensureModerationConfig(g);
  ensureWelcomeConfig(g);

  if (!Array.isArray(g.bannedWords)) g.bannedWords = [];
  g.bannedWords = uniqBannedWords(g.bannedWords);

  g.mutes = normalizeMuteMap(g.mutes, Date.now());

  return g;
}

export {
  ensureGroup,
  ensureModerationConfig,
  ensureWelcomeConfig,
  normalizeAllowlist,
  normalizeBannedWord,
  normalizeMuteMap,
  normalizeStoreData,
  normalizeWelcomeTemplate,
  uniq,
  uniqBannedWords
};
