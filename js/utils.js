// =====================================================================
// FREEDOM — УТИЛИТЫ
// =====================================================================
// Вспомогательные функции, которые используются во всех модулях.
// Здесь НЕТ работы с базой или бизнес-логики — только «инструменты».
// =====================================================================

import { CONFIG } from './config.js';

// =====================================================================
// ФОРМАТИРОВАНИЕ ЧИСЕЛ И ДЕНЕГ
// =====================================================================

/**
 * Форматирует число как сумму в гривнах с разделителями тысяч.
 * Пример: 12345.6 → "12 345,60 грн"
 */
export function formatMoney(value) {
    const num = Number(value) || 0;
    return num.toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }) + ' грн';
}

/**
 * Форматирует число без копеек (для смет, где суммы целые).
 * Пример: 12345.6 → "12 346 грн"
 */
/**
 * Округляет денежную сумму до копеек.
 * Нужно, чтобы при сложении/умножении float-чисел не накапливалась ошибка
 * (0.1 + 0.2 = 0.30000000000000004).
 */
export function roundMoney(value) {
    const num = Number(value) || 0;
    return Math.round((num + Number.EPSILON) * 100) / 100;
}

export function formatMoneyShort(value) {
    const num = Number(value) || 0;
    return num.toLocaleString('ru-RU', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }) + ' грн';
}

/**
 * Форматирует число с разделителями тысяч (без валюты).
 * Пример: 12345.6 → "12 345,6"
 */
export function formatNumber(value, decimals = 2) {
    const num = Number(value) || 0;
    return num.toLocaleString('ru-RU', {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals
    });
}

// =====================================================================
// ФОРМАТИРОВАНИЕ ДАТ
// =====================================================================

/**
 * Возвращает сегодняшнюю дату в формате YYYY-MM-DD (для input[type=date]).
 */
export function todayISO() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Форматирует дату в читаемый вид: DD.MM.YYYY
 * Принимает ISO-строку или объект Date.
 */
export function formatDate(dateInput) {
    if (!dateInput) return '—';
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(date.getTime())) return String(dateInput);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}.${month}.${year}`;
}

/**
 * Форматирует дату и время: DD.MM.YYYY, HH:MM
 */
export function formatDateTime(dateInput) {
    if (!dateInput) return '—';
    const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(date.getTime())) return String(dateInput);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day}.${month}.${year}, ${hours}:${minutes}`;
}

/**
 * Возвращает true, если дата (ISO) меньше сегодняшней (просрочена).
 */
export function isOverdue(dateISO) {
    if (!dateISO) return false;
    const today = todayISO();
    return dateISO < today;
}

// =====================================================================
// НУМЕРАЦИЯ ЗАЯВОК (формат: № 5/26)
// =====================================================================

/**
 * Форматирует номер заявки из числа и года.
 * @param {number} number — порядковый номер (1, 2, 3, ...)
 * @param {number} year — полный год (2026)
 * @returns {string} — "№ 5/26"
 */
export function formatRequestNumber(number, year) {
    const yy = String(year).slice(-2);
    return `№ ${number}/${yy}`;
}

/**
 * Извлекает номер и год из строки "№ 5/26".
 * Используется для парсинга при необходимости.
 * @returns {{ number: number, year: number } | null}
 */
export function parseRequestNumber(str) {
    if (!str) return null;
    const match = String(str).match(/№?\s*(\d+)\/(\d{2})/);
    if (!match) return null;
    const number = parseInt(match[1], 10);
    const yearShort = parseInt(match[2], 10);
    const year = 2000 + yearShort;
    return { number, year };
}

/**
 * Возвращает текущий год.
 */
export function currentYear() {
    return new Date().getFullYear();
}

// =====================================================================
// РАЗДЕЛЫ СМЕТЫ — СОПОСТАВЛЕНИЕ ПО ИМЕНИ
// =====================================================================

/**
 * Нормализует название раздела для сопоставления.
 * Тем же способом сравнивает разделы загрузчик сметы (estimate.js),
 * поэтому одна логика и там, и в служебных проверках.
 */
export function normalizeSectionName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Это служебный раздел «Доп. расходы» (вне сметы)?
 * Он создаётся приложением, а не приходит из Excel: такие разделы не удаляются
 * и не перезаписываются при загрузке/удалении сметы и не попадают в план-факт.
 */
export function isExtraSectionName(name) {
    return normalizeSectionName(name) === normalizeSectionName(CONFIG.EXTRA_SECTION?.NAME || '');
}

// =====================================================================
// НДС (ПДВ)
// =====================================================================
// Галочки «+20%» в приложении нет намеренно: у поставщиков цены бывают и без
// налога, и уже с ним. Поэтому в окне счёта снабженец выбирает РЕЖИМ ввода
// (CONFIG.VAT.MODE), а налог всегда считает одна функция — эта.
//
// Инвариант денег: в order_items.unit_price / total_price лежит сумма К ОПЛАТЕ
// (с НДС), а vat_amount — сколько налога внутри. Отсюда правило «налог не
// прибавляется дважды»: либо он ВЫДЕЛЯЕТСЯ из конечной цены, либо добавляется
// к цене без налога ровно один раз — при сохранении счёта.
// Равенство base + vat === total выполняется строго до копейки (vat считается
// вычитанием), иначе суммы в реестре разъехались бы на копейку.

/**
 * Ставка НДС в процентах. Пустое поле, мусор и отрицательные значения — ноль:
 * в приложении ноль значит «налога нет».
 */
export function normalizeVatRate(rate) {
    const num = Number(rate);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.min(100, num);
}

/**
 * Разбирает сумму на базу и НДС.
 *
 * @param {number} amount — сумма, которую ввёл снабженец (цена × количество);
 * @param {number} rate — ставка НДС в процентах (0 / 7 / 20 / своя);
 * @param {boolean} amountWithVat — true: в сумме налог УЖЕ есть (выделяем),
 *        false: сумма без налога (налог добавляем сверху).
 * @returns {{ base: number, vat: number, total: number, rate: number }}
 *          где base + vat === total (строго).
 */
export function calcVat(amount, rate, amountWithVat) {
    const percent = normalizeVatRate(rate);
    const total = roundMoney(amount);

    if (percent === 0) {
        return { base: total, vat: 0, total, rate: 0 };
    }

    if (amountWithVat) {
        const base = roundMoney(total * 100 / (100 + percent));
        return { base, vat: roundMoney(total - base), total, rate: percent };
    }

    const base = total;
    const vat = roundMoney(base * percent / 100);
    return { base, vat, total: roundMoney(base + vat), rate: percent };
}

/**
 * НДС, «спрятанный» внутри суммы с налогом.
 * Нужно там, где известна только сумма к оплате (реестр, расход подотчёта,
 * своя доставка): base = total − vat.
 */
export function vatFromTotal(total, rate) {
    return calcVat(total, rate, true).vat;
}

/**
 * Это позиция доставки по заявке на материалы (CONFIG.DELIVERY_ITEM)?
 *
 * Доставку снабженец вписывает отдельной строкой в окне счёта
 * (js/modules/orders.js → saveOrderInvoice), а живёт она в order_items —
 * отдельной колонки в orders нет, миграция базы не нужна. Вид доставки
 * («везёт поставщик» / «везёт компания») тоже хранится в имени строки:
 * CONFIG.DELIVERY_ITEM.NAME / COMPANY_NAME. По этому признаку:
 *   * «📊 Реестр материалов» показывает строку категорией «🚚 Доставка»,
 *     а не «📦 Материалы» (js/modules/registry.js);
 *   * в списках и карточках заявок строке ставится иконка 🚚 вместо 📦
 *     (js/modules/orders.js) — поэтому в именах доставки эмодзи нет.
 * Имена — ключ сопоставления (их пишет приложение при сохранении доставки),
 * поэтому сравниваем так же, как разделы сметы: без регистра и двойных пробелов.
 */
export function isDeliveryItem(item) {
    return getDeliveryItemType(item) !== null;
}

/**
 * Вид доставки у позиции заявки:
 *   CONFIG.DELIVERY_ITEM.TYPE.SUPPLIER — везёт поставщик (сумма в счёте),
 *   CONFIG.DELIVERY_ITEM.TYPE.COMPANY  — везёт компания (вне счёта поставщика),
 *   null — это не строка доставки, а обычная позиция.
 *
 * С v2.5.0 вид лежит в колонке order_items.delivery_kind ('supplier' /
 * 'company') — это надёжнее имени строки, которое можно переименовать.
 * Строки, созданные раньше, распознаём по имени («Доставка» / «Доставка
 * компании», CONFIG.DELIVERY_ITEM.NAME / COMPANY_NAME): оно остаётся
 * ключом совместимости.
 */
export function getDeliveryItemType(item) {
    const types = CONFIG.DELIVERY_ITEM?.TYPE || {};
    const kind = String(item?.delivery_kind || '').trim().toLowerCase();

    if (kind === (types.COMPANY || 'company')) return types.COMPANY || 'company';
    if (kind === (types.SUPPLIER || 'supplier')) return types.SUPPLIER || 'supplier';

    const name = normalizeSectionName(item?.name);
    if (!name) return null;

    if (name === normalizeSectionName(CONFIG.DELIVERY_ITEM?.NAME || '')) return types.SUPPLIER || 'supplier';
    if (name === normalizeSectionName(CONFIG.DELIVERY_ITEM?.COMPANY_NAME || '')) return types.COMPANY || 'company';

    return null;
}

/**
 * Это своя доставка — заявку везла компания, в счёт поставщика сумма не вошла?
 */
export function isOwnDeliveryItem(item) {
    return getDeliveryItemType(item) === (CONFIG.DELIVERY_ITEM?.TYPE?.COMPANY || 'company');
}

/**
 * Заявки, по которым своя доставка уже оплачена расходом подотчёта.
 *
 * Своя доставка — та самая сумма, которую легко посчитать дважды: она есть и
 * строкой заявки (order_items), и расходом кассы (cash_operations.source =
 * 'own_delivery', его создаёт js/modules/orders.js → saveOwnDeliveryExpense()).
 * Поэтому все модули, которые складывают деньги — реестр, план-факт, «Доп.
 * расходы», дашборд, — берут эту проверку отсюда, а не пишут свою.
 * Возвращает Set строк с id заявок: сравнивать через String(), потому что
 * PostgREST отдаёт bigint как строку.
 *
 * @param {Array<Object>} operations — операции кассы (расходы) любого источника
 * @returns {Set<string>}
 */
export function ownDeliveryCoveredOrderIds(operations) {
    return new Set((operations || [])
        .filter(op => op && op.source === 'own_delivery' && op.order_id)
        .map(op => String(op.order_id)));
}

/**
 * Позицию заявки надо пропустить: своя доставка, за которую уже заплатили
 * расходом подотчёта (иначе сумма попала бы в итоги дважды).
 *
 * @param {Object} item — позиция заявки (order_items, нужен order_id)
 * @param {Set<string>} coveredOrderIds — результат ownDeliveryCoveredOrderIds()
 */
export function isOwnDeliveryCovered(item, coveredOrderIds) {
    if (!item || !coveredOrderIds || coveredOrderIds.size === 0) return false;
    return isOwnDeliveryItem(item) && coveredOrderIds.has(String(item.order_id || ''));
}

/**
 * Как называется строка доставки в заявке для выбранного вида.
 * Принимает CONFIG.DELIVERY_ITEM.TYPE.* (всё остальное считаем доставкой
 * поставщика — так же, как это делает форма счёта по умолчанию).
 */
export function getDeliveryItemName(type) {
    const company = CONFIG.DELIVERY_ITEM?.TYPE?.COMPANY;
    return type === company
        ? (CONFIG.DELIVERY_ITEM?.COMPANY_NAME || '')
        : (CONFIG.DELIVERY_ITEM?.NAME || '');
}

// =====================================================================
// БЕЗОПАСНОСТЬ — ЭКРАНИРОВАНИЕ HTML
// =====================================================================

/**
 * Экранирует HTML-символы, чтобы пользователь не мог вставить <script>.
 * Используй при вставке данных из БД в HTML-шаблоны.
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// =====================================================================
// TOAST-УВЕДОМЛЕНИЯ
// =====================================================================

/**
 * Показывает всплывающее уведомление в правом верхнем углу.
 * @param {string} message — текст
 * @param {string} type — 'success' | 'error' | 'warning' | 'info'
 */
export function toast(message, type = 'info') {
    const colors = {
        success: 'bg-[#15803d] text-white',
        error:   'bg-red-600 text-white',
        warning: 'bg-amber-500 text-white',
        info:    'bg-gray-800 text-white'
    };
    const icons = {
        success: '✅',
        error:   '❌',
        warning: '⚠️',
        info:    'ℹ️'
    };

    const el = document.createElement('div');
    el.className = `fixed top-4 right-4 z-[200] px-4 py-3 rounded-xl shadow-2xl text-sm font-semibold
                    ${colors[type] || colors.info} transform translate-x-full transition-transform duration-300`;
    el.innerHTML = `${icons[type] || ''} ${escapeHtml(message)}`;
    document.body.appendChild(el);

    // Анимация появления
    requestAnimationFrame(() => {
        el.classList.remove('translate-x-full');
    });

    // Автоудаление
    setTimeout(() => {
        el.classList.add('translate-x-full');
        setTimeout(() => el.remove(), 300);
    }, CONFIG.UI.TOAST_DURATION_MS);
}

// =====================================================================
// UI — КНОПКИ И ЗАГРУЗКА
// =====================================================================

/**
 * Блокирует кнопку на время операции и меняет текст.
 * Возвращает функцию для возврата в исходное состояние.
 */
export function lockButton(button, loadingText = 'Загрузка...') {
    const originalText = button.innerHTML;
    const wasDisabled = button.disabled;
    button.disabled = true;
    button.innerHTML = `<span class="app-spinner" aria-hidden="true"></span> ${loadingText}`;
    return function unlock() {
        button.disabled = wasDisabled;
        button.innerHTML = originalText;
    };
}

/**
 * Показывает/скрывает модальное окно по id.
 *
 * Дополнительно (доступность):
 *   - role="dialog" + aria-modal="true" для скринридеров
 *   - фокус переводится внутрь окна, а после закрытия возвращается назад
 *   - Escape закрывает верхнее окно, Tab не выходит за его пределы
 */

let lastFocusedElement = null;

/** Все открытые модальные окна (снизу вверх). */
function getOpenModals() {
    return Array.from(document.querySelectorAll('[id$="-modal"]'))
        .filter(el => !el.classList.contains('hidden'));
}

export function isAnyModalOpen() {
    return getOpenModals().length > 0;
}

/**
 * Закрывает верхнее открытое модальное окно. Используется по Escape.
 * @returns {boolean} — было ли что закрывать
 */
export function closeTopModal() {
    const open = getOpenModals();
    if (open.length === 0) return false;
    hideModal(open[open.length - 1].id);
    return true;
}

export function showModal(id) {
    const el = document.getElementById(id);
    if (!el) return;

    const active = document.activeElement;
    lastFocusedElement = active instanceof HTMLElement ? active : null;

    el.classList.remove('hidden');

    if (!el.hasAttribute('role')) el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');

    if (!el.hasAttribute('aria-labelledby')) {
        const title = el.querySelector('h3');
        if (title) {
            if (!title.id) title.id = `${id}-title`;
            el.setAttribute('aria-labelledby', title.id);
        }
    }

    const focusable = el.querySelector(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])'
    );
    if (focusable) setTimeout(() => focusable.focus(), 50);
}

export function hideModal(id) {
    const el = document.getElementById(id);
    if (!el) return;

    el.classList.add('hidden');
    el.removeAttribute('aria-modal');

    const target = lastFocusedElement;
    lastFocusedElement = null;

    // Возвращаем фокус только если не открылось следующее окно
    setTimeout(() => {
        if (isAnyModalOpen()) return;
        if (target && document.contains(target)) {
            try { target.focus(); } catch (err) { /* элемент мог исчезнуть */ }
        }
    }, 0);
}

// Escape закрывает верхнее окно, Tab — не даём фокусу уйти из окна
document.addEventListener('keydown', (event) => {
    const open = getOpenModals();
    if (open.length === 0) return;

    const top = open[open.length - 1];

    if (event.key === 'Escape') {
        event.preventDefault();
        hideModal(top.id);
        return;
    }

    if (event.key !== 'Tab') return;

    const focusables = Array.from(top.querySelectorAll(
        'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(node => node.offsetParent !== null || node === document.activeElement);

    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});

// =====================================================================
// РАБОТА С ФОРМАМИ
// =====================================================================

/**
 * Собирает данные формы в объект.
 * @param {string} formId — id формы
 * @returns {Object} — { name: 'value', ... }
 */
export function getFormData(formId) {
    const form = document.getElementById(formId);
    if (!form) return {};
    const data = {};
    new FormData(form).forEach((value, key) => {
        data[key] = value.trim ? value.trim() : value;
    });
    return data;
}

/**
 * Сбрасывает форму по id.
 */
export function resetForm(formId) {
    const form = document.getElementById(formId);
    if (form) form.reset();
}

// =====================================================================
// ПАРСИНГ И ВАЛИДАЦИЯ
// =====================================================================

/**
 * Безопасный парсинг числа. Возвращает 0, если не число.
 */
export function parseNumber(value) {
    const num = parseFloat(String(value).replace(',', '.'));
    return isNaN(num) ? 0 : num;
}

/**
 * Валидирует email.
 */
export function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email));
}

// =====================================================================
// ДЕБАУНС (для поиска по мере ввода)
// =====================================================================

/**
 * Ограничивает частоту вызова функции.
 * Пример: debounce(() => search(), 300)
 */
export function debounce(fn, delayMs = 300) {
    let timer = null;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delayMs);
    };
}

// =====================================================================
// СКРОЛЛ И ФОКУС
// =====================================================================

/**
 * Прокручивает страницу к элементу.
 */
export function scrollToElement(elementOrId) {
    const el = typeof elementOrId === 'string'
        ? document.getElementById(elementOrId)
        : elementOrId;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Ставит фокус на поле ввода по id.
 */
export function focusInput(id) {
    const el = document.getElementById(id);
    if (el) setTimeout(() => el.focus(), 100);
}

// =====================================================================
// ЛОГИРОВАНИЕ (для отладки)
// =====================================================================

export const log = {
    info:  (msg, ...args) => console.log(`[ℹ️]`, msg, ...args),
    warn:  (msg, ...args) => console.warn(`[⚠️]`, msg, ...args),
    error: (msg, ...args) => console.error(`[❌]`, msg, ...args),
    // SQL-логи печатаем только при CONFIG.APP.DEBUG = true
    db:    (msg, ...args) => { if (CONFIG.APP.DEBUG) console.log(`[🗄️ DB]`, msg, ...args); },
    auth:  (msg, ...args) => console.log(`[🔐 AUTH]`, msg, ...args)
};

// =====================================================================
// ХЕЛПЕРЫ ДЛЯ ОТРИСОВКИ
// =====================================================================

/**
 * Возвращает бейдж статуса заявки (HTML).
 */
export function getOrderStatusBadge(status) {
    const labels = CONFIG.STATUS_LABELS.ORDERS;
    const map = {
        new:         { text: labels.new,         cls: 'bg-red-100 text-red-700' },
        in_progress: { text: labels.in_progress, cls: 'bg-yellow-100 text-yellow-700' },
        delivered:   { text: labels.delivered,   cls: 'bg-emerald-100 text-emerald-800' },
        closed:      { text: labels.closed,      cls: 'bg-green-100 text-green-700' },
        archived:    { text: labels.archived,    cls: 'bg-gray-200 text-gray-600' }
    };
    const item = map[status] || { text: status, cls: 'bg-gray-100 text-gray-700' };
    return `<span class="px-2 py-0.5 text-xs font-bold rounded ${item.cls}">${item.text}</span>`;
}

/**
 * Возвращает бейдж статуса оплаты (HTML).
 */
export function getPaymentStatusBadge(status) {
    if (status === 'debt') {
        return `<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold text-[10px]">Ожидает оплаты</span>`;
    }
    return `<span class="bg-green-100 text-green-800 px-2 py-0.5 rounded font-bold text-[10px]">Оплачено</span>`;
}

/**
 * Возвращает бейдж приоритета задачи (HTML).
 */
export function getTaskPriorityBadge(priority) {
    const map = {
        urgent:    { text: 'Срочно',  cls: 'bg-red-100 text-red-700' },
        important: { text: 'Важный',  cls: 'bg-amber-100 text-amber-800' },
        normal:    { text: 'Обычная', cls: 'bg-gray-100 text-gray-700' }
    };
    const item = map[priority];
    if (!item) return '';
    return `<span class="text-[10px] ${item.cls} px-1.5 py-0.5 rounded font-bold">${item.text}</span>`;
}

// =====================================================================
// ЗАГЛУШКА ПУСТОГО СПИСКА
// =====================================================================

/**
 * Возвращает HTML-заглушку для пустого списка.
 */
export function emptyState(message, colSpan = 1) {
    if (colSpan > 1) {
        return `<tr><td colspan="${colSpan}" class="text-center text-gray-400 py-6">${escapeHtml(message)}</td></tr>`;
    }
    return `<p class="text-gray-400 italic text-center py-6 text-sm">${escapeHtml(message)}</p>`;
}

// =====================================================================
// ПРОВЕРКА ОНЛАЙН-СТАТУСА
// =====================================================================

export function isOnline() {
    return navigator.onLine;
}

// =====================================================================
// ОБНОВЛЕНИЕ РАБОЧЕГО ЭКРАНА
// =====================================================================

/**
 * Перерисовывает «Рабочий экран» (дашборд сотрудника), если он открыт.
 *
 * Нужно после действий, которые сотрудник делает ПРЯМО на рабочем экране:
 * прораб создаёт и дорабатывает заявки, убирает их в архив — и блоки «Мои
 * заявки» не должны показывать старый статус. Дашборд не трогаем, когда
 * открыт другой раздел (иначе лишний запрос в базу), и не ломаемся, если
 * модуль дашборда ещё не загрузился.
 */
export async function refreshDashboardIfVisible() {
    if (window.AppState?.currentTab !== 'tasks') return;
    if (typeof window.loadDashboard !== 'function') return;

    try {
        await window.loadDashboard();
    } catch (err) {
        log.warn('Не удалось обновить рабочий экран:', err?.message || err);
    }
}

// Следим за состоянием сети (можно использовать для показа баннера "Нет связи")
window.addEventListener('online',  () => log.info('Соединение восстановлено'));
window.addEventListener('offline', () => log.warn('Соединение потеряно'));