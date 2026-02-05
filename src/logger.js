const LEVEL_ORDER = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

function nowIso() {
  return new Date().toISOString();
}

function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function createLogger({ level = 'info', base = {} } = {}) {
  const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  const baseMeta = safeMeta(base);

  const write = (lvl, msg, meta) => {
    const rank = LEVEL_ORDER[lvl];
    if (rank === undefined || rank > threshold) return;
    const line = {
      ts: nowIso(),
      level: lvl,
      msg,
      ...baseMeta,
      ...safeMeta(meta)
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };

  return {
    level,
    error: (msg, meta) => write('error', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    debug: (msg, meta) => write('debug', msg, meta),
    child: (meta) => createLogger({ level, base: { ...baseMeta, ...safeMeta(meta) } })
  };
}
