import { isUserJid, normalizeUserJid } from '../utils/jid.js';

function isPnUserJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

async function maybeToLid(socket, userJid) {
  if (!isPnUserJid(userJid)) return userJid;

  const mapping = socket?.signalRepository?.lidMapping;
  if (!mapping || typeof mapping.getLIDForPN !== 'function') return userJid;

  try {
    const lid = await mapping.getLIDForPN(userJid);
    return normalizeUserJid(lid) || userJid;
  } catch {
    return userJid;
  }
}

export function createGroupAdminService({ logger, ttlMs = 30_000 } = {}) {
  const groupMetaCache = new Map();

  const getGroupMetadata = async (socket, groupJid) => {
    const now = Date.now();
    const cached = groupMetaCache.get(groupJid);

    if (cached && now - cached.ts < ttlMs) return cached.data;

    const data = await socket.groupMetadata(groupJid);
    groupMetaCache.set(groupJid, { ts: now, data });
    return data;
  };

  const getAdminStatus = async (socket, groupJid, userJid) => {
    if (!groupJid || !userJid) return { ok: true, isAdmin: false };

    try {
      const meta = await getGroupMetadata(socket, groupJid);
      const parts = meta?.participants;
      if (!Array.isArray(parts)) return { ok: true, isAdmin: false };

      const normalized = normalizeUserJid(userJid);
      if (!normalized) return { ok: true, isAdmin: false };

      for (const p of parts) {
        const pid = normalizeUserJid(p?.id || null);
        if (!pid) continue;
        if (pid !== normalized) continue;
        return { ok: true, isAdmin: Boolean(p?.admin) };
      }

      return { ok: true, isAdmin: false };
    } catch (err) {
      logger?.warn?.('فشل التحقق من مشرفي المجموعة', { err: String(err) });
      return { ok: false, isAdmin: false };
    }
  };

  const getBotJid = (socket) => normalizeUserJid(socket?.user?.id || null);

  const sanitizeTargets = async (socket, targets) => {
    const botJid = getBotJid(socket);
    const unique = Array.from(
      new Set((Array.isArray(targets) ? targets : []).map(normalizeUserJid).filter(Boolean))
    ).filter((jid) => isUserJid(jid) && (!botJid || jid !== botJid));

    const resolved = [];
    for (const jid of unique) {
      resolved.push(await maybeToLid(socket, jid));
    }

    return Array.from(new Set(resolved.map(normalizeUserJid).filter(Boolean)));
  };

  return {
    getGroupMetadata,
    getAdminStatus,
    getBotJid,
    sanitizeTargets
  };
}
