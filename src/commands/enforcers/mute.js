import { jidMentionTag } from '../utils/jid.js';
import { safeSendText } from '../utils/send.js';

export function createMuteEnforcer({
  logger,
  store,
  getAdminStatus,
  shouldSendWarning
} = {}) {
  return async function maybeEnforceMuteMessage({ socket, msg, groupJid, senderJid, botJid }) {
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
}
