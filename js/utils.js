// =====================================================================
// RSK ODESSA — УТИЛИТЫ
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
    button.innerHTML = `<span class="inline-block animate-spin">⏳</span> ${loadingText}`;
    return function unlock() {
        button.disabled = wasDisabled;
        button.innerHTML = originalText;
    };
}

/**
 * Показывает/скрывает модальное окно по id.
 */
export function showModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
}

export function hideModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
}

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
    db:    (msg, ...args) => console.log(`[🗄️ DB]`, msg, ...args),
    auth:  (msg, ...args) => console.log(`[🔐 AUTH]`, msg, ...args)
};

// =====================================================================
// ХЕЛПЕРЫ ДЛЯ ОТРИСОВКИ
// =====================================================================

/**
 * Возвращает бейдж статуса заявки (HTML).
 */
export function getOrderStatusBadge(status) {
    const map = {
        new:         { text: '🔴 Новая',       cls: 'bg-red-100 text-red-700' },
        in_progress: { text: '🟡 В работе',    cls: 'bg-yellow-100 text-yellow-700' },
        closed:      { text: '🟢 Закрыта',     cls: 'bg-green-100 text-green-700' },
        archived:    { text: '📥 Архив',       cls: 'bg-gray-200 text-gray-600' }
    };
    const item = map[status] || { text: status, cls: 'bg-gray-100 text-gray-700' };
    return `<span class="px-2 py-0.5 text-xs font-bold rounded ${item.cls}">${item.text}</span>`;
}

/**
 * Возвращает бейдж статуса оплаты (HTML).
 */
export function getPaymentStatusBadge(status) {
    if (status === 'debt') {
        return `<span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold text-[10px]">В долг</span>`;
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

// Следим за состоянием сети (можно использовать для показа баннера "Нет связи")
window.addEventListener('online',  () => log.info('Соединение восстановлено'));
window.addEventListener('offline', () => log.warn('Соединение потеряно'));