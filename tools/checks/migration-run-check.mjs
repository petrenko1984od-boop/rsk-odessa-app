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
//      миграцию целиком не запускают) лечит то же самое сам;
//   8. миграция v2.6.0 (database/migrate-v2.6.sql) — та же история в третий раз,
//      но про заявки на финансы: на cash_requests.status осталось ограничение
//      прежних версий (без 'archived' и без 'revision'), поэтому «📥 В архив» и
//      «✏️ На доработку» падали с «violates check constraint
//      "cash_requests_status_check"» (23514). Проверяется и служебный файл
//      database/fix-cash-requests-status-check.sql (он разрешает только
//      'revision').
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

// --- миграция v2.6.0 (database/migrate-v2.6.sql) -------------------------------
// Третья боевая жалоба того же рода, но про заявки на финансы: автор убирает
// законченную заявку в архив, а карточка не двигается — база отвечает
// «new row for relation "cash_requests" violates check constraint
// "cash_requests_status_check"» (23514). Причина: на cash_requests.status
// осталось ограничение прежних версий — без 'archived' (архив появился в
// v2.6.0) и без 'revision' («На доработке», v2.2.0). Файл колонок НЕ
// добавляет: он снимает устаревшее ограничение и ставит новое со всеми шестью
// статусами приложения (js/modules/cash-requests.js → getCashRequestStatusInfo).
const ARCHIVE = path.join(ROOT, 'database', 'migrate-v2.6.sql');
const CASH_STATUSES = ['pending', 'approved', 'revision', 'rejected', 'issued', 'archived'];

if (fs.existsSync(ARCHIVE)) {
    const archiveSql = fs.readFileSync(ARCHIVE, 'utf8');
    const db4 = new PGlite();
    await db4.exec(`
        create table cash_requests (
            id bigint primary key,
            request_number text not null unique,
            status text not null default 'pending'
        );
        alter table cash_requests add constraint cash_requests_status_check
            check (status in ('pending', 'approved', 'rejected', 'issued'));
        insert into cash_requests (id, request_number, status) values (1, 'Ф-1/26', 'issued');
    `);

    // Самопроверка файла (БЛОК 4) — тот же запрос, который читает администратор.
    const verifyCashSql = archiveSql.slice(
        archiveSql.indexOf('with constraint_def as ('),
        archiveSql.indexOf('order by c.status_value;') + 'order by c.status_value;'.length
    );
    const verifyBefore = (await db4.query(verifyCashSql)).rows;
    const missedBefore = verifyBefore.filter((row) => !String(row.status).startsWith('ok'));

    // Боевые кнопки до миграции: «📥 В архив» и «✏️ На доработку».
    let archiveBefore = null;
    try { await db4.exec("update cash_requests set status = 'archived' where id = 1"); }
    catch (error) { archiveBefore = error; }

    let revisionBefore = null;
    try { await db4.exec("update cash_requests set status = 'revision' where id = 1"); }
    catch (error) { revisionBefore = error; }

    let archiveRun = null;
    try { await db4.exec(archiveSql); }
    catch (error) { archiveRun = error; }

    let archiveAfter = null;
    try { await db4.exec("update cash_requests set status = 'archived' where id = 1"); }
    catch (error) { archiveAfter = error; }

    let revisionAfter = null;
    try { await db4.exec("update cash_requests set status = 'revision' where id = 1"); }
    catch (error) { revisionAfter = error; }

    const verifyAfter = (await db4.query(verifyCashSql)).rows;

    const archiveConstraint = (await db4.query(`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'cash_requests'::regclass and conname = 'cash_requests_status_check'
    `)).rows[0];

    // Повторный запуск безопасен: файл только правит ограничение.
    let archiveRerun = null;
    try { await db4.exec(archiveSql); }
    catch (error) { archiveRerun = error; }

    ok('migrate-v2.6.sql: до миграции архив запрещён (та самая боевая ошибка)',
        archiveBefore !== null && /cash_requests_status_check/.test(archiveBefore.message),
        archiveBefore ? archiveBefore.message : 'запись прошла — тест не воспроизвёл ошибку');
    ok('migrate-v2.6.sql: до миграции доработка тоже запрещена',
        revisionBefore !== null && /cash_requests_status_check/.test(revisionBefore.message),
        revisionBefore ? '' : 'ограничение пропустило revision — тест не воспроизвёл состояние боевой базы');
    ok('migrate-v2.6.sql: выполняется без ошибок', archiveRun === null,
        archiveRun ? archiveRun.message : '');
    ok('migrate-v2.6.sql: после миграции заявка уходит в архив', archiveAfter === null,
        archiveAfter ? archiveAfter.message : '');
    ok('migrate-v2.6.sql: после миграции заявка уходит на доработку', revisionAfter === null,
        revisionAfter ? revisionAfter.message : '');
    ok('migrate-v2.6.sql: ограничение допускает все шесть статусов кода',
        CASH_STATUSES.every((value) => new RegExp("'" + value + "'").test(archiveConstraint?.def || '')),
        String(archiveConstraint?.def || 'ограничения нет'));
    ok('migrate-v2.6.sql: самопроверка до миграции честно печатает MISSING',
        missedBefore.length === 2 &&
            /archived/.test(missedBefore.map((row) => row.status_value).join(',')) &&
            missedBefore.every((row) => /MISSING/.test(String(row.status))),
        missedBefore.map((row) => row.status_value + '=' + row.status).join(', ') || 'ни одного MISSING');
    ok('migrate-v2.6.sql: самопроверка после миграции печатает 6 строк ok',
        verifyAfter.length === 6 && verifyAfter.every((row) => String(row.status).startsWith('ok')),
        verifyAfter.map((row) => row.status_value + '=' + row.status).join(', '));
    ok('migrate-v2.6.sql: повторный запуск безопасен', archiveRerun === null,
        archiveRerun ? archiveRerun.message : '');
    ok('migrate-v2.6.sql: колонок таблицы не трогает (архив — только статус)',
        !/add column/i.test(archiveSql));

    await db4.close();
} else {
    ok('есть файл database/migrate-v2.6.sql', false, ARCHIVE);
}

// --- database/migrate-v2.9-registry-view.sql: ВИД РЕЕСТРА В POSTGRES ---------
// С v2.9.0 раздел «📊 Реестр» читает строки из вида public.registry_rows
// страницами, а итог берёт командой public.registry_totals. Раньше эта логика
// жила в браузере (js/modules/registry.js), и в SQL её легко испортить:
// перепутать свою и поставщикову доставку, посчитать одну сумму дважды
// (строка заявки + расход подотчёта) или забыть security_invoker — тогда вид
// выполнялся бы от имени владельца и ОБОШЁЛ RLS, показав расходы всех объектов.
// Прогон собирает маленькую, но полную картину реестра: заявка фирмы со счётом,
// своя доставка, уже оплаченная из подотчёта, заявка, оплаченная сотрудником,
// прямой расход без позиций и новая заявка (в реестр ей рано).
const REGISTRY_MIGRATION = path.join(ROOT, 'database', 'migrate-v2.9-registry-view.sql');

if (!fs.existsSync(REGISTRY_MIGRATION)) {
    ok('есть файл database/migrate-v2.9-registry-view.sql', false, REGISTRY_MIGRATION);
} else {
    const registrySql = fs.readFileSync(REGISTRY_MIGRATION, 'utf8');
    const db5 = new PGlite();

    // Роли: миграция выдаёт права роли authenticated и отбирает их у anon.
    // В Supabase обе роли уже есть, в пустом Postgres их создаём сами.
    await db5.exec(`
        create role authenticated;
        create role anon;

        create table public.employees (id bigint primary key, name text);
        create table public.projects (id bigint primary key, name text);
        create table public.sections (
            id bigint primary key,
            project_id bigint references public.projects(id),
            name text
        );
        create table public.orders (
            id bigint primary key,
            request_number text not null unique,
            project_id bigint references public.projects(id),
            section_id bigint references public.sections(id),
            status text not null default 'new',
            supplier text,
            payment_source text not null default 'company',
            payment_status text default 'paid',
            created_by_employee_id bigint references public.employees(id),
            closed_at timestamptz,
            delivered_at timestamptz,
            created_at timestamptz not null default now()
        );
        create table public.order_items (
            id bigint primary key,
            order_id bigint not null references public.orders(id),
            name text not null,
            unit text,
            qty numeric not null default 0,
            unit_price numeric not null default 0,
            total_price numeric not null default 0,
            payment_status text,
            vat_amount numeric not null default 0,
            delivery_kind text
        );
        create table public.cash_operations (
            id bigint primary key,
            employee_id bigint references public.employees(id),
            operation_type text not null,
            amount numeric not null default 0,
            description text,
            category text,
            items jsonb not null default '[]'::jsonb,
            project_id bigint references public.projects(id),
            section_id bigint references public.sections(id),
            order_id bigint references public.orders(id),
            source text,
            vat_amount numeric not null default 0,
            operation_date date not null default current_date,
            created_at timestamptz not null default now()
        );
    `);

    await db5.exec(`
        insert into public.employees (id, name) values
            (1, 'Прораб Петренко'), (2, 'Снабженец Ищенко');
        insert into public.projects (id, name) values (1, 'Объект А');
        insert into public.sections (id, project_id, name) values (1, 1, 'Раздел 1');

        insert into public.orders
            (id, request_number, project_id, section_id, status, supplier, payment_source,
             payment_status, created_by_employee_id, delivered_at)
        values
            (1, 'З-1/26', 1, 1, 'delivered', 'ТОВ Будпостач', 'company', 'debt', 1, '2026-02-01T08:00:00Z'),
            (2, 'З-2/26', 1, 1, 'delivered', 'ТОВ Пісок', 'company', 'paid', 1, '2026-02-02T08:00:00Z'),
            (3, 'З-3/26', 1, 1, 'closed', 'ТОВ Цемент', 'employee', 'paid', 1, '2026-02-03T08:00:00Z'),
            (4, 'З-4/26', 1, 1, 'new', null, 'company', 'debt', 1, null);

        insert into public.order_items
            (id, order_id, name, unit, qty, unit_price, total_price, vat_amount, delivery_kind, payment_status)
        values
            (11, 1, 'Кирпич', 'шт', 100, 10, 1000, 166.67, null, 'debt'),
            (12, 1, 'Доставка', 'усл.', 1, 500, 500, 0, 'supplier', 'debt'),
            (13, 2, 'Доставка компании', 'усл.', 1, 900, 900, 0, 'company', 'paid'),
            (14, 3, 'Цемент', 'меш', 10, 200, 2000, 0, null, 'paid'),
            (15, 4, 'Песок', 'т', 1, 100, 100, 0, null, 'debt');

        insert into public.cash_operations
            (id, employee_id, operation_type, amount, description, category, items,
             project_id, section_id, order_id, source, vat_amount, operation_date)
        values
            -- Своя доставка по заявке 2, уже оплаченная из подотчёта: её сумма
            -- должна попасть в реестр РАСХОДОМ, а строка заявки (id 13) исчезнуть.
            (21, 2, 'expense', 900, 'Своя доставка по заявке З-2/26', 'delivery',
                '[{"name": "Доставка компании", "unit": "усл.", "qty": 1, "price": 900, "sum": 900}]'::jsonb,
                1, 1, 2, 'own_delivery', 150, '2026-02-02'),
            -- Заявка, оплаченная сотрудником: деньги живут в расходе с позициями.
            (22, 2, 'expense', 2000, 'Заявка З-3/26 (ТОВ Цемент)', 'materials',
                '[{"name": "Цемент", "unit": "меш", "qty": 10, "price": 200, "sum": 2000}]'::jsonb,
                1, 1, 3, 'order', 0, '2026-02-03'),
            -- Прямой расход без позиций: одна строка по комментарию операции.
            (23, 1, 'expense', 300, 'Прочие расходы (бензин)', 'other', '[]'::jsonb,
                1, 1, null, 'manual', 0, '2026-02-04'),
            -- Выдача подотчёта: в реестре её быть не должно.
            (24, 1, 'issue', 5000, 'Подотчёт', null, '[]'::jsonb,
                1, 1, null, null, 0, '2026-02-05');
    `);

    let registryError = null;
    try { await db5.exec(registrySql); }
    catch (error) { registryError = error; }

    ok('migrate-v2.9-registry-view.sql: выполняется на настоящем Postgres без ошибок',
        registryError === null, registryError ? registryError.message : '');

    const registryRows = (await db5.query(`
        select kind, source_number, name, unit, qty, unit_price, total_sum,
               category, payment, supplier, project_name, employee_name
        from public.registry_rows
        order by entry_at, row_key
    `)).rows;

    const rowOf = (name) => registryRows.find((row) => row.name === name) || null;

    ok('реестр: пять строк — две позиции заявки, расход-своя доставка, расход-заявка и прямой расход',
        registryRows.length === 5,
        registryRows.map((row) => row.kind + ':' + row.name).join(' | '));

    ok('реестр: своя доставка посчитана ОДИН раз (строка заявки уступила расходу подотчёта)',
        registryRows.filter((row) => row.name === 'Доставка компании').length === 1 &&
        rowOf('Доставка компании')?.kind === 'own_delivery' &&
        rowOf('Доставка компании')?.source_number === 'З-2/26',
        JSON.stringify(rowOf('Доставка компании') || {}));

    ok('реестр: позиция доставленной фирмой заявки — материалы с долгом и поставщиком',
        rowOf('Кирпич')?.kind === 'order' &&
        rowOf('Кирпич')?.category === 'materials' &&
        rowOf('Кирпич')?.payment === 'debt' &&
        rowOf('Кирпич')?.supplier === 'ТОВ Будпостач' &&
        Number(rowOf('Кирпич')?.total_sum) === 1000,
        JSON.stringify(rowOf('Кирпич') || {}));

    ok('реестр: доставка поставщика — отдельная категория (фильтр «Категория» её видит)',
        rowOf('Доставка')?.category === 'delivery' &&
        Number(rowOf('Доставка')?.total_sum) === 500 &&
        rowOf('Доставка')?.source_number === 'З-1/26',
        JSON.stringify(rowOf('Доставка') || {}));

    ok('реестр: заявка с оплатой сотрудником показана расходом с номером и поставщиком заявки',
        rowOf('Цемент')?.kind === 'order_employee' &&
        rowOf('Цемент')?.source_number === 'З-3/26' &&
        rowOf('Цемент')?.supplier === 'ТОВ Цемент' &&
        rowOf('Цемент')?.payment === 'paid',
        JSON.stringify(rowOf('Цемент') || {}));

    ok('реестр: прямой расход без позиций — одна строка по комментарию (кол-во 1)',
        rowOf('Прочие расходы (бензин)')?.kind === 'expense' &&
        rowOf('Прочие расходы (бензин)')?.source_number === '💰 Расход' &&
        rowOf('Прочие расходы (бензин)')?.unit === '—' &&
        Number(rowOf('Прочие расходы (бензин)')?.qty) === 1 &&
        Number(rowOf('Прочие расходы (бензин)')?.total_sum) === 300,
        JSON.stringify(rowOf('Прочие расходы (бензин)') || {}));

    ok('реестр: новая заявка (до «Доставлено на объект») и выдача подотчёта в реестр не попали',
        rowOf('Песок') === null && !registryRows.some((row) => row.name === 'Подотчёт'),
        registryRows.map((row) => row.name).join(', '));

    // ---- Итоги считаются по ВСЕМУ набору, а не по странице списка ----------
    const totals = (await db5.query('select * from public.registry_totals()')).rows[0];

    ok('registry_totals: количество и сумма по всем строкам реестра (1000 + 500 + 900 + 2000 + 300)',
        Number(totals?.rows_count) === 5 && Number(totals?.total_sum) === 4700,
        JSON.stringify(totals || {}));

    ok('registry_totals: НДС сложен справочно (166.67 по кирпичу + 150 по своей доставке)',
        Number(totals?.total_vat) === 316.67,
        String(totals?.total_vat));

    const debtTotals = (await db5.query(
        "select * from public.registry_totals(p_payment => 'debt')"
    )).rows[0];

    ok('registry_totals: фильтр «Ожидает оплаты» считает только долг (кирпич + доставка поставщика)',
        Number(debtTotals?.rows_count) === 2 && Number(debtTotals?.total_sum) === 1500,
        JSON.stringify(debtTotals || {}));

    const deliveryTotals = (await db5.query(
        "select * from public.registry_totals(p_project_id => 1, p_category => 'delivery')"
    )).rows[0];

    ok('registry_totals: фильтры «объект + категория» работают как в списке',
        Number(deliveryTotals?.rows_count) === 2 && Number(deliveryTotals?.total_sum) === 1400,
        JSON.stringify(deliveryTotals || {}));

    const periodTotals = (await db5.query(
        "select * from public.registry_totals(p_date_from => '2026-02-03')"
    )).rows[0];

    ok('registry_totals: период считает только строки внутри границ (цемент + прочие расходы)',
        Number(periodTotals?.rows_count) === 2 && Number(periodTotals?.total_sum) === 2300,
        JSON.stringify(periodTotals || {}));

    // ---- Вид не обходит RLS и закрыт от анонимного ключа -------------------
    const viewInfo = (await db5.query(`
        select c.reloptions,
               has_table_privilege('authenticated', 'public.registry_rows', 'SELECT') as can_auth,
               has_table_privilege('anon', 'public.registry_rows', 'SELECT') as can_anon
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'registry_rows'
    `)).rows[0];

    ok('вид реестра: security_invoker = true (права и RLS проверяются у читающего)',
        (viewInfo?.reloptions || []).includes('security_invoker=true'),
        String(viewInfo?.reloptions || 'настройки не заданы'));

    ok('вид реестра: authenticated читает, anon — нет',
        viewInfo?.can_auth === true && viewInfo?.can_anon === false,
        JSON.stringify({ auth: viewInfo?.can_auth, anon: viewInfo?.can_anon }));

    const totalsPrivilege = (await db5.query(`
        select has_function_privilege('authenticated',
                   'public.registry_totals(bigint,bigint,text,text,bigint,date,date)', 'EXECUTE') as can_auth,
               has_function_privilege('anon',
                   'public.registry_totals(bigint,bigint,text,text,bigint,date,date)', 'EXECUTE') as can_anon
    `)).rows[0];

    ok('registry_totals: команда доступна authenticated и недоступна anon',
        totalsPrivilege?.can_auth === true && totalsPrivilege?.can_anon === false,
        JSON.stringify(totalsPrivilege || {}));

    // ---- Повторный запуск безопасен (вид пересоздаётся, права возвращаются) --
    let registryRerun = null;
    try { await db5.exec(registrySql); }
    catch (error) { registryRerun = error; }

    const rowsAfterRerun = (await db5.query('select count(*)::int as n from public.registry_rows')).rows[0];
    const viewInfoRerun = (await db5.query(`
        select c.reloptions,
               has_table_privilege('authenticated', 'public.registry_rows', 'SELECT') as can_auth
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'registry_rows'
    `)).rows[0];

    ok('migrate-v2.9-registry-view.sql: повторный запуск безопасен (строки и права на месте)',
        registryRerun === null && Number(rowsAfterRerun?.n) === 5 &&
        viewInfoRerun?.can_auth === true &&
        (viewInfoRerun?.reloptions || []).includes('security_invoker=true'),
        registryRerun ? registryRerun.message : String(rowsAfterRerun?.n));

    // Анонимный ключ не должен даже видеть структуру: SELECT отозван.
    let anonRead = null;
    try {
        await db5.exec('set role anon');
        await db5.query('select count(*) from public.registry_rows');
    } catch (error) {
        anonRead = error;
    } finally {
        try { await db5.exec('reset role'); } catch { /* роль могла не переключиться */ }
    }

    ok('вид реестра: под ролью anon чтение отклонено базой',
        anonRead !== null && /permission denied/i.test(String(anonRead.message)),
        anonRead ? anonRead.message : 'запрос прошёл — анонимный ключ увидел реестр');

    await db5.close();
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
