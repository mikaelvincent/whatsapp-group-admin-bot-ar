export function renderHelp({ prefix, commands }) {
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
