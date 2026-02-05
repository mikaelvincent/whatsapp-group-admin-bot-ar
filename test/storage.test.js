import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/storage.js';

const logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => logger
};

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'wa-bot-'));
}

test('persist global allowlist', async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'store.json');

  const store1 = await createStore({ filePath, logger });
  const r1 = await store1.addAllowlist([
    '111111@s.whatsapp.net',
    '222222@s.whatsapp.net',
    '111111@s.whatsapp.net',
    'not-a-jid'
  ]);

  assert.equal(r1.added, 2);
  assert.equal(r1.total, 2);
  assert.deepEqual(store1.listAllowlist().sort(), ['111111@s.whatsapp.net', '222222@s.whatsapp.net'].sort());

  await store1.close();

  const store2 = await createStore({ filePath, logger });
  assert.deepEqual(store2.listAllowlist().sort(), ['111111@s.whatsapp.net', '222222@s.whatsapp.net'].sort());

  const r2 = await store2.removeAllowlist(['111111@s.whatsapp.net', '333333@s.whatsapp.net']);
  assert.equal(r2.removed, 1);
  assert.deepEqual(store2.listAllowlist(), ['222222@s.whatsapp.net']);

  await store2.close();
});

test('rename corrupt store file', async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, 'store.json');

  await fs.writeFile(filePath, '{bad json', 'utf8');

  const store = await createStore({ filePath, logger });

  const names = await fs.readdir(dir);
  assert.ok(names.some((n) => n.startsWith('store.json.corrupt.')));

  await store.close();
});
