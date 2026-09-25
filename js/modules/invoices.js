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
    log, toast, escapeHtml, formatMoney, formatDate, todayISO,
    showModal, hideModal
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

    return `<button type="button" data-action="setInvoiceView" data-arg="${view}" id="invoice-view-${view}"
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
                <select id="invoice-period-filter" data-action="setInvoicePeriod" data-arg-value data-on="change"
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
                <button type="button" data-action="exportMaterialInvoicesToExcel" id="invoice-export-btn"
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

/**
 * Карточка счёта в очереди оплаты. Вся карточка кликабельна: подробности и
 * кнопка оплаты живут в окне `#material-invoice-detail-modal`
 * (openMaterialInvoiceDetail()).
 *
 * Почему в списке статус, а не кнопка: раньше справа внизу стояла зелёная
 * кнопка «✅ Оплачено», и очередь «⏳ Ожидают оплату» читалась как «эти счета
 * уже оплачены». Теперь список показывает состояние счёта, а закрыть долг
 * можно только осознанно — открыв карточку.
 */
function renderInvoiceCard(order) {
    const sum = Number(order.invoice_total) || Number(order.total_sum) || 0;
    const delivered = order.status === 'delivered'
        || order.status === 'closed'
        || order.status === 'archived';

    const statusBadge = delivered
        ? `<span class="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-bold">🚚 ${t('invoice.delivered')}</span>`
        : `<span class="text-[10px] bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded font-bold">📦 ${t('invoice.notDelivered')}</span>`;

    // Кнопка файла — внутри кликабельной карточки: гасим всплытие, иначе клик
    // по «🧾 Открыть счёт» открывал бы ещё и окно подробностей.
    const fileBlock = order.invoice_path
        ? `<button data-action="viewMaterialInvoice" data-arg="${order.id}" data-stop
                   data-skip data-on="keydown"
                   class="text-[11px] font-semibold text-[#15803d] hover:underline">${t('invoice.openFile')}</button>`
        : `<span class="text-[11px] text-amber-700">⚠ ${t('invoice.noFile')}</span>`;

    return `
        <div id="material-invoice-card-${order.id}" role="button" tabindex="0"
             data-action="openMaterialInvoiceDetail" data-arg="${order.id}"
             data-on="click keydown" data-keys="Enter Space" data-prevent
             class="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2 cursor-pointer transition hover:border-amber-400 hover:shadow-sm">
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
                <div class="flex flex-wrap items-center gap-2">
                    <span class="text-[11px] font-semibold text-[#15803d]">${t('invoice.cardHint')}</span>
                    <span class="text-[10px] bg-amber-200 text-amber-900 px-2 py-0.5 rounded font-bold whitespace-nowrap">⏳ ${t('invoice.debt')}</span>
                </div>
            </div>
        </div>
    `;
}

/**
 * Карточка оплаченного счёта (история «✅ Оплаченные»): когда и кто заплатил.
 * Кнопки «Оплачено» здесь нет — счёт уже оплачен, а отменить это в приложении
 * нельзя (см. инструкцию для финансиста). Карточка тоже кликабельна: окно
 * подробностей покажет тот же счёт, но без кнопки оплаты.
 */
function renderPaidInvoiceCard(order) {
    // См. renderInvoiceCard(): всплытие гасим, иначе кнопка файла открывала бы
    // ещё и окно подробностей.
    const fileBlock = order.invoice_path
        ? `<button data-action="viewMaterialInvoice" data-arg="${order.id}" data-stop
                   data-skip data-on="keydown"
                   class="text-[11px] font-semibold text-[#15803d] hover:underline">${t('invoice.openFile')}</button>`
        : `<span class="text-[11px] text-gray-400">${t('invoice.noFile')}</span>`;

    const payer = order.paid_by?.name;

    return `
        <div id="material-invoice-card-${order.id}" role="button" tabindex="0"
             data-action="openMaterialInvoiceDetail" data-arg="${order.id}"
             data-on="click keydown" data-keys="Enter Space" data-prevent
             class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-2 cursor-pointer transition hover:border-emerald-400 hover:shadow-sm">
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
                <div class="flex flex-wrap items-center gap-2">
                    ${order.invoice_uploaded_at ? `<span class="text-[10px] text-gray-500">${t('invoice.of')} 🧾 ${formatDate(order.invoice_uploaded_at)}</span>` : ''}
                    <span class="text-[11px] font-semibold text-[#15803d]">${t('invoice.cardHintPaid')}</span>
                </div>
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
// ОКНО ПОДРОБНОСТЕЙ СЧЁТА
// =====================================================================
// Список отвечает на вопрос «что нужно оплатить», а окно — «что это за закупка
// и чем закрыть долг»: те же поля плюс даты (счёт, заявка, поставка) и отметка
// оплаты — кто и когда. Кнопка оплаты есть только здесь: в списке счёт нельзя
// закрыть случайным нажатием (раньше кнопка стояла в самой карточке очереди).
//
// Окно одно для очереди и истории оплат: у оплаченного счёта кнопки «Оплачено»
// просто нет, поэтому отдельного окна для истории не нужно.
//
// Данные берём из кэша списка: окно открывается по клику, лишний запрос в базу
// только задержал бы ответ, а счёт уже прочитан вместе со списком.

/** Подставляет подробности счёта в окно и открывает его. */
export function openMaterialInvoiceDetail(orderId) {
    // Счёт ищем в обоих списках: кликабельны и карточка очереди, и история.
    const order = invoiceCache.find(row => row.id === orderId)
        || paidInvoiceCache.find(row => row.id === orderId);

    if (!order) {
        toast(t('invoice.notFound'), 'error');
        return;
    }

    const container = document.getElementById('material-invoice-detail-content');
    if (!container) return;

    container.innerHTML = renderInvoiceDetail(order);
    renderInvoiceDetailActions(order);

    showModal('material-invoice-detail-modal');
}

/** Подробности счёта: шапка со статусами, поля заявки и файл счёта. */
function renderInvoiceDetail(order) {
    const delivered = order.status === 'delivered'
        || order.status === 'closed'
        || order.status === 'archived';

    const paid = order.payment_status === 'paid';
    const invoiceTotal = Number(order.invoice_total) || null;
    const orderTotal = Number(order.total_sum) || null;

    // Обе суммы показываем, только когда они РАЗНЫЕ: так видно, что в счёт
    // поставщика не вошла своя доставка — она осталась расходом заявки.
    // Копеечный запас — чтобы равенство не «поехало» из-за дробных чисел.
    const sumsDiffer = invoiceTotal !== null && orderTotal !== null
        && Math.abs(invoiceTotal - orderTotal) > 0.004;

    const payBadge = paid
        ? `<span class="text-xs font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">✅ ${t('invoice.paidAt')}</span>`
        : `<span class="text-xs font-bold px-2 py-0.5 rounded bg-amber-200 text-amber-900">⏳ ${t('invoice.debt')}</span>`;

    const deliveryBadge = delivered
        ? `<span class="text-xs font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">🚚 ${t('invoice.delivered')}</span>`
        : `<span class="text-xs font-bold px-2 py-0.5 rounded bg-yellow-100 text-yellow-800">📦 ${t('invoice.notDelivered')}</span>`;

    const fileBlock = order.invoice_path
        ? `<div class="flex flex-wrap justify-between items-center gap-2 bg-gray-50 border rounded-lg p-2.5 text-xs">
                <span class="text-gray-600">🧾 ${escapeHtml(order.invoice_file_name || t('invoice.of'))}</span>
                <button data-action="viewMaterialInvoice" data-arg="${order.id}"
                        class="text-[11px] font-semibold text-[#15803d] hover:underline">${t('invoice.openFile')}</button>
            </div>`
        : `<p class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">⚠ ${t('invoice.noFile')}</p>`;

    const payer = order.paid_by?.name;

    return `
        <div class="flex flex-wrap justify-between items-center gap-2 bg-gray-50 border rounded-lg p-3">
            <div class="flex items-center gap-2 flex-wrap">
                <span class="font-bold text-[#15803d] font-mono text-base">${escapeHtml(order.request_number)}</span>
                ${payBadge}
                ${deliveryBadge}
            </div>
            <span class="font-bold text-[#166534]">${formatMoney(invoiceSum(order))}</span>
        </div>

        <div class="bg-gray-50 border rounded-lg p-3 space-y-0.5 text-xs text-gray-700">
            <p><strong>🏗 ${t('common.object')}:</strong> ${escapeHtml(order.project?.name || '—')}</p>
            <p><strong>📂 ${t('common.section')}:</strong> ${escapeHtml(order.section?.name || '—')}</p>
            ${order.supplier ? `<p><strong>🏬 ${t('invoice.colSupplier')}:</strong> ${escapeHtml(order.supplier)}</p>` : ''}
            <p><strong>💰 ${t('invoice.colSum')}:</strong> ${formatMoney(invoiceTotal ?? invoiceSum(order))}</p>
            ${sumsDiffer ? `<p><strong>📦 ${t('invoice.orderSum')}:</strong> ${formatMoney(orderTotal)}</p>` : ''}
            ${order.invoice_uploaded_at ? `<p><strong>🧾 ${t('invoice.fieldInvoiceLoaded')}:</strong> ${formatDate(order.invoice_uploaded_at)}</p>` : ''}
            ${order.created_at ? `<p><strong>📅 ${t('invoice.fieldCreated')}:</strong> ${formatDate(order.created_at)}</p>` : ''}
            ${order.desired_date ? `<p><strong>⏳ ${t('invoice.fieldDesired')}:</strong> ${formatDate(order.desired_date)}</p>` : ''}
            ${order.delivered_at ? `<p><strong>🚚 ${t('invoice.fieldDeliveredAt')}:</strong> ${formatDate(order.delivered_at)}</p>` : ''}
            ${order.paid_at ? `<p><strong>✅ ${t('invoice.paidAt')}:</strong> ${formatDate(order.paid_at)}${payer ? ` · 👤 ${t('invoice.paidBy')}: ${escapeHtml(payer)}` : ''}</p>` : ''}
        </div>

        ${fileBlock}
    `;
}

/**
 * Кнопки окна: файл счёта, оплата и закрытие. Оплата — только у долга и
 * только с правом pay_material_invoice; шаг всё равно подтверждается
 * системным вопросом (markMaterialInvoicePaid()), потому что деньги уходят с
 * расчётного счёта фирмы, а отменить отметку в приложении нельзя.
 */
function renderInvoiceDetailActions(order) {
    const container = document.getElementById('material-invoice-detail-actions');
    if (!container) return;

    const buttons = [];

    if (order.invoice_path) {
        buttons.push(`<button type="button" data-action="viewMaterialInvoice" data-arg="${order.id}"
            class="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">${t('invoice.openFile')}</button>`);
    }

    if (order.payment_status !== 'paid' && canPayInvoices()) {
        buttons.push(`<button type="button" id="material-invoice-pay-btn"
            data-action="markMaterialInvoicePaid" data-arg="${order.id}"
            class="bg-[#15803d] hover:bg-[#166534] text-white font-semibold px-4 py-2 rounded-lg text-sm transition">${t('invoice.pay')}</button>`);
    }

    buttons.push(`<button type="button" data-action="hideModal" data-arg="material-invoice-detail-modal"
        class="bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold px-4 py-2 rounded-lg text-sm transition">${t('common.close')}</button>`);

    container.innerHTML = buttons.join('');
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

    // Окно подробностей закрываем: счёт ушёл в историю, а его карточка из
    // очереди исчезнет после перерисовки — старая копия в окне только сбивала
    // бы с толку (там осталась бы кнопка «✅ Оплачено»).
    hideModal('material-invoice-detail-modal');

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
window.openMaterialInvoiceDetail = openMaterialInvoiceDetail;
window.markMaterialInvoicePaid = markMaterialInvoicePaid;
window.renderMaterialInvoices = renderMaterialInvoices;
window.setInvoiceView = setInvoiceView;
window.setInvoicePeriod = setInvoicePeriod;
window.exportMaterialInvoicesToExcel = exportMaterialInvoicesToExcel;
