import { extractMentions, extractQuotedParticipant } from './message.js';
import { normalizeUserJid } from './jid.js';

export function parseCommand(text, prefix) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith(prefix)) return null;

  const withoutPrefix = trimmed.slice(prefix.length).trim();
  if (!withoutPrefix) return null;

  const parts = withoutPrefix.split(/\s+/);
  const name = String(parts[0] ?? '').toLowerCase();
  if (!name) return null;

  const args = parts.slice(1);
  const rawArgs = args.join(' ');

  return { name, args, rawArgs };
}

export function parseDurationToken(value) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();

  if (!v) return null;

  const match = v.match(/^(\d{1,6})([smhdw])$/);
  if (!match) return null;

  const count = Number.parseInt(match[1], 10);
  if (!Number.isFinite(count) || count <= 0) return null;

  const unit = match[2];

  const mult =
    unit === 's'
      ? 1000
      : unit === 'm'
      ? 60_000
      : unit === 'h'
      ? 3_600_000
      : unit === 'd'
      ? 86_400_000
      : 604_800_000;

  const ms = count * mult;
  const maxMs = 365 * 24 * 60 * 60 * 1000;

  if (ms > maxMs) return { count, unit, ms, tooLarge: true };
  return { count, unit, ms, tooLarge: false };
}

export function renderDurationAr(duration) {
  if (!duration) return '';
  const label =
    duration.unit === 's'
      ? 'ثانية'
      : duration.unit === 'm'
      ? 'دقيقة'
      : duration.unit === 'h'
      ? 'ساعة'
      : duration.unit === 'd'
      ? 'يوم'
      : 'أسبوع';
  return `${duration.count} ${label}`;
}

export function parseOnOff(value) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();

  if (!v) return null;
  if (['on', 'enable', 'enabled', '1', 'true', 'yes', 'y'].includes(v)) return true;
  if (['off', 'disable', 'disabled', '0', 'false', 'no', 'n'].includes(v)) return false;
  return null;
}

function normalizePhoneTarget(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length < 6 || digits.length > 20) return null;
  return normalizeUserJid(`${digits}@s.whatsapp.net`);
}

export function resolveTargetsFromMessage(message, args) {
  const mentionTargets = extractMentions(message);
  if (mentionTargets.length > 0) {
    return { targets: Array.from(new Set(mentionTargets)), source: 'mentions' };
  }

  const quoted = extractQuotedParticipant(message);
  if (quoted) {
    return { targets: [quoted], source: 'reply' };
  }

  const numberTargets = [];
  for (const a of Array.isArray(args) ? args : []) {
    const jid = normalizePhoneTarget(a);
    if (jid) numberTargets.push(jid);
  }

  if (numberTargets.length > 0) {
    return { targets: Array.from(new Set(numberTargets)), source: 'number' };
  }

  return { targets: [], source: null };
}
