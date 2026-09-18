// =====================================================================
// МОДУЛЬ: ДОП. РАСХОДЫ (вне сметы)
// =====================================================================
// Подвкладка «📦 Доп. расходы» в карточке объекта (сразу после «📊 План-факт»).
//
// Зачем: смета описывает план, но на стройке постоянно появляется то, чего
// в ней нет — докупить материал, оплатить рабочим подрезку, вывезти мусор.
// Раньше такие траты было некуда отнести: создание заказа/запроса/расхода
// требовало раздела сметы, а разделы появляются только из Excel-файла.
//
// Решение: в каждом объекте есть служебный раздел «Доп. расходы»
// (CONFIG.EXTRA_SECTION.NAME, создаётся автоматически — js/modules/sections.js).
// Сотрудник выбирает его в форме заказа материалов, финансового запроса
// или в авансовом отчёте, и всё это собирается здесь:
//   * расходы подотчёта (cash_operations, category: works/materials/delivery/other);
//   * заказы материалов с оплатой фирмой (закрытые/архив) — как в план-факте;
//   * заказы материалов по этому объекту (все статусы — что заказано);
//   * финансовые запросы на работы.
//
// В план-факт по смете эти суммы НЕ попадают (там план = смета),
// поэтому карточка показывает их отдельной строкой «⚠ Доп. расходы».
// =====================================================================

import { db } from '../database.js';
import { CONFIG } from '../config.js';
import {
    log, escapeHtml, formatMoney, formatDate,
    getOrderStatusBadge, isExtraSectionName
} from '../utils.js';
import { getCategoryLabel, loadExpensesForProject } from './cash.js';
import { getCashRequestStatusInfo } from './cash-requests.js';
import { loadSectionsWithExtra } from './sections.js';

const EXTRA_SECTION_NAME = CONFIG.EXTRA_SECTION?.NAME || 'Доп. расходы';

// =====================================================================
// РАСЧЁТ ИТОГОВ (чистая функция — удобно проверять тестами)
// =====================================================================

/**
 * Итоги по тратам вне сметы.
 * materials включает delivery: так же считает план-факт (estimate.js → calcFacts).
 *
 * @param {Array<Object>} operations
 * @returns {{ works, materials, delivery, other, total, count }}
 */
export function calcExtraTotals(operations) {
    let works = 0;
    let materials = 0;
    let delivery = 0;
    let other = 0;

    (operations || []).forEach(op => {
        const amount = Number(op.amount) || 0;

        switch (op.category) {
            case 'works':     works += amount; break;
            case 'materials': materials += amount; break;
            case 'delivery':  delivery += amount; break;
            default:          other += amount;
        }
    });

    const materialsAll = materials + delivery;

    return {
        works,
        materials: materialsAll,
        delivery,
        other,
        total: works + materialsAll + other,
        count: (operations || []).length
    };
}

// =====================================================================
// ЗАГРУЗКА ДАННЫХ
// =====================================================================

/**
 * Сравнение операций по дате (свежие сверху).
 */
function byOperationDateDesc(a, b) {
    const left = String(a.operation_date || a.created_at || '');
    const right = String(b.operation_date || b.created_at || '');
    return right.localeCompare(left);
}

/**
 * Всё, что привязано к служебному разделу «Доп. расходы»:
 * расходы подотчёта (+ позиции закрытых заявок с оплатой фирмой),
 * заказы материалов и финансовые запросы.
 *
 * @param {Object} project
 * @returns {Promise<{ extraSection, operations, orders, requests, error }>}
 */
async function loadExtraCostsData(project) {
    const { extraSection, estimateSections, error: sectionError } = await loadSectionsWithExtra(project.id);

    if (!extraSection) {
        return { extraSection: null, estimateSections: [], operations: [], orders: [], requests: [], error: sectionError };
    }

    const [expensesResult, ordersResult, requestsResult] = await Promise.all([
        loadExpensesForProject(project.id),
        db.select('orders', {
            filters: { section_id: extraSection.id },
            orderBy: { column: 'created_at', asc: false }
        }),
        db.select('cash_requests', {
            filters: { section_id: extraSection.id },
            orderBy: { column: 'created_at', asc: false }
        })
    ]);

    if (ordersResult.error) log.warn('Доп. расходы: не удалось загрузить заявки —', ordersResult.error.message);
    if (requestsResult.error) log.warn('Доп. расходы: не удалось загрузить финансовые запросы —', requestsResult.error.message);

    const operations = (expensesResult.extraOps || []).slice().sort(byOperationDateDesc);
    const orders = ordersResult.data || [];
    const requests = requestsResult.data || [];

    // Имена сотрудников — одним запросом на все три списка
    const employeeIds = [...new Set([
        ...operations.map(op => op.employee_id),
        ...orders.map(order => order.created_by_employee_id),
        ...requests.map(request => request.employee_id)
    ].filter(Boolean))];

    const employeeMap = {};
    if (employeeIds.length > 0) {
        const { data: employees } = await db.select('employees', {
            select: 'id, name',
            filters: { 'id.in': employeeIds }
        });
        (employees || []).forEach(employee => { employeeMap[employee.id] = employee; });
    }

    orders.forEach(order => { order._employee = employeeMap[order.created_by_employee_id] || null; });
    requests.forEach(request => { request._employee = employeeMap[request.employee_id] || null; });

    return {
        extraSection,
        estimateSections,
        operations: operations.map(op => ({
            ...op,
            _employee: op._employee || employeeMap[op.employee_id] || null
        })),
        orders,
        requests,
        error: null
    };
}

// =====================================================================
// РЕНДЕР: СВОДКА
// =====================================================================

function renderExtraSummary(totals, planTotal) {
    const extraNote = planTotal > 0
        ? `<p class="text-[11px] text-amber-800">⚠ Эти траты не входят в план сметы: доп. расходы — ${((totals.total / planTotal) * 100).toFixed(1)}% от плана (${formatMoney(planTotal)}).</p>`
        : `<p class="text-[11px] text-amber-800">⚠ Эти траты не входят в план сметы (у объекта нет сметы — весь факт собирается здесь).</p>`;

    const card = (icon, label, value, hint = '') => `
        <div class="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p class="text-[10px] font-bold uppercase tracking-wider text-amber-800">${icon} ${label}</p>
            <p class="mt-1 text-base font-bold text-gray-800">${formatMoney(value)}</p>
            ${hint ? `<p class="text-[10px] text-gray-500">${hint}</p>` : ''}
        </div>
    `;

    return `
        <div class="space-y-2">
            <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
                ${card('💰', 'Итого вне сметы', totals.total, `Записей: ${totals.count}`)}
                ${card('🛠', 'Работы', totals.works)}
                ${card('📦', 'Материалы', totals.materials, totals.delivery > 0 ? `в т.ч. доставка: ${formatMoney(totals.delivery)}` : '')}
                ${card('📋', 'Прочее', totals.other)}
            </div>
            ${extraNote}
        </div>
    `;
}

// =====================================================================
// РЕНДЕР: РАСХОДЫ ПОДОТЧЁТА
// =====================================================================

function renderExtraOperation(op) {
    const categoryLabel = op.category ? getCategoryLabel(op.category) : '—';
    const employeeName = op._employee?.name || '—';
    const isFromOrder = op._isOrderItem || op._source === 'order' || op._source === 'order_employee';

    const sourceBadge = isFromOrder
        ? `<span class="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">📦 по заявке${op._orderNumber ? ' ' + escapeHtml(op._orderNumber) : ''}</span>`
        : `<span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold text-gray-600">🧾 авансовый отчёт</span>`;

    const itemsHtml = Array.isArray(op.items) && op.items.length > 0
        ? `<div class="mt-2 space-y-0.5 border-t pt-2">
                ${op.items.map(item => `
                    <div class="flex justify-between gap-2 text-[11px] text-gray-600">
                        <span>${escapeHtml(item.name || '—')} — ${item.qty || 0} ${escapeHtml(item.unit || '')} × ${formatMoney(item.price || 0)}</span>
                        <span class="whitespace-nowrap font-semibold">${formatMoney(item.sum || 0)}</span>
                    </div>
                `).join('')}
           </div>`
        : '';

    const receiptHtml = op.receipt_path
        ? `<button onclick="window.viewReceipt('${escapeHtml(op.receipt_path)}')" class="mt-1 text-[10px] text-blue-600 hover:underline">📎 Чек</button>`
        : '';

    return `
        <div class="rounded-lg border border-amber-100 bg-white p-3 text-xs">
            <div class="flex items-start justify-between gap-2">
                <div class="flex-1 space-y-0.5">
                    <p class="flex flex-wrap items-center gap-1.5 font-semibold text-gray-800">
                        <span>${escapeHtml(categoryLabel)}</span>
                        ${sourceBadge}
                    </p>
                    <p class="text-[11px] text-gray-500">👤 ${escapeHtml(employeeName)}</p>
                    ${op.description ? `<p class="text-[11px] text-gray-500">${escapeHtml(op.description)}</p>` : ''}
                </div>
                <span class="whitespace-nowrap font-bold text-red-700">− ${formatMoney(op.amount || 0)}</span>
            </div>
            ${itemsHtml}
            ${receiptHtml}
            <p class="mt-1 border-t pt-1 text-[10px] text-gray-400">📅 ${formatDate(op.operation_date || op.created_at)}</p>
        </div>
    `;
}

function renderExtraOperationsBlock(operations) {
    if (!operations || operations.length === 0) return '';

    return `
        <div class="space-y-2">
            <h4 class="text-xs font-bold uppercase tracking-wider text-gray-700">
                🧾 Расходы подотчёта <span class="text-gray-400">(${operations.length})</span>
            </h4>
            <div class="space-y-2">${operations.map(renderExtraOperation).join('')}</div>
        </div>
    `;
}

// =====================================================================
// РЕНДЕР: ЗАЯВКИ И ФИНАНСОВЫЕ ЗАПРОСЫ
// =====================================================================

function renderExtraOrdersBlock(orders) {
    if (!orders || orders.length === 0) return '';

    const rows = orders.map(order => `
        <tr class="cursor-pointer hover:bg-amber-50/60" onclick="window.openOrderDetail(${order.id})">
            <td class="p-2 font-semibold text-[#166534] whitespace-nowrap">${escapeHtml(order.request_number || '—')}</td>
            <td class="p-2 whitespace-nowrap text-gray-600">${formatDate(order.created_at)}</td>
            <td class="p-2 text-gray-700">${escapeHtml(order.supplier || '—')}</td>
            <td class="p-2">${getOrderStatusBadge(order.status)}</td>
            <td class="p-2 whitespace-nowrap text-gray-600">${order.payment_source === 'employee' ? 'За счёт сотрудника' : 'За счёт фирмы'}</td>
            <td class="p-2 whitespace-nowrap text-right font-bold text-gray-800">${formatMoney(order.total_sum || 0)}</td>
        </tr>
    `).join('');

    return `
        <div class="space-y-2">
            <h4 class="text-xs font-bold uppercase tracking-wider text-gray-700">
                📦 Заказы материалов <span class="text-gray-400">(${orders.length})</span>
            </h4>
            <div class="overflow-x-auto rounded-xl border bg-white">
                <table class="w-full min-w-[560px] text-xs">
                    <thead class="bg-gray-100 text-[10px] uppercase text-gray-600">
                        <tr>
                            <th class="p-2 text-left">Номер</th>
                            <th class="p-2 text-left">Создана</th>
                            <th class="p-2 text-left">Поставщик</th>
                            <th class="p-2 text-left">Статус</th>
                            <th class="p-2 text-left">Оплата</th>
                            <th class="p-2 text-right">Сумма</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y">${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

function renderExtraRequestsBlock(requests) {
    if (!requests || requests.length === 0) return '';

    const rows = requests.map(request => {
        const status = getCashRequestStatusInfo(request.status);

        return `
            <tr class="cursor-pointer hover:bg-amber-50/60" onclick="window.openCashRequestDetail(${request.id})">
                <td class="p-2 font-semibold text-[#166534] whitespace-nowrap">${escapeHtml(request.request_number || '—')}</td>
                <td class="p-2 whitespace-nowrap text-gray-600">${formatDate(request.created_at)}</td>
                <td class="p-2 text-gray-700">${escapeHtml(request._employee?.name || '—')}</td>
                <td class="p-2"><span class="rounded px-2 py-0.5 text-[10px] font-bold ${status.bg} ${status.color}">${escapeHtml(status.label)}</span></td>
                <td class="p-2 whitespace-nowrap text-right font-bold text-gray-800">${formatMoney(request.total_sum || 0)}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="space-y-2">
            <h4 class="text-xs font-bold uppercase tracking-wider text-gray-700">
                💰 Финансовые запросы <span class="text-gray-400">(${requests.length})</span>
            </h4>
            <div class="overflow-x-auto rounded-xl border bg-white">
                <table class="w-full min-w-[520px] text-xs">
                    <thead class="bg-gray-100 text-[10px] uppercase text-gray-600">
                        <tr>
                            <th class="p-2 text-left">Номер</th>
                            <th class="p-2 text-left">Создан</th>
                            <th class="p-2 text-left">Сотрудник</th>
                            <th class="p-2 text-left">Статус</th>
                            <th class="p-2 text-right">Сумма</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y">${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

// =====================================================================
// ОСНОВНОЙ РЕНДЕР ПОДВКЛАДКИ «📦 ДОП. РАСХОДЫ»
// =====================================================================

/**
 * Рисует подвкладку карточки объекта.
 * Контейнер — #proj-subtab-extra (index.html), кнопка — #subbtn-extra.
 *
 * @param {Object} project
 */
export async function renderExtraCostsUI(project) {
    const container = document.getElementById('proj-subtab-extra');

    if (!container) {
        // Регрессия-маркер: контейнер должен быть в index.html рядом с другими подвкладками.
        log.warn('Не найден контейнер #proj-subtab-extra — подвкладка «Доп. расходы» не отрисована');
        return;
    }

    if (!project) return;

    container.innerHTML = '<div class="app-loading app-loading-card text-sm text-gray-500"><span>Загрузка доп. расходов...</span></div>';

    const { extraSection, estimateSections, operations, orders, requests, error } = await loadExtraCostsData(project);

    if (!extraSection || error) {
        container.innerHTML = `
            <div class="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-xs text-red-700">
                Не удалось открыть раздел «${escapeHtml(EXTRA_SECTION_NAME)}» для объекта «${escapeHtml(project.name || '')}».
                <br>Проверьте права доступа к таблице sections (нужна вставка строк) и обновите страницу.
            </div>
        `;
        log.error('Доп. расходы: служебный раздел недоступен', error?.message || 'нет данных');
        return;
    }

    const totals = calcExtraTotals(operations);
    const planTotal = (estimateSections || []).reduce((sum, section) => sum + (Number(section.plan_total) || 0), 0);
    const sectionName = escapeHtml(extraSection.name);

    const headerHtml = `
        <div class="overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-2 bg-amber-500 px-4 py-3 text-white">
                <h3 class="text-sm font-bold">⚠ ${sectionName} (вне сметы)</h3>
                <button onclick="window.__renderExtraCostsUI()"
                        class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold transition hover:bg-amber-700">
                    ↻ Обновить
                </button>
            </div>
            <div class="space-y-3 p-4">
                <p class="text-xs text-gray-500">
                    Здесь собираются работы и материалы, которых нет в смете: заказы материалов, расходы из авансового отчёта
                    и финансовые запросы, в которых выбран раздел «${sectionName}».
                    В «📊 План-факт» эти суммы не входят — там план строго по смете.
                </p>
                ${renderExtraSummary(totals, planTotal)}
            </div>
        </div>
    `;

    const emptyHtml = `
        <div class="rounded-xl border bg-gray-50 p-6 text-center text-xs text-gray-500">
            Пока пусто.
            <br>Чтобы записать незапланированный расход, при оформлении заказа материалов, финансового запроса
            или в авансовом отчёте выбери объект, а в поле «Раздел» — группу
            <b class="text-amber-700">⚠ Вне сметы → ${sectionName}</b>.
        </div>
    `;

    const blocksHtml = [
        renderExtraOperationsBlock(operations),
        renderExtraOrdersBlock(orders),
        renderExtraRequestsBlock(requests)
    ].filter(Boolean).join('');

    container.innerHTML = `
        <div class="space-y-4">
            ${headerHtml}
            ${blocksHtml || emptyHtml}
        </div>
    `;
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

// Кнопка «↻ Обновить» внутри подвкладки: берём текущий объект из карточки
window.__renderExtraCostsUI = () => {
    const project = window.__getCurrentProject?.();
    if (project) renderExtraCostsUI(project);
};
