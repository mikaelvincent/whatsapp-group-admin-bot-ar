import fs from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 5;

const DEFAULT_WELCOME_TEMPLATE =
  '👋 مرحبًا {user}!\n\nأهلًا بك في المجموعة.\n\n{rules}';

const MAX_WELCOME_TEMPLATE_CHARS = 2000;

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
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

async function ensureSecureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dirPath, 0o700);
  } catch {}
}

async function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);

  // Atomic rename reduces the risk of store corruption on crash/power loss.
  await fs.writeFile(tmpPath, content, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);

  try {
    await fs.chmod(filePath, 0o600);
  } catch {}
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : null;
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

export async function createStore({ filePath, logger } = {}) {
  const resolvedPath = path.resolve(process.cwd(), String(filePath || './data/store.json'));
  await ensureSecureDir(path.dirname(resolvedPath));

  let data;
  try {
    const loaded = await readJson(resolvedPath);
    data = normalizeStoreData(loaded);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      data = normalizeStoreData(null);
    } else {
      logger?.warn('فشل تحميل التخزين', { err: String(err) });
      try {
        await fs.rename(resolvedPath, `${resolvedPath}.corrupt.${Date.now()}`);
      } catch {}
      data = normalizeStoreData(null);
    }
  }

  let opChain = Promise.resolve();

  const enqueue = (fn) => {
    opChain = opChain.then(fn, fn);
    return opChain;
  };

  const flush = async () => {
    const json = JSON.stringify(data, null, 2);
    await writeAtomic(resolvedPath, `${json}\n`);
  };

  const listAllowlist = () => {
    const raw = Array.isArray(data.allowlist) ? data.allowlist : [];
    return [...raw];
  };

  const isAllowlisted = (userJid) => {
    const u = normalizeUserJid(userJid);
    if (!u) return false;
    const raw = Array.isArray(data.allowlist) ? data.allowlist : [];
    return raw.includes(u);
  };

  const addAllowlist = (userJids) =>
    enqueue(async () => {
      if (!Array.isArray(data.allowlist)) data.allowlist = [];

      const before = new Set(data.allowlist);
      const incoming = uniq(
        (Array.isArray(userJids) ? userJids : []).map(normalizeUserJid).filter(Boolean)
      );

      let added = 0;
      for (const jid of incoming) {
        if (before.has(jid)) continue;
        before.add(jid);
        added += 1;
      }

      if (added === 0) return { added: 0, total: before.size };

      data.allowlist = Array.from(before);
      await flush();
      return { added, total: data.allowlist.length };
    });

  const removeAllowlist = (userJids) =>
    enqueue(async () => {
      if (!Array.isArray(data.allowlist)) data.allowlist = [];

      const before = new Set(data.allowlist);
      const incoming = uniq(
        (Array.isArray(userJids) ? userJids : []).map(normalizeUserJid).filter(Boolean)
      );

      let removed = 0;
      for (const jid of incoming) {
        if (before.delete(jid)) removed += 1;
      }

      if (removed === 0) return { removed: 0, total: before.size };

      data.allowlist = Array.from(before);
      await flush();
      return { removed, total: data.allowlist.length };
    });

  const listBans = (groupJid) => {
    const g = ensureGroup(data, groupJid);
    return g ? [...g.bans] : [];
  };

  const isBanned = (groupJid, userJid) => {
    const g = ensureGroup(data, groupJid);
    const u = normalizeUserJid(userJid);
    if (!g || !u) return false;
    return g.bans.includes(u);
  };

  const addBans = (groupJid, userJids) =>
    enqueue(async () => {
      const g = ensureGroup(data, groupJid);
      if (!g) return { added: 0, total: 0 };

      const before = new Set(g.bans);
      const incoming = uniq(
        (Array.isArray(userJids) ? userJids : []).map(normalizeUserJid).filter(Boolean)
      );

      let added = 0;
      for (const jid of incoming) {
        if (before.has(jid)) continue;
        before.add(jid);
        added += 1;
      }

      g.bans = Array.from(before);
      await flush();
      return { added, total: g.bans.length };
    });

  const removeBans = (groupJid, userJids) =>
    enqueue(async () => {
      const g = ensureGroup(data, groupJid);
      if (!g) return { removed: 0, total: 0 };

      const before = new Set(g.bans);
      const incoming = uniq(
        (Array.isArray(userJids) ? userJids : []).map(normalizeUserJid).filter(Boolean)
      );

      let removed = 0;
      for (const jid of incoming) {
        if (before.delete(jid)) removed += 1;
      }

      g.bans = Array.from(before);
      await flush();
      return { removed, total: g.bans.length };
    });

  const getMute = (groupJid, userJid) => {
    const g = ensureGroup(data, groupJid);
    const u = normalizeUserJid(userJid);
    if (!g || !u) return { muted: false, until: null };

    const entry = g.mutes && typeof g.mutes === 'object' ? g.mutes[u] : null;
    if (!entry) return { muted: false, until: null };

    const until = entry.until === null || entry.until === undefined ? null : Number(entry.until);
    if (until === null) return { muted: true, until: null };

    const now = Date.now();
    if (!Number.isFinite(until) || until <= now) {
      delete g.mutes[u];
      return { muted: false, until: null };
    }

    return { muted: true, until };
  };

  const addMutes = (groupJid, userJids, untilMs) =>
    enqueue(async () => {
      const g = ensureGroup(data, groupJid);
      if (!g) return { added: 0, updated: 0, total: 0 };

      const now = Date.now();
      const until = untilMs === null || untilMs === undefined ? null : Number(untilMs);

      if (until !== null && (!Number.isFinite(until) || until <= now)) {
        return { added: 0, updated: 0, total: Object.keys(g.mutes || {}).length };
      }

      const incoming = uniq(
        (Array.isArray(userJids) ? userJids : []).map(normalizeUserJid).filter(Boolean)
      );

      let added = 0;
      let updated = 0;

      if (!g.mutes || typeof g.mutes !== 'object' || Array.isArray(g.mutes)) g.mutes = {};

      for (const jid of incoming) {
        const prev = g.mutes[jid];
        if (!prev) {
          g.mutes[jid] = { until };
          added += 1;
          continue;
        }

        const prevUntil = prev.until === null || prev.until === undefined ? null : Number(prev.until);
        const same =
          (prevUntil === null && until === null) ||
          (prevUntil !== null && until !== null && prevUntil === until);

        if (same) continue;

        g.mutes[jid] = { until };
        updated += 1;
      }

      if (added > 0 || updated > 0) await flush();
      return { added, updated, total: Object.keys(g.mutes).length };
    });

  const removeMutes = (groupJid, userJids) =>
    enqueue(async () => {
      const g = ensureGroup(data, groupJid);
      if (!g) return { removed: 0, total: 0 };

      const incoming = uniq(
        (Array.isArray(userJids) ? userJids : []).map(normalizeUserJid).filter(Boolean)
      );

      let removed = 0;

      if (!g.mutes || typeof g.mutes !== 'object' || Array.isArray(g.mutes)) g.mutes = {};

      for (const jid of incoming) {
        if (!Object.prototype.hasOwnProperty.call(g.mutes, jid)) continue;
        delete g.mutes[jid];
        removed += 1;
      }

      if (removed > 0) await flush();
      return { removed, total: Object.keys(g.mutes).length };
    });

  const getModeration = (groupJid) => {
    const g = ensureGroup(data, groupJid);
    if (!g) return null;

    const m = ensureModerationConfig(g);
    return {
      antiLink: Boolean(m.antiLink),
      filterEnabled: Boolean(m.filterEnabled),
      antiImage: Boolean(m.antiImage),
      antiSticker: Boolean(m.antiSticker),
      exemptAllowlisted: Boolean(m.exemptAllowlisted),
      exemptAdmins: Boolean(m.exemptAdmins),
      bannedWords: [...(Array.isArray(g.bannedWords) ? g.bannedWords : [])]
    };
  };

  const setModerationFlag = (groupJid, key, value) =>
    enqueue(async () => {
      const g = ensureGroup(data, groupJid);
      if (!g) return { ok: false, value: false };
      const m = ensureModerationConfig(g);

      const known = new Set([
        'antiLink',
        'filterEnabled',
        'antiImage',
        'antiSticker',
        'exemptAllowlisted',
        'exemptAdmins'
      ]);

      if (!known.has(key)) return { ok: false, value: false };

      m[key] = Boolean(value);
      await flush();
      return { ok: true, value: Boolean(m[key]) };
    });

  const setAntiLink = (groupJid, enabled) => setModerationFlag(groupJid, 'antiLink', enabled);
  const setFilterEnabled = (groupJid, enabled) =>
    setModerationFlag(groupJid, 'filterEnabled', enabled);
  const setAntiImage = (groupJid, enabled) => setModerationFlag(groupJid, 'antiImage', enabled);
  const setAntiSticker = (groupJid, enabled) =>
    setModerationFlag(groupJid, 'antiSticker', enabled);
  const setExemptAllowlisted = (groupJid, enabled) =>
    setModerationFlag(groupJid, 'exemptAllowlisted', enabled);
  const setExemptAdmins = (groupJid, enabled) =>
    setModerationFlag(groupJid, 'exemptAdmins', enabled);

  const listBannedWords = (groupJid) => {
    const g = ensureGroup(data, groupJid);
    return g ? [...g.bannedWords] : [];
  };

  const addBannedWord = (groupJid, phrase) =>
    enqueue(async () => {
      const g = ensureGroup(data, groupJid);
      if (!g) return { added: 0, total: 0 };

      const v = normalizeBannedWord(phrase);
      if (!v) return { added: 0, total: g.bannedWords.length };

      const needle = v.toLowerCase();
      const existing = new Set(g.bannedWords.map((w) => String(w).toLowerCase()));

      if (existing.has(needle)) return { added: 0, total: g.bannedWords.length };

      g.bannedWords.push(v);
      g.bannedWords = uniqBannedWords(g.bannedWords);
      await flush();
      return { added: 1, total: g.bannedWords.length };
    });

  const removeBannedWord = (groupJid, phrase) =>
    enqueue(async () => {
      const g = ensureGroup(data, groupJid);
      if (!g) return { removed: 0, total: 0 };

      const v = normalizeBannedWord(phrase);
      if (!v) return { removed: 0, total: g.bannedWords.length };

      const needle = v.toLowerCase();
      const before = Array.isArray(g.bannedWords) ? g.bannedWords : [];
      const after = before.filter((w) => String(w).toLowerCase() !== needle);

      const removed = before.length - after.length;
      g.bannedWords = uniqBannedWords(after);
      await flush();

      return { removed, total: g.bannedWords.length };
    });

  const getWelcome = (groupJid) => {
    const g = ensureGroup(data, groupJid);
    if (!g) return null;

    const w = ensureWelcomeConfig(g);
    return { enabled: Boolean(w.enabled), template: String(w.template || DEFAULT_WELCOME_TEMPLATE) };
  };

  const setWelcomeEnabled = (groupJid, enabled) =>
    enqueue(async () => {
      const g = ensureGroup(data, groupJid);
      if (!g) return { ok: false, value: false };

      const w = ensureWelcomeConfig(g);
      w.enabled = Boolean(enabled);
      await flush();
      return { ok: true, value: Boolean(w.enabled) };
    });

  const setWelcomeTemplate = (groupJid, template) =>
    enqueue(async () => {
      const g = ensureGroup(data, groupJid);
      if (!g) return { ok: false, template: DEFAULT_WELCOME_TEMPLATE };

      const w = ensureWelcomeConfig(g);
      const next = normalizeWelcomeTemplate(template);
      w.template = next;
      await flush();
      return { ok: true, template: next };
    });

  return {
    path: resolvedPath,
    listAllowlist,
    isAllowlisted,
    addAllowlist,
    removeAllowlist,
    listBans,
    isBanned,
    addBans,
    removeBans,
    getMute,
    addMutes,
    removeMutes,
    getModeration,
    setAntiLink,
    setFilterEnabled,
    setAntiImage,
    setAntiSticker,
    setExemptAllowlisted,
    setExemptAdmins,
    listBannedWords,
    addBannedWord,
    removeBannedWord,
    getWelcome,
    setWelcomeEnabled,
    setWelcomeTemplate,
    close: async () => {
      await opChain;
    }
  };
}
