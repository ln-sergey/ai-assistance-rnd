// Аудит покрытия правил по карточкам в datasets/cases/.
// Считает hits по rule_id (НЕ карточки): одна dirty-карточка с двумя
// нарушениями по разным правилам даёт hit обоим правилам.
// Сравнивает с целевой квотой из datasets/synthetic-quota.yaml и
// печатает delta = max(0, quota - total). delta > 0 означает «нужно
// сгенерировать синтетику по этому правилу».
//
// Использование:
//   pnpm cases:audit                   — таблица для человека
//   pnpm cases:audit --json            — массив для synth:scaffold --from-audit
//   pnpm cases:audit --source=real     — только реальная выборка
//   pnpm cases:audit --source=synthetic — только синтетика

import {
  buildRows,
  countHits,
  readAllCases,
  readQuota,
  readRules,
  type AuditRow,
  type SourceFilter,
} from './lib/audit.js';

interface CliArgs {
  json: boolean;
  source: SourceFilter;
}

function bail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv: readonly string[] = process.argv.slice(2)): CliArgs {
  let json = false;
  let source: SourceFilter = null;
  for (const a of argv) {
    if (a === '--json') {
      json = true;
      continue;
    }
    const m = a.match(/^--source=(real|synthetic)$/);
    if (m?.[1]) {
      source = m[1] as SourceFilter;
      continue;
    }
    bail(`[audit] неизвестный аргумент: ${a}`);
  }
  return { json, source };
}

function pad(s: string, w: number, right = false): string {
  if (s.length >= w) return s;
  return right ? s.padStart(w) : s.padEnd(w);
}

function printTable(rows: readonly AuditRow[], source: SourceFilter): void {
  const showReal = source !== 'synthetic';
  const showSynth = source !== 'real';

  type Col = { label: string; w: number; right: boolean; get: (r: AuditRow) => string };
  const cols: Col[] = [];
  cols.push({ label: 'rule_id', w: 8, right: false, get: (r) => r.rule_id });
  cols.push({ label: 'severity', w: 10, right: false, get: (r) => r.severity });
  if (showReal) cols.push({ label: 'real', w: 6, right: true, get: (r) => String(r.real) });
  if (showSynth)
    cols.push({ label: 'synthetic', w: 11, right: true, get: (r) => String(r.synthetic) });
  cols.push({ label: 'total', w: 7, right: true, get: (r) => String(r.total) });
  cols.push({ label: 'quota', w: 7, right: true, get: (r) => String(r.quota) });
  cols.push({ label: 'delta', w: 7, right: true, get: (r) => String(r.delta) });

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
  const totalQuota = rows.reduce((s, r) => s + r.quota, 0);
  const totalDelta = rows.reduce((s, r) => s + r.delta, 0);
  const noCovReal = rows.filter((r) => r.real === 0).length;
  const noCovSynth = rows.filter((r) => r.synthetic === 0).length;
  const noCovTotal = rows.filter((r) => r.total === 0).length;

  const labelW = (cols[0]?.w ?? 0) + 1 + (cols[1]?.w ?? 0);
  const sumLine = (
    label: string,
    vReal: number,
    vSynth: number,
    vTotal: number,
    vQuota?: number,
    vDelta?: number,
  ): string => {
    let s = pad(label, labelW, false);
    if (showReal) s += ' ' + pad(String(vReal), 6, true);
    if (showSynth) s += ' ' + pad(String(vSynth), 11, true);
    s += ' ' + pad(String(vTotal), 7, true);
    if (vQuota !== undefined) s += ' ' + pad(String(vQuota), 7, true);
    if (vDelta !== undefined) s += ' ' + pad(String(vDelta), 7, true);
    return s;
  };

  console.log(sumLine('Всего нарушений', totalReal, totalSynth, totalAll, totalQuota, totalDelta));
  console.log(sumLine('Правил без покрытия', noCovReal, noCovSynth, noCovTotal));
  console.log(`Правил всего: ${rows.length}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const rules = await readRules();
  const knownRules = new Set(rules.map((r) => r.id));
  const quota = await readQuota();
  const { real, synthetic } = await readAllCases();

  const realHits = countHits(real, knownRules);
  const synthHits = countHits(synthetic, knownRules);

  const rows = buildRows(rules, realHits, synthHits, quota, args.source);

  if (args.json) {
    const sorted = [...rows].sort((a, b) => {
      if (b.delta !== a.delta) return b.delta - a.delta;
      return a.rule_id.localeCompare(b.rule_id);
    });
    process.stdout.write(JSON.stringify(sorted, null, 2) + '\n');
    return;
  }

  printTable(rows, args.source);
}

main().catch((err) => {
  console.error('[audit] failure:', err);
  process.exit(1);
});
