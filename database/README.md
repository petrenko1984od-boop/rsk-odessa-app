# База данных: схема и миграции

Здесь лежит всё, что относится к базе Supabase (Postgres + Auth + Storage).

| Файл | Что это |
| --- | --- |
| `schema.sql` | Полная схема для **чистой** установки: таблицы, колонки, внешние ключи. Включает изменения v2.4.0 и v2.5.0 |
| `migrate-v2.4.sql` | Пошаговая миграция v2.4.0 для **уже работающей** базы: счёт поставщика по заявке, статус «Доставлено на объект», оплата счёта финансистом, обновление CHECK-ограничения `orders_status_check` |
| `migrate-v2.5.sql` | Пошаговая миграция v2.5.0 для **уже работающей** базы: НДС (ПДВ) в счёте и в позициях заявки, признак вида доставки `delivery_kind`, учёт своей доставки из подотчёта (`source = 'own_delivery'`) |
| `migrate-v2.6.sql` | Пошаговая миграция v2.6.0 для **уже работающей** базы: архив заявок на финансирование — обновление CHECK-ограничения `cash_requests_status_check` (разрешает `revision` и `archived`). **Колонок не добавляет** |
| `fix-unconfirmed-users.sql` | Служебный скрипт: что делать с аккаунтами, застрявшими в «Email not confirmed» |
| `fix-orders-status-check.sql` | Служебный скрипт: если заявка не закрывается из-за устаревшего CHECK-ограничения `orders_status_check` (ошибка `23514`) — короткая правка вместо запуска всей миграции |
| `fix-cash-requests-status-check.sql` | Служебный скрипт: если заявка на финансы не уходит на доработку из-за устаревшего CHECK-ограничения `cash_requests_status_check` (ошибка `23514`) — короткая правка. Разрешает только `revision`: **для архива нужен `migrate-v2.6.sql`** |

## Что делать с уже работающей базой

`schema.sql` — это **реконструкция** схемы по коду, а не дамп боевой базы: там нет индексов,
триггеров, политик RLS и настроек Storage. Поэтому на работающем проекте применяют
**миграции по порядку**, а не `schema.sql`: сначала `migrate-v2.4.sql`, затем
`migrate-v2.5.sql`, а если нужен архив заявок на финансирование — ещё
`migrate-v2.6.sql`. Последний колонок **не добавляет** (правит только ограничение
статусов `cash_requests`), поэтому его можно применять когда угодно — в том числе
первым, до остальных: боевой базе «колонки v2.4.0 и v2.5.0 на месте» он не мешает.

### Как применить `migrate-v2.4.sql`

1. Supabase → **SQL Editor** → **New query**.
2. Перед запуском сделайте бэкап: **Database → Backups** (или выгрузите дамп).
3. Откройте `database/migrate-v2.4.sql`, скопируйте файл **целиком** и вставьте
   в редактор → **Run**.
4. Посмотрите результаты запросов и вкладку **Notices**. Их должно быть два:
   * **БЛОК 3** — самопроверка колонок: **8 строк со статусом `ok`**;

   | column_name | data_type | status |
   | --- | --- | --- |
   | delivered_at | timestamp with time zone | ok |
   | invoice_file_name | text | ok |
   | invoice_path | text | ok |
   | invoice_total | numeric | ok |
   | invoice_uploaded_at | timestamp with time zone | ok |
   | paid_at | timestamp with time zone | ok |
   | paid_by_employee_id | bigint | ok |
   | payment_status | text | ok |

   * **БЛОК 4в** — проверка статусов: строка `orders_status_check = ok`. Если
     там `MISSING — delivered запрещён`, значит старое ограничение снять не
     удалось (смотрите Notices) — без этого заявка не закроется, см. раздел
     «Если заявка не закрывается» ниже.

5. Обновите приложение в браузере (Ctrl+F5) и повторите действие, которое падало.

Что делает миграция: добавляет в `orders` восемь колонок (`invoice_path`,
`invoice_file_name`, `invoice_uploaded_at`, `invoice_total`, `payment_status`,
`delivered_at`, `paid_at`, `paid_by_employee_id`), ставит `payment_status`
значение по умолчанию `'paid'`, переводит в `'paid'` уже существующие заявки,
а также снимает устаревшее CHECK-ограничение `orders_status_check` и ставит его
заново со списком статусов, который знает код (`new`, `in_progress`,
`delivered`, `closed`, `archived`).
Отдельного бакета Storage не нужно: счета лежат в бакете чеков.

Повторный запуск безопасен.

### Как применить `migrate-v2.5.sql`

Файл нужен, когда приложение жалуется на колонки **НДС и своей доставки**: `invoice_price_mode`,
`invoice_vat_rate`, `vat_total`, `own_delivery_charge`, `own_delivery_employee_id`,
`own_delivery_vat_rate` (в `orders`), `vat_rate`, `vat_amount`, `price_with_vat`, `delivery_kind`
(в `order_items`), `vat_rate`, `vat_amount` (в `cash_operations`).

1. Supabase → **SQL Editor** → **New query**. Бэкап — как в шаге 2 выше.
2. Откройте `database/migrate-v2.5.sql`, скопируйте файл **целиком** и вставьте в редактор → **Run**.
3. Посмотрите результат запроса — самопроверка в конце файла даёт **12 строк со статусом `ok`**:

   | table_name | column_name | status |
   | --- | --- | --- |
   | cash_operations | vat_rate | ok |
   | cash_operations | vat_amount | ok |
   | order_items | vat_rate | ok |
   | order_items | vat_amount | ok |
   | order_items | price_with_vat | ok |
   | order_items | delivery_kind | ok |
   | orders | invoice_price_mode | ok |
   | orders | invoice_vat_rate | ok |
   | orders | vat_total | ok |
   | orders | own_delivery_charge | ok |
   | orders | own_delivery_employee_id | ok |
   | orders | own_delivery_vat_rate | ok |

   Где `MISSING — примените файл целиком` — запустите файл ещё раз; во вкладке **Notices**
   по каждой неудачной колонке будет точная ошибка базы.
4. В **Notices** будет ещё два сообщения про уже созданные строки доставки: сколько строк
   «Доставка» помечено доставкой поставщика (`delivery_kind = 'supplier'`), а «Доставка компании» —
   своей (`delivery_kind = 'company'`). Имена строк и суммы не меняются.
5. Обновите приложение (Ctrl+F5) и сохраните счёт ещё раз: в окне счёта появятся блоки
   «🧮 ПДВ в счёте» и «🚚 Чья доставка», а в «📊 Реестре материалов» — колонка «в т.ч. ПДВ».

Что делает миграция:

* добавляет 12 колонок (6 в `orders`, 4 в `order_items`, 2 в `cash_operations`) — каждая отдельным
  защищённым блоком (`add column if not exists` + `exception when others`), поэтому «наполовину
  применённой» она не остаётся: один упавший `alter table` не отменяет остальные;
* заполняет `delivery_kind` у уже созданных строк по имени (раньше вид доставки читался только по
  тексту строки, и её нельзя было переименовать без риска развалить учёт);
* просит PostgREST перечитать схему (`notify pgrst, 'reload schema'`) — иначе приложение ещё
  несколько минут получает «Could not find the … column in the schema cache».

Повторный запуск безопасен. Значения, которые пишет приложение, совпадают с `js/config.js`
(`CONFIG.VAT.MODE` → `with_vat` / `without_vat`, `CONFIG.DELIVERY_ITEM.CHARGE` → `snagach` /
`employee` / `firm`, `CONFIG.DELIVERY_ITEM.TYPE` → `supplier` / `company`), а согласованность
«миграция ↔ схема ↔ код ↔ словарь» стережёт прогон `tools/checks/vat-check.mjs`.

То же самое одним запросом (для отчёта «сколько колонок v2.5.0 есть»):

```sql
select count(*) as columns_present
from information_schema.columns
where table_schema = 'public' and (
    (table_name = 'orders' and column_name in (
        'invoice_price_mode', 'invoice_vat_rate', 'vat_total',
        'own_delivery_charge', 'own_delivery_employee_id', 'own_delivery_vat_rate')) or
    (table_name = 'order_items' and column_name in (
        'vat_rate', 'vat_amount', 'price_with_vat', 'delivery_kind')) or
    (table_name = 'cash_operations' and column_name in ('vat_rate', 'vat_amount'))
);
```

Должно быть `12`. Меньше — примените `database/migrate-v2.5.sql` целиком.

То же самое можно проверить без SQL Editor — прогоном `tools/checks/schema-live-check.mjs`
(из папки `tools/checks`: `node schema-live-check.mjs`). Он спрашивает боевую базу тем же
запросом, что и приложение (`select ... limit=1` через `/rest/v1/`), печатает `ok` / `FAIL`
по каждой колонке v2.4.0 и v2.5.0 и в конце называет файл миграции, который надо применить
(а для «наполовину применённой» миграции — что запустить файл нужно ещё раз целиком).
Запись в базу не выполняется, так что запускать можно в любой момент.

### Как применить `migrate-v2.6.sql`

Файл нужен, когда заявка на финансирование **не убирается в архив** («📥 В архив») или
**не возвращается на доработку** («✏️ На доработку»), а база отклоняет запись:
`new row for relation "cash_requests" violates check constraint "cash_requests_status_check"`
(SQLSTATE `23514`). Колонок эта миграция **не добавляет** — она правит только CHECK-ограничение
списка статусов таблицы `cash_requests`.

1. Supabase → **SQL Editor** → **New query**. Отдельный бэкап можно не делать: файл колонок не
   трогает и содержимое таблиц не меняет — только список разрешённых значений статуса.
2. Откройте `database/migrate-v2.6.sql`, скопируйте файл **целиком** и вставьте в редактор → **Run**.
3. Сначала появится таблица **БЛОК 1**: какое ограничение стоит на `cash_requests.status` сейчас и
   под каким именем. Это отчёт — ничего не меняется.
4. Потом — результат **БЛОК 4**: нужно **шесть строк со статусом `ok`**:

   | status_value | status |
   | --- | --- |
   | approved | ok |
   | archived | ok |
   | issued | ok |
   | pending | ok |
   | rejected | ok |
   | revision | ok |

   Где `MISSING — примените файл целиком` — запустите файл ещё раз; во вкладке **Notices** будет
   точная ошибка базы (например, нет прав на `alter table`).
5. В **Notices** будет ещё две строки: `ok: снято устаревшее ограничение …` (либо
   `ok: устаревших ограничений на cash_requests.status нет`) и
   `ok: cash_requests_status_check обновлено — archived разрешён`.
6. Обновите приложение (Ctrl+F5) и нажмите «📥 В архив» ещё раз: заявка должна уйти в архив и
   показаться под фильтром «📥 Архив».

Что делает миграция:

* снимает с `cash_requests.status` устаревшие CHECK-ограничения — те, в которых **нет** `archived`.
  Ищутся они по определению, а не по имени: на боевой базе имя могло отличаться от
  `cash_requests_status_check`;
* ставит ограничение заново со всеми **шестью** статусами приложения
  (`js/modules/cash-requests.js` → `getCashRequestStatusInfo`):
  `pending | approved | revision | rejected | issued | archived`;
* снятие и постановка ограничения — две отдельные защищённые операции (`exception when others`):
  обрыв скрипта не оставляет таблицу без ограничения, а ошибка печатается в **Notices**, а не
  проглатывается молча;
* просит PostgREST перечитать схему (`notify pgrst, 'reload schema'`) — иначе приложение ещё
  несколько минут считает, что статуса `archived` в списке нет.

Проверить, что ограничение обновилось, можно одним запросом:

```sql
select pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'cash_requests'::regclass and conname = 'cash_requests_status_check';
```

В ответе должен быть весь список:
`status = ANY (ARRAY['pending'::text, 'approved'::text, 'revision'::text, 'rejected'::text, 'issued'::text, 'archived'::text])`.
Если строк нет вообще — ограничения на список статусов нет (архив работает, но список ничем не
проверяется: запустите файл ещё раз). Повторный запуск файла безопасен.

⚠️ Прогон `tools/checks/schema-live-check.mjs` эту миграцию **не видит**: он проверяет колонки
v2.4.0 и v2.5.0, а v2.6.0 колонок не добавляет. Состояние ограничения проверяется только запросом
выше (SQL Editor) или прогоном `tools/checks/migration-run-check.mjs` — он выполняет файл в
настоящем Postgres и проверяет, что архив и доработка после него работают.

### Если заявка не закрывается: `violates check constraint "orders_status_check"`

Так выглядит вторая половина той же истории: колонки в базе уже есть, счёт
сохраняется и уходит финансисту, а кнопка **«🚚 Доставлено на объект»** отвечает

```
Ошибка закрытия заявки: new row for relation "orders" violates check constraint "orders_status_check"
```

(SQLSTATE `23514`). Причина: на колонке `orders.status` с прежних версий висит
CHECK-ограничение со списком статусов, где **нет** нового статуса `delivered`
(в v2.4.0 закупка закрывается именно им). Приложение пишет `status = 'delivered'`
— база отклоняет запись.

Что делать: применить `database/migrate-v2.4.sql` **целиком** ещё раз либо (быстрее)
запустить служебный файл **`database/fix-orders-status-check.sql`** — он делает ровно
этот шаг: снимает устаревшее ограничение и ставит новое. БЛОК 4 миграции делает то же
самое:

```sql
check (status in ('new', 'in_progress', 'delivered', 'closed', 'archived'))
```

Проверить, что ограничение обновилось (БЛОК 4в — тот же запрос отдельно):

```sql
select coalesce(conname, '— ограничений на orders.status нет —') as constraint_name,
       coalesce(pg_get_constraintdef(oid), 'status — обычный text') as definition,
       case when oid is null or pg_get_constraintdef(oid) ~ '\ydelivered\y'
            then 'ok' else 'MISSING — delivered запрещён: примените файл целиком' end as status
from (select 1) as one
left join lateral (
    select conname, oid
    from pg_constraint
    where conrelid = 'orders'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ '\ystatus\y'
) as k on true;
```

Ожидается `ok`. В приложении это же видно тостом: вместо английской строки
Postgres приложение пишет «База отклонила запись: в таблице «orders» сработало
ограничение «orders_status_check» — в списке статусов нет «Доставлено на
объект». Примените database/migrate-v2.4.sql…» (`js/database.js` →
`explainError()`).

⚠️ Если будете добавлять новый статус заявки — допишите его и в это ограничение
(иначе повторится та же ошибка). Список статусов живёт в `js/config.js`
(`CONFIG.ORDER_STATUS`).

### Если заявка на финансы не уходит на доработку или в архив: `violates check constraint "cash_requests_status_check"`

Та же история, но про заявки на **финансирование** (таблица `cash_requests`): карточка на рабочем
экране не двигается, а в углу появляется тост приложения

```
База отклонила запись: в таблице «cash_requests» сработало ограничение
«cash_requests_status_check» — в списке статусов нет нужного значения
(«На доработке» или «В архиве»). Примените database/migrate-v2.6.sql
(Supabase → SQL Editor) и повторите действие.
```

Так отвечают кнопки **«📥 В архив»** (автор убирает законченную заявку) и **«✏️ На доработку»**
(директор возвращает заявку): приложение пишет `status = 'archived'` (появился в v2.6.0) или
`status = 'revision'` (появился в v2.2.0), а на `cash_requests.status` с прежних версий висит
CHECK-ограничение со списком статусов, где этих значений нет. Сырой ответ базы выглядит так:

```
new row for relation "cash_requests" violates check constraint "cash_requests_status_check"
```

(SQLSTATE `23514`).

Что делать: применить **`database/migrate-v2.6.sql`** (SQL Editor → файл целиком → Run) — он снимает
устаревшее ограничение и ставит список всех **шести** статусов приложения. Готовый к исполнению
список шагов, самопроверка и запрос для проверки — в разделе «Как применить `migrate-v2.6.sql`».
Ожидаемый результат:

```sql
check (status in ('pending', 'approved', 'revision', 'rejected', 'issued', 'archived'))
```

⚠️ Служебный файл `database/fix-cash-requests-status-check.sql` делает **только половину** этой
работы: он разрешает `revision` (возврат на доработку), но **не** `archived`. Если кнопка «📥 В
архив» всё ещё падает после него — нужен `migrate-v2.6.sql`; он же заменяет собой и этот файл.

⚠️ К заявкам на **материалы** это не относится: у `orders.status` статус `archived` разрешён с
v2.4.0 (БЛОК 4 в `database/migrate-v2.4.sql`), поэтому архив прораба по закупкам работает без
v2.6.0.

Если после Run архив всё ещё не работает, посмотрите **Notices**: там будет либо строка
`ok: cash_requests_status_check обновлено …`, либо точная ошибка базы (чаще всего нет прав на
`alter table`). Проверить ограничение можно запросом из раздела выше, а прогнать сценарий на
настоящем Postgres — `node tools/checks/migration-run-check.mjs` из папки `tools/checks`.

### Почему команды миграции «защищены» и это важно

SQL Editor выполняет скрипт до **первой** ошибки и остальные команды не делает.
Раньше в `migrate-v2.4.sql` шли восемь `alter table` подряд, и на боевой базе
получилось так: первые четыре колонки добавились, пятая упала — и оставшиеся
четыре **молча не применились**. Приложение после этого работало «наполовину»:
счёт сохранялся без статуса оплаты, доставка не проходила, у финансиста пусто.

Поэтому теперь каждая колонка добавляется в своём блоке `do $$ ... exception
when others ... $$`, скрипт всегда доходит до конца, а про неудачу пишет в
**Notices** точную ошибку базы, например:

```
WARNING: НЕ ДОБАВЛЕНО — orders.payment_status: permission denied for relation orders (42501)
```

### Если применилась только часть колонок

Запустите обновлённый файл целиком ещё раз — он добавит то, чего
не хватает, а существующие колонки не тронет (`if not exists`). Самопроверка
(**БЛОК 3** у v2.4.0, таблица из 12 строк у v2.5.0) покажет, что осталось.
Для `migrate-v2.5.sql` это особенно безопасно: там **каждая** колонка — отдельный
защищённый блок, поэтому падение одной не отменяет остальные.

Если на боевой базе не хватает ровно тех четырёх колонок, которые не успели
добавиться (проверьте самопроверкой!), можно выполнить только их:

```sql
do $$
declare definition text;
begin
    foreach definition in array array[
        'payment_status text',
        'delivered_at timestamptz',
        'paid_at timestamptz',
        'paid_by_employee_id bigint references employees(id)'
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

alter table orders alter column payment_status set default 'paid';
update orders set payment_status = 'paid' where payment_status is null;

notify pgrst, 'reload schema';
```

### Проверка, что миграция применилась

Самый простой способ — самопроверка из миграции (**БЛОК 3**). Она же полезна как
отдельный запрос:

```sql
select c.name as column_name,
       coalesce(a.atttypid::regtype::text, '—') as data_type,
       case when a.attname is null then 'MISSING — добавить не удалось' else 'ok' end as status
from (values ('delivered_at'), ('invoice_file_name'), ('invoice_path'),
             ('invoice_total'), ('invoice_uploaded_at'), ('paid_at'),
             ('paid_by_employee_id'), ('payment_status')) as c(name)
left join pg_attribute a
       on a.attrelid = 'orders'::regclass
      and a.attname::text = c.name
      and a.attnum > 0
      and not a.attisdropped
order by c.name, 3;
```

Ожидаемый результат — **8 строк `ok`**. Если есть `MISSING` — миграция не
применилась (или применилась частично): смотрите **Notices**, там точная ошибка.

То же самое одним запросом (для отчёта «сколько колонок из восьми есть»):

```sql
select count(*) as columns_present
from information_schema.columns
where table_name = 'orders' and column_name in (
    'invoice_path', 'invoice_file_name', 'invoice_uploaded_at', 'invoice_total',
    'payment_status', 'delivered_at', 'paid_at', 'paid_by_employee_id'
);
```

Должно быть `8`. Меньше — миграция не применена (или применена частично).


Проверка «глазами»: заявка «В обработке» → кнопка **«🚚 Доставлено на объект»** →
заявка должна закрыться без ошибки и появиться в «📊 Реестр материалов».

## Если миграция не применена — что видно в приложении

PostgREST отвечает по-английски, поэтому такие ошибки переведены
(`js/database.js` → `explainError()`), и в интерфейсе видно, чего именно не
хватает, **какой файл миграции применить** и что делать:

* **раздел «📦 Снабжение»** — жёлтая плашка над списком заявок
  (`#orders-warning`, заполняет `js/modules/orders.js → loadOrders()`);
* **раздел «📊 Реестр материалов»** — такая же плашка `#registry-warning`;
* **блок «🧾 Счета на материалы»** у финансиста — красная строка «Не удалось
  загрузить счета: …» (`js/modules/invoices.js`);
* **любое сохранение** («Сохранить счёт», «Доставлено на объект», «Оплачено») —
  тост с текстом:

```
База данных не обновлена: в таблице «orders» нет колонки «payment_status».
Примените database/migrate-v2.4.sql (Supabase → SQL Editor) и повторите действие.

База данных не обновлена: в таблице «orders» нет колонки «invoice_price_mode».
Примените database/migrate-v2.5.sql (Supabase → SQL Editor) и повторите действие.
```

Файл в подсказке выбирается по **имени отсутствующей колонки** (`js/database.js` →
`MIGRATIONS`): колонки НДС и своей доставки ведут к `migrate-v2.5.sql`, счёт поставщика,
доставка и оплата заявки — к `migrate-v2.4.sql`. Так администратор не запускает не тот файл
и не видит ту же ошибку второй раз.

Сырые ответы базы, по которым легко узнать эту ситуацию:

| Ответ | Когда приходит |
| --- | --- |
| `column orders.payment_status does not exist` (42703) | чтение `orders` — списки заявок, реестр, счета финансиста |
| `column orders.delivered_at does not exist` (42703) | то же: в списке/реестре запрошена отсутствующая колонка |
| `Could not find the 'delivered_at' column of 'orders' in the schema cache` (PGRST204) | запись — «Доставлено на объект» |
| `Could not find the 'payment_status' column of 'orders' in the schema cache` (PGRST204) | запись — «Сохранить счёт» (именно это видно на боевой базе после половины миграции) |
| `Could not find the 'vat_rate' column of 'order_items' in the schema cache` (PGRST204) | запись — «Сохранить счёт» на базе без v2.5.0 (НДС и своя доставка) |
| `column orders.vat_total does not exist` (42703) | чтение `orders` — реестр и счета финансиста на базе без v2.5.0 |
| `new row for relation "orders" violates check constraint "orders_status_check"` (23514) | запись `orders` — «🚚 Доставлено на объект»: устаревшее ограничение статусов без `delivered` (см. «Если заявка не закрывается») |
| `new row for relation "cash_requests" violates check constraint "cash_requests_status_check"` (23514) | запись `cash_requests` — «📥 В архив» или «✏️ На доработку»: устаревшее ограничение статусов без `archived` и `revision` (см. «Если заявка на финансы не уходит на доработку или в архив») |

Порядок действий в этом случае один: применить **нужный** файл миграции целиком и обновить
приложение (Ctrl+F5). Какой именно — приложение пишет в подсказке:
`migrate-v2.4.sql` (счёт поставщика, статусы, оплата заявки), `migrate-v2.5.sql`
(НДС и своя доставка) или `migrate-v2.6.sql` (архив заявок на финансы; колонок не добавляет,
поэтому в этом разделе о нём речи нет — см. «Как применить `migrate-v2.6.sql`»).
Про нехватку колонок — «Если применилась только часть колонок».

