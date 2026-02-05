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

export { isGroupJid, normalizeUserJid };
