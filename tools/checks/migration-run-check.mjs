// =====================================================================
// Прогон миграции в НАСТОЯЩЕМ Postgres (PGlite: Postgres в WASM, в памяти)
// =====================================================================
// Запускает database/migrate-v2.4.sql на копии боевого состояния «миграция
// применилась наполовину» и проверяет:
//   1. не хватающих колонок было 4 — стало 8;
//   2. payment_status получил default 'paid', старые заявки переведены в 'paid';
//   3. самопроверка из файла печатает 8 строк ok;
//   4. повторный запуск безопасен;
//   5. если alter table падает (в тесте orders — это ВИД, а не таблица), скрипт
//      всё равно доходит до конца и самопроверка печатает MISSING;
//   6. СТАРОЕ CHECK-ограничение orders_status_check (боевая база: список без
//      'delivered') снимается, и заявку снова можно закрыть. Без этой правки
//      приложение отвечало «new row for relation "orders" violates check
//      constraint "orders_status_check"» — «заявка не закрывается»;
//   7. короткий файл database/fix-orders-status-check.sql (для случаев, когда
//      миграцию целиком не запускают) лечит то же самое сам.
//
// Пакет нужен только для этого прогона:
//     npm install @electric-sql/pglite
// Запуск (из папки tools/checks):  node migration-run-check.mjs
// Пакета нет — прогон просто пропускается (остальные проверки не зависят от него).
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MIGRATION = path.join(ROOT, 'database', 'migrate-v2.4.sql');

const report = [];
const log = (...args) => { const line = args.join(' '); report.push(line); console.log(line); };

let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
};

let PGlite = null;
try {
    ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
    log('PGlite не установлен — прогон миграции в Postgres пропущен.');
    log('Установить: npm install @electric-sql/pglite (в этой папке или выше)');
    process.exit(0);
}

const sql = fs.readFileSync(MIGRATION, 'utf8');
const db = new PGlite();

// --- состояние боевой базы: таблица orders без четырёх последних колонок ---
await db.exec(`
    create table employees (id bigint primary key, name text);
    insert into employees (id, name) values (1, 'Тест Финансист');
    create table orders (
        id bigint primary key,
        status text not null default 'new',
        supplier text,
        total_sum numeric not null default 0,
        created_at timestamptz default now()
    );
    alter table orders add column if not exists invoice_path text;
    alter table orders add column if not exists invoice_file_name text;
    alter table orders add column if not exists invoice_uploaded_at timestamptz;
    alter table orders add column if not exists invoice_total numeric;
    -- Именно это ограничение стоит на боевой базе: список статусов старее
    -- приложения — 'delivered' в нём нет, поэтому закрытие закупки падало.
    alter table orders add constraint orders_status_check
        check (status in ('new', 'in_progress', 'closed', 'archived'));
    insert into orders (id, status) values (1, 'in_progress');
`);

const columnsPresent = async () => (await db.query(`
    select count(*)::int as n from information_schema.columns
    where table_name = 'orders' and column_name in (
        'invoice_path', 'invoice_file_name', 'invoice_uploaded_at', 'invoice_total',
        'payment_status', 'delivered_at', 'paid_at', 'paid_by_employee_id')
`)).rows[0].n;

const verifySql = sql.slice(
    sql.indexOf('select c.name as column_name'),
    sql.indexOf('order by c.name, 3;') + 'order by c.name, 3;'.length
);

// Запрос-проверка из БЛОК 4в: не осталось ли ограничение, запрещающее 'delivered'.
const deliveredVerifySql = sql.slice(
    sql.indexOf('select coalesce(conname'),
    sql.indexOf(') as k on true;') + ') as k on true;'.length
);

log('Миграция в Postgres (PGlite): ' + path.relative(ROOT, MIGRATION));
ok('до миграции колонок 4 из 8 (состояние боевой базы)', await columnsPresent() === 4);

// Боевая жалоба «заявка не закрывается»: старое ограничение не пропускает
// status = 'delivered'. Проверяем, что тест воспроизводит именно это.
let deliveredBefore = null;
try {
    await db.exec("update orders set status = 'delivered' where id = 1");
} catch (error) {
    deliveredBefore = error;
}
ok('до миграции закрыть заявку нельзя (delivered запрещён ограничением)',
    deliveredBefore !== null && /orders_status_check/.test(deliveredBefore.message),
    deliveredBefore ? deliveredBefore.message : 'запись прошла — тест не воспроизвёл боевую ошибку');

// Ошибку самого запуска тоже превращаем в строку отчёта, а не в падение прогона
let firstRunError = null;
try {
    await db.exec(sql);
} catch (error) {
    firstRunError = error;
}
ok('миграция выполняется без ошибок', firstRunError === null,
    firstRunError ? firstRunError.message : '');

ok('после миграции все 8 колонок', await columnsPresent() === 8);

// Боевая жалоба «заявка не закрывается» — лечится: ограничение снято и
// поставлено заново со статусом 'delivered'.
let deliveredAfter = null;
try {
    await db.exec("update orders set status = 'delivered' where id = 1");
} catch (error) {
    deliveredAfter = error;
}
ok('после миграции заявка закрывается (status = delivered принимается)',
    deliveredAfter === null, deliveredAfter ? deliveredAfter.message : '');

const constraint = (await db.query(`
    select pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'orders'::regclass and conname = 'orders_status_check'
`)).rows[0];
ok('ограничение orders_status_check допускает delivered',
    /delivered/.test(constraint?.def || ''), String(constraint?.def || 'ограничения нет'));

const deliveredVerify = await db.query(deliveredVerifySql);
ok('проверка из БЛОК 4в: ok (delivered больше не запрещён)',
    deliveredVerify.rows.length > 0 && deliveredVerify.rows.every((row) => row.status === 'ok'),
    deliveredVerify.rows.map((row) => row.constraint_name + '=' + row.status).join(', ').slice(0, 160));

const def = (await db.query(`
    select column_default from information_schema.columns
    where table_name = 'orders' and column_name = 'payment_status'
`)).rows[0].column_default;
ok("payment_status по умолчанию = 'paid'", def === "'paid'::text", String(def));

await db.exec("insert into orders (id, status) values (2, 'new')");
const statuses = (await db.query('select id, payment_status from orders order by id')).rows
    .map((row) => row.id + '=' + row.payment_status).join(', ');
ok('старые и новые заявки не попадут в очередь финансиста',
    statuses === '1=paid, 2=paid', statuses);

const verify = await db.query(verifySql);
ok('самопроверка из файла: 8 строк ok',
    verify.rows.length === 8 && verify.rows.every((row) => row.status === 'ok'),
    verify.rows.map((row) => row.column_name + '=' + row.status).join(', ').slice(0, 160));

await db.exec(sql);
ok('повторный запуск безопасен', await columnsPresent() === 8);

// --- скрипт не обрывается на первой ошибке ---
// orders превращаем в ВИД: теперь ЛЮБОЙ alter table orders падает. Раньше SQL
// Editor останавливал скрипт на первой ошибке — именно так миграция и
// применилась наполовину, а приложение потом «не отправляло счета финансисту».
await db.exec(`
    alter table orders rename to orders_real;
    create view orders as select id, status, supplier, total_sum, created_at from orders_real;
`);

let crashed = null;
try {
    await db.exec(sql);
} catch (error) {
    crashed = error;
}

ok('при сбое alter table скрипт доходит до конца', crashed === null,
    crashed ? crashed.message : '');

const verifyBroken = await db.query(verifySql);
ok('самопроверка сообщает MISSING, а не молчит',
    verifyBroken.rows.length === 8 &&
    verifyBroken.rows.every((row) => String(row.status).startsWith('MISSING')),
    verifyBroken.rows.map((row) => row.column_name + '=' + row.status).join(', ').slice(0, 160));

await db.close();

// --- отдельный файл database/fix-orders-status-check.sql ---------------------
// Для случаев, когда миграцию целиком не запускают: короткий скрипт должен сам
// снять устаревшее ограничение и поставить новое. Проверяем на том же
// состоянии боевой базы (ограничение без 'delivered').
const FIX = path.join(ROOT, 'database', 'fix-orders-status-check.sql');

if (fs.existsSync(FIX)) {
    const db2 = new PGlite();
    await db2.exec(`
        create table orders (
            id bigint primary key,
            status text not null default 'new'
        );
        alter table orders add constraint orders_status_check
            check (status in ('new', 'in_progress', 'closed', 'archived'));
        insert into orders (id, status) values (1, 'in_progress');
    `);

    let fixBefore = null;
    try { await db2.exec("update orders set status = 'delivered' where id = 1"); }
    catch (error) { fixBefore = error; }

    let fixError = null;
    try { await db2.exec(fs.readFileSync(FIX, 'utf8')); }
    catch (error) { fixError = error; }

    let fixAfter = null;
    try { await db2.exec("update orders set status = 'delivered' where id = 1"); }
    catch (error) { fixAfter = error; }

    const fixConstraint = (await db2.query(`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'orders'::regclass and conname = 'orders_status_check'
    `)).rows[0];

    ok('fix-orders-status-check.sql: до правки delivered запрещён',
        fixBefore !== null && /orders_status_check/.test(fixBefore.message),
        fixBefore ? fixBefore.message : 'запись прошла — тест не воспроизвёл ошибку');
    ok('fix-orders-status-check.sql: выполняется без ошибок', fixError === null,
        fixError ? fixError.message : '');
    ok('fix-orders-status-check.sql: после правки заявка закрывается', fixAfter === null,
        fixAfter ? fixAfter.message : '');
    ok('fix-orders-status-check.sql: ограничение допускает delivered',
        /delivered/.test(fixConstraint?.def || ''), String(fixConstraint?.def || 'ограничения нет'));

    await db2.close();
} else {
    ok('есть файл database/fix-orders-status-check.sql', false, FIX);
}

// --- отдельный файл database/fix-cash-requests-status-check.sql ---------------
// Та же боевая жалоба, но про заявки на финансы: «директор отправляет заявку на
// доработку, а она не отправляется». В базе на cash_requests.status осталось
// старое CHECK-ограничение без статуса 'revision'. Короткий файл должен сам
// снять его и поставить новое — со всеми пятью статусами.
const FIX_CASH = path.join(ROOT, 'database', 'fix-cash-requests-status-check.sql');

if (fs.existsSync(FIX_CASH)) {
    const db3 = new PGlite();
    await db3.exec(`
        create table cash_requests (
            id bigint primary key,
            request_number text not null unique,
            status text not null default 'pending'
        );
        alter table cash_requests add constraint cash_requests_status_check
            check (status in ('pending', 'approved', 'rejected', 'issued'));
        insert into cash_requests (id, request_number, status) values (1, 'Ф-1/26', 'pending');
    `);

    let cashBefore = null;
    try { await db3.exec("update cash_requests set status = 'revision' where id = 1"); }
    catch (error) { cashBefore = error; }

    let cashFixError = null;
    try { await db3.exec(fs.readFileSync(FIX_CASH, 'utf8')); }
    catch (error) { cashFixError = error; }

    let cashAfter = null;
    try { await db3.exec("update cash_requests set status = 'revision' where id = 1"); }
    catch (error) { cashAfter = error; }

    const cashConstraint = (await db3.query(`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'cash_requests'::regclass and conname = 'cash_requests_status_check'
    `)).rows[0];

    ok('fix-cash-requests-status-check.sql: до правки revision запрещён',
        cashBefore !== null && /cash_requests_status_check/.test(cashBefore.message),
        cashBefore ? cashBefore.message : 'запись прошла — тест не воспроизвёл ошибку');
    ok('fix-cash-requests-status-check.sql: выполняется без ошибок', cashFixError === null,
        cashFixError ? cashFixError.message : '');
    ok('fix-cash-requests-status-check.sql: после правки заявка уходит на доработку', cashAfter === null,
        cashAfter ? cashAfter.message : '');
    ok('fix-cash-requests-status-check.sql: ограничение допускает revision',
        /revision/.test(cashConstraint?.def || ''), String(cashConstraint?.def || 'ограничения нет'));

    await db3.close();
} else {
    ok('есть файл database/fix-cash-requests-status-check.sql', false, FIX_CASH);
}

log('--- ИТОГ ---');
log(failed === 0
    ? '  ВСЁ ВЕРНО: миграция применяется на настоящем Postgres и защищена от обрыва наполовину'
    : '  не прошло проверок: ' + failed);

const outDir = path.join(os.tmpdir(), 'rsk-fin');
try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'migration-run-check.txt'), report.join('\r\n'), 'utf8');
} catch { /* нет доступа к %TEMP% — отчёт остаётся в консоли */ }

process.exit(failed === 0 ? 0 : 1);
