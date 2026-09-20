# База данных: схема и миграции

Здесь лежит всё, что относится к базе Supabase (Postgres + Auth + Storage).

| Файл | Что это |
| --- | --- |
| `schema.sql` | Полная схема для **чистой** установки: таблицы, колонки, внешние ключи. Включает изменения v2.4.0 |
| `migrate-v2.4.sql` | Пошаговая миграция v2.4.0 для **уже работающей** базы: счёт поставщика по заявке, статус «Доставлено на объект», оплата счёта финансистом |
| `fix-unconfirmed-users.sql` | Служебный скрипт: что делать с аккаунтами, застрявшими в «Email not confirmed» |

## Что делать с уже работающей базой

`schema.sql` — это **реконструкция** схемы по коду, а не дамп боевой базы: там нет индексов,
триггеров, политик RLS и настроек Storage. Поэтому на работающем проекте применяют
**миграции по порядку**, а не `schema.sql`.

### Как применить `migrate-v2.4.sql`

1. Supabase → **SQL Editor** → **New query**.
2. Перед запуском сделайте бэкап: **Database → Backups** (или выгрузите дамп).
3. Откройте `database/migrate-v2.4.sql`, скопируйте **БЛОК 1** и вставьте в редактор → **Run**.
   Блок добавляет в таблицу `orders` восемь колонок:
   `invoice_path`, `invoice_file_name`, `invoice_uploaded_at`, `invoice_total`,
   `payment_status`, `delivered_at`, `paid_at`, `paid_by_employee_id`.
4. Повторите то же для **БЛОКА 2** (он только проверяет, что у `orders.status` нет
   CHECK-констрейнта — новый статус `delivered` добавлять в базу не нужно).
5. Обновите приложение в браузере (Ctrl+F5) и повторите действие, которое падало.

Повторный запуск безопасен: все команды идут с `if not exists`, а `update`
затрагивает только строки с пустым `payment_status`.

### Проверка, что миграция применилась

```sql
select column_name, data_type
from information_schema.columns
where table_name = 'orders' and column_name in (
    'invoice_path', 'invoice_file_name', 'invoice_uploaded_at', 'invoice_total',
    'payment_status', 'delivered_at', 'paid_at', 'paid_by_employee_id'
)
order by column_name;
```

Ожидаемый результат — **8 строк**. Если строк меньше, миграция не применилась.

Проверка «глазами»: заявка «В обработке» → кнопка **«🚚 Доставлено на объект»** →
заявка должна закрыться без ошибки и появиться в «📊 Реестр материалов».

## Если миграция не применена — что видно в приложении

PostgREST отвечает по-английски, поэтому в v2.4.0 такие ошибки переведены
(`js/database.js` → `explainError()`), а в разделе «📊 Реестр» появляется
жёлтая плашка:

```
База данных не обновлена: в таблице «orders» нет колонки «invoice_file_name».
Примените database/migrate-v2.4.sql (Supabase → SQL Editor) и повторите действие.
```

Сырые ответы базы, по которым легко узнать эту ситуацию:

* `Could not find the 'delivered_at' column of 'orders' in the schema cache` — при закрытии заявки;
* `column orders.payment_status does not exist` — при загрузке реестра и счетов.
