// =====================================================================
// RSK ODESSA — СЛОЙ РАБОТЫ С БАЗОЙ ДАННЫХ
// =====================================================================
// Универсальный «посредник» между модулями и Supabase.
// Модули НЕ обращаются к Supabase напрямую — только через эти функции.
//
// Все функции возвращают { data, error } — как в самом Supabase.
// Это позволяет обрабатывать ошибки единообразно.
// =====================================================================

import { supabase, CONFIG } from './config.js';
import { log, currentYear, formatRequestNumber, parseRequestNumber } from './utils.js';

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
 * Текст ошибки для сотрудника. Для ошибок про отсутствующую колонку
 * возвращает понятную инструкцию, для остальных — исходное сообщение.
 */
export function explainError(error) {
    const missing = parseMissingColumn(error);
    if (!missing) return error?.message || String(error || 'Неизвестная ошибка');

    const where = missing.table ? `в таблице «${missing.table}»` : 'в базе данных';

    if (!schemaWarningShown) {
        schemaWarningShown = true;
        log.error(`⚠ В таблице ${missing.table || '?'} нет колонки «${missing.column}» — база не обновлена под v${CONFIG.APP.VERSION}`);
        log.error('⚠ Выполните database/migrate-v2.4.sql в Supabase → SQL Editor: без этих колонок счёт, доставка и оплата заявок не сохраняются.');
    }

    return `База данных не обновлена: ${where} нет колонки «${missing.column}». ` +
        'Примените database/migrate-v2.4.sql (Supabase → SQL Editor) и повторите действие.';
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

/**
 * Применяет одно условие к запросу.
 * Поддерживает операторы: { 'id.in': [1,2] }, { 'created_at.gte': '...' }
 */
function applyFilter(query, key, value) {
    if (!key.includes('.')) {
        return query.eq(key, value);
    }

    const [field, op] = key.split('.');

    switch (op) {
        case 'gte':  return query.gte(field, value);
        case 'lte':  return query.lte(field, value);
        case 'gt':   return query.gt(field, value);
        case 'lt':   return query.lt(field, value);
        case 'neq':  return query.neq(field, value);
        case 'in':   return query.in(field, Array.isArray(value) ? value : [value]);
        case 'like': return query.like(field, value);
        case 'is':   return query.is(field, value);
        default:     return query.eq(field, value);
    }
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
            query = query.order(orderBy.column, { ascending: orderBy.asc !== false });
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
 * Для номеров берите «максимум за год + 1» и повторяйте запрос при ошибке 23505
 * (см. getNextRequestNumber ниже и generateCashRequestNumber в cash-requests.js).
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
// СПЕЦИАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

/**
 * Возвращает следующий номер заявки в формате "№ 5/26".
 * Логика: считаем все заявки за текущий год + 1.
 *
 * @returns {Promise<{ requestNumber: string, error }>}
 */
export async function getNextRequestNumber() {
    const year = currentYear();
    const startOfYear = `${year}-01-01T00:00:00`;
    const startOfNextYear = `${year + 1}-01-01T00:00:00`;

    // Берём МАКСИМУМ уже выданных номеров за год, а не COUNT(*):
    // иначе после удаления заявки номер будет выдан повторно (дубликат).
    const { data: yearOrders, error } = await select('orders', {
        select: 'request_number',
        filters: {
            'created_at.gte': startOfYear,
            'created_at.lt': startOfNextYear
        }
    });

    if (error) {
        log.error('Не удалось получить следующий номер заявки:', error.message);
        return { requestNumber: null, error };
    }

    let maxNumber = 0;
    (yearOrders || []).forEach(order => {
        const parsed = parseRequestNumber(order.request_number);
        if (parsed && parsed.year === year && parsed.number > maxNumber) {
            maxNumber = parsed.number;
        }
    });

    const nextNumber = maxNumber + 1;
    const requestNumber = formatRequestNumber(nextNumber, year);
    log.db(`Следующий номер заявки: ${requestNumber}`);
    return { requestNumber, error: null };
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
    // Специальные
    getNextRequestNumber,
    explainError,
    // Storage
    uploadFile,
    getFileUrl,
    downloadFile,
    deleteFile
};