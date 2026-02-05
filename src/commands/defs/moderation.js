import { parseOnOff } from '../utils/parse.js';

function renderRules(store, groupJid) {
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
}

export function createModerationCommands({ config, logger, store }) {
  const rules = {
    name: 'rules',
    aliases: [],
    category: 'moderation',
    privileged: false,
    groupOnly: true,
    handler: async (ctx) => {
      await ctx.reply(renderRules(store, ctx.groupJid));
    }
  };

  const antilink = {
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
  };

  const antiimage = {
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
  };

  const antisticker = {
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
  };

  const filter = {
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
  };

  const exempt = {
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
  };

  const welcome = {
    name: 'welcome',
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
        `- ${ctx.prefix}welcome on|off\n` +
        `- ${ctx.prefix}welcome set <نص>\n` +
        `المتغيرات: {user} {group} {rules}`;

      if (!sub) {
        const current = ctx.store.getWelcome(ctx.groupJid);
        if (!current) {
          await ctx.reply('تعذر قراءة إعدادات الترحيب لهذه المجموعة.');
          return;
        }

        const status = current.enabled ? 'مفعل ✅' : 'معطل ❌';
        const tpl = String(current.template ?? '').trim();
        const shown = tpl.length > 900 ? `${tpl.slice(0, 900)}...` : tpl;

        await ctx.reply(`📣 الترحيب: ${status}\n\nالنص الحالي:\n${shown}\n\n${usage}`);
        return;
      }

      if (sub === 'on' || sub === 'off') {
        const enabled = sub === 'on';
        try {
          const res = await ctx.store.setWelcomeEnabled(ctx.groupJid, enabled);
          if (!res?.ok) throw new Error('store_rejected');
        } catch (err) {
          logger.warn('فشل تحديث إعدادات الترحيب', { group: ctx.groupJid, err: String(err) });
          await ctx.reply('حدث خطأ أثناء تحديث إعدادات الترحيب.');
          return;
        }

        await ctx.reply(enabled ? '✅ تم تفعيل الترحيب.' : '✅ تم تعطيل الترحيب.');
        return;
      }

      if (sub === 'set') {
        const raw = String(ctx.rawArgs ?? '').trim();
        const without = raw.replace(/^set\b/i, '').trim();
        const template = without.replace(/\\n/g, '\n').trim();

        if (!template) {
          await ctx.reply(`اكتب نص الترحيب بعد الأمر.\nمثال: ${ctx.prefix}welcome set مرحبًا {user}!`);
          return;
        }

        if (template.length > 2000) {
          await ctx.reply('نص الترحيب طويل جدًا. حاول تقصيره.');
          return;
        }

        try {
          const res = await ctx.store.setWelcomeTemplate(ctx.groupJid, template);
          if (!res?.ok) throw new Error('store_rejected');
        } catch (err) {
          logger.warn('فشل تحديث نص الترحيب', { group: ctx.groupJid, err: String(err) });
          await ctx.reply('حدث خطأ أثناء تحديث نص الترحيب.');
          return;
        }

        await ctx.reply('✅ تم تحديث نص الترحيب.');
        return;
      }

      await ctx.reply(usage);
    }
  };

  return [rules, antilink, antiimage, antisticker, filter, exempt, welcome];
}
