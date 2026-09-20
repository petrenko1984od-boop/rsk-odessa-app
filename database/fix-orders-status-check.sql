-- =====================================================================
-- RSK ODESSA — БЫСТРАЯ ПРАВКА: CHECK-ограничение статусов заявок
-- =====================================================================
-- КОГДА НУЖНО. Заявка не закрывается, а приложение пишет:
--   «База отклонила запись: в таблице «orders» сработало ограничение
--    «orders_status_check» — в списке статусов нет «Доставлено на объект».
--    Примените database/migrate-v2.4.sql (Supabase → SQL Editor)…»
-- В консоли/Notices при этом видно ответ Postgres:
--   new row for relation "orders" violates check constraint
--   "orders_status_check"   (SQLSTATE 23514, код ошибки 23514)
--
-- ПРИЧИНА. На колонке orders.status с прежних версий осталось CHECK-ограничение
-- со списком статусов БЕЗ нового статуса 'delivered' — именно им версия 2.4.0
-- закрывает закупку («🚚 Доставлено на объект»). База отклоняет запись, и
-- заявка «не закрывается».
--
-- ЧТО ДЕЛАЕТ ФАЙЛ. Только одно: снимает устаревшее ограничение и ставит новое
-- со списком статусов, который знает приложение (js/config.js →
-- CONFIG.ORDER_STATUS):
--     new | in_progress | delivered | closed | archived
--
-- ⚠️ Это тот же шаг, что делает БЛОК 4 миграции database/migrate-v2.4.sql.
--    Если вы применяете миграцию целиком — отдельный файл не нужен.
--    Этот файл — короткий путь: скопировать, запустить, проверить результат.
--
-- КАК ВЫПОЛНЯТЬ. Supabase → SQL Editor → New query → вставить ЦЕЛИКОМ → Run
-- (не по блокам). Повторный запуск безопасен. В конце будет таблица проверки:
-- нужна строка со статусом 'ok'.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Что уже стоит на orders.status (для отчёта)
-- ---------------------------------------------------------------------
select conname as constraint_name, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'orders'::regclass and contype = 'c'
order by conname;


-- ---------------------------------------------------------------------
-- 2. Снимаем устаревшие ограничения на status — те, где нет 'delivered'.
--    Ограничения, которые уже допускают этот статус, не трогаем.
--    Ошибка снятия не обрывает скрипт: она печатается в Notices.
-- ---------------------------------------------------------------------
do $$
declare
    r record;
    dropped int := 0;
begin
    for r in
        select conname
        from pg_constraint
        where conrelid = 'orders'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) ~ '\ystatus\y'
          and pg_get_constraintdef(oid) !~ '\ydelivered\y'
    loop
        begin
            execute format('alter table orders drop constraint %I', r.conname);
            dropped := dropped + 1;
            raise notice 'ok: снято устаревшее ограничение %', r.conname;
        exception when others then
            raise warning 'НЕ СНЯТО — %: % (%)', r.conname, sqlerrm, sqlstate;
        end;
    end loop;

    if dropped = 0 then
        raise notice 'ok: устаревших ограничений на orders.status нет';
    end if;
end $$;


-- ---------------------------------------------------------------------
-- 3. Ставим ограничение заново — со всеми статусами приложения
-- ---------------------------------------------------------------------
do $$
declare
    definition text;
begin
    select pg_get_constraintdef(oid) into definition
    from pg_constraint
    where conrelid = 'orders'::regclass and conname = 'orders_status_check';

    if definition is not null and definition ~ '\ydelivered\y' then
        raise notice 'ok: ограничение уже допускает delivered — править нечего';
        return;
    end if;

    if definition is not null then
        execute 'alter table orders drop constraint orders_status_check';
    end if;

    execute format(
        'alter table orders add constraint orders_status_check '
        'check (status in (%L, %L, %L, %L, %L))',
        'new', 'in_progress', 'delivered', 'closed', 'archived'
    );

    raise notice 'ok: orders_status_check обновлено — delivered разрешён';
exception when others then
    raise warning 'orders_status_check не обновлено: % (%) — проверьте права на таблицу orders', sqlerrm, sqlstate;
end $$;


-- ---------------------------------------------------------------------
-- 4. ПРОВЕРКА: не осталось ли ограничение, запрещающее 'delivered'.
--    Нужна строка со статусом 'ok'. Если 'MISSING' — смотрите Notices:
--    там точная ошибка базы (например, нет прав на alter table).
-- ---------------------------------------------------------------------
select coalesce(conname, '— ограничений на orders.status нет —') as constraint_name,
       coalesce(pg_get_constraintdef(oid), 'status — обычный text') as definition,
       case when oid is null or pg_get_constraintdef(oid) ~ '\ydelivered\y'
            then 'ok' else 'MISSING — delivered запрещён' end as status
from (select 1) as one
left join lateral (
    select conname, oid
    from pg_constraint
    where conrelid = 'orders'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ '\ystatus\y'
) as k on true;

-- PostgREST держит свою копию схемы: просим перечитать, иначе приложение
-- ещё несколько минут работает со старым представлением о таблице.
notify pgrst, 'reload schema';
