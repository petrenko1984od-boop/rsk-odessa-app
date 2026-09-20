// =====================================================================
// МОДУЛЬ: СЧЕТА НА МАТЕРИАЛЫ (очередь оплаты финансиста)
// =====================================================================
// Как сюда попадают счета: снабженец взял заявку в работу, получил счёт у
// поставщика и загрузил его (js/modules/orders.js → «🧾 Счёт от поставщика»).
// Дальше счёт живёт отдельной очередью: материалы могут приехать на объект
// раньше оплаты, поэтому заявка закрывается статусом «Доставлено на объект»
// и уходит в «📊 Реестр материалов» со статусом «Ожидает оплаты».
//
// ⚠️ Оплата счёта НЕ списывает деньги с подотчёта финансиста: это безнал
//    фирмы. Отметка «Оплачено» закрывает задолженность перед поставщиком и
//    меняет статус в реестре, но никаких cash_operations не создаёт.
//
// Право на оплату — pay_material_invoice (Финансист, Директор).
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, formatMoney, formatDate
} from '../utils.js';
import { can, getEmployee } from '../permissions.js';
import { CONFIG } from '../config.js';
import { t } from '../i18n.js';

let invoiceCache = [];

/** Может ли текущий пользователь отмечать счета оплаченными. */
export function canPayInvoices() {
    return can('pay_material_invoice');
}

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

/**
 * Счета, ожидающие оплаты: заявки фирмы со статусом оплаты 'debt'.
 * Счёт без файла тоже показываем — снабженец мог его не приложить, но
 * оплачивать всё равно нужно.
 */
async function loadOpenInvoices() {
    const { data, error } = await db.select('orders', {
        select: `
            id, request_number, status, supplier, total_sum, invoice_total,
            invoice_path, invoice_file_name, invoice_uploaded_at,
            payment_status, delivered_at, closed_at, desired_date, created_at,
            project:projects ( id, name ),
            section:sections ( id, name )
        `,
        filters: {
            payment_source: 'company',
            payment_status: 'debt'
        },
        orderBy: { column: 'created_at', asc: false }
    });

    if (error) {
        log.error('Ошибка загрузки счетов на материалы:', error.message);
        return { invoices: [], error };
    }

    return { invoices: data || [], error: null };
}

// =====================================================================
// ОТРИСОВКА ПАНЕЛИ
// =====================================================================

function renderInvoiceCard(order) {
    const sum = Number(order.invoice_total) || Number(order.total_sum) || 0;
    const delivered = order.status === 'delivered'
        || order.status === 'closed'
        || order.status === 'archived';

    const statusBadge = delivered
        ? `<span class="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-bold">🚚 ${t('invoice.delivered')}</span>`
        : `<span class="text-[10px] bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded font-bold">📦 ${t('invoice.notDelivered')}</span>`;

    const fileBlock = order.invoice_path
        ? `<button onclick="window.viewMaterialInvoice(${order.id})"
                   class="text-[11px] font-semibold text-[#15803d] hover:underline">${t('invoice.openFile')}</button>`
        : `<span class="text-[11px] text-amber-700">⚠ ${t('invoice.noFile')}</span>`;

    return `
        <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2">
            <div class="flex flex-wrap justify-between items-start gap-2">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-bold text-[#15803d] font-mono text-sm bg-white px-2 py-0.5 rounded border border-emerald-200">${escapeHtml(order.request_number)}</span>
                    ${statusBadge}
                    ${order.invoice_uploaded_at ? `<span class="text-[10px] text-gray-500">🧾 ${formatDate(order.invoice_uploaded_at)}</span>` : ''}
                </div>
                <span class="text-sm font-bold text-[#166534] whitespace-nowrap">${formatMoney(sum)}</span>
            </div>

            <div class="text-xs text-gray-700 space-y-0.5">
                <p><strong>🏗 ${t('common.object')}:</strong> ${escapeHtml(order.project?.name || '—')}
                   · <strong>${t('common.section')}:</strong> ${escapeHtml(order.section?.name || '—')}</p>
                ${order.supplier ? `<p><strong>🏬 ${escapeHtml(order.supplier)}</strong></p>` : ''}
            </div>

            <div class="flex flex-wrap justify-between items-center gap-2 pt-1 border-t border-amber-200">
                ${fileBlock}
                <div class="flex gap-2">
                    ${canPayInvoices() ? `
                        <button onclick="window.markMaterialInvoicePaid(${order.id})"
                                class="bg-[#15803d] hover:bg-[#166534] text-white px-3 py-1.5 rounded-lg text-xs font-semibold shadow transition">${t('invoice.pay')}</button>
                    ` : ''}
                </div>
            </div>
        </div>
    `;
}

/**
 * Рисует панель «Счета на материалы» на рабочем столе. Вызывается при
 * открытии раздела заявок (js/modules/cash-requests.js → loadCashRequests).
 */
export async function renderMaterialInvoices() {
    const panel = document.getElementById('material-invoices-panel');
    if (!panel) return;

    if (!canPayInvoices()) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
    }

    panel.classList.remove('hidden');
    panel.innerHTML = `
        <div class="bg-white rounded-xl shadow-sm border border-amber-200 p-4 space-y-2">
            <h3 class="text-sm font-bold text-gray-800">${t('invoice.panelTitle')}</h3>
            <p class="text-xs text-gray-500">${t('common.loading')}</p>
        </div>
    `;

    const { invoices, error } = await loadOpenInvoices();
    invoiceCache = invoices;

    const totalToPay = invoices.reduce(
        (sum, row) => sum + (Number(row.invoice_total) || Number(row.total_sum) || 0), 0
    );

    const head = `
        <div class="flex flex-wrap justify-between items-center gap-2">
            <div>
                <h3 class="text-sm font-bold text-gray-800">${t('invoice.panelTitle')}</h3>
                <p class="text-xs text-gray-500">${t('invoice.panelSubtitle')}</p>
            </div>
            <span class="text-xs font-semibold bg-amber-100 text-amber-800 px-3 py-1.5 rounded-lg">
                ${t('common.total')}: ${formatMoney(totalToPay)}
            </span>
        </div>
    `;

    if (error) {
        panel.innerHTML = `<div class="bg-white rounded-xl shadow-sm border border-red-200 p-4 space-y-2">
            ${head}<p class="text-xs text-red-600">Не удалось загрузить счета: ${escapeHtml(error.message)}</p></div>`;
        return;
    }

    if (invoices.length === 0) {
        panel.innerHTML = `<div class="bg-white rounded-xl shadow-sm border border-dashed border-gray-300 p-4 space-y-2">
            ${head}<p class="text-xs text-gray-500">${t('invoice.empty')}</p></div>`;
        return;
    }

    panel.innerHTML = `
        <div class="bg-white rounded-xl shadow-sm border border-amber-200 p-4 space-y-3">
            ${head}
            ${invoices.map(renderInvoiceCard).join('')}
        </div>
    `;
}

// =====================================================================
// ДЕЙСТВИЯ
// =====================================================================

/** Открывает файл счёта (подписанная ссылка — файлы приватные). */
export async function viewMaterialInvoice(orderId) {
    const order = invoiceCache.find(row => row.id === orderId);
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

/** Отметка «Оплачено»: закрывает долг перед поставщиком (деньги фирмы, безнал). */
export async function markMaterialInvoicePaid(orderId) {
    if (!canPayInvoices()) {
        toast(t('invoice.noPermission'), 'error');
        return;
    }

    const order = invoiceCache.find(row => row.id === orderId);
    if (!order) return;

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан к сотруднику', 'error');
        return;
    }

    if (!confirm(t('invoice.confirm', { number: order.request_number }))) return;

    const { error } = await db.update('orders', {
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
        paid_by_employee_id: emp.id
    }, { id: orderId });

    if (error) {
        toast('Не удалось отметить оплату: ' + error.message, 'error');
        return;
    }

    // Позиции заявки — тоже «Оплачено»: их показывает «📊 Реестр материалов»
    const { error: itemsError } = await db.update('order_items', {
        payment_status: 'paid'
    }, { order_id: orderId });

    if (itemsError) {
        log.warn('Счёт оплачен, но позиции заявки не обновлены:', itemsError.message);
    }

    log.info('✅ Счёт отмечен оплаченным:', order.request_number);
    toast(t('invoice.paidToast', { number: order.request_number }), 'success');

    await renderMaterialInvoices();

    // Реестр показывает статус оплаты — обновляем, если он открыт
    if (window.AppState?.currentTab === 'registry' && typeof window.loadRegistry === 'function') {
        await window.loadRegistry();
    }
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.viewMaterialInvoice = viewMaterialInvoice;
window.markMaterialInvoicePaid = markMaterialInvoicePaid;
window.renderMaterialInvoices = renderMaterialInvoices;
