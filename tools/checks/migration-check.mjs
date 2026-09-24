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

    // --- 3в. Отдельный файл быстрой правки ограничения статусов ---
    // Короткий скрипт для случая «заявка не закрывается»: его копируют в
    // SQL Editor целиком, поэтому он должен быть безопасен к копированию,
    // повторному запуску и обрыву на ошибке — проверяем то же, что у миграции.
    const FIX = path.join(ROOT, 'database', 'fix-orders-status-check.sql');

    if (!fs.existsSync(FIX)) {
        ok('есть файл database/fix-orders-status-check.sql', false, FIX);
    } else {
        const fix = fs.readFileSync(FIX, 'utf8');
        const fixHandlers = (fix.match(/exception\s+when\s+others/gi) || []).length;

        ok('fix-orders-status-check.sql: снимает старое и ставит новое ограничение',
            /orders_status_check/.test(fix) && /drop constraint/i.test(fix) &&
            /add constraint orders_status_check/i.test(fix), 'drop + add');

        const fixMissing = STATUS_VALUES.filter((value) => !new RegExp(`'${value}'`).test(fix));
        ok('fix-orders-status-check.sql: разрешает все статусы кода (включая delivered)',
            fixMissing.length === 0, fixMissing.join(', ') || STATUS_VALUES.join(' | '));

        ok('fix-orders-status-check.sql: шаги защищены и есть проверка результата',
            fixHandlers >= 2 && /MISSING — delivered запрещён/.test(fix),
            'обработчиков exception when others: ' + fixHandlers);

        const fixTypo = codeLines(fix).filter((line) => TYPOGRAPHIC.test(line.code));
        const fixInvisible = codeLines(fix).filter((line) => INVISIBLE.test(line.code));
        const fixStripped = linesOf(fix)
            .map((line) => {
                const comment = line.indexOf('--');
                return comment === -1 ? line : line.slice(0, comment);
            })
            .join('\n')
            .replace(/'(?:[^']|'')*'/g, "''");
        const fixEven = (open, close) => fixStripped.split(open).length === fixStripped.split(close).length;

        ok('fix-orders-status-check.sql: чистый для копирования (кавычки, пробелы, скобки, $$)',
            fixTypo.length === 0 && fixInvisible.length === 0 &&
            fixEven('(', ')') && ((fix.match(/\$\$/g) || []).length % 2 === 0),
            [...fixTypo, ...fixInvisible]
                .map((line) => line.number + ': ' + line.code.trim().slice(0, 50)).join(' | '));
    }

    // --- 3г. Отдельный файл быстрой правки ограничения заявок НА ФИНАНСЫ ---
    // Вторая боевая жалоба того же рода: «директор отправляет заявку на
    // доработку, а она не отправляется». Причина — старое CHECK-ограничение
    // на cash_requests.status без статуса 'revision' (появился в v2.2.0).
    const FIX_CASH = path.join(ROOT, 'database', 'fix-cash-requests-status-check.sql');
    const CASH_STATUS_VALUES = ['pending', 'approved', 'revision', 'rejected', 'issued'];

    if (!fs.existsSync(FIX_CASH)) {
        ok('есть файл database/fix-cash-requests-status-check.sql', false, FIX_CASH);
    } else {
        const fixCash = fs.readFileSync(FIX_CASH, 'utf8');
        const cashHandlers = (fixCash.match(/exception\s+when\s+others/gi) || []).length;

        ok('fix-cash-requests-status-check.sql: снимает старое и ставит новое ограничение',
            /cash_requests_status_check/.test(fixCash) && /drop constraint/i.test(fixCash) &&
            /add constraint cash_requests_status_check/i.test(fixCash), 'drop + add');

        const cashMissing = CASH_STATUS_VALUES.filter((value) => !new RegExp(`'${value}'`).test(fixCash));
        ok('fix-cash-requests-status-check.sql: разрешает все статусы кода (включая revision)',
            cashMissing.length === 0, cashMissing.join(', ') || CASH_STATUS_VALUES.join(' | '));

        ok('fix-cash-requests-status-check.sql: шаги защищены и есть проверка результата',
            cashHandlers >= 2 && /MISSING — revision запрещён/.test(fixCash),
            'обработчиков exception when others: ' + cashHandlers);

        // Колонок этот файл не добавляет: у cash_requests они есть с прошлых
        // версий (в отличие от orders, где миграция v2.4.0 добавляет 8 колонок).
        ok('fix-cash-requests-status-check.sql: колонки таблицы не трогает',
            !/add column/i.test(fixCash));

        const cashTypo = codeLines(fixCash).filter((line) => TYPOGRAPHIC.test(line.code));
        const cashInvisible = codeLines(fixCash).filter((line) => INVISIBLE.test(line.code));
        const cashStripped = linesOf(fixCash)
            .map((line) => {
                const comment = line.indexOf('--');
                return comment === -1 ? line : line.slice(0, comment);
            })
            .join('\n')
            .replace(/'(?:[^']|'')*'/g, "''");
        const cashEven = (open, close) => cashStripped.split(open).length === cashStripped.split(close).length;

        ok('fix-cash-requests-status-check.sql: чистый для копирования (кавычки, пробелы, скобки, $$)',
            cashTypo.length === 0 && cashInvisible.length === 0 &&
            cashEven('(', ')') && ((fixCash.match(/\$\$/g) || []).length % 2 === 0),
            [...cashTypo, ...cashInvisible]
                .map((line) => line.number + ': ' + line.code.trim().slice(0, 50)).join(' | '));
    }

    // --- 3д. Миграция v2.5.0: НДС (ПДВ) и своя доставка ---
    // Отдельный файл, а не правка v2.4.0: ту миграцию могли уже применить, а
    // НДС и способ закрытия своей доставки появились позже. Приложение при
    // отсутствии этих колонок отказывается сохранять счёт и говорит, какой
    // файл применить (js/database.js → explainError).
    const VAT_MIGRATION = path.join(ROOT, 'database', 'migrate-v2.5.sql');

    const VAT_COLUMNS = [
        'invoice_price_mode',
        'invoice_vat_rate',
        'vat_total',
        'own_delivery_charge',
        'own_delivery_employee_id',
        'own_delivery_vat_rate',
        'vat_rate',
        'vat_amount',
        'price_with_vat',
        'delivery_kind'
    ];

    if (!fs.existsSync(VAT_MIGRATION)) {
        ok('есть файл database/migrate-v2.5.sql', false, VAT_MIGRATION);
    } else {
        const vatSql = fs.readFileSync(VAT_MIGRATION, 'utf8');

        const vatMissing = VAT_COLUMNS.filter((col) => !new RegExp(`\\b${col}\\b`).test(vatSql));
        ok('миграция v2.5.0 описывает колонки НДС и свою доставку',
            vatMissing.length === 0, vatMissing.join(', ') || 'все на месте');

        const vatInSchema = VAT_COLUMNS.filter((col) => !new RegExp(`\\b${col}\\b`).test(schema));
        ok('schema.sql описывает те же колонки НДС и свою доставку',
            vatInSchema.length === 0, vatInSchema.join(', ') || 'все на месте');

        const vatWithType = VAT_COLUMNS.filter(
            (col) => new RegExp(`'${col}\\s+(text|timestamptz|numeric|bigint|boolean)`, 'i').test(vatSql)
        );
        ok('колонки НДС перечислены с типом (text/numeric/bigint/boolean)',
            vatWithType.length === VAT_COLUMNS.length,
            vatWithType.length + ' из ' + VAT_COLUMNS.length);

        const vatAddColumn = (vatSql.match(/add column/gi) || []).length;
        const vatGuarded = (vatSql.match(/add column\s+if not exists/gi) || []).length;
        ok('в миграции v2.5.0 у каждого add column есть if not exists',
            vatGuarded === vatAddColumn && vatAddColumn >= 3,
            vatGuarded + ' из ' + vatAddColumn);

        const vatHandlers = (vatSql.match(/exception\s+when\s+others/gi) || []).length;
        ok('колонки v2.5.0 добавляются в защищённых блоках (exception when others)',
            vatHandlers >= 4, 'обработчиков exception when others: ' + vatHandlers);

        ok('в конце миграции v2.5.0 есть самопроверка (ok / MISSING)',
            /MISSING — примените файл целиком/.test(vatSql) && /'ok'/.test(vatSql));

        ok('миграция v2.5.0 просит PostgREST перечитать схему (notify pgrst)',
            /notify\s+pgrst\s*,\s*'reload schema'/i.test(vatSql));

        ok('миграция v2.5.0 заполняет вид доставки у старых строк (supplier / company)',
            /set delivery_kind = 'supplier'/.test(vatSql) && /set delivery_kind = 'company'/.test(vatSql));

        const vatTypo = codeLines(vatSql).filter((line) => TYPOGRAPHIC.test(line.code));
        const vatInvisible = codeLines(vatSql).filter((line) => INVISIBLE.test(line.code));
        const vatStripped = linesOf(vatSql)
            .map((line) => {
                const comment = line.indexOf('--');
                return comment === -1 ? line : line.slice(0, comment);
            })
            .join('\n')
            .replace(/'(?:[^']|'')*'/g, "''");
        const vatEven = (open, close) => vatStripped.split(open).length === vatStripped.split(close).length;

        ok('миграция v2.5.0 чистая для копирования (кавычки, пробелы, скобки, $$)',
            vatTypo.length === 0 && vatInvisible.length === 0 &&
            vatEven('(', ')') && ((vatSql.match(/\$\$/g) || []).length % 2 === 0),
            [...vatTypo, ...vatInvisible]
                .map((line) => line.number + ': ' + line.code.trim().slice(0, 50)).join(' | '));

        // Код и миграция должны называть одно и то же: если приложение начнёт
        // писать другой маркер расхода, проверка это заметит.
        const utilsJs = fs.readFileSync(path.join(ROOT, 'js', 'utils.js'), 'utf8');
        ok("код знает маркер расхода своей доставки (source = 'own_delivery')",
            /own_delivery/.test(utilsJs) && /ownDeliveryCoveredOrderIds/.test(utilsJs));
    }

    // --- 3е. Миграция v2.6.0: архив заявок на финансирование ---
    // Третья боевая жалоба того же рода: «кнопка 📥 В архив не работает».
    // Причина — на cash_requests.status осталось CHECK-ограничение без статуса
    // 'archived' (появился в v2.6.0). Файл колонок НЕ добавляет: правит только
    // ограничение, поэтому в нём не должно быть ни одного add column.
    const ARCHIVE_MIGRATION = path.join(ROOT, 'database', 'migrate-v2.6.sql');
    const ARCHIVE_STATUS_VALUES = ['pending', 'approved', 'revision', 'rejected', 'issued', 'archived'];

    if (!fs.existsSync(ARCHIVE_MIGRATION)) {
        ok('есть файл database/migrate-v2.6.sql', false, ARCHIVE_MIGRATION);
    } else {
        const v26 = fs.readFileSync(ARCHIVE_MIGRATION, 'utf8');

        ok('migrate-v2.6.sql: снимает старое и ставит новое ограничение',
            /cash_requests_status_check/.test(v26) && /drop constraint/i.test(v26) &&
            /add constraint cash_requests_status_check/i.test(v26), 'drop + add');

        const v26Missing = ARCHIVE_STATUS_VALUES.filter((value) => !new RegExp(`'${value}'`).test(v26));
        ok('migrate-v2.6.sql: разрешает все статусы кода (включая archived)',
            v26Missing.length === 0, v26Missing.join(', ') || ARCHIVE_STATUS_VALUES.join(' | '));

        ok('migrate-v2.6.sql: колонки таблицы не трогает (архив — только статус)',
            !/add column/i.test(v26));

        const v26Handlers = (v26.match(/exception\s+when\s+others/gi) || []).length;
        ok('migrate-v2.6.sql: шаги защищены и есть проверка результата',
            v26Handlers >= 2 && /MISSING — примените файл целиком/.test(v26) && /'ok'/.test(v26),
            'обработчиков exception when others: ' + v26Handlers);

        ok('migrate-v2.6.sql просит PostgREST перечитать схему (notify pgrst)',
            /notify\s+pgrst\s*,\s*'reload schema'/i.test(v26));

        const v26Typo = codeLines(v26).filter((line) => TYPOGRAPHIC.test(line.code));
        const v26Invisible = codeLines(v26).filter((line) => INVISIBLE.test(line.code));
        const v26Stripped = linesOf(v26)
            .map((line) => {
                const comment = line.indexOf('--');
                return comment === -1 ? line : line.slice(0, comment);
            })
            .join('\n')
            .replace(/'(?:[^']|'')*'/g, "''");
        const v26Even = (open, close) => v26Stripped.split(open).length === v26Stripped.split(close).length;

        ok('migrate-v2.6.sql чистая для копирования (кавычки, пробелы, скобки, $$)',
            v26Typo.length === 0 && v26Invisible.length === 0 &&
            v26Even('(', ')') && ((v26.match(/\$\$/g) || []).length % 2 === 0),
            [...v26Typo, ...v26Invisible]
                .map((line) => line.number + ': ' + line.code.trim().slice(0, 50)).join(' | '));

        // Код и миграция должны знать один и тот же статус: приложение пишет
        // 'archived' и показывает его фильтром «📥 Архив».
        const cashJs = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'cash-requests.js'), 'utf8');
        const dashboardJs = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'dashboard.js'), 'utf8');
        ok("код умеет ставить и показывать статус 'archived'",
            /canArchiveCashRequest/.test(cashJs) && /'archived'/.test(cashJs) &&
            /'archived'/.test(dashboardJs));
    }

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

