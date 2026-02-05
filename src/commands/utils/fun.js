import { randomInt } from 'node:crypto';

export function pickRandom(list) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length === 0) return null;
  return arr[randomInt(0, arr.length)];
}

export function randomInRangeInclusive(min, max) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const lo = Math.min(a, b);
  const hi = Math.max(a, b);

  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
  if (lo < 1 || hi < 1) return null;
  if (hi > 1_000_000) return null;

  return randomInt(lo, hi + 1);
}

export function parseRollSpec(args) {
  const tokens = (Array.isArray(args) ? args : [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);

  if (tokens.length === 0) return { kind: 'range', min: 1, max: 6 };

  const a0 = tokens[0].toLowerCase();

  const dice = a0.match(/^(\d{1,2})d(\d{1,4})$/i);
  if (dice) {
    const rolls = Number.parseInt(dice[1], 10);
    const sides = Number.parseInt(dice[2], 10);
    if (!Number.isFinite(rolls) || !Number.isFinite(sides)) return null;
    if (rolls < 1 || rolls > 20) return null;
    if (sides < 2 || sides > 1000) return null;
    return { kind: 'dice', rolls, sides };
  }

  const dOnly = a0.match(/^d(\d{1,4})$/i);
  if (dOnly) {
    const sides = Number.parseInt(dOnly[1], 10);
    if (!Number.isFinite(sides) || sides < 2 || sides > 1000) return null;
    return { kind: 'dice', rolls: 1, sides };
  }

  const hyphen = a0.match(/^(\d{1,6})-(\d{1,6})$/);
  if (hyphen) {
    const min = Number.parseInt(hyphen[1], 10);
    const max = Number.parseInt(hyphen[2], 10);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min < 1 || max < 1) return null;
    if (min > 1_000_000 || max > 1_000_000) return null;
    return { kind: 'range', min, max };
  }

  const n0 = tokens[0].match(/^\d{1,6}$/);
  const n1 = tokens[1]?.match(/^\d{1,6}$/);

  if (n0 && n1) {
    const min = Number.parseInt(tokens[0], 10);
    const max = Number.parseInt(tokens[1], 10);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min < 1 || max < 1) return null;
    if (min > 1_000_000 || max > 1_000_000) return null;
    return { kind: 'range', min, max };
  }

  if (n0 && tokens.length === 1) {
    const max = Number.parseInt(tokens[0], 10);
    if (!Number.isFinite(max)) return null;
    if (max < 2 || max > 1_000_000) return null;
    return { kind: 'range', min: 1, max };
  }

  return null;
}

export function formatUptimeAr(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds ?? 0) || 0));
  const days = Math.floor(total / 86_400);
  const rem = total % 86_400;

  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;

  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');

  const clock = `${hh}:${mm}:${ss}`;
  if (days > 0) return `${days} يوم ${clock}`;
  return clock;
}

export function formatMb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  return `${Math.round(n / 1024 / 1024)} MB`;
}
