import { randomInt } from 'node:crypto';

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
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.templateButtonReplyMessage?.selectedId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
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
  if (!jid) return null;

  const message = { text: String(text ?? '') };
  if (extra?.mentions && Array.isArray(extra.mentions) && extra.mentions.length > 0) {
    message.mentions = extra.mentions;
  }

  return await socket.sendMessage(jid, message, quoted ? { quoted } : undefined);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FUN_QUOTES_AR = [
  'التركيز على خطوة واحدة أفضل من تشتيت ألف خطوة.',
  'الهدوء لا يعني الضعف؛ أحيانًا يعني الحكمة.',
  'اترك أثرًا جميلًا حتى في أبسط الكلمات.',
  'من جدّ وجد، ومن زرع حصد.',
  'التقدم البسيط كل يوم يصنع فرقًا كبيرًا.',
  'الاحترام لا يُطلب، يُمارس.',
  'حافظ على نيتك نظيفة… والباقي يتيسر.',
  'الكلمة الطيبة صدقة.',
  'تعلّم أن تقول: لا… عندما يلزم.',
  'لا تقارن بدايتك بنهاية غيرك.',
  'الوقت أثمن مما تتوقع.',
  'خفف توقعاتك… تزداد طاقتك.',
  'الابتسامة طريقة بسيطة لتخفيف التوتر.',
  'اجعل يومك أبسط… ليصير أجمل.',
  'اسأل أكثر… وافترض أقل.',
  'النجاح يحب الانضباط.',
  'الراحة ليست كسلًا؛ هي جزء من الاستمرار.',
  'لا تتجاهل التفاصيل الصغيرة.',
  'ابدأ الآن… وعدّل لاحقًا.',
  'الفكرة الجيدة بلا تنفيذ مجرد رغبة.'
];

const FUN_TODAY_PROMPTS_AR = [
  '📝 سؤال اليوم: ما عادة بسيطة تتمنى تلتزم بها؟',
  '🎯 تحدي اليوم: قل كلمة شكر لشخص يستحق.',
  '🌿 سؤال اليوم: ما شيء واحد يهدّيك بسرعة؟',
  '📌 تحدي اليوم: اكتب 3 أشياء ممتن لها.',
  '💡 سؤال اليوم: ما أفضل نصيحة سمعتها مؤخرًا؟',
  '🧠 تحدي اليوم: تعلّم معلومة صغيرة وشاركها.',
  '☕ سؤال اليوم: قهوتك/شايك… كيف تفضله؟',
  '📚 سؤال اليوم: كتاب أو فيلم تنصح به ولماذا؟',
  '🎵 سؤال اليوم: أغنية ترفع مزاجك دائمًا؟',
  '🏃 تحدي اليوم: 5 دقائق حركة… أي شيء!',
  '🗣️ سؤال اليوم: كلمة عربية تحب معناها؟',
  '🎁 سؤال اليوم: ما أجمل هدية غير مادية تتلقاها؟',
  '🧩 تحدي اليوم: حلّ لغز بسيط أو لعبة قصيرة.',
  '🧼 تحدي اليوم: رتّب شيئًا واحدًا حولك الآن.',
  '🌙 سؤال اليوم: ما أفضل عادة قبل النوم؟'
];

const FUN_GAME_CATEGORIES_AR = [
  'مدينة',
  'دولة',
  'حيوان',
  'أكلة',
  'مهنة',
  'اسم شخص',
  'شيء في البيت',
  'شيء في المدرسة/العمل'
];

const AR_LETTERS = [
  'ا',
  'ب',
  'ت',
  'ث',
  'ج',
  'ح',
  'خ',
  'د',
  'ذ',
  'ر',
  'ز',
  'س',
  'ش',
  'ص',
  'ض',
  'ط',
  'ظ',
  'ع',
  'غ',
  'ف',
  'ق',
  'ك',
  'ل',
  'م',
  'ن',
  'ه',
  'و',
  'ي'
];

function pickRandom(list) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length === 0) return null;
  return arr[randomInt(0, arr.length)];
}

function randomInRangeInclusive(min, max) {
  const a = Number(min);
  const b = Number(max);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const lo = Math.min(a, b);
  const hi = Math.max(a, b);

  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
  if (lo < 1 || hi < 1) return null;
  if (hi > 1_000_000) return null;

  return randomInt(lo, hi + 1);
}

function parseRollSpec(args) {
  const tokens = (Array.isArray(args) ? args : [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);

  if (tokens.length === 0) return { kind: 'range', min: 1, max: 6 };

  const a0 = tokens[0].toLowerCase();

  const dice = a0.match(/^(\d{1,2})d(\d{1,4})$/i);
  if (dice) {
    const rolls = Number.parseInt(dice[1], 10);
    const sides = Number.parseInt(dice[2], 10);
    if (!Number.isFinite(rolls) || !Number.isFinite(sides)) return null;
    if (rolls < 1 || rolls > 20) return null;
    if (sides < 2 || sides > 1000) return null;
    return { kind: 'dice', rolls, sides };
  }

  const dOnly = a0.match(/^d(\d{1,4})$/i);
  if (dOnly) {
    const sides = Number.parseInt(dOnly[1], 10);
    if (!Number.isFinite(sides) || sides < 2 || sides > 1000) return null;
    return { kind: 'dice', rolls: 1, sides };
  }

  const hyphen = a0.match(/^(\d{1,6})-(\d{1,6})$/);
  if (hyphen) {
    const min = Number.parseInt(hyphen[1], 10);
    const max = Number.parseInt(hyphen[2], 10);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min < 1 || max < 1) return null;
    if (min > 1_000_000 || max > 1_000_000) return null;
    return { kind: 'range', min, max };
  }

  const n0 = tokens[0].match(/^\d{1,6}$/);
  const n1 = tokens[1]?.match(/^\d{1,6}$/);

  if (n0 && n1) {
    const min = Number.parseInt(tokens[0], 10);
    const max = Number.parseInt(tokens[1], 10);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min < 1 || max < 1) return null;
    if (min > 1_000_000 || max > 1_000_000) return null;
    return { kind: 'range', min, max };
  }

  if (n0 && tokens.length === 1) {
    const max = Number.parseInt(tokens[0], 10);
    if (!Number.isFinite(max)) return null;
    if (max < 2 || max > 1_000_000) return null;
    return { kind: 'range', min: 1, max };
  }

  return null;
}

function formatUptimeAr(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds ?? 0) || 0));
  const days = Math.floor(total / 86_400);
  const rem = total % 86_400;

  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;

  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');

  const clock = `${hh}:${mm}:${ss}`;
  if (days > 0) return `${days} يوم ${clock}`;
  return clock;
}

function formatMb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  return `${Math.round(n / 1024 / 1024)} MB`;
}

export function createCommandRouter({ config, logger, store }) {
  const allowlist = new Set(
    (Array.isArray(config.allowlist) ? config.allowlist : [])
      .map(normalizeUserJid)
      .filter(Boolean)
  );

  const warnCooldownMs = Number.isFinite(config.moderationWarnCooldownMs)
    ? config.moderationWarnCooldownMs
    : 15_000;

  const commandCooldownMs = Number.isFinite(config.commandCooldownMs) ? config.commandCooldownMs : 1200;

  const funCooldownMs = Number.isFinite(config.funCooldownMs) ? config.funCooldownMs : 6000;

  const warnCache = new Map();
  const commandCooldownCache = new Map();

  const groupMetaCache = new Map();
  const groupMetaTtlMs = 30_000;

  const menuState = new Map();
  const menuTtlMs = 90_000;

  const rememberMenu = (groupJid, view, sendResult) => {
    const id = sendResult?.key?.id ? String(sendResult.key.id) : null;
    menuState.set(groupJid, { ts: Date.now(), view, id });

    if (menuState.size > 2000) menuState.clear();
  };

  const getReplyStanzaId = (message) => {
    const ctx = extractContextInfo(message);
    const id = String(ctx?.stanzaId ?? '').trim();
    return id || null;
  };

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

  const cooldownRemainingMs = (key, windowMs, now) => {
    if (!windowMs || windowMs <= 0) return 0;

    const last = commandCooldownCache.get(key);
    if (typeof last !== 'number') return 0;

    const delta = now - last;
    if (delta >= windowMs) return 0;

    return windowMs - delta;
  };

  const bumpCooldown = (key, now) => {
    commandCooldownCache.set(key, now);
    if (commandCooldownCache.size > 20_000) commandCooldownCache.clear();
  };

  const cooldownWaitAr = (ms) => {
    const sec = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
    return `${sec} ثانية`;
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
    lines.push(`- ${config.prefix}unban : إلغاء الحظر`);
    lines.push(`- ${config.prefix}promote : ترقية لمشرف`);
    lines.push(`- ${config.prefix}demote : تنزيل مشرف`);
    lines.push(`- ${config.prefix}mute [مدة] : كتم (حذف رسائل)`);
    lines.push(`- ${config.prefix}unmute : فك الكتم`);
    lines.push('');
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

    const helpText = renderHelp({ prefix: config.prefix, commands });
    const sent = await safeSendText(socket, groupJid, helpText, msg);
    rememberMenu(groupJid, 'root', sent);
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
      logger.warn('فشل إرسال تحذير إشراف', {
        group: groupJid,
        from: senderJid,
        rule,
        err: String(err)
      });
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
      aliases: [],
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
            : raw === '2' || raw === 'moderation' || raw === 'mod' || raw === 'اشراف' || raw === 'إشراف'
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
          await sendMenuAdmin({ socket: ctx.socket, groupJid: ctx.groupJid, quoted: ctx.msg });
          return;
        }

        if (key === 'moderation') {
          await sendMenuModeration({ socket: ctx.socket, groupJid: ctx.groupJid, quoted: ctx.msg });
          return;
        }

        if (key === 'fun') {
          await sendMenuFun({ socket: ctx.socket, groupJid: ctx.groupJid, quoted: ctx.msg });
          return;
        }

        if (key === 'help') {
          await ctx.reply(
            renderHelp({
              prefix: ctx.prefix,
              commands
            })
          );
          return;
        }

        if (key === 'unknown') {
          await sendMenuRoot({
            socket: ctx.socket,
            groupJid: ctx.groupJid,
            quoted: ctx.msg,
            isAllowlisted: ctx.isAllowlisted,
            preferInteractive: false
          });
          return;
        }

        await sendMenuRoot({
          socket: ctx.socket,
          groupJid: ctx.groupJid,
          quoted: ctx.msg,
          isAllowlisted: ctx.isAllowlisted,
          preferInteractive: true
        });
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
      name: 'dice',
      aliases: ['roll'],
      category: 'fun',
      privileged: false,
      groupOnly: true,
      handler: async (ctx) => {
        const spec = parseRollSpec(ctx.args);

        const usage =
          `الاستخدام:\n` +
          `- ${ctx.prefix}dice (افتراضي 1-6)\n` +
          `- ${ctx.prefix}dice 100 (1-100)\n` +
          `- ${ctx.prefix}dice 5-20\n` +
          `- ${ctx.prefix}dice 2d6`;

        if (!spec) {
          await ctx.reply(usage);
          return;
        }

        if (spec.kind === 'dice') {
          const results = [];
          let sum = 0;

          for (let i = 0; i < spec.rolls; i += 1) {
            const v = randomInt(1, spec.sides + 1);
            results.push(v);
            sum += v;
          }

          const lines = [];
          lines.push(`🎲 ${spec.rolls}d${spec.sides}`);
          lines.push(`النتائج: ${results.join(', ')}`);
          if (spec.rolls > 1) lines.push(`المجموع: ${sum}`);

          await ctx.reply(lines.join('\n'));
          return;
        }

        const value = randomInRangeInclusive(spec.min, spec.max);
        if (value === null) {
          await ctx.reply(usage);
          return;
        }

        await ctx.reply(`🎲 النتيجة: ${value} (${spec.min}-${spec.max})`);
      }
    },
    {
      name: 'quote',
      aliases: [],
      category: 'fun',
      privileged: false,
      groupOnly: true,
      handler: async (ctx) => {
        const q = pickRandom(FUN_QUOTES_AR) || 'ابتسم 🙂';
        await ctx.reply(`💬 ${q}`);
      }
    },
    {
      name: 'today',
      aliases: ['daily'],
      category: 'fun',
      privileged: false,
      groupOnly: true,
      handler: async (ctx) => {
        const prompt = pickRandom(FUN_TODAY_PROMPTS_AR) || '📝 سؤال اليوم: كيف كان يومك؟';
        await ctx.reply(prompt);
      }
    },
    {
      name: 'game',
      aliases: ['event'],
      category: 'fun',
      privileged: false,
      groupOnly: true,
      handler: async (ctx) => {
        const letter = pickRandom(AR_LETTERS) || 'م';
        const category = pickRandom(FUN_GAME_CATEGORIES_AR) || 'مدينة';
        await ctx.reply(`🎮 لعبة سريعة: اكتب ${category} يبدأ بحرف: (${letter})\n⏱️ 30 ثانية!`);
      }
    },
    {
      name: 'uptime',
      aliases: [],
      category: 'fun',
      privileged: false,
      groupOnly: true,
      handler: async (ctx) => {
        const mem = process.memoryUsage ? process.memoryUsage() : null;
        const rss = mem?.rss ?? 0;

        const lines = [];
        lines.push('📊 حالة البوت');
        lines.push(`- مدة التشغيل: ${formatUptimeAr(process.uptime())}`);
        lines.push(`- الذاكرة (RSS): ${formatMb(rss)}`);

        await ctx.reply(lines.join('\n'));
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
            `⚠️ تعذر إخراج ${res.failed.length} عضو/أعضاء.${
              failedList ? `\nالذين تعذر إخراجهم: ${failedList}` : ''
            }`
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
            `⚠️ تعذر ترقية ${res.failed.length} عضو/أعضاء.${
              failedList ? `\nالذين تعذر ترقيتهم: ${failedList}` : ''
            }`
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
            `⚠️ تعذر تنزيل ${res.failed.length} عضو/أعضاء.${
              failedList ? `\nالذين تعذر تنزيلهم: ${failedList}` : ''
            }`
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

    if (!parsed) {
      if (isGroup) {
        try {
          const handled = await maybeHandleMenuNavigation({
            socket,
            msg,
            groupJid: chatJid,
            text,
            isAllowlisted
          });
          if (handled) return;
        } catch (err) {
          logger.warn('فشل التعامل مع تنقل القائمة', { group: chatJid, err: String(err) });
        }
      }

      return;
    }

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

    if (senderJid && isGroupJid(chatJid)) {
      const now = Date.now();
      const baseKey = `${chatJid}|${senderJid}|cmd`;
      const funKey = `${chatJid}|${senderJid}|fun`;

      const baseWait = cooldownRemainingMs(baseKey, commandCooldownMs, now);
      if (baseWait > 0) {
        logger.warn('رفض أمر بسبب تهدئة', {
          command: def.name,
          group: chatJid,
          from: senderJid,
          wait_ms: baseWait,
          scope: 'cmd'
        });

        await safeSendText(
          socket,
          chatJid,
          `⏳ انتظر ${cooldownWaitAr(baseWait)} قبل إعادة استخدام الأوامر.`,
          msg
        );
        return;
      }

      if (def.category === 'fun') {
        const funWait = cooldownRemainingMs(funKey, funCooldownMs, now);
        if (funWait > 0) {
          logger.warn('رفض أمر بسبب تهدئة', {
            command: def.name,
            group: chatJid,
            from: senderJid,
            wait_ms: funWait,
            scope: 'fun'
          });

          await safeSendText(
            socket,
            chatJid,
            `⏳ انتظر ${cooldownWaitAr(funWait)} قبل استخدام أوامر الفعاليات مرة أخرى.`,
            msg
          );
          return;
        }
      }

      if (commandCooldownMs > 0) bumpCooldown(baseKey, now);
      if (def.category === 'fun' && funCooldownMs > 0) bumpCooldown(funKey, now);
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
