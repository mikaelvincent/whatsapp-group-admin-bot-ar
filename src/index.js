import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startWhatsAppBot } from './whatsapp.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, base: { service: 'wa-bot' } });

  logger.info('بدء تشغيل البوت', {
    prefix: config.prefix,
    auth_dir: config.authDir
  });

  const bot = await startWhatsAppBot({
    config,
    logger: logger.child({ component: 'whatsapp' })
  });

  const shutdown = async (signal) => {
    logger.warn('إيقاف البوت', { signal });
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err)}\n`);
  process.exit(1);
});
