import fs from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 2;

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

function uniq(list) {
  return Array.from(new Set(list));
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
  return { version: STORE_VERSION, groups };
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

function ensureGroup(data, groupJid) {
  if (!isGroupJid(groupJid)) return null;
  if (!data.groups[groupJid] || typeof data.groups[groupJid] !== 'object') data.groups[groupJid] = {};
  const g = data.groups[groupJid];

  if (!Array.isArray(g.bans)) g.bans = [];
  g.bans = uniq(g.bans.map(normalizeUserJid).filter(Boolean));

  ensureModerationConfig(g);

  if (!Array.isArray(g.bannedWords)) g.bannedWords = [];
  g.bannedWords = uniqBannedWords(g.bannedWords);

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

  return {
    path: resolvedPath,
    listBans,
    isBanned,
    addBans,
    removeBans,
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
    close: async () => {
      await opChain;
    }
  };
}
