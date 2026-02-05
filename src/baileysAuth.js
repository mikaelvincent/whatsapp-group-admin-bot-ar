import fs from 'node:fs/promises';
import path from 'node:path';

import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';

import { ensureSecureDir, writeAtomic } from './storage/fs.js';

function normalizeLoaded(value) {
  const v = value && typeof value === 'object' ? value : null;

  const creds = v?.creds && typeof v.creds === 'object' ? v.creds : null;
  const keys = v?.keys && typeof v.keys === 'object' && v.keys ? v.keys : {};

  return { creds: creds || initAuthCreds(), keys };
}

export async function useSingleFileAuthState({ filePath } = {}) {
  const resolvedPath = path.resolve(process.cwd(), String(filePath || './data/auth/auth-state.json'));
  await ensureSecureDir(path.dirname(resolvedPath));

  let data = normalizeLoaded(null);

  try {
    const raw = await fs.readFile(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw, BufferJSON.reviver);
    data = normalizeLoaded(parsed);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      try {
        await fs.rename(resolvedPath, `${resolvedPath}.corrupt.${Date.now()}`);
      } catch {}
    }
    data = normalizeLoaded(null);
  }

  let opChain = Promise.resolve();
  let flushTimer = null;
  const flushDebounceMs = 350;

  const enqueue = (fn) => {
    opChain = opChain.then(fn, fn);
    return opChain;
  };

  const flush = () =>
    enqueue(async () => {
      const json = JSON.stringify(data, BufferJSON.replacer, 2);
      await writeAtomic(resolvedPath, `${json}\n`);
    });

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushDebounceMs);
    flushTimer.unref?.();
  };

  const state = {
    creds: data.creds,
    keys: {
      get: async (type, ids) => {
        const bucket =
          data.keys && typeof data.keys === 'object' && !Array.isArray(data.keys) ? data.keys[type] : null;

        const store = bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? bucket : {};
        const out = {};

        for (const id of Array.isArray(ids) ? ids : []) {
          if (Object.prototype.hasOwnProperty.call(store, id)) out[id] = store[id];
        }

        return out;
      },
      set: async (payload) => {
        const src = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};

        if (!data.keys || typeof data.keys !== 'object' || Array.isArray(data.keys)) data.keys = {};

        for (const [type, entries] of Object.entries(src)) {
          if (!data.keys[type] || typeof data.keys[type] !== 'object' || Array.isArray(data.keys[type])) {
            data.keys[type] = {};
          }

          const store = data.keys[type];
          const map = entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};

          for (const [id, value] of Object.entries(map)) {
            if (value === null || value === undefined) {
              delete store[id];
            } else {
              store[id] = value;
            }
          }
        }

        scheduleFlush();
      }
    }
  };

  const saveCreds = async () => {
    scheduleFlush();
    await flush();
  };

  return {
    state,
    saveCreds,
    flush,
    path: resolvedPath
  };
}
