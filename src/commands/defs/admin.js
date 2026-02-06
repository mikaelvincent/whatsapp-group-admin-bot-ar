import { formatJids } from '../utils/jid.js';
import { parseDurationToken, renderDurationAr } from '../utils/parse.js';
import { safeSendText, sleep } from '../utils/send.js';

async function runGroupAction({ socket, groupJid, action, targets }) {
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
}

export function createAdminCommands({ logger, sanitizeTargets, getAdminStatus }) {
  const resolveTargets = async (ctx, example, replyOverride) => {
    const reply = typeof replyOverride === 'function' ? replyOverride : ctx.reply;

    let targets;

    try {
      targets = await sanitizeTargets(ctx.socket, ctx.targetJids);
    } catch (err) {
      logger.warn('فشل تجهيز الأهداف', { group: ctx.groupJid, err: String(err) });
      await reply('حدث خطأ أثناء تجهيز الأهداف.');
      return null;
    }

    if (!Array.isArray(targets) || targets.length === 0) {
      await reply(`لم يتم تحديد أي هدف. استخدم الإشارة أو الرد أو رقم هاتف.\nمثال: ${example}`);
      return null;
    }

    return targets;
  };

  const kick = {
    name: 'kick',
    aliases: [],
    category: 'admin',
    privileged: true,
    groupOnly: true,
    requiresBotAdmin: true,
    handler: async (ctx) => {
      const targets = await resolveTargets(ctx, `${ctx.prefix}kick @شخص`);
      if (!targets) return;

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
          `⚠️ تعذر إخراج ${res.failed.length} عضو/أعضاء.${
            failedList ? `\nالذين تعذر إخراجهم: ${failedList}` : ''
          }`
        );
      }

      await ctx.reply(lines.join('\n'));
    }
  };

  const ban = {
    name: 'ban',
    aliases: [],
    category: 'admin',
    privileged: true,
    groupOnly: true,
    requiresBotAdmin: true,
    handler: async (ctx) => {
      const targets = await resolveTargets(ctx, `${ctx.prefix}ban @شخص`);
      if (!targets) return;

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
          `⚠️ تعذر إخراج ${res.failed.length} عضو/أعضاء.${
            failedList ? `\nالذين تعذر إخراجهم: ${failedList}` : ''
          }`
        );
      }

      if (lines.length === 0) {
        await ctx.reply('لم يتم تنفيذ أي إجراء.');
        return;
      }

      await ctx.reply(lines.join('\n'));
    }
  };

  const unban = {
    name: 'unban',
    aliases: [],
    category: 'admin',
    privileged: true,
    groupOnly: true,
    handler: async (ctx) => {
      const isNumberTarget = ctx.targetSource === 'number';

      const reply =
        isNumberTarget && ctx.groupJid
          ? async (t, extra) => safeSendText(ctx.socket, ctx.groupJid, t, null, extra)
          : ctx.reply;

      if (ctx.groupJid && isNumberTarget && ctx.msg?.key) {
        try {
          await ctx.socket.sendMessage(ctx.groupJid, { delete: ctx.msg.key });
        } catch (err) {
          logger.warn('فشل حذف رسالة أمر unban', { group: ctx.groupJid, err: String(err) });
        }
      }

      const targets = await resolveTargets(ctx, `${ctx.prefix}unban +9665XXXXXXX`, reply);
      if (!targets) return;

      let result;
      try {
        result = await ctx.store.removeBans(ctx.groupJid, targets);
      } catch (err) {
        await reply('حدث خطأ أثناء تحديث قائمة الحظر.');
        return;
      }

      if (result.removed === 0) {
        await reply('لا يوجد حظر على الأهداف المحددة.');
        return;
      }

      await reply(`✅ تم إلغاء الحظر عن ${result.removed} عضو/أعضاء.`);
    }
  };

  const mute = {
    name: 'mute',
    aliases: [],
    category: 'admin',
    privileged: true,
    groupOnly: true,
    handler: async (ctx) => {
      const targets = await resolveTargets(ctx, `${ctx.prefix}mute @شخص 10m`);
      if (!targets) return;

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
  };

  const unmute = {
    name: 'unmute',
    aliases: [],
    category: 'admin',
    privileged: true,
    groupOnly: true,
    handler: async (ctx) => {
      const targets = await resolveTargets(ctx, `${ctx.prefix}unmute @شخص`);
      if (!targets) return;

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
  };

  const promote = {
    name: 'promote',
    aliases: [],
    category: 'admin',
    privileged: true,
    groupOnly: true,
    requiresBotAdmin: true,
    handler: async (ctx) => {
      const targets = await resolveTargets(ctx, `${ctx.prefix}promote @شخص`);
      if (!targets) return;

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
          `⚠️ تعذر ترقية ${res.failed.length} عضو/أعضاء.${
            failedList ? `\nالذين تعذر ترقيتهم: ${failedList}` : ''
          }`
        );
      }

      await ctx.reply(lines.join('\n'));
    }
  };

  const demote = {
    name: 'demote',
    aliases: [],
    category: 'admin',
    privileged: true,
    groupOnly: true,
    requiresBotAdmin: true,
    handler: async (ctx) => {
      const targets = await resolveTargets(ctx, `${ctx.prefix}demote @شخص`);
      if (!targets) return;

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
          `⚠️ تعذر تنزيل ${res.failed.length} عضو/أعضاء.${
            failedList ? `\nالذين تعذر تنزيلهم: ${failedList}` : ''
          }`
        );
      }

      await ctx.reply(lines.join('\n'));
    }
  };

  return [kick, ban, unban, mute, unmute, promote, demote];
}
