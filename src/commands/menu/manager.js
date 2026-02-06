import { safeSendText } from '../utils/send.js';
import { getReplyStanzaId } from '../utils/message.js';
import { renderHelp } from '../utils/help.js';

export function createMenuManager({ config, logger, store, allowlist, commandsRef }) {
  const menuState = new Map();
  const menuTtlMs = 90_000;

  const rememberMenu = (groupJid, view, sendResult) => {
    const id = sendResult?.key?.id ? String(sendResult.key.id) : null;
    menuState.set(groupJid, { ts: Date.now(), view, id });

    if (menuState.size > 2000) menuState.clear();
  };

  const onOffAr = (v) => (v ? 'مفعل ✅' : 'معطل ❌');

  const renderMenuRoot = ({ isAllowlisted }) => {
    const lines = [];
    lines.push('📋 القائمة');
    lines.push('');
    lines.push('1) 🛡️ الإدارة');
    lines.push('2) 🧹 الإشراف');
    lines.push('3) 🎲 فعاليات');
    lines.push('4) ❓ المساعدة');
    lines.push('');
    if (allowlist.size === 0) {
      lines.push('⚠️ قائمة السماح غير مضبوطة حاليًا.');
    } else {
      lines.push(`🔐 قائمة السماح: ${allowlist.size} رقم/أرقام.`);
    }
    lines.push(`- شرط مشرف المرسل للأوامر المحمية: ${onOffAr(Boolean(config.requireCallerAdmin))}`);
    lines.push(`- حالتك: ${isAllowlisted ? 'ضمن قائمة السماح ✅' : 'غير مخول ❌'}`);
    lines.push('');
    lines.push(`أرسل رقمًا (1-4) أو اكتب: ${config.prefix}menu 2`);
    lines.push(`اكتب ${config.prefix}targets لمعرفة تحديد الهدف.`);

    return lines.join('\n');
  };

  const renderMenuAdmin = () => {
    const lines = [];
    lines.push('🛡️ قسم الإدارة');
    lines.push('');
    lines.push(`- ${config.prefix}kick : إخراج عضو/أعضاء`);
    lines.push(`- ${config.prefix}ban : إخراج + حظر دائم`);
    lines.push(`- ${config.prefix}unban <رقم> : إلغاء الحظر (بالرقم)`);
    lines.push(`- ${config.prefix}promote : ترقية لمشرف`);
    lines.push(`- ${config.prefix}demote : تنزيل مشرف`);
    lines.push(`- ${config.prefix}mute [مدة] : كتم (حذف رسائل)`);
    lines.push(`- ${config.prefix}unmute : فك الكتم`);
    lines.push('');
    lines.push('ملاحظة: إذا كان العضو خارج المجموعة، استخدم رقم الهاتف مع رمز الدولة.');
    lines.push(`مثال: ${config.prefix}unban +9665XXXXXXX (سيتم حذف رسالة الأمر إن أمكن).`);
    lines.push('ملاحظة: أغلب هذه الأوامر تتطلب أن يكون البوت مشرفًا.');
    lines.push(`أرسل 0 للرجوع للقائمة.`);

    return lines.join('\n');
  };

  const renderMenuModeration = (groupJid) => {
    const m = store.getModeration(groupJid);
    const w = store.getWelcome(groupJid);

    const lines = [];
    lines.push('🧹 قسم الإشراف');
    lines.push('');
    if (!m) {
      lines.push('تعذر قراءة إعدادات الإشراف.');
      lines.push(`أرسل 0 للرجوع للقائمة.`);
      return lines.join('\n');
    }

    lines.push(`- منع الروابط: ${onOffAr(m.antiLink)} (${config.prefix}antilink on|off)`);
    lines.push(
      `- فلتر الكلمات: ${onOffAr(m.filterEnabled)}${
        m.filterEnabled ? ` (عدد العناصر: ${m.bannedWords.length})` : ''
      } (${config.prefix}filter ...)`
    );
    lines.push(`- منع الصور: ${onOffAr(m.antiImage)} (${config.prefix}antiimage on|off)`);
    lines.push(`- منع الملصقات: ${onOffAr(m.antiSticker)} (${config.prefix}antisticker on|off)`);
    lines.push('');
    lines.push(
      `- استثناء المخولين: ${onOffAr(m.exemptAllowlisted)} (${config.prefix}exempt allowlist on|off)`
    );
    lines.push(
      `- استثناء مشرفي المجموعة: ${onOffAr(m.exemptAdmins)} (${config.prefix}exempt admins on|off)`
    );
    if (w) lines.push(`- الترحيب: ${onOffAr(Boolean(w.enabled))} (${config.prefix}welcome on|off)`);
    lines.push('');
    lines.push(`- عرض القواعد: ${config.prefix}rules`);
    lines.push('ملاحظة: حذف الرسائل يحتاج أن يكون البوت مشرفًا.');
    lines.push(`أرسل 0 للرجوع للقائمة.`);

    return lines.join('\n');
  };

  const renderMenuFun = () => {
    const lines = [];
    lines.push('🎲 قسم الفعاليات');
    lines.push('');
    lines.push(`- ${config.prefix}ping : فحص سريع`);
    lines.push(`- ${config.prefix}dice [نطاق] : رمية عشوائية`);
    lines.push(`- ${config.prefix}quote : اقتباس عشوائي`);
    lines.push(`- ${config.prefix}today : سؤال/تحدي اليوم`);
    lines.push(`- ${config.prefix}game : فعالية سريعة`);
    lines.push(`- ${config.prefix}uptime : حالة التشغيل`);
    lines.push(`- ${config.prefix}auth : حالة صلاحيتك`);
    lines.push(`- ${config.prefix}targets : طريقة تحديد الهدف`);
    lines.push(`- ${config.prefix}help : جميع الأوامر`);
    lines.push('');
    lines.push(`أرسل 0 للرجوع للقائمة.`);

    return lines.join('\n');
  };

  const sendMenuRoot = async ({ socket, groupJid, quoted, isAllowlisted, preferInteractive }) => {
    const text = renderMenuRoot({ isAllowlisted });

    if (preferInteractive) {
      const payload = {
        text,
        footer: 'إذا لم تظهر القائمة، أرسل رقمًا (1-4).',
        title: '📋 القائمة',
        buttonText: 'اختر',
        sections: [
          {
            title: 'الأقسام',
            rows: [
              {
                title: '🛡️ الإدارة',
                description: 'إخراج/حظر/ترقية/كتم',
                rowId: `${config.prefix}menu admin`
              },
              {
                title: '🧹 الإشراف',
                description: 'روابط/فلتر/وسائط/ترحيب',
                rowId: `${config.prefix}menu moderation`
              },
              {
                title: '🎲 فعاليات',
                description: 'أوامر خفيفة',
                rowId: `${config.prefix}menu fun`
              },
              {
                title: '❓ المساعدة',
                description: 'عرض جميع الأوامر',
                rowId: `${config.prefix}help`
              }
            ]
          }
        ]
      };

      try {
        const sent = await socket.sendMessage(groupJid, payload, quoted ? { quoted } : undefined);
        rememberMenu(groupJid, 'root', sent);
        return;
      } catch (err) {
        logger.warn('فشل إرسال قائمة تفاعلية', { group: groupJid, err: String(err) });
      }
    }

    const sent = await safeSendText(socket, groupJid, text, quoted);
    rememberMenu(groupJid, 'root', sent);
  };

  const sendMenuAdmin = async ({ socket, groupJid, quoted }) => {
    const text = renderMenuAdmin();
    const sent = await safeSendText(socket, groupJid, text, quoted);
    rememberMenu(groupJid, 'admin', sent);
  };

  const sendMenuModeration = async ({ socket, groupJid, quoted }) => {
    const text = renderMenuModeration(groupJid);
    const sent = await safeSendText(socket, groupJid, text, quoted);
    rememberMenu(groupJid, 'moderation', sent);
  };

  const sendMenuFun = async ({ socket, groupJid, quoted }) => {
    const text = renderMenuFun();
    const sent = await safeSendText(socket, groupJid, text, quoted);
    rememberMenu(groupJid, 'fun', sent);
  };

  const maybeHandleMenuNavigation = async ({ socket, msg, groupJid, text, isAllowlisted }) => {
    if (!groupJid) return false;

    const token = String(text ?? '').trim();
    if (!['0', '1', '2', '3', '4'].includes(token)) return false;

    const state = menuState.get(groupJid);
    if (!state) return false;

    const now = Date.now();
    if (now - state.ts > menuTtlMs) {
      menuState.delete(groupJid);
      return false;
    }

    const replyId = getReplyStanzaId(msg?.message);
    if (state.id && replyId && replyId !== state.id && now - state.ts > 15_000) return false;

    if (token === '0') {
      await sendMenuRoot({
        socket,
        groupJid,
        quoted: msg,
        isAllowlisted,
        preferInteractive: false
      });
      return true;
    }

    if (token === '1') {
      await sendMenuAdmin({ socket, groupJid, quoted: msg });
      return true;
    }

    if (token === '2') {
      await sendMenuModeration({ socket, groupJid, quoted: msg });
      return true;
    }

    if (token === '3') {
      await sendMenuFun({ socket, groupJid, quoted: msg });
      return true;
    }

    const helpText = renderHelp({ prefix: config.prefix, commands: commandsRef });
    const sent = await safeSendText(socket, groupJid, helpText, msg);
    rememberMenu(groupJid, 'root', sent);
    return true;
  };

  return {
    sendMenuRoot,
    sendMenuAdmin,
    sendMenuModeration,
    sendMenuFun,
    maybeHandleMenuNavigation
  };
}
