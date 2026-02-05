import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_WELCOME_TEMPLATE } from './constants.js';
import { ensureSecureDir, readJson, writeAtomic } from './fs.js';
import {
  ensureGroup,
  ensureModerationConfig,
  ensureWelcomeConfig,
  normalizeBannedWord,
  normalizeStoreData,
  normalizeWelcomeTemplate,
  uniq,
  uniqBannedWords
} from './normalize.js';
import { normalizeUserJid } from './ids.js';

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
  const setAntiSticker = (groupJid, enabled) => setModerationFlag(groupJid, 'antiSticker', enabled);
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
