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

    return {
        exists: false,
        known: MISSING_COLUMN_ERROR.test(`${code} ${message}`),
        info: `${response.status} ${code} ${message}`.trim()
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
function finish(code) {
    log('');
    log('--- ИТОГ ---');
    log(code === 0
        ? '  ВСЁ ВЕРНО: база обновлена — колонки v2.4.0 и v2.5.0 на месте'
        : '  не прошло проверок: ' + failed);

    const outDir = path.join(os.tmpdir(), 'rsk-fin');
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

    for (const group of REQUIRED) {
        log('');
        log(`── v${group.version} — ${group.why} (${group.file}) ──`);
        let present = 0;

        for (const [table, column] of group.pairs) {
            let answer;
            try {
                answer = await askColumn(conn, table, column);
            } catch (error) {
                ok(`${table}.${column}`, false, 'запрос к базе не прошёл: ' + error.message);
                continue;
            }

            if (answer.exists) present += 1;
            else missing.push({ group, table, column });

            ok(`${table}.${column}`, answer.exists,
                answer.exists
                    ? ''
                    : (answer.known
                        ? `колонки нет — примените ${group.file}`
                        : `неожиданный ответ базы: ${answer.info}`));
        }

        const partial = present > 0 && present < group.pairs.length;
        log(`  колонок v${group.version} на месте: ${present} из ${group.pairs.length}` +
            (partial
                ? ' — миграция применилась НАПОЛОВИНУ: запустите файл ещё раз целиком'
                : (present === 0 ? ' — миграция не применена' : '')));
    }

    if (missing.length) instructions(conn, missing);

    finish(missing.length ? 1 : 0);
}

await main();
