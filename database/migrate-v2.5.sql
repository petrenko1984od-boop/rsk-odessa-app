-- =====================================================================
-- FREEDOM — МИГРАЦИЯ v2.5.0
-- =====================================================================
-- Что добавляет эта версия:
--   1. НДС (ПДВ) по закупке: ставка, сумма налога и признак «цена уже
--      с НДС» — у позиций заявки (order_items), по счёту в целом
--      (orders) и у расхода подотчёта (cash_operations);
--   2. явный признак вида доставки в строке заявки (order_items.
--      delivery_kind: 'supplier' | 'company'): раньше вид читался по имени
--      строки («Доставка» / «Доставка компании»), из-за чего строку
--      нельзя было переименовать без риска развалить учёт;
--   3. «своя доставка» (везёт компания) закрывается расходом подотчёта:
--      при сохранении счёта приложение создаёт cash_operation с
--      source = 'own_delivery', и строка заявки из денег больше не
--      считается — сумма не попадает в итоги дважды. Кто списывает
--      (снабженец / другой сотрудник / фирма) хранится в
--      orders.own_delivery_charge и orders.own_delivery_employee_id.
--
-- Колонки добавляются ЗАЩИЩЁННЫМИ блоками (БЛОК 1-3), затем одним
-- блоком заполняется признак доставки у уже созданных строк (БЛОК 4),
-- в конце — самопроверка (БЛОК 5): печатает статусы ok / MISSING.
-- SQL Editor останавливает скрипт на первой ошибке, поэтому «наполовину
-- применённая» миграция видна сразу по этой таблице.
--
-- Выполнять в Supabase → SQL Editor → New query: вставить файл целиком → Run.
-- Повторный запуск безопасен (везде if not exists / проверки).
-- Перед запуском сделайте бэкап (Supabase → Database → Backups).
-- Как применять и как проверить, что получилось — database/README.md.
--
-- ⚠️ Пока миграция не применена, счёт не сохранится: PostgREST ответит
--    «Could not find the 'vat_rate' column of 'order_items' in the schema
--    cache» (PGRST204) или «column orders.vat_total does not exist»
--    (42703). Приложение показывает это понятным текстом
--    (js/database.js → explainError) и НЕ сохраняет половину молча.
-- =====================================================================


-- ---------------------------------------------------------------------
-- БЛОК 1. НДС и способ оплаты своей доставки (таблица orders)
-- ---------------------------------------------------------------------
-- invoice_price_mode — как снабженец вводил цены в счёте:
--   'with_vat'    — цена конечная, налог ВЫДЕЛЯЕТСЯ из неё
--                   (vat = сумма × ставка / (100 + ставка));
--   'without_vat' — цена без налога, налог ДОБАВЛЯЕТСЯ сверху
--                   (vat = сумма × ставка / 100).
--   По умолчанию 'with_vat': поведение для уже созданных заявок и для
--   поставщиков, кто пишет конечную сумму с налогом, не меняется.
-- invoice_vat_rate         — ставка НДС по позициям счёта, % (0, 7, 20, своя);
-- vat_total                — справочно: НДС по счёту (для бухгалтера);
-- own_delivery_charge      — чем закрывается «своя доставка»:
--   'snagach'  — подотчёт снабженца, который сохраняет счёт (по умолчанию);
--   'employee' — подотчёт другого сотрудника (водитель, транспортный отдел);
--   'firm'     — платит фирма (безнал): расход подотчёта НЕ создаётся,
--                сумма остаётся себестоимостью объекта строкой заявки;
-- own_delivery_employee_id — чей подотчёт списывается при 'employee';
-- own_delivery_vat_rate    — ставка НДС на услугу перевозки (0: своя
--                доставка чаще всего без налога).
-- ---------------------------------------------------------------------
do $$
declare
    definition text;
begin
    foreach definition in array array[
        'invoice_price_mode text not null default ''with_vat''',
        'invoice_vat_rate numeric not null default 0',
        'vat_total numeric not null default 0',
        'own_delivery_charge text',
        'own_delivery_employee_id bigint references employees(id)',
        'own_delivery_vat_rate numeric not null default 0'
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
-- БЛОК 2. НДС и вид доставки в позициях заявки (таблица order_items)
-- ---------------------------------------------------------------------
-- vat_rate       — ставка, применённая к позиции, % (0 = налога нет);
-- vat_amount     — сумма налога внутри total_price (справочно);
-- price_with_vat — как введена цена: true — уже с налогом, false — без;
-- delivery_kind  — 'supplier' (везёт поставщик, сумма в счёте) или
--                  'company' (везёт компания, в счёт поставщика не входит).
--                  У обычных позиций остаётся NULL.
--
-- Инвариант денег (его держит js/modules/orders.js): unit_price и
-- total_price — это сумма К ОПЛАТЕ, то есть с НДС, а vat_amount лишь
-- показывает, сколько налога внутри. Поэтому invoice_total и total_sum
-- по смыслу не меняются, а НДС виден отдельной колонкой в «Реестре
-- материалов» и в выгрузке Excel.
-- ---------------------------------------------------------------------
do $$
declare
    definition text;
begin
    foreach definition in array array[
        'vat_rate numeric not null default 0',
        'vat_amount numeric not null default 0',
        'price_with_vat boolean not null default true',
        'delivery_kind text'
    ]
    loop
        begin
            execute format('alter table order_items add column if not exists %s', definition);
            raise notice 'ok: order_items.%', split_part(definition, ' ', 1);
        exception when others then
            raise warning 'НЕ ДОБАВЛЕНО — order_items.%: % (%)',
                split_part(definition, ' ', 1), sqlerrm, sqlstate;
        end;
    end loop;
end $$;


-- ---------------------------------------------------------------------
-- БЛОК 3. НДС в расходах подотчёта (таблица cash_operations)
-- ---------------------------------------------------------------------
-- Нужно для расходов, которые создаёт само приложение (своя доставка с
-- source = 'own_delivery'), и для ручных расходов по счёту поставщика:
-- «Реестр материалов» показывает налог отдельной колонкой.
-- ---------------------------------------------------------------------
do $$
declare
    definition text;
begin
    foreach definition in array array[
        'vat_rate numeric not null default 0',
        'vat_amount numeric not null default 0'
    ]
    loop
        begin
            execute format('alter table cash_operations add column if not exists %s', definition);
            raise notice 'ok: cash_operations.%', split_part(definition, ' ', 1);
        exception when others then
            raise warning 'НЕ ДОБАВЛЕНО — cash_operations.%: % (%)',
                split_part(definition, ' ', 1), sqlerrm, sqlstate;
        end;
    end loop;
end $$;


-- ---------------------------------------------------------------------
-- БЛОК 4. Признак вида доставки у уже созданных строк заявок
-- ---------------------------------------------------------------------
-- До v2.5.0 вид доставки жил только в имени строки. Заполняем новый
-- признак по имени — чтобы код мог опираться на колонку, а не на текст.
-- Имя при этом не меняется: строки, созданные раньше, продолжают
-- работать и в реестре, и в план-факте.
--
-- ⚠️ Строку «Доставка компании», созданную до v2.5.0, НЕ удаляем и НЕ
--    превращаем в расход: расхода подотчёта для неё в базе нет, значит
--    она, как и раньше, остаётся себестоимостью объекта. Расход появится
--    сам, когда снабженец пересохранит счёт (или впишет доставку заново):
--    только тогда сумма перестанет считаться дважды.
-- ---------------------------------------------------------------------
do $$
declare
    updated int := 0;
begin
    update order_items
       set delivery_kind = 'supplier'
     where delivery_kind is null
       and name = 'Доставка';
    get diagnostics updated = row_count;
    raise notice 'ok: order_items.delivery_kind=supplier у строк "Доставка": %', updated;

    update order_items
       set delivery_kind = 'company'
     where delivery_kind is null
       and name = 'Доставка компании';
    get diagnostics updated = row_count;
    raise notice 'ok: order_items.delivery_kind=company у строк "Доставка компании": %', updated;
exception when others then
    raise warning 'признак доставки НЕ заполнен: % (%) — приложение продолжит работать: вид доставки читается и по имени строки', sqlerrm, sqlstate;
end $$;


-- ---------------------------------------------------------------------
-- БЛОК 5. ПРОВЕРКА: все колонки v2.5.0 на месте?
-- ---------------------------------------------------------------------
-- Ожидается 12 строк со статусом 'ok'. Где 'MISSING' — смотрите Notices
-- и применяйте файл целиком.
-- ---------------------------------------------------------------------
select c.tbl as table_name,
       c.col as column_name,
       case when exists (
                select 1
                  from information_schema.columns ic
                 where ic.table_schema = 'public'
                   and ic.table_name = c.tbl
                   and ic.column_name = c.col
            )
            then 'ok'
            else 'MISSING — примените файл целиком'
       end as status
from (values
    ('orders', 'invoice_price_mode'),
    ('orders', 'invoice_vat_rate'),
    ('orders', 'vat_total'),
    ('orders', 'own_delivery_charge'),
    ('orders', 'own_delivery_employee_id'),
    ('orders', 'own_delivery_vat_rate'),
    ('order_items', 'vat_rate'),
    ('order_items', 'vat_amount'),
    ('order_items', 'price_with_vat'),
    ('order_items', 'delivery_kind'),
    ('cash_operations', 'vat_rate'),
    ('cash_operations', 'vat_amount')
) as c(tbl, col);

-- Схему PostgREST надо перечитать, иначе приложение ещё несколько минут
-- будет получать «Could not find the ... column in the schema cache».
notify pgrst, 'reload schema';
