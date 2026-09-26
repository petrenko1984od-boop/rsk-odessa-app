// =====================================================================
// FREEDOM — СЛОЙ РАБОТЫ С БАЗОЙ ДАННЫХ
// =====================================================================
// Универсальный «посредник» между модулями и Supabase.
// Модули НЕ обращаются к Supabase напрямую — только через эти функции.
//
// Все функции возвращают { data, error } — как в самом Supabase.
// Это позволяет обрабатывать ошибки единообразно.
// =====================================================================

import { supabase } from './config.js';
import { log } from './utils.js';

// =====================================================================
// ЗАЩИТА ДАННЫХ: UPDATE / DELETE БЕЗ УСЛОВИЙ
// =====================================================================
// UPDATE и DELETE без фильтров в Supabase меняют/удаляют ВСЮ таблицу.
// Один забытый аргумент — и можно потерять всю базу, поэтому здесь
// любые массовые операции без условий блокируются на уровне слоя БД.
// =====================================================================

// =====================================================================
// ПОНЯТНАЯ ОШИБКА, КОГДА ТАБЛИЦА НЕ ОБНОВЛЕНА
// =====================================================================
// PostgREST отвечает 42703 («column orders.invoice_file_name does not
// exist») или PGRST204 («Could not find the 'invoice_file_name' column of
// 'orders' in the schema cache»), когда в базе нет колонки, которую знает
// код. Причина всегда одна — не применена миграция (database/migrate-*.sql),
// но по английскому тексту это не видно, и сотрудник видит «сохранение не
// удалось» без объяснений. Здесь такие ошибки превращаются в подсказку с
// именем колонки и файлом миграции.
// =====================================================================

let schemaWarningShown = false;

// Какая миграция добавила какие колонки. Нужна, чтобы подсказка называла
// ИМЕННО тот файл, который лечит ошибку: колонки НДС и своей доставки приносит
// database/migrate-v2.5.sql, и снабженец, которому посоветовали бы v2.4.0,
// применил бы её и получил бы ту же ошибку второй раз.
//
// version — версия САМОЙ МИГРАЦИИ (не приложения!), и в подсказке для консоли
// печатается именно она. Раньше там стояла версия приложения, и при
// отсутствующей колонке из v2.4.0 (payment_status) администратор читал
// «база не обновлена под v2.5.0» — то есть не про тот файл, который нужен.
const MIGRATIONS = [
    {
        file: 'database/migrate-v2.5.sql',
        version: '2.5.0',
        why: 'НДС, режим цены счёта и своя доставка',
        columns: [
            'invoice_price_mode',
            'invoice_vat_rate',
            'vat_total',
            'own_delivery_charge',
            'own_delivery_employee_id',
            'own_delivery_vat_rate',
            'vat_rate',
            'vat_amount',
            'price_with_vat',
            'delivery_kind'
        ]
    },
    {
        file: 'database/migrate-v2.4.sql',
        version: '2.4.0',
        why: 'счёт поставщика, доставка и оплата заявок',
        columns: [
            'invoice_path',
            'invoice_file_name',
            'invoice_uploaded_at',
            'invoice_total',
            'payment_status',
            'delivered_at',
            'paid_at',
            'paid_by_employee_id'
        ]
    }
];

/**
 * Миграция, которая добавляет колонку. Для незнакомого имени возвращает
 * базовую v2.4.0 — на ней держится счёт поставщика целиком.
 * @returns {{ file: string, version: string, why: string }}
 */
function migrationForColumn(column) {
    const name = String(column || '').toLowerCase();
    return MIGRATIONS.find(item => item.columns.includes(name)) || MIGRATIONS[MIGRATIONS.length - 1];
}

/**
 * Достаёт из ошибки PostgREST имя отсутствующей колонки и таблицы.
 * @returns {{ table: string|null, column: string }|null}
 */
function parseMissingColumn(error) {
    const message = error?.message || '';
    if (!message) return null;

    // «Could not find the 'invoice_file_name' column of 'orders' in the schema cache»
    let match = message.match(/Could not find the '([^']+)' column of '([^']+)'/i);
    if (match) return { table: match[2], column: match[1] };

    // «column orders.invoice_file_name does not exist»
    match = message.match(/column (?:"?([\w]+)"?\.)?"?([\w]+)"? does not exist/i);
    if (match) return { table: match[1] || null, column: match[2] };

    return null;
}

/**
 * Достаёт из ошибки имя CHECK-ограничения, которое не пропустило запись.
 * Postgres: «new row for relation "orders" violates check constraint
 * "orders_status_check"» (SQLSTATE 23514). Так выглядит УСТАРЕВШЕЕ ограничение
 * на список значений: например, в базе список статусов заявки старее
 * приложения, и она запрещает новый статус ('delivered' у заявок на материалы,
 * 'revision' у заявок на финансы) — сотрудник видит «заявка не закрывается»
 * или «на доработку не отправляется» и не понимает, что делать.
 * @returns {{ table: string|null, constraint: string }|null}
 */
function parseCheckViolation(error) {
    const message = error?.message || '';
    if (!message) return null;

    const match = message.match(/violates check constraint "([^"]+)"/i);
    if (!match) return null;

    return {
        table: (message.match(/relation "([^"]+)"/i) || [])[1] || null,
        constraint: match[1]
    };
}

// Коды, которыми база отвечает на серверные команды (v2.8.0):
//   28000 — аккаунт не привязан к активному сотруднику;
//   42501 — у роли нет права на действие (или не обновлены политики RLS);
//   22023 — неверный параметр (пустой объект, чужая секция, сумма <= 0);
//   P0001 — правило бизнес-логики (например, «заявка не одобрена»);
//   P0002 — объект не найден.
const RPC_ERROR_CODES = new Set(['28000', '42501', '22023', 'P0001', 'P0002']);

/**
 * Ошибка серверной команды (RPC, v2.8.0) — понятный текст для сотрудника.
 *
 * Нужна отдельно от остальных разборов потому, что здесь причина чаще всего
 * в САМОЙ БАЗЕ, а не в данных: команду выполняет база и она же отказывает
 * («Нет права создавать заявку на материалы», «Заявка должна быть в статусе
 * «Одобрено»»). Тексты база пишет по-русски, поэтому их достаточно показать.
 *
 * @returns {string|null} текст ошибки или null, если это не отказ RPC
 */
function parseRpcFailure(error) {
    const message = error?.message || '';
    const code = String(error?.code || '');

    // PostgREST не нашёл функцию: база не обновлена под v2.8.0. Без этой
    // подсказки сотрудник читает английское «Could not find the function
    // public.create_cash_request_with_items(...)» и не знает, что делать.
    if (code === 'PGRST202' || /could not find the function/i.test(message)) {
        log.error('⚠ В базе нет серверной команды (RPC) — база не обновлена под v2.8.0');
        log.error('⚠ Выполните database/migrate-v2.8-finance-rpc-audit.sql в Supabase → SQL Editor.');
        return 'База данных не обновлена: в ней нет серверной команды, которой приложение создаёт заявки. ' +
            'Примените database/migrate-v2.8-finance-rpc-audit.sql (Supabase → SQL Editor) и повторите действие.';
    }

    if (!RPC_ERROR_CODES.has(code)) return null;

    if (code === '42501') {
        log.error('⚠ База отклонила действие по правам:', message);
        log.error('⚠ Права выдаёт роль сотрудника (раздел «Сотрудники»); политики баз — database/migrate-v2.7-rls-finance.sql, команды — v2.8.0.');
        return 'База отклонила действие: у вашей роли нет этого права. ' +
            'Проверьте роль сотрудника в разделе «Сотрудники». Если роль верная — база не обновлена под v2.7.0/v2.8.0: ' +
            'примените database/migrate-v2.7-rls-finance.sql и database/migrate-v2.8-finance-rpc-audit.sql (Supabase → SQL Editor).';
    }

    if (code === '28000') {
        log.error('⚠ Аккаунт не привязан к активному сотруднику:', message);
        return `${message}. Откройте раздел «Сотрудники»: запись должна быть активна и привязана к вашему e-mail.`;
    }

    // Остальные отказы (22023, P0001, P0002) база формулирует по-русски и
    // адресует сотруднику — показываем их как есть.
    log.error('⚠ База отклонила команду:', code, message);
    return message || 'База отклонила действие';
}

/**
 * Текст ошибки для сотрудника. Для отсутствующей колонки и устаревшего
 * CHECK-ограничения возвращает понятную инструкцию, для остальных —
 * исходное сообщение.
 */
export function explainError(error) {
    // Отказ серверной команды (v2.8.0) объясняет сама база, и чаще всего он
    // не про колонки: показываем её текст (и подсказку про миграцию).
    const rpcFailure = parseRpcFailure(error);
    if (rpcFailure) return rpcFailure;

    const missing = parseMissingColumn(error);
    if (!missing) {
        // Не колонка — возможно, база отклонила значение по ограничению.
        const check = parseCheckViolation(error);
        if (!check) return error?.message || String(error || 'Неизвестная ошибка');

        const where = check.table ? `в таблице «${check.table}»` : 'в базе данных';

        // Ограничение на список СТАТУСОВ заявки. Их два, и лечатся они разными
        // файлами:
        //   orders_status_check        — заявки на материалы: статус 'delivered'
        //                                появился в v2.4.0 (БЛОК 4 миграции);
        //   cash_requests_status_check — заявки на финансы: статус 'revision'
        //                                («✏️ На доработку») появился в v2.2.0,
        //                                а статус 'archived' («📥 В архив») —
        //                                в v2.6.0; всё это разрешает
        //                                database/migrate-v2.6.sql.
        // Подсказка зависит от таблицы: иначе директор, нажимая «На доработку»,
        // читал бы про «Доставлено на объект» и правил не то ограничение.
        if (/cash_request/i.test(`${check.table || ''} ${check.constraint}`)) {
            log.error(`⚠ ${where} сработало ограничение «${check.constraint}»: в списке статусов нет нужного значения`);
            log.error('⚠ Выполните database/migrate-v2.6.sql в Supabase → SQL Editor: он разрешает «На доработке» и «В архиве».');
            return `База отклонила запись: ${where} сработало ограничение «${check.constraint}» — в списке статусов нет нужного значения («На доработке» или «В архиве»). ` +
                'Примените database/migrate-v2.6.sql (Supabase → SQL Editor) и повторите действие.';
        }

        if (/status/i.test(check.constraint)) {
            log.error(`⚠ ${where} сработало ограничение «${check.constraint}»: список статусов в базе старее приложения`);
            log.error('⚠ Выполните database/migrate-v2.4.sql в Supabase → SQL Editor: он обновляет это ограничение и добавляет статус «Доставлено на объект».');
            return `База отклонила запись: ${where} сработало ограничение «${check.constraint}» — в списке статусов нет «Доставлено на объект». ` +
                'Примените database/migrate-v2.4.sql (или короткий database/fix-orders-status-check.sql) в Supabase → SQL Editor и повторите действие.';
        }

        log.error(`⚠ ${where} сработало ограничение «${check.constraint}» — запись не прошла`);
        return `База отклонила запись: ${where} сработало ограничение «${check.constraint}». ` +
            'Значение не подходит по правилам базы — сообщите администратору.';
    }

    const where = missing.table ? `в таблице «${missing.table}»` : 'в базе данных';
    const migration = migrationForColumn(missing.column);

    if (!schemaWarningShown) {
        schemaWarningShown = true;
        // Версия — из самой миграции (migration.version), а не CONFIG.APP.VERSION:
        // иначе при старой базе консоль обещала бы v2.5.0 там, где нужен v2.4.0.
        log.error(`⚠ В таблице ${missing.table || '?'} нет колонки «${missing.column}» — база не обновлена под v${migration.version}`);
        log.error(`⚠ Выполните ${migration.file} в Supabase → SQL Editor: без этих колонок не сохраняются ${migration.why}.`);
    }

    return `База данных не обновлена: ${where} нет колонки «${missing.column}». ` +
        `Примените ${migration.file} (Supabase → SQL Editor) и повторите действие.`;
}

/**
 * Проверяет, что payload не пустой (нечего обновлять).
 * @returns {Error|null} — ошибка или null, если всё в порядке
 */
function validatePayload(table, payload, operation) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        log.error(`${operation} "${table}": payload отсутствует — операция отменена`);
        return new Error(`${operation}: не переданы данные для записи`);
    }

    if (Object.keys(payload).length === 0) {
        log.error(`${operation} "${table}": payload пустой — операция отменена`);
        return new Error(`${operation}: нечего обновлять (пустой объект данных)`);
    }

    return null;
}

/**
 * Проверяет, что фильтры заданы и есть хотя бы одно рабочее условие.
 * @returns {Error|null} — ошибка или null, если всё в порядке
 */
function validateFilters(table, filters, operation) {
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
        log.error(`${operation} "${table}": не переданы фильтры — операция отменена`);
        return new Error(`${operation}: не переданы условия. Операция отменена, чтобы не изменить всю таблицу.`);
    }

    const usable = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null);

    if (usable.length === 0) {
        log.error(`${operation} "${table}": все фильтры пустые — операция отменена`);
        return new Error(`${operation}: пустые условия. Операция отменена, чтобы не изменить всю таблицу.`);
    }

    return null;
}

// =====================================================================
// МОДУЛЬНАЯ БИБЛИОТЕКА ФИЛЬТРОВ
// =====================================================================
/**
 * Применяет одно условие к запросу.
 * Поддерживает операторы: { 'id.in': [1,2] }, { 'created_at.gte': '...' }
 *
 * v2.9.0 добавила два случая, без которых не собрать фильтр поиска и
 * «или» на СЕРВЕРЕ:
 *   * ilike — поиск по части строки без учёта регистра (номер заявки,
 *     поставщик, имя сотрудника): { 'supplier.ilike': '%труба%' };
 *   * or / and — готовое условие PostgREST целиком, когда колонки в ключе
 *     нет: { or: 'request_number.ilike.%труба%,supplier.ilike.%труба%' }.
 *     Собирает такое условие db.textSearch() — он же вычищает из текста
 *     символы, которые сломали бы разбор (запятая, скобки, проценты).
 *     Скобки вокруг значения добавляет сам supabase-js (в запрос уйдёт
 *     or=(...)) — свои добавлять не нужно: выйдет or=((...)) и PGRST100.
 */
function applyFilter(query, key, value) {
    // Условие целиком (без колонки в ключе) — отдаём в PostgREST как есть.
    if (key === 'or' || key === 'and') {
        return query[key](value);
    }

    if (!key.includes('.')) {
        return query.eq(key, value);
    }

    const [field, op] = key.split('.');

    switch (op) {
        case 'gte':   return query.gte(field, value);
        case 'lte':   return query.lte(field, value);
        case 'gt':    return query.gt(field, value);
        case 'lt':    return query.lt(field, value);
        case 'neq':   return query.neq(field, value);
        case 'in':    return query.in(field, Array.isArray(value) ? value : [value]);
        case 'like':  return query.like(field, value);
        case 'ilike': return query.ilike(field, value);
        case 'is':    return query.is(field, value);
        default:      return query.eq(field, value);
    }
}


/**
 * Сортировка запроса.
 *
 * Колонка может быть одна ({ column: 'created_at', asc: false }) или несколько
 * ([{ column: 'entry_at', asc: false }, { column: 'row_key', asc: false }]).
 * Список нужен там, где одного поля мало: у вида «Реестр материалов» строки
 * делят одну дату, и без второго поля они «прыгали» бы между страницами
 * (одна и та же строка пришли бы дважды, а другая — ни разу).
 */
function applyOrderBy(query, orderBy) {
    if (!orderBy) return query;

    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    let result = query;

    for (const item of list) {
        if (!item || !item.column) continue;
        result = result.order(item.column, { ascending: item.asc !== false });
    }

    return result;
}

// =====================================================================
// УНИВЕРСАЛЬНЫЕ CRUD-ОПЕРАЦИИ
// =====================================================================

/**
 * Получить записи из таблицы.
 * @param {string} table — имя таблицы ('projects', 'orders', ...)
 * @param {Object} options — { select, filters, orderBy, limit, single }
 * @returns {Promise<{ data, error }>}
 *
 * Примеры:
 *   await db.select('projects');
 *   await db.select('orders', { select: '*, order_items(*)', orderBy: { column: 'created_at', asc: false } });
 *   await db.select('projects', { filters: { id: 5 }, single: true });
 */
export async function select(table, options = {}) {
    const {
        select: columns = '*',
        filters = null,
        orderBy = null,
        limit = null,
        single = false
    } = options;

    log.db(`SELECT из "${table}"`, { columns, filters, orderBy, limit });

    try {
        let query = supabase.from(table).select(columns);

        // Применяем фильтры: { id: 5, status: 'new' } → .eq('id', 5).eq('status', 'new')
        if (filters && typeof filters === 'object') {
            for (const [key, value] of Object.entries(filters)) {
                if (value === undefined || value === null) continue;

                // Поддержка операторов: { 'price.gte': 100 }
                query = applyFilter(query, key, value);
            }
        }

        // Сортировка
        if (orderBy) {
            query = applyOrderBy(query, orderBy);
        }

        // Лимит
        if (limit) query = query.limit(limit);

        // Одна запись или массив
        if (single) query = query.maybeSingle();

        const { data, error } = await query;

        if (error) {
            log.error(`Ошибка SELECT "${table}":`, error.message);
            return { data: null, error };
        }

        return { data, error: null };

    } catch (err) {
        log.error(`Исключение в SELECT "${table}":`, err);
        return { data: null, error: err };
    }
}

// =====================================================================
// СТРАНИЦЫ (v2.9.0) — ЧИТАЕМ НЕ ВСЮ ТАБЛИЦУ, А ОДНУ СТРАНИЦУ
// =====================================================================
// До v2.9.0 список заявок грузил ВСЮ таблицу: 25 карточек на экране и,
// например, 40 000 строк из базы, из которых 39 975 тут же выбрасывались
// фильтром в браузере. Чем дольше работают объекты, тем медленнее
// открывался раздел — и тем больше памяти занимала вкладка.
//
// Здесь живёт серверная страница: PostgREST отдаёт РОВНО pageSize строк
// (.range → HTTP-заголовок Range) и, если попросить count: 'exact', ещё и
// общее число строк (заголовок Content-Range), не выгружая их.
//
//   const { data, count, page, totalPages } =
//       await db.selectPage('orders', {
//           select: 'id, request_number', filters: { status: 'new' },
//           orderBy: { column: 'created_at', asc: false }, page: 2
//       });
//
// ⚠️ data — это ТОЛЬКО страница. Всё, что должно считать по всем строкам
//    (итоги, план-факт, экспорт в Excel), обязано либо фильтровать на
//    сервере, либо брать полный набор через db.selectAllPaged() — иначе
//    сумма посчитается по одной странице и окажется меньше настоящей.
// =====================================================================

/** Сколько строк в странице по умолчанию. */
export const PAGE_SIZE = 25;

/** Больше этого числа строк за один запрос слой не отдаст, даже если
 *  модуль попросит: страница на 1000 карточек — это уже не список, а
 *  выгрузка (для выгрузки есть db.selectAllPaged). */
export const MAX_PAGE_SIZE = 100;

/**
 * Условие «или» для текстового поиска по нескольким колонкам.
 *
 *   db.textSearch(['request_number', 'supplier'], 'труба')
 *   → { or: 'request_number.ilike.%труба%,supplier.ilike.%труба%' }
 *   в запрос уйдёт: or=(request_number.ilike.%труба%,supplier.ilike.%труба%)
 *
 * Пустой текст → null: фильтр не добавляем (иначе поиск по «%» нашёл бы
 * всё и запрос всё равно стал бы полным перебором).
 *
 * ⚠️ Скобки вокруг условия НЕ ставим: supabase-js сам оборачивает значение
 *    `.or()` в скобки. Со своими скобками в запрос уходило or=((...)) — и
 *    боевая база отвечала PGRST100 «failed to parse logic tree», а поиск
 *    молча не находил ничего (прогон tools/checks/scale-check.mjs ловит это).
 *
 * Запятая, скобки, проценты и точка с запятой ВЫРЕЗАЮТСЯ из текста: в
 * PostgREST это служебные символы условия or, и «труба, 50» превратило бы
 * одно условие в два бессмысленных. Символы всё равно не помогли бы найти
 * ничего: в номере заявки и в названии поставщика их не бывает.
 *
 * @param {string[]} columns — колонки, по которым ищем
 * @param {string} text — то, что набрал сотрудник
 * @returns {Object|null} — готовый фильтр или null, если искать нечего
 */
export function textSearch(columns, text) {
    const term = String(text || '')
        .replace(/[,()%*;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!term || !columns || columns.length === 0) return null;

    const parts = columns.map((column) => `${column}.ilike.%${term}%`);
    return { or: parts.join(',') };
}

/**
 * Взять ОДНУ страницу записей вместе с общим количеством строк.
 *
 * @param {string} table
 * @param {Object} options — { select, filters, orderBy, page, pageSize }
 *        orderBy — { column, asc } ИЛИ список таких объектов: у вида реестра
 *        одной колонки мало, строки делят дату (см. applyOrderBy).
 * @returns {Promise<{ data, error, count, page, pageSize, totalPages, hasMore, from, to }>}
 *
 * count — сколько строк подходит под фильтр ВСЕГО (null, если база не
 * вернула Content-Range, например на моках в проверках). Интерфейс обязан
 * работать и с null: js/pagination.js тогда показывает «Показано N» вместо
 * «Показано 1-N из M».
 */
export async function selectPage(table, options = {}) {
    const {
        select: columns = '*',
        filters = null,
        orderBy = null,
        page = 1,
        pageSize = PAGE_SIZE
    } = options;

    const size = Math.min(Math.max(1, Math.floor(Number(pageSize) || PAGE_SIZE)), MAX_PAGE_SIZE);
    const current = Math.max(1, Math.floor(Number(page) || 1));
    const from = (current - 1) * size;
    const to = from + size - 1;

    log.db(`SELECT-СТРАНИЦА из "${table}"`, { columns, filters, orderBy, from, to });

    try {
        let query = supabase
            .from(table)
            .select(columns, { count: 'exact' });

        if (filters && typeof filters === 'object') {
            for (const [key, value] of Object.entries(filters)) {
                if (value === undefined || value === null) continue;
                query = applyFilter(query, key, value);
            }
        }

        if (orderBy) {
            query = applyOrderBy(query, orderBy);
        }

        const { data, error, count } = await query.range(from, to);

        if (error) {
            log.error(`Ошибка SELECT-СТРАНИЦА "${table}":`, error.message);
            return { data: null, error, count: null, page: current, pageSize: size };
        }

        const rows = data || [];
        // totalPages считаем только по достоверному count: при null
        // (мок/старый PostgREST) страниц «вперёд» не показываем.
        const totalPages = typeof count === 'number' ? Math.max(1, Math.ceil(count / size)) : null;

        return {
            data: rows,
            error: null,
            count: typeof count === 'number' ? count : null,
            page: current,
            pageSize: size,
            totalPages,
            hasMore: rows.length >= size,
            from: rows.length ? from + 1 : 0,
            to: from + rows.length
        };

    } catch (err) {
        log.error(`Исключение в SELECT-СТРАНИЦА "${table}":`, err);
        return { data: null, error: err, count: null, page: current, pageSize: size };
    }
}


/**
 * Взять ВСЕ строки страницами — для того, что честно считает по всему
 * набору: экспорт в Excel, план-факт объекта, реестр, итоги по всем
 * заявкам. Заменяет db.select() без фильтров там, где нужен полный набор.
 *
 * @param {string} table
 * @param {Object} options — { select, filters, orderBy, pageSize, maxRows }
 * @returns {Promise<{ data, error, fetched, truncated }>}
 *
 * truncated = true значит: строк больше, чем maxRows, и в data лежит только
 * часть. Модуль ОБЯЗАН сказать об этом сотруднику («показаны не все
 * строки — сузьте период»), а не молча посчитать половину суммы: молчаливое
 * усечение в деньгах — это неверный итог, за который отвечает бухгалтер.
 */
export async function selectAllPaged(table, options = {}) {
    const {
        select: columns = '*',
        filters = null,
        orderBy = null,
        pageSize = MAX_PAGE_SIZE,
        maxRows = 5000
    } = options;

    const size = Math.min(Math.max(1, Math.floor(Number(pageSize) || MAX_PAGE_SIZE)), MAX_PAGE_SIZE);
    const limit = Math.max(size, Math.floor(Number(maxRows) || 5000));
    const rows = [];

    log.db(`SELECT-ВСЁ "${table}" страницами`, { columns, filters, orderBy, pageSize: size, maxRows: limit });

    try {
        let page = 1;

        // Идём страницами, пока база отдаёт полные страницы. Ограничение —
        // предохранитель от бесконечного цикла, если база проигнорировала
        // .range() (так ведут себя моки в проверках): тогда выходим, как
        // только строк стало больше заявленного максимума.
        while (rows.length < limit) {
            let query = supabase.from(table).select(columns);
            const from = (page - 1) * size;

            if (filters && typeof filters === 'object') {
                for (const [key, value] of Object.entries(filters)) {
                    if (value === undefined || value === null) continue;
                    query = applyFilter(query, key, value);
                }
            }

            if (orderBy) {
                query = applyOrderBy(query, orderBy);
            }

            const { data, error } = await query.range(from, from + size - 1);

            if (error) {
                log.error(`Ошибка SELECT-ВСЁ "${table}":`, error.message);
                return { data: rows.length ? rows : null, error, fetched: rows.length, truncated: false };
            }

            const part = data || [];
            rows.push(...part);

            if (part.length < size) break;
            page += 1;
        }

        const truncated = rows.length > limit;
        if (truncated) {
            log.error(`SELECT-ВСЁ "${table}": строк больше ${limit} — вернул первые ${limit}`);
        }

        return {
            data: rows.slice(0, limit),
            error: null,
            fetched: Math.min(rows.length, limit),
            truncated
        };

    } catch (err) {
        log.error(`Исключение в SELECT-ВСЁ "${table}":`, err);
        return { data: rows.length ? rows : null, error: err, fetched: rows.length, truncated: false };
    }
}

/**
 * Вставить одну запись.
 * @param {string} table
 * @param {Object} payload
 * @returns {Promise<{ data, error }>}
 *
 * Пример: await db.insert('projects', { name: 'Коттедж', foreman_id: 3 });
 */
export async function insert(table, payload) {
    log.db(`INSERT в "${table}"`, payload);

    try {
        const { data, error } = await supabase
            .from(table)
            .insert(payload)
            .select()
            .single();

        if (error) {
            log.error(`Ошибка INSERT "${table}":`, error.message);
            return { data: null, error };
        }

        return { data, error: null };

    } catch (err) {
        log.error(`Исключение в INSERT "${table}":`, err);
        return { data: null, error: err };
    }
}

/**
 * Вставить несколько записей сразу (batch insert).
 * @param {string} table
 * @param {Array<Object>} rows
 * @returns {Promise<{ data, error }>}
 *
 * Пример: await db.insertMany('order_items', [{...}, {...}]);
 */
export async function insertMany(table, rows) {
    log.db(`BATCH INSERT в "${table}"`, `${rows.length} записей`);

    try {
        const { data, error } = await supabase
            .from(table)
            .insert(rows)
            .select();

        if (error) {
            log.error(`Ошибка BATCH INSERT "${table}":`, error.message);
            return { data: null, error };
        }

        return { data, error: null };

    } catch (err) {
        log.error(`Исключение в BATCH INSERT "${table}":`, err);
        return { data: null, error: err };
    }
}

/**
 * Обновить записи по фильтру.
 * @param {string} table
 * @param {Object} payload — что менять
 * @param {Object} filters — по какому условию
 * @returns {Promise<{ data, error }>}
 *
 * Пример: await db.update('orders', { status: 'closed' }, { id: 5 });
 */
export async function update(table, payload, filters) {
    const payloadGuard = validatePayload(table, payload, 'UPDATE');
    if (payloadGuard) return { data: null, error: payloadGuard };

    const filtersGuard = validateFilters(table, filters, 'UPDATE');
    if (filtersGuard) return { data: null, error: filtersGuard };
    log.db(`UPDATE "${table}"`, { payload, filters });

    try {
        let query = supabase.from(table).update(payload);

        for (const [key, value] of Object.entries(filters)) {
            query = applyFilter(query, key, value);
        }

        const { data, error } = await query.select();

        if (error) {
            log.error(`Ошибка UPDATE "${table}":`, error.message);
            return { data: null, error };
        }

        return { data, error: null };

    } catch (err) {
        log.error(`Исключение в UPDATE "${table}":`, err);
        return { data: null, error: err };
    }
}

/**
 * Удалить записи по фильтру.
 * @param {string} table
 * @param {Object} filters
 * @returns {Promise<{ data, error }>}
 *
 * Пример: await db.remove('projects', { id: 5 });
 */
export async function remove(table, filters) {
    const guard = validateFilters(table, filters, 'DELETE');
    if (guard) return { data: null, error: guard };
    log.db(`DELETE из "${table}"`, filters);

    try {
        let query = supabase.from(table).delete();

        for (const [key, value] of Object.entries(filters)) {
            query = applyFilter(query, key, value);
        }

        const { data, error } = await query;

        if (error) {
            log.error(`Ошибка DELETE "${table}":`, error.message);
            return { data: null, error };
        }

        return { data, error: null };

    } catch (err) {
        log.error(`Исключение в DELETE "${table}":`, err);
        return { data: null, error: err };
    }
}

/**
 * Посчитать записи в таблице с фильтром.
 * @returns {Promise<{ count, error }>}
 *
 * ⚠️ НЕ используйте count() для нумерации документов (номер заявки + 1):
 * COUNT(*) даёт дубли после удаления записей и в параллельных сессиях.
 * С v2.8.0 номер документа считает сама база внутри серверной команды
 * (create_order_with_items / create_cash_request_with_items) — под блокировкой
 * и в одной транзакции с записью заявки, см. db.rpc() ниже.
 */
export async function count(table, filters = null) {
    log.db(`COUNT в "${table}"`, filters);

    try {
        let query = supabase
            .from(table)
            .select('*', { count: 'exact', head: true });

        if (filters) {
            for (const [key, value] of Object.entries(filters)) {
                query = applyFilter(query, key, value);
            }
        }

        const { count: cnt, error } = await query;

        if (error) {
            log.error(`Ошибка COUNT "${table}":`, error.message);
            return { count: 0, error };
        }

        return { count: cnt || 0, error: null };

    } catch (err) {
        log.error(`Исключение в COUNT "${table}":`, err);
        return { count: 0, error: err };
    }
}

// =====================================================================
// СЕРВЕРНЫЕ КОМАНДЫ (RPC) — ТРАНЗАКЦИИ, версия 2.8.0
// =====================================================================
// С v2.8.0 заявки и деньги создаёт САМА БАЗА — одной серверной командой
// (RPC из database/migrate-v2.8-finance-rpc-audit.sql). Почему так:
//
//   * заголовок и позиции пишутся в ОДНОЙ транзакции — «заявка без позиций»
//     или «позиции без заявки» больше невозможны (раньше сбой между двумя
//     insert оставлял заявку с пустым списком работ);
//   * номер заявки считает база под блокировкой (pg_advisory_xact_lock),
//     поэтому две заявки, отправленные одновременно, не получают один и тот
//     же номер: браузерный «максимум за год + 1» такую коллизию допускал;
//   * права проверяет база по своей таблице ролей, а не только интерфейс:
//     кнопку можно спрятать, но запрос к API — нет;
//   * каждая команда попадает в public.audit_log: кто, что и когда, плюс
//     ключ идемпотентности — повторный запрос возвращает прежний результат,
//     а не создаёт вторую заявку.
//
// Прямые insert в orders и cash_requests из браузера миграция закрывает
// (`revoke insert`), поэтому такие записи делаются ТОЛЬКО через db.rpc(...).
// =====================================================================

/**
 * Имена серверных команд. Держим их в одном месте: опечатка в строке
 * приводит к ошибке PGRST202 («функция не найдена») уже в бою, а прогон
 * tools/checks/migration-check.mjs сверяет список с файлом миграции.
 */
export const RPC = {
    CREATE_ORDER: 'create_order_with_items',
    CREATE_CASH_REQUEST: 'create_cash_request_with_items',
    ISSUE_CASH_REQUEST: 'issue_cash_request',
    SAVE_OWN_DELIVERY_EXPENSE: 'save_own_delivery_expense'
};

/**
 * Команды раздела «📐 Сметы» (v2.10.0, database/migrate-v2.10-estimates.sql).
 *
 * Отдельный объект, а не дополнение к RPC выше: прогон
 * tools/checks/migration-check.mjs сверяет список финансовых команд v2.8.0 с
 * файлом migrate-v2.8-finance-rpc-audit.sql — их ровно четыре, и каждая в нём
 * объявлена. Положить сюда команды другой версии значило бы сломать эту
 * проверку (а вместе с ней — обещание, что «финансовые команды объявлены в
 * своей миграции»).
 */
export const RPC_ESTIMATES = {
    SAVE: 'save_estimate',               // сохранить смету целиком: шапка + разделы + позиции + лимиты
    DELETE: 'delete_estimate',           // удалить смету вместе с содержимым
    SET_STATUS: 'set_estimate_status'    // черновик ⇄ утверждена (из списка)
};

/**
 * Ключ идемпотентности — «номер попытки» серверной команды.
 *
 * Зачем: сеть и прокси иногда доставляют запрос дважды, а сотрудник — тем
 * более не ждёт и нажимает «Создать заявку» второй раз. База по этому ключу
 * узнаёт повтор и возвращает результат первой попытки вместо второй заявки
 * или второго расхода кассы (в audit_log ключ уникален).
 *
 * Новый ключ — на каждое НАМЕРЕНИЕ пользователя (один клик «Создать»), а не
 * на каждый сетевой вызов: поэтому повторная отправка того же самого действия
 * после ошибки должна брать новый ключ.
 *
 * База ждёт тип uuid, поэтому форма ключа — ровно RFC 4122 версия 4.
 * crypto.randomUUID() доступен только в защищённом контексте (https или
 * localhost), а приложение открывают и по http://192.168.* — поэтому UUID
 * собираем из случайных байт, это работает везде.
 *
 * @returns {string} ключ вида '3f9c1a52-...-9b7e-2c1d4f6a8b90'
 */
export function newCommandKey() {
    const bytes = new Uint8Array(16);

    try {
        crypto.getRandomValues(bytes);
    } catch {
        // Экзотика (нет Web Crypto): ключ нужен только против случайного
        // повтора, криптостойкость здесь не требуется.
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }

    bytes[6] = (bytes[6] & 0x0F) | 0x40;   // версия 4
    bytes[8] = (bytes[8] & 0x3F) | 0x80;   // вариант RFC 4122

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Выполнить серверную команду (RPC).
 *
 * Возвращает { data, error } — как остальные функции слоя. Прямые вставки
 * в orders/cash_requests с v2.8.0 базой запрещены: единственный путь —
 * эта функция.
 *
 * @param {string} fnName — имя команды (см. RPC выше)
 * @param {object} params — параметры команды (p_*)
 * @param {{ idempotencyKey?: string }} options — ключ идемпотентности
 *        (newCommandKey()). Без него база отклонит команду, поэтому
 *        передавайте его всегда: `{ idempotencyKey: db.newCommandKey() }`.
 */
export async function rpc(fnName, params = {}, { idempotencyKey = null } = {}) {
    const body = { ...params };

    if (idempotencyKey) body.p_idempotency_key = idempotencyKey;

    log.db(`RPC "${fnName}"`, body);

    try {
        const { data, error } = await supabase.rpc(fnName, body);

        if (error) {
            log.error(`Ошибка RPC "${fnName}":`, error.message);
            return { data: null, error };
        }

        // Пустой ответ (шлюз без тела) — это НЕ успех: неизвестно, применилась
        // ли транзакция. Возвращаем ошибку, чтобы вызывающий код показал
        // понятный текст, а не упал на чтении data.request_number.
        if (!data || typeof data !== 'object') {
            const empty = new Error(`База не вернула результат команды «${fnName}». Повторите попытку.`);
            log.error(empty.message);
            return { data: null, error: empty };
        }

        return { data, error: null };

    } catch (err) {
        log.error(`Исключение в RPC "${fnName}":`, err);
        return { data: null, error: err };
    }
}

// =====================================================================
// STORAGE — РАБОТА С ФАЙЛАМИ
// =====================================================================

/**
 * Загружает файл в Storage.
 * @param {string} bucket — 'estimates' или 'task-photos'
 * @param {string} path — путь внутри бакета, например 'project_5/estimate.xlsx'
 * @param {File|Blob} file — объект файла
 * @returns {Promise<{ path, error }>}
 */
export async function uploadFile(bucket, path, file) {
    log.db(`UPLOAD в "${bucket}"`, path);

    try {
        const { data, error } = await supabase.storage
            .from(bucket)
            .upload(path, file, {
                cacheControl: '3600',
                upsert: true  // перезаписываем, если файл уже есть
            });

        if (error) {
            log.error(`Ошибка UPLOAD в "${bucket}":`, error.message);
            return { path: null, error };
        }

        return { path: data.path, error: null };

    } catch (err) {
        log.error(`Исключение в UPLOAD "${bucket}":`, err);
        return { path: null, error: err };
    }
}

/**
 * Получает временную подписанную ссылку на приватный файл.
 * @param {string} bucket
 * @param {string} path
 * @param {number} expiresInSec — сколько секунд ссылка действительна (по умолчанию 1 час)
 * @returns {Promise<{ url, error }>}
 */
export async function getFileUrl(bucket, path, expiresInSec = 3600) {
    if (!path) return { url: null, error: null };

    try {
        const { data, error } = await supabase.storage
            .from(bucket)
            .createSignedUrl(path, expiresInSec);

        if (error) {
            log.error(`Ошибка получения ссылки из "${bucket}":`, error.message);
            return { url: null, error };
        }

        return { url: data.signedUrl, error: null };

    } catch (err) {
        log.error(`Исключение при получении ссылки "${bucket}":`, err);
        return { url: null, error: err };
    }
}

/**
 * Скачивает файл как Blob (для парсинга Excel).
 * @returns {Promise<{ blob, error }>}
 */
export async function downloadFile(bucket, path) {
    if (!path) return { blob: null, error: null };

    try {
        const { data, error } = await supabase.storage
            .from(bucket)
            .download(path);

        if (error) {
            log.error(`Ошибка DOWNLOAD из "${bucket}":`, error.message);
            return { blob: null, error };
        }

        return { blob: data, error: null };

    } catch (err) {
        log.error(`Исключение DOWNLOAD "${bucket}":`, err);
        return { blob: null, error: err };
    }
}

/**
 * Удаляет файл из Storage.
 * @returns {Promise<{ success, error }>}
 */
export async function deleteFile(bucket, path) {
    if (!path) return { success: true, error: null };

    try {
        const { error } = await supabase.storage
            .from(bucket)
            .remove([path]);

        if (error) {
            log.error(`Ошибка DELETE файла из "${bucket}":`, error.message);
            return { success: false, error };
        }

        return { success: true, error: null };

    } catch (err) {
        log.error(`Исключение DELETE "${bucket}":`, err);
        return { success: false, error: err };
    }
}

// =====================================================================
// ЭКСПОРТ ЕДИНЫМ ОБЪЕКТОМ
// =====================================================================
// Позволяет писать: import { db } from './database.js';
// Тогда вызов: await db.select('projects');
// =====================================================================

export const db = {
    // CRUD
    select,
    insert,
    insertMany,
    update,
    remove,
    count,
    // Страницы и поиск на сервере (v2.9.0)
    selectPage,
    selectAllPaged,
    textSearch,
    PAGE_SIZE,
    MAX_PAGE_SIZE,
    // Серверные команды (транзакции, версия 2.8.0)
    rpc,
    RPC,
    // Серверные команды раздела «📐 Сметы» (версия 2.10.0)
    RPC_ESTIMATES,
    newCommandKey,
    // Специальные
    explainError,
    // Storage
    uploadFile,
    getFileUrl,
    downloadFile,
    deleteFile
};