// =====================================================================
// FREEDOM — ПАНЕЛЬ СПИСКА: ПОИСК, ПОДСЧЁТ СТРОК, СТРАНИЦЫ (v2.9.0)
// =====================================================================
// Один и тот же блок для всех списков приложения: строка поиска, надпись
// «Показано 1-25 из 137», выбор размера страницы и кнопки «‹ Назад / Вперёд ›».
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Раньше каждый список рисовал всё сам: у заявок был
// свой набор кнопок-вкладок, у кассы — свои, и нигде не было видно, сколько
// строк всего и что показана только часть. Копировать «‹ / ›» в четвёртый
// список — верный способ получить четыре разных поведения. Здесь поведение
// одно, а модуль отдаёт только разметку и события.
//
// Как пользоваться (js/modules/orders.js):
//   const state = { page: 1, pageSize: db.PAGE_SIZE, count: 137, search: '' };
//   renderToolbar('orders-toolbar', {
//       id: 'orders',
//       searchValue: state.search,
//       searchPlaceholder: t('orders.searchPlaceholder'),
//       page: state.page, pageSize: state.pageSize,
//       count: state.count, rowsOnPage: ordersCache.length,
//       onSearch: (text) => { ... }, onPage: (page) => { ... },
//       onPageSize: (size) => { ... }
//   });
//
// ⚠️ count может быть null: моки в прогонах (tools/checks) и старый PostgREST
//    не присылают Content-Range. Тогда модуль пишет «Показано 25», а не
//    «Показано 1-25 из неизвестно»: неизвестное число не выдумываем.
// =====================================================================

import { t } from './i18n.js';
import { escapeHtml, debounce } from './utils.js';

// Размеры страницы на выбор. Согласованы с db.MAX_PAGE_SIZE (js/database.js):
// слой не отдаст за один запрос больше 100 строк, и вариант «200» в списке
// выглядел бы как обман.
const PAGE_SIZES = [25, 50, 100];

/** Поиск шлём на сервер не на каждую букву, а через небольшую паузу. */
const SEARCH_DELAY_MS = 350;

/**
 * Собирает HTML панели. Отдельно от отрисовки, чтобы разметку можно было
 * проверить прогоном (tools/checks/scale-check.mjs) без браузера.
 *
 * @param {Object} options
 * @param {string} options.id — префикс id элементов (уникален на страницу)
 * @param {boolean} [options.showSearch=true] — рисовать ли строку поиска.
 *        У «Реестра материалов» поиск не показывается: у него 12 колонок и
 *        семь фильтров, а строка поиска искала бы только по названию — и
 *        сотрудник ждал бы от неё другого. Фильтры уходят в запрос
 *        (js/modules/registry.js → registryRowFilters).
 * @param {string} [options.searchValue] — что уже набрано в поиске
 * @param {string} [options.searchPlaceholder] — подсказка в поле поиска.
 *        Готовый текст перевода передаёт сам список (см. js/modules/orders.js):
 *        тогда прогон i18n видит ключ в коде и проверяет оба языка.
 * @param {number} [options.page] — текущая страница, с 1
 * @param {number} [options.pageSize]
 * @param {number|null} [options.count] — сколько строк всего
 * @param {number} [options.rowsOnPage] — сколько строк пришло в этой странице
 * @returns {string}
 */
export function toolbarHtml(options = {}) {
    const {
        id,
        showSearch = true,
        searchValue = '',
        searchPlaceholder = '',
        page = 1,
        pageSize = PAGE_SIZES[0],
        count = null,
        rowsOnPage = 0
    } = options;

    const totalPages = typeof count === 'number' ? Math.max(1, Math.ceil(count / pageSize)) : null;
    const canPrev = page > 1;
    const canNext = totalPages !== null ? page < totalPages : rowsOnPage >= pageSize;

    const sizes = PAGE_SIZES.map((size) => `
                    <option value="${size}"${size === pageSize ? ' selected' : ''}>${size}</option>`).join('');

    return `
        <div class="flex flex-wrap items-center gap-2">
            ${showSearch ? `
            <div class="flex-1 min-w-[200px]">
                <input type="search" id="${id}-search" value="${escapeHtml(searchValue)}"
                       placeholder="${escapeHtml(searchPlaceholder || t('pager.searchPlaceholder'))}"
                       class="w-full border rounded-lg px-3 py-1.5 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
            </div>` : ''}
            <label class="text-[11px] text-gray-500 flex items-center gap-1">
                ${escapeHtml(t('pager.pageSize'))}
                <select id="${id}-page-size" class="border rounded-lg px-2 py-1.5 text-xs bg-white text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">${sizes}
                </select>
            </label>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span id="${id}-range" class="text-[11px] text-gray-500">${escapeHtml(rangeText({ page, pageSize, count, rowsOnPage }))}</span>
            <div class="flex items-center gap-1">
                <button type="button" id="${id}-prev" ${canPrev ? '' : 'disabled'}
                        class="px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${canPrev
                            ? 'bg-white text-[#15803d] hover:bg-gray-50'
                            : 'bg-gray-100 text-gray-400 cursor-not-allowed'}">${escapeHtml(t('pager.prev'))}</button>
                <span id="${id}-page" class="text-[11px] text-gray-500 px-1">${escapeHtml(pageText({ page, totalPages }))}</span>
                <button type="button" id="${id}-next" ${canNext ? '' : 'disabled'}
                        class="px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${canNext
                            ? 'bg-white text-[#15803d] hover:bg-gray-50'
                            : 'bg-gray-100 text-gray-400 cursor-not-allowed'}">${escapeHtml(t('pager.next'))}</button>
            </div>
        </div>
    `;
}

/**
 * «Показано 1-25 из 137». Без count — «Показано 25»: неизвестное число
 * строк не выдумываем.
 */
export function rangeText({ page = 1, pageSize = PAGE_SIZES[0], count = null, rowsOnPage = 0 } = {}) {
    if (typeof count === 'number') {
        const from = count === 0 ? 0 : (page - 1) * pageSize + 1;
        const to = count === 0 ? 0 : Math.min(count, (page - 1) * pageSize + rowsOnPage);
        return t('pager.range', { from, to, total: count });
    }

    return t('pager.rangeUnknown', { rows: rowsOnPage });
}

/** «Страница 2 из 6». Без count — только номер текущей страницы. */
export function pageText({ page = 1, totalPages = null } = {}) {
    if (totalPages === null) return t('pager.page', { page });

    return t('pager.pageOf', { page, pages: totalPages });
}

/**
 * Рисует панель в контейнере и вешает обработчики.
 *
 * @param {string} containerId — id пустого блока в index.html
 * @param {Object} options — то же, что у toolbarHtml, плюс обработчики:
 *    onSearch(text) — набран текст поиска (уже с паузой);
 *    onPage(page) — нажали «‹ Назад» / «Вперёд ›»;
 *    onPageSize(size) — сменили размер страницы.
 */
export function renderToolbar(containerId, options = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const { id, onSearch, onPage, onPageSize } = options;

    container.innerHTML = toolbarHtml(options);

    const search = document.getElementById(`${id}-search`);
    const size = document.getElementById(`${id}-page-size`);
    const prev = document.getElementById(`${id}-prev`);
    const next = document.getElementById(`${id}-next`);
    const page = options.page || 1;
    const totalPages = typeof options.count === 'number'
        ? Math.max(1, Math.ceil(options.count / (options.pageSize || PAGE_SIZES[0])))
        : null;

    if (search && typeof onSearch === 'function') {
        const push = debounce(() => onSearch(search.value.trim()), SEARCH_DELAY_MS);
        search.addEventListener('input', push);
    }

    if (size && typeof onPageSize === 'function') {
        size.addEventListener('change', () => onPageSize(Number(size.value)));
    }

    // Кнопки выключены атрибутом disabled, но обработчик всё равно проверяет
    // границы: список могли перерисовать, пока нажатие было в пути.
    if (prev && typeof onPage === 'function') {
        prev.addEventListener('click', () => {
            if (page > 1) onPage(page - 1);
        });
    }

    if (next && typeof onPage === 'function') {
        next.addEventListener('click', () => {
            const canNext = totalPages !== null
                ? page < totalPages
                : (options.rowsOnPage || 0) >= (options.pageSize || PAGE_SIZES[0]);
            if (canNext) onPage(page + 1);
        });
    }
}

export const PAGINATION = {
    PAGE_SIZES,
    toolbarHtml,
    renderToolbar,
    rangeText,
    pageText
};
