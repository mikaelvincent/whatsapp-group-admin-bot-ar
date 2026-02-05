import { normalizeUserJid } from './jid.js';

export function unwrapMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message)
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  return message;
}

export function extractText(message) {
  const msg = unwrapMessage(message);
  if (!msg) return null;

  return (
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.templateButtonReplyMessage?.selectedId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    null
  );
}

export function extractContextInfo(message) {
  const msg = unwrapMessage(message);
  if (!msg) return null;

  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    null
  );
}

export function extractMentions(message) {
  const ctx = extractContextInfo(message);
  const raw = ctx?.mentionedJid;
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeUserJid).filter(Boolean);
}

export function extractQuotedParticipant(message) {
  const ctx = extractContextInfo(message);
  return normalizeUserJid(ctx?.participant || null);
}

export function getReplyStanzaId(message) {
  const ctx = extractContextInfo(message);
  const id = String(ctx?.stanzaId ?? '').trim();
  return id || null;
}
