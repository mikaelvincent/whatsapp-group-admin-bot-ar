import { isUserJid, normalizeUserJid } from '../utils/jid.js';

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

      for (const p of parts) {
        const pid = normalizeUserJid(p?.id || p?.jid || p?.participant || null);
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

  const getBotJid = (socket) => {
    const raw = socket?.user?.id || socket?.user?.jid || null;
    return normalizeUserJid(raw || null);
  };

  const sanitizeTargets = (socket, targets) => {
    const botJid = getBotJid(socket);
    const unique = Array.from(
      new Set((Array.isArray(targets) ? targets : []).map(normalizeUserJid).filter(Boolean))
    );

    return unique.filter((jid) => isUserJid(jid) && (!botJid || jid !== botJid));
  };

  return {
    getGroupMetadata,
    getAdminStatus,
    getBotJid,
    sanitizeTargets
  };
}
