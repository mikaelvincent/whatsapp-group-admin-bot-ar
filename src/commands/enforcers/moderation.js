import { jidMentionTag } from '../utils/jid.js';
import { extractText } from '../utils/message.js';
import { detectMedia, findBannedWord, findFirstLink } from '../utils/moderation.js';
import { safeSendText } from '../utils/send.js';

export function createModerationEnforcer({
  logger,
  store,
  getAdminStatus,
  shouldSendWarning
} = {}) {
  return async function maybeModerateMessage({ socket, msg, groupJid, senderJid, isAllowlisted, botJid }) {
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
      logger.warn('فشل إرسال تحذير إشراف', {
        group: groupJid,
        from: senderJid,
        rule,
        err: String(err)
      });
    }
  };
}
