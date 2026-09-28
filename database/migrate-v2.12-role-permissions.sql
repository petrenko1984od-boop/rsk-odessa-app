-- =====================================================================
-- FREEDOM — МИГРАЦИЯ v2.12.0: УПРАВЛЕНИЕ ДОСТУПАМИ (матрица прав по ролям)
-- =====================================================================
-- Что делает этот файл:
--   1. создаёт таблицу public.role_permissions — «какие права роль ПОТЕРЯЛА»:
--      строка здесь означает, что у должности право снято Администратором
--      прямо в приложении (раздел «🔐 Доступы»), а не в коде;
--   2. закрывает таблицу: читают её все вошедшие (каждой роли нужно знать
--      свои отзывы, чтобы не показывать лишние кнопки), меняет — ТОЛЬКО
--      Администратор;
--   3. ставит штамп изменения (кто и когда) — его подставляет БАЗА, а не
--      браузер: подделать нельзя.
--
-- ЗАЧЕМ. До этого матрица прав жила одним файлом — js/permissions.js →
-- ROLE_PERMISSIONS: чтобы убрать у роли раздел или кнопку, нужно было править
-- код, собирать фронтенд и выпускать версию. Теперь это делает Администратор
-- в своём меню: экран «🔐 Доступы» показывает матрицу «право × роль» и
-- сохраняет снятые галочки в эту таблицу.
--
-- ⚠️ ТОЛЬКО ОТЗЫВ, А НЕ ВЫДАЧА ПРАВ. В таблице появиться может лишь строка
--    «право снято». Выдать роль право, которого у неё нет в коде, экран не
--    может: настоящая защита данных — политики RLS в Postgres, а они знают
--    роли ПО ИМЕНАМ (database/migrate-v2.7-rls-finance.sql и другие). Выдача
--    права в обход политики дала бы худший вид ошибки: кнопка есть, база
--    отвечает «new row violates row-level security policy». Поэтому выдача
--    прав остаётся правкой кода (js/permissions.js) ВМЕСТЕ с политиками.
--    Проверку «строка = только отзыв» стережёт
--    tools/checks/migration-check.mjs (блок v2.12.0) и сам экран.
--
-- ⚠️ Сначала должна быть применена v2.7.0 (database/migrate-v2.7-rls-finance.sql):
--    политики опираются на её функции контекста сотрудника. Без неё файл
--    останавливается с понятным сообщением, как migrate-v2.8.
--
-- Порядок применения: Supabase → SQL Editor → New query → вставить файл
-- ЦЕЛИКОМ → Run. Повторный запуск безопасен (таблица — if not exists,
-- политики и триггер — drop перед созданием). Перед применением сделайте
-- резервную копию (database/README.md; автоматический дамп — ops/README.md →
-- «Резервные копии»).
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
-- БЛОК 1. Таблица отозванных прав
-- ---------------------------------------------------------------------
-- Колонки:
--   role        — должность из CONFIG.POSITIONS (ключ ROLE_PERMISSIONS);
--   permission  — право из каталога js/permissions.js → PERMISSION_CATALOG;
--   revoked     — true  — право снято у роли;
--                 false — право вернули к заводскому (галочка снята), строка
--                 остаётся ради истории изменений;
--   changed_at / changed_by — кто и когда это сделал (подставляет триггер).
--
-- Пары «роль + право» уникальны: одна строка — одно решение. Права, которых
-- в таблице нет, работают ровно так, как записано в коде, — поэтому новая
-- версия приложения с новыми правами не требует миграции базы.
-- ---------------------------------------------------------------------

create table if not exists public.role_permissions (
    role        text        not null,
    permission  text        not null,
    revoked     boolean     not null default true,
    changed_at  timestamptz not null default now(),
    changed_by  bigint,
    primary key (role, permission),
    -- Мусор в таблице ломает не только экран: имя роли сверяется со
    -- справочником должностей, а право — с каталогом, поэтому длина и вид
    -- значений ограничены. Право, которого нет в каталоге, приложение
    -- игнорирует и показывает администратору предупреждение.
    constraint role_permissions_role_check
        check (char_length(btrim(role)) between 1 and 64),
    constraint role_permissions_permission_check
        check (permission ~ '^[a-z][a-z0-9_]{2,48}$')
);

comment on table public.role_permissions is
    'Отозванные права ролей: строка = право снято у должности администратором в разделе 🔐 Доступы. Читают все вошедшие, меняет только Администратор (RLS). Выдача прав выполняется кодом вместе с политиками.';

-- ---------------------------------------------------------------------
-- БЛОК 2. Штамп изменения: кто и когда снял право
-- ---------------------------------------------------------------------
-- На экране видно «изменено: дата, сотрудник». Дату и сотрудника берёт база:
-- браузер их не присылает, поэтому в историю нельзя вписать чужое имя (та же
-- логика, что в журнале ошибок v2.9.0).
-- ---------------------------------------------------------------------

create or replace function public.rsk_role_permissions_stamp()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
    new.changed_at := now();
    new.changed_by := public.rsk_current_employee_id();
    return new;
end;
$$;

comment on function public.rsk_role_permissions_stamp() is
    'Штамп изменения матрицы прав: время и сотрудник подставляются базой из сессии, а не браузером.';

revoke all on function public.rsk_role_permissions_stamp() from public;
revoke all on function public.rsk_role_permissions_stamp() from anon;
revoke all on function public.rsk_role_permissions_stamp() from authenticated;

drop trigger if exists rsk_role_permissions_stamp on public.role_permissions;
create trigger rsk_role_permissions_stamp
before insert or update on public.role_permissions
for each row execute function public.rsk_role_permissions_stamp();

-- ---------------------------------------------------------------------
-- БЛОК 3. Права доступа к таблице и политики RLS
-- ---------------------------------------------------------------------
-- Чтение — всем вошедшим: приложение на входе подтягивает отзывы своей роли
-- (и только их показывает). Данные здесь не секрет: это настройка интерфейса,
-- а не деньги и не документы.
--
-- Запись — только Администратор. Роль берётся из базы
-- (rsk_current_employee_role()), а не из запроса: подменить её в браузере
-- нельзя. Директор экран не видит (право manage_access), но даже если бы
-- запрос ушёл из консоли — база его отклонит.
-- ---------------------------------------------------------------------

revoke all on table public.role_permissions from anon;
revoke all on table public.role_permissions from authenticated;
grant select, insert, update, delete on table public.role_permissions to authenticated;

alter table public.role_permissions enable row level security;

drop policy if exists rsk_role_permissions_select_all on public.role_permissions;
create policy rsk_role_permissions_select_all
on public.role_permissions
for select
to authenticated
using (true);

drop policy if exists rsk_role_permissions_write_admin on public.role_permissions;
create policy rsk_role_permissions_write_admin
on public.role_permissions
for all
to authenticated
using (
    public.rsk_current_employee_role() = 'Администратор'
)
with check (
    public.rsk_current_employee_role() = 'Администратор'
);

commit;

-- ---------------------------------------------------------------------
-- БЛОК 4. САМОПРОВЕРКА: таблица на месте и закрыта?
-- ---------------------------------------------------------------------
-- Ожидается 6 строк со статусом 'ok'. Где 'MISSING' — смотрите вкладку
-- Notices этого запуска и применяйте файл ЦЕЛИКОМ, а не по блокам.
-- ---------------------------------------------------------------------

select what, status
from (
    select 1 as num, 'таблица role_permissions' as what,
        case when to_regclass('public.role_permissions') is not null
             then 'ok' else 'MISSING - примените файл целиком' end as status

    union all
    select 2, 'RLS включён на role_permissions',
        case when coalesce((select relrowsecurity from pg_class
                             where oid = to_regclass('public.role_permissions')), false)
             then 'ok' else 'MISSING - таблица открыта' end

    union all
    select 3, 'политика чтения (все вошедшие)',
        case when exists (select 1 from pg_policies
                           where schemaname = 'public' and tablename = 'role_permissions'
                             and policyname = 'rsk_role_permissions_select_all')
             then 'ok' else 'MISSING - отзывы не прочитаются' end

    union all
    select 4, 'политика записи (только Администратор)',
        case when exists (select 1 from pg_policies
                           where schemaname = 'public' and tablename = 'role_permissions'
                             and policyname = 'rsk_role_permissions_write_admin')
             then 'ok' else 'MISSING - матрицу сможет менять кто угодно' end

    union all
    select 5, 'штамп изменения (триггер)',
        case when exists (select 1 from pg_trigger
                           where tgrelid = to_regclass('public.role_permissions')
                             and tgname = 'rsk_role_permissions_stamp')
             then 'ok' else 'MISSING - история изменений не заполнится' end

    -- Права anon читаются из каталога (aclexplode), а не через
    -- has_table_privilege: так проверка не зависит от того, что роль anon
    -- вообще существует (в локальной копии базы её может не быть).
    union all
    select 6, 'ключ anon к таблице закрыт',
        case when not exists (
                select 1
                  from pg_class as c,
                       aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) as acl
                 where c.oid = to_regclass('public.role_permissions')
                   and acl.grantee = (select oid from pg_roles where rolname = 'anon')
                   and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
             )
             then 'ok' else 'MISSING - anon имеет права' end
) as checks
order by num;

-- PostgREST держит схему в кэше: без этого уведомления таблица появится в REST
-- только после его перезапуска (в интерфейсе — «Could not find the table
-- public.role_permissions in the schema cache», хотя в SQL она есть).
-- Последняя команда файла: всё созданное ПОСЛЕ него в кэш API не попадёт.
notify pgrst, 'reload schema';

