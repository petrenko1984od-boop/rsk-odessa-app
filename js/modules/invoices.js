// =====================================================================
// МОДУЛЬ: СЧЕТА НА МАТЕРИАЛЫ (блок оплаты счетов на рабочем столе)
// =====================================================================
// Как сюда попадают счета: снабженец взял заявку в работу, получил счёт у
// поставщика и загрузил его (js/modules/orders.js → «🧾 Счёт от поставщика»).
// Дальше счёт живёт отдельной очередью: материалы могут приехать на объект
// раньше оплаты, поэтому заявка закрывается статусом «Доставлено на объект»
// и уходит в «📊 Реестр материалов» со статусом «Ожидает оплаты».
//
// Блок один, а списков в нём два — как меню над списком:
//   ⏳ «Ожидают оплату» (payment_status = 'debt') — что нужно заплатить;
//   ✅ «Оплаченные»     (payment_status = 'paid') — история: кто и когда
//      заплатил. Её и выгружают в Excel для сверки с банком.
// У истории есть фильтр периода («Этот месяц» / «Прошлый месяц»), а у
// «Ожидают оплату» его нет: долг нельзя спрятать фильтром — счёт должен быть
// виден, пока он не оплачен. Выгрузка в Excel всегда повторяет то, что видно
// на экране (активное меню + период).
//
// ⚠️ Оплата счёта НЕ списывает деньги с подотчёта финансиста: это безнал
//    фирмы. Отметка «Оплачено» закрывает задолженность перед поставщиком и
//    меняет статус в реестре, но никаких cash_operations не создаёт.
//
// Право на оплату — pay_material_invoice (Финансист, Директор).
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, formatMoney, formatDate, todayISO
} from '../utils.js';
import { can, getEmployee } from '../permissions.js';
import { CONFIG } from '../config.js';
import { t } from '../i18n.js';

// Очередь «⏳ Ожидают оплату» (payment_status = 'debt')
let invoiceCache = [];
// История «✅ Оплаченные» (payment_status = 'paid')
let paidInvoiceCache = [];
// Ошибка основной очереди: вместо пустого списка показываем её текст
let invoiceError = null;

// Активное меню блока: 'open' — ⏳ Ожидают оплату, 'paid' — ✅ Оплаченные.
// Выбор живёт в модуле (а не в DOM): панель перерисовывается целиком и после
// оплаты счёта, и при смене фильтра.
let invoiceView = 'open';

// Фильтр периода истории оплат: 'all' | 'month' | 'prev'
let invoicePeriod = 'all';

// Сколько последних оплат держим в истории. Как в авансовом отчёте
// (js/modules/cash.js → MY_OPERATIONS_LIMIT): фильтр периода и выгрузка
// работают по этому окну, поэтому 50 строк для сверки с банком мало.
const PAID_INVOICES_LIMIT = 500;

/** Может ли текущий пользователь отмечать счета оплаченными. */
export function canPayInvoices() {
    return can('pay_material_invoice');
}

/** Сумма счёта: по счёту, иначе — по заявке (файл могли не приложить). */
function invoiceSum(order) {
    return Number(order.invoice_total) || Number(order.total_sum) || 0;
}

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

// Колонки обоих списков одинаковые: очередь и история берут одни и те же поля,
// поэтому карточка и выгрузка показывают счёт одинаково. Связь с тем, кто
// оплатил, читаем по имени внешнего ключа — как в js/modules/orders.js для
// payer_employee_id.
const INVOICE_COLUMNS = `
    id, request_number, status, supplier, total_sum, invoice_total,
    invoice_path, invoice_file_name, invoice_uploaded_at,
    payment_status, delivered_at, closed_at, desired_date, created_at,
    paid_at, paid_by_employee_id,
    project:projects ( id, name ),
    section:sections ( id, name ),
    paid_by:employees!orders_paid_by_employee_id_fkey ( id, name )
`;

/**
 * Счета, ожидающие оплаты: заявки фирмы со статусом оплаты 'debt'.
 * Счёт без файла тоже показываем — снабженец мог его не приложить, но
 * оплачивать всё равно нужно.
 */
async function loadOpenInvoices() {
    const { data, error } = await db.select('orders', {
        select: INVOICE_COLUMNS,
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

/**
 * История оплат: счета фирмы со статусом 'paid'. Свежие — сверху, поэтому
 * лимит отсекает старое, а не нужное.
 *
 * Строки без счёта не показываем: миграция v2.4.0 перевела в 'paid' ВСЕ
 * старые заявки, у которых счёта не было вовсе, — в истории оплат им не
 * место (иначе список заполнили бы заявки без суммы по счёту и без даты
 * оплаты).
 */
async function loadPaidInvoices() {
    const { data, error } = await db.select('orders', {
        select: INVOICE_COLUMNS,
        filters: {
            payment_source: 'company',
            payment_status: 'paid'
        },
        orderBy: { column: 'paid_at', asc: false },
        limit: PAID_INVOICES_LIMIT
    });

    if (error) {
        log.error('Ошибка загрузки оплаченных счетов:', error.message);
        return { invoices: [], error };
    }

    const invoices = (data || []).filter(
        row => row.invoice_uploaded_at || row.invoice_path || row.invoice_total
    );

    return { invoices, error: null };
}

// =====================================================================
// МЕНЮ БЛОКА И ФИЛЬТР ПЕРИОДА
// =====================================================================

/**
 * Границы выбранного периода (или null для «всё время»).
 * «Этот месяц» — с 1-го числа текущего месяца; «Прошлый месяц» — с 1-го по
 * последнее число предыдущего.
 */
function periodRange() {
    if (invoicePeriod === 'all') return null;

    const now = new Date();
    const shift = invoicePeriod === 'prev' ? -1 : 0;

    return {
        from: new Date(now.getFullYear(), now.getMonth() + shift, 1),
        to: new Date(now.getFullYear(), now.getMonth() + shift + 1, 1)
    };
}

/**
 * История оплат с учётом фильтра периода — по дате оплаты. Если paid_at не
 * заполнен (старая отметка оплаты), берём дату счёта: строка не должна
 * пропадать из истории из-за одного фильтра.
 */
function filterPaidByPeriod(rows) {
    const range = periodRange();
    if (!range) return rows;

    return rows.filter(row => {
        const stamp = new Date(
            row.paid_at || row.invoice_uploaded_at || row.created_at || 0
        ).getTime();

        return stamp >= range.from.getTime() && stamp < range.to.getTime();
    });
}

/**
 * Что видно на экране: активное меню блока и, у истории оплат, фильтр периода.
 * По этому же списку работает выгрузка в Excel — «скачать по фильтру» значит
 * «выгрузить ровно то, что видно».
 */
export function getVisibleInvoices() {
    if (invoiceView === 'paid') return filterPaidByPeriod(paidInvoiceCache);
    return invoiceCache;
}

/**
 * Меню блока: «⏳ Ожидают оплату» ↔ «✅ Оплаченные».
 * Базу не перечитываем: оба списка уже в кэше, а после оплаты счёта панель
 * перерисовывает сама markMaterialInvoicePaid().
 */
export function setInvoiceView(view) {
    invoiceView = view === 'paid' ? 'paid' : 'open';
    paintMaterialInvoices();
}

/** Фильтр периода истории оплат: 'all' (всё время) | 'month' | 'prev'. */
export function setInvoicePeriod(period) {
    invoicePeriod = ['month', 'prev'].includes(period) ? period : 'all';
    paintMaterialInvoices();
}

// =====================================================================
// ОТРИСОВКА ПАНЕЛИ
// =====================================================================

/** Кнопка меню с количеством: активная — зелёная, остальные — серые. */
function renderInvoiceTab(view, label, count) {
    const active = invoiceView === view;
    const cls = active
        ? 'bg-[#15803d] text-white'
        : 'bg-gray-100 text-gray-600 hover:bg-gray-200';

    return `<button type="button" onclick="window.setInvoiceView('${view}')" id="invoice-view-${view}"
                    class="px-3 py-1.5 rounded-lg text-xs font-semibold transition ${cls}">${label} (${count})</button>`;
}

/** Пункт фильтра периода: выбран тот, что действует сейчас. */
function periodOption(value, label) {
    const selected = invoicePeriod === value ? ' selected' : '';
    return `<option value="${value}"${selected}>${label}</option>`;
}

/** Заголовок блока: итог по активному списку, фильтр периода и выгрузка в Excel. */
function renderInvoiceHead() {
    const paidVisible = filterPaidByPeriod(paidInvoiceCache);
    const visible = invoiceView === 'paid' ? paidVisible : invoiceCache;
    const total = visible.reduce((sum, row) => sum + invoiceSum(row), 0);

    // Фильтр периода — только у истории оплат: в очереди долг обязан быть
    // виден целиком, фильтр по дате там был бы ловушкой.
    const periodSelect = invoiceView === 'paid' ? `
                <select id="invoice-period-filter" onchange="window.setInvoicePeriod(this.value)"
                        title="${t('invoice.periodHint')}"
                        class="text-xs rounded-lg border border-gray-300 bg-white px-2 py-1.5 font-semibold text-gray-700">
                    ${periodOption('all', t('invoice.periodAll'))}
                    ${periodOption('month', t('invoice.periodMonth'))}
                    ${periodOption('prev', t('invoice.periodPrev'))}
                </select>
    ` : '';

    return `
        <div class="flex flex-wrap justify-between items-start gap-2">
            <div>
                <h3 class="text-sm font-bold text-gray-800">${t('invoice.panelTitle')}</h3>
                <p class="text-xs text-gray-500">${t('invoice.panelSubtitle')}</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <span class="text-xs font-semibold bg-amber-100 text-amber-800 px-3 py-1.5 rounded-lg">
                    ${t('common.total')}: ${formatMoney(total)}
                </span>
                ${periodSelect}
                <button type="button" onclick="window.exportMaterialInvoicesToExcel()" id="invoice-export-btn"
                        title="${t('invoice.exportHint')}"
                        class="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-3 py-1.5 rounded-lg text-xs transition shadow">${t('invoice.export')}</button>
            </div>
        </div>

        <div class="flex flex-wrap gap-2 pt-1" id="invoice-tabs">
            ${renderInvoiceTab('open', t('invoice.tabOpen'), invoiceCache.length)}
            ${renderInvoiceTab('paid', t('invoice.tabPaid'), paidVisible.length)}
        </div>
    `;
}

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
 * Карточка оплаченного счёта (история «✅ Оплаченные»): когда и кто заплатил.
 * Кнопки «Оплачено» здесь нет — счёт уже оплачен, а отменить это в приложении
 * нельзя (см. инструкцию для финансиста).
 */
function renderPaidInvoiceCard(order) {
    const fileBlock = order.invoice_path
        ? `<button onclick="window.viewMaterialInvoice(${order.id})"
                   class="text-[11px] font-semibold text-[#15803d] hover:underline">${t('invoice.openFile')}</button>`
        : `<span class="text-[11px] text-gray-400">${t('invoice.noFile')}</span>`;

    const payer = order.paid_by?.name;

    return `
        <div class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-2">
            <div class="flex flex-wrap justify-between items-start gap-2">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-bold text-[#15803d] font-mono text-sm bg-white px-2 py-0.5 rounded border border-emerald-200">${escapeHtml(order.request_number)}</span>
                    <span class="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-bold">✅ ${t('invoice.paidAt')}</span>
                    <span class="text-[10px] text-gray-500">📅 ${formatDate(order.paid_at || order.invoice_uploaded_at)}</span>
                    ${payer ? `<span class="text-[10px] text-gray-500">👤 ${t('invoice.paidBy')}: ${escapeHtml(payer)}</span>` : ''}
                </div>
                <span class="text-sm font-bold text-[#166534] whitespace-nowrap">${formatMoney(invoiceSum(order))}</span>
            </div>

            <div class="text-xs text-gray-700 space-y-0.5">
                <p><strong>🏗 ${t('common.object')}:</strong> ${escapeHtml(order.project?.name || '—')}
                   · <strong>${t('common.section')}:</strong> ${escapeHtml(order.section?.name || '—')}</p>
                ${order.supplier ? `<p><strong>🏬 ${escapeHtml(order.supplier)}</strong></p>` : ''}
            </div>

            <div class="flex flex-wrap justify-between items-center gap-2 pt-1 border-t border-emerald-200">
                ${fileBlock}
                ${order.invoice_uploaded_at ? `<span class="text-[10px] text-gray-500">${t('invoice.of')} 🧾 ${formatDate(order.invoice_uploaded_at)}</span>` : ''}
            </div>
        </div>
    `;
}

/**
 * Перерисовка блока из кэша (без запросов в базу): меню, фильтр периода и
 * список. Вызывается после загрузки и при переключении меню/фильтра.
 */
function paintMaterialInvoices() {
    const panel = document.getElementById('material-invoices-panel');
    if (!panel) return;

    if (!canPayInvoices()) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
    }

    panel.classList.remove('hidden');

    const head = renderInvoiceHead();

    if (invoiceError) {
        panel.innerHTML = `<div class="bg-white rounded-xl shadow-sm border border-red-200 p-4 space-y-2">
            ${head}<p class="text-xs text-red-600">Не удалось загрузить счета: ${escapeHtml(db.explainError(invoiceError))}</p></div>`;
        return;
    }

    const visible = getVisibleInvoices();

    // Пустой список подписываем по-разному: он пуст из-за фильтра периода или
    // потому, что платить/сверять действительно нечего.
    const emptyText = invoiceView === 'paid'
        ? (invoicePeriod === 'all' ? t('invoice.emptyPaid') : t('invoice.emptyPaidPeriod'))
        : t('invoice.empty');

    const card = order => (invoiceView === 'paid'
        ? renderPaidInvoiceCard(order)
        : renderInvoiceCard(order));

    // Пустая очередь — пунктирная рамка, как было раньше; счета к оплате —
    // янтарная, история оплат — зелёная.
    const boxBorder = visible.length === 0
        ? 'border-dashed border-gray-300'
        : (invoiceView === 'paid' ? 'border-emerald-200' : 'border-amber-200');

    panel.innerHTML = `
        <div class="bg-white rounded-xl shadow-sm border ${boxBorder} p-4 space-y-3">
            ${head}
            ${visible.length === 0
                ? `<p class="text-xs text-gray-500">${emptyText}</p>`
                : visible.map(card).join('')}
        </div>
    `;
}

/**
 * Рисует блок «🧾 Счета на материалы»: читает из базы оба списка (очередь
 * оплаты и историю оплат) и перерисовывает панель. Вызывается при открытии
 * раздела заявок (js/modules/cash-requests.js → loadCashRequests) и после
 * отметки «Оплачено».
 */
export async function renderMaterialInvoices() {
    const panel = document.getElementById('material-invoices-panel');
    if (!panel) return;

    if (!canPayInvoices()) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
    }

    // Первый вход в раздел: пока идут запросы, показываем, что блок на месте.
    // При перерисовке (после оплаты) старый список не мигает «Загрузкой».
    if (invoiceCache.length === 0 && paidInvoiceCache.length === 0) {
        panel.classList.remove('hidden');
        panel.innerHTML = `
            <div class="bg-white rounded-xl shadow-sm border border-amber-200 p-4 space-y-2">
                <h3 class="text-sm font-bold text-gray-800">${t('invoice.panelTitle')}</h3>
                <p class="text-xs text-gray-500">${t('common.loading')}</p>
            </div>
        `;
    }

    const [open, paid] = await Promise.all([loadOpenInvoices(), loadPaidInvoices()]);

    invoiceCache = open.invoices;
    invoiceError = open.error;
    paidInvoiceCache = paid.invoices;

    paintMaterialInvoices();
}

// =====================================================================
// ДЕЙСТВИЯ
// =====================================================================

/** Открывает файл счёта (подписанная ссылка — файлы приватные). */
export async function viewMaterialInvoice(orderId) {
    // Счёт ищем в обоих списках: кнопка «Открыть счёт» есть и у очереди,
    // и у истории оплат (там счёт уже оплачен, но документ нужен).
    const order = invoiceCache.find(row => row.id === orderId)
        || paidInvoiceCache.find(row => row.id === orderId);

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
        toast('Не удалось отметить оплату: ' + db.explainError(error), 'error');
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
// ВЫГРУЗКА В EXCEL
// =====================================================================

/**
 * Выгружает в Excel ТОЛЬКО то, что видно на экране: активное меню блока
 * («⏳ Ожидают оплату» или «✅ Оплаченные») и, у истории, выбранный период.
 * Это и есть «скачать по фильтру»: финансист получает на листе те же строки,
 * что и в блоке, и может приложить файл к сверке с банком.
 */
export function exportMaterialInvoicesToExcel() {
    if (typeof XLSX === 'undefined') {
        toast(t('invoice.noXlsx'), 'error');
        return;
    }

    const orders = getVisibleInvoices();
    if (orders.length === 0) {
        toast(t('invoice.exportEmpty'), 'warning');
        return;
    }

    const isPaid = invoiceView === 'paid';
    const sumHeader = t('invoice.colSum');
    const dateHeader = t('common.date');
    const paidAtHeader = t('invoice.paidAt');
    const paidByHeader = t('invoice.paidBy');

    const rows = orders.map(order => {
        const row = {
            [t('invoice.colNumber')]: order.request_number || '',
            [dateHeader]: formatDate(order.invoice_uploaded_at || order.created_at)
        };

        // «Кто и когда оплатил» — только у истории оплат: в очереди эти
        // колонки были бы пустыми и только мешали бы читать список.
        if (isPaid) {
            row[paidAtHeader] = formatDate(order.paid_at);
            row[paidByHeader] = order.paid_by?.name || '';
        }

        row[t('common.object')] = order.project?.name || '';
        row[t('common.section')] = order.section?.name || '';
        row[t('invoice.colSupplier')] = order.supplier || '';
        row[sumHeader] = invoiceSum(order);

        return row;
    });

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const columns = Object.keys(rows[0]);

    // Ширина колонок по самому длинному значению: иначе Excel показывает ~8 знаков
    worksheet['!cols'] = columns.map(header => {
        const maxLen = rows.reduce((max, row) => {
            const length = String(row[header] ?? '').length;
            return length > max ? length : max;
        }, header.length);

        return { wch: Math.max(10, Math.min(maxLen + 2, 60)) };
    });

    // Автофильтр по шапке: сортировка и фильтр доступны в Excel сразу
    worksheet['!autofilter'] = {
        ref: XLSX.utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: rows.length, c: columns.length - 1 }
        })
    };

    // Сумма — настоящим числом с денежным форматом: в Excel по колонке считают
    // итог, а не читают её как текст.
    const sumColumn = columns.indexOf(sumHeader);
    if (sumColumn > -1) {
        rows.forEach((row, index) => {
            const cell = worksheet[XLSX.utils.encode_cell({ r: index + 1, c: sumColumn })];
            if (!cell) return;

            const num = Number(cell.v);
            if (isNaN(num)) return;

            cell.t = 'n';
            cell.v = num;
            cell.z = '#,##0.00';
            delete cell.w;
        });
    }

    const sheetName = (isPaid ? t('invoice.sheetPaid') : t('invoice.sheetOpen')).slice(0, 31);
    const fileName = `${isPaid ? t('invoice.filePaid') : t('invoice.fileOpen')}_${todayISO()}.xlsx`;

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    XLSX.writeFile(workbook, fileName);

    log.info(`🧾 Счета выгружены в Excel: строк ${rows.length} (${sheetName})`);
    toast(t('invoice.exported', { count: rows.length }), 'success');
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.viewMaterialInvoice = viewMaterialInvoice;
window.markMaterialInvoicePaid = markMaterialInvoicePaid;
window.renderMaterialInvoices = renderMaterialInvoices;
window.setInvoiceView = setInvoiceView;
window.setInvoicePeriod = setInvoicePeriod;
window.exportMaterialInvoicesToExcel = exportMaterialInvoicesToExcel;
