-- =====================================================================
-- FREEDOM — МИГРАЦИЯ v2.9.0 (эксплуатация): ЖУРНАЛ ОШИБОК ПРИЛОЖЕНИЯ
-- =====================================================================
-- Что делает этот файл:
--   1. создаёт таблицу public.app_errors — журнал ошибок, которые случились
--      В БРАУЗЕРЕ сотрудника (необработанное исключение, отклонённый промис,
--      отказ при сохранении, сбой service worker-а);
--   2. создаёт команду public.rsk_log_app_errors(entries jsonb) — единственный
--      способ писать в журнал. Она сама подставляет сотрудника, роль и время,
--      обрезает длинные строки и не даёт журналу расти бесконечно;
--   3. закрывает журнал: писать может только вошедший (через команду), читать —
--      только Администратор и Директор.
--
-- ЗАЧЕМ. До этого об ошибках у сотрудников узнавали со слов: «у меня не
-- сохраняется». В консоли браузера при этом лежит готовый ответ — текст
-- ошибки и стек, — но его никто не видит, а сотрудник не обязан уметь
-- открывать DevTools. Инструкция «пришлите скриншот консоли» не работает;
-- журнал работает: приложение само складывает ошибки в базу, где их видно
-- запросом (ops/README.md → «Журнал ошибок», там же готовые запросы).
--
-- ⚠️ В журнал НЕ ПОПАДАЮТ данные приложения: только текст ошибки, стек, адрес
--    страницы, версия приложения и ревизия оболочки. Пароли, суммы и файлы не
--    пишутся — модуль js/monitoring.js их и не имеет, а команда базы принимает
--    только перечисленные поля (запись в остальные колонки невозможна).
--
-- ⚠️ Сначала должна быть применена v2.7.0 (database/migrate-v2.7-rls-finance.sql):
--    журнал опирается на её функции контекста сотрудника. Без неё файл
--    останавливается с понятным сообщением, как migrate-v2.8.
--
-- Порядок применения: Supabase → SQL Editor → New query → вставить файл
-- ЦЕЛИКОМ → Run. Повторный запуск безопасен (таблица и индексы — if not
-- exists, команда — replace). Перед применением сделайте резервную копию:
-- файл трогает структуру боевой базы (database/README.md; автоматический дамп
-- — ops/README.md → «Резервные копии»).
--
-- В конце печатается самопроверка: строки со статусом 'ok'. Где 'MISSING' —
-- смотрите вкладку Notices этого запуска.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- БЛОК 0. Проверка: применена ли v2.7.0
-- ---------------------------------------------------------------------
do $$
begin
    if to_regprocedure('public.rsk_current_employee_role()') is null
        or to_regprocedure('public.rsk_current_employee_id()') is null
    then
        raise exception 'Сначала примените database/migrate-v2.7-rls-finance.sql';
    end if;
end $$;

-- ---------------------------------------------------------------------
-- БЛОК 1. Таблица журнала
-- ---------------------------------------------------------------------
-- Колонки:
--   kind        — вид события: error (исключение), rejection (промис без
--                 обработки), save (отказ при сохранении), network (нет
--                 связи), sw (service worker);
--   message     — текст ошибки (обрезан до 500 символов);
--   stack       — стек вызовов (обрезан до 2000);
--   page        — адрес страницы приложения (location.pathname);
--   user_id / employee_id / role — кто это увидел (подставляет БАЗА из сессии,
--                 а не браузер: подделать нельзя);
--   context     — мелкие подробности (версия, ревизия оболочки, действие).
-- ---------------------------------------------------------------------

create table if not exists public.app_errors (
    id              bigserial primary key,
    created_at      timestamptz not null default now(),
    app_version     text not null default '',
    shell_revision  text not null default '',
    kind            text not null default 'error',
    message         text not null,
    stack           text,
    page            text,
    user_agent      text,
    user_id         uuid,
    employee_id     bigint,
    role            text,
    context         jsonb not null default '{}'::jsonb
);

comment on table public.app_errors is
    'Журнал ошибок из браузеров сотрудников. Пишется только командой rsk_log_app_errors; читают Администратор и Директор (RLS).';

-- Журнал читают по времени («что было вчера») и группируют по тексту ошибки
-- («одно и то же повторяется») — под это два индекса, а не один.
create index if not exists app_errors_created_idx
    on public.app_errors (created_at desc);
create index if not exists app_errors_kind_created_idx
    on public.app_errors (kind, created_at desc);

-- ---------------------------------------------------------------------
-- БЛОК 2. Кто что может
-- ---------------------------------------------------------------------
-- Пишет только команда (она выполняется от владельца базы и потому обходит
-- RLS): прямого insert у приложения нет вовсе — значит, нельзя записать
-- чужой user_id, «затереть» строки или наполнить журнал мусором мимо правил
-- команды. Чтение — Администратор и Директор (та же пара ролей, что видит
-- деньги в v2.7.0): журнал показывает, у кого что падает.

revoke all on table public.app_errors from anon;
revoke all on table public.app_errors from authenticated;
grant select on table public.app_errors to authenticated;

alter table public.app_errors enable row level security;

drop policy if exists rsk_app_errors_select_admin on public.app_errors;
create policy rsk_app_errors_select_admin
on public.app_errors
for select
to authenticated
using (
    public.rsk_current_employee_role() in ('Администратор', 'Директор')
);

-- ---------------------------------------------------------------------
-- БЛОК 3. Команда записи
-- ---------------------------------------------------------------------
-- Принимает ПАЧКУ записей (до 20): приложение копит ошибки в localStorage и
-- отправляет их одним запросом — в офлайне это важно, потому что связи может
-- не быть вовсе, а ошибки терять нельзя.
--
-- Здесь же три защиты журнала:
--   * обрезка длинных строк (left) — стек на мегабайт в базу не уедет;
--   * отказ при лавине: если за минуту прилетело больше 200 записей, значит
--     ошибка повторяется в цикле (например, в обработчике прокрутки) — пишем
--     отказ, иначе один сломанный экран наполнит таблицу за час;
--   * ротация: записи старше 90 дней удаляются сами.
--
-- Возвращает объект { saved: N } — слой js/database.js считает ответ без
-- объекта ошибкой, поэтому пустой ответ команда не отдаёт никогда.

create or replace function public.rsk_log_app_errors(p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    entry   jsonb;
    saved   integer := 0;
    who     uuid    := auth.uid();
    worker  bigint  := public.rsk_current_employee_id();
    job     text    := public.rsk_current_employee_role();
begin
    -- Без сессии писать нечего: журнал привязан к сотруднику, а анонимный
    -- insert превратил бы таблицу в мусорку для любого, кто знает адрес.
    if who is null then
        return jsonb_build_object('saved', 0, 'reason', 'no_session');
    end if;

    if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
        return jsonb_build_object('saved', 0, 'reason', 'bad_payload');
    end if;

    if (select count(*) from public.app_errors where created_at > now() - interval '1 minute') > 200 then
        return jsonb_build_object('saved', 0, 'reason', 'rate_limited');
    end if;

    for entry in (select value from jsonb_array_elements(p_entries) limit 20) loop
        if jsonb_typeof(entry) <> 'object' then
            continue;
        end if;

        insert into public.app_errors (
            app_version, shell_revision, kind, message, stack, page, user_agent,
            context, user_id, employee_id, role
        ) values (
            left(coalesce(entry ->> 'app_version', ''), 32),
            left(coalesce(entry ->> 'shell_revision', ''), 16),
            left(coalesce(nullif(entry ->> 'kind', ''), 'error'), 24),
            left(coalesce(nullif(entry ->> 'message', ''), '(без текста)'), 500),
            left(entry ->> 'stack', 2000),
            left(entry ->> 'page', 200),
            left(entry ->> 'user_agent', 300),
            case when jsonb_typeof(entry -> 'context') = 'object'
                 then entry -> 'context' else '{}'::jsonb end,
            who, worker, job
        );

        saved := saved + 1;
    end loop;

    delete from public.app_errors where created_at < now() - interval '90 days';

    return jsonb_build_object('saved', saved);
end;
$$;

comment on function public.rsk_log_app_errors(jsonb) is
    'Запись ошибок из браузера: принимает до 20 записей за раз, подставляет сотрудника из сессии, обрезает длинные строки, хранит журнал 90 дней.';

revoke all on function public.rsk_log_app_errors(jsonb) from public;
grant execute on function public.rsk_log_app_errors(jsonb) to authenticated;

commit;

-- PostgREST держит схему в кэше: без этого уведомления команда и таблица
-- появятся в REST только после его перезапуска (в интерфейсе — «функция не
-- найдена», хотя в SQL она есть).
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- БЛОК 4. ПРОВЕРКА: журнал на месте?
-- ---------------------------------------------------------------------
-- Ожидается 6 строк со статусом 'ok'. Где 'MISSING' — смотрите вкладку
-- Notices этого запуска и применяйте файл ЦЕЛИКОМ, а не по блокам.
-- ---------------------------------------------------------------------

select what, status
from (
    select 1 as num, 'таблица app_errors' as what,
        case when to_regclass('public.app_errors') is not null
             then 'ok' else 'MISSING — примените файл целиком' end as status

    union all
    select 2, 'индексы журнала (created_at, kind)',
        case when (select count(*) from pg_indexes
                    where schemaname = 'public' and tablename = 'app_errors') >= 3
             then 'ok' else 'MISSING — часть индексов не создалась' end

    union all
    select 3, 'RLS включён на app_errors',
        case when coalesce((select relrowsecurity from pg_class
                             where oid = to_regclass('public.app_errors')), false)
             then 'ok' else 'MISSING — журнал открыт' end

    union all
    select 4, 'политика чтения (Администратор/Директор)',
        case when exists (select 1 from pg_policies
                           where schemaname = 'public' and tablename = 'app_errors'
                             and policyname = 'rsk_app_errors_select_admin')
             then 'ok' else 'MISSING — читать журнал некому' end

    union all
    select 5, 'команда записи rsk_log_app_errors(jsonb)',
        case when to_regprocedure('public.rsk_log_app_errors(jsonb)') is not null
             then 'ok' else 'MISSING — ошибки некуда писать' end

    -- Права anon читаются из каталога (aclexplode), а не через
    -- has_table_privilege: так проверка не зависит от того, что роль anon
    -- вообще существует (в локальной копии базы её может не быть).
    union all
    select 6, 'ключ anon к журналу закрыт',
        case when not exists (
                select 1
                  from pg_class as c,
                       aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as acl
                  join pg_roles as r on r.oid = acl.grantee
                 where c.oid = to_regclass('public.app_errors')
                   and r.rolname = 'anon')
             then 'ok' else 'MISSING — отзовите права у anon' end
) as checks
order by num;

-- Заодно видно, что журнал пока пустой (после выпуска здесь появятся записи).
select count(*) as rows_in_journal from public.app_errors;
