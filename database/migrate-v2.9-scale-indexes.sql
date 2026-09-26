-- =====================================================================
-- FREEDOM — МИГРАЦИЯ v2.9.0: МАСШТАБИРОВАНИЕ
-- =====================================================================
-- Что делает эта версия:
--   1. ставит индексы на колонки, по которым приложение ФИЛЬТРУЕТ и
--      СОРТИРУЕТ строки (статусы заявок, объект, раздел, сотрудник, дата
--      операции, дедлайн задачи);
--   2. собирает статистику планировщика (analyze) — без неё Postgres на
--      «пустой для него» таблице выбирает перебор вместо индекса;
--   3. в конце печатает самопроверку: ok / MISSING по каждому индексу.
--
-- Колонок эта миграция НЕ добавляет, данные НЕ меняет, RLS и серверные
-- команды (v2.7.0 / v2.8.0) НЕ трогает. Только индексы и статистика.
--
-- ЗАЧЕМ. PostgREST выполняет ровно тот запрос, который собрал фронтенд, а
-- фронтенд с v2.9.0 больше не просит всю таблицу: он просит СТРАНИЦУ
-- (js/database.js → selectPage, js/pagination.js) с фильтрами:
--     /orders?status=in.(new,in_progress)&order=created_at.desc&limit=25
--     /cash_operations?operation_type=eq.expense&order=operation_date.desc
-- Без индексов такой запрос на большой таблице читает её целиком и
-- сортирует во временном файле: страница «Снабжения» открывается всё
-- дольше, хотя в ней всего 25 карточек. Индекс превращает это в чтение
-- нескольких десятков строк.
--
-- ⚠️ Точный индекс нужен КАЖДОЙ странице, а не «примерно похожий»: порядок
--    колонок в определении повторяет порядок «фильтр → сортировка». Если
--    добавить в код новый фильтр, добавьте и индекс — прогон
--    tools/checks/migration-check.mjs проверяет эту связку (таблица и
--    колонка фильтра из кода должны быть в списке индексов этого файла).
--
-- Как выполнять в Supabase → SQL Editor → New query: вставить файл ЦЕЛИКОМ →
-- Run (не по блокам). Повторный запуск безопасен: все индексы создаются с
-- if not exists. В конце будет таблица проверки: нужны строки со статусом
-- 'ok'. Подробно — database/README.md.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- БЛОК 1. Заявки на материалы (orders)
-- ---------------------------------------------------------------------
-- Экран «Снабжение» (js/modules/orders.js) и план-факт объекта.
-- Порядок колонок: сначала то, по чему фильтруем (status / project_id /
-- created_by_employee_id), потом то, по чему сортируем (created_at desc) —
-- так Postgres отдаёт страницу прямо из индекса, без сортировки.
-- ---------------------------------------------------------------------

-- Вкладки «🔴 Новые», «🟡 В обработке», «🚚 Доставлено», «🟢 Закрытые»,
-- «📥 Архив» и «📋 Все» (последняя — без фильтра, но с той же сортировкой).
create index if not exists orders_status_created_idx
    on public.orders (status, created_at desc);

-- Прораб видит только свои заявки: фильтр created_by_employee_id ставит
-- СЕРВЕР (js/modules/orders.js → ordersFilters), а не браузер.
create index if not exists orders_created_by_created_idx
    on public.orders (created_by_employee_id, created_at desc);

-- Рабочий экран прораба и карточка объекта: заявки по объекту
-- (фильтр project_id.in(...) + сортировка по дате).
create index if not exists orders_project_created_idx
    on public.orders (project_id, created_at desc);

-- План-факт и «📦 Доп. расходы»: заявки раздела (js/modules/extra-costs.js).
create index if not exists orders_section_idx
    on public.orders (section_id);

-- Своя доставка и закупки из подотчёта: поиск заявок плательщика
-- (js/modules/registry.js, js/modules/orders.js → payer_employee_id).
create index if not exists orders_payer_idx
    on public.orders (payer_employee_id);

-- «🧾 Счета поставщиков → Ожидают оплаты» (js/modules/invoices.js:
-- payment_source = 'company' и payment_status = 'debt'). Индекс частичный:
-- долгов всегда на порядок меньше, чем закупок, поэтому он маленький и
-- попадает в кэш целиком. Сортировка по дате — как просит экран.
create index if not exists orders_debt_created_idx
    on public.orders (created_at desc)
    where payment_source = 'company' and payment_status = 'debt';

-- «✅ Оплаченные счета» — та же вкладка финансиста, но по отметке оплаты
-- (paid_at ставит финансист, см. database/migrate-v2.4.sql).
create index if not exists orders_paid_created_idx
    on public.orders (paid_at desc)
    where payment_source = 'company' and payment_status = 'paid';

-- ---------------------------------------------------------------------
-- БЛОК 2. Позиции заявок (order_items)
-- ---------------------------------------------------------------------
-- Позиции всегда читают «по списку заявок страницы» и дописывают их к
-- карточке: фильтр order_id.in(...) / order_id = N.
-- ---------------------------------------------------------------------
create index if not exists order_items_order_idx
    on public.order_items (order_id);

-- ---------------------------------------------------------------------
-- БЛОК 3. Заявки на подотчёт (cash_requests)
-- ---------------------------------------------------------------------
-- Раздел «💰 Финансы» (js/modules/cash-requests.js) и «Мои заявки».
-- ---------------------------------------------------------------------
create index if not exists cash_requests_employee_created_idx
    on public.cash_requests (employee_id, created_at desc);

-- Вкладки «На утверждении / Выданные / Отклонённые / Архив».
create index if not exists cash_requests_status_created_idx
    on public.cash_requests (status, created_at desc);

-- Заявка привязана к объекту и разделу: карточка объекта и план-факт.
create index if not exists cash_requests_project_idx
    on public.cash_requests (project_id);

-- Позиции заявки читаются по request_id (как order_items по order_id).
create index if not exists cash_request_items_request_idx
    on public.cash_request_items (request_id);

-- ---------------------------------------------------------------------
-- БЛОК 4. Касса и подотчёт (cash_operations)
-- ---------------------------------------------------------------------
-- Это самая быстрорастущая таблица: каждая закупка, каждая выдача и каждое
-- пополнение подотчёта — строка. Читают её: «Мои операции» и авансовый
-- отчёт (js/modules/cash.js), реестр материалов (js/modules/registry.js),
-- план-факт объекта (js/modules/dashboard.js).
-- ---------------------------------------------------------------------

-- «Мои операции» и баланс сотрудника: фильтр employee_id + сортировка по
-- дате операции (operation_date not null default current_date, см. schema.sql).
create index if not exists cash_operations_employee_date_idx
    on public.cash_operations (employee_id, operation_date desc, created_at desc);

-- Реестр берёт ТОЛЬКО расходы (operation_type = 'expense'), ведомости — только
-- выдачи (operation_type = 'issue'). Обе выборки идут по дате.
create index if not exists cash_operations_type_date_idx
    on public.cash_operations (operation_type, operation_date desc);

-- План-факт объекта и «Доп. расходы»: расходы по объекту и по разделу.
create index if not exists cash_operations_project_idx
    on public.cash_operations (project_id);
create index if not exists cash_operations_section_idx
    on public.cash_operations (section_id);

-- Реестр сопоставляет расход со заявкой (source = 'order' / 'own_delivery'):
-- по order_id он добирает номер и поставщика. Без индекса это перебор всей
-- кассы на каждый расход.
create index if not exists cash_operations_order_idx
    on public.cash_operations (order_id);

-- ---------------------------------------------------------------------
-- БЛОК 5. Задачи (tasks)
-- ---------------------------------------------------------------------
-- «✅ Задачи» (js/modules/tasks.js), рабочий экран прораба и карточка
-- сотрудника (js/modules/employees.js).
-- ---------------------------------------------------------------------
create index if not exists tasks_assignee_status_idx
    on public.tasks (assignee_employee_id, status);
create index if not exists tasks_project_status_idx
    on public.tasks (project_id, status);

-- «Просроченные» и сортировка по сроку: фильтр по deadline без проекта.
create index if not exists tasks_deadline_idx
    on public.tasks (deadline);

-- Раздел задачи — план-факт раздела.
create index if not exists tasks_section_idx
    on public.tasks (section_id);

-- ---------------------------------------------------------------------
-- БЛОК 6. Объекты, разделы, файлы, сотрудники
-- ---------------------------------------------------------------------
-- Объекты прораба (js/modules/projects.js, dashboard.js).
create index if not exists projects_foreman_idx
    on public.projects (foreman_id);

-- Разделы объекта: смета, график работ, план-факт (sections.project_id).
create index if not exists sections_project_idx
    on public.sections (project_id);

-- Лента Ганта сортирует разделы по плановой дате начала
-- (js/modules/gantt.js: order by planned_start_date).
create index if not exists sections_project_planned_idx
    on public.sections (project_id, planned_start_date);

-- Документация объекта: список файлов по объекту, свежие сверху.
create index if not exists project_files_project_created_idx
    on public.project_files (project_id, created_at desc);

-- Вход в приложение: auth.js ищет сотрудника по auth-пользователю
-- (employees.user_id = user.id) на каждой загрузке страницы.
-- ⚠️ Индекс НЕ уникальный сознательно: уникальность запретила бы вход, если в
--    боевой базе уже есть два сотрудника с одним user_id (так бывает после
--    ручных правок прямо в таблице). Сначала исправьте данные, и только
--    потом ставьте уникальный: create unique index ... — приложение берёт
--    строку через .maybeSingle(), и с дублями он вернёт ошибку PGRST116.
create index if not exists employees_user_idx
    on public.employees (user_id)
    where user_id is not null;

-- Список сотрудников фильтруют по роли и статусу (активные, по должности).
create index if not exists employees_position_status_idx
    on public.employees (position, status);

-- Справочники сотрудников сортируются по имени (order by name).
create index if not exists employees_name_idx
    on public.employees (name);

-- ---------------------------------------------------------------------
-- БЛОК 7. Статистика планировщика
-- ---------------------------------------------------------------------
-- Индексы бесполезны, пока планировщик считает таблицу пустой: он выбирает
-- перебор строк. analyze собирает статистику сразу после создания индексов.
-- ---------------------------------------------------------------------
analyze public.employees;
analyze public.projects;
analyze public.sections;
analyze public.orders;
analyze public.order_items;
analyze public.cash_requests;
analyze public.cash_request_items;
analyze public.cash_operations;
analyze public.tasks;
analyze public.project_files;

commit;

-- =====================================================================
-- БЛОК 8. САМОПРОВЕРКА
-- =====================================================================
-- Ниже по строке на каждый индекс: status = 'ok', если индекс создан.
-- 'MISSING' значит, что файл выполнен не целиком (например, скопировали
-- только его часть). Запустите файл ещё раз целиком — повтор безопасен.
-- =====================================================================

select
    expected.index_name,
    case when existing.indexname is null then 'MISSING' else 'ok' end as status
from (values
    ('orders_status_created_idx'),
    ('orders_created_by_created_idx'),
    ('orders_project_created_idx'),
    ('orders_section_idx'),
    ('orders_payer_idx'),
    ('orders_debt_created_idx'),
    ('orders_paid_created_idx'),
    ('order_items_order_idx'),
    ('cash_requests_employee_created_idx'),
    ('cash_requests_status_created_idx'),
    ('cash_requests_project_idx'),
    ('cash_request_items_request_idx'),
    ('cash_operations_employee_date_idx'),
    ('cash_operations_type_date_idx'),
    ('cash_operations_project_idx'),
    ('cash_operations_section_idx'),
    ('cash_operations_order_idx'),
    ('tasks_assignee_status_idx'),
    ('tasks_project_status_idx'),
    ('tasks_deadline_idx'),
    ('tasks_section_idx'),
    ('projects_foreman_idx'),
    ('sections_project_idx'),
    ('sections_project_planned_idx'),
    ('project_files_project_created_idx'),
    ('employees_user_idx'),
    ('employees_position_status_idx'),
    ('employees_name_idx')
) as expected(index_name)
left join pg_indexes as existing
    on existing.schemaname = 'public'
   and existing.indexname = expected.index_name
order by expected.index_name;

-- Итог одной строкой: сколько индексов из списка выше существует на самом
-- деле. Должно быть 28 из 28.
select
    count(*) filter (where existing.indexname is not null) as created_indexes,
    count(*) as expected_indexes
from (values
    ('orders_status_created_idx'),
    ('orders_created_by_created_idx'),
    ('orders_project_created_idx'),
    ('orders_section_idx'),
    ('orders_payer_idx'),
    ('orders_debt_created_idx'),
    ('orders_paid_created_idx'),
    ('order_items_order_idx'),
    ('cash_requests_employee_created_idx'),
    ('cash_requests_status_created_idx'),
    ('cash_requests_project_idx'),
    ('cash_request_items_request_idx'),
    ('cash_operations_employee_date_idx'),
    ('cash_operations_type_date_idx'),
    ('cash_operations_project_idx'),
    ('cash_operations_section_idx'),
    ('cash_operations_order_idx'),
    ('tasks_assignee_status_idx'),
    ('tasks_project_status_idx'),
    ('tasks_deadline_idx'),
    ('tasks_section_idx'),
    ('projects_foreman_idx'),
    ('sections_project_idx'),
    ('sections_project_planned_idx'),
    ('project_files_project_created_idx'),
    ('employees_user_idx'),
    ('employees_position_status_idx'),
    ('employees_name_idx')
) as expected(index_name)
left join pg_indexes as existing
    on existing.schemaname = 'public'
   and existing.indexname = expected.index_name;
