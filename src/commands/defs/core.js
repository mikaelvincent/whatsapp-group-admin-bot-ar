import { renderHelp } from '../utils/help.js';

export function createCoreCommands({ config, menu, commandsRef } = {}) {
  const help = {
    name: 'help',
    aliases: [],
    category: 'fun',
    privileged: false,
    groupOnly: true,
    handler: async (ctx) => {
      await ctx.reply(
        renderHelp({
          prefix: ctx.prefix,
          commands: commandsRef
        })
      );
    }
  };

  const menuCmd = {
    name: 'menu',
    aliases: [],
    category: 'fun',
    privileged: false,
    groupOnly: true,
    handler: async (ctx) => {
      const raw = String(ctx.args[0] ?? '')
        .trim()
        .toLowerCase();

      const key =
        raw === '1' || raw === 'admin' || raw === 'admins' || raw === 'ادارة' || raw === 'إدارة'
          ? 'admin'
          : raw === '2' ||
            raw === 'moderation' ||
            raw === 'mod' ||
            raw === 'اشراف' ||
            raw === 'إشراف'
          ? 'moderation'
          : raw === '3' || raw === 'fun' || raw === 'فعاليات'
          ? 'fun'
          : raw === '4' || raw === 'help'
          ? 'help'
          : raw === 'root' || raw === 'main' || raw === 'start'
          ? 'root'
          : raw
          ? 'unknown'
          : 'root';

      if (key === 'admin') {
        await menu.sendMenuAdmin({ socket: ctx.socket, groupJid: ctx.groupJid, quoted: ctx.msg });
        return;
      }

      if (key === 'moderation') {
        await menu.sendMenuModeration({ socket: ctx.socket, groupJid: ctx.groupJid, quoted: ctx.msg });
        return;
      }

      if (key === 'fun') {
        await menu.sendMenuFun({ socket: ctx.socket, groupJid: ctx.groupJid, quoted: ctx.msg });
        return;
      }

      if (key === 'help') {
        await ctx.reply(
          renderHelp({
            prefix: ctx.prefix,
            commands: commandsRef
          })
        );
        return;
      }

      if (key === 'unknown') {
        await menu.sendMenuRoot({
          socket: ctx.socket,
          groupJid: ctx.groupJid,
          quoted: ctx.msg,
          isAllowlisted: ctx.isAllowlisted,
          preferInteractive: false
        });
        return;
      }

      await menu.sendMenuRoot({
        socket: ctx.socket,
        groupJid: ctx.groupJid,
        quoted: ctx.msg,
        isAllowlisted: ctx.isAllowlisted,
        preferInteractive: true
      });
    }
  };

  return [help, menuCmd];
}
