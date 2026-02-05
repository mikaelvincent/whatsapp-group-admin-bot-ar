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

async function ensureSecureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dirPath, 0o700);
  } catch {
    // Ignore permission errors; operator may run on a FS that doesn't support chmod.
  }
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
          } catch {
            // ignore
          }
          await visit(full);
          return;
        }

        try {
          await fs.chmod(full, 0o600);
        } catch {
          // ignore
        }
      })
    );
  };

  try {
    await fs.chmod(rootPath, 0o700);
  } catch {
    // ignore
  }

  await visit(rootPath);
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function unwrapMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.ephemeralMessage?.message) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message)
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  return message;
}

function extractText(message) {
  const msg = unwrapMessage(message);
  if (!msg) return null;

  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    null
  );
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
    } catch {
      // ignore
    }

    try {
      socket.ws.close();
    } catch {
      // ignore
    }
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

    // Only override the WA Web version when servers start rejecting the built-in one (405/503),
    // to reduce the chance of using a too-new version with incompatible protobufs.
    try {
      const res = await fetchLatestWaWebVersion({});
      if (res?.error) throw res.error;
      if (!Array.isArray(res?.version) || res.version.length < 3) throw new Error('invalid_wa_web_version');

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

      socket.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
          try {
            if (!msg?.message) continue;
            if (msg.key?.fromMe) continue;

            const jid = msg.key?.remoteJid;
            if (!isGroupJid(jid)) continue;

            const text = extractText(msg.message);
            if (!text) continue;

            const trimmed = String(text).trim();
            const expected = `${config.prefix}ping`;
            if (trimmed.toLowerCase() !== expected.toLowerCase()) continue;

            logger.info('تنفيذ أمر', {
              command: 'ping',
              group: jid,
              from: msg.key?.participant || msg.key?.remoteJid
            });

            await socket.sendMessage(
              jid,
              {
                text: config.pingResponse
              },
              { quoted: msg }
            );
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
    }
  };
}
