-- =====================================================================
-- RSK ODESSA — МИГРАЦИЯ v2.4.0
-- =====================================================================
-- Что добавляет эта версия:
--   1. счёт поставщика по заявке на материалы + его оплату (безнал фирмы);
--   2. статус заявки «Доставлено на объект»;
--   3. ведомость пополнений подотчёта финансиста (маркер source).
--
-- Выполнять в Supabase → SQL Editor БЛОКАМИ, сверху вниз.
-- Каждый блок самостоятельный, повторный запуск безопасен.
-- Перед запуском сделайте бэкап (Supabase → Database → Backups).
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
alter table orders add column if not exists invoice_path          text;
alter table orders add column if not exists invoice_file_name     text;
alter table orders add column if not exists invoice_uploaded_at   timestamptz;
alter table orders add column if not exists invoice_total         numeric;
alter table orders add column if not exists payment_status        text default 'paid';
alter table orders add column if not exists delivered_at          timestamptz;
alter table orders add column if not exists paid_at               timestamptz;
alter table orders add column if not exists paid_by_employee_id   bigint references employees(id);

-- Уже созданные заявки считаем оплаченными: иначе они попали бы в очередь
-- «Счета на материалы» у финансиста, хотя счетов по ним нет.
update orders set payment_status = 'paid' where payment_status is null;

-- Кто и что уже оплатил — проверка (необязательный блок).
select status, payment_status, count(*)
from orders
group by status, payment_status
order by status, payment_status;


-- ---------------------------------------------------------------------
-- БЛОК 2. Статус «Доставлено на объект» (orders.status)
-- ---------------------------------------------------------------------
-- Новое значение статуса: 'delivered' — закупка приехала на объект, позиции
-- уходят в «Реестр материалов», а счёт при этом может быть ещё не оплачен.
-- Миграция колонок НЕ нужна: status — обычный text без CHECK-констрейнта
-- (проверьте себя запросом ниже: строк не должно быть).
-- ---------------------------------------------------------------------
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'orders'::regclass and contype = 'c';
