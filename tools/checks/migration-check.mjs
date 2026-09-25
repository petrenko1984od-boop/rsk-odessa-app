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
//   4. v2.7.0 (migrate-v2.7-rls-finance.sql) включает RLS на финансы: anon-ключ
//      публичен по дизайну, поэтому политики — единственное, что защищает
//      cash_requests/cash_operations. Проверяем, что RLS включён И форсирован,
//      каждая политика сначала снимается (файл запускают повторно), права anon
//      отобраны, а функции-контекста недоступны роли public. Там же сверяется
//      матрица прав приложения (js/permissions.js → ROLE_PERMISSIONS) со
//      списками ролей в политиках: право и политика — два независимых списка, и
//      расхождение («кнопка есть, а база запись отклоняет») видно только в бою.
//   5. v2.8.0 (migrate-v2.8-finance-rpc-audit.sql) переносит запись в команды
//      RPC и закрывает прямой INSERT. Список команд живёт в коде
//      (js/database.js → RPC), и он обязан совпадать с файлом миграции: опечатка
//      даёт PGRST202 уже в бою. Тем же блоком стерегутся закрытые прямой записи,
//      журнал audit_log, ключ идемпотентности и отсутствие прямых insert в
//      orders/cash_requests в исходниках приложения.
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
// eslint-disable-next-line no-misleading-character-class -- рядом стоят неразрывные и нулевой ширины пробелы с ZWJ: именно их и надо найти
const INVISIBLE = /[\u00A0\u2007\u202F\u200B\u200C\u200D\u2060\uFEFF]/u;

/**
 * «Готов ли файл к копированию в SQL Editor»: типографские кавычки и невидимые
 * пробелы (в коде, вне комментариев), баланс скобок и чётное число разделителей
 * `$$` у do-блоков. Вынести в функцию пришлось после v2.7.0: файлов, которые
 * администратор копирует целиком, стало три, а такая проверка была написана
 * только внутри блока v2.6.0.
 */
function copyIssues(text) {
    const typo = codeLines(text).filter((line) => TYPOGRAPHIC.test(line.code));
    const invisible = codeLines(text).filter((line) => INVISIBLE.test(line.code));

    // Скобки считаем по «голому» SQL: комментарии и строковые литералы
    // выбрасываем, иначе скобка из подсказки ('ИТОГО (грн)') сломала бы подсчёт.
    const stripped = linesOf(text)
        .map((line) => {
            const comment = line.indexOf('--');
            return comment === -1 ? line : line.slice(0, comment);
        })
        .join('\n')
        .replace(/'(?:[^']|'')*'/g, "''");
    const even = (open, close) => stripped.split(open).length === stripped.split(close).length;

    return {
        typo,
        invisible,
        clean: typo.length === 0 && invisible.length === 0 &&
            even('(', ')') && ((text.match(/\$\$/g) || []).length % 2 === 0),
        detail: [...typo, ...invisible]
            .map((line) => line.number + ': ' + line.code.trim().slice(0, 50)).join(' | ')
    };
}

function main() {
    log('Проверка миграций базы (v2.4.0 … v2.9.0): ' + path.relative(ROOT, MIGRATION));

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

    // --- 3ж. Миграция v2.7.0: RLS на финансы и кассовые операции ---
    // Повод: anon-ключ Supabase публичен по дизайну, и до v2.7.0 таблицы
    // cash_requests и cash_operations защищала только «секретность» адреса
    // проекта. Файл включает RLS, отбирает права у anon и создаёт политики по
    // ролям; часть из них — ВРЕМЕННЫЕ (прямая запись), их затем снимает v2.8.0.
    const RLS_MIGRATION = path.join(ROOT, 'database', 'migrate-v2.7-rls-finance.sql');
    const RLS_TABLES = ['cash_requests', 'cash_operations'];
    const RLS_POLICY_COUNT = { cash_requests: 6, cash_operations: 9 };

    if (!fs.existsSync(RLS_MIGRATION)) {
        ok('есть файл database/migrate-v2.7-rls-finance.sql', false, RLS_MIGRATION);
    } else {
        const v27 = fs.readFileSync(RLS_MIGRATION, 'utf8');

        ok('v2.7.0: есть функция-контекст сотрудника (id и роль)',
            /create or replace function public\.rsk_current_employee_id\(\)/.test(v27) &&
            /create or replace function public\.rsk_current_employee_role\(\)/.test(v27) &&
            /returns bigint/.test(v27) && /returns text/.test(v27));

        // Считаем только в КОДЕ: слова «SECURITY DEFINER» и «search_path»
        // встречаются и в комментариях файла — там они объясняют, зачем это.
        const v27Code = codeLines(v27).map((line) => line.code).join('\n');
        const definers = (v27Code.match(/security definer/gi) || []).length;
        const searchPaths = (v27Code.match(/set search_path\s*=\s*pg_catalog,\s*public/gi) || []).length;
        ok('v2.7.0: функции SECURITY DEFINER с фиксированным search_path',
            definers >= 2 && searchPaths >= definers,
            'definer: ' + definers + ', search_path: ' + searchPaths);

        ok('v2.7.0: функции доступны только authenticated (revoke from public + grant execute)',
            ['rsk_current_employee_id', 'rsk_current_employee_role'].every((fn) =>
                new RegExp('revoke all on function public\\.' + fn + '\\(\\) from public').test(v27) &&
                new RegExp('grant execute on function public\\.' + fn + '\\(\\) to authenticated').test(v27)));

        ok('v2.7.0: у anon отобраны права на обе финансовые таблицы',
            RLS_TABLES.every((table) =>
                new RegExp('revoke all on table public\\.' + table + ' from anon').test(v27)));

        ok('v2.7.0: RLS включён и форсирован для обеих таблиц (владелец таблицы тоже под политиками)',
            RLS_TABLES.every((table) =>
                new RegExp('alter table public\\.' + table + ' enable row level security').test(v27) &&
                new RegExp('alter table public\\.' + table + ' force row level security').test(v27)));

        const v27Created = (v27.match(/create policy\s+([a-z_0-9]+)/gi) || [])
            .map((line) => line.replace(/^create policy\s+/i, ''));
        const v27Dropped = (v27.match(/drop policy if exists\s+([a-z_0-9]+)/gi) || [])
            .map((line) => line.replace(/^drop policy if exists\s+/i, ''));
        const v27NotDropped = v27Created.filter((name) => !v27Dropped.includes(name));
        ok('v2.7.0: каждая политика сначала снимается (drop policy if exists) — файл можно запускать повторно',
            v27Created.length > 0 && v27NotDropped.length === 0,
            v27NotDropped.join(', ') || 'политик: ' + v27Created.length);

        const v27Policies = {};
        RLS_TABLES.forEach((table) => {
            v27Policies[table] = (v27.match(
                new RegExp('create policy\\s+\\S+\\s+on public\\.' + table + '\\b', 'g')) || []).length;
        });
        ok('v2.7.0: политики покрывают обе таблицы (6 у заявок, 9 у операций)',
            RLS_TABLES.every((table) => v27Policies[table] === RLS_POLICY_COUNT[table]),
            RLS_TABLES.map((table) => table + ': ' + v27Policies[table] +
                '/' + RLS_POLICY_COUNT[table]).join(', '));

        ok('v2.7.0: в конце есть самопроверка (RLS enabled+forced, список политик, права anon)',
            /relforcerowsecurity/.test(v27) && /from pg_policies/.test(v27) &&
            /has_table_privilege\('anon'/.test(v27));

        ok('v2.7.0: просит PostgREST перечитать политики (notify pgrst)',
            /notify\s+pgrst\s*,\s*'reload schema'/i.test(v27));

        const v27Copy = copyIssues(v27);
        ok('migrate-v2.7-rls-finance.sql чистый для копирования (кавычки, пробелы, скобки, $$)',
            v27Copy.clean, v27Copy.detail);

        // --- Сверка с матрицей прав приложения (js/permissions.js) ---
        // Право в коде и роль в политике — два независимых списка, и расхождение
        // видно только в бою: кнопка есть, а база запись отклоняет («new row
        // violates row-level security policy»), либо наоборот — политика шире
        // интерфейса. Проверяем четыре пути ПРЯМОЙ записи (v2.8.0 их не
        // закрывает, они разрешены политиками v2.7.0):
        //   * пополнение подотчёта кассой — js/modules/cash.js → addIssue →
        //     createOperation (operation_type = 'issue'), право cash_issue;
        //   * расход и возврат «за себя» — addExpenseMulti / addReturn
        //     (source = 'manual' либо NULL), права cash_expense_self,
        //     cash_return_self (Финансист может только возврат);
        //   * закрытие заявки с оплатой из подотчёта — js/modules/orders.js →
        //     closeOrder (source = 'order'), право process_order.
        const rolePerms = {};
        let parsedRole = null;
        const permsBlock = fs.readFileSync(path.join(ROOT, 'js', 'permissions.js'), 'utf8')
            .match(/const ROLE_PERMISSIONS = \{([\s\S]*?)\r?\n\};/);
        if (permsBlock) {
            linesOf(permsBlock[1]).forEach((line) => {
                const code = line.replace(/\s*\/\/.*$/, '');
                const role = code.match(/^\s*'([^']+)':\s*\[/);
                if (role) { parsedRole = role[1]; rolePerms[parsedRole] = []; return; }
                const perm = code.match(/^\s*'([a-z_0-9]+)'\s*,?\s*$/);
                if (perm && parsedRole) rolePerms[parsedRole].push(perm[1]);
            });
        }

        const rolesWith = (perm) => Object.keys(rolePerms).filter((role) => rolePerms[role].includes(perm));
        const policyBlock = (name) => {
            const start = v27Code.indexOf('create policy ' + name);
            if (start === -1) return null;
            const next = v27Code.indexOf('create policy ', start + 1);
            return v27Code.slice(start, next === -1 ? v27Code.length : next);
        };
        const policyRoles = (name) => {
            const block = policyBlock(name);
            if (block === null) return null;
            const list = block.match(/rsk_current_employee_role\(\)\s*in\s*\(([^)]*)\)/);
            return list ? [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
        };
        const missingRoles = (roles, allowed) => roles.filter((role) => !allowed.includes(role));
        const sameSet = (a, b) => a.length === b.length && a.every((role) => b.includes(role));

        const cashierPolicyRoles = policyRoles('rsk_cash_operations_insert_cashier');
        const selfPolicyRoles = policyRoles('rsk_cash_operations_insert_self');
        const selfBlock = policyBlock('rsk_cash_operations_insert_self') || '';
        const issueRoles = rolesWith('cash_issue');
        const expenseRoles = rolesWith('cash_expense_self');
        const returnRoles = rolesWith('cash_return_self');
        const processRoles = rolesWith('process_order');
        const returnAllowed = (selfPolicyRoles || []).concat('Финансист');

        ok('v2.7.0: матрица прав прочитана из js/permissions.js (роли сверяются с политиками)',
            Object.keys(rolePerms).length >= 6 && issueRoles.length > 0 && expenseRoles.length > 0 &&
            returnRoles.length > 0 && processRoles.length > 0,
            'ролей: ' + Object.keys(rolePerms).length + ', cash_issue: ' + issueRoles.join(', '));

        ok('v2.7.0: право cash_issue совпадает с политикой кассы (пополнение подотчёта — прямой записью)',
            sameSet(issueRoles, cashierPolicyRoles || []),
            'в коде: ' + issueRoles.join(', ') + ' | в политике: ' +
                (cashierPolicyRoles || []).join(', '));

        ok('v2.7.0: право cash_expense_self входит в политику расхода «за себя»',
            missingRoles(expenseRoles, selfPolicyRoles || []).length === 0,
            missingRoles(expenseRoles, selfPolicyRoles || []).join(', ') || 'все на месте');

        ok('v2.7.0: право cash_return_self входит в политику возврата (у Финансиста только return)',
            /rsk_current_employee_role\(\) = 'Финансист'/.test(selfBlock) &&
            missingRoles(returnRoles, returnAllowed).length === 0,
            missingRoles(returnRoles, returnAllowed).join(', ') || 'все на месте');

        ok('v2.7.0: закрытие заявки с оплатой из подотчёта (process_order) разрешено политикой',
            missingRoles(processRoles, selfPolicyRoles || []).length === 0,
            missingRoles(processRoles, selfPolicyRoles || []).join(', ') || 'все на месте');

        ok('v2.7.0: расход из закрытой заявки (source = \'order\') разрешён политикой',
            /source in \('manual', 'order'\)/.test(selfBlock));
    }

    // --- 3з. Миграция v2.8.0: транзакционные RPC, закрытый INSERT, audit_log ---
    // Повод: заявка и её позиции писались из браузера несколькими запросами —
    // сбой между ними оставлял заявку без позиций, а номер («№ N/YY») считался в
    // браузере и повторялся у двух одновременных заявок. Файл переносит запись в
    // SECURITY DEFINER команды, закрывает прямой INSERT в orders/cash_requests и
    // пишет журнал audit_log с ключом идемпотентности.
    const RPC_MIGRATION = path.join(ROOT, 'database', 'migrate-v2.8-finance-rpc-audit.sql');

    if (!fs.existsSync(RPC_MIGRATION)) {
        ok('есть файл database/migrate-v2.8-finance-rpc-audit.sql', false, RPC_MIGRATION);
    } else {
        const v28 = fs.readFileSync(RPC_MIGRATION, 'utf8');
        const v27Text = fs.existsSync(RLS_MIGRATION) ? fs.readFileSync(RLS_MIGRATION, 'utf8') : '';
        const databaseJs = fs.readFileSync(path.join(ROOT, 'js', 'database.js'), 'utf8');

        // Исходники приложения одним текстом: по ним видно, что прямых insert в
        // закрытые таблицы больше нигде нет.
        const appCode = ['js', path.join('js', 'modules')]
            .flatMap((dir) => fs.readdirSync(path.join(ROOT, dir))
                .filter((file) => file.endsWith('.js'))
                .map((file) => fs.readFileSync(path.join(ROOT, dir, file), 'utf8')))
            .join('\n');

        // Боевой список команд — из кода (js/database.js → RPC), а не из SQL:
        // именно код зовёт команды по имени.
        const rpcBlock = databaseJs.match(/export const RPC = \{([\s\S]*?)\};/);
        const rpcNames = rpcBlock
            ? [...rpcBlock[1].matchAll(/:\s*'([a-z_0-9]+)'/g)].map((match) => match[1])
            : [];
        ok('v2.8.0: команды RPC перечислены в коде в одном месте (js/database.js → RPC)',
            rpcNames.length === 4, rpcNames.join(', ') || 'RPC не найден');

        const rpcMissing = rpcNames.filter((name) =>
            !new RegExp('create or replace function public\\.' + name + '\\s*\\(').test(v28));
        ok('v2.8.0: каждая команда из кода объявлена в файле миграции (иначе PGRST202 «функция не найдена»)',
            rpcNames.length === 4 && rpcMissing.length === 0,
            rpcMissing.join(', ') || 'все на месте');

        const rpcPriv = rpcNames.filter((name) =>
            !(new RegExp('revoke all on function public\\.' + name + '\\b').test(v28) &&
              new RegExp('grant execute on function public\\.' + name +
                  '\\b[\\s\\S]{0,160}?to authenticated').test(v28)));
        ok('v2.8.0: у каждой команды revoke from public и grant execute только authenticated',
            rpcNames.length === 4 && rpcPriv.length === 0,
            rpcPriv.join(', ') || 'все на месте');

        ok('v2.8.0: роли anon команды недоступны (execute не выдаётся)',
            !/grant execute on function[\s\S]{0,160}?to (anon|public)\b/i.test(v28));

        ok('v2.8.0: прямой INSERT в orders и cash_requests закрыт (revoke insert)',
            /revoke insert on table public\.cash_requests from authenticated/.test(v28) &&
            /revoke insert on table public\.orders\b[^;]*from anon, authenticated/.test(v28));

        // Обратная проверка: запись операций в cash_operations НЕ закрывается.
        // Расход, возврат и пополнение подотчёта финансиста клиент пишет прямой
        // вставкой (js/modules/cash.js → createOperation, заявка на материалы с
        // оплатой из подотчёта — js/modules/orders.js), а разрешает их RLS v2.7.0.
        // Если однажды «усилить» и эту таблицу, расходы перестанут сохраняться.
        const cashOpsPolicies = ['rsk_cash_operations_insert_self', 'rsk_cash_operations_insert_cashier']
            .filter((policy) => new RegExp('create policy\\s+' + policy + '\\b').test(v27Text));
        ok('v2.8.0: cash_operations пишется напрямую — политики v2.7.0 на месте, revoke insert нет',
            cashOpsPolicies.length === 2 &&
            !/revoke\s+(all|insert)\s+on\s+table\s+public\.cash_operations\b/i.test(v28) &&
            /insert\('cash_operations'/.test(appCode),
            cashOpsPolicies.join(', ') || 'в v2.7.0 нет политик вставки в cash_operations');

        // Временные политики прямой записи из v2.7.0 снимаются здесь и не
        // создаются заново: выдача идёт через issue_cash_request, своя доставка —
        // через save_own_delivery_expense.
        // Только финансы: у audit_log своя политика чтения, файл создаёт её заново,
        // временной она не является.
        const tempPolicies = [...v28.matchAll(
            /drop policy if exists\s+([a-z_0-9]+)\s+on public\.(cash_requests|cash_operations)\b/gi)]
            .map((match) => ({ name: match[1], table: match[2] }));
        const recreated = tempPolicies.filter((policy) =>
            new RegExp('create policy\\s+' + policy.name + '\\b', 'i').test(v28));
        const unknownPolicies = tempPolicies.filter((policy) =>
            !new RegExp('create policy\\s+' + policy.name + '\\b', 'i').test(v27Text));
        ok('v2.8.0: снимает временные политики v2.7.0 и не создаёт их заново',
            tempPolicies.length >= 5 && recreated.length === 0 && unknownPolicies.length === 0,
            recreated.concat(unknownPolicies).map((policy) => policy.name).join(', ') ||
                'снято политик: ' + tempPolicies.length);

        ok('v2.8.0: журнал audit_log для клиента только на чтение',
            /create table if not exists public\.audit_log/.test(v28) &&
            /revoke all on table public\.audit_log from public, anon, authenticated/.test(v28) &&
            /grant select on table public\.audit_log to authenticated/.test(v28) &&
            /alter table public\.audit_log enable row level security/.test(v28) &&
            /alter table public\.audit_log force row level security/.test(v28));

        ok('v2.8.0: повтор команды не создаёт вторую заявку (уникальный ключ идемпотентности)',
            /create unique index if not exists audit_log_command_once/.test(v28) &&
            /on public\.audit_log \(actor_user_id, action, idempotency_key\)/.test(v28) &&
            /p_idempotency_key uuid/.test(v28));

        const auditCalls = (v28.match(/perform public\.rsk_write_audit\(/g) || []).length;
        ok('v2.8.0: каждая команда оставляет отметку в журнале (perform rsk_write_audit)',
            auditCalls >= rpcNames.length,
            'вызовов: ' + auditCalls + ', команд: ' + rpcNames.length);

        ok('v2.8.0: одна своя доставка на заявку (уникальный индекс + отказ на исторических дублях)',
            /create unique index if not exists cash_operations_one_own_delivery_per_order/.test(v28) &&
            /Найдены дубли own_delivery/.test(v28));

        ok('v2.8.0: без применённой v2.7.0 файл останавливается с подсказкой (P0001)',
            /to_regprocedure\('public\.rsk_current_employee_id\(\)'\)/.test(v28) &&
            /Сначала примените database\/migrate-v2\.7-rls-finance\.sql/.test(v28));

        ok('v2.8.0: самопроверка перечисляет все команды (exists / authenticated / anon)',
            /has_function_privilege\('authenticated'/.test(v28) &&
            /has_function_privilege\('anon'/.test(v28) &&
            rpcNames.every((name) => new RegExp("\\('" + name + "'").test(v28)));

        ok('v2.8.0: команды зовут через db.rpc, а не прямой записью в orders/cash_requests',
            !/db\.insert\(\s*['"](orders|cash_requests)['"]/.test(appCode) &&
            (appCode.match(/db\.rpc\(/g) || []).length >= rpcNames.length,
            'вызовов db.rpc: ' + (appCode.match(/db\.rpc\(/g) || []).length);

        ok('v2.8.0: каждая команда получает ключ идемпотентности (db.newCommandKey())',
            (appCode.match(/newCommandKey\(\)/g) || []).length >= rpcNames.length,
            'ключей: ' + (appCode.match(/newCommandKey\(\)/g) || []).length);

        const v28Copy = copyIssues(v28);
        ok('migrate-v2.8-finance-rpc-audit.sql чистый для копирования (кавычки, пробелы, скобки, $$)',
            v28Copy.clean, v28Copy.detail);
    }

    // --- 3и. Миграция v2.9.0: индексы под страницы и фильтры на сервере ---
    // Повод: список заявок грузил ВСЮ таблицу и фильтровал её в браузере. С
    // v2.9.0 списки читаются страницами с фильтрами в запросе
    // (js/database.js → selectPage), поэтому у каждой колонки, по которой код
    // фильтрует и сортирует, должен быть индекс — иначе «страница на 25 строк»
    // читает весь объект. Здесь же проверяется связка «код ↔ индекс»: новая
    // колонка в фильтре без индекса валит прогон.
    const SCALE_MIGRATION = path.join(ROOT, 'database', 'migrate-v2.9-scale-indexes.sql');
    const ordersJs = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'orders.js'), 'utf8');
    const paginationExists = fs.existsSync(path.join(ROOT, 'js', 'pagination.js'));
    const swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const configJs = fs.readFileSync(path.join(ROOT, 'js', 'config.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    if (!fs.existsSync(SCALE_MIGRATION)) {
        ok('есть файл database/migrate-v2.9-scale-indexes.sql', false, SCALE_MIGRATION);
    } else {
        const v29 = fs.readFileSync(SCALE_MIGRATION, 'utf8');

        // 1. Файл ничего не ломает: только индексы и статистика планировщика.
        //    Ни данных, ни таблиц, ни политик, ни прав.
        const dangerous = ['drop ', 'alter ', 'insert ', 'update ', 'delete ', 'revoke ', 'grant ',
            'create table', 'create policy', 'truncate']
            .filter((word) => new RegExp('^\\s*' + word, 'im').test(v29));
        ok('v2.9.0: файл только ставит индексы и статистику (данные и права не трогает)',
            dangerous.length === 0, dangerous.join(', '));

        // 2. Все индексы создаются с if not exists: повторный запуск безопасен
        //    (файл копируют в SQL Editor целиком и иногда дважды).
        const creates = (v29.match(/create index\s+/gi) || []).length;
        const idempotent = (v29.match(/create index if not exists\s+/gi) || []).length;
        ok('v2.9.0: каждый индекс создаётся с if not exists (повтор безопасен)',
            creates > 0 && creates === idempotent, 'всего: ' + creates + ', идемпотентных: ' + idempotent);

        // 3. Список индексов из определений и из самопроверки — один и тот же:
        //    индекс, забытый в самопроверке, выглядит как MISSING у администратора.
        const indexDefs = [...v29.matchAll(
            /create index if not exists\s+([a-z_0-9]+)\s+on public\.([a-z_]+)\s*\(([^)]*)\)([^;]*);/gi)]
            .map((m) => ({
                name: m[1],
                table: m[2],
                columns: [
                    ...m[3].split(',').map((column) => column.trim().replace(/\s+(asc|desc)$/i, '')),
                    // Колонки из WHERE частичного индекса тоже покрыты: Postgres
                    // берёт такой индекс, когда условие запроса совпадает с его
                    // предикатом (orders_debt_created_idx покрывает и
                    // payment_status, и payment_source).
                    ...[...m[4].matchAll(/([a-z_0-9]+)\s*=\s*'/gi)].map((x) => x[1])
                ]
            }));
        const selfCheckBlock = v29.slice(v29.indexOf('БЛОК 8. САМОПРОВЕРКА'));
        const missingInSelfCheck = indexDefs.filter((ix) => !selfCheckBlock.includes("('" + ix.name + "')"));
        ok('v2.9.0: самопроверка перечисляет все индексы файла (иначе администратор видит MISSING)',
            indexDefs.length >= 20 && missingInSelfCheck.length === 0,
            missingInSelfCheck.map((ix) => ix.name).join(', ') || 'индексов: ' + indexDefs.length);

        // 4. СВЯЗКА «КОД ↔ ИНДЕКС». Колонки, по которым списки фильтруют и
        //    сортируют на сервере. Список ведётся руками рядом с кодом:
        //    добавили фильтр — добавьте строку здесь и индекс в миграцию,
        //    иначе прогон скажет, что индекс пропущен.
        const pagedColumns = [
            ['orders', 'status'],
            ['orders', 'created_at'],
            ['orders', 'created_by_employee_id'],
            ['orders', 'project_id'],
            ['orders', 'section_id'],
            ['orders', 'payer_employee_id'],
            ['orders', 'payment_status'],
            ['orders', 'paid_at'],
            ['order_items', 'order_id'],
            ['cash_requests', 'employee_id'],
            ['cash_requests', 'status'],
            ['cash_requests', 'project_id'],
            ['cash_request_items', 'request_id'],
            ['cash_operations', 'employee_id'],
            ['cash_operations', 'operation_type'],
            ['cash_operations', 'operation_date'],
            ['cash_operations', 'project_id'],
            ['cash_operations', 'section_id'],
            ['cash_operations', 'order_id'],
            ['tasks', 'assignee_employee_id'],
            ['tasks', 'project_id'],
            ['tasks', 'deadline'],
            ['tasks', 'section_id'],
            ['sections', 'project_id'],
            ['sections', 'planned_start_date'],
            ['project_files', 'project_id'],
            ['projects', 'foreman_id'],
            ['employees', 'user_id'],
            ['employees', 'position'],
            ['employees', 'name']
        ];
        const uncovered = pagedColumns.filter(([table, column]) =>
            !indexDefs.some((ix) => ix.table === table && ix.columns.includes(column)));
        ok('v2.9.0: у каждой колонки фильтра/сортировки списков есть индекс',
            uncovered.length === 0,
            uncovered.map(([table, column]) => table + '.' + column).join(', ') ||
                'проверено колонок: ' + pagedColumns.length);

        // 5. Список заявок действительно читается страницей, а не всей таблицей:
        //    ровно эту деградацию миграция и лечит. Вернётся «вся таблица +
        //    фильтр в браузере» — индексы уже не помогут.
        const loadOrdersBody = (ordersJs.match(/export async function loadOrders\(\)[\s\S]*?\n}/) || [''])[0];
        ok('v2.9.0: список заявок читается страницей (db.selectPage), а не всей таблицей',
            /db\.selectPage\('orders'/.test(loadOrdersBody) &&
            !/db\.select\('orders'/.test(loadOrdersBody) &&
            /pageSize: ordersPageSize/.test(loadOrdersBody));

        // 6. Фильтры списка уходят на сервер: вкладка статуса (в том числе
        //    «активные» = два статуса), видимость прораба и поиск. Фильтра
        //    в браузере (ordersCache.filter(canSeeOrder)) быть не должно.
        ok('v2.9.0: вкладки, права прораба и поиск стали условиями запроса, а не фильтром в браузере',
            /'status\.in': \['new', 'in_progress'\]/.test(ordersJs) &&
            /filters\.created_by_employee_id = emp\.id/.test(ordersJs) &&
            /db\.textSearch\(/.test(ordersJs) &&
            !/filter\(canSeeOrder\)/.test(ordersJs));

        // 6б. Условие поиска собирается БЕЗ своих скобок: скобки добавляет
        //     supabase-js. Со своими в запрос уходило or=((...)), PostgREST
        //     отвечал PGRST100 — и поиск молча ничего не находил (эту ошибку
        //     поймал прогон scale-check.mjs при разработке v2.9.0).
        const databaseJs29 = fs.readFileSync(path.join(ROOT, 'js', 'database.js'), 'utf8');
        ok('v2.9.0: условие поиска собирается без лишних скобок (иначе or=((...)) и PGRST100)',
            /return \{ or: parts\.join\(','\) \};/.test(databaseJs29));

        // 7. Панель списка есть, она в кэше оболочки и у неё есть место в
        //    разметке — иначе поиск и страницы просто некуда рисовать.
        ok('v2.9.0: панель списка существует, подключена к оболочке и к разметке',
            paginationExists &&
            /'\.\/js\/pagination\.js'/.test(swJs) &&
            /id="orders-toolbar"/.test(indexHtml));

        // 8. Версия приложения одна в config.js и sw.js: с v2.9.0 меняется имя
        //    кэша оболочки, и расхождение версий оставило бы сотрудников на
        //    старых js — то есть на списке без страниц.
        const configVersion = (configJs.match(/VERSION:\s*'([0-9.]+)'/) || [])[1];
        const swVersion = (swJs.match(/const APP_VERSION = '([0-9.]+)'/) || [])[1];
        ok('v2.9.0: версия приложения совпадает в js/config.js и sw.js',
            configVersion === '2.9.0' && swVersion === configVersion,
            'config: ' + configVersion + ', sw: ' + swVersion);

        const v29Copy = copyIssues(v29);
        ok('migrate-v2.9-scale-indexes.sql чистый для копирования (кавычки, пробелы, скобки, $$)',
            v29Copy.clean, v29Copy.detail);
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
        ? '  ВСЁ ВЕРНО: миграции v2.4.0 … v2.9.0 и schema.sql согласованы, SQL защищён от обрыва наполовину'
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

