// Генератор реальных тест-кейсов (Sprint P3, baseline-разметка).
// Читает datasets/<source>/cards.raw.jsonl, применяет ручную классификацию,
// раскладывает 67 файлов по datasets/cases/real-clean и real-dirty.
//
// Источник правды по разметке — словари DIRTY и REVIEWS ниже.
// Любая карточка, которой нет в DIRTY, идёт в real-clean.
// Файл идемпотентен: повторный прогон перезаписывает то же содержимое.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const DATASETS_DIR = join(REPO_ROOT, 'datasets');
const CASES_DIR = join(DATASETS_DIR, 'cases');
const CLEAN_DIR = join(CASES_DIR, 'real-clean');
const DIRTY_DIR = join(CASES_DIR, 'real-dirty');

const TODAY = '2026-04-25';

type Severity = 'low' | 'medium' | 'high' | 'critical';

interface Violation {
  rule_id: string;
  severity: Severity;
  field_path: string;
  quote: string | null;
  rationale: string;
}

// Сюда вписываются только грязные карточки.
const DIRTY: Record<string, Violation[]> = {
  // sputnik8 — аренда яхты в карточке экскурсии (TXT-23).
  sputnik8_57480: [
    {
      rule_id: 'TXT-23',
      severity: 'high',
      field_path: 'title',
      quote: 'Аренда яхты «BAYLINER 205 CAPRI»',
      rationale:
        'Карточка с product_type=excursion используется для публикации аренды катера. TXT-23 прямо запрещает использование карточки для аренды.',
    },
  ],

  // pmpoperator — title заявляет 5 дней, программа содержит 7 дней (TXT-22).
  'pmpoperator_v-kaliningrad-na-pyat-dney-leto-zaezdi-ezhednevno': [
    {
      rule_id: 'TXT-22',
      severity: 'high',
      field_path: 'program_items[6].title',
      quote: 'День 7',
      rationale:
        'В заголовке заявлено «пять дней», но программа содержит 7 дней — пункт «День 7» противоречит длительности из заголовка карточки.',
    },
  ],

  // pmpoperator — карточка типа excursion описывает многодневное проживание
  // в гостевых домах (TXT-21).
  'pmpoperator_perezagruzka-dlya-megapolisa-bez-interneta-televizora-sosedey': [
    {
      rule_id: 'TXT-21',
      severity: 'high',
      field_path: 'full_description',
      quote:
        'Отдых без интернета, телевизора, соседей! В любой день недели и на любое количество дней!',
      rationale:
        'Карточка с product_type=excursion фактически описывает многодневное проживание в гостевых домах с произвольным числом ночей. Это другой тип сущности (тур или средство размещения), не экскурсия.',
    },
  ],

  // scantour — телефон в short_description с прямым призывом «бронируйте по телефону» (TXT-20).
  'scantour_prityagatelnaya-ladoga-krasota-vdohnovlyayushhaya-na-otkrytiya': [
    {
      rule_id: 'TXT-20',
      severity: 'high',
      field_path: 'short_description',
      quote:
        'Бронирование на сайте или по телефону: 8 (812) 607-64-63',
      rationale:
        'short_description содержит прямой призыв забронировать тур по телефону вне платформы — явный TXT-20.',
    },
  ],
  'scantour_skazochnyj-velikij-ustyug-czelyj-den-v-votchine-deda-moroza': [
    {
      rule_id: 'TXT-20',
      severity: 'high',
      field_path: 'short_description',
      quote:
        'Бронирование на сайте или по телефону: 8 (812) 607-64-63',
      rationale:
        'short_description содержит прямой призыв забронировать тур по телефону вне платформы — явный TXT-20.',
    },
  ],
  'scantour_2-v-1-peterburg-ruskeala-kizhi-shhery': [
    {
      rule_id: 'TXT-20',
      severity: 'high',
      field_path: 'short_description',
      quote:
        'Бронирование на сайте или по телефону: 8 (812) 607-64-63',
      rationale:
        'short_description содержит прямой призыв забронировать тур по телефону вне платформы — явный TXT-20.',
    },
  ],
  'scantour_gran-tur-vsya-kareliya-i-splav-na-reke-shuya': [
    {
      rule_id: 'TXT-20',
      severity: 'high',
      field_path: 'short_description',
      quote:
        'Бронирование на сайте или по телефону: 8 (812) 607-64-63',
      rationale:
        'short_description содержит прямой призыв забронировать тур по телефону вне платформы — явный TXT-20.',
    },
  ],
  'scantour_zimnyaya-skazka-v-arhangelskoj-oblasti': [
    {
      rule_id: 'TXT-20',
      severity: 'high',
      field_path: 'short_description',
      quote:
        'Бронирование на сайте или по телефону: 8 (812) 607-64-63',
      rationale:
        'short_description содержит прямой призыв забронировать тур по телефону вне платформы — явный TXT-20.',
    },
  ],
  'scantour_solovki-za-odin-den-iz-petrozavodska': [
    {
      rule_id: 'TXT-20',
      severity: 'high',
      field_path: 'short_description',
      quote:
        'Бронирование на сайте или по телефону: 8 (812) 607-64-63',
      rationale:
        'short_description содержит прямой призыв забронировать тур по телефону вне платформы — явный TXT-20.',
    },
  ],
  'scantour_valdaj-ivany-pereleski-lesnoj-kvest-i-chaj-iz-samovara': [
    {
      rule_id: 'TXT-20',
      severity: 'high',
      field_path: 'short_description',
      quote:
        'Бронирование на сайте или по телефону: 8 (812) 607-64-63',
      rationale:
        'short_description содержит прямой призыв забронировать тур по телефону вне платформы — явный TXT-20.',
    },
  ],
  'scantour_4-svobodnyh-dnya-v-karelii-glempingi-na-beregu-ladozhskogo-ozera-lajt': [
    {
      rule_id: 'TXT-20',
      severity: 'high',
      field_path: 'short_description',
      quote:
        'Бронирование на сайте или по телефону: 8 (812) 607-64-63',
      rationale:
        'short_description содержит прямой призыв забронировать тур по телефону вне платформы — явный TXT-20.',
    },
  ],
  'scantour_gatchina-imperatorskaya-ferma-i-syrnyj-master-klass': [
    {
      rule_id: 'TXT-20',
      severity: 'high',
      field_path: 'short_description',
      quote:
        'Бронирование на сайте или по телефону: 8 (812) 607-64-63',
      rationale:
        'short_description содержит прямой призыв забронировать тур по телефону вне платформы — явный TXT-20.',
    },
  ],
  'scantour_top-mesta-karelii-2-valaam-shhery-master-klassy-iz-petrozavodska': [
    {
      rule_id: 'TXT-20',
      severity: 'high',
      field_path: 'short_description',
      quote:
        'Бронирование на сайте или по телефону: 8 (812) 607-64-63',
      rationale:
        'short_description содержит прямой призыв забронировать тур по телефону вне платформы — явный TXT-20.',
    },
  ],

  // afisha — упоминание домена «Afisha.ru» в short_description (TXT-19) +
  // HTML-теги в full_description (TXT-26) у одной карточки.
  'afisha_concert_dmitriy-pevcov-i-pevcov-orkestr-6021770': [
    {
      rule_id: 'TXT-19',
      severity: 'medium',
      field_path: 'short_description',
      quote: 'Afisha.ru',
      rationale:
        'short_description содержит явное указание на сторонний сайт продажи билетов (Afisha.ru) — TXT-19, попытка перенести покупку вне платформы.',
    },
    {
      rule_id: 'TXT-26',
      severity: 'medium',
      field_path: 'full_description',
      quote: '<p>Дмитрий Анатольевич Певцов является театральным и киноактёром',
      rationale:
        'full_description содержит непочищенные HTML-теги (<p>…</p>) — технический мусор разметки, что подпадает под TXT-26.',
    },
  ],
  'afisha_performance_don-zhuan-263122': [
    {
      rule_id: 'TXT-19',
      severity: 'medium',
      field_path: 'short_description',
      quote: 'Afisha.ru',
      rationale:
        'short_description содержит явное указание на сторонний сайт продажи билетов (Afisha.ru) — TXT-19, попытка перенести покупку вне платформы.',
    },
  ],
  'afisha_concert_tanya-shamanina-6034924': [
    {
      rule_id: 'TXT-19',
      severity: 'medium',
      field_path: 'short_description',
      quote: 'Afisha.ru',
      rationale:
        'short_description содержит явное указание на сторонний сайт продажи билетов (Afisha.ru) — TXT-19, попытка перенести покупку вне платформы.',
    },
  ],
};

// notes:"review" для карточек, требующих ручного просмотра. Изначально
// сюда попали 5 карточек, у которых парсер захватывал нерелевантные блоки
// (отзывы, биография гида, меню вместо описания); после фикса парсеров
// в parse-sputnik8.ts/parse-pmpoperator.ts (2026-04-25) все 5 пере-парсены
// и попали в clean. Сейчас словарь пуст — оставлен ради будущих ручных
// пометок без изменения сигнатуры buildCase.
const REVIEWS: Record<string, string> = {};

interface CardRecord {
  card: Record<string, unknown> & { id: string };
  _meta?: unknown;
}

interface CardCase {
  case_id: string;
  kind: 'card_case';
  source: 'production';
  generator: { model: null; prompt_version: null; date: string };
  card: Record<string, unknown>;
  expected_violations: Violation[];
  expected_clean: boolean;
  notes: string | null;
}

async function readJsonl(path: string): Promise<CardRecord[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CardRecord);
}

async function listSources(): Promise<string[]> {
  const entries = await readdir(DATASETS_DIR, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (['images', 'schema', 'cases'].includes(e.name)) continue;
    out.push(e.name);
  }
  return out.sort();
}

function buildCase(card: CardRecord['card']): CardCase {
  const id = card.id;
  const violations = DIRTY[id] ?? [];
  const noteRaw = REVIEWS[id];
  const expected_clean = violations.length === 0;
  return {
    case_id: id,
    kind: 'card_case',
    source: 'production',
    generator: { model: null, prompt_version: null, date: TODAY },
    card,
    expected_violations: violations,
    expected_clean,
    notes: noteRaw ?? null,
  };
}

async function main(): Promise<void> {
  await mkdir(CLEAN_DIR, { recursive: true });
  await mkdir(DIRTY_DIR, { recursive: true });

  const sources = await listSources();
  let total = 0;
  let cleanCount = 0;
  let dirtyCount = 0;
  let reviewCount = 0;

  const dirtyKnown = new Set(Object.keys(DIRTY));
  const reviewsKnown = new Set(Object.keys(REVIEWS));
  const seenIds = new Set<string>();

  for (const src of sources) {
    const path = join(DATASETS_DIR, src, 'cards.raw.jsonl');
    const records = await readJsonl(path);
    for (const rec of records) {
      if (!rec.card || typeof rec.card.id !== 'string') {
        throw new Error(`[generate] ${path}: запись без card.id`);
      }
      const id = rec.card.id;
      if (seenIds.has(id)) {
        throw new Error(`[generate] дубликат case_id: ${id}`);
      }
      seenIds.add(id);
      const c = buildCase(rec.card);
      const dir = c.expected_clean ? CLEAN_DIR : DIRTY_DIR;
      const filePath = join(dir, `${id}.json`);
      await writeFile(filePath, JSON.stringify(c, null, 2) + '\n', 'utf8');
      total += 1;
      if (c.expected_clean) cleanCount += 1;
      else dirtyCount += 1;
      if (c.notes) reviewCount += 1;
    }
  }

  // Защита от ошибок в словарях: id из DIRTY/REVIEWS, которых нет в исходных карточках.
  const orphansDirty = [...dirtyKnown].filter((id) => !seenIds.has(id));
  const orphansReviews = [...reviewsKnown].filter((id) => !seenIds.has(id));
  if (orphansDirty.length > 0) {
    throw new Error(
      `[generate] DIRTY содержит id, отсутствующие в cards.raw.jsonl: ${orphansDirty.join(', ')}`,
    );
  }
  if (orphansReviews.length > 0) {
    throw new Error(
      `[generate] REVIEWS содержит id, отсутствующие в cards.raw.jsonl: ${orphansReviews.join(', ')}`,
    );
  }

  console.log(
    `[generate] total=${total}, clean=${cleanCount}, dirty=${dirtyCount}, review-flagged=${reviewCount}`,
  );
}

main().catch((err) => {
  console.error('[generate] failure:', err);
  process.exit(1);
});
