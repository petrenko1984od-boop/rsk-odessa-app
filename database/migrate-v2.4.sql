-- =====================================================================
-- RSK ODESSA — МИГРАЦИЯ v2.4.0
-- =====================================================================
-- Что добавляет эта версия:
--   1. счёт поставщика по заявке на материалы + его оплату (безнал фирмы);
--   2. статус заявки «Доставлено на объект» (status = 'delivered').
-- Ведомость пополнений подотчёта финансиста миграции НЕ требует: колонка
-- cash_operations.source есть в базе с прежних версий, а новое значение
-- 'financier_topup' пишет само приложение.
--
-- Выполнять в Supabase → SQL Editor → New query: вставить файл целиком → Run.
-- SQL Editor останавливает скрипт на ПЕРВОЙ ошибке, поэтому здесь каждая
-- команда защищена (см. БЛОК 1) и в конце идёт самопроверка — применить
-- миграцию «наполовину» больше нельзя: что не получилось, будет видно.
-- Повторный запуск безопасен.
-- Перед запуском сделайте бэкап (Supabase → Database → Backups).
-- Как применять и как проверить, что получилось — database/README.md.
--
-- ⚠️ Пока миграция не применена, приложение не сохранит счёт, доставку и
--    оплату заявки: в таблице orders нет нужных колонок, и PostgREST ответит
--    «column orders.payment_status does not exist» (42703) или
--    «Could not find the 'payment_status' column of 'orders' in the schema
--    cache» (PGRST204).
-- =====================================================================


-- ---------------------------------------------------------------------
-- БЛОК 1. Счёт поставщика и оплата заявки (таблица orders)
-- ---------------------------------------------------------------------
-- payment_status:
--   'paid' — оплачено (значение по умолчанию: так вели себя все прежние
--            заявки, поэтому уже созданные строки не попадут в очередь
--            финансиста);
--   'debt' — «Ожидает оплаты» (счёт загружен, деньги ещё не ушли).
-- invoice_path — файл счёта в бакете Storage (js/config.js →
--                CONFIG.STORAGE.INVOICES_BUCKET, по умолчанию 'receipts').
-- ---------------------------------------------------------------------
-- Каждая колонка добавляется своим блоком с обработкой ошибки.
-- Почему не восемь команд подряд: SQL Editor ОСТАНАВЛИВАЕТ скрипт на первой
-- же ошибке. На боевой базе так и получилось — четыре команды прошли, четыре
-- нет, и раздел «Снабжение» сломался наполовину. Здесь скрипт всегда доходит
-- до конца, а неудачу печатает в «Notices» с точной причиной.
do $$
declare
    definition text;
begin
    foreach definition in array array[
        'invoice_path text',
        'invoice_file_name text',
        'invoice_uploaded_at timestamptz',
        'invoice_total numeric',
        'payment_status text',
        'delivered_at timestamptz',
        'paid_at timestamptz',
        'paid_by_employee_id bigint references employees(id)'
    ]
    loop
        begin
            execute format('alter table orders add column if not exists %s', definition);
            raise notice 'ok: orders.%', split_part(definition, ' ', 1);
        exception when others then
            raise warning 'НЕ ДОБАВЛЕНО — orders.%: % (%)',
                split_part(definition, ' ', 1), sqlerrm, sqlstate;
        end;
    end loop;
end $$;


-- ---------------------------------------------------------------------
-- БЛОК 2. Значения по умолчанию и перевод старых заявок
-- ---------------------------------------------------------------------
do $$
begin
    -- Значение по умолчанию: заявка без счёта считается оплаченной — так вели
    -- себя все версии до v2.4.0 (см. database/schema.sql).
    alter table orders alter column payment_status set default 'paid';

    -- Уже созданные заявки тоже считаем оплаченными: иначе они попали бы в
    -- очередь «Счета на материалы» у финансиста, хотя счетов по ним нет.
    update orders set payment_status = 'paid' where payment_status is null;

    raise notice 'ok: payment_status default + backfill';
exception when others then
    raise warning 'payment_status (default/backfill): % (%)', sqlerrm, sqlstate;
end $$;


-- ---------------------------------------------------------------------
-- БЛОК 3. ПРОВЕРКА: чего не хватает в таблице orders
-- ---------------------------------------------------------------------
-- Одна строка на колонку. Всё «ok» — миграция применена полностью.
-- Если есть «MISSING» — откройте вкладку «Notices» этого запуска: там
-- предупреждение с точной ошибкой базы для каждой неудачной колонки.
-- ---------------------------------------------------------------------
select c.name as column_name,
       coalesce(a.atttypid::regtype::text, '—') as data_type,
       case when a.attname is null then 'MISSING — добавить не удалось' else 'ok' end as status
from (values ('delivered_at'), ('invoice_file_name'), ('invoice_path'),
             ('invoice_total'), ('invoice_uploaded_at'), ('paid_at'),
             ('paid_by_employee_id'), ('payment_status')) as c(name)
left join pg_attribute a
       on a.attrelid = 'orders'::regclass
      and a.attname::text = c.name
      and a.attnum > 0
      and not a.attisdropped
order by c.name, 3;

-- PostgREST держит собственную копию схемы. Сразу после добавления колонок
-- просим перечитать её: иначе приложение ещё несколько минут получает
-- «column does not exist», хотя колонка уже есть.
notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
-- БЛОК 4. Статус «Доставлено на объект» (orders.status)
-- ---------------------------------------------------------------------
-- Новое значение статуса: 'delivered' — закупка приехала на объект, позиции
-- уходят в «Реестр материалов», а счёт при этом может быть ещё не оплачен.
-- Миграция колонок НЕ нужна: status — обычный text без CHECK-констрейнта
-- (проверьте себя запросом ниже: строк не должно быть).
-- ---------------------------------------------------------------------
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'orders'::regclass and contype = 'c';
