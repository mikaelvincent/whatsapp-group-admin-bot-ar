import { isUserJid, normalizeUserJid } from '../utils/jid.js';

function isPnUserJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

function isLidUserJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

function uniqOrdered(values) {
  const out = [];
  const seen = new Set();

  for (const v of Array.isArray(values) ? values : []) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }

  return out;
}

function normalizePnJid(value) {
  const direct = normalizeUserJid(value);
  if (direct) return direct;

  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;

  return normalizeUserJid(`${digits}@s.whatsapp.net`);
}

function getSocketUserJids(socket) {
  const u = socket?.user;
  return uniqOrdered([normalizeUserJid(u?.lid), normalizeUserJid(u?.id), normalizePnJid(u?.phoneNumber)]);
}

function getLidMapping(socket) {
  const mapping = socket?.signalRepository?.lidMapping;
  return mapping && typeof mapping === 'object' ? mapping : null;
}

async function maybeToLid(socket, userJid) {
  if (!isPnUserJid(userJid)) return userJid;

  const mapping = getLidMapping(socket);
  if (!mapping || typeof mapping.getLIDForPN !== 'function') return userJid;

  try {
    const lid = await mapping.getLIDForPN(userJid);
    return normalizeUserJid(lid) || userJid;
  } catch {
    return userJid;
  }
}

async function maybeToPn(socket, userJid) {
  if (!isLidUserJid(userJid)) return userJid;

  const mapping = getLidMapping(socket);
  if (!mapping || typeof mapping.getPNForLID !== 'function') return userJid;

  try {
    const pn = await mapping.getPNForLID(userJid);
    return normalizeUserJid(pn) || userJid;
  } catch {
    return userJid;
  }
}

async function buildCandidateJids(socket, userJid) {
  const normalized = normalizeUserJid(userJid);
  if (!normalized) return new Set();

  const set = new Set([normalized]);

  if (isPnUserJid(normalized)) {
    const lid = normalizeUserJid(await maybeToLid(socket, normalized));
    if (lid) set.add(lid);
  } else if (isLidUserJid(normalized)) {
    const pn = normalizeUserJid(await maybeToPn(socket, normalized));
    if (pn) set.add(pn);
  }

  return set;
}

function participantAdminFlag(p) {
  if (!p || typeof p !== 'object') return false;
  return Boolean(p.admin) || Boolean(p.isAdmin) || Boolean(p.isSuperAdmin);
}

function extractParticipantJids(p) {
  return uniqOrdered([normalizeUserJid(p?.id), normalizeUserJid(p?.lid), normalizePnJid(p?.phoneNumber)]);
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

      const userCandidates = await buildCandidateJids(socket, userJid);
      if (userCandidates.size === 0) return { ok: true, isAdmin: false };

      for (const p of parts) {
        const ids = extractParticipantJids(p);
        for (const id of ids) {
          if (!id) continue;
          if (!userCandidates.has(id)) continue;
          return { ok: true, isAdmin: participantAdminFlag(p) };
        }
      }

      return { ok: true, isAdmin: false };
    } catch (err) {
      logger?.warn?.('فشل التحقق من مشرفي المجموعة', { err: String(err) });
      return { ok: false, isAdmin: false };
    }
  };

  const getBotJid = (socket) => {
    const ids = getSocketUserJids(socket);
    return ids[0] || null;
  };

  const sanitizeTargets = async (socket, targets) => {
    const botBase = getSocketUserJids(socket);
    const botSet = new Set(botBase);

    for (const jid of botBase) {
      const set = await buildCandidateJids(socket, jid);
      for (const candidate of set) botSet.add(candidate);
    }

    const unique = Array.from(
      new Set((Array.isArray(targets) ? targets : []).map(normalizeUserJid).filter(Boolean))
    ).filter((jid) => isUserJid(jid) && !botSet.has(jid));

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
