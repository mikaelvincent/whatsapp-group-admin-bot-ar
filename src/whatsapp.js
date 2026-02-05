import fs from 'node:fs/promises';
import path from 'node:path';

import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import { createCommandRouter } from './commands.js';
import { createStore } from './storage.js';

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

function jidMentionTag(jid) {
  const u = normalizeUserJid(jid);
  const id = u ? u.split('@')[0] : '';
  return id ? `@${id}` : '';
}

async function safeSendText(socket, jid, text, extra) {
  if (!jid) return;

  const message = { text: String(text ?? '') };
  if (extra?.mentions && Array.isArray(extra.mentions) && extra.mentions.length > 0) {
    message.mentions = extra.mentions;
  }

  await socket.sendMessage(jid, message);
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureSecureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dirPath, 0o700);
  } catch {}
}

async function secureTree(rootPath) {
  const visit = async (p) => {
    let entries;
    try {
      entries = await fs.readdir(p, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (ent) => {
        const full = path.join(p, ent.name);
        if (ent.isDirectory()) {
          try {
            await fs.chmod(full, 0o700);
          } catch {}
          await visit(full);
          return;
        }

        try {
          await fs.chmod(full, 0o600);
        } catch {}
      })
    );
  };

  try {
    await fs.chmod(rootPath, 0o700);
  } catch {}

  await visit(rootPath);
}

function computeBackoff(attempt) {
  const base = 2000;
  const max = 60000;
  const delay = base * 2 ** Math.min(attempt, 5);
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(max, delay + jitter);
}

function disconnectCode(lastDisconnect) {
  const err = lastDisconnect?.error;
  const outputCode = err?.output?.statusCode;
  const directCode = err?.statusCode;
  const reason = outputCode ?? directCode;
  return typeof reason === 'number' ? reason : null;
}

function shouldRefreshWaWebVersion(code) {
  return code === 405 || code === DisconnectReason.unavailableService;
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

  const groupMetaCache = new Map();
  const groupMetaTtlMs = 30_000;

  const getGroupSubject = async (socketRef, groupJid) => {
    const now = Date.now();
    const cached = groupMetaCache.get(groupJid);

    if (cached && now - cached.ts < groupMetaTtlMs) return cached.subject;

    try {
      const meta = await socketRef.groupMetadata(groupJid);
      const subject = String(meta?.subject ?? '').trim();
      groupMetaCache.set(groupJid, { ts: now, subject });
      return subject;
    } catch (err) {
      groupMetaCache.set(groupJid, { ts: now, subject: '' });
      return '';
    }
  };

  let waWebVersion = null;
  let waWebVersionRefreshRequested = false;
  let waWebVersionFetchBlockedUntilMs = 0;

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
      socket.ws.close();
    } catch {}
    socket = null;
  };

  const requestWaWebVersionRefresh = (code) => {
    if (!shouldRefreshWaWebVersion(code)) return;
    waWebVersion = null;
    waWebVersionRefreshRequested = true;
  };

  const maybeFetchWaWebVersion = async () => {
    if (!waWebVersionRefreshRequested) return;
    const now = Date.now();
    if (now < waWebVersionFetchBlockedUntilMs) return;

    try {
      const res = await fetchLatestWaWebVersion({});
      if (res?.error) throw res.error;
      if (!Array.isArray(res?.version) || res.version.length < 3)
        throw new Error('invalid_wa_web_version');

      waWebVersion = res.version;
      waWebVersionRefreshRequested = false;

      logger.info('تم تحديث نسخة واتساب ويب', {
        version: res.version.join('.'),
        is_latest: Boolean(res.isLatest)
      });
    } catch (err) {
      waWebVersionFetchBlockedUntilMs = now + 60000;
      logger.warn('فشل تحديث نسخة واتساب ويب', {
        err: String(err),
        retry_after_ms: 60000
      });
    }
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

      await ensureSecureDir(config.authDir);
      await secureTree(config.authDir);

      const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

      await maybeFetchWaWebVersion();

      const socketConfig = {
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
        },
        logger: baileysLogger,
        markOnlineOnConnect: false,
        syncFullHistory: false
      };

      if (waWebVersion) {
        socketConfig.version = waWebVersion;
      }

      socket = makeWASocket(socketConfig);

      socket.ev.on('creds.update', async () => {
        try {
          await saveCreds();
          await secureTree(config.authDir);
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
          const code = disconnectCode(update.lastDisconnect);

          if (code !== null) requestWaWebVersionRefresh(code);

          if (code === DisconnectReason.loggedOut) {
            logger.error('تم تسجيل الخروج: يلزم إعادة ربط الجلسة', { code });
            stopped = true;
            clearReconnectTimer();
            await stopSocket();
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

          const botJid = normalizeUserJid(socket?.user?.id || socket?.user?.jid || null);

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
                  `🚫 تم إخراج ${removed.length} عضو/أعضاء محظورين تلقائيًا.`
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
                  '⚠️ تعذر إخراج عضو/أعضاء محظورين تلقائيًا. تأكد أن البوت مشرف في المجموعة.'
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

          await safeSendText(socket, groupJid, text, { mentions: welcomed });

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
      await store.close();
    }
  };
}
