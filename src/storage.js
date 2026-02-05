import fs from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;

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

function uniq(list) {
  return Array.from(new Set(list));
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

function ensureGroup(data, groupJid) {
  if (!isGroupJid(groupJid)) return null;
  if (!data.groups[groupJid] || typeof data.groups[groupJid] !== 'object') data.groups[groupJid] = {};
  const g = data.groups[groupJid];
  if (!Array.isArray(g.bans)) g.bans = [];
  g.bans = uniq(g.bans.map(normalizeUserJid).filter(Boolean));
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
      const incoming = uniq((Array.isArray(userJids) ? userJids : []).map(normalizeUserJid).filter(Boolean));

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
      const incoming = uniq((Array.isArray(userJids) ? userJids : []).map(normalizeUserJid).filter(Boolean));

      let removed = 0;
      for (const jid of incoming) {
        if (before.delete(jid)) removed += 1;
      }

      g.bans = Array.from(before);
      await flush();
      return { removed, total: g.bans.length };
    });

  return {
    path: resolvedPath,
    listBans,
    isBanned,
    addBans,
    removeBans,
    close: async () => {
      await opChain;
    }
  };
}
