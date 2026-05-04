// Аудит покрытия правил по карточкам в datasets/cases/.
// Считает hits по rule_id (НЕ карточки): одна dirty-карточка с двумя
// нарушениями по разным правилам даёт hit обоим правилам.
// Сравнивает с целевой квотой (text: datasets/synthetic-quota.yaml,
// image: datasets/synthetic-quota.images.yaml) и печатает delta.
// delta > 0 означает «нужно сгенерировать синтетику по этому правилу».
//
// Image-таблица показывает только AI-only IMG-правила
// (datasets/image_rules.compact.json уже отфильтрован по
// datasets/image_rules.scope.yaml). Heuristic-разрешимые
// IMG-01/02/13/15/26 в audit не появляются.
//
// Использование:
//   pnpm cases:audit                       — text + image таблицы
//   pnpm cases:audit --rules=text          — только текстовая
//   pnpm cases:audit --rules=image         — только IMG
//   pnpm cases:audit --rules=all           — обе (default)
//   pnpm cases:audit --json                — массив для synth:scaffold --from-audit
//   pnpm cases:audit --source=real         — только реальная выборка
//   pnpm cases:audit --source=synthetic    — только синтетика

import {
  buildImageRows,
  buildRows,
  countHits,
  countImageHits,
  readAllCases,
  readImageQuota,
  readImageRules,
  readQuota,
  readRules,
  type AuditRow,
  type ImageAuditRow,
  type SourceFilter,
} from './lib/audit.js';

type RulesFilter = 'text' | 'image' | 'all';

interface CliArgs {
  json: boolean;
  source: SourceFilter;
  rules: RulesFilter;
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let json = false;
  let source: SourceFilter = null;
  let rules: RulesFilter = 'all';
  for (const a of argv) {
    if (a === '--json') {
      json = true;
      continue;
    }
    const sm = a.match(/^--source=(real|synthetic)$/);
    if (sm?.[1]) {
      source = sm[1] as SourceFilter;
      continue;
    }
    const rm = a.match(/^--rules=(text|image|all)$/);
    if (rm?.[1]) {
      rules = rm[1] as RulesFilter;
      continue;
    }
    bail(`[audit] неизвестный аргумент: ${a}`);
  }
  return { json, source, rules };
}

function pad(s: string, w: number, right = false): string {
  if (s.length >= w) return s;
  return right ? s.padStart(w) : s.padEnd(w);
}

type AnyRow = AuditRow | ImageAuditRow;

function quotaToString(v: number | null): string {
  return v === null ? '—' : String(v);
}

function printTable(rows: readonly AnyRow[], source: SourceFilter, kind: 'text' | 'image'): void {
  const showReal = source !== 'synthetic';
  const showSynth = source !== 'real';
  console.log(`[audit] ${kind} rules: ${rows.length}`);

  type Col = { label: string; w: number; right: boolean; get: (r: AnyRow) => string };
  const cols: Col[] = [];
  cols.push({ label: 'rule_id', w: 8, right: false, get: (r) => r.rule_id });
  cols.push({ label: 'severity', w: 10, right: false, get: (r) => r.severity });
  if (showReal) cols.push({ label: 'real', w: 6, right: true, get: (r) => String(r.real) });
  if (showSynth)
    cols.push({ label: 'synthetic', w: 11, right: true, get: (r) => String(r.synthetic) });
  cols.push({ label: 'total', w: 7, right: true, get: (r) => String(r.total) });
  cols.push({ label: 'quota', w: 7, right: true, get: (r) => quotaToString(r.quota) });
  cols.push({ label: 'delta', w: 7, right: true, get: (r) => quotaToString(r.delta) });

  const fmtRow = (vals: readonly string[]): string =>
    cols.map((c, i) => pad(vals[i] ?? '', c.w, c.right)).join(' ');

  console.log(fmtRow(cols.map((c) => c.label)));

  const sorted = [...rows].sort((a, b) => a.rule_id.localeCompare(b.rule_id));
  for (const r of sorted) {
    console.log(fmtRow(cols.map((c) => c.get(r))));
  }

  const totalWidth = cols.reduce((acc, c) => acc + c.w + 1, -1);
  console.log('─'.repeat(Math.max(40, totalWidth)));

  const totalReal = rows.reduce((s, r) => s + r.real, 0);
  const totalSynth = rows.reduce((s, r) => s + r.synthetic, 0);
  const totalAll = rows.reduce((s, r) => s + r.total, 0);
  // Quota и delta для image-таблицы могут содержать null (целевая
  // квота не задана). Для строки «Всего» показываем '—', если хоть
  // одна строка с null, чтобы не вводить в заблуждение суммой по
  // подмножеству строк.
  const someNullQuota = rows.some((r) => r.quota === null);
  const someNullDelta = rows.some((r) => r.delta === null);
  const totalQuota: number | null = someNullQuota
    ? null
    : rows.reduce((s, r) => s + (r.quota ?? 0), 0);
  const totalDelta: number | null = someNullDelta
    ? null
    : rows.reduce((s, r) => s + (r.delta ?? 0), 0);
  const noCovReal = rows.filter((r) => r.real === 0).length;
  const noCovSynth = rows.filter((r) => r.synthetic === 0).length;
  const noCovTotal = rows.filter((r) => r.total === 0).length;

  const labelW = (cols[0]?.w ?? 0) + 1 + (cols[1]?.w ?? 0);
  const sumLine = (
    label: string,
    vReal: number,
    vSynth: number,
    vTotal: number,
    vQuota?: number | null,
    vDelta?: number | null,
  ): string => {
    let s = pad(label, labelW, false);
    if (showReal) s += ' ' + pad(String(vReal), 6, true);
    if (showSynth) s += ' ' + pad(String(vSynth), 11, true);
    s += ' ' + pad(String(vTotal), 7, true);
    if (vQuota !== undefined) s += ' ' + pad(quotaToString(vQuota), 7, true);
    if (vDelta !== undefined) s += ' ' + pad(quotaToString(vDelta), 7, true);
    return s;
  };

  console.log(sumLine('Всего нарушений', totalReal, totalSynth, totalAll, totalQuota, totalDelta));
  console.log(sumLine('Правил без покрытия', noCovReal, noCovSynth, noCovTotal));
  console.log(`Правил всего: ${rows.length}`);
}

async function computeText(source: SourceFilter): Promise<AuditRow[]> {
  const rules = await readRules();
  const known = new Set(rules.map((r) => r.id));
  const quota = await readQuota();
  const { real, synthetic } = await readAllCases();
  const realHits = countHits(real, known);
  const synthHits = countHits(synthetic, known);
  return buildRows(rules, realHits, synthHits, quota, source);
}

async function computeImage(source: SourceFilter): Promise<ImageAuditRow[]> {
  const rules = await readImageRules();
  const known = new Set(rules.map((r) => r.id));
  const quota = await readImageQuota();
  const { real, synthetic } = await readAllCases();
  const realHits = countImageHits(real, known);
  const synthHits = countImageHits(synthetic, known);
  return buildImageRows(rules, realHits, synthHits, quota, source);
}

async function main(): Promise<void> {
  const args = parseArgs();

  const wantText = args.rules === 'text' || args.rules === 'all';
  const wantImage = args.rules === 'image' || args.rules === 'all';

  const textRows: AuditRow[] = wantText ? await computeText(args.source) : [];
  const imageRows: ImageAuditRow[] = wantImage ? await computeImage(args.source) : [];

  if (args.json) {
    if (args.rules === 'text') {
      const sorted = [...textRows].sort((a, b) => {
        if (b.delta !== a.delta) return b.delta - a.delta;
        return a.rule_id.localeCompare(b.rule_id);
      });
      process.stdout.write(JSON.stringify(sorted, null, 2) + '\n');
      return;
    }
    if (args.rules === 'image') {
      const sorted = [...imageRows].sort((a, b) => a.rule_id.localeCompare(b.rule_id));
      process.stdout.write(JSON.stringify(sorted, null, 2) + '\n');
      return;
    }
    // all: обе таблицы под одним объектом, чтобы скрипт-потребитель
    // явно знал, что получил.
    process.stdout.write(
      JSON.stringify({ text: textRows, image: imageRows }, null, 2) + '\n',
    );
    return;
  }

  if (wantText) printTable(textRows, args.source, 'text');
  if (wantText && wantImage) console.log('');
  if (wantImage) printTable(imageRows, args.source, 'image');
}

main().catch((err) => {
  console.error('[audit] failure:', err);
  process.exit(1);
});
