export async function safeSendText(socket, jid, text, quoted, extra) {
  if (!jid) return null;

  const message = { text: String(text ?? '') };
  if (extra?.mentions && Array.isArray(extra.mentions) && extra.mentions.length > 0) {
    message.mentions = extra.mentions;
  }

  return await socket.sendMessage(jid, message, quoted ? { quoted } : undefined);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
