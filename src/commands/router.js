import { createAdminCommands } from './defs/admin.js';
import { createCoreCommands } from './defs/core.js';
import { createFunCommands, createTargetsCommand } from './defs/fun.js';
import { createModerationCommands } from './defs/moderation.js';
import { createModerationEnforcer } from './enforcers/moderation.js';
import { createMuteEnforcer } from './enforcers/mute.js';
import { createMenuManager } from './menu/manager.js';
import { createGroupAdminService } from './services/groupAdmin.js';
import { isGroupJid, isUserJid, normalizeUserJid } from './utils/jid.js';
import { extractMentions, extractQuotedParticipant, extractText } from './utils/message.js';
import { parseCommand, resolveTargetsFromMessage } from './utils/parse.js';
import { safeSendText } from './utils/send.js';

export function createCommandRouter({ config, logger, store }) {
  const allowlist = new Set(
    (Array.isArray(config.allowlist) ? config.allowlist : [])
      .map(normalizeUserJid)
      .filter(Boolean)
  );

  const warnCooldownMs = Number.isFinite(config.moderationWarnCooldownMs)
    ? config.moderationWarnCooldownMs
    : 15_000;

  const commandCooldownMs = Number.isFinite(config.commandCooldownMs) ? config.commandCooldownMs : 1200;

  const funCooldownMs = Number.isFinite(config.funCooldownMs) ? config.funCooldownMs : 6000;

  const warnCache = new Map();
  const commandCooldownCache = new Map();

  const groupAdmin = createGroupAdminService({ logger, ttlMs: 30_000 });

  const commands = [];
  const menu = createMenuManager({ config, logger, store, allowlist, commandsRef: commands });

  const shouldSendWarning = (groupJid, senderJid, rule) => {
    if (!warnCooldownMs || warnCooldownMs <= 0) return true;

    const key = `${groupJid}|${senderJid}|${rule}`;
    const now = Date.now();
    const last = warnCache.get(key);

    if (typeof last === 'number' && now - last < warnCooldownMs) return false;
    warnCache.set(key, now);

    if (warnCache.size > 5000) warnCache.clear();

    return true;
  };

  const cooldownRemainingMs = (key, windowMs, now) => {
    if (!windowMs || windowMs <= 0) return 0;

    const last = commandCooldownCache.get(key);
    if (typeof last !== 'number') return 0;

    const delta = now - last;
    if (delta >= windowMs) return 0;

    return windowMs - delta;
  };

  const bumpCooldown = (key, now) => {
    commandCooldownCache.set(key, now);
    if (commandCooldownCache.size > 20_000) commandCooldownCache.clear();
  };

  const cooldownWaitAr = (ms) => {
    const sec = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
    return `${sec} ثانية`;
  };

  const muteEnforcer = createMuteEnforcer({
    logger,
    store,
    getAdminStatus: groupAdmin.getAdminStatus,
    shouldSendWarning
  });

  const moderationEnforcer = createModerationEnforcer({
    logger,
    store,
    getAdminStatus: groupAdmin.getAdminStatus,
    shouldSendWarning
  });

  commands.push(...createCoreCommands({ config, menu, commandsRef: commands }));
  commands.push(...createModerationCommands({ config, logger, store }));
  commands.push(...createFunCommands({ config, allowlist }));
  commands.push(
    ...createAdminCommands({
      logger,
      sanitizeTargets: groupAdmin.sanitizeTargets,
      getAdminStatus: groupAdmin.getAdminStatus
    })
  );
  commands.push(createTargetsCommand({ config }));

  const commandIndex = new Map();
  for (const cmd of commands) {
    commandIndex.set(cmd.name.toLowerCase(), cmd);
    for (const a of cmd.aliases || []) {
      commandIndex.set(String(a).toLowerCase(), cmd);
    }
  }

  const replyUnknownCommand = async (socket, jid, quoted) => {
    await safeSendText(socket, jid, `أمر غير معروف. اكتب ${config.prefix}help لعرض الأوامر.`, quoted);
  };

  const replyGroupOnly = async (socket, jid, quoted) => {
    await safeSendText(socket, jid, 'هذا الأمر يعمل داخل المجموعات فقط.', quoted);
  };

  const replyNotAllowlisted = async (socket, jid, quoted) => {
    if (allowlist.size === 0) {
      await safeSendText(socket, jid, '⚠️ لم يتم إعداد قائمة السماح للمخولين بعد.', quoted);
      return;
    }

    await safeSendText(socket, jid, 'عذرًا، هذا الأمر مخصص للمخولين فقط.', quoted);
  };

  const replyNotGroupAdmin = async (socket, jid, quoted) => {
    await safeSendText(socket, jid, 'عذرًا، هذا الأمر متاح لمشرفي المجموعة فقط.', quoted);
  };

  const replyCannotVerifyAdmin = async (socket, jid, quoted) => {
    await safeSendText(socket, jid, 'تعذر التحقق من صلاحيات المشرفين حاليًا. حاول لاحقًا.', quoted);
  };

  const replyBotNotAdmin = async (socket, jid, quoted) => {
    await safeSendText(socket, jid, 'لا يمكن تنفيذ الأمر لأن البوت ليس مشرفًا في المجموعة.', quoted);
  };

  const handle = async ({ socket, msg }) => {
    if (!msg?.message) return;
    if (msg.key?.fromMe) return;

    const chatJid = msg.key?.remoteJid;
    if (!chatJid || chatJid === 'status@broadcast') return;
    if (!isGroupJid(chatJid) && !isUserJid(chatJid)) return;

    const isGroup = isGroupJid(chatJid);
    const senderRawJid = isGroup ? msg.key?.participant : msg.key?.remoteJid;
    const senderJid = normalizeUserJid(senderRawJid);

    const senderAltRawJid = isGroup ? msg.key?.participantAlt : msg.key?.remoteJidAlt;
    const senderAltJid = normalizeUserJid(senderAltRawJid);

    const isAllowlisted = Boolean(
      (senderJid && allowlist.has(senderJid)) || (senderAltJid && allowlist.has(senderAltJid))
    );

    const botJid = groupAdmin.getBotJid(socket);

    if (isGroup && senderJid) {
      try {
        const enforced = await muteEnforcer({
          socket,
          msg,
          groupJid: chatJid,
          senderJid,
          botJid
        });

        if (enforced) return;
      } catch (err) {
        logger.warn('فشل تنفيذ كتم', { group: chatJid, from: senderJid, err: String(err) });
      }
    }

    if (isGroup && senderJid) {
      try {
        await moderationEnforcer({
          socket,
          msg,
          groupJid: chatJid,
          senderJid,
          isAllowlisted,
          botJid
        });
      } catch (err) {
        logger.warn('فشل تنفيذ إشراف', { group: chatJid, from: senderJid, err: String(err) });
      }
    }

    const text = extractText(msg.message);
    const parsed = parseCommand(text, config.prefix);

    if (!parsed) {
      if (isGroup) {
        try {
          const handled = await menu.maybeHandleMenuNavigation({
            socket,
            msg,
            groupJid: chatJid,
            text,
            isAllowlisted
          });
          if (handled) return;
        } catch (err) {
          logger.warn('فشل التعامل مع تنقل القائمة', { group: chatJid, err: String(err) });
        }
      }

      return;
    }

    const def = commandIndex.get(parsed.name);

    if (!def) {
      logger.info('أمر غير معروف', {
        command: parsed.name,
        chat: chatJid,
        group: isGroup ? chatJid : null,
        from: senderJid
      });

      await replyUnknownCommand(socket, chatJid, msg);
      return;
    }

    if (def.groupOnly && !isGroup) {
      logger.warn('رفض أمر خارج مجموعة', {
        command: def.name,
        chat: chatJid,
        from: senderJid
      });

      await replyGroupOnly(socket, chatJid, msg);
      return;
    }

    if (def.privileged) {
      if (!isAllowlisted) {
        logger.warn('رفض أمر لعدم الصلاحية', {
          command: def.name,
          group: chatJid,
          from: senderJid
        });

        await replyNotAllowlisted(socket, chatJid, msg);
        return;
      }

      if (config.requireCallerAdmin) {
        const check = await groupAdmin.getAdminStatus(socket, chatJid, senderJid);
        if (!check.ok) {
          logger.warn('فشل التحقق من صلاحية المرسل', {
            command: def.name,
            group: chatJid,
            from: senderJid
          });

          await replyCannotVerifyAdmin(socket, chatJid, msg);
          return;
        }

        if (!check.isAdmin) {
          logger.warn('رفض أمر لعدم كون المرسل مشرفًا', {
            command: def.name,
            group: chatJid,
            from: senderJid
          });

          await replyNotGroupAdmin(socket, chatJid, msg);
          return;
        }
      }

      if (def.requiresBotAdmin) {
        if (!botJid) {
          logger.warn('فشل تحديد هوية البوت', { command: def.name, group: chatJid });
          await replyCannotVerifyAdmin(socket, chatJid, msg);
          return;
        }

        const check = await groupAdmin.getAdminStatus(socket, chatJid, botJid);
        if (!check.ok) {
          logger.warn('فشل التحقق من صلاحية البوت', { command: def.name, group: chatJid });
          await replyCannotVerifyAdmin(socket, chatJid, msg);
          return;
        }

        if (!check.isAdmin) {
          logger.warn('رفض أمر لأن البوت ليس مشرفًا', {
            command: def.name,
            group: chatJid,
            from: senderJid
          });

          await replyBotNotAdmin(socket, chatJid, msg);
          return;
        }
      }
    }

    if (senderJid && isGroupJid(chatJid)) {
      const now = Date.now();
      const baseKey = `${chatJid}|${senderJid}|cmd`;
      const funKey = `${chatJid}|${senderJid}|fun`;

      const baseWait = cooldownRemainingMs(baseKey, commandCooldownMs, now);
      if (baseWait > 0) {
        logger.warn('رفض أمر بسبب تهدئة', {
          command: def.name,
          group: chatJid,
          from: senderJid,
          wait_ms: baseWait,
          scope: 'cmd'
        });

        await safeSendText(
          socket,
          chatJid,
          `⏳ انتظر ${cooldownWaitAr(baseWait)} قبل إعادة استخدام الأوامر.`,
          msg
        );
        return;
      }

      if (def.category === 'fun') {
        const funWait = cooldownRemainingMs(funKey, funCooldownMs, now);
        if (funWait > 0) {
          logger.warn('رفض أمر بسبب تهدئة', {
            command: def.name,
            group: chatJid,
            from: senderJid,
            wait_ms: funWait,
            scope: 'fun'
          });

          await safeSendText(
            socket,
            chatJid,
            `⏳ انتظر ${cooldownWaitAr(funWait)} قبل استخدام أوامر الفعاليات مرة أخرى.`,
            msg
          );
          return;
        }
      }

      if (commandCooldownMs > 0) bumpCooldown(baseKey, now);
      if (def.category === 'fun' && funCooldownMs > 0) bumpCooldown(funKey, now);
    }

    const resolution = resolveTargetsFromMessage(msg.message, parsed.args);

    const ctx = {
      socket,
      msg,
      chatJid,
      groupJid: isGroup ? chatJid : null,
      senderJid,
      senderRawJid,
      botJid,
      prefix: config.prefix,
      command: def.name,
      args: parsed.args,
      rawArgs: parsed.rawArgs,
      mentions: extractMentions(msg.message),
      quotedParticipant: extractQuotedParticipant(msg.message),
      targetJids: resolution.targets,
      targetSource: resolution.source,
      isAllowlisted,
      store,
      reply: async (t, extra) => safeSendText(socket, chatJid, t, msg, extra)
    };

    logger.info('تنفيذ أمر', {
      command: def.name,
      group: chatJid,
      from: senderJid,
      privileged: def.privileged,
      allowlisted: isAllowlisted
    });

    try {
      await def.handler(ctx);
      logger.info('تم تنفيذ الأمر', {
        command: def.name,
        group: chatJid,
        from: senderJid
      });
    } catch (err) {
      logger.error('فشل تنفيذ أمر', {
        command: def.name,
        group: chatJid,
        from: senderJid,
        err: String(err?.stack || err)
      });

      await safeSendText(socket, chatJid, 'حدث خطأ أثناء تنفيذ الأمر.', msg);
    }
  };

  return { handle };
}
