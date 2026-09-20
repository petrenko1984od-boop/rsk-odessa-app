// =====================================================================
// МОДУЛЬ: СНАБЖЕНИЕ (заявки на материалы)
// =====================================================================
// Заявки: прораб создаёт → снабженец обрабатывает → закрывает.
// При закрытии: расход попадает в план-факт объекта + реестр.
//
// Статусы:
//   new         — 🔴 Новая
//   in_progress — 🟡 В работе
//   closed      — 🟢 Закрыта
//   archived    — 📥 Архив
//
// Права:
//   - Создание: все, кроме Директора. Прораб — только для своих объектов.
//   - Обработка: Снабженец + Администратор.
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    formatDate, formatDateTime, formatMoney, roundMoney
} from '../utils.js';
import {
    can, requirePermission, getEmployee, isAdmin, canSeeHeaderButton, canSeeTab
} from '../permissions.js';
import { CONFIG } from '../config.js';
import { t } from '../i18n.js';
import { fillSectionsSelect } from './sections.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let ordersCache = [];         // Все загруженные заявки
let currentFilter = 'active'; // Текущий фильтр
let currentOrderId = null;    // Открытая карточка заявки

// =====================================================================
// ПРАВА
// =====================================================================

/**
 * Может ли текущий пользователь создавать заявки?
 * Право 'create_order' есть у всех, кроме Директора (см. permissions.js).
 */
function canCreateOrder() {
    return can('create_order');
}

/**
 * Может ли текущий пользователь обрабатывать заявки?
 */
function canProcessOrder() {
    return can('process_order');
}

/**
 * Видит ли текущий пользователь эту заявку?
 */
function canSeeOrder(order) {
    const emp = getEmployee();
    if (!emp) return false;

    // Если не прораб — видит все
    if (emp.position !== 'Прораб') return true;

    // Прораб видит только свои объекты
    return order.created_by_employee_id === emp.id;
}

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

export async function loadOrders() {
    log.info('Загрузка заявок...');

    const { data, error } = await db.select('orders', {
        select: `
            *,
            project:projects ( id, name ),
            section:sections ( id, name ),
            created_by_emp:employees!orders_created_by_employee_id_fkey ( id, name, position ),
            payer:employees!orders_payer_employee_id_fkey ( id, name, position )
        `,
        orderBy: { column: 'created_at', asc: false }
    });

    if (error) {
        log.error('Ошибка загрузки заявок:', error.message);
        toast('Не удалось загрузить заявки', 'error');
        return;
    }

    // Фильтруем по правам
    const allOrders = data || [];
    ordersCache = allOrders.filter(canSeeOrder);

    // Загружаем позиции одним запросом
    if (ordersCache.length > 0) {
        const orderIds = ordersCache.map(o => o.id);
        const { data: items } = await db.select('order_items', {
            filters: { 'order_id.in': orderIds }
        });

        const itemsMap = {};
        (items || []).forEach(it => {
            if (!itemsMap[it.order_id]) itemsMap[it.order_id] = [];
            itemsMap[it.order_id].push(it);
        });

        ordersCache.forEach(o => {
            o._items = itemsMap[o.id] || [];
        });
    }

    log.info(`Загружено заявок: ${ordersCache.length}`);
    renderOrders();
}

// =====================================================================
// ФИЛЬТРАЦИЯ
// =====================================================================

function getFilteredOrders() {
    if (currentFilter === 'all') return ordersCache;

    if (currentFilter === 'active') {
        return ordersCache.filter(o => o.status === 'new' || o.status === 'in_progress');
    }

    return ordersCache.filter(o => o.status === currentFilter);
}

export function switchOrdersTab(filter) {
    currentFilter = filter;

    const filters = ['active', 'new', 'in_progress', 'delivered', 'closed', 'archived', 'all'];
    filters.forEach(f => {
        const btn = document.getElementById(`orders-filter-${f}`);
        if (!btn) return;
        if (f === filter) {
            btn.classList.remove('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200');
            btn.classList.add('bg-[#15803d]', 'text-white');
        } else {
            btn.classList.add('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200');
            btn.classList.remove('bg-[#15803d]', 'text-white');
        }
    });

    renderOrders();
}

// =====================================================================
// РЕНДЕР СПИСКА
// =====================================================================

export function renderOrders() {
    const container = document.getElementById('orders-container');
    if (!container) return;

    const filtered = getFilteredOrders();

    // Скрываем кнопку «Заказ материалов» в шапке (у снабженца её заменяет
    // «➕ Создать заявку» внутри «Рабочего экрана», см. ROLE_UI в permissions.js)
    const newOrderBtn = document.getElementById('btn-new-order');
    if (newOrderBtn) {
        const allowed = canCreateOrder() && canSeeHeaderButton('btn-new-order');
        newOrderBtn.style.display = allowed ? '' : 'none';
    }

    // Скрываем кнопку создания внутри вкладки
    const createBtn = document.getElementById('create-order-btn');
    if (createBtn) {
        createBtn.style.display = canCreateOrder() ? '' : 'none';
    }

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="bg-white rounded-xl shadow-sm border-2 border-dashed border-gray-300 p-8 text-center space-y-2">
                <div class="text-5xl">📦</div>
                <h3 class="font-bold text-gray-700">Заявок нет</h3>
                <p class="text-sm text-gray-500">
                    ${canCreateOrder() ? 'Нажми «➕ Создать заявку», чтобы оформить новую' : 'Пока заявок нет'}
                </p>
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(renderOrderCard).join('');
}

function renderOrderCard(order) {
    const statusInfo = getStatusInfo(order.status);
    const items = order._items || [];
    const projectName = order.project?.name || '—';
    const sectionName = order.section?.name || '—';
    const creatorName = order.created_by_emp?.name || '—';
    const payerName = order.payer?.name || null;
    const totalSum = Number(order.total_sum) || 0;

    // Бейджи оплаты и счёта
    let paymentBadge = '';
    if (order.status === 'closed' || order.status === 'archived') {
        if (order.payment_source === 'company') {
            paymentBadge = `<span class="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-bold">🏢 Фирма</span>`;
        } else if (order.payment_source === 'employee') {
            paymentBadge = `<span class="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold">💵 ${escapeHtml(payerName || 'Сотрудник')}</span>`;
        }
    }

    // Счёт загружен / оплата ещё не прошла — видно прямо в списке
    const invoiceBadge = order.invoice_path
        ? `<span class="text-[10px] bg-white border border-amber-300 text-amber-800 px-2 py-0.5 rounded font-bold">🧾 ${t('invoice.of')}</span>`
        : '';

    // Бейдж оплаты — из общего правила (orderPaymentState): «Ожидает оплаты»
    // для долга фирмы, «Оплачено» только когда статус оплаты действительно
    // известен. Пусто — заявка ещё не дошла до денег (нет ни счёта, ни доставки).
    const payState = orderPaymentState(order);

    let payBadge = '';
    if (payState === 'debt') {
        payBadge = `<span class="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold">${t('order.paymentPending')}</span>`;
    } else if (payState === 'paid') {
        payBadge = `<span class="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded font-bold">${t('order.paymentPaid')}</span>`;
    }

    return `
        <button onclick="window.openOrderDetail(${order.id})"
                class="w-full text-left bg-white rounded-xl shadow-sm border p-4 flex flex-col gap-3 border-l-4 ${statusInfo.border} hover:bg-emerald-50/50 transition cursor-pointer group">
            <div class="flex justify-between items-start gap-2 w-full">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-bold text-[#15803d] font-mono text-sm bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">${escapeHtml(order.request_number)}</span>
                    <span class="text-xs font-bold px-2 py-0.5 rounded ${statusInfo.bg} ${statusInfo.color}">${statusInfo.label}</span>
                    ${invoiceBadge}
                    ${payBadge}
                    ${paymentBadge}
                </div>
                ${totalSum > 0 ? `<span class="text-sm font-bold text-[#166534] whitespace-nowrap">${formatMoney(totalSum)}</span>` : ''}
            </div>

            <div class="space-y-1">
                <p class="text-xs text-gray-600"><strong>🏗 Объект:</strong> <span class="text-gray-900 font-semibold">${escapeHtml(projectName)}</span></p>
                <p class="text-xs text-gray-600"><strong>📂 Раздел:</strong> ${escapeHtml(sectionName)}</p>
            </div>

            <div class="bg-gray-50 border rounded-lg p-2 text-xs space-y-0.5">
                ${items.length > 0 
                    ? items.slice(0, 3).map(it => `
                        <div class="flex justify-between text-gray-700">
                            <span>📦 ${escapeHtml(it.name)} — ${it.qty} ${escapeHtml(it.unit || '')}</span>
                            ${it.total_price ? `<span class="text-gray-500 font-semibold">${formatMoney(it.total_price)}</span>` : ''}
                        </div>
                    `).join('') + (items.length > 3 ? `<p class="text-[10px] text-gray-400 italic pt-1">и ещё ${items.length - 3}...</p>` : '')
                    : `<p class="text-gray-400 italic">Нет позиций</p>`}
            </div>

            <div class="flex justify-between items-center pt-1 border-t text-[10px] text-gray-400">
                <span>👤 Создал: ${escapeHtml(creatorName)}</span>
                <span>📅 ${formatDate(order.created_at)}</span>
            </div>
        </button>
    `;
}

// =====================================================================
// КАРТОЧКА ЗАЯВКИ (просмотр)
// =====================================================================

/**
 * Статус оплаты заявки для интерфейса:
 *   null   — об оплате речи ещё нет (заявку не взяли в работу, счёта нет);
 *   'debt' — «⏳ Ожидает оплаты»;
 *   'paid' — «✅ Оплачено».
 *
 * Оплата живёт на заявке (её отмечает финансист по счёту), позиции лишь
 * наследуют статус — поэтому смотрим на заявку, а не на каждую позицию.
 * Раньше карточка рисовала бейдж по order_items.payment_status, а при
 * создании заявки позиции сразу получали 'paid': «Новая» заявка показывала
 * «✅ Оплачено», хотя денег никто не платил (и позиции финансиста по ней
 * не ждали).
 */
function orderPaymentState(order) {
    if (!order) return null;

    // Отметка финансиста «счёт оплачен» — самый надёжный признак.
    if (order.paid_at) return 'paid';

    const items = order._items || [];
    const delivered = order.status === 'delivered'
        || order.status === 'closed'
        || order.status === 'archived';

    // Позиции помечены «Ожидает оплаты» — значит долг перед поставщиком открыт.
    if (order.payment_status === 'debt' || items.some(it => it.payment_status === 'debt')) {
        return 'debt';
    }

    // Ни счёта, ни доставки — показывать статус оплаты нечего.
    if (!delivered && !order.invoice_path) return null;

    // Материалы на объекте, платил снабженец из подотчёта — деньги уже ушли.
    if (order.payment_source === 'employee' && delivered) return 'paid';

    // Заявка фирмы без признака долга: так выглядят закупки, закрытые
    // до v2.4 (и они уже оплачены) либо оплаченные финансистом.
    return 'paid';
}

export async function openOrderDetail(id) {
    const order = ordersCache.find(o => o.id === id);
    if (!order) {
        toast('Заявка не найдена', 'error');
        return;
    }

    currentOrderId = id;

    const statusInfo = getStatusInfo(order.status);
    const items = order._items || [];

    const projectName = order.project?.name || '—';
    const sectionName = order.section?.name || '—';
    const creatorName = order.created_by_emp?.name || '—';
    const payerName = order.payer?.name || null;

    // Статус оплаты заявки: null — «ещё неизвестно», поэтому бейдж в карточке
    // показываем только когда он есть (см. orderPaymentState выше).
    const payState = orderPaymentState(order);

    const itemsHtml = items.length > 0
        ? items.map(it => `
            <div class="flex justify-between items-center bg-white border rounded-lg p-2 text-xs">
                <div class="flex-1 min-w-0">
                    <p class="font-semibold text-gray-800">📦 ${escapeHtml(it.name)}</p>
                    <p class="text-[11px] text-gray-500">${it.qty} ${escapeHtml(it.unit || '')} ${it.unit_price ? `× ${formatMoney(it.unit_price)}` : ''}</p>
                </div>
                <div class="text-right shrink-0">
                    ${it.total_price ? `<p class="font-bold text-[#166534]">${formatMoney(it.total_price)}</p>` : ''}
                    ${payState ? `<span class="text-[10px] px-1.5 py-0.5 rounded ${payState === 'debt' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-700'} font-bold">${payState === 'debt' ? t('order.paymentPending') : t('order.paymentPaid')}</span>` : ''}
                </div>
            </div>
        `).join('')
        : '<p class="text-center text-gray-400 italic py-3 text-sm">Нет позиций</p>';

    let paymentHtml = '';
    if (order.status === 'closed' || order.status === 'archived') {
        if (order.payment_source === 'company') {
            paymentHtml = `
                <div class="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs space-y-1">
                    <p class="font-bold text-blue-800">🏢 Оплата фирмой (по счёту)</p>
                </div>
            `;
        } else if (order.payment_source === 'employee') {
            paymentHtml = `
                <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs space-y-1">
                    <p class="font-bold text-amber-800">💵 Оплата сотрудником из подотчёта</p>
                    <p class="text-gray-600">Плательщик: <b>${escapeHtml(payerName || '—')}</b></p>
                </div>
            `;
        }
    }

    const container = document.getElementById('order-detail-content');
    if (!container) return;

    container.innerHTML = `
        <div class="flex flex-wrap justify-between items-center gap-2 bg-emerald-50 p-3 rounded-lg border border-emerald-200">
            <div class="flex items-center gap-2 flex-wrap">
                <span class="font-bold text-[#15803d] font-mono text-base">${escapeHtml(order.request_number)}</span>
                <span class="text-xs font-bold px-2 py-0.5 rounded ${statusInfo.bg} ${statusInfo.color}">${statusInfo.label}</span>
            </div>
            ${order.total_sum > 0 ? `<span class="font-bold text-[#166534]">${formatMoney(order.total_sum)}</span>` : ''}
        </div>

        <div class="bg-gray-50 p-3 rounded-lg border space-y-2 text-xs">
            <p><strong>🏗 Объект:</strong> <span class="font-semibold text-gray-800">${escapeHtml(projectName)}</span></p>
            <p><strong>📂 Раздел:</strong> <span class="font-semibold text-gray-800">${escapeHtml(sectionName)}</span></p>
            <p><strong>👤 Создал:</strong> ${escapeHtml(creatorName)}</p>
            <p><strong>📅 Создано:</strong> ${formatDate(order.created_at)}</p>
            ${order.desired_date ? `<p><strong>⏳ Желаемая поставка:</strong> ${formatDate(order.desired_date)}</p>` : ''}
            ${order.supplier ? `<p><strong>🏬 Поставщик:</strong> <span class="font-semibold text-gray-800">${escapeHtml(order.supplier)}</span></p>` : ''}
            ${order.purchase_notes ? `<p><strong>📝 Комментарий:</strong> ${escapeHtml(order.purchase_notes)}</p>` : ''}
            ${order.invoice_path ? `
                <p><strong>🧾 ${t('invoice.of')}:</strong>
                   ${escapeHtml(order.invoice_file_name || '—')}
                   ${order.invoice_total ? `· <b>${formatMoney(order.invoice_total)}</b>` : ''}
                   ${order.invoice_uploaded_at ? `· ${formatDate(order.invoice_uploaded_at)}` : ''}
                   <button onclick="window.viewOrderInvoice(${order.id})"
                           class="text-[#15803d] font-semibold hover:underline ml-1">${t('common.open')}</button>
                </p>
            ` : ''}
            ${payState === 'debt' ? `<p class="text-amber-700 font-semibold">${t('order.paymentPending')}</p>` : ''}
            ${order.paid_at ? `<p><strong>${t('invoice.paidAt')}:</strong> ${formatDateTime(order.paid_at)}</p>` : ''}
            ${order.delivered_at ? `<p><strong>🚚 ${t('invoice.delivered')}:</strong> ${formatDate(order.delivered_at)}</p>` : ''}
            ${order.closed_at ? `<p><strong>✅ Закрыто:</strong> ${formatDate(order.closed_at)}</p>` : ''}
        </div>

        ${paymentHtml}

        <div class="space-y-2 pt-2">
            <p class="text-xs font-bold text-gray-500 uppercase tracking-wider">📦 Позиции (${items.length}):</p>
            <div class="space-y-1">
                ${itemsHtml}
            </div>
        </div>
    `;

    renderOrderActions(order);
    showModal('order-detail-modal');
}

function renderOrderActions(order) {
    const actionsContainer = document.getElementById('order-detail-actions');
    if (!actionsContainer) return;

    let buttonsHtml = '';

    if (order.status === 'new' && canProcessOrder()) {
        buttonsHtml += `<button onclick="window.takeOrderToWork(${order.id})" class="bg-yellow-500 hover:bg-yellow-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">${t('order.takeToWork')}</button>`;
    }

    // Счёт можно загрузить и до доставки, и после: материалы приезжают
    // раньше оплаты, а счёт иногда присылают позже накладной.
    if ((order.status === 'in_progress' || order.status === 'delivered') && canProcessOrder()) {
        buttonsHtml += `<button onclick="window.openOrderInvoiceModal(${order.id})" class="bg-amber-500 hover:bg-amber-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">${t('order.invoiceButton')}</button>`;
    }

    if (order.status === 'in_progress' && canProcessOrder()) {
        buttonsHtml += `<button onclick="window.openCloseOrderModal(${order.id})" class="bg-[#15803d] hover:bg-[#166534] text-white font-semibold px-4 py-2 rounded-lg text-sm transition">${t('order.deliveredButton')}</button>`;
    }

    if ((order.status === 'delivered' || order.status === 'closed') && canProcessOrder()) {
        buttonsHtml += `<button onclick="window.archiveOrder(${order.id})" class="bg-gray-500 hover:bg-gray-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">${t('order.toArchive')}</button>`;
    }

    // Удаление — только Админ + только new
    if (order.status === 'new' && isAdmin()) {
        buttonsHtml += `<button onclick="window.deleteOrder(${order.id})" class="bg-red-100 hover:bg-red-200 text-red-700 font-semibold px-4 py-2 rounded-lg text-sm transition">🗑 Удалить</button>`;
    }

    actionsContainer.innerHTML = buttonsHtml;
}

// =====================================================================
// ХЕЛПЕРЫ
// =====================================================================

export function getStatusInfo(status) {
    const labels = CONFIG.STATUS_LABELS.ORDERS;
    const map = {
        'new':         { label: labels.new,         bg: 'bg-red-100',    color: 'text-red-700',    border: 'border-red-400' },
        'in_progress': { label: labels.in_progress, bg: 'bg-yellow-100', color: 'text-yellow-800', border: 'border-yellow-400' },
        'delivered':   { label: labels.delivered,   bg: 'bg-emerald-100', color: 'text-emerald-800', border: 'border-[#15803d]' },
        'closed':      { label: labels.closed,      bg: 'bg-green-100',  color: 'text-green-700',  border: 'border-[#15803d]' },
        'archived':    { label: labels.archived,    bg: 'bg-gray-200',   color: 'text-gray-600',   border: 'border-gray-400' }
    };
    return map[status] || { label: status, bg: 'bg-gray-100', color: 'text-gray-700', border: 'border-gray-300' };
}

// =====================================================================
// ФОРМА СОЗДАНИЯ ЗАЯВКИ
// =====================================================================

export async function openNewOrderForm() {
    if (!canCreateOrder()) {
        toast('Нет прав на создание заявки', 'error');
        return;
    }

    document.getElementById('new-order-project').value = '';
    document.getElementById('new-order-section').innerHTML = '<option value="">Сначала выбери объект</option>';
    document.getElementById('new-order-date').valueAsDate = new Date();
    document.getElementById('new-order-comment').value = '';

    const itemsContainer = document.getElementById('new-order-items');
    itemsContainer.innerHTML = '';
    addOrderItemRow();

    await loadProjectsForOrder();
    recalcOrderTotal();

    showModal('new-order-modal');
}

async function loadProjectsForOrder() {
    const select = document.getElementById('new-order-project');
    if (!select) return;

    let filters = null;

    const emp = getEmployee();
    if (emp && emp.position === 'Прораб') {
        filters = { foreman_id: emp.id };
    }

    const { data, error } = await db.select('projects', {
        filters,
        orderBy: { column: 'name', asc: true }
    });

    if (error || !data) {
        select.innerHTML = '<option value="">Ошибка загрузки объектов</option>';
        return;
    }

    if (data.length === 0) {
        select.innerHTML = '<option value="">Нет доступных объектов</option>';
        return;
    }

    select.innerHTML = '<option value="">— Выбери объект —</option>' +
        data.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

/**
 * Селект «Раздел» в форме заказа материалов.
 * Разделы сметы — группой «📊 Разделы сметы», служебный «Доп. расходы» —
 * отдельной группой «⚠ Вне сметы» (для материалов и работ, которых нет в смете).
 */
export async function loadSectionsForOrder() {
    const projectId = parseInt(document.getElementById('new-order-project')?.value, 10);
    const sectionSelect = document.getElementById('new-order-section');

    await fillSectionsSelect(sectionSelect, projectId);
}

export function addOrderItemRow() {
    const container = document.getElementById('new-order-items');
    if (!container) return;

    const rowId = 'order-item-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

    const row = document.createElement('div');
    row.className = 'order-item-row bg-gray-50 border rounded-lg p-3 space-y-2';
    row.id = rowId;
    row.dataset.rowId = rowId;

    row.innerHTML = `
        <div class="flex gap-2 items-start">
            <div class="flex-1">
                <input type="text" placeholder="Наименование (Цемент М400)" 
                       class="order-item-name w-full border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
            </div>
            <button type="button" onclick="window.removeOrderItemRow('${rowId}')" 
                    class="text-red-500 hover:text-red-700 px-2 py-1 text-base font-bold shrink-0">✕</button>
        </div>
        <div class="grid grid-cols-2 gap-2">
            <input type="number" step="any" placeholder="Кол-во" 
                   class="order-item-qty border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]"
                   oninput="window.recalcOrderTotal()">
            <select class="order-item-unit border rounded-lg p-2 text-xs bg-white text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                <option value="шт">шт</option>
                <option value="м">м</option>
                <option value="кг">кг</option>
                <option value="т">т</option>
                <option value="м²">м²</option>
                <option value="м³">м³</option>
                <option value="уп">уп</option>
                <option value="л">л</option>
                <option value="меш">меш</option>
            </select>
        </div>
    `;

    container.appendChild(row);
    recalcOrderTotal();
}

export function removeOrderItemRow(rowId) {
    const container = document.getElementById('new-order-items');
    if (!container) return;

    if (container.querySelectorAll('.order-item-row').length <= 1) {
        toast('Должна быть хотя бы одна позиция', 'warning');
        return;
    }

    const row = document.getElementById(rowId);
    if (row) {
        row.remove();
        recalcOrderTotal();
    }
}

export function recalcOrderTotal() {
    const rows = document.querySelectorAll('.order-item-row');
    const count = rows.length;

    const counterEl = document.getElementById('new-order-items-count');
    if (counterEl) counterEl.textContent = count;
}

export async function saveNewOrder(event) {
    event.preventDefault();
    if (!canCreateOrder()) {
        toast('Нет прав на создание заявки', 'error');
        return;
    }

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняем...';

    // Кнопку возвращаем в исходный вид в finally: иначе после успешного
    // сохранения (или сбоя) она остаётся «Сохраняем...» и выключенной,
    // поэтому следующая заявка молча не отправляется.
    try {
        await createOrder(form);

    } catch (err) {
        log.error('Исключение при создании заявки:', err);
        toast('Не удалось создать заявку: ' + (err?.message || 'неизвестная ошибка'), 'error');

    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Создать заявку';
    }
}

/**
 * Собирает и сохраняет заявку на материалы.
 * Кнопку не трогает — это дело saveNewOrder, иначе при сбое она осталась бы
 * выключенной.
 */
async function createOrder(form) {
    const projectId = parseInt(document.getElementById('new-order-project').value, 10);
    const sectionId = parseInt(document.getElementById('new-order-section').value, 10);
    const desiredDate = document.getElementById('new-order-date').value;
    const comment = document.getElementById('new-order-comment').value.trim();

    if (!projectId) {
        toast('Выбери объект', 'error');
        return false;
    }
    if (!sectionId) {
        toast('Выбери раздел сметы', 'error');
        return false;
    }
    if (!desiredDate) {
        toast('Укажи желаемую дату поставки', 'error');
        return false;
    }

    const rows = document.querySelectorAll('.order-item-row');
    const items = [];

    for (const row of rows) {
        const name = row.querySelector('.order-item-name')?.value.trim();
        const qty = parseFloat(row.querySelector('.order-item-qty')?.value);
        const unit = row.querySelector('.order-item-unit')?.value || 'шт';

        if (!name) {
            toast('Заполни наименование во всех позициях', 'error');
            return false;
        }
        if (!qty || qty <= 0) {
            toast('Кол-во должно быть больше нуля', 'error');
            return false;
        }

        items.push({ name, qty, unit });
    }

    if (items.length === 0) {
        toast('Добавь хотя бы одну позицию', 'error');
        return false;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан к сотруднику', 'error');
        return false;
    }

    const orderPayload = {
        project_id: projectId,
        section_id: sectionId,
        status: 'new',
        desired_date: desiredDate,
        purchase_data: comment ? { comment } : {},
        created_by_employee_id: emp.id,
        payment_source: 'company'
    };

    // Номер заявки берём как «максимум за год + 1» (см. db.getNextRequestNumber).
    // Если тот же номер успел занять другой пользователь — БД вернёт 23505,
    // и мы просто запрашиваем следующий номер (до 3 попыток).
    let requestNumber = null;
    let orderData = null;
    let orderError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const { requestNumber: nextNumber, error: numberError } = await db.getNextRequestNumber();

        if (numberError || !nextNumber) {
            log.error('Не удалось получить номер заявки:', numberError?.message || 'нет данных');
            toast('Не удалось получить номер заявки. Попробуйте ещё раз.', 'error');
            return false;
        }

        const { data, error } = await db.insert('orders', { ...orderPayload, request_number: nextNumber });

        if (!error) {
            requestNumber = nextNumber;
            orderData = data;
            orderError = null;
            break;
        }

        orderError = error;

        // 23505 — нарушение UNIQUE(request_number): номер уже занят, берём следующий
        if (error.code !== '23505') break;

        log.warn(`Номер ${nextNumber} уже занят, пробуем следующий (попытка ${attempt} из 3)`);
    }

    if (orderError) {
        log.error('Ошибка создания заявки:', orderError.message);
        toast('Не удалось создать заявку: ' + orderError.message, 'error');
        return false;
    }

    // База может не вернуть созданную строку — без проверки здесь был бы
    // TypeError, а кнопка молча оставалась бы «Сохраняем...».
    const orderId = orderData ? orderData.id : null;

    if (!orderId) {
        log.error('База не вернула созданную заявку (пустой ответ на INSERT)');
        toast('Заявка не сохранилась: база не вернула запись. Повторите попытку.', 'error');
        return false;
    }

    // Статус оплаты позициям НЕ выставляем: новая заявка ещё не оплачена.
    // Раньше здесь стояло payment_status: 'paid' — и карточка «Новой» заявки
    // показывала «✅ Оплачено», хотя закупку ещё не брали в работу и денег
    // никто не платил. Статус появляется позже: при доставке (closeOrder)
    // или когда финансист отметит счёт (js/modules/invoices.js).
    const itemsPayload = items.map(it => ({
        order_id: orderId,
        name: it.name,
        qty: it.qty,
        unit: it.unit
    }));

    const { error: itemsError } = await db.insertMany('order_items', itemsPayload);

    if (itemsError) {
        log.error('Ошибка создания позиций:', itemsError.message);
        toast('Заявка создана, но позиции не сохранились', 'warning');
    }

    log.info('✅ Заявка создана:', requestNumber);
    toast(`Заявка ${requestNumber} создана`, 'success');

    hideModal('new-order-modal');
    form.reset();

    await loadOrders();

    // Переключаем на список заявок только у тех, кому он виден: у прораба
    // вкладка «Снабжение» скрыта (право create_order есть, view_orders_tab —
    // нет), иначе сразу после сохранения он получал бы отказ в доступе.
    if (canSeeTab('orders')) switchTab('orders');
}

// =====================================================================
// ВЗЯТЬ В РАБОТУ
// =====================================================================

export async function takeOrderToWork(id) {
    if (!canProcessOrder()) {
        toast('Нет прав на обработку заявки', 'error');
        return;
    }

    const order = ordersCache.find(o => o.id === id);
    if (!order) {
        toast('Заявка не найдена', 'error');
        return;
    }

    if (order.status !== 'new') {
        toast('Заявка уже в работе или закрыта', 'warning');
        return;
    }

    const { error } = await db.update('orders', {
        status: 'in_progress'
    }, { id });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    toast(`Заявка ${order.request_number} взята в работу`, 'success');

    hideModal('order-detail-modal');
    await loadOrders();
}

// =====================================================================
// ФОРМА ЗАКРЫТИЯ
// =====================================================================

export async function openCloseOrderModal(id) {
    if (!canProcessOrder()) {
        toast('Нет прав на закрытие заявки', 'error');
        return;
    }

    const order = ordersCache.find(o => o.id === id);
    if (!order) {
        toast('Заявка не найдена', 'error');
        return;
    }

    if (order.status !== 'in_progress') {
        toast('Заявка должна быть в статусе «В работе»', 'warning');
        return;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан к сотруднику', 'error');
        return;
    }

    currentOrderId = id;
    hideModal('order-detail-modal');

    const titleEl = document.getElementById('close-order-title');
    if (titleEl) titleEl.textContent = `${t('order.deliveredTitle')} — ${order.request_number}`;

    document.getElementById('close-order-id').value = id;
    // Поставщика подставляем из счёта, если снабженец его уже загрузил
    document.getElementById('close-order-supplier').value = order.supplier || '';
    document.getElementById('close-order-notes').value = '';
    document.getElementById('close-order-payment-company').checked = true;

    const infoEl = document.getElementById('close-order-info');
    if (infoEl) {
        infoEl.innerHTML = `
            <div class="bg-emerald-50 p-3 rounded-lg border border-emerald-200 text-xs space-y-1">
                <p><strong>🏗 Объект:</strong> ${escapeHtml(order.project?.name || '—')}</p>
                <p><strong>📂 Раздел:</strong> ${escapeHtml(order.section?.name || '—')}</p>
                <p><strong>👤 Создал:</strong> ${escapeHtml(order.created_by_emp?.name || '—')}</p>
            </div>
        `;
    }

    const items = order._items || [];
    const itemsContainer = document.getElementById('close-order-items');
    if (!itemsContainer) return;

    if (items.length === 0) {
        itemsContainer.innerHTML = '<p class="text-center text-red-500 text-sm py-3">У заявки нет позиций</p>';
        return;
    }

    itemsContainer.innerHTML = items.map((it) => `
        <div class="close-order-item bg-gray-50 border rounded-lg p-3 space-y-2" 
             data-item-id="${it.id}"
             data-item-name="${escapeHtml(it.name)}"
             data-item-qty="${it.qty}"
             data-item-unit="${escapeHtml(it.unit || 'шт')}">
            <div class="flex justify-between items-start gap-2">
                <div class="flex-1">
                    <p class="font-semibold text-gray-800 text-xs">📦 ${escapeHtml(it.name)}</p>
                    <p class="text-[11px] text-gray-500">${it.qty} ${escapeHtml(it.unit || 'шт')}</p>
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2 items-center">
                <input type="number" step="0.01" placeholder="Цена за ед., грн" 
                       class="close-order-price w-full border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]"
                       value="${it.unit_price || ''}"
                       oninput="window.recalcCloseOrderTotal()"
                       required>
                <!-- Статус оплаты позиций рисует updateCloseOrderPaymentHints(): он
                     зависит от выбранного «кто платит» и пересчитывается на лету.
                     Раньше здесь стояли оба варианта текста («Ожидает оплаты /
                     Оплачено»), и в окне доставки читалось, будто позиции уже
                     оплачены, хотя счёт ещё никто не оплачивал. -->
                <span class="close-order-payment-state text-center"></span>
            </div>
        </div>
    `).join('');

    recalcCloseOrderTotal();
    updateCloseOrderPaymentHints();
    showModal('close-order-modal');
}

export function recalcCloseOrderTotal() {
    const rows = document.querySelectorAll('.close-order-item');
    let total = 0;

    rows.forEach(row => {
        const qty = parseFloat(row.dataset.itemQty) || 0;
        const price = parseFloat(row.querySelector('.close-order-price')?.value) || 0;
        total = roundMoney(total + qty * price);
    });

    const totalEl = document.getElementById('close-order-total');
    if (totalEl) totalEl.textContent = formatMoney(total);
}

/**
 * Показывает в окне доставки, что произойдёт с оплатой позиций при текущем
 * выборе «кто платит». Без этого в окне висел статичный текст со обоими
 * вариантами («Ожидает оплаты / Оплачено»), и снабженец читал его как
 * «уже оплачено».
 *
 * Вызывается при открытии окна и при смене радиокнопки
 * (onchange в index.html → window.updateCloseOrderPaymentHints()).
 */
export function updateCloseOrderPaymentHints() {
    const order = ordersCache.find(o => o.id === currentOrderId);
    const source = document.querySelector('input[name="close-order-payment-source"]:checked')?.value || 'company';

    // Фирма (безнал по счёту) → «Ожидает оплаты», пока финансист не отметит
    // счёт; подотчёт снабженца → деньги ушли сразу, «Оплачено».
    // Если счёт уже оплачен (paid_at), статус не откатываем.
    const state = (source === 'employee' || order?.paid_at) ? 'paid' : 'debt';

    const badge = state === 'debt'
        ? `<span class="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">${t('order.paymentPending')}</span>`
        : `<span class="text-[10px] font-bold bg-green-100 text-green-700 px-1.5 py-0.5 rounded">${t('order.paymentPaid')}</span>`;

    document.querySelectorAll('.close-order-payment-state').forEach((el) => {
        el.innerHTML = badge;
    });
}

export async function closeOrder(event) {
    event.preventDefault();

    if (!canProcessOrder()) {
        toast('Нет прав', 'error');
        return;
    }

    const orderId = parseInt(document.getElementById('close-order-id').value, 10);
    const supplier = document.getElementById('close-order-supplier').value.trim();
    const notes = document.getElementById('close-order-notes').value.trim();
    const paymentSource = document.querySelector('input[name="close-order-payment-source"]:checked')?.value || 'company';

    if (!supplier) {
        toast('Укажи поставщика', 'error');
        return;
    }

    const order = ordersCache.find(o => o.id === orderId);
    if (!order) {
        toast('Заявка не найдена', 'error');
        return;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const rows = document.querySelectorAll('.close-order-item');
    const updatedItems = [];
    let totalSum = 0;

    // Оплата фирмой — по счёту (безнал): до отметки финансиста позиции
    // «Ожидает оплаты». Признак оплаты — paid_at (его ставит финансист),
    // а не payment_status: у новой заявки статус может быть любым.
    // Если платит снабженец из подотчёта — позиции сразу «Оплачено».
    const companyUnpaid = paymentSource === 'company' && !order.paid_at;
    const itemPaymentStatus = companyUnpaid ? 'debt' : 'paid';

    for (const row of rows) {
        const itemId = parseInt(row.dataset.itemId, 10);
        const name = row.dataset.itemName;
        const qty = parseFloat(row.dataset.itemQty) || 0;
        const unit = row.dataset.itemUnit;
        const unitPrice = parseFloat(row.querySelector('.close-order-price')?.value) || 0;
        const paymentStatus = itemPaymentStatus;

        if (unitPrice <= 0) {
            toast(`Укажи цену для позиции «${name}»`, 'error');
            return;
        }

        const totalPrice = roundMoney(qty * unitPrice);
        totalSum = roundMoney(totalSum + totalPrice);

        updatedItems.push({
            id: itemId,
            name,
            qty,
            unit,
            unit_price: unitPrice,
            total_price: totalPrice,
            payment_status: paymentStatus
        });
    }

    if (updatedItems.length === 0) {
        toast('Нет позиций для закрытия', 'error');
        return;
    }

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняем...';

    // 1. Обновляем цены в позициях
    for (const item of updatedItems) {
        const { error } = await db.update('order_items', {
            unit_price: item.unit_price,
            total_price: item.total_price,
            payment_status: item.payment_status
        }, { id: item.id });

        if (error) {
            log.error('Ошибка обновления позиции:', error.message);
        }
    }

    // 2. Обновляем заявку
    const closeTimestamp = new Date().toISOString();

    const { error: orderError } = await db.update('orders', {
        status: 'delivered',          // материалы на объекте → позиции в «Реестр материалов»
        supplier: supplier,
        total_sum: totalSum,
        purchase_notes: notes || null,
        payment_source: paymentSource,
        payer_employee_id: paymentSource === 'employee' ? emp.id : null,
        payment_status: itemPaymentStatus,
        closed_at: closeTimestamp,
        delivered_at: closeTimestamp
    }, { id: orderId });

    if (orderError) {
        toast('Ошибка закрытия заявки: ' + db.explainError(orderError), 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Закрыть заявку';
        return;
    }

    // 3. Если оплата из подотчёта — создаём cash_operation
    if (paymentSource === 'employee') {
        const { error: cashError } = await db.insert('cash_operations', {
            employee_id: emp.id,
            operation_type: 'expense',
            amount: totalSum,
            category: 'materials',
            project_id: order.project_id,
            section_id: order.section_id,
            order_id: orderId,
            items: updatedItems.map(it => ({
                name: it.name,
                qty: it.qty,
                unit: it.unit,
                price: it.unit_price,
                sum: it.total_price
            })),
            source: 'order',
            description: `Заявка ${order.request_number} (${supplier})`,
            operation_date: new Date().toISOString().split('T')[0]
        });

        if (cashError) {
            log.error('Ошибка создания cash_operation:', cashError.message);
            toast('Заявка закрыта, но расход не записан', 'warning');
        } else {
            log.info('✅ Cash operation создана для заявки', order.request_number);
        }
    }

    log.info('✅ Заявка доставлена на объект:', order.request_number);
    toast(`${t('order.deliveredToast', { number: order.request_number })} · ${formatMoney(totalSum)}`, 'success');

    hideModal('close-order-modal');
    await loadOrders();

    if (paymentSource === 'employee') {
        if (window.renderProfileBalance) {
            await window.renderProfileBalance();
        }
    }

    // Кнопку возвращаем в исходный вид: без этого после закрытия заявки она
    // оставалась «Сохраняем...» и выключенной — вторую заявку закрыть нельзя.
    submitBtn.disabled = false;
    submitBtn.textContent = '💾 Закрыть заявку';
}

// =====================================================================
// СЧЁТ ПОСТАВЩИКА (снабженец)
// =====================================================================
// Снабженец связывается с поставщиком, получает счёт, загружает файл (фото,
// скрин, PDF) и заполняет цены по позициям. С этого момента:
//   * счёт виден финансисту в блоке «🧾 Счета на материалы»
//     (js/modules/invoices.js) — деньги фирмы, безнал;
//   * материалы могут ехать на объект раньше оплаты: главное правило
//     «материалы приезжают раньше, чем их оплатят».
// Заявка при загрузке счёта остаётся «В обработке» и получает
// payment_status = 'debt' («Ожидает оплаты»).

/** Короткое безопасное имя файла для Storage: кириллица → «_», расширение сохраняем. */
function invoiceFileName(originalName) {
    const lastDot = originalName.lastIndexOf('.');
    const ext = lastDot > 0 ? originalName.slice(lastDot).toLowerCase().slice(0, 10) : '';
    const base = (lastDot > 0 ? originalName.slice(0, lastDot) : originalName)
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 60);

    return (base || 'invoice') + ext;
}

/** Открывает окно загрузки счёта по заявке. */
export async function openOrderInvoiceModal(orderId) {
    if (!canProcessOrder()) {
        toast('Нет прав', 'error');
        return;
    }

    const order = ordersCache.find(o => o.id === orderId);
    if (!order) {
        toast('Заявка не найдена', 'error');
        return;
    }

    const titleEl = document.getElementById('order-invoice-title');
    if (titleEl) titleEl.textContent = `${t('order.invoiceTitle')} ${order.request_number}`;

    document.getElementById('order-invoice-id').value = String(orderId);
    document.getElementById('order-invoice-supplier').value = order.supplier || '';

    const fileInput = document.getElementById('order-invoice-file');
    if (fileInput) fileInput.value = '';

    const currentEl = document.getElementById('order-invoice-current');
    if (currentEl) {
        currentEl.innerHTML = order.invoice_path
            ? `${t('order.invoiceFileCurrent')}: <b>${escapeHtml(order.invoice_file_name || '—')}</b>
               <button type="button" onclick="window.viewOrderInvoice(${orderId})"
                       class="text-[#15803d] font-semibold hover:underline ml-1">${t('common.open')}</button>`
            : '';
    }

    const items = order._items || [];
    const container = document.getElementById('order-invoice-items');
    if (container) {
        container.innerHTML = items.length === 0
            ? '<p class="text-xs text-gray-500">У заявки нет позиций</p>'
            : items.map(it => `
                <div class="order-invoice-item flex items-center gap-2 bg-gray-50 border rounded-lg p-2"
                     data-item-id="${it.id}"
                     data-item-name="${escapeHtml(it.name)}"
                     data-item-qty="${it.qty}">
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-semibold text-gray-800 truncate">📦 ${escapeHtml(it.name)}</p>
                        <p class="text-[11px] text-gray-500">${it.qty} ${escapeHtml(it.unit || 'шт')}</p>
                    </div>
                    <input type="number" step="0.01" min="0" placeholder="Цена, грн"
                           value="${it.unit_price || ''}"
                           class="order-invoice-price w-24 border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]"
                           oninput="window.recalcOrderInvoiceTotal()">
                </div>
            `).join('');
    }

    recalcOrderInvoiceTotal();
    showModal('order-invoice-modal');
}

/** Итого по счёту = сумма (кол-во × цена) по всем позициям. */
export function recalcOrderInvoiceTotal() {
    const rows = document.querySelectorAll('.order-invoice-item');
    let total = 0;

    rows.forEach(row => {
        const qty = parseFloat(row.dataset.itemQty) || 0;
        const price = parseFloat(row.querySelector('.order-invoice-price')?.value) || 0;
        total = roundMoney(total + qty * price);
    });

    const totalEl = document.getElementById('order-invoice-total');
    if (totalEl) totalEl.textContent = formatMoney(total);
}

/** Сохраняет счёт: файл в Storage + цены позиций + сумма заявки. */
export async function saveOrderInvoice(event) {
    event.preventDefault();

    if (!canProcessOrder()) {
        toast('Нет прав', 'error');
        return;
    }

    const orderId = parseInt(document.getElementById('order-invoice-id').value, 10);
    const order = ordersCache.find(o => o.id === orderId);
    if (!order) {
        toast('Заявка не найдена', 'error');
        return;
    }

    const supplier = document.getElementById('order-invoice-supplier').value.trim();
    if (!supplier) {
        toast(t('order.invoiceNeedSupplier'), 'error');
        return;
    }

    const rows = document.querySelectorAll('.order-invoice-item');
    const prices = [];

    for (const row of rows) {
        const name = row.dataset.itemName;
        const qty = parseFloat(row.dataset.itemQty) || 0;
        const unitPrice = parseFloat(row.querySelector('.order-invoice-price')?.value) || 0;

        if (!unitPrice || unitPrice <= 0) {
            toast(t('order.invoiceNeedPrices', { name }), 'error');
            return;
        }

        prices.push({
            id: parseInt(row.dataset.itemId, 10),
            unitPrice,
            totalPrice: roundMoney(qty * unitPrice)
        });
    }

    if (prices.length === 0) {
        toast('У заявки нет позиций', 'error');
        return;
    }

    const file = document.getElementById('order-invoice-file')?.files?.[0] || null;
    const submitBtn = event.target.querySelector('button[type="submit"]');
    const initialLabel = submitBtn.textContent;

    submitBtn.disabled = true;
    submitBtn.textContent = t('common.loading');

    try {
        let invoicePath = order.invoice_path || null;
        let invoiceFileNameSaved = order.invoice_file_name || null;

        if (file) {
            const path = `invoices/${orderId}-${Date.now()}-${invoiceFileName(file.name)}`;
            const { path: uploaded, error: uploadError } = await db.uploadFile(
                CONFIG.STORAGE.INVOICES_BUCKET, path, file
            );

            if (uploadError || !uploaded) {
                log.error('Ошибка загрузки файла счёта:', uploadError?.message || 'нет пути');
                toast(`${t('order.invoiceUploadFailed')}: ${uploadError?.message || ''}`, 'error');
                return;
            }

            invoicePath = uploaded;
            invoiceFileNameSaved = file.name;
        }

        // Цены по позициям — из них собирается «📊 Реестр материалов»
        for (const item of prices) {
            const { error } = await db.update('order_items', {
                unit_price: item.unitPrice,
                total_price: item.totalPrice
            }, { id: item.id });

            if (error) log.error('Ошибка обновления цены позиции:', error.message);
        }

        const totalSum = roundMoney(prices.reduce((sum, item) => sum + item.totalPrice, 0));

        const payload = {
            supplier,
            total_sum: totalSum,
            invoice_total: totalSum,
            invoice_path: invoicePath,
            invoice_file_name: invoiceFileNameSaved,
            invoice_uploaded_at: new Date().toISOString()
        };

        // Счёт загружен → заявка ждёт оплаты. Исключение — счёт уже оплачен
        // финансистом (есть paid_at): тогда статус не откатываем назад.
        if (!order.paid_at) payload.payment_status = 'debt';

        const { error } = await db.update('orders', payload, { id: orderId });

        if (error) {
            toast('Не удалось сохранить счёт: ' + db.explainError(error), 'error');
            return;
        }

        log.info('🧾 Счёт сохранён по заявке', order.request_number, `на ${formatMoney(totalSum)}`);
        toast(t('order.invoiceSaved', { number: order.request_number }), 'success');

        hideModal('order-invoice-modal');
        await loadOrders();
        await openOrderDetail(orderId);   // карточка сразу покажет счёт и статус оплаты

    } catch (err) {
        log.error('Исключение при сохранении счёта:', err);
        toast('Не удалось сохранить счёт: ' + db.explainError(err), 'error');

    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = initialLabel;
    }
}

/** Открывает файл счёта по заявке (подписанная ссылка). */
export async function viewOrderInvoice(orderId) {
    const order = ordersCache.find(o => o.id === orderId);
    if (!order || !order.invoice_path) {
        toast('Файл счёта не загружен', 'warning');
        return;
    }

    const { url, error } = await db.getFileUrl(CONFIG.STORAGE.INVOICES_BUCKET, order.invoice_path);

    if (error || !url) {
        toast('Не удалось получить ссылку на счёт', 'error');
        return;
    }

    window.open(url, '_blank');
}

// =====================================================================
// АРХИВ
// =====================================================================

export async function archiveOrder(id) {
    if (!canProcessOrder()) {
        toast('Нет прав', 'error');
        return;
    }

    const order = ordersCache.find(o => o.id === id);
    if (!order) return;

    if (order.status !== 'delivered' && order.status !== 'closed') {
        toast('В архив можно отправить только доставленные заявки', 'warning');
        return;
    }

    if (!confirm(`Отправить заявку ${order.request_number} в архив?`)) return;

    const { error } = await db.update('orders', {
        status: 'archived'
    }, { id });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    toast('Заявка в архиве', 'success');
    hideModal('order-detail-modal');
    await loadOrders();
}

// =====================================================================
// УДАЛЕНИЕ
// =====================================================================

export async function deleteOrder(id) {
    if (!isAdmin()) {
        toast('Только Администратор может удалять заявки', 'error');
        return;
    }

    const order = ordersCache.find(o => o.id === id);
    if (!order) return;

    if (order.status !== 'new') {
        toast('Можно удалять только новые заявки', 'warning');
        return;
    }

    if (!confirm(`УДАЛИТЬ заявку ${order.request_number}?\n\nЭто действие нельзя отменить.`)) return;

    await db.remove('order_items', { order_id: id });

    const { error } = await db.remove('orders', { id });

    if (error) {
        toast('Ошибка удаления: ' + error.message, 'error');
        return;
    }

    toast('Заявка удалена', 'success');
    hideModal('order-detail-modal');
    await loadOrders();
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ (для onclick)
// =====================================================================

window.openOrderDetail = openOrderDetail;
window.switchOrdersTab = switchOrdersTab;
window.openNewOrderForm = openNewOrderForm;
window.loadSectionsForOrder = loadSectionsForOrder;
window.addOrderItemRow = addOrderItemRow;
window.removeOrderItemRow = removeOrderItemRow;
window.recalcOrderTotal = recalcOrderTotal;
window.takeOrderToWork = takeOrderToWork;
window.openOrderInvoiceModal = openOrderInvoiceModal;
window.recalcOrderInvoiceTotal = recalcOrderInvoiceTotal;
window.saveOrderInvoice = saveOrderInvoice;
window.viewOrderInvoice = viewOrderInvoice;
window.openCloseOrderModal = openCloseOrderModal;
window.recalcCloseOrderTotal = recalcCloseOrderTotal;
window.updateCloseOrderPaymentHints = updateCloseOrderPaymentHints;
window.archiveOrder = archiveOrder;
window.deleteOrder = deleteOrder;