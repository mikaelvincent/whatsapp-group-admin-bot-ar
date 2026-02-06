import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCommandRouter } from '../src/commands.js';
import { createStore } from '../src/storage.js';

const logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => logger
};

async function makeTempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-bot-'));
  const filePath = path.join(dir, 'store.json');
  const store = await createStore({ filePath, logger });
  return { dir, store };
}

function makeGroupMeta({ botJid, botAdmin, senderJid, senderAdmin, extra = [] }) {
  return {
    subject: 'Test Group',
    participants: [
      { id: botJid, admin: botAdmin ? 'admin' : undefined },
      { id: senderJid, admin: senderAdmin ? 'admin' : undefined },
      ...extra.map((id) => ({ id }))
    ]
  };
}

function createSocketStub({ botJid, groupMeta, throwInteractive }) {
  let counter = 0;
  const sent = [];

  return {
    user: { id: botJid },
    sent,
    async sendMessage(jid, message, opts) {
      if (throwInteractive && message && typeof message === 'object' && Array.isArray(message.sections)) {
        throw new Error('interactive_not_supported');
      }

      counter += 1;
      sent.push({ jid, message, opts });
      return { key: { id: `s${counter}` } };
    },
    async groupMetadata() {
      return groupMeta;
    },
    async groupParticipantsUpdate() {
      throw new Error('groupParticipantsUpdate_not_stubbed');
    }
  };
}

function groupMessage({ groupJid, senderJid, id, text, mentionedJids, quotedParticipant, stanzaId }) {
  const key = { remoteJid: groupJid, fromMe: false, participant: senderJid, id: id || 'm1' };

  const ctx = {};
  if (Array.isArray(mentionedJids) && mentionedJids.length > 0) ctx.mentionedJid = mentionedJids;
  if (quotedParticipant) ctx.participant = quotedParticipant;
  if (stanzaId) ctx.stanzaId = stanzaId;

  const message =
    Object.keys(ctx).length > 0
      ? { extendedTextMessage: { text, contextInfo: ctx } }
      : { conversation: text };

  return { key, message };
}

test('reject privileged command for non-allowlisted', async () => {
  const { store } = await makeTempStore();

  const groupJid = '123@g.us';
  const botJid = '999@s.whatsapp.net';
  const senderJid = '222@s.whatsapp.net';

  const config = {
    prefix: '!',
    allowlist: ['111@s.whatsapp.net'],
    requireCallerAdmin: false,
    moderationWarnCooldownMs: 0,
    commandCooldownMs: 0,
    funCooldownMs: 0,
    pingResponse: 'pong'
  };

  const socket = createSocketStub({
    botJid,
    groupMeta: makeGroupMeta({ botJid, botAdmin: true, senderJid, senderAdmin: false })
  });

  const router = createCommandRouter({ config, logger, store });

  await router.handle({
    socket,
    msg: groupMessage({ groupJid, senderJid, text: '!antilink on' })
  });

  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].jid, groupJid);
  assert.equal(socket.sent[0].message.text, 'عذرًا، هذا الأمر مخصص للمخولين فقط.');

  await store.close();
});

test('enforce caller admin when enabled', async () => {
  const { store } = await makeTempStore();

  const groupJid = '123@g.us';
  const botJid = '999@s.whatsapp.net';
  const senderJid = '111@s.whatsapp.net';

  const config = {
    prefix: '!',
    allowlist: [senderJid],
    requireCallerAdmin: true,
    moderationWarnCooldownMs: 0,
    commandCooldownMs: 0,
    funCooldownMs: 0,
    pingResponse: 'pong'
  };

  const socket = createSocketStub({
    botJid,
    groupMeta: makeGroupMeta({ botJid, botAdmin: true, senderJid, senderAdmin: false })
  });

  const router = createCommandRouter({ config, logger, store });

  await router.handle({
    socket,
    msg: groupMessage({ groupJid, senderJid, text: '!antilink on' })
  });

  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].message.text, 'عذرًا، هذا الأمر متاح لمشرفي المجموعة فقط.');

  await store.close();
});

test('enable anti-link and moderate links', async () => {
  const { store } = await makeTempStore();

  const groupJid = '123@g.us';
  const botJid = '999@s.whatsapp.net';
  const adminJid = '111@s.whatsapp.net';
  const userJid = '222@s.whatsapp.net';

  const config = {
    prefix: '!',
    allowlist: [adminJid],
    requireCallerAdmin: false,
    moderationWarnCooldownMs: 0,
    commandCooldownMs: 0,
    funCooldownMs: 0,
    pingResponse: 'pong'
  };

  const socket = createSocketStub({
    botJid,
    groupMeta: makeGroupMeta({ botJid, botAdmin: true, senderJid: adminJid, senderAdmin: true })
  });

  const router = createCommandRouter({ config, logger, store });

  await router.handle({
    socket,
    msg: groupMessage({ groupJid, senderJid: adminJid, text: '!antilink on' })
  });

  assert.equal(socket.sent.at(-1).message.text, '✅ تم تفعيل منع الروابط.');
  assert.equal(store.getModeration(groupJid).antiLink, true);

  socket.sent.length = 0;

  await router.handle({
    socket,
    msg: groupMessage({ groupJid, senderJid: userJid, id: 'm-link', text: 'hi https://example.com' })
  });

  assert.equal(socket.sent.length, 2);
  assert.ok(socket.sent[0].message.delete);
  assert.ok(String(socket.sent[1].message.text).includes('يُمنع إرسال الروابط'));

  await store.close();
});

test('delete messages from muted user', async () => {
  const { store } = await makeTempStore();

  const groupJid = '123@g.us';
  const botJid = '999@s.whatsapp.net';
  const adminJid = '111@s.whatsapp.net';
  const targetJid = '222@s.whatsapp.net';

  const config = {
    prefix: '!',
    allowlist: [adminJid],
    requireCallerAdmin: false,
    moderationWarnCooldownMs: 0,
    commandCooldownMs: 0,
    funCooldownMs: 0,
    pingResponse: 'pong'
  };

  const socket = createSocketStub({
    botJid,
    groupMeta: makeGroupMeta({ botJid, botAdmin: true, senderJid: adminJid, senderAdmin: true, extra: [targetJid] })
  });

  const router = createCommandRouter({ config, logger, store });

  await router.handle({
    socket,
    msg: groupMessage({
      groupJid,
      senderJid: adminJid,
      text: '!mute @222',
      mentionedJids: [targetJid]
    })
  });

  assert.equal(store.getMute(groupJid, targetJid).muted, true);

  socket.sent.length = 0;

  await router.handle({
    socket,
    msg: groupMessage({ groupJid, senderJid: targetJid, id: 'm-muted', text: 'hello' })
  });

  assert.equal(socket.sent.length, 2);
  assert.ok(socket.sent[0].message.delete);
  assert.ok(String(socket.sent[1].message.text).includes('أنت مكتوم'));

  await store.close();
});

test('delete muted message when bot id is LID', async () => {
  const { store } = await makeTempStore();

  const groupJid = '123@g.us';
  const botJid = '999@s.whatsapp.net';
  const botLid = 'bot@lid';
  const adminJid = '111@s.whatsapp.net';
  const targetJid = '222@s.whatsapp.net';

  const config = {
    prefix: '!',
    allowlist: [adminJid],
    requireCallerAdmin: false,
    moderationWarnCooldownMs: 0,
    commandCooldownMs: 0,
    funCooldownMs: 0,
    pingResponse: 'pong'
  };

  const groupMeta = {
    subject: 'Test Group',
    participants: [
      { id: botLid, lid: botLid, phoneNumber: botJid, admin: 'admin' },
      { id: adminJid, admin: 'admin' },
      { id: targetJid }
    ]
  };

  const socket = createSocketStub({ botJid, groupMeta });

  const router = createCommandRouter({ config, logger, store });

  await router.handle({
    socket,
    msg: groupMessage({
      groupJid,
      senderJid: adminJid,
      text: '!mute @222',
      mentionedJids: [targetJid]
    })
  });

  assert.equal(store.getMute(groupJid, targetJid).muted, true);

  socket.sent.length = 0;

  await router.handle({
    socket,
    msg: groupMessage({ groupJid, senderJid: targetJid, id: 'm-muted-lid', text: 'hello' })
  });

  assert.equal(socket.sent.length, 2);
  assert.ok(socket.sent[0].message.delete);
  assert.ok(String(socket.sent[1].message.text).includes('أنت مكتوم'));

  await store.close();
});

test('fallback to text menu when interactive fails', async () => {
  const { store } = await makeTempStore();

  const groupJid = '123@g.us';
  const botJid = '999@s.whatsapp.net';
  const senderJid = '111@s.whatsapp.net';

  const config = {
    prefix: '!',
    allowlist: [senderJid],
    requireCallerAdmin: false,
    moderationWarnCooldownMs: 0,
    commandCooldownMs: 0,
    funCooldownMs: 0,
    pingResponse: 'pong'
  };

  const socket = createSocketStub({
    botJid,
    throwInteractive: true,
    groupMeta: makeGroupMeta({ botJid, botAdmin: true, senderJid, senderAdmin: true })
  });

  const router = createCommandRouter({ config, logger, store });

  await router.handle({
    socket,
    msg: groupMessage({ groupJid, senderJid, text: '!menu' })
  });

  assert.equal(socket.sent.length, 1);
  assert.ok(String(socket.sent[0].message.text).startsWith('📋 القائمة'));

  await store.close();
});

test('navigate menu with numbers', async () => {
  const { store } = await makeTempStore();

  const groupJid = '123@g.us';
  const botJid = '999@s.whatsapp.net';
  const senderJid = '111@s.whatsapp.net';

  const config = {
    prefix: '!',
    allowlist: [senderJid],
    requireCallerAdmin: false,
    moderationWarnCooldownMs: 0,
    commandCooldownMs: 0,
    funCooldownMs: 0,
    pingResponse: 'pong'
  };

  const socket = createSocketStub({
    botJid,
    groupMeta: makeGroupMeta({ botJid, botAdmin: true, senderJid, senderAdmin: true })
  });

  const router = createCommandRouter({ config, logger, store });

  await router.handle({
    socket,
    msg: groupMessage({ groupJid, senderJid, text: '!menu' })
  });

  await router.handle({
    socket,
    msg: groupMessage({ groupJid, senderJid, id: 'm-nav', text: '2' })
  });

  assert.ok(String(socket.sent.at(-1).message.text).startsWith('🧹 قسم الإشراف'));

  await store.close();
});

test('reject kick when bot is not admin', async () => {
  const { store } = await makeTempStore();

  const groupJid = '123@g.us';
  const botJid = '999@s.whatsapp.net';
  const senderJid = '111@s.whatsapp.net';
  const targetJid = '222@s.whatsapp.net';

  const config = {
    prefix: '!',
    allowlist: [senderJid],
    requireCallerAdmin: false,
    moderationWarnCooldownMs: 0,
    commandCooldownMs: 0,
    funCooldownMs: 0,
    pingResponse: 'pong'
  };

  const socket = createSocketStub({
    botJid,
    groupMeta: makeGroupMeta({ botJid, botAdmin: false, senderJid, senderAdmin: true, extra: [targetJid] })
  });

  const router = createCommandRouter({ config, logger, store });

  await router.handle({
    socket,
    msg: groupMessage({
      groupJid,
      senderJid,
      text: '!kick @222',
      mentionedJids: [targetJid]
    })
  });

  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].message.text, 'لا يمكن تنفيذ الأمر لأن البوت ليس مشرفًا في المجموعة.');

  await store.close();
});

test('unban by number replies without quoting', async () => {
  const { store } = await makeTempStore();

  const groupJid = '123@g.us';
  const botJid = '999@s.whatsapp.net';
  const senderJid = '111@s.whatsapp.net';

  const targetJid = '639661851118@s.whatsapp.net';

  const config = {
    prefix: '!',
    allowlist: [senderJid],
    requireCallerAdmin: false,
    moderationWarnCooldownMs: 0,
    commandCooldownMs: 0,
    funCooldownMs: 0,
    pingResponse: 'pong'
  };

  await store.addBans(groupJid, [targetJid]);

  const socket = createSocketStub({
    botJid,
    groupMeta: makeGroupMeta({ botJid, botAdmin: true, senderJid, senderAdmin: true })
  });

  const router = createCommandRouter({ config, logger, store });

  await router.handle({
    socket,
    msg: groupMessage({ groupJid, senderJid, text: '!unban +639661851118' })
  });

  assert.ok(socket.sent.some((s) => s.message && s.message.delete));

  const last = socket.sent.at(-1);
  assert.equal(last.message.text, '✅ تم إلغاء الحظر عن 1 عضو/أعضاء.');
  assert.equal(last.opts, undefined);

  await store.close();
});
