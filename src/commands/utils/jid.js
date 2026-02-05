export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

export function isUserJid(jid) {
  return (
    typeof jid === 'string' && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))
  );
}

export function normalizeUserJid(jid) {
  if (typeof jid !== 'string') return null;
  const trimmed = jid.trim();
  if (!trimmed) return null;

  const at = trimmed.indexOf('@');
  if (at === -1) return null;

  const userPart = trimmed.slice(0, at);
  const serverPart = trimmed.slice(at + 1).toLowerCase();
  const user = userPart.split(':')[0];

  if (!user || !serverPart) return null;

  const normalized = `${user}@${serverPart}`;
  if (!isUserJid(normalized)) return null;

  return normalized;
}

export function formatJids(jids, limit = 5) {
  const raw = Array.isArray(jids) ? jids : [];
  const normalized = raw.map(normalizeUserJid).filter(Boolean);
  const ids = normalized.map((jid) => jid.split('@')[0]).filter(Boolean);

  if (ids.length === 0) return '';
  const head = ids.slice(0, limit).join(', ');
  if (ids.length <= limit) return head;
  return `${head} ... (+${ids.length - limit})`;
}

export function jidMentionTag(jid) {
  const u = normalizeUserJid(jid);
  const id = u ? u.split('@')[0] : '';
  return id ? `@${id}` : '';
}
