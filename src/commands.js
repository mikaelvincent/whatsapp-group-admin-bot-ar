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

function parseDurationToken(value) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase();

  if (!v) return null;

  const match = v.match(/^(\d{1,6})([smhdw])$/);
  if (!match) return null;

  const count = Number.parseInt(match[1], 10);
  if (!Number.isFinite(count) || count <= 0) return null;

  const unit = match[2];

  const mult =
    unit === 's'
      ? 1000
      : unit === 'm'
      ? 60_000
      : unit === 'h'
      ? 3_600_000
      : unit === 'd'
      ? 86_400_000
      : 604_800_000;

  const ms = count * mult;
  const maxMs = 365 * 24 * 60 * 60 * 1000;

  if (ms > maxMs) return { count, unit, ms, tooLarge: true };
  return { count, unit, ms, tooLarge: false };
}

function renderDurationAr(duration) {
  if (!duration) return '';
  const label =
    duration.unit === 's'
      ? 'ثانية'
      : duration.unit === 'm'
      ? 'دقيقة'
      : duration.unit === 'h'
      ? 'ساعة'
      : duration.unit === 'd'
      ? 'يوم'
      : 'أسبوع';
  return `${duration.count} ${label}`;
}

function normalizePhoneTarget(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length < 6 || digits.length > 20) return null;
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

function normalizeSearchText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findFirstLink(text) {
  const v = String(text ?? '');
  if (!v) return null;
  const match = v.match(/https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?/i);
  return match ? String(match[0] ?? '') : null;
}

function findBannedWord(text, bannedWords) {
  const hay = normalizeSearchText(text);
  if (!hay) return null;

  for (const raw of Array.isArray(bannedWords) ? bannedWords : []) {
    const needle = normalizeSearchText(raw);
    if (!needle) continue;
    if (hay.includes(needle)) return needle;
  }

  return null;
}

function detectMedia(message) {
  const msg = unwrapMessage(message);
  if (!msg) return { hasImage: false, hasSticker: false };
  return {
    hasImage: Boolean(msg.imageMessage),
    hasSticker: Boolean(msg.stickerMessage)
  };
}

function jidMentionTag(jid) {
  const u = normalizeUserJid(jid);
  const id = u ? u.split('@')[0] : '';
  return id ? `@${id}` : '';
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

  const warnCooldownMs = Number.isFinite(config.moderationWarnCooldownMs)
    ? config.moderationWarnCooldownMs
    : 15_000;

  const warnCache = new Map();

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

  const parseOnOff = (value) => {
    const v = String(value ?? '')
      .trim()
      .toLowerCase();

    if (!v) return null;
    if (['on', 'enable', 'enabled', '1', 'true', 'yes', 'y'].includes(v)) return true;
    if (['off', 'disable', 'disabled', '0', 'false', 'no', 'n'].includes(v)) return false;
    return null;
  };

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

  const maybeEnforceMuteMessage = async ({ socket, msg, groupJid, senderJid, botJid }) => {
    if (!groupJid || !senderJid) return false;

    const state = store.getMute(groupJid, senderJid);
    if (!state?.muted) return false;

    let deleted = false;

    if (msg?.key) {
      let canDelete = true;

      if (botJid) {
        const botCheck = await getAdminStatus(socket, groupJid, botJid);
        if (botCheck.ok && !botCheck.isAdmin) canDelete = false;
      }

      if (canDelete) {
        try {
          await socket.sendMessage(groupJid, { delete: msg.key });
          deleted = true;
        } catch (err) {
          logger.warn('فشل حذف رسالة مكتوم', {
            group: groupJid,
            from: senderJid,
            err: String(err)
          });
        }
      }
    }

    logger.info('تنفيذ كتم', {
      group: groupJid,
      from: senderJid,
      deleted,
      until_ms: state.until
    });

    if (!shouldSendWarning(groupJid, senderJid, 'mute')) return true;

    const tag = jidMentionTag(senderJid);
    const mentions = tag ? [senderJid] : [];

    const warningText = `⚠️ ${tag} أنت مكتوم في هذه المجموعة.`;

    try {
      await safeSendText(socket, groupJid, warningText, null, { mentions });
    } catch (err) {
      logger.warn('فشل إرسال تحذير كتم', { group: groupJid, from: senderJid, err: String(err) });
    }

    return true;
  };

  const maybeModerateMessage = async ({ socket, msg, groupJid, senderJid, isAllowlisted, botJid }) => {
    if (!groupJid || !senderJid) return;

    const moderation = store.getModeration(groupJid);
    if (!moderation) return;

    const anyEnabled =
      moderation.antiLink ||
      moderation.filterEnabled ||
      moderation.antiImage ||
      moderation.antiSticker;

    if (!anyEnabled) return;

    if (moderation.exemptAllowlisted && isAllowlisted) return;

    if (moderation.exemptAdmins) {
      const check = await getAdminStatus(socket, groupJid, senderJid);
      if (!check.ok) return;
      if (check.isAdmin) return;
    }

    const media = detectMedia(msg.message);
    const text = extractText(msg.message);

    let rule = null;
    let match = null;

    if (moderation.antiImage && media.hasImage) {
      rule = 'antiimage';
    } else if (moderation.antiSticker && media.hasSticker) {
      rule = 'antisticker';
    } else if (
      moderation.filterEnabled &&
      Array.isArray(moderation.bannedWords) &&
      moderation.bannedWords.length > 0
    ) {
      const found = findBannedWord(text, moderation.bannedWords);
      if (found) {
        rule = 'filter';
        match = 'banned_word';
      }
    } else if (moderation.antiLink) {
      const link = findFirstLink(text);
      if (link) {
        rule = 'antilink';
        match = 'link';
      }
    }

    if (!rule) return;

    let deleted = false;

    if (msg?.key) {
      let canDelete = true;

      if (botJid) {
        const botCheck = await getAdminStatus(socket, groupJid, botJid);
        if (botCheck.ok && !botCheck.isAdmin) canDelete = false;
      }

      if (canDelete) {
        try {
          await socket.sendMessage(groupJid, { delete: msg.key });
          deleted = true;
        } catch (err) {
          logger.warn('فشل حذف رسالة إشراف', {
            group: groupJid,
            from: senderJid,
            rule,
            err: String(err)
          });
        }
      }
    }

    logger.info('تنفيذ إشراف', {
      group: groupJid,
      from: senderJid,
      rule,
      deleted,
      match
    });

    if (!shouldSendWarning(groupJid, senderJid, rule)) return;

    const tag = jidMentionTag(senderJid);
    const mentions = tag ? [senderJid] : [];

    const warningText =
      rule === 'antilink'
        ? `⚠️ ${tag} يُمنع إرسال الروابط في هذه المجموعة.`
        : rule === 'filter'
        ? `⚠️ ${tag} هذه العبارة غير مسموحة في هذه المجموعة.`
        : rule === 'antiimage'
        ? `⚠️ ${tag} يُمنع إرسال الصور في هذه المجموعة.`
        : `⚠️ ${tag} يُمنع إرسال الملصقات في هذه المجموعة.`;

    try {
      await safeSendText(socket, groupJid, warningText, null, { mentions });
    } catch (err) {
      logger.warn('فشل إرسال تحذير إشراف', { group: groupJid, from: senderJid, rule, err: String(err) });
    }
  };

  const renderRules = (groupJid) => {
    const m = store.getModeration(groupJid);
    if (!m) return 'تعذر قراءة إعدادات الإشراف لهذه المجموعة.';

    const onOff = (v) => (v ? 'مفعل ✅' : 'معطل ❌');

    const lines = [];
    lines.push('📜 القواعد الحالية');
    lines.push('');
    lines.push(`- منع الروابط: ${onOff(m.antiLink)}`);
    lines.push(
      `- فلتر الكلمات: ${onOff(m.filterEnabled)}${
        m.filterEnabled ? ` (عدد العناصر: ${m.bannedWords.length})` : ''
      }`
    );
    lines.push(`- منع الصور: ${onOff(m.antiImage)}`);
    lines.push(`- منع الملصقات: ${onOff(m.antiSticker)}`);
    lines.push('');
    lines.push(`- استثناء المخولين: ${onOff(m.exemptAllowlisted)}`);
    lines.push(`- استثناء مشرفي المجموعة: ${onOff(m.exemptAdmins)}`);
    lines.push('');
    lines.push('ملاحظة: حذف الرسائل يحتاج أن يكون البوت مشرفًا.');

    return lines.join('\n');
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
      name: 'rules',
      aliases: [],
      category: 'moderation',
      privileged: false,
      groupOnly: true,
      handler: async (ctx) => {
        await ctx.reply(renderRules(ctx.groupJid));
      }
    },
    {
      name: 'antilink',
      aliases: [],
      category: 'moderation',
      privileged: true,
      groupOnly: true,
      handler: async (ctx) => {
        const enabled = parseOnOff(ctx.args[0]);
        if (enabled === null) {
          await ctx.reply(`الاستخدام: ${ctx.prefix}antilink on|off`);
          return;
        }

        try {
          const res = await ctx.store.setAntiLink(ctx.groupJid, enabled);
          if (!res?.ok) throw new Error('store_rejected');
        } catch (err) {
          logger.warn('فشل تحديث منع الروابط', { group: ctx.groupJid, err: String(err) });
          await ctx.reply('حدث خطأ أثناء تحديث إعدادات منع الروابط.');
          return;
        }

        await ctx.reply(enabled ? '✅ تم تفعيل منع الروابط.' : '✅ تم تعطيل منع الروابط.');
      }
    },
    {
      name: 'antiimage',
      aliases: [],
      category: 'moderation',
      privileged: true,
      groupOnly: true,
      handler: async (ctx) => {
        const enabled = parseOnOff(ctx.args[0]);
        if (enabled === null) {
          await ctx.reply(`الاستخدام: ${ctx.prefix}antiimage on|off`);
          return;
        }

        try {
          const res = await ctx.store.setAntiImage(ctx.groupJid, enabled);
          if (!res?.ok) throw new Error('store_rejected');
        } catch (err) {
          logger.warn('فشل تحديث منع الصور', { group: ctx.groupJid, err: String(err) });
          await ctx.reply('حدث خطأ أثناء تحديث إعدادات منع الصور.');
          return;
        }

        await ctx.reply(enabled ? '✅ تم تفعيل منع الصور.' : '✅ تم تعطيل منع الصور.');
      }
    },
    {
      name: 'antisticker',
      aliases: [],
      category: 'moderation',
      privileged: true,
      groupOnly: true,
      handler: async (ctx) => {
        const enabled = parseOnOff(ctx.args[0]);
        if (enabled === null) {
          await ctx.reply(`الاستخدام: ${ctx.prefix}antisticker on|off`);
          return;
        }

        try {
          const res = await ctx.store.setAntiSticker(ctx.groupJid, enabled);
          if (!res?.ok) throw new Error('store_rejected');
        } catch (err) {
          logger.warn('فشل تحديث منع الملصقات', { group: ctx.groupJid, err: String(err) });
          await ctx.reply('حدث خطأ أثناء تحديث إعدادات منع الملصقات.');
          return;
        }

        await ctx.reply(enabled ? '✅ تم تفعيل منع الملصقات.' : '✅ تم تعطيل منع الملصقات.');
      }
    },
    {
      name: 'filter',
      aliases: [],
      category: 'moderation',
      privileged: true,
      groupOnly: true,
      handler: async (ctx) => {
        const sub = String(ctx.args[0] ?? '')
          .trim()
          .toLowerCase();

        const usage =
          `الاستخدام:\n` +
          `- ${ctx.prefix}filter on|off\n` +
          `- ${ctx.prefix}filter add <كلمة/عبارة>\n` +
          `- ${ctx.prefix}filter remove <كلمة/عبارة>\n` +
          `- ${ctx.prefix}filter list`;

        if (!sub) {
          await ctx.reply(usage);
          return;
        }

        if (sub === 'on' || sub === 'off') {
          const enabled = sub === 'on';
          try {
            const res = await ctx.store.setFilterEnabled(ctx.groupJid, enabled);
            if (!res?.ok) throw new Error('store_rejected');
          } catch (err) {
            logger.warn('فشل تحديث فلتر الكلمات', { group: ctx.groupJid, err: String(err) });
            await ctx.reply('حدث خطأ أثناء تحديث إعدادات فلتر الكلمات.');
            return;
          }

          await ctx.reply(enabled ? '✅ تم تفعيل فلتر الكلمات.' : '✅ تم تعطيل فلتر الكلمات.');
          return;
        }

        if (sub === 'list') {
          const words = ctx.store.listBannedWords(ctx.groupJid);
          if (!words || words.length === 0) {
            await ctx.reply('لا توجد كلمات/عبارات في قائمة المنع.');
            return;
          }

          const max = 30;
          const head = words.slice(0, max);
          const lines = [];
          lines.push('🚫 قائمة الكلمات/العبارات الممنوعة');
          lines.push('');

          for (let i = 0; i < head.length; i += 1) {
            lines.push(`${i + 1}) ${head[i]}`);
          }

          if (words.length > max) lines.push(`\n... (+${words.length - max})`);

          await ctx.reply(lines.join('\n'));
          return;
        }

        if (sub === 'add') {
          const phrase = String(ctx.args.slice(1).join(' ') ?? '').trim();
          if (!phrase) {
            await ctx.reply(`اكتب العبارة بعد الأمر.\nمثال: ${ctx.prefix}filter add كلمة`);
            return;
          }

          if (phrase.length > 200) {
            await ctx.reply('العبارة طويلة جدًا. حاول تقصيرها.');
            return;
          }

          let res;
          try {
            res = await ctx.store.addBannedWord(ctx.groupJid, phrase);
          } catch (err) {
            logger.warn('فشل إضافة كلمة ممنوعة', { group: ctx.groupJid, err: String(err) });
            await ctx.reply('حدث خطأ أثناء تحديث قائمة المنع.');
            return;
          }

          if (res?.added) {
            await ctx.reply(`✅ تم إضافة العبارة إلى قائمة المنع. (الإجمالي: ${res.total})`);
            return;
          }

          await ctx.reply('هذه العبارة موجودة بالفعل في قائمة المنع.');
          return;
        }

        if (sub === 'remove' || sub === 'del' || sub === 'delete') {
          const phrase = String(ctx.args.slice(1).join(' ') ?? '').trim();
          if (!phrase) {
            await ctx.reply(`اكتب العبارة بعد الأمر.\nمثال: ${ctx.prefix}filter remove كلمة`);
            return;
          }

          let res;
          try {
            res = await ctx.store.removeBannedWord(ctx.groupJid, phrase);
          } catch (err) {
            logger.warn('فشل إزالة كلمة ممنوعة', { group: ctx.groupJid, err: String(err) });
            await ctx.reply('حدث خطأ أثناء تحديث قائمة المنع.');
            return;
          }

          if (res?.removed) {
            await ctx.reply(`✅ تم حذف العبارة من قائمة المنع. (الإجمالي: ${res.total})`);
            return;
          }

          await ctx.reply('هذه العبارة غير موجودة في قائمة المنع.');
          return;
        }

        await ctx.reply(usage);
      }
    },
    {
      name: 'exempt',
      aliases: [],
      category: 'moderation',
      privileged: true,
      groupOnly: true,
      handler: async (ctx) => {
        const kind = String(ctx.args[0] ?? '')
          .trim()
          .toLowerCase();
        const enabled = parseOnOff(ctx.args[1]);

        if (!kind || enabled === null) {
          await ctx.reply(`الاستخدام: ${ctx.prefix}exempt allowlist|admins on|off`);
          return;
        }

        const isAllowlist = ['allowlist', 'allowlisted', 'allowed'].includes(kind);
        const isAdmins = ['admins', 'admin', 'groupadmins', 'groupadmin'].includes(kind);

        if (!isAllowlist && !isAdmins) {
          await ctx.reply(`الاستخدام: ${ctx.prefix}exempt allowlist|admins on|off`);
          return;
        }

        try {
          const res = isAllowlist
            ? await ctx.store.setExemptAllowlisted(ctx.groupJid, enabled)
            : await ctx.store.setExemptAdmins(ctx.groupJid, enabled);
          if (!res?.ok) throw new Error('store_rejected');
        } catch (err) {
          logger.warn('فشل تحديث الاستثناءات', { group: ctx.groupJid, err: String(err) });
          await ctx.reply('حدث خطأ أثناء تحديث إعدادات الاستثناءات.');
          return;
        }

        const label = isAllowlist ? 'المخولين' : 'مشرفي المجموعة';
        await ctx.reply(enabled ? `✅ تم تفعيل استثناء ${label}.` : `✅ تم تعطيل استثناء ${label}.`);
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
          lines.push(
            `⚠️ تعذر إخراج ${res.failed.length} عضو/أعضاء.${failedList ? `\nالذين تعذر إخراجهم: ${failedList}` : ''}`
          );
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
          lines.push(
            `⚠️ تعذر إخراج ${res.failed.length} عضو/أعضاء.${failedList ? `\nالذين تعذر إخراجهم: ${failedList}` : ''}`
          );
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
      name: 'mute',
      aliases: [],
      category: 'admin',
      privileged: true,
      groupOnly: true,
      handler: async (ctx) => {
        const targets = sanitizeTargets(ctx.socket, ctx.targetJids);

        if (targets.length === 0) {
          await ctx.reply(
            `لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${ctx.prefix}mute @شخص 10m`
          );
          return;
        }

        let duration = null;
        for (const a of Array.isArray(ctx.args) ? ctx.args : []) {
          const parsed = parseDurationToken(a);
          if (!parsed) continue;

          if (parsed.tooLarge) {
            await ctx.reply('المدة كبيرة جدًا. الحد الأقصى هو 365 يوم. مثال: !mute @شخص 10m');
            return;
          }

          duration = parsed;
          break;
        }

        const untilMs = duration ? Date.now() + duration.ms : null;

        let res;
        try {
          res = await ctx.store.addMutes(ctx.groupJid, targets, untilMs);
        } catch (err) {
          logger.warn('فشل تحديث قائمة الكتم', { group: ctx.groupJid, err: String(err) });
          await ctx.reply('حدث خطأ أثناء تحديث قائمة الكتم.');
          return;
        }

        const lines = [];

        if (duration) {
          lines.push(`✅ تم كتم ${targets.length} عضو/أعضاء لمدة ${renderDurationAr(duration)}.`);
        } else {
          lines.push(`✅ تم كتم ${targets.length} عضو/أعضاء بدون مدة.`);
        }

        if (res && res.added === 0 && res.updated === 0) {
          lines.push('ℹ️ الأهداف مكتومون بالفعل.');
        }

        if (ctx.botJid) {
          const check = await getAdminStatus(ctx.socket, ctx.groupJid, ctx.botJid);
          if (!check.ok) {
            lines.push('⚠️ ملاحظة: تعذر التحقق من صلاحيات البوت لحذف رسائل المكتومين.');
          } else if (!check.isAdmin) {
            lines.push('⚠️ ملاحظة: البوت ليس مشرفًا وقد لا يستطيع حذف رسائل المكتومين.');
          }
        }

        await ctx.reply(lines.join('\n'));
      }
    },
    {
      name: 'unmute',
      aliases: [],
      category: 'admin',
      privileged: true,
      groupOnly: true,
      handler: async (ctx) => {
        const targets = sanitizeTargets(ctx.socket, ctx.targetJids);

        if (targets.length === 0) {
          await ctx.reply(
            `لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${ctx.prefix}unmute @شخص`
          );
          return;
        }

        let res;
        try {
          res = await ctx.store.removeMutes(ctx.groupJid, targets);
        } catch (err) {
          logger.warn('فشل تحديث قائمة فك الكتم', { group: ctx.groupJid, err: String(err) });
          await ctx.reply('حدث خطأ أثناء تحديث قائمة الكتم.');
          return;
        }

        if (!res || res.removed === 0) {
          await ctx.reply('لا يوجد كتم على الأهداف المحددة.');
          return;
        }

        await ctx.reply(`✅ تم فك الكتم عن ${res.removed} عضو/أعضاء.`);
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
          await ctx.reply(
            `لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${ctx.prefix}promote @شخص`
          );
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
          lines.push(
            `⚠️ تعذر ترقية ${res.failed.length} عضو/أعضاء.${failedList ? `\nالذين تعذر ترقيتهم: ${failedList}` : ''}`
          );
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
          await ctx.reply(
            `لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${ctx.prefix}demote @شخص`
          );
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
          lines.push(
            `⚠️ تعذر تنزيل ${res.failed.length} عضو/أعضاء.${failedList ? `\nالذين تعذر تنزيلهم: ${failedList}` : ''}`
          );
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

    const isGroup = isGroupJid(chatJid);
    const senderRawJid = isGroup ? msg.key?.participant : msg.key?.remoteJid;
    const senderJid = normalizeUserJid(senderRawJid);

    const isAllowlisted = Boolean(senderJid && allowlist.has(senderJid));
    const botJid = getBotJid(socket);

    if (isGroup && senderJid) {
      try {
        const enforced = await maybeEnforceMuteMessage({
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
        await maybeModerateMessage({
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
    if (!parsed) return;

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
