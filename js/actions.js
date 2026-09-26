// =====================================================================
// FREEDOM — ДЕЙСТВИЯ ИНТЕРФЕЙСА (одна точка обработки событий)
// =====================================================================
// ЗАЧЕМ ЭТОТ ФАЙЛ. Разметка раньше вызывала функции прямо в атрибутах
// (`onclick="switchTab('tasks')"`) — так делают в примерах, но не в проде:
//   * такой обработчик нельзя закрыть политикой Content-Security-Policy
//     (для него нужен `script-src 'unsafe-inline'`, а это открывает дорогу
//     внедрённому скрипту — XSS через подставленные данные);
//   * браузер не может проверить такой код ни линтером, ни прогонами:
//     опечатка в имени функции молчит, кнопка просто не нажимается.
//
// КАК ТЕПЕРЬ. Разметка НАЗЫВАЕТ действие атрибутом `data-action`, а слушатели
// висят здесь — по одному на `document`, а не на каждой кнопке. Поэтому
// перерисованные списки (`innerHTML`) работают без повторного навешивания.
//
//   <button data-action="switchTab" data-arg="tasks">
//   <button data-action="hideModal" data-arg="settings-modal">
//   <input  data-action="recalcOrderTotal" data-on="input">
//   <select data-action="setInvoicePeriod" data-arg-value data-on="change">
//   <div    data-action="openMaterialInvoiceDetail" data-arg="${order.id}"
//           data-on="click keydown" data-keys="Enter Space" data-prevent role="button" tabindex="0">
//   <button data-action="viewMaterialInvoice" data-arg="${order.id}" data-stop>
//   <tr     data-action="openTaskDetail" data-arg="${task.id}"
//           data-after="hideModal" data-after-arg="task-filter-modal">
//   <button data-action="recalcExpenseTotal" data-remove="expense-row-3">
//   <button data-on="keydown" data-skip>           ← перехватить событие карточки
//   <img src="./logo.png" data-fallback-show="logo-fallback">
//
// ПРАВИЛА (короткие — чтобы разметку можно было читать не заглядывая сюда):
//   * `data-arg` — один аргумент; строка из одних цифр становится числом,
//     поэтому `data-arg="${order.id}"` передаёт число, а не "12";
//   * `data-arg-value` — аргумент берётся из поля (`select`, `input`) —
//     это замена `onchange="...this.value"`;
//   * `data-on="click keydown"` — какие события обрабатывает элемент
//     (по умолчанию только `click`);
//   * `data-keys="Enter Space"` — для `keydown`: какие клавиши считаются
//     нажатием (по умолчанию Enter и пробел — элемент с `role="button"`
//     доступен с клавиатуры);
//   * `data-stop` — `event.stopPropagation()`: кнопка внутри кликабельной
//     карточки не должна открывать карточку;
//   * `data-prevent` — `event.preventDefault()`;
//   * `data-after` / `data-after-arg` — второе действие после первого
//     (например, «открыть задачу и закрыть окно фильтра»);
//   * `data-remove="id"` — убрать элемент из документа перед действием
//     (удаление строки таблицы);
//   * `data-skip` (без `data-action`) — элемент только перехватывает событие:
//     кнопка внутри карточки не даёт карточке сработать по Enter;
//   * `data-fallback-show="id"` — на ошибке загрузки картинки показать
//     запасной блок по id (вместо `onerror="this.outerHTML=..."`).
//
// Имя действия ищется сначала в реестре (`registerActions`), затем на
// `window` — все функции приложения по-прежнему живут там (`window.hideModal`,
// `window.openOrderDetail`, ...). Поэтому переход на `data-action` не потребовал
// переписывать сами модули.
// =====================================================================

import { log } from './utils.js';

// Действия, которых нет среди функций приложения: их объявляет сам диспетчер.
const BUILT_IN = {
    'reload-page': () => window.location.reload()
};

const registry = new Map(Object.entries(BUILT_IN));

/**
 * Добавляет действия в реестр — для модулей, которые не выставляют функции
 * на `window`. Обычно не нужен: `window.foo = foo` уже достаточно.
 * @param {Record<string, Function>} actions — имя → функция
 */
export function registerActions(actions) {
    for (const [name, fn] of Object.entries(actions)) {
        registry.set(name, fn);
    }
}

function resolve(name) {
    if (registry.has(name)) return registry.get(name);
    const fn = window[name];
    return typeof fn === 'function' ? fn : null;
}

/**
 * `data-arg` приходит строкой. Числа (id заявок, сотрудников, объектов)
 * передаём числом: модули сравнивают их с id из базы.
 */
function toArg(value) {
    const text = String(value).trim();
    if (/^-?\d+$/.test(text)) return Number(text);
    return String(value);
}

const DEFAULT_KEYS = 'Enter Space';
const EVENTS = ['click', 'change', 'input', 'submit', 'keydown'];

function runAction(el, event) {
    if (el.hasAttribute('data-prevent')) event.preventDefault();
    if (el.hasAttribute('data-stop')) event.stopPropagation();

    const removeId = el.dataset.remove;
    if (removeId) document.getElementById(removeId)?.remove();

    const name = el.dataset.action;
    const fn = resolve(name);

    if (!fn) {
        // Молчать нельзя: такое действие просто «не нажимается», а причина
        // не видна ни в интерфейсе, ни в отчёте прогонов.
        log.warn(`Действие интерфейса не найдено: ${name} (см. js/actions.js)`);
        return;
    }

    let args = [];
    if (el.hasAttribute('data-pass-event')) args = [event];
    else if (el.hasAttribute('data-arg-value')) args = [el.value];
    else if (el.hasAttribute('data-arg-checked')) args = [el.checked];
    else if (el.hasAttribute('data-arg')) args = [toArg(el.dataset.arg)];

    const result = fn(...args);

    const after = el.dataset.after;
    if (after) {
        const afterFn = resolve(after);
        if (afterFn) {
            const afterArg = el.dataset.afterArg;
            afterFn(...(afterArg === undefined ? [] : [toArg(afterArg)]));
        } else {
            log.warn(`Действие интерфейса не найдено: ${after} (data-after, см. js/actions.js)`);
        }
    }

    return result;
}

function makeHandler(type) {
    return (event) => {
        const start = event.target instanceof Element ? event.target : null;
        if (!start) return;

        // Берём САМЫЙ ВНУТРЕННИЙ элемент с действием: кнопка внутри
        // кликабельной карточки важнее карточки. `data-skip` (без
        // `data-action`) — «дальше не ищи»: кнопка внутри карточки не даёт
        // карточке сработать по Enter.
        const el = start.closest('[data-action], [data-skip]');
        if (!el) return;

        const wanted = (el.dataset.on || 'click').split(/\s+/);
        if (!wanted.includes(type)) return;

        if (type === 'keydown') {
            const keys = (el.dataset.keys || DEFAULT_KEYS).split(/\s+/);
            if (!keys.includes(event.key)) return;
        }

        if (el.hasAttribute('data-skip') && !el.hasAttribute('data-action')) {
            if (el.hasAttribute('data-prevent')) event.preventDefault();
            if (el.hasAttribute('data-stop')) event.stopPropagation();
            return;
        }

        runAction(el, event);
    };
}

// Слушатель один на весь документ: перерисованные списки (innerHTML) работают
// без повторного навешивания обработчиков на новые элементы.
for (const type of EVENTS) {
    document.addEventListener(type, makeHandler(type));
}

// Ошибка загрузки картинки: `error` не всплывает, поэтому слушаем на
// поглощающей фазе. Вместо подстановки HTML (`onerror="this.outerHTML=..."`)
// прячем картинку и показываем заготовленный запасной блок из разметки —
// так подставленный текст не может стать разметкой.
document.addEventListener('error', (event) => {
    const el = event.target;
    if (!(el instanceof HTMLImageElement)) return;

    const fallbackId = el.dataset.fallbackShow;
    if (!fallbackId) return;

    const fallback = document.getElementById(fallbackId);
    if (!fallback) return;

    el.classList.add('hidden');
    fallback.classList.remove('hidden');
}, true);
