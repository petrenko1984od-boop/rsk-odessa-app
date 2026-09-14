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
import { log, currentYear, formatRequestNumber } from './utils.js';

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
                if (key.includes('.')) {
                    const [field, op] = key.split('.');
                    switch (op) {
                        case 'gte': query = query.gte(field, value); break;
                        case 'lte': query = query.lte(field, value); break;
                        case 'gt':  query = query.gt(field, value);  break;
                        case 'lt':  query = query.lt(field, value);  break;
                        case 'neq': query = query.neq(field, value); break;
                        case 'in':  query = query.in(field, value);  break;
                        case 'like': query = query.like(field, value); break;
                        default:    query = query.eq(field, value);
                    }
                } else {
                    query = query.eq(key, value);
                }
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
    log.db(`UPDATE "${table}"`, { payload, filters });

    try {
        let query = supabase.from(table).update(payload);

        for (const [key, value] of Object.entries(filters)) {
            query = query.eq(key, value);
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
    log.db(`DELETE из "${table}"`, filters);

    try {
        let query = supabase.from(table).delete();

        for (const [key, value] of Object.entries(filters)) {
            query = query.eq(key, value);
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
 */
export async function count(table, filters = null) {
    log.db(`COUNT в "${table}"`, filters);

    try {
        let query = supabase
            .from(table)
            .select('*', { count: 'exact', head: true });

        if (filters) {
            for (const [key, value] of Object.entries(filters)) {
                if (key.includes('.')) {
                    const [field, op] = key.split('.');
                    switch (op) {
                        case 'gte': query = query.gte(field, value); break;
                        case 'lte': query = query.lte(field, value); break;
                        case 'gt':  query = query.gt(field, value);  break;
                        case 'lt':  query = query.lt(field, value);  break;
                        default:    query = query.eq(field, value);
                    }
                } else {
                    query = query.eq(key, value);
                }
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

    const { count: total, error } = await count('orders', {
        'created_at.gte': startOfYear,
        'created_at.lt': startOfNextYear
    });

    if (error) {
        log.error('Не удалось получить следующий номер заявки:', error.message);
        return { requestNumber: null, error };
    }

    const nextNumber = (total || 0) + 1;
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
    // Storage
    uploadFile,
    getFileUrl,
    downloadFile,
    deleteFile
};