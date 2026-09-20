-- =====================================================================
-- RSK ODESSA — БЫСТРАЯ ПРАВКА: CHECK-ограничение статусов заявок НА ФИНАНСЫ
-- =====================================================================
-- КОГДА НУЖНО. Директор нажимает «✏️ На доработку», а приложение пишет:
--   «База отклонила запись: в таблице «cash_requests» сработало ограничение
--    «cash_requests_status_check» — в списке статусов нет «На доработке».
--    Примените database/fix-cash-requests-status-check.sql (Supabase → SQL
--    Editor) и повторите действие.»
-- В консоли/Notices при этом видно ответ Postgres:
--   new row for relation "cash_requests" violates check constraint
--   "cash_requests_status_check"   (SQLSTATE 23514, код ошибки 23514)
--
-- ПРИЧИНА. На колонке cash_requests.status с прежних версий осталось
-- CHECK-ограничение со списком статусов БЕЗ статуса 'revision' — именно им
-- версия 2.2.0 возвращает заявку автору («✏️ На доработку»). База отклоняет
-- запись, и кнопка «На доработку» выглядит «не работает». Одобрение и отказ
-- проходят, потому что статусы 'approved' и 'rejected' в старом списке есть.
--
-- ЧТО ДЕЛАЕТ ФАЙЛ. Только одно: снимает устаревшее ограничение и ставит новое
-- со списком статусов, который знает приложение (js/modules/cash-requests.js):
--     pending | approved | revision | rejected | issued
--
-- ⚠️ Колонок этот файл НЕ добавляет: в отличие от заявок на материалы
--    (delivered_at, payment_status, …), все колонки cash_requests есть с
--    прошлых версий. Если приложение просит ещё и database/migrate-v2.4.sql —
--    запустите сначала миграцию, потом этот файл.
--
-- КАК ВЫПОЛНЯТЬ. Supabase → SQL Editor → New query → вставить ЦЕЛИКОМ → Run
-- (не по блокам). Повторный запуск безопасен. В конце будет таблица проверки:
-- нужна строка со статусом 'ok'.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Что уже стоит на cash_requests.status (для отчёта)
-- ---------------------------------------------------------------------
select conname as constraint_name, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'cash_requests'::regclass and contype = 'c'
order by conname;


-- ---------------------------------------------------------------------
-- 2. Снимаем устаревшие ограничения на status — те, где нет 'revision'.
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
        where conrelid = 'cash_requests'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) ~ '\ystatus\y'
          and pg_get_constraintdef(oid) !~ '\yrevision\y'
    loop
        begin
            execute format('alter table cash_requests drop constraint %I', r.conname);
            dropped := dropped + 1;
            raise notice 'ok: снято устаревшее ограничение %', r.conname;
        exception when others then
            raise warning 'НЕ СНЯТО — %: % (%)', r.conname, sqlerrm, sqlstate;
        end;
    end loop;

    if dropped = 0 then
        raise notice 'ok: устаревших ограничений на cash_requests.status нет';
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
    where conrelid = 'cash_requests'::regclass and conname = 'cash_requests_status_check';

    if definition is not null and definition ~ '\yrevision\y' then
        raise notice 'ok: ограничение уже допускает revision — править нечего';
        return;
    end if;

    if definition is not null then
        execute 'alter table cash_requests drop constraint cash_requests_status_check';
    end if;

    execute format(
        'alter table cash_requests add constraint cash_requests_status_check '
        'check (status in (%L, %L, %L, %L, %L))',
        'pending', 'approved', 'revision', 'rejected', 'issued'
    );

    raise notice 'ok: cash_requests_status_check обновлено — revision разрешён';
exception when others then
    raise warning 'cash_requests_status_check не обновлено: % (%) — проверьте права на таблицу cash_requests', sqlerrm, sqlstate;
end $$;


-- ---------------------------------------------------------------------
-- 4. ПРОВЕРКА: не осталось ли ограничение, запрещающее 'revision'.
--    Нужна строка со статусом 'ok'. Если 'MISSING' — смотрите Notices:
--    там точная ошибка базы (например, нет прав на alter table).
-- ---------------------------------------------------------------------
select coalesce(conname, '— ограничений на cash_requests.status нет —') as constraint_name,
       coalesce(pg_get_constraintdef(oid), 'status — обычный text') as definition,
       case when oid is null or pg_get_constraintdef(oid) ~ '\yrevision\y'
            then 'ok' else 'MISSING — revision запрещён' end as status
from (select 1) as one
left join lateral (
    select conname, oid
    from pg_constraint
    where conrelid = 'cash_requests'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ '\ystatus\y'
) as k on true;

-- PostgREST держит свою копию схемы: просим перечитать, иначе приложение
-- ещё несколько минут работает со старым представлением о таблице.
notify pgrst, 'reload schema';
