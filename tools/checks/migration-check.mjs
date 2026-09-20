// =====================================================================
// Прогон БЕЗ БРАУЗЕРА (только Node): проверка файлов миграции базы
// =====================================================================
// Зачем: база обновляется вручную в Supabase SQL Editor, и ошибка в SQL
// видна только там. Прогон стережёт то, что уже ломалось на боевой базе:
//
//   1. SQL Editor останавливает скрипт на ПЕРВОЙ ошибке — поэтому восемь
//      alter table подряд применились наполовину (4 колонки из 8). Проверяем,
//      что колонки добавляются в защищённых блоках (exception when others) и
//      что в файле есть самопроверка.
//   2. SQL легко испортить копированием из документа/отчёта: типографская
//      кавычка ’paid’ или невидимый пробел превращают команду в синтаксическую
//      ошибку — и скрипт обрывается на ней. Такие символы ищем в коде (вне
//      комментариев).
//   3. Миграция и database/schema.sql должны описывать одну и ту же схему:
//      колонки, нужные коду v2.4.0, обязаны быть в обоих файлах.
//
// Запуск (из папки tools/checks):  node migration-check.mjs
// Код возврата 1, если есть замечания — удобно для автопроверки перед выкладкой.
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIGRATION = path.join(ROOT, 'database', 'migrate-v2.4.sql');
const SCHEMA = path.join(ROOT, 'database', 'schema.sql');

// Колонки, которые появились в v2.4.0 и нужны коду (js/modules/orders.js,
// js/modules/invoices.js, js/modules/registry.js).
const REQUIRED_COLUMNS = [
    'invoice_path',
    'invoice_file_name',
    'invoice_uploaded_at',
    'invoice_total',
    'payment_status',
    'delivered_at',
    'paid_at',
    'paid_by_employee_id'
];

const report = [];
const log = (...args) => { const line = args.join(' '); report.push(line); console.log(line); };

let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
};

/** Строки файла без правки исходника. */
const linesOf = (text) => text.split(/\r?\n/);

/** Код без однострочных комментариев (-- ...) — только он должен быть чистым. */
function codeLines(text) {
    const out = [];
    linesOf(text).forEach((line, index) => {
        const comment = line.indexOf('--');
        const code = comment === -1 ? line : line.slice(0, comment);
        if (code.trim()) out.push({ number: index + 1, code });
    });
    return out;
}

const TYPOGRAPHIC = /[\u00AB\u00BB\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u2039\u203A]/u;
const INVISIBLE = /[\u00A0\u2007\u202F\u200B\u200C\u200D\u2060\uFEFF]/u;

function main() {
    log('Проверка миграции базы: ' + path.relative(ROOT, MIGRATION));

    if (!fs.existsSync(MIGRATION)) {
        ok('файл миграции существует', false, MIGRATION);
        return;
    }

    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const schema = fs.existsSync(SCHEMA) ? fs.readFileSync(SCHEMA, 'utf8') : '';

    // --- 1. Все колонки v2.4.0 описаны в миграции и в schema.sql ---
    const missingInMigration = REQUIRED_COLUMNS.filter((col) => !new RegExp(`\\b${col}\\b`).test(sql));
    ok('миграция описывает все 8 колонок v2.4.0',
        missingInMigration.length === 0, missingInMigration.join(', ') || 'все на месте');

    // Важно, что с типом: колонка без типа в списке добавления уронит весь блок
    const withType = REQUIRED_COLUMNS.filter(
        (col) => new RegExp(`'${col}\\s+(text|timestamptz|numeric|bigint)`, 'i').test(sql)
    );
    ok('все 8 колонок перечислены с типом (text/timestamptz/numeric/bigint)',
        withType.length === REQUIRED_COLUMNS.length,
        withType.length + ' из ' + REQUIRED_COLUMNS.length);

    const missingInSchema = REQUIRED_COLUMNS.filter((col) => !new RegExp(`\\b${col}\\b`).test(schema));
    ok('schema.sql описывает те же 8 колонок',
        missingInSchema.length === 0, missingInSchema.join(', ') || 'все на месте');

    // --- 2. Каждый add column идемпотентен (if not exists) ---
    const addColumnCount = (sql.match(/add column/gi) || []).length;
    const guardedCount = (sql.match(/add column\s+if not exists/gi) || []).length;
    ok('у каждого add column есть if not exists',
        guardedCount === addColumnCount && addColumnCount > 0,
        guardedCount + ' из ' + addColumnCount);

    // --- 3. Ошибка одной команды не обрывает скрипт ---
    const doBlocks = (sql.match(/do\s*\$\$/gi) || []).length;
    const handlers = (sql.match(/exception\s+when\s+others/gi) || []).length;
    ok('колонки добавляются в защищённых блоках (exception when others)',
        doBlocks >= 2 && handlers >= 2, 'do-блоков: ' + doBlocks + ', обработчиков: ' + handlers);

    ok('в конце есть самопроверка (ok / MISSING по каждой колонке)',
        /'MISSING/.test(sql) && /'ok'/.test(sql));

    ok('скрипт просит PostgREST перечитать схему (notify pgrst)',
        /notify\s+pgrst\s*,\s*'reload schema'/i.test(sql));

    // --- 3б. Статусы заявки: миграция обновляет CHECK-ограничение ---
    // Боевая жалоба «заявка не закрывается»: на orders.status висело старое
    // ограничение без 'delivered', и запись падала с 23514 («violates check
    // constraint "orders_status_check"»). Миграция обязана снять старое
    // ограничение и поставить новое — со списком статусов из кода.
    ok('миграция обновляет CHECK-ограничение orders_status_check',
        /orders_status_check/.test(sql) &&
        /drop constraint/i.test(sql) &&
        /add constraint orders_status_check/i.test(sql),
        'снятие старого + постановка нового');

    const STATUS_VALUES = ['new', 'in_progress', 'delivered', 'closed', 'archived'];
    const missingStatuses = STATUS_VALUES.filter((value) => !new RegExp(`'${value}'`).test(sql));
    ok("новое ограничение разрешает все статусы кода (включая 'delivered')",
        missingStatuses.length === 0, missingStatuses.join(', ') || STATUS_VALUES.join(' | '));

    const missingInSchemaStatuses = STATUS_VALUES.filter((value) => !new RegExp(value).test(schema));
    ok('schema.sql описывает тот же список статусов',
        missingInSchemaStatuses.length === 0, missingInSchemaStatuses.join(', ') || 'все на месте');

    ok('снятие и постановка ограничения тоже защищены (exception when others)',
        handlers >= 4, 'обработчиков exception when others: ' + handlers);

    ok('есть проверка, что ограничение больше не запрещает delivered',
        /MISSING — delivered запрещён/.test(sql) && /as k on true;/.test(sql));

    // --- 4. Разделители в порядке (иначе команда вообще не выполнится) ---
    // Считаем скобки по «голому» SQL: комментарии и строковые литералы
    // выбрасываем, иначе скобка из подсказки или из текста 'ИТОГО (грн)'
    // сломала бы сам подсчёт.
    const stripped = linesOf(sql)
        .map((line) => {
            const comment = line.indexOf('--');
            return comment === -1 ? line : line.slice(0, comment);
        })
        .join('\n')
        .replace(/'(?:[^']|'')*'/g, "''");

    const dollarQuotes = (sql.match(/\$\$/g) || []).length;
    ok('кавычки $$ парные', dollarQuotes % 2 === 0 && dollarQuotes > 0, 'найдено: ' + dollarQuotes);

    const balanced = (open, close) => (stripped.split(open).length === stripped.split(close).length);
    ok('в SQL сбалансированы скобки ( ) и [ ]',
        balanced('(', ')') && balanced('[', ']'));

    // --- 5. В коде нет символов, которые ломают SQL при копировании ---
    const typographic = codeLines(sql).filter((line) => TYPOGRAPHIC.test(line.code));
    const invisible = codeLines(sql).filter((line) => INVISIBLE.test(line.code));

    ok('в SQL нет типографских кавычек (« » “ ” ‘ ’) — они рвут команду',
        typographic.length === 0,
        typographic.map((line) => line.number + ': ' + line.code.trim().slice(0, 60)).join(' | '));

    ok('в SQL нет невидимых пробелов (NBSP, zero-width, BOM)',
        invisible.length === 0,
        invisible.map((line) => line.number + ': ' + line.code.trim().slice(0, 60)).join(' | '));

    log('--- ИТОГ ---');
    log(failed === 0
        ? '  ВСЁ ВЕРНО: миграция и schema.sql согласованы, SQL защищён от обрыва наполовину'
        : '  не прошло проверок: ' + failed);
}

try {
    main();
} catch (error) {
    log('ОШИБКА ПРОГОНА: ' + (error && error.stack ? error.stack : error));
    failed += 1;
} finally {
    const outDir = path.join(os.tmpdir(), 'rsk-fin');
    try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'migration-check.txt'), report.join('\r\n'), 'utf8');
    } catch { /* нет доступа к %TEMP% — отчёт остаётся в консоли */ }

    process.exit(failed === 0 ? 0 : 1);
}

