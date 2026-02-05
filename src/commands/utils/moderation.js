import { unwrapMessage } from './message.js';

function normalizeSearchText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function findFirstLink(text) {
  const v = String(text ?? '');
  if (!v) return null;
  const match = v.match(/https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?/i);
  return match ? String(match[0] ?? '') : null;
}

export function findBannedWord(text, bannedWords) {
  const hay = normalizeSearchText(text);
  if (!hay) return null;

  for (const raw of Array.isArray(bannedWords) ? bannedWords : []) {
    const needle = normalizeSearchText(raw);
    if (!needle) continue;
    if (hay.includes(needle)) return needle;
  }

  return null;
}

export function detectMedia(message) {
  const msg = unwrapMessage(message);
  if (!msg) return { hasImage: false, hasSticker: false };
  return {
    hasImage: Boolean(msg.imageMessage),
    hasSticker: Boolean(msg.stickerMessage)
  };
}
