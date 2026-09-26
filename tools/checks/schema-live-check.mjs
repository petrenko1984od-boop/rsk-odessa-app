// =====================================================================
// Прогон СЕТЕВОЙ (только Node): схема БОЕВОЙ базы — обновлена ли она
// =====================================================================
// Зачем: приложение и база обновляются отдельно — код отдаётся статикой,
// а колонки в Postgres добавляются руками в Supabase → SQL Editor. Если
// обновить только код, снабженец при сохранении счёта получает отказ:
//
//     Не удалось сохранить счёт: База данных не обновлена: в таблице
//     «orders» нет колонки «invoice_price_mode». Примените
//     database/migrate-v2.5.sql (Supabase → SQL Editor)…
//
// Это не баг интерфейса, а не применённая миграция — js/database.js →
// explainError() честно говорит, чего не хватает, но проверить это можно
// только по живой базе. Прогон задаёт базе ТОТ ЖЕ вопрос, что и приложение
// (PostgREST: /rest/v1/<таблица>?select=<колонка>&limit=1), и печатает по
// каждой колонке ok / FAIL, а в конце — какой файл миграции применить.
//
// ⚠️ Прогон НИЧЕГО не пишет в базу: только чтение (select ... limit=1),
//    поэтому запускать его на боевой базе можно в любой момент.
//
// ⚠️ С миграцией v2.7.0 финансовые таблицы закрыты для ключа `anon`
//    (`revoke` + RLS), а ключ в приложении — именно анонимный. Поэтому
//    `cash_operations` отвечает 401 / 42501 («permission denied»): это НЕ
//    «миграция не применена», а доказательство, что защита на месте. Такие
//    колонки прогон помечает как непроверенные (`note`) и не считает их
//    пропажей — колонки RLS-таблиц смотрите запросом в SQL Editor. Заодно
//    прогон отдельно проверяет по живой базе: `cash_requests` и
//    `cash_operations` закрыты для anon (v2.7.0), а таблица журнала
//    `audit_log` существует (v2.8.0) — до её применения PostgREST отвечает
//    404 / PGRST205.
//
// Запуск (из папки tools/checks):  node schema-live-check.mjs
// Адрес и ключ берутся из js/config.js — те же, что у приложения. Другой
// проект можно проверить, не правя файл:
//     $env:SUPABASE_URL='https://<проект>.supabase.co'; $env:SUPABASE_ANON_KEY='sb_publishable_...'; node schema-live-check.mjs
//
// Код возврата 1, если база не обновлена или недоступна — удобно для
// автопроверки перед выкладкой. Ключ в отчёт не попадает: печатается
// только хост.
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const report = [];
const log = (...args) => { const line = args.join(' '); report.push(line); console.log(line); };

let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
};

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

// --- Подключение: как у приложения (js/config.js) ---------------------
// Значение вытаскиваем из текста, а не импортом: config.js при загрузке
// сразу создаёт клиент Supabase и обращается к window (как в vat-check.mjs).
function connection() {
    const cfg = read('js', 'config.js');
    const pick = (name) => (cfg.match(new RegExp(`${name}:\\s*'([^']+)'`)) || [])[1] || '';
    return {
        url: String(process.env.SUPABASE_URL || pick('SUPABASE_URL')).replace(/\/+$/, ''),
        key: process.env.SUPABASE_ANON_KEY || pick('SUPABASE_ANON_KEY'),
        fromConfig: !process.env.SUPABASE_URL
    };
}

// --- Что именно требует код -------------------------------------------
// Список колонок НЕ выдумывается: он читается из самопроверки файлов
// миграции (там же, где администратор видит ok / MISSING после Run).
// Разойдётся миграция и код — прогон это покажет, а не промолчит.
const TABLES = 'orders|order_items|cash_operations';

/** Пары (таблица, колонка) из самопроверки migration-v2.5.sql. */
function pairsV25(sql) {
    return [...sql.matchAll(new RegExp(`\\(\\s*'(${TABLES})'\\s*,\\s*'([a-z_]+)'\\s*\\)`, 'g'))]
        .map((m) => [m[1], m[2]]);
}

/** Колонки из самопроверки migrate-v2.4.sql (все — в таблице orders). */
function columnsV24(sql) {
    const block = sql.slice(sql.indexOf('from (values'), sql.indexOf(') as c(name)'));
    return [...block.matchAll(/\('([a-z_]+)'\)/g)].map((m) => m[1]);
}

const M24 = { version: '2.4.0', file: 'database/migrate-v2.4.sql' };
const M25 = { version: '2.5.0', file: 'database/migrate-v2.5.sql' };

const sql24 = read('database', 'migrate-v2.4.sql');
const sql25 = read('database', 'migrate-v2.5.sql');

const REQUIRED = [
    { ...M24, why: 'счёт поставщика, доставка и оплата заявок', pairs: columnsV24(sql24).map((col) => ['orders', col]) },
    { ...M25, why: 'НДС (ПДВ), режим цены счёта и своя доставка', pairs: pairsV25(sql25) }
];

// --- Вопрос базе ------------------------------------------------------
// Приложение спрашивает так же: выгружает одну колонку с limit=1. Если
// колонки нет, PostgREST отвечает 400 и кодом 42703 («column orders.vat_total
// does not exist») либо PGRST204 («Could not find the 'vat_total' column of
// 'orders' in the schema cache») — обе ошибки разбирает js/database.js →
// explainError(). Строк может не быть вовсе (200 и []) — колонка при этом
// существует, и для нас это главное.
const MISSING_COLUMN_ERROR = /42703|PGRST204/i;
// Таблица закрыта для ключа anon (RLS/revoke, v2.7.0) — это не пропажа колонки.
const PERMISSION_DENIED = /42501|PGRST301|permission denied/i;
// Таблицы нет вовсе (PostgREST её не знает) — так выглядит неприменённый файл.
const MISSING_TABLE = /PGRST205|42P01|could not find the table/i;

async function askColumn(conn, table, column) {
    const url = `${conn.url}/rest/v1/${table}?select=${encodeURIComponent(column)}&limit=1`;
    const response = await fetch(url, {
        headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
    });
    if (response.ok) return { exists: true };

    const text = await response.text();
    let code = '';
    let message = text;
    try {
        const parsed = JSON.parse(text);
        code = parsed.code || '';
        message = parsed.message || text;
    } catch { /* не JSON — покажем ответ как есть */ }

    const info = `${response.status} ${code} ${message}`.trim();

    return {
        exists: false,
        // Колонку нельзя проверить анонимным ключом: таблица закрыта RLS.
        closed: PERMISSION_DENIED.test(`${code} ${message}`),
        known: MISSING_COLUMN_ERROR.test(`${code} ${message}`),
        tableMissing: MISSING_TABLE.test(`${code} ${message}`),
        info
    };
}

/** Таблица вообще есть в базе? (200 — есть и читается, 42501 — есть, но закрыта). */
async function askTable(conn, table) {
    const response = await fetch(`${conn.url}/rest/v1/${table}?select=id&limit=1`, {
        headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
    });
    if (response.ok) return { exists: true, info: '200' };

    const text = await response.text();
    let code = '';
    let message = text;
    try {
        const parsed = JSON.parse(text);
        code = parsed.code || '';
        message = parsed.message || text;
    } catch { /* не JSON — покажем ответ как есть */ }

    const info = `${response.status} ${code} ${message}`.trim();
    const denied = PERMISSION_DENIED.test(`${code} ${message}`);

    return {
        exists: denied,
        denied,
        missing: MISSING_TABLE.test(`${code} ${message}`),
        info
    };
}

const hostOf = (url) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/**
 * Что делать: печатается только когда база реально не обновлена — с файлами
 * в том порядке, в котором их применяют, и с проверкой после.
 */
function instructions(conn, missing) {
    const files = [...new Set(missing.map((item) => item.group.file))];

    log('');
    log('── ЧТО ДЕЛАТЬ ─────────────────────────────────────────');
    log('  База, на которую смотрит приложение: ' + hostOf(conn.url));
    log('  Не хватает колонок — применить файлы миграции:');
    for (const file of files) {
        const list = missing.filter((item) => item.group.file === file);
        log(`    ${file} (v${list[0].group.version}) — ${list.length} шт.: ` +
            list.map((item) => `${item.table}.${item.column}`).join(', '));
    }
    log('  Порядок (если база отстала сразу на две версии):');
    log('    1. Supabase → SQL Editor → New query.');
    log('    2. Открыть файл миграции, скопировать ЦЕЛИКОМ → Run.');
    log('    3. В конце файла идёт самопроверка: строки ok по каждой колонке');
    log('       (вкладка Notices — точная ошибка базы там, где MISSING).');
    log('    4. Обновить приложение в браузере (Ctrl+F5) и повторить действие.');
    log('    5. Повторить этот прогон: все колонки должны стать ok.');
    log('  Подробно с шагами и бэкапом — database/README.md (раздел');
    log('  «Как применить migrate-v2.5.sql») и инструкция Администратора, п. 9.');
    log('');
    log('  Если колонки уже ok, а приложение всё ещё ругается — PostgREST');
    log('  держит копию схемы: файл миграции в конце просит перечитать её');
    log('  (notify pgrst), подождите минуту и обновите приложение (Ctrl+F5).');
}



// --- Прогон -----------------------------------------------------------
function finish(code, unchecked = 0) {
    log('');
    log('--- ИТОГ ---');
    log(code === 0
        ? '  ВСЁ ВЕРНО: база обновлена — колонки v2.4.0 и v2.5.0 на месте'
        : '  не прошло проверок: ' + failed);
    if (unchecked) {
        log('  Ключом anon не проверить колонок: ' + unchecked +
            ' — таблицы закрыты RLS (v2.7.0, это правильно).');
        log('  Их смотрите запросом в SQL Editor (database/README.md → «Как применить'
            + ' migrate-v2.7-rls-finance.sql»).');
    }

    const outDir = path.join(os.tmpdir(), 'freedom-fin');
    try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'schema-live-check.txt'), report.join('\r\n'), 'utf8');
    } catch { /* нет доступа к %TEMP% — отчёт остаётся в консоли */ }

    process.exit(code);
}

async function main() {
    const conn = connection();

    log('Проверка схемы БОЕВОЙ базы (только чтение, запись не выполняется)');
    log('  База: ' + (conn.url ? hostOf(conn.url) : '—') +
        (conn.fromConfig
            ? '  (адрес и ключ — из js/config.js, как у приложения)'
            : '  (адрес и ключ — из SUPABASE_URL / SUPABASE_ANON_KEY)'));
    ok('адрес и ключ подключения найдены', Boolean(conn.url && conn.key));

    if (typeof fetch !== 'function') {
        log('  ⚠ нужен Node.js 18+: в нём есть fetch. Проверка без сети невозможна.');
        failed += 1;
        finish(1);
        return;
    }

    if (!conn.url || !conn.key) {
        log('  ⚠ проверьте CONFIG.SUPABASE_URL и CONFIG.SUPABASE_ANON_KEY в js/config.js');
        finish(1);
        return;
    }

    // Числа, которые администратор видит в SQL Editor после Run: 8 строк ok
    // у v2.4.0 и 12 у v2.5.0. Разойдутся файлы миграции и этот прогон —
    // проверка скажет об этом, а не промолчит.
    const DOCUMENTED = { '2.4.0': 8, '2.5.0': 12 };
    for (const group of REQUIRED) {
        ok(`колонки v${group.version} прочитаны из ${group.file}`,
            group.pairs.length === DOCUMENTED[group.version],
            `колонок в самопроверке: ${group.pairs.length} (ожидается ${DOCUMENTED[group.version]})`);
    }

    // Один пробный запрос: если базы нет (офлайн, VPN, опечатка в адресе),
    // незачем ждать двадцать одинаковых таймаутов.
    try {
        await fetch(`${conn.url}/rest/v1/orders?select=id&limit=1`, {
            headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
            signal: AbortSignal.timeout(15000)
        });
    } catch (error) {
        log('');
        log('  ⚠ база не ответила: ' + error.message);
        log('    Проверьте интернет, VPN/фильтры и адрес (CONFIG.SUPABASE_URL в js/config.js).');
        failed += 1;
        finish(1);
        return;
    }

    const missing = [];
    const skipped = [];

    for (const group of REQUIRED) {
        log('');
        log(`── v${group.version} — ${group.why} (${group.file}) ──`);
        let present = 0;
        let unchecked = 0;

        for (const [table, column] of group.pairs) {
            let answer;
            try {
                answer = await askColumn(conn, table, column);
            } catch (error) {
                ok(`${table}.${column}`, false, 'запрос к базе не прошёл: ' + error.message);
                continue;
            }

            if (answer.exists) {
                present += 1;
                ok(`${table}.${column}`, true);
                continue;
            }

            // Таблица закрыта RLS (v2.7.0 + `revoke` для anon): анонимным ключом
            // колонку не увидеть. Это не «миграция не применена» — колонку
            // смотрят запросом в SQL Editor (см. database/README.md).
            if (answer.closed) {
                unchecked += 1;
                skipped.push({ group, table, column });
                log(`  note ${table}.${column} — таблица закрыта для anon (RLS v2.7.0), ` +
                    `колонку проверяет SQL Editor :: ${answer.info}`);
                continue;
            }

            missing.push({ group, table, column });
            ok(`${table}.${column}`, false,
                answer.known
                    ? `колонки нет — примените ${group.file}`
                    : `неожиданный ответ базы: ${answer.info}`);
        }

        const checked = group.pairs.length - unchecked;
        const partial = present > 0 && present < checked;
        log(`  колонок v${group.version} на месте: ${present} из ${checked}` +
            (unchecked ? ` (ещё ${unchecked} не проверить ключом anon — таблица под RLS)` : '') +
            (partial
                ? ' — миграция применилась НАПОЛОВИНУ: запустите файл ещё раз целиком'
                : (checked > 0 && present === 0 ? ' — миграция не применена' : '')));
    }

    // --- Живая проверка защиты и команд (v2.7.0 / v2.8.0) ---------------
    // Ключ в приложении анонимный, поэтому здесь видно ровно то, что
    // защищает RLS: финансовые таблицы обязаны быть ЗАКРЫТЫ, а журнал команд
    // из v2.8.0 — существовать. До v2.7.0 обе таблицы отвечали 200, то есть
    // любой желающий с ключом из исходников читал чужие заявки и кассу.
    log('');
    log('── Защита финансов и журнал команд (v2.7.0 / v2.8.0) ──');

    for (const table of ['cash_requests', 'cash_operations']) {
        let answer;
        try {
            answer = await askTable(conn, table);
        } catch (error) {
            ok(`${table} — таблица не ответила`, false, error.message);
            continue;
        }

        ok(`v2.7.0: public.${table} закрыта для anon (RLS/revoke применены)`,
            answer.denied,
            answer.denied
                ? answer.info
                : `таблица открыта ключу из исходников (${answer.info}) — примените database/migrate-v2.7-rls-finance.sql`);
    }

    let auditLog;
    try {
        auditLog = await askTable(conn, 'audit_log');
    } catch (error) {
        auditLog = { exists: false, info: 'запрос не прошёл: ' + error.message };
    }

    ok('v2.8.0: журнал public.audit_log создан (иначе PostgREST отвечает 404 / PGRST205)',
        auditLog.exists,
        auditLog.exists
            ? auditLog.info
            : `журнала нет — примените database/migrate-v2.8-finance-rpc-audit.sql :: ${auditLog.info}`);

    if (missing.length) instructions(conn, missing);

    // Код возврата считаем по счётчику проверок, а не по числу колонок: прогон
    // проверяет ещё и защиту (v2.7.0) и журнал команд (v2.8.0) — «FAIL» там
    // тоже обязан вернуть 1, иначе автопроверка перед выкладкой промолчит.
    finish(failed ? 1 : 0, skipped.length);
}

await main();
