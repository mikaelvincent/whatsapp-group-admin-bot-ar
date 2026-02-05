function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function isUserJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
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

function extractContextInfo(message) {
  const msg = unwrapMessage(message);
  if (!msg) return null;

  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    null
  );
}

function extractMentions(message) {
  const ctx = extractContextInfo(message);
  const raw = ctx?.mentionedJid;
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeUserJid).filter(Boolean);
}

function extractQuotedParticipant(message) {
  const ctx = extractContextInfo(message);
  return normalizeUserJid(ctx?.participant || null);
}

function parseCommand(text, prefix) {
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

function normalizePhoneTarget(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return normalizeUserJid(`${digits}@s.whatsapp.net`);
}

function resolveTargetsFromMessage(message, args) {
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

function renderHelp({ prefix, commands }) {
  const categories = {
    admin: 'إدارة',
    moderation: 'إشراف',
    fun: 'فعاليات'
  };

  const byCat = new Map(Object.keys(categories).map((k) => [k, []]));

  for (const cmd of commands) {
    const cat = categories[cmd.category] ? cmd.category : 'fun';
    byCat.get(cat).push(cmd);
  }

  const lines = [];
  lines.push('📋 قائمة الأوامر');
  lines.push('');
  lines.push('🛡️ ملاحظة: الأوامر المحمية تعمل للمخولين فقط.');

  for (const [catKey, label] of Object.entries(categories)) {
    const list = byCat.get(catKey) || [];
    if (list.length === 0) continue;

    lines.push('');
    lines.push(`• ${label}`);

    for (const cmd of list) {
      const names = [cmd.name, ...(cmd.aliases || [])]
        .map((n) => `${prefix}${n}`)
        .join(' / ');
      const suffix = cmd.privileged ? ' (محمي)' : '';
      lines.push(`- ${names}${suffix}`);
    }
  }

  lines.push('');
  lines.push(`اكتب ${prefix}targets لمعرفة طريقة تحديد الهدف.`);

  return lines.join('\n');
}

function formatJids(jids, limit = 5) {
  const raw = Array.isArray(jids) ? jids : [];
  const normalized = raw.map(normalizeUserJid).filter(Boolean);
  const ids = normalized.map((jid) => jid.split('@')[0]).filter(Boolean);

  if (ids.length === 0) return '';
  const head = ids.slice(0, limit).join(', ');
  if (ids.length <= limit) return head;
  return `${head} ... (+${ids.length - limit})`;
}

async function safeSendText(socket, jid, text, quoted, extra) {
  if (!jid) return;

  const message = { text: String(text ?? '') };
  if (extra?.mentions && Array.isArray(extra.mentions) && extra.mentions.length > 0) {
    message.mentions = extra.mentions;
  }

  await socket.sendMessage(jid, message, quoted ? { quoted } : undefined);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCommandRouter({ config, logger, store }) {
  const allowlist = new Set(
    (Array.isArray(config.allowlist) ? config.allowlist : [])
      .map(normalizeUserJid)
      .filter(Boolean)
  );

  const groupMetaCache = new Map();
  const groupMetaTtlMs = 30_000;

  const getGroupMetadata = async (socket, groupJid) => {
    const now = Date.now();
    const cached = groupMetaCache.get(groupJid);

    if (cached && now - cached.ts < groupMetaTtlMs) return cached.data;

    const data = await socket.groupMetadata(groupJid);
    groupMetaCache.set(groupJid, { ts: now, data });
    return data;
  };

  const getAdminStatus = async (socket, groupJid, userJid) => {
    if (!groupJid || !userJid) return { ok: true, isAdmin: false };

    try {
      const meta = await getGroupMetadata(socket, groupJid);
      const parts = meta?.participants;
      if (!Array.isArray(parts)) return { ok: true, isAdmin: false };

      const normalized = normalizeUserJid(userJid);

      for (const p of parts) {
        const pid = normalizeUserJid(p?.id || p?.jid || p?.participant || null);
        if (!pid) continue;
        if (pid !== normalized) continue;
        return { ok: true, isAdmin: Boolean(p?.admin) };
      }

      return { ok: true, isAdmin: false };
    } catch (err) {
      logger.warn('فشل التحقق من مشرفي المجموعة', { err: String(err) });
      return { ok: false, isAdmin: false };
    }
  };

  const getBotJid = (socket) => {
    const raw = socket?.user?.id || socket?.user?.jid || null;
    return normalizeUserJid(raw || null);
  };

  const sanitizeTargets = (socket, targets) => {
    const botJid = getBotJid(socket);
    const unique = Array.from(
      new Set((Array.isArray(targets) ? targets : []).map(normalizeUserJid).filter(Boolean))
    );

    return unique.filter((jid) => isUserJid(jid) && (!botJid || jid !== botJid));
  };

  const runGroupAction = async ({ socket, groupJid, action, targets }) => {
    const ok = [];
    const failed = [];

    for (let i = 0; i < targets.length; i += 1) {
      const jid = targets[i];

      try {
        await socket.groupParticipantsUpdate(groupJid, [jid], action);
        ok.push(jid);
      } catch (err) {
        failed.push({ jid, err: String(err) });
      }

      if (i + 1 < targets.length) await sleep(350);
    }

    return { ok, failed };
  };

  const commands = [
    {
      name: 'help',
      aliases: ['menu'],
      category: 'fun',
      privileged: false,
      groupOnly: true,
      handler: async (ctx) => {
        await ctx.reply(
          renderHelp({
            prefix: ctx.prefix,
            commands
          })
        );
      }
    },
    {
      name: 'ping',
      aliases: ['p'],
      category: 'fun',
      privileged: false,
      groupOnly: true,
      handler: async (ctx) => {
        await ctx.reply(String(config.pingResponse ?? '🏓 بونج!'));
      }
    },
    {
      name: 'auth',
      aliases: ['whoami'],
      category: 'fun',
      privileged: false,
      groupOnly: true,
      handler: async (ctx) => {
        if (allowlist.size === 0) {
          await ctx.reply('⚠️ لم يتم إعداد قائمة السماح للمخولين بعد.');
          return;
        }

        if (ctx.isAllowlisted) {
          await ctx.reply('✅ أنت ضمن قائمة السماح.');
          return;
        }

        await ctx.reply('❌ لست ضمن قائمة السماح.');
      }
    },
    {
      name: 'kick',
      aliases: [],
      category: 'admin',
      privileged: true,
      groupOnly: true,
      requiresBotAdmin: true,
      handler: async (ctx) => {
        const targets = sanitizeTargets(ctx.socket, ctx.targetJids);

        if (targets.length === 0) {
          await ctx.reply(`لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${ctx.prefix}kick @شخص`);
          return;
        }

        const res = await runGroupAction({
          socket: ctx.socket,
          groupJid: ctx.groupJid,
          action: 'remove',
          targets
        });

        const lines = [];
        if (res.ok.length > 0) lines.push(`✅ تم إخراج ${res.ok.length} عضو/أعضاء.`);
        if (res.failed.length > 0) {
          const failedList = formatJids(res.failed.map((f) => f.jid));
          lines.push(`⚠️ تعذر إخراج ${res.failed.length} عضو/أعضاء.${failedList ? `\nالذين تعذر إخراجهم: ${failedList}` : ''}`);
        }

        await ctx.reply(lines.join('\n'));
      }
    },
    {
      name: 'ban',
      aliases: [],
      category: 'admin',
      privileged: true,
      groupOnly: true,
      requiresBotAdmin: true,
      handler: async (ctx) => {
        const targets = sanitizeTargets(ctx.socket, ctx.targetJids);

        if (targets.length === 0) {
          await ctx.reply(`لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${ctx.prefix}ban @شخص`);
          return;
        }

        const res = await runGroupAction({
          socket: ctx.socket,
          groupJid: ctx.groupJid,
          action: 'remove',
          targets
        });

        let storeResult = null;
        let storeErr = null;

        if (res.ok.length > 0) {
          try {
            storeResult = await ctx.store.addBans(ctx.groupJid, res.ok);
          } catch (err) {
            storeErr = err;
          }
        }

        const lines = [];

        if (res.ok.length > 0) {
          lines.push(`✅ تم إخراج ${res.ok.length} عضو/أعضاء.`);
        }

        if (storeResult) {
          if (storeResult.added > 0) {
            lines.push(`🚫 تم حفظ الحظر الدائم لـ ${storeResult.added} عضو/أعضاء.`);
          } else {
            lines.push('🚫 الأهداف موجودة بالفعل في قائمة الحظر الدائم.');
          }
        } else if (res.ok.length > 0 && storeErr) {
          lines.push('⚠️ تم الإخراج لكن تعذر حفظ الحظر الدائم.');
        }

        if (res.failed.length > 0) {
          const failedList = formatJids(res.failed.map((f) => f.jid));
          lines.push(`⚠️ تعذر إخراج ${res.failed.length} عضو/أعضاء.${failedList ? `\nالذين تعذر إخراجهم: ${failedList}` : ''}`);
        }

        if (lines.length === 0) {
          await ctx.reply('لم يتم تنفيذ أي إجراء.');
          return;
        }

        await ctx.reply(lines.join('\n'));
      }
    },
    {
      name: 'unban',
      aliases: [],
      category: 'admin',
      privileged: true,
      groupOnly: true,
      handler: async (ctx) => {
        const targets = sanitizeTargets(ctx.socket, ctx.targetJids);

        if (targets.length === 0) {
          await ctx.reply(`لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${ctx.prefix}unban @شخص`);
          return;
        }

        let result;
        try {
          result = await ctx.store.removeBans(ctx.groupJid, targets);
        } catch (err) {
          await ctx.reply('حدث خطأ أثناء تحديث قائمة الحظر.');
          return;
        }

        if (result.removed === 0) {
          await ctx.reply('لا يوجد حظر على الأهداف المحددة.');
          return;
        }

        await ctx.reply(`✅ تم إلغاء الحظر عن ${result.removed} عضو/أعضاء.`);
      }
    },
    {
      name: 'promote',
      aliases: [],
      category: 'admin',
      privileged: true,
      groupOnly: true,
      requiresBotAdmin: true,
      handler: async (ctx) => {
        const targets = sanitizeTargets(ctx.socket, ctx.targetJids);

        if (targets.length === 0) {
          await ctx.reply(`لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${ctx.prefix}promote @شخص`);
          return;
        }

        const res = await runGroupAction({
          socket: ctx.socket,
          groupJid: ctx.groupJid,
          action: 'promote',
          targets
        });

        const lines = [];
        if (res.ok.length > 0) lines.push(`✅ تم ترقية ${res.ok.length} عضو/أعضاء إلى مشرف.`);
        if (res.failed.length > 0) {
          const failedList = formatJids(res.failed.map((f) => f.jid));
          lines.push(`⚠️ تعذر ترقية ${res.failed.length} عضو/أعضاء.${failedList ? `\nالذين تعذر ترقيتهم: ${failedList}` : ''}`);
        }

        await ctx.reply(lines.join('\n'));
      }
    },
    {
      name: 'demote',
      aliases: [],
      category: 'admin',
      privileged: true,
      groupOnly: true,
      requiresBotAdmin: true,
      handler: async (ctx) => {
        const targets = sanitizeTargets(ctx.socket, ctx.targetJids);

        if (targets.length === 0) {
          await ctx.reply(`لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${ctx.prefix}demote @شخص`);
          return;
        }

        const res = await runGroupAction({
          socket: ctx.socket,
          groupJid: ctx.groupJid,
          action: 'demote',
          targets
        });

        const lines = [];
        if (res.ok.length > 0) lines.push(`✅ تم تنزيل ${res.ok.length} مشرف/مشرفين.`);
        if (res.failed.length > 0) {
          const failedList = formatJids(res.failed.map((f) => f.jid));
          lines.push(`⚠️ تعذر تنزيل ${res.failed.length} عضو/أعضاء.${failedList ? `\nالذين تعذر تنزيلهم: ${failedList}` : ''}`);
        }

        await ctx.reply(lines.join('\n'));
      }
    },
    {
      name: 'targets',
      aliases: ['target'],
      category: 'fun',
      privileged: false,
      groupOnly: true,
      handler: async (ctx) => {
        const label =
          ctx.targetSource === 'mentions'
            ? 'بالإشارة'
            : ctx.targetSource === 'reply'
            ? 'بالرد'
            : ctx.targetSource === 'number'
            ? 'بالرقم'
            : 'غير محدد';

        if (ctx.targetJids.length === 0) {
          await ctx.reply(
            `لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${ctx.prefix}targets @شخص`
          );
          return;
        }

        await ctx.reply(`تم تحديد ${ctx.targetJids.length} هدف (${label}).`);
      }
    }
  ];

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

    const text = extractText(msg.message);
    if (!text) return;

    const parsed = parseCommand(text, config.prefix);
    if (!parsed) return;

    const def = commandIndex.get(parsed.name);

    const isGroup = isGroupJid(chatJid);
    const senderRawJid = isGroup ? msg.key?.participant : msg.key?.remoteJid;
    const senderJid = normalizeUserJid(senderRawJid);

    const isAllowlisted = Boolean(senderJid && allowlist.has(senderJid));
    const botJid = getBotJid(socket);

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
        const check = await getAdminStatus(socket, chatJid, senderJid);
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

        const check = await getAdminStatus(socket, chatJid, botJid);
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
