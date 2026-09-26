// =====================================================================
// Проверка РЕЗЕРВНОЙ КОПИИ (tools/ops/check-dump.mjs)
// =====================================================================
// Зачем: бэкап, который никто не проверял, — это надежда, а не копия. Дамп
// снимается автоматически (.github/workflows/backup.yml, ежедневно), и до
// аварии о нём ничего не известно. Этот прогон отвечает на три вопроса,
// пока дамп ещё лежит в CI:
//
//   1. файлы вообще есть и не пустые (пустой data.sql = «дамп снялся», но
//      таблицы не выгрузились: типичный след отозванных прав);
//   2. в схеме есть ключевые таблицы приложения — значит, выгрузилась именно
//      наша база, а не соседний проект и не пустая схема public;
//   3. архивы .gz распаковываются (обрыв загрузки иначе выясняется только при
//      восстановлении, когда чинить уже нечего).
//
// Отдельно печатается манифест: файл, размер, sha256 и коммит. Его кладут
// рядом с дампом, и по нему видно, ЧТО именно лежит в архиве и когда снято.
// Восстановление проверяется на staging (см. ops/README.md → «Резервные
// копии»): в сам Postgres этот прогон не пишет ничего и ни к какой базе не
// подключается — ему нужны только файлы.
//
// Запуск:  node tools/ops/check-dump.mjs <папка с дампом> [--manifest=<файл>]
// Код возврата 1, если дамп неполный или повреждён.
// =====================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const dirArg = argv.find((arg) => !arg.startsWith('--'));
const dir = path.resolve(dirArg || 'dump');
const flagValue = (name) => {
    const arg = argv.find((item) => item.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : '';
};

const report = [];
const log = (...args) => { const line = args.join(' '); report.push(line); console.log(line); };

let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
    return !!cond;
};

if (!fs.existsSync(dir)) {
    console.error(`❌ check-dump: нет папки с дампом ${dir}`);
    process.exit(1);
}

// --- Что должно быть в дампе ------------------------------------------
// Имена таблиц не выдуманы: это то, без чего приложение не работает
// (database/schema.sql, database/migrate-v2.8-finance-rpc-audit.sql — журнал
// audit_log, database/migrate-v2.9-ops-monitoring.sql — журнал ошибок).
const KEY_TABLES = ['employees', 'projects', 'orders', 'order_items', 'cash_requests',
    'cash_operations', 'audit_log', 'app_errors'];

const files = fs.readdirSync(dir).filter((name) => /\.sql(\.gz)?$/.test(name)).sort();

/** Размер по-человечески: байты для мелочи, килобайты для настоящего дампа. */
const sizeText = (bytes) => (bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(0)} КБ`);

log(`=== Проверка резервной копии из ${dir} ===`);
log(`  коммит: ${process.env.GITHUB_SHA || 'неизвестно'}, время: ${new Date().toISOString()}`);

ok('в папке есть файлы дампа (*.sql или *.sql.gz)', files.length >= 2, files.join(', ') || 'ничего нет');

const manifest = [];
const content = new Map();

for (const name of files) {
    const full = path.join(dir, name);
    const size = fs.statSync(full).size;
    const buffer = fs.readFileSync(full);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const packed = name.endsWith('.gz');

    // Размер архива говорит только о том, что файл на месте: у маленького
    // проекта сжатые роли весят десятки байт, и «меньше килобайта» здесь не
    // поломка. Настоящая проверка содержимого — ниже, после распаковки.
    // Пустоту архива по размеру не определить: сильно повторяющиеся данные
    // сжимаются в десятки байт (проверено на выгрузке-образце). Поэтому здесь
    // только «файл есть» (у gzip это пара десятков байт заголовка), а настоящая
    // проверка содержимого — ниже, по распакованному размеру.
    const minSize = packed ? 20 : 1000;
    ok(`${name}: файл не пустой (${sizeText(size)}${packed ? ' в архиве' : ''})`, size > minSize);
    manifest.push(`${name}\t${size}\t${sha256}`);

    if (packed) {
        try {
            const unpacked = zlib.gunzipSync(buffer);
            ok(`${name}: архив распаковывается, внутри ${sizeText(unpacked.length)} данных`, unpacked.length > 1000);
            content.set(name, unpacked.toString('utf8'));
        } catch (error) {
            ok(`${name}: архив распаковывается`, false, String(error.message || error));
        }
    } else {
        ok(`${name}: не пустой (${sizeText(size)})`, size > 1000);
        content.set(name, buffer.toString('utf8'));
    }
}

// --- Схема: выгрузилась именно наша база -------------------------------
const schema = [...content.entries()].find(([name]) => name.startsWith('schema'))?.[1] || '';
ok('есть файл схемы (schema*.sql)', !!schema);
if (schema) {
    // Таблицы ищем в операторах `create table`, а не по всему тексту: имя
    // может встретиться в комментарии или в политике, и тогда неполный дамп
    // выглядел бы целым. Кавычки не учитываем: разные версии `pg_dump` пишут
    // и `create table "public"."orders"`, и `CREATE TABLE public.orders`.
    const statements = schema.split(';').filter((part) => /create table/i.test(part));
    const missing = KEY_TABLES.filter((table) =>
        !statements.some((part) => new RegExp(`["\\s.]${table}["\\s(]`).test(part)));
    ok(`в схеме есть ключевые таблицы приложения (${KEY_TABLES.length} шт.)`,
        missing.length === 0, missing.join(', ') || 'все на месте');
    ok('в схеме видно защиту финансов (включён RLS)', /row level security/i.test(schema));
}

// --- Данные: строки действительно выгрузились --------------------------
const data = [...content.entries()].find(([name]) => name.startsWith('data'))?.[1] || '';
ok('есть файл данных (data*.sql)', !!data);
if (data) {
    // BOM снимаем: его может добавить редактор/конвейер, и первый COPY-блок
    // иначе «терялся» бы (ровно этот случай поймал ручной прогон).
    const copies = [...data.replace(/^\uFEFF/, '').matchAll(/^COPY\s+(?:"?public"?\.)?"?([a-z_]+)"?/gm)]
        .map((match) => match[1]);
    const unique = [...new Set(copies)];
    ok(`в данных есть COPY-блоки таблиц (${unique.length} таблиц)`, unique.length >= 5, unique.join(', '));

    // Без сотрудников и объектов база бесполезна: это справочники, на которых
    // держится всё остальное, и именно они чаще всего теряются при неверной
    // выгрузке (например, когда дамп снят с пустого проекта).
    const lostReferences = ['employees', 'projects'].filter((table) => !unique.includes(table));
    ok('данные сотрудников и объектов выгружены', lostReferences.length === 0, lostReferences.join(', '));
}

// --- Манифест -----------------------------------------------------------
const manifestPath = flagValue('manifest') || path.join(dir, 'backup-manifest.txt');
const header = [
    '# FreeDOM — манифест резервной копии',
    '# как восстановить: ops/README.md → «Резервные копии»',
    `# снято: ${new Date().toISOString()}`,
    `# коммит: ${process.env.GITHUB_SHA || 'неизвестно'}`,
    '# файл\tбайт\tsha256'
];
fs.writeFileSync(manifestPath, header.concat(manifest).join('\n') + '\n', 'utf8');
ok('манифест записан (файл, размер, sha256)', fs.existsSync(manifestPath), manifestPath);
ok('в манифесте перечислены все файлы дампа', manifest.length === files.length,
    `${manifest.length} из ${files.length}`);

log('--- ИТОГ ---');
log(failed === 0
    ? `  ДАМП ГОДЕН: ${files.length} файлов, ключевые таблицы и данные на месте, sha256 записан`
    : `  замечаний: ${failed} — дамп неполный, разбирайтесь раньше, чем он понадобится`);

const outDir = path.join(os.tmpdir(), 'freedom-fin');
try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'backup-check.txt'), report.join('\r\n'), 'utf8');
} catch { /* нет доступа к %TEMP% — отчёт остаётся в консоли */ }

process.exit(failed === 0 ? 0 : 1);
