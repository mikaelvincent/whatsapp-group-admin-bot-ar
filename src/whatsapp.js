import path from 'node:path';

import makeWASocket, { DisconnectReason, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import { createCommandRouter } from './commands.js';
import { useSingleFileAuthState } from './baileysAuth.js';
import { safeSendText, sleep } from './commands/utils/send.js';
import { isGroupJid, jidMentionTag, normalizeUserJid } from './commands/utils/jid.js';
import { createStore } from './storage.js';

function renderRulesSummaryForWelcome(store, groupJid) {
  const m = store.getModeration(groupJid);
  if (!m) return '';

  const items = [];
  if (m.antiLink) items.push('• يُمنع إرسال الروابط.');
  if (m.filterEnabled) items.push('• يُمنع إرسال العبارات غير المسموحة.');
  if (m.antiImage) items.push('• يُمنع إرسال الصور.');
  if (m.antiSticker) items.push('• يُمنع إرسال الملصقات.');

  if (items.length === 0) return '';
  return ['📜 القواعد المختصرة:', ...items].join('\n');
}

function renderWelcomeText(template, params) {
  const user = String(params?.user ?? '').trim();
  const group = String(params?.group ?? '').trim();
  const rules = String(params?.rules ?? '').trim();
  const prefix = String(params?.prefix ?? '').trim();

  let out = String(template ?? '').replace(/\r\n/g, '\n');
  out = out.replace(/\{user\}/gi, user);
  out = out.replace(/\{group\}/gi, group);
  out = out.replace(/\{rules\}/gi, rules);
  out = out.replace(/\{prefix\}/gi, prefix);

  out = out.replace(/\n{3,}/g, '\n\n').trim();
  if (!out) out = user ? `👋 مرحبًا ${user}!` : '👋 مرحبًا!';

  return out;
}

function computeBackoff(attempt) {
  const base = 2000;
  const max = 60000;
  const delay = base * 2 ** Math.min(attempt, 5);
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(max, delay + jitter);
}

function getDisconnectStatusCode(lastDisconnect) {
  const code = lastDisconnect?.error?.output?.statusCode;
  return typeof code === 'number' ? code : null;
}

function messageKeyToId(key) {
  const jid = String(key?.remoteJid ?? '').trim();
  const id = String(key?.id ?? '').trim();
  if (!jid || !id) return null;
  return `${jid}|${id}`;
}

export async function startWhatsAppBot({ config, logger }) {
  let socket = null;
  let stopped = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;

  const baileysLogger = pino({ level: config.baileysLogLevel });

  const store = await createStore({
    filePath: config.storagePath,
    logger: logger.child({ component: 'store' })
  });

  try {
    const seed = Array.isArray(config.allowlist) ? config.allowlist : [];
    if (seed.length > 0) {
      const res = await store.addAllowlist(seed);
      if (res?.added > 0) {
        logger.info('تمت مزامنة قائمة السماح', { added: res.added, total: res.total });
      }
    }

    config.allowlist = store.listAllowlist();
  } catch (err) {
    logger.warn('فشل مزامنة قائمة السماح', { err: String(err) });
  }

  const commandRouter = createCommandRouter({
    config,
    logger: logger.child({ component: 'commands' }),
    store
  });

  const auth = await useSingleFileAuthState({
    filePath: path.join(config.authDir, 'auth-state.json')
  });

  const messageCache = new Map();
  const messageCacheTtlMs = 10 * 60 * 1000;
  const messageCacheMax = 5000;

  const rememberMessage = (msg) => {
    const key = msg?.key;
    const m = msg?.message;
    const k = messageKeyToId(key);
    if (!k || !m) return;

    messageCache.set(k, { ts: Date.now(), message: m });

    while (messageCache.size > messageCacheMax) {
      const first = messageCache.keys().next().value;
      if (!first) break;
      messageCache.delete(first);
    }
  };

  const getMessage = async (key) => {
    const k = messageKeyToId(key);
    if (!k) return undefined;

    const entry = messageCache.get(k);
    if (!entry) return undefined;

    const now = Date.now();
    if (now - entry.ts > messageCacheTtlMs) {
      messageCache.delete(k);
      return undefined;
    }

    return entry.message;
  };

  const groupMetaCache = new Map();
  const groupMetaTtlMs = 30_000;

  const getCachedGroupMetadata = (groupJid) => {
    const v = groupMetaCache.get(groupJid);
    if (!v) return null;

    if (Date.now() - v.ts > groupMetaTtlMs) {
      groupMetaCache.delete(groupJid);
      return null;
    }

    return v.data || null;
  };

  const cachedGroupMetadata = async (jid) => getCachedGroupMetadata(jid) || undefined;

  const getGroupMetadata = async (socketRef, groupJid) => {
    const cached = getCachedGroupMetadata(groupJid);
    if (cached) return cached;

    const meta = await socketRef.groupMetadata(groupJid);
    groupMetaCache.set(groupJid, { ts: Date.now(), data: meta });
    return meta;
  };

  const getGroupSubject = async (socketRef, groupJid) => {
    try {
      const meta = await getGroupMetadata(socketRef, groupJid);
      return String(meta?.subject ?? '').trim();
    } catch {
      return '';
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const stopSocket = async () => {
    if (!socket) return;

    try {
      socket.ev.removeAllListeners('connection.update');
      socket.ev.removeAllListeners('creds.update');
      socket.ev.removeAllListeners('messages.upsert');
      socket.ev.removeAllListeners('group-participants.update');
    } catch {}

    try {
      socket.end();
    } catch {}

    socket = null;
  };

  const scheduleReconnect = async (reason) => {
    if (stopped) return;
    clearReconnectTimer();

    const delay = computeBackoff(reconnectAttempt);
    logger.warn('إعادة الاتصال قريبًا', { delay_ms: delay, reason });

    reconnectTimer = setTimeout(() => {
      reconnectAttempt += 1;
      void startSocket();
    }, delay);
  };

  const startSocket = async () => {
    try {
      if (stopped) return;

      clearReconnectTimer();
      await stopSocket();

      socket = makeWASocket({
        auth: {
          creds: auth.state.creds,
          keys: makeCacheableSignalKeyStore(auth.state.keys, baileysLogger)
        },
        logger: baileysLogger,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        getMessage,
        cachedGroupMetadata
      });

      socket.ev.on('creds.update', async () => {
        try {
          await auth.saveCreds();
          logger.info('تم حفظ بيانات المصادقة');
        } catch (err) {
          logger.warn('فشل حفظ بيانات المصادقة', { err: String(err) });
        }
      });

      socket.ev.on('connection.update', async (update) => {
        if (update.qr) {
          logger.info('امسح QR لتسجيل الدخول');
          qrcode.generate(update.qr, { small: true });
        }

        if (update.connection === 'open') {
          reconnectAttempt = 0;
          logger.info('تم الاتصال بواتساب');
          return;
        }

        if (update.connection === 'close') {
          const code = getDisconnectStatusCode(update.lastDisconnect);

          if (code === DisconnectReason.loggedOut) {
            logger.error('تم تسجيل الخروج: يلزم إعادة ربط الجلسة', { code });
            stopped = true;
            clearReconnectTimer();
            await stopSocket();
            try {
              await auth.flush();
            } catch {}
            process.exitCode = 1;
            return;
          }

          await scheduleReconnect(code ?? 'unknown');
        }
      });

      socket.ev.on('group-participants.update', async (update) => {
        try {
          const groupJid = update?.id;
          if (!isGroupJid(groupJid)) return;

          const action = String(update?.action ?? '').trim().toLowerCase();
          if (action !== 'add' && action !== 'invite') return;

          const participants = Array.isArray(update?.participants)
            ? update.participants.map(normalizeUserJid).filter(Boolean)
            : [];

          if (participants.length === 0) return;

          const botJid = normalizeUserJid(socket?.user?.id || null);

          const banned = [];
          const welcomed = [];

          for (const jid of participants) {
            if (!jid) continue;
            if (botJid && jid === botJid) continue;

            if (store.isBanned(groupJid, jid)) {
              banned.push(jid);
              continue;
            }

            welcomed.push(jid);
          }

          if (banned.length > 0) {
            const removed = [];
            const failed = [];

            for (let i = 0; i < banned.length; i += 1) {
              const jid = banned[i];
              try {
                await socket.groupParticipantsUpdate(groupJid, [jid], 'remove');
                removed.push(jid);
              } catch (err) {
                failed.push({ jid, err: String(err) });
              }

              if (i + 1 < banned.length) await sleep(350);
            }

            logger.info('إنفاذ حظر عند الانضمام', {
              group: groupJid,
              removed: removed.length,
              failed: failed.length
            });

            if (removed.length > 0) {
              try {
                await safeSendText(
                  socket,
                  groupJid,
                  `🚫 تم إخراج ${removed.length} عضو/أعضاء محظورين تلقائيًا.`,
                  null
                );
              } catch (err) {
                logger.warn('فشل إعلان إخراج محظور', { group: groupJid, err: String(err) });
              }
            }

            if (failed.length > 0) {
              try {
                await safeSendText(
                  socket,
                  groupJid,
                  '⚠️ تعذر إخراج عضو/أعضاء محظورين تلقائيًا. تأكد أن البوت مشرف في المجموعة.',
                  null
                );
              } catch (err) {
                logger.warn('فشل إعلان فشل إخراج محظور', { group: groupJid, err: String(err) });
              }
            }
          }

          const welcome = store.getWelcome(groupJid);
          if (!welcome?.enabled) return;

          if (welcomed.length === 0) return;

          const tags = welcomed.map(jidMentionTag).filter(Boolean);
          const usersLabel = tags.length > 0 ? tags.join('، ') : 'أهلًا بك!';

          const template = String(welcome.template ?? '').trim();
          const needsRules = /\{rules\}/i.test(template);
          const needsGroup = /\{group\}/i.test(template);

          const groupName = needsGroup ? await getGroupSubject(socket, groupJid) : '';
          const rules = needsRules ? renderRulesSummaryForWelcome(store, groupJid) : '';

          const text = renderWelcomeText(template, {
            user: usersLabel,
            group: groupName || 'المجموعة',
            rules,
            prefix: config.prefix
          });

          await safeSendText(socket, groupJid, text, null, { mentions: welcomed });

          logger.info('تم إرسال ترحيب', {
            group: groupJid,
            users: welcomed.length,
            has_rules: Boolean(rules)
          });
        } catch (err) {
          logger.warn('فشل التعامل مع تحديث أعضاء المجموعة', { err: String(err) });
        }
      });

      socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
          try {
            rememberMessage(msg);
            await commandRouter.handle({ socket, msg });
          } catch (err) {
            logger.warn('فشل التعامل مع رسالة', { err: String(err) });
          }
        }
      });
    } catch (err) {
      logger.error('فشل بدء الاتصال بواتساب', { err: String(err) });
      await scheduleReconnect('start_error');
    }
  };

  await startSocket();

  return {
    stop: async () => {
      stopped = true;
      clearReconnectTimer();
      await stopSocket();
      try {
        await auth.flush();
      } catch {}
      await store.close();
    }
  };
}
