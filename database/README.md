# База данных: схема и миграции

Здесь лежит всё, что относится к базе Supabase (Postgres + Auth + Storage).

| Файл | Что это |
| --- | --- |
| `schema.sql` | Полная схема для **чистой** установки: таблицы, колонки, внешние ключи. Включает изменения v2.4.0 |
| `migrate-v2.4.sql` | Пошаговая миграция v2.4.0 для **уже работающей** базы: счёт поставщика по заявке, статус «Доставлено на объект», оплата счёта финансистом, обновление CHECK-ограничения `orders_status_check` |
| `fix-unconfirmed-users.sql` | Служебный скрипт: что делать с аккаунтами, застрявшими в «Email not confirmed» |
| `fix-orders-status-check.sql` | Служебный скрипт: если заявка не закрывается из-за устаревшего CHECK-ограничения `orders_status_check` (ошибка `23514`) — короткая правка вместо запуска всей миграции |

## Что делать с уже работающей базой

`schema.sql` — это **реконструкция** схемы по коду, а не дамп боевой базы: там нет индексов,
триггеров, политик RLS и настроек Storage. Поэтому на работающем проекте применяют
**миграции по порядку**, а не `schema.sql`.

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

Запустите обновлённый `migrate-v2.4.sql` целиком ещё раз — он добавит то, чего
не хватает, а существующие колонки не тронет (`if not exists`). Самопроверка
(**БЛОК 3**) покажет, что осталось.

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

PostgREST отвечает по-английски, поэтому в v2.4.0 такие ошибки переведены
(`js/database.js` → `explainError()`), и в интерфейсе видно, чего именно не
хватает и что делать:

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
```

Сырые ответы базы, по которым легко узнать эту ситуацию:

| Ответ | Когда приходит |
| --- | --- |
| `column orders.payment_status does not exist` (42703) | чтение `orders` — списки заявок, реестр, счета финансиста |
| `column orders.delivered_at does not exist` (42703) | то же: в списке/реестре запрошена отсутствующая колонка |
| `Could not find the 'delivered_at' column of 'orders' in the schema cache` (PGRST204) | запись — «Доставлено на объект» |
| `Could not find the 'payment_status' column of 'orders' in the schema cache` (PGRST204) | запись — «Сохранить счёт» (именно это видно на боевой базе после половины миграции) |
| `new row for relation "orders" violates check constraint "orders_status_check"` (23514) | запись `orders` — «🚚 Доставлено на объект»: устаревшее ограничение статусов без `delivered` (см. «Если заявка не закрывается») |

Порядок действий в этом случае один: применить `migrate-v2.4.sql` целиком
(см. «Если применилась только часть колонок») и обновить приложение (Ctrl+F5).

