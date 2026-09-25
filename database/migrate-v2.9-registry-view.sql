-- =====================================================================
-- RSK ODESSA - MIGRATION v2.9.0: «Реестр материалов» как ВИД БАЗЫ
-- =====================================================================
-- Файл: database/migrate-v2.9-registry-view.sql
-- Копируется в Supabase SQL Editor целиком и запускается один раз
-- (повторный запуск безопасен). Предыдущие миграции не нужны, но права на
-- чтение реестра дают политики database/migrate-v2.7-rls-finance.sql.
--
-- ПОВОД. Раздел «📊 Реестр» собирался В БРАУЗЕРЕ из четырёх выгрузок:
--   1) заявки фирмы (status = delivered/closed/archived),
--   2) все их позиции (order_items),
--   3) ВСЕ расходы кассы (cash_operations, operation_type = 'expense'),
--   4) номера заявок для расходов.
-- Дальше фильтры, итог и «Записей: N» считались по загруженному массиву.
-- Значит: на каждое открытие раздела читались все подходящие строки, при
-- 40 000 позиций это десятки мегабайт и заметная пауза; «Итого» учитывало
-- только то, что успело приехать; фильтр в браузере не мог ограничить
-- выгрузку.
--
-- ЧТО ТЕПЕРЬ. Строки реестра формирует БАЗА:
--   * вид public.registry_rows — та же логика, что была в
--     js/modules/registry.js, но одним запросом к базе;
--   * страница списка — db.selectPage('registry_rows', …): PostgREST отдаёт
--     ровно N строк (limit/offset) и общее число строк (count);
--   * фильтры разделa (объект, раздел, категория, оплата, сотрудник, период) —
--     обычные условия запроса к виду;
--   * итог — команда public.registry_totals(…): сумма и количество по ВСЕМУ
--     отфильтрованному набору, а не по одной странице (иначе «Итого» было бы
--     меньше настоящего, а за такие цифры отвечает бухгалтер).
--
-- !!! БЕЗОПАСНОСТЬ. Вид объявлен с security_invoker = true. Без этого он
--     выполнялся бы от имени ВЛАДЕЛЬЦА (postgres) и обходил RLS: любой
--     сотрудник увидел бы расходы всех объектов, хотя политика
--     rsk_cash_operations_select (database/migrate-v2.7-rls-finance.sql)
--     пускает к полному реестру только Администратора, Директора, Главного
--     инженера, Снабженца, Инженера ПТО и Финансиста, а остальным — только
--     собственные операции. С security_invoker права проверяются у того, кто
--     читает вид, поэтому раздел показывает каждому ровно то, что ему можно.
--
-- ЧТО ВАЖНО НЕ СЛОМАТЬ (те же правила, что в js/modules/registry.js):
--   * архивные заявки в реестре ЕСТЬ (архив не удаление);
--   * своя доставка («🚚 Доставка компании») учитывается ОДИН раз: если она
--     уже оплачена из подотчёта (cash_operations.source = 'own_delivery'), то
--     СТРОКА ЗАЯВКИ в реестр не попадает — вместо неё показывается расход;
--   * «🏢 Вне счёта» (payment = 'company') стоит у доставки компании: её
--     суммы в счёте поставщика не было, поэтому «Ожидает оплаты» там врало бы
--     о долге фирмы;
--   * НДС (vat_amount) — справочно: деньги в total_sum уже с налогом.
-- =====================================================================

-- =====================================================================
-- БЛОК 1. ИНДЕКСЫ ПОД ВИД
-- =====================================================================
-- Вид читают страницами и с фильтрами, поэтому нужны индексы. Часть взята из
-- database/migrate-v2.9-scale-indexes.sql (order_items(order_id),
-- cash_operations(operation_date) и другие), здесь только то, чего там нет.

-- Проверка «своя доставка уже оплачена из подотчёта» выполняется для каждой
-- строки заявки: exists (select 1 from cash_operations where source =
-- 'own_delivery' and order_id = <заявка>). Индекс по (source, order_id) делает
-- её поиском по индексу, а не перебором всех расходов.
create index if not exists cash_operations_source_order_idx
    on public.cash_operations (source, order_id);

-- Список заявок реестра: «оплата фирмой» + статус, по которым отбираются
-- заявки. Индекс порядка колонок совпадает с условиями вида.
create index if not exists orders_registry_source_status_idx
    on public.orders (payment_source, status);

analyze public.orders;
analyze public.order_items;
analyze public.cash_operations;

-- =====================================================================
-- БЛОК 2. ДВЕ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ВИДА
-- =====================================================================
-- Логика этих функций повторяет js/utils.js (getDeliveryItemType,
-- normalizeSectionName), потому что строки реестра теперь собирает база.
-- Обе объявлены immutable и с фиксированным search_path (как функции контекста
-- в database/migrate-v2.7-rls-finance.sql): подстановка чужой схемы не должна
-- менять смысл вычисления.

-- Какого вида доставка у позиции: 'supplier' (везёт поставщик, сумма в счёте),
-- 'company' (везёт компания, вне счёта поставщика) или NULL (обычная позиция).
-- Колонка delivery_kind надёжнее имени строки, но у строк, созданных до
-- v2.5.0, её нет — поэтому имя остаётся ключом совместимости. Имена взяты из
-- js/config.js (CONFIG.DELIVERY_ITEM.NAME / COMPANY_NAME) и сверяются прогоном
-- tools/checks/migration-check.mjs: переименовать их «на ходу» нельзя.
create or replace function public.rsk_delivery_kind(p_delivery_kind text, p_name text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
    select case
        when lower(btrim(coalesce(p_delivery_kind, ''))) = 'supplier' then 'supplier'
        when lower(btrim(coalesce(p_delivery_kind, ''))) = 'company'  then 'company'
        when regexp_replace(btrim(lower(coalesce(p_name, ''))), '\s+', ' ', 'g') = 'доставка'
            then 'supplier'
        when regexp_replace(btrim(lower(coalesce(p_name, ''))), '\s+', ' ', 'g') = 'доставка компании'
            then 'company'
        else null
    end;
$$;

-- Число из позиции расхода (cash_operations.items — массив jsonb):
--   [{name, unit, qty, price, sum}]
-- Значение приходит и числом, и строкой (так писали прошлые версии), а
-- испорченная строка не должна ронять весь реестр: не число — вернём 0.
create or replace function public.rsk_json_amount(p_item jsonb, p_key text)
returns numeric
language sql
immutable
set search_path = pg_catalog, public
as $$
    select case
        when p_item is null then 0
        when jsonb_typeof(p_item -> p_key) = 'number' then (p_item ->> p_key)::numeric
        when jsonb_typeof(p_item -> p_key) = 'string'
             and (p_item ->> p_key) ~ '^-?[0-9]+([.][0-9]+)?$'
            then (p_item ->> p_key)::numeric
        else 0
    end;
$$;


-- =====================================================================
-- БЛОК 3. ВИД public.registry_rows
-- =====================================================================
-- Одна строка = одна строка таблицы реестра: позиция заявки или позиция
-- расхода кассы (а у расхода без позиций — сам расход).
--
-- Вид пересоздаётся (drop + create), а не «create or replace»: так список
-- колонок всегда совпадает с этим файлом, и повторный запуск после правки
-- вида не упирается в ошибку «cannot change name of view column».
-- Данных у вида нет — терять нечего, права выдаются сразу ниже.
drop view if exists public.registry_rows;

create view public.registry_rows
with (security_invoker = true)
as
-- ---- 1. Позиции заявок, оплаченных фирмой (delivered / closed / archived) ----
select
    'order'::text                                             as kind,
    o.request_number::text                                    as source_number,
    o.id                                                      as order_id,
    'order_item:' || i.id::text                               as row_key,
    coalesce(o.delivered_at, o.closed_at, o.created_at)       as entry_at,
    coalesce(o.delivered_at, o.closed_at, o.created_at)::date as entry_date,
    i.name::text                                              as name,
    coalesce(nullif(btrim(i.unit), ''), 'шт')::text           as unit,
    coalesce(i.qty, 0)                                        as qty,
    coalesce(i.unit_price, 0)                                 as unit_price,
    coalesce(i.total_price, 0)                                as total_sum,
    coalesce(i.vat_amount, 0)                                 as vat_amount,
    -- Категория: доставка идёт отдельной строкой заявки, поэтому её показываем
    -- категорией «🚚 Доставка» — фильтр «Категория» тогда видит реальные суммы.
    case
        when public.rsk_delivery_kind(i.delivery_kind, i.name) is not null then 'delivery'
        else 'materials'
    end::text                                                 as category,
    -- Статус оплаты берём у заявки: «Ожидает оплаты» держится до отметки
    -- финансиста по счёту, а не по каждой позиции.
    case
        when public.rsk_delivery_kind(i.delivery_kind, i.name) = 'company' then 'company'
        else coalesce(
            nullif(btrim(o.payment_status), ''),
            nullif(btrim(i.payment_status), ''),
            'paid'
        )
    end::text                                                 as payment,
    case
        when public.rsk_delivery_kind(i.delivery_kind, i.name) = 'company' then '—'
        else coalesce(nullif(btrim(o.supplier), ''), '—')
    end::text                                                 as supplier,
    o.project_id,
    coalesce(p.name, '—')::text                               as project_name,
    o.section_id,
    coalesce(s.name, '—')::text                               as section_name,
    o.created_by_employee_id                                  as employee_id,
    coalesce(ce.name, '—')::text                              as employee_name
from public.order_items i
join public.orders o on o.id = i.order_id
left join public.projects p on p.id = o.project_id
left join public.sections s on s.id = o.section_id
left join public.employees ce on ce.id = o.created_by_employee_id
where o.payment_source = 'company'
  and o.status in ('delivered', 'closed', 'archived')
  -- Своя доставка, уже оплаченная из подотчёта, показана расходом (вторая
  -- половина вида), а не снова строкой заявки: иначе одна сумма попала бы в
  -- деньги дважды.
  and not (
      public.rsk_delivery_kind(i.delivery_kind, i.name) = 'company'
      and exists (
          select 1
          from public.cash_operations od
          where od.source = 'own_delivery'
            and od.order_id = o.id
      )
  )

union all

-- ---- 2. Расходы кассы: подотчёт (source = order / own_delivery / manual) ----
select
    case op.source
        when 'own_delivery' then 'own_delivery'
        when 'order'        then 'order_employee'
        else 'expense'
    end::text                                                 as kind,
    case
        when op.source in ('order', 'own_delivery')
            then coalesce(nullif(btrim(o.request_number), ''), '—')
        else '💰 Расход'
    end::text                                                 as source_number,
    op.order_id,
    'cash_op:' || op.id::text || ':' || coalesce(item.ord, 0)::text as row_key,
    coalesce(op.operation_date::timestamptz, op.created_at)   as entry_at,
    coalesce(op.operation_date, op.created_at::date)          as entry_date,
    -- Позиции расхода лежат в jsonb (cash_operations.items); у расхода без
    -- позиций строка одна и называется по комментарию операции.
    case
        when item.value is null then coalesce(nullif(btrim(op.description), ''), '—')
        else coalesce(nullif(btrim(item.value ->> 'name'), ''), '—')
    end::text                                                 as name,
    case
        when item.value is null then '—'
        else coalesce(nullif(btrim(item.value ->> 'unit'), ''), 'шт')
    end::text                                                 as unit,
    case when item.value is null then 1 else public.rsk_json_amount(item.value, 'qty') end as qty,
    case when item.value is null then coalesce(op.amount, 0)
         else public.rsk_json_amount(item.value, 'price') end  as unit_price,
    case when item.value is null then coalesce(op.amount, 0)
         else public.rsk_json_amount(item.value, 'sum') end    as total_sum,
    coalesce(op.vat_amount, 0)                                as vat_amount,
    case
        when item.value is not null
             and public.rsk_delivery_kind(item.value ->> 'delivery_kind', item.value ->> 'name') is not null
            then 'delivery'
        else op.category
    end::text                                                 as category,
    -- Деньги с подотчёта уже списаны: расход всегда «Оплачено».
    'paid'::text                                              as payment,
    case
        when op.source = 'order' then coalesce(nullif(btrim(o.supplier), ''), '—')
        else '—'
    end::text                                                 as supplier,
    op.project_id,
    coalesce(p.name, '—')::text                               as project_name,
    op.section_id,
    coalesce(s.name, '—')::text                               as section_name,
    op.employee_id,
    coalesce(em.name, '—')::text                              as employee_name
from public.cash_operations op
left join public.orders o on o.id = op.order_id
left join public.projects p on p.id = op.project_id
left join public.sections s on s.id = op.section_id
left join public.employees em on em.id = op.employee_id
-- LEFT JOIN, а не CROSS JOIN: у расхода без позиций (items = []) строка тоже
-- нужна — тогда item.value пустой и берутся поля самой операции.
left join lateral jsonb_array_elements(
    case when jsonb_typeof(op.items) = 'array' then op.items else '[]'::jsonb end
) with ordinality as item(value, ord) on true
where op.operation_type = 'expense';

comment on view public.registry_rows is
    'Строки раздела Реестр материалов: позиции заявок фирмы и расходы кассы. '
    'security_invoker = true: права и RLS проверяются у того, кто читает вид '
    '(database/migrate-v2.9-registry-view.sql).';

-- Права: читать вид могут вошедшие сотрудники; что именно они увидят, решают
-- политики RLS базовых таблиц (database/migrate-v2.7-rls-finance.sql, политика
-- rsk_cash_operations_select). Анонимному ключу вид недоступен.
revoke all on table public.registry_rows from public, anon, authenticated;
grant select on table public.registry_rows to authenticated;

-- =====================================================================
-- БЛОК 4. КОМАНДА public.registry_totals: ИТОГ ПО ВСЕМУ НАБОРУ
-- =====================================================================
-- «Записей: N» и «Итого: сумма» в шапке раздела нельзя считать по странице:
-- на экране 25 строк, а в базе их может быть 40 000, и «Итого» оказалось бы
-- меньше настоящего. Команда считает то же, что показывает список, но по
-- всему отфильтрованному набору и без выгрузки строк в браузер.
--
-- Фильтры — те же, что уходят в запрос страницы (js/modules/registry.js ->
-- registryRowFilters): пустой параметр (null) значит «фильтр не задан».
-- security invoker: команда читает вид от имени вызвавшего, поэтому RLS
-- базовых таблиц действует так же, как в списке.
create or replace function public.registry_totals(
    p_project_id  bigint default null,
    p_section_id  bigint default null,
    p_category    text   default null,
    p_payment     text   default null,
    p_employee_id bigint default null,
    p_date_from   date   default null,
    p_date_to     date   default null
)
returns table (rows_count bigint, total_sum numeric, total_vat numeric)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
    select
        count(*)::bigint                       as rows_count,
        coalesce(sum(r.total_sum), 0)::numeric as total_sum,
        coalesce(sum(r.vat_amount), 0)::numeric as total_vat
    from public.registry_rows r
    where (p_project_id  is null or r.project_id  = p_project_id)
      and (p_section_id  is null or r.section_id  = p_section_id)
      and (p_category    is null or r.category    = p_category)
      and (p_payment     is null or r.payment     = p_payment)
      and (p_employee_id is null or r.employee_id = p_employee_id)
      and (p_date_from   is null or r.entry_date >= p_date_from)
      and (p_date_to     is null or r.entry_date <= p_date_to);
$$;

comment on function public.registry_totals(bigint, bigint, text, text, bigint, date, date) is
    'Количество строк, сумма и НДС Реестра материалов по всему отфильтрованному набору '
    '(а не по одной странице списка).';

-- Права на команду: только вошедшим (тем же, кто читает вид).
revoke all on function public.registry_totals(bigint, bigint, text, text, bigint, date, date)
    from public, anon, authenticated;
grant execute on function public.registry_totals(bigint, bigint, text, text, bigint, date, date)
    to authenticated;

-- Вспомогательные функции вида: права нужны читающему вид (он выполняется от
-- его имени), иначе вид отвечает «permission denied for function».
revoke all on function public.rsk_delivery_kind(text, text) from public, anon;
revoke all on function public.rsk_json_amount(jsonb, text) from public, anon;
grant execute on function public.rsk_delivery_kind(text, text) to authenticated;
grant execute on function public.rsk_json_amount(jsonb, text) to authenticated;

-- =====================================================================
-- БЛОК 5. САМОПРОВЕРКА
-- =====================================================================
-- Файл копируют в SQL Editor: по каждой строке отчёта видно ok или MISSING и
-- что именно не применилось (вид, право, команда).
do $$
declare
    v_view    boolean;
    v_invoker boolean;
    v_grant   boolean;
    v_anon    boolean;
    v_funcs   int;
    v_totals  boolean;
begin
    select exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'registry_rows'
          and c.relkind = 'v'
    ) into v_view;

    raise notice 'registry_rows: %',
        case when v_view then 'ok' else 'MISSING - нет вида public.registry_rows' end;

    select coalesce(bool_or('security_invoker=true' = any (c.reloptions)), false)
    into v_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'registry_rows';

    raise notice 'registry_rows security_invoker: %',
        case when coalesce(v_invoker, false) then 'ok'
             else 'MISSING - вид обойдёт RLS, нужен security_invoker = true' end;

    select has_table_privilege('authenticated', 'public.registry_rows', 'SELECT') into v_grant;

    raise notice 'registry_rows право select: %',
        case when v_grant then 'ok' else 'MISSING - нет grant select для authenticated' end;

    select not has_table_privilege('anon', 'public.registry_rows', 'SELECT') into v_anon;

    raise notice 'registry_rows закрыт от anon: %',
        case when v_anon then 'ok' else 'MISSING - вид читается анонимным ключом' end;

    select count(*)
    into v_funcs
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('rsk_delivery_kind', 'rsk_json_amount');

    raise notice 'вспомогательные функции вида: %',
        case when v_funcs = 2 then 'ok'
             else 'MISSING - нет rsk_delivery_kind или rsk_json_amount' end;

    select exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'registry_totals'
    ) into v_totals;

    raise notice 'registry_totals: %',
        case when v_totals then 'ok'
             else 'MISSING - нет команды public.registry_totals' end;

    raise notice 'проверка чисел из позиций расхода: %',
        case when public.rsk_json_amount('{"sum": "1 500,50"}'::jsonb, 'sum') = 0
              and public.rsk_json_amount('{"sum": 1500.5}'::jsonb, 'sum') = 1500.5
             then 'ok'
             else 'MISSING - разбор чисел в позициях расхода сломан' end;

    raise notice 'проверка вида доставки: %',
        case when public.rsk_delivery_kind(null, 'Доставка компании') = 'company'
              and public.rsk_delivery_kind(null, 'Доставка') = 'supplier'
              and public.rsk_delivery_kind('company', 'Кирпич') = 'company'
              and public.rsk_delivery_kind(null, 'Кирпич') is null
             then 'ok'
             else 'MISSING - вид доставки определяется неверно' end;
end $$;

-- PostgREST держит схему в кэше: без этого новый вид и команда не появятся в
-- API до перезапуска (приложение получило бы PGRST205 или PGRST202).
notify pgrst, 'reload schema';

