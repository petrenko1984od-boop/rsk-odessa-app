-- =====================================================================
-- FREEDOM — МИГРАЦИЯ v2.6.0
-- =====================================================================
-- Что добавляет эта версия:
--   1. статус 'archived' («📥 В архиве») у заявок на финансирование: автор
--      убирает ЗАКОНЧЕННУЮ заявку (выданную или отклонённую) со своего
--      рабочего экрана. Заявка остаётся в базе со всеми позициями, решением
--      директора и операцией выдачи — меняется только статус;
--   2. заодно то же ограничение разрешает статус 'revision' («✏️ На
--      доработке», появился в v2.2.0). Если он уже разрешён — ничего не
--      меняется, файл только подтверждает результат.
--
-- Колонок эта миграция НЕ добавляет: у cash_requests все нужные колонки есть
-- с прошлых версий. Файл правит только CHECK-ограничение на список статусов
-- таблицы cash_requests.
--
-- ЗАЧЕМ. На cash_requests.status с прошлых версий стоит CHECK-ограничение со
-- списком статусов БЕЗ 'archived'. Без этой миграции кнопка «📥 В архив» не
-- работает: база отклоняет запись и отвечает
--     new row for relation "cash_requests" violates check constraint
--     "cash_requests_status_check"    (SQLSTATE 23514)
-- Приложение показывает это понятным текстом (js/database.js → explainError)
-- и называет именно этот файл — половина действий молча не пропадает.
--
-- ⚠️ К заявкам на МАТЕРИАЛЫ это не относится: orders.status знает статус
--    'archived' с v2.4.0 (БЛОК 4 в database/migrate-v2.4.sql), поэтому архив
--    прораба по закупкам работает без этой миграции.
--
-- ⚠️ Короткий файл database/fix-cash-requests-status-check.sql делает только
--    первую половину работы (разрешает 'revision'). Если вы уже применяли
--    его или просто нужен архив — выполняйте ЭТОТ файл: он ставит ограничение
--    со всеми шестью статусами приложения и перезапускается безопасно.
--
-- Как выполнять в Supabase → SQL Editor → New query: вставить файл ЦЕЛИКОМ →
-- Run (не по блокам). Повторный запуск безопасен. В конце будет таблица
-- проверки: нужны строки со статусом 'ok'. Подробно — database/README.md.
-- =====================================================================


-- ---------------------------------------------------------------------
-- БЛОК 1. Что уже стоит на cash_requests.status (для отчёта)
-- ---------------------------------------------------------------------
-- Строки этой таблицы ничего не меняют: по ним видно, какое ограничение
-- действует сейчас и под каким именем.
-- ---------------------------------------------------------------------
select conname as constraint_name, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'cash_requests'::regclass and contype = 'c'
order by conname;


-- ---------------------------------------------------------------------
-- БЛОК 2. Снимаем устаревшие ограничения на status — те, где нет 'archived'.
--        Ограничения, которые уже допускают этот статус, не трогаем.
--        Ошибка снятия не обрывает скрипт: она печатается в Notices.
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
          and pg_get_constraintdef(oid) !~ '\yarchived\y'
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
-- БЛОК 3. Ставим ограничение заново — со всеми статусами приложения
--        (js/modules/cash-requests.js → getCashRequestStatusInfo):
--            pending | approved | revision | rejected | issued | archived
-- ---------------------------------------------------------------------
do $$
declare
    definition text;
begin
    select pg_get_constraintdef(oid) into definition
    from pg_constraint
    where conrelid = 'cash_requests'::regclass and conname = 'cash_requests_status_check';

    if definition is not null and definition ~ '\yarchived\y' then
        raise notice 'ok: ограничение уже допускает archived — править нечего';
        return;
    end if;

    if definition is not null then
        execute 'alter table cash_requests drop constraint cash_requests_status_check';
    end if;

    execute format(
        'alter table cash_requests add constraint cash_requests_status_check '
        'check (status in (%L, %L, %L, %L, %L, %L))',
        'pending', 'approved', 'revision', 'rejected', 'issued', 'archived'
    );

    raise notice 'ok: cash_requests_status_check обновлено — archived разрешён';
exception when others then
    raise warning 'cash_requests_status_check не обновлено: % (%) — проверьте права на таблицу cash_requests', sqlerrm, sqlstate;
end $$;


-- ---------------------------------------------------------------------
-- БЛОК 4. ПРОВЕРКА: все статусы приложения разрешены?
--        Нужны шесть строк со статусом 'ok'. Где 'MISSING' — смотрите Notices:
--        там точная ошибка базы (например, нет прав на alter table).
-- ---------------------------------------------------------------------
with constraint_def as (
    select pg_get_constraintdef(oid) as definition
      from pg_constraint
     where conrelid = 'cash_requests'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ~ '\ystatus\y'
     limit 1
)
select c.status_value as status_value,
       case
           when (select definition from constraint_def) is null
               then 'ok — ограничения на список статусов нет: любое значение разрешено'
           when (select definition from constraint_def) ~ ('\y' || c.status_value || '\y')
               then 'ok'
           else 'MISSING — примените файл целиком'
       end as status
from (values
    ('pending'), ('approved'), ('revision'), ('rejected'), ('issued'), ('archived')
) as c(status_value)
order by c.status_value;

-- Схему PostgREST надо перечитать, иначе приложение ещё несколько минут
-- будет считать, что статуса 'archived' в списке нет.
notify pgrst, 'reload schema';
