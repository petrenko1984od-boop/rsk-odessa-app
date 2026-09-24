-- =====================================================================
-- RSK ODESSA — RLS ДЛЯ ФИНАНСОВЫХ ЗАЯВОК И КАССОВЫХ ОПЕРАЦИЙ
-- Версия: 2.7.0 (первый этап усиления безопасности)
-- =====================================================================
--
-- Фактическое имя таблицы финансовых заявок в приложении — cash_requests
-- (не financial_requests). Эта миграция включает RLS только для:
--   * public.cash_requests;
--   * public.cash_operations.
--
-- На этом этапе здесь НЕТ транзакционных RPC, триггеров и Audit Log.
-- Поэтому две политики временно шире идеального варианта:
--   1) Финансист может создать приход получателю и возврат со своего
--      подотчета — так сейчас работает issueCashRequest() в браузере;
--   2) Снабженец может создать/изменить расход source = 'own_delivery'
--      для выбранного сотрудника — так сейчас сохраняется своя доставка.
-- После переноса этих действий в SECURITY DEFINER RPC временные политики
-- нужно удалить, а прямую запись в cash_operations закрыть.
--
-- Файл можно запускать повторно: функции заменяются, политики сначала
-- удаляются через DROP POLICY IF EXISTS, затем создаются заново.
-- =====================================================================

begin;

-- =====================================================================
-- 1. КОНТЕКСТ ТЕКУЩЕГО СОТРУДНИКА
-- =====================================================================
-- SECURITY DEFINER нужен, чтобы политики финансовых таблиц могли получить
-- привязанного сотрудника независимо от будущей RLS на employees.
-- Фиксированный search_path и полные имена объектов защищают функцию от
-- подмены объектов через пользовательскую схему.

create or replace function public.rsk_current_employee_id()
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
    select e.id
    from public.employees as e
    where e.user_id = auth.uid()
      and coalesce(e.status, 'active') = 'active'
    order by e.id
    limit 1
$$;

create or replace function public.rsk_current_employee_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
    select e.position
    from public.employees as e
    where e.user_id = auth.uid()
      and coalesce(e.status, 'active') = 'active'
    order by e.id
    limit 1
$$;

revoke all on function public.rsk_current_employee_id() from public;
revoke all on function public.rsk_current_employee_role() from public;
grant execute on function public.rsk_current_employee_id() to authenticated;
grant execute on function public.rsk_current_employee_role() to authenticated;

-- =====================================================================
-- 2. БАЗОВЫЕ GRANT И ВКЛЮЧЕНИЕ RLS
-- =====================================================================
-- Anon-ключ публичен по дизайну Supabase, но без сессии он не должен читать
-- или изменять финансовые данные. Service role сохраняет штатный BYPASSRLS.

revoke all on table public.cash_requests from anon;
revoke all on table public.cash_operations from anon;

revoke all on table public.cash_requests from authenticated;
revoke all on table public.cash_operations from authenticated;

grant select, insert, update, delete on table public.cash_requests to authenticated;
grant select, insert, update, delete on table public.cash_operations to authenticated;

-- Identity/serial sequences нужны для INSERT через PostgREST. Получаем имена
-- динамически, чтобы миграция работала и с serial, и с identity.
do $$
declare
    sequence_name text;
begin
    sequence_name := pg_get_serial_sequence('public.cash_requests', 'id');
    if sequence_name is not null then
        execute format('grant usage, select on sequence %s to authenticated', sequence_name);
        execute format('revoke all on sequence %s from anon', sequence_name);
    end if;

    sequence_name := pg_get_serial_sequence('public.cash_operations', 'id');
    if sequence_name is not null then
        execute format('grant usage, select on sequence %s to authenticated', sequence_name);
        execute format('revoke all on sequence %s from anon', sequence_name);
    end if;
end $$;

alter table public.cash_requests enable row level security;
alter table public.cash_requests force row level security;
alter table public.cash_operations enable row level security;
alter table public.cash_operations force row level security;

-- =====================================================================
-- 3. CASH_REQUESTS — ФИНАНСОВЫЕ ЗАЯВКИ
-- =====================================================================

-- Удаляем только политики этой миграции. Чужие политики с другими именами
-- намеренно не трогаем: перед применением проверьте итоговый список в БЛОКЕ 5.
drop policy if exists rsk_cash_requests_select on public.cash_requests;
drop policy if exists rsk_cash_requests_insert_own on public.cash_requests;
drop policy if exists rsk_cash_requests_update_decision on public.cash_requests;
drop policy if exists rsk_cash_requests_update_issue on public.cash_requests;
drop policy if exists rsk_cash_requests_update_owner on public.cash_requests;
drop policy if exists rsk_cash_requests_delete_owner on public.cash_requests;

-- Чтение:
--   * Администратор / Директор / Главный инженер — все заявки;
--   * Финансист — только одобренные и выданные;
--   * остальные активные сотрудники — только свои.
create policy rsk_cash_requests_select
on public.cash_requests
for select
to authenticated
using (
    public.rsk_current_employee_id() is not null
    and (
        public.rsk_current_employee_role() in (
            'Администратор', 'Директор', 'Главный инженер'
        )
        or (
            public.rsk_current_employee_role() = 'Финансист'
            and status in ('approved', 'issued')
        )
        or employee_id = public.rsk_current_employee_id()
    )
);

-- Создание своей заявки. Директор и Финансист заявки не создают по текущим
-- бизнес-правилам интерфейса. Поля решения директора и выдачи должны быть пусты.
create policy rsk_cash_requests_insert_own
on public.cash_requests
for insert
to authenticated
with check (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() in (
        'Администратор', 'Главный инженер', 'Снабженец',
        'Инженер ПТО', 'Прораб'
    )
    and employee_id = public.rsk_current_employee_id()
    and status = 'pending'
    and total_sum > 0
    and approved_by_employee_id is null
    and approved_at is null
    and rejection_reason is null
    and issued_operation_id is null
);

-- Решение по новой заявке: одобрить, вернуть на доработку или отклонить.
create policy rsk_cash_requests_update_decision
on public.cash_requests
for update
to authenticated
using (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() in (
        'Администратор', 'Директор', 'Главный инженер'
    )
    and status = 'pending'
)
with check (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() in (
        'Администратор', 'Директор', 'Главный инженер'
    )
    and status in ('approved', 'revision', 'rejected')
    and total_sum > 0
);

-- Выдача одобренной заявки. Директор намеренно исключен: он согласовывает,
-- но не выдает. Администратор и Главный инженер сохраняют роль кассы.
create policy rsk_cash_requests_update_issue
on public.cash_requests
for update
to authenticated
using (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() in (
        'Администратор', 'Главный инженер', 'Финансист'
    )
    and status = 'approved'
)
with check (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() in (
        'Администратор', 'Главный инженер', 'Финансист'
    )
    and status = 'issued'
    and total_sum > 0
);

-- Автор может повторно отправить возвращенную заявку или убрать завершенную
-- заявку в архив. RLS гарантирует владение строкой; точную пару переходов
-- revision -> pending / issued|rejected -> archived закрепит следующий этап
-- через транзакционный RPC или trigger.
create policy rsk_cash_requests_update_owner
on public.cash_requests
for update
to authenticated
using (
    public.rsk_current_employee_id() is not null
    and employee_id = public.rsk_current_employee_id()
    and status in ('revision', 'issued', 'rejected')
)
with check (
    public.rsk_current_employee_id() is not null
    and employee_id = public.rsk_current_employee_id()
    and status in ('pending', 'archived')
    and total_sum > 0
);

-- Удаление разрешено только автору, пока заявка не ушла в денежный процесс.
create policy rsk_cash_requests_delete_owner
on public.cash_requests
for delete
to authenticated
using (
    public.rsk_current_employee_id() is not null
    and employee_id = public.rsk_current_employee_id()
    and status in ('pending', 'revision')
);

-- =====================================================================
-- 4. CASH_OPERATIONS — ОПЕРАЦИИ ПОДОТЧЕТА
-- =====================================================================

drop policy if exists rsk_cash_operations_select on public.cash_operations;
drop policy if exists rsk_cash_operations_insert_self on public.cash_operations;
drop policy if exists rsk_cash_operations_insert_cashier on public.cash_operations;
drop policy if exists rsk_cash_operations_insert_financier_transition on public.cash_operations;
drop policy if exists rsk_cash_operations_insert_own_delivery on public.cash_operations;
drop policy if exists rsk_cash_operations_update_admin on public.cash_operations;
drop policy if exists rsk_cash_operations_update_own_delivery on public.cash_operations;
drop policy if exists rsk_cash_operations_delete_admin on public.cash_operations;
drop policy if exists rsk_cash_operations_delete_own_delivery on public.cash_operations;

-- Полный реестр операций видят роли с view_registry/cash_view_all в текущем UI.
-- Прораб видит только собственный авансовый отчет.
create policy rsk_cash_operations_select
on public.cash_operations
for select
to authenticated
using (
    public.rsk_current_employee_id() is not null
    and (
        public.rsk_current_employee_role() in (
            'Администратор', 'Директор', 'Главный инженер',
            'Снабженец', 'Инженер ПТО', 'Финансист'
        )
        or employee_id = public.rsk_current_employee_id()
    )
);

-- Собственный расход или возврат. Финансист может делать только возврат;
-- остальные перечисленные роли — расход и возврат. source ограничен текущими
-- клиентскими сценариями manual/order (у return source обычно NULL).
create policy rsk_cash_operations_insert_self
on public.cash_operations
for insert
to authenticated
with check (
    public.rsk_current_employee_id() is not null
    and employee_id = public.rsk_current_employee_id()
    and amount > 0
    and (
        (
            public.rsk_current_employee_role() in (
                'Администратор', 'Директор', 'Главный инженер',
                'Снабженец', 'Инженер ПТО', 'Прораб'
            )
            and (
                (operation_type = 'expense' and source in ('manual', 'order'))
                or (operation_type = 'return' and source is null)
            )
        )
        or (
            public.rsk_current_employee_role() = 'Финансист'
            and operation_type = 'return'
            and source is null
        )
    )
    and (created_by is null or created_by = auth.uid())
);

-- Касса выдает подотчет любому активному сотруднику.
create policy rsk_cash_operations_insert_cashier
on public.cash_operations
for insert
to authenticated
with check (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() in (
        'Администратор', 'Директор', 'Главный инженер'
    )
    and operation_type = 'issue'
    and amount > 0
    and employee_id is not null
    and (created_by is null or created_by = auth.uid())
);

-- ВРЕМЕННАЯ ПОЛИТИКА ДО RPC issue_cash_request:
-- текущий frontend сначала создает issue получателю, потом return Финансисту.
-- Без cash_request_id в cash_operations RLS не может надежно связать INSERT с
-- конкретной approved-заявкой, поэтому это разрешение шире желаемого.
create policy rsk_cash_operations_insert_financier_transition
on public.cash_operations
for insert
to authenticated
with check (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() = 'Финансист'
    and operation_type = 'issue'
    and amount > 0
    and employee_id is not null
    and employee_id <> public.rsk_current_employee_id()
    and (created_by is null or created_by = auth.uid())
);

-- ВРЕМЕННАЯ ПОЛИТИКА ДО RPC сохранения счета/своей доставки:
-- Снабженец может списать own_delivery с выбранного подотчета сотрудника.
create policy rsk_cash_operations_insert_own_delivery
on public.cash_operations
for insert
to authenticated
with check (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() in ('Администратор', 'Снабженец')
    and operation_type = 'expense'
    and source = 'own_delivery'
    and amount > 0
    and order_id is not null
    and employee_id is not null
    and (created_by is null or created_by = auth.uid())
);

-- Администратор нужен для удаления объекта и исправления аварийных данных.
create policy rsk_cash_operations_update_admin
on public.cash_operations
for update
to authenticated
using (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() = 'Администратор'
)
with check (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() = 'Администратор'
    and amount > 0
);

create policy rsk_cash_operations_delete_admin
on public.cash_operations
for delete
to authenticated
using (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() = 'Администратор'
);

-- Сохранение счета обновляет или удаляет ранее созданный расход своей доставки.
create policy rsk_cash_operations_update_own_delivery
on public.cash_operations
for update
to authenticated
using (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() = 'Снабженец'
    and operation_type = 'expense'
    and source = 'own_delivery'
    and order_id is not null
)
with check (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() = 'Снабженец'
    and operation_type = 'expense'
    and source = 'own_delivery'
    and amount > 0
    and order_id is not null
    and employee_id is not null
);

create policy rsk_cash_operations_delete_own_delivery
on public.cash_operations
for delete
to authenticated
using (
    public.rsk_current_employee_id() is not null
    and public.rsk_current_employee_role() = 'Снабженец'
    and operation_type = 'expense'
    and source = 'own_delivery'
    and order_id is not null
);

commit;

-- Просим PostgREST перечитать функции, grants и политики.
notify pgrst, 'reload schema';

-- =====================================================================
-- 5. САМОПРОВЕРКА ПОСЛЕ МИГРАЦИИ
-- =====================================================================

-- Должны быть две строки со статусом enabled + forced.
select
    c.relname as table_name,
    case when c.relrowsecurity then 'enabled' else 'MISSING' end as rls,
    case when c.relforcerowsecurity then 'forced' else 'not forced' end as force_rls
from pg_class as c
join pg_namespace as n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('cash_requests', 'cash_operations')
order by c.relname;

-- Список политик: 6 для cash_requests и 9 для cash_operations.
select
    tablename,
    policyname,
    cmd,
    roles,
    qual,
    with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('cash_requests', 'cash_operations')
order by tablename, policyname;

-- Для обеих таблиц все значения anon_* должны быть false.
select
    table_name,
    has_table_privilege('anon', format('public.%I', table_name), 'SELECT') as anon_select,
    has_table_privilege('anon', format('public.%I', table_name), 'INSERT') as anon_insert,
    has_table_privilege('anon', format('public.%I', table_name), 'UPDATE') as anon_update,
    has_table_privilege('anon', format('public.%I', table_name), 'DELETE') as anon_delete
from (values ('cash_requests'), ('cash_operations')) as tables(table_name)
order by table_name;
