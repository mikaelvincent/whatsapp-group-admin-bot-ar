import { loadConfig, validateConfig } from './config.js';
import { createLogger } from './logger.js';
import { startWhatsAppBot } from './whatsapp.js';

function nodeMajorVersion() {
  const raw = String(process.versions?.node ?? '').trim();
  const major = Number.parseInt(raw.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : 0;
}

async function main() {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    base: { service: 'wa-bot', pid: process.pid, node: String(process.versions?.node ?? '') }
  });

  const major = nodeMajorVersion();
  if (major && major < 20) {
    logger.error('إصدار Node.js غير مدعوم', { required: '>=20', current: String(process.versions?.node ?? '') });
    process.exit(1);
    return;
  }

  const validation = validateConfig(config);
  if (validation.warnings.length > 0) {
    logger.warn('تحذيرات إعدادات', { warnings: validation.warnings });
  }
  if (!validation.ok) {
    logger.error('إعدادات غير صالحة', { errors: validation.errors });
    process.exit(1);
    return;
  }

  logger.info('بدء تشغيل البوت', {
    prefix: config.prefix,
    auth_dir: config.authDir,
    storage_path: config.storagePath,
    allowlist_count: Array.isArray(config.allowlist) ? config.allowlist.length : 0,
    require_caller_admin: Boolean(config.requireCallerAdmin),
    cmd_cooldown_ms: config.commandCooldownMs,
    fun_cooldown_ms: config.funCooldownMs
  });

  let bot = null;
  let shuttingDown = false;

  const shutdown = async (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn('إيقاف البوت', { signal, code });

    try {
      await bot?.stop();
    } catch (err) {
      logger.warn('فشل إيقاف البوت', { err: String(err?.stack || err) });
    }

    process.exit(code);
  };

  const panic = async (kind, err) => {
    logger.error('خطأ غير معالج', { kind, err: String(err?.stack || err) });
    await shutdown(kind, 1);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });

  process.on('uncaughtException', (err) => {
    void panic('uncaughtException', err);
  });

  process.on('unhandledRejection', (reason) => {
    void panic('unhandledRejection', reason);
  });

  bot = await startWhatsAppBot({
    config,
    logger: logger.child({ component: 'whatsapp' })
  });
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err)}\n`);
  process.exit(1);
});
