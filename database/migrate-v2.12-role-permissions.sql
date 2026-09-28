-- =====================================================================
-- FREEDOM — МИГРАЦИЯ v2.12.0: УПРАВЛЕНИЕ ДОСТУПАМИ (матрица прав по ролям)
-- =====================================================================
-- Что делает этот файл:
--   1. создаёт таблицу public.role_permissions — решения администратора по
--      матрице «право × роль», принятые прямо в приложении (раздел
--      «🔐 Доступы»), а не в коде:
--          revoked = true — право СНЯТО у должности;
--          granted = true — право ВЫДАНО должности сверх заводской матрицы;
--   2. закрывает таблицу: читают её все вошедшие (каждой роли нужно знать
--      свои выдачи и отзывы, чтобы не показывать лишние кнопки), меняет —
--      ТОЛЬКО Администратор;
--   3. ставит штамп изменения (кто и когда) — его подставляет БАЗА, а не
--      браузер: подделать нельзя;
--   4. делает ВЫДАЧУ настоящей, а не картинкой в интерфейсе: добавляет
--      функцию public.rsk_permission_granted() и учит её спрашивать те места,
--      где данные закрыты политиками и функциями базы — политики RLS на
--      денежные заявки и операции, журнал ошибок, редактор смет и четыре
--      финансовых RPC.
--
-- ЗАЧЕМ. До этого матрица прав жила одним файлом — js/permissions.js →
-- ROLE_PERMISSIONS: чтобы убрать или добавить роли раздел или кнопку, нужно
-- было править код, собирать фронтенд и выпускать версию. Теперь это делает
-- Администратор в своём меню: экран «🔐 Доступы» показывает матрицу и
-- сохраняет галочки в эту таблицу.
--
-- ⚠️ ПОЧЕМУ ВЫДАЧА РАБОТАЕТ. Право, поставленное галочкой, действует не
--    только в разметке: политики RLS и финансовые RPC перечисляют роли ПО
--    ИМЕНАМ, поэтому без изменений в базе выданное право дало бы худший вид
--    ошибки — кнопка есть, а база отвечает «new row violates row-level
--    security policy». Поэтому выдача проверяется функцией
--    public.rsk_permission_granted(), которая читает ту же таблицу:
--      · политики-выдачи добавлены как ДОПОЛНИТЕЛЬНЫЕ (permissive): старые
--        политики не переписаны, поэтому доступ у ролей не сузился;
--      · в финансовые RPC условие отказа стало строже по смыслу: «роль не
--        подходит И право не выдано» (тела функций переписываются базой через
--        pg_get_functiondef, чтобы копия кода не разошлась с
--        migrate-v2.8-finance-rpc-audit.sql);
--      · строку правок вправе менять только Администратор, поэтому «выдать
--        себе всё» из консоли браузера нельзя.
--    Что выдача НЕ отменяет: заводские правила строки («только своя заявка»,
--    «только в статусе pending») остаются в силе — заявку чужого сотрудника
--    выданное право не откроет.
--
-- ⚠️ СНАЧАЛА ДОЛЖНЫ БЫТЬ ПРИМЕНЕНЫ v2.7.0, v2.8.0, v2.9.0 и v2.10.0:
--    политики опираются на функции контекста сотрудника (v2.7), а расширяются
--    денежные RPC (v2.8), журнал ошибок (v2.9) и редактор смет (v2.10). Если
--    чего-то не хватает, файл останавливается с понятным сообщением — какой
--    файл применить (как migrate-v2.8 и migrate-v2.9).
--
-- Порядок применения: Supabase → SQL Editor → New query → вставить файл
-- ЦЕЛИКОМ → Run. Повторный запуск безопасен (таблица — if not exists, колонка —
-- add column if not exists, политики и триггер — drop перед созданием, функции
-- и RPC — create or replace, уже расширенные гейты пропускаются). Если раньше
-- применялась первая версия файла (экран тогда умел только отзывать права),
-- повторный запуск добавит колонку granted, функцию и политики выдачи.
-- Перед применением сделайте резервную копию (database/README.md;
-- автоматический дамп — ops/README.md → «Резервные копии»).
--
-- В конце печатается самопроверка: строки со статусом 'ok'. Где 'MISSING' —
-- смотрите вкладку Notices этого запуска.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- БЛОК 0. Проверка зависимостей: применены ли v2.7.0 … v2.10.0
-- ---------------------------------------------------------------------
-- Файл не делает вид, что всё на месте: без функций контекста сотрудника
-- политики выдачи некуда повесить, а без денежных RPC, журнала ошибок и
-- редактора смет нечего дополнять выдачей. Ошибка называет файл, который
-- нужно применить, — как в migrate-v2.8 и migrate-v2.9.
-- ---------------------------------------------------------------------

do $$
begin
    if to_regprocedure('public.rsk_current_employee_role()') is null
        or to_regprocedure('public.rsk_current_employee_id()') is null
    then
        raise exception 'Сначала примените database/migrate-v2.7-rls-finance.sql';
    end if;

    if to_regclass('public.cash_requests') is null
        or to_regclass('public.cash_operations') is null
    then
        raise exception 'Не найдены таблицы денежных заявок и операций — примените database/schema.sql и database/migrate-v2.4.sql';
    end if;

    if to_regprocedure('public.create_order_with_items(bigint,bigint,date,text,jsonb,uuid)') is null
        or to_regprocedure('public.create_cash_request_with_items(bigint,bigint,text,jsonb,uuid)') is null
        or to_regprocedure('public.issue_cash_request(bigint,uuid)') is null
        or to_regprocedure('public.save_own_delivery_expense(bigint,boolean,numeric,text,bigint,numeric,uuid)') is null
    then
        raise exception 'Сначала примените database/migrate-v2.8-finance-rpc-audit.sql';
    end if;

    if to_regclass('public.app_errors') is null then
        raise exception 'Сначала примените database/migrate-v2.9-ops-monitoring.sql';
    end if;

    if to_regprocedure('public.rsk_is_estimate_editor()') is null then
        raise exception 'Сначала примените database/migrate-v2.10-estimates.sql';
    end if;
end $$;

-- ---------------------------------------------------------------------
-- БЛОК 1. Таблица решений администратора
-- ---------------------------------------------------------------------
-- Колонки:
--   role        — должность из CONFIG.POSITIONS (ключ ROLE_PERMISSIONS);
--   permission  — право из каталога js/permissions.js → PERMISSION_CATALOG;
--   revoked     — true — право СНЯТО у роли;
--   granted     — true — право ВЫДАНО роли сверх заводской матрицы;
--                 revoked = false и granted = false — право вернули к
--                 заводскому: строка остаётся ради истории изменений;
--   changed_at / changed_by — кто и когда это сделал (подставляет триггер).
--
-- Пары «роль + право» уникальны: одна строка — одно решение. Права, которых
-- в таблице нет, работают ровно так, как записано в коде, — поэтому новая
-- версия приложения с новыми правами не требует миграции базы.
-- ---------------------------------------------------------------------

create table if not exists public.role_permissions (
    role        text        not null,
    permission  text        not null,
    revoked     boolean     not null default false,
    granted     boolean     not null default false,
    changed_at  timestamptz not null default now(),
    changed_by  bigint,
    primary key (role, permission),
    -- «Снято» и «выдано» одновременно — противоречие: такая строка сломала бы
    -- и экран (две правки в одной клетке), и проверки базы.
    constraint role_permissions_override_check
        check (not (revoked and granted)),
    -- Мусор в таблице ломает не только экран: имя роли сверяется со
    -- справочником должностей, а право — с каталогом, поэтому длина и вид
    -- значений ограничены. Право, которого нет в каталоге, приложение
    -- игнорирует и показывает администратору предупреждение.
    constraint role_permissions_role_check
        check (char_length(btrim(role)) between 1 and 64),
    constraint role_permissions_permission_check
        check (permission ~ '^[a-z][a-z0-9_]{2,48}$')
);

-- Таблицу могла создать первая версия этого файла: тогда в ней нет колонки
-- granted, а revoked по умолчанию true. Дополняем — повторный запуск файла
-- после обновления приложения должен работать, а не падать.
alter table public.role_permissions
    add column if not exists granted boolean not null default false;
alter table public.role_permissions
    alter column revoked set default false;
alter table public.role_permissions
    drop constraint if exists role_permissions_override_check;
alter table public.role_permissions
    add constraint role_permissions_override_check check (not (revoked and granted));

comment on table public.role_permissions is
    'Решения администратора по матрице прав (раздел 🔐 Доступы): revoked = true — право снято у должности, granted = true — право выдано сверх заводской матрицы, оба false — вернули заводское значение (строка остаётся ради истории). Читают все вошедшие, меняет только Администратор (RLS). Выдачу видят политики RLS и финансовые RPC — через public.rsk_permission_granted().';

-- ---------------------------------------------------------------------
-- БЛОК 2. Штамп изменения: кто и когда менял право
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
-- Чтение — всем вошедшим: приложение на входе подтягивает правки своей роли
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

-- ---------------------------------------------------------------------
-- БЛОК 4. Проверка выдачи: public.rsk_permission_granted()
-- ---------------------------------------------------------------------
-- Вопрос, который задают политики и функции базы: «право выдано текущей роли
-- администратором?» Ответ читается из этой же таблицы, поэтому экран и база
-- не могут разойтись.
--
-- SECURITY DEFINER с фиксированным search_path: политики должны видеть решения
-- администратора независимо от того, насколько строго закрыта сама таблица.
--
-- ⚠️ Функция отвечает только за ВЫДАЧУ, а не за заводскую матрицу: она говорит
--    «да» лишь тогда, когда в таблице есть строка granted = true и не revoked.
--    Поэтому её можно добавлять к старым проверкам через «или»: роли, у которых
--    выдачи нет, ничего не теряют.
-- ---------------------------------------------------------------------

create or replace function public.rsk_permission_granted(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
    select exists (
        select 1
          from public.role_permissions as rp
         where rp.role = public.rsk_current_employee_role()
           and rp.permission = p_permission
           and rp.granted
           and not rp.revoked
    )
$$;

comment on function public.rsk_permission_granted(text) is
    'Выдано ли право текущей роли администратором (раздел 🔐 Доступы): true, если в role_permissions для пары role + permission стоит granted = true и не revoked. Этим вопросом дополнены политики RLS, редактор смет и финансовые RPC — чтобы выданное право работало и в данных, а не только в интерфейсе.';

revoke all on function public.rsk_permission_granted(text) from public;
revoke all on function public.rsk_permission_granted(text) from anon;
grant execute on function public.rsk_permission_granted(text) to authenticated;

-- ---------------------------------------------------------------------
-- БЛОК 5. Выдача права работает в данных: политики RLS и редактор смет
-- ---------------------------------------------------------------------
-- Здесь СОЗДАЮТСЯ ДОПОЛНИТЕЛЬНЫЕ политики (permissive), а старые не трогаются:
-- у Postgres политики одной команды складываются по «или», поэтому доступ ролей
-- может только расшириться — тот, кто работал вчера, работает и сегодня.
-- Так же дополняется маленькая функция редактора смет (create or replace).
--
-- Заводские правила строки при этом сохраняются: чужую заявку выдача не откроет
-- (условия «employee_id = свой», статусы и виды операций скопированы из политик
-- v2.7.0 дословно).
-- ---------------------------------------------------------------------

-- Деньги: видеть все заявки и все операции подотчёта (право cash_view_all).
drop policy if exists rsk_cash_requests_select_granted on public.cash_requests;
create policy rsk_cash_requests_select_granted
on public.cash_requests
for select
to authenticated
using (
    public.rsk_permission_granted('cash_view_all')
);

drop policy if exists rsk_cash_operations_select_granted on public.cash_operations;
create policy rsk_cash_operations_select_granted
on public.cash_operations
for select
to authenticated
using (
    public.rsk_permission_granted('cash_view_all')
);

-- Деньги: согласовать заявку (process_cash_request).
drop policy if exists rsk_cash_requests_update_decision_granted on public.cash_requests;
create policy rsk_cash_requests_update_decision_granted
on public.cash_requests
for update
to authenticated
using (
    public.rsk_permission_granted('process_cash_request')
    and status = 'pending'
)
with check (
    public.rsk_permission_granted('process_cash_request')
    and status in ('approved', 'revision', 'rejected')
    and total_sum > 0
);

-- Деньги: выдать деньги по одобренной заявке (issue_cash_request).
drop policy if exists rsk_cash_requests_update_issue_granted on public.cash_requests;
create policy rsk_cash_requests_update_issue_granted
on public.cash_requests
for update
to authenticated
using (
    public.rsk_permission_granted('issue_cash_request')
    and status = 'approved'
)
with check (
    public.rsk_permission_granted('issue_cash_request')
    and status = 'issued'
    and total_sum > 0
);

-- Деньги: свой расход (cash_expense_self) и свой возврат (cash_return_self).
drop policy if exists rsk_cash_operations_insert_self_granted on public.cash_operations;
create policy rsk_cash_operations_insert_self_granted
on public.cash_operations
for insert
to authenticated
with check (
    public.rsk_current_employee_id() is not null
    and employee_id = public.rsk_current_employee_id()
    and amount > 0
    and (
        (
            public.rsk_permission_granted('cash_expense_self')
            and operation_type = 'expense'
            and source in ('manual', 'order')
        )
        or (
            public.rsk_permission_granted('cash_return_self')
            and operation_type = 'return'
            and source is null
        )
    )
    and (created_by is null or created_by = auth.uid())
);


-- Деньги: выдать подотчёт сотруднику (cash_issue) — как политика кассы v2.7.0.
drop policy if exists rsk_cash_operations_insert_cashier_granted on public.cash_operations;
create policy rsk_cash_operations_insert_cashier_granted
on public.cash_operations
for insert
to authenticated
with check (
    public.rsk_current_employee_id() is not null
    and public.rsk_permission_granted('cash_issue')
    and operation_type = 'issue'
    and amount > 0
    and employee_id is not null
    and (created_by is null or created_by = auth.uid())
);

-- Диагностика: раздел «🩺 Диагностика» (право view_diagnostics).
drop policy if exists rsk_app_errors_select_granted on public.app_errors;
create policy rsk_app_errors_select_granted
on public.app_errors
for select
to authenticated
using (
    public.rsk_permission_granted('view_diagnostics')
);

-- Смета: одна маленькая функция закрывает весь файл сметы и её справочники,
-- поэтому её тело дополняется выдачей права manage_estimate.
create or replace function public.rsk_is_estimate_editor()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
    select coalesce(public.rsk_current_employee_role(), '') in
        ('Администратор', 'Главный инженер', 'Инженер ПТО')
        or public.rsk_permission_granted('manage_estimate')
$$;

revoke all on function public.rsk_is_estimate_editor() from public;
grant execute on function public.rsk_is_estimate_editor() to authenticated;


-- ---------------------------------------------------------------------
-- БЛОК 6. Выдача права работает в деньгах: финансовые RPC
-- ---------------------------------------------------------------------
-- Каждая денежная команда проверяет роль списком: «создавать заявку могут
-- Администратор, Главный инженер, Снабженец, Инженер ПТО, Прораб». Выданное в
-- приложении право такой список не расширит, и сотрудник получил бы кнопку,
-- которая отвечает «Нет права...» — ровно тот обман, из-за которого этот блок
-- и появился.
--
-- Тела функций берутся ИЗ БАЗЫ (pg_get_functiondef) и переписываются с одним
-- дополнением: отказ выдаётся, только если роль НЕ подходит И права не выдавали
-- («if employee_role not in (...) and not public.rsk_permission_granted(...)»).
-- Копии кода здесь нет намеренно: два текста одной и той же функции рано или
-- поздно разошлись бы с database/migrate-v2.8-finance-rpc-audit.sql.
--
-- Повторный запуск безопасен: если гейт уже дополнен выдачей, функция
-- пропускается; а если в теле не нашлась проверка «роль в списке» (функцию
-- переписали), файл останавливается с ошибкой, а не оставляет половину правок.
-- ---------------------------------------------------------------------

do $$
declare
    spec record;
    definition text;
    patched text;
begin
    for spec in
        select *
          from (values
              ('public.create_order_with_items(bigint,bigint,date,text,jsonb,uuid)', 'create_order'),
              ('public.create_cash_request_with_items(bigint,bigint,text,jsonb,uuid)', 'cash_expense_self'),
              ('public.issue_cash_request(bigint,uuid)', 'issue_cash_request'),
              ('public.save_own_delivery_expense(bigint,boolean,numeric,text,bigint,numeric,uuid)', 'cash_expense_self')
          ) as t(signature, permission)
    loop
        definition := pg_get_functiondef(to_regprocedure(spec.signature));

        -- Уже дополнено (повторный запуск файла) — делать нечего.
        if position('rsk_permission_granted' in definition) > 0 then
            continue;
        end if;

        patched := regexp_replace(
            definition,
            '(if employee_role not in \([^)]*\)) then',
            '\1 and not public.rsk_permission_granted(''' || spec.permission || ''') then'
        );

        if patched = definition then
            raise exception 'В функции % не найдена проверка if employee_role not in (...) then — тело функции изменилось, обновите этот блок миграции', spec.signature;
        end if;

        execute patched;
    end loop;
end $$;


commit;

-- ---------------------------------------------------------------------
-- БЛОК 7. САМОПРОВЕРКА: таблица, выдача и её проверки в базе
-- ---------------------------------------------------------------------
-- Ожидается 13 строк со статусом 'ok' — от таблицы до гейтов финансовых RPC.
-- Где 'MISSING' — смотрите вкладку Notices этого запуска и применяйте файл
-- ЦЕЛИКОМ, а не по блокам.
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
             then 'ok' else 'MISSING - правки не прочитаются' end

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
    union all
    select 7, 'колонка granted (выдача прав)',
        case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'role_permissions'
                             and column_name = 'granted')
             then 'ok' else 'MISSING - выдача прав не сохранится' end

    union all
    select 8, 'запрет: снято и выдано сразу',
        case when exists (select 1 from pg_constraint
                           where conname = 'role_permissions_override_check')
             then 'ok' else 'MISSING - противоречивые строки пройдут' end

    union all
    select 9, 'функция rsk_permission_granted()',
        case when to_regprocedure('public.rsk_permission_granted(text)') is not null
             then 'ok' else 'MISSING - выдача не работает в данных' end

    union all
    select 10, 'политики выдачи на деньги (6)',
        case when (select count(*) from pg_policies
                    where schemaname = 'public'
                      and policyname in (
                          'rsk_cash_requests_select_granted',
                          'rsk_cash_requests_update_decision_granted',
                          'rsk_cash_requests_update_issue_granted',
                          'rsk_cash_operations_select_granted',
                          'rsk_cash_operations_insert_self_granted',
                          'rsk_cash_operations_insert_cashier_granted'
                      )) = 6
             then 'ok' else 'MISSING - деньги не примут выданное право' end

    union all
    select 11, 'политика выдачи на журнал ошибок',
        case when exists (select 1 from pg_policies
                           where schemaname = 'public' and tablename = 'app_errors'
                             and policyname = 'rsk_app_errors_select_granted')
             then 'ok' else 'MISSING - раздел Диагностика не выдастся' end

    union all
    select 12, 'редактор смет видит выдачу manage_estimate',
        case when coalesce(position('rsk_permission_granted' in
                    pg_get_functiondef(to_regprocedure('public.rsk_is_estimate_editor()'))), 0) > 0
             then 'ok' else 'MISSING - смета останется закрытой' end

    union all
    select 13, 'финансовые RPC пускают выданное право (4)',
        case when (select count(*)
                     from unnest(array[
                         'public.create_order_with_items(bigint,bigint,date,text,jsonb,uuid)',
                         'public.create_cash_request_with_items(bigint,bigint,text,jsonb,uuid)',
                         'public.issue_cash_request(bigint,uuid)',
                         'public.save_own_delivery_expense(bigint,boolean,numeric,text,bigint,numeric,uuid)'
                     ]) as signature
                    where coalesce(position('rsk_permission_granted' in
                              pg_get_functiondef(to_regprocedure(signature))), 0) > 0
                   ) = 4
             then 'ok' else 'MISSING - деньги не примут выданное право' end
) as checks
order by num;

-- PostgREST держит схему в кэше: без этого уведомления таблица появится в REST
-- только после его перезапуска (в интерфейсе — «Could not find the table
-- public.role_permissions in the schema cache», хотя в SQL она есть).
-- Последняя команда файла: всё созданное ПОСЛЕ него в кэш API не попадёт.
notify pgrst, 'reload schema';

