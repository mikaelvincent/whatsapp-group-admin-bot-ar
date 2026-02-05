import { randomInt } from 'node:crypto';

import { formatMb, formatUptimeAr, parseRollSpec, pickRandom, randomInRangeInclusive } from '../utils/fun.js';

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

export function createFunCommands({ config, allowlist }) {
  const ping = {
    name: 'ping',
    aliases: ['p'],
    category: 'fun',
    privileged: false,
    groupOnly: true,
    handler: async (ctx) => {
      await ctx.reply(String(config.pingResponse ?? '🏓 بونج!'));
    }
  };

  const auth = {
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
  };

  const dice = {
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
  };

  const quote = {
    name: 'quote',
    aliases: [],
    category: 'fun',
    privileged: false,
    groupOnly: true,
    handler: async (ctx) => {
      const q = pickRandom(FUN_QUOTES_AR) || 'ابتسم 🙂';
      await ctx.reply(`💬 ${q}`);
    }
  };

  const today = {
    name: 'today',
    aliases: ['daily'],
    category: 'fun',
    privileged: false,
    groupOnly: true,
    handler: async (ctx) => {
      const prompt = pickRandom(FUN_TODAY_PROMPTS_AR) || '📝 سؤال اليوم: كيف كان يومك؟';
      await ctx.reply(prompt);
    }
  };

  const game = {
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
  };

  const uptime = {
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
  };

  return [ping, auth, dice, quote, today, game, uptime];
}

export function createTargetsCommand({ config }) {
  return {
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
  };
}
