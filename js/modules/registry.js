// =====================================================================
// МОДУЛЬ: РЕЕСТР МАТЕРИАЛОВ
// =====================================================================
// Сводная таблица всех закупок и расходов.
//
// Источники данных (не хранит, а собирает):
//   1. Заявки с payment_source = 'company' (closed + archived)
//   2. Расходы из cash_operations (source = 'manual')
//   3. Заявки с payment_source = 'employee' (уже в cash_operations)
//
// ⚠️ ВАЖНО: 
//   - Архивные заявки ТОЖЕ попадают в реестр (архив ≠ удаление)
//   - Избегаем двойного учёта:
//       * заявка фирмой → из order_items
//       * заявка сотрудником → из cash_operations
//       * прямой расход → из cash_operations
//   - Дата: для заявок — closed_at, для расходов — operation_date
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, formatMoney,
    formatDate
} from '../utils.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let registryCache = [];
let filters = {
    project: '',
    section: '',
    category: '',
    payment: '',
    employee: '',
    dateFrom: '',
    dateTo: ''
};

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

export async function loadRegistry() {
    log.info('Загрузка реестра материалов...');

    const items = [];

    // ============================================================
    // 1. Заявки с оплатой фирмой (status: closed ИЛИ archived)
    //    ⚠️ .in не работает — загружаем всё, фильтруем в JS
    // ============================================================
    const { data: allOrders, error: ordersError } = await db.select('orders', {
        select: `
            id, request_number, project_id, section_id, 
            supplier, payment_source, closed_at, status, created_at,
            project:projects ( id, name ),
            section:sections ( id, name ),
            created_by_emp:employees!orders_created_by_employee_id_fkey ( id, name )
        `,
        filters: { payment_source: 'company' }
    });

    if (ordersError) {
        log.error('Ошибка загрузки заявок для реестра:', ordersError.message);
    }

    // Фильтруем только closed + archived
    const firmOrders = (allOrders || []).filter(o => 
        o.status === 'closed' || o.status === 'archived'
    );

    if (firmOrders.length > 0) {
        // Загружаем order_items для этих заявок
        const orderIds = firmOrders.map(o => o.id);
        const { data: allOrderItems } = await db.select('order_items', {
            filters: {}
        });

        // Фильтруем items по нашим заявкам
        const orderMap = {};
        firmOrders.forEach(o => { orderMap[o.id] = o; });

        const orderItems = (allOrderItems || []).filter(it => 
            orderMap[it.order_id]
        );

        orderItems.forEach(it => {
            const order = orderMap[it.order_id];
            if (!order) return;

            items.push({
                _source: 'order',
                _orderNumber: order.request_number,
                _orderId: order.id,
                date: order.closed_at || order.created_at,
                name: it.name,
                unit: it.unit || 'шт',
                qty: it.qty,
                unitPrice: it.unit_price || 0,
                sum: it.total_price || 0,
                category: 'materials',
                supplier: order.supplier || '—',
                project: order.project?.name || '—',
                projectId: order.project_id,
                section: order.section?.name || '—',
                sectionId: order.section_id,
                employee: order.created_by_emp?.name || '—',
                payment: it.payment_status || 'paid'
            });
        });
    }

    // ============================================================
    // 2. Все расходы из cash_operations (source = 'manual' или 'order')
    //    Заявки, оплаченные сотрудником, уже здесь (source = 'order')
    // ============================================================
    const { data: expenses, error: expError } = await db.select('cash_operations', {
        select: `
            id, employee_id, amount, category, project_id, section_id,
            items, source, order_id, operation_date, created_at, description,
            employee:employees ( id, name ),
            project:projects ( id, name ),
            section:sections ( id, name )
        `,
        filters: { operation_type: 'expense' }
    });

    if (expError) {
        log.error('Ошибка загрузки расходов:', expError.message);
    }

    if (expenses && expenses.length > 0) {
        // Номера заявок для source='order'
        const orderIdsForNumbers = expenses.filter(e => e.order_id).map(e => e.order_id);
        let orderNumbersMap = {};
        if (orderIdsForNumbers.length > 0) {
            const { data: ordersData } = await db.select('orders', {
                select: 'id, request_number, supplier'
            });
            (ordersData || []).forEach(o => { 
                if (orderIdsForNumbers.includes(o.id)) {
                    orderNumbersMap[o.id] = o;
                }
            });
        }

        expenses.forEach(exp => {
            const expItems = Array.isArray(exp.items) ? exp.items : [];

            // Источник
            let sourceLabel = '💰 Расход';
            let supplier = '—';
            if (exp.source === 'order' && exp.order_id) {
                const orderInfo = orderNumbersMap[exp.order_id];
                sourceLabel = orderInfo ? orderInfo.request_number : '—';
                supplier = orderInfo?.supplier || '—';
            }

            if (expItems.length > 0) {
                expItems.forEach(it => {
                    items.push({
                        _source: exp.source === 'order' ? 'order_employee' : 'expense',
                        _orderNumber: sourceLabel,
                        _orderId: exp.order_id,
                        date: exp.operation_date || exp.created_at,
                        name: it.name,
                        unit: it.unit || 'шт',
                        qty: it.qty,
                        unitPrice: it.price || 0,
                        sum: it.sum || 0,
                        category: exp.category,
                        supplier: supplier,
                        project: exp.project?.name || '—',
                        projectId: exp.project_id,
                        section: exp.section?.name || '—',
                        sectionId: exp.section_id,
                        employee: exp.employee?.name || '—',
                        payment: 'paid'
                    });
                });
            } else {
                items.push({
                    _source: exp.source === 'order' ? 'order_employee' : 'expense',
                    _orderNumber: sourceLabel,
                    _orderId: exp.order_id,
                    date: exp.operation_date || exp.created_at,
                    name: exp.description || '—',
                    unit: '—',
                    qty: 1,
                    unitPrice: exp.amount,
                    sum: exp.amount,
                    category: exp.category,
                    supplier: supplier,
                    project: exp.project?.name || '—',
                    projectId: exp.project_id,
                    section: exp.section?.name || '—',
                    sectionId: exp.section_id,
                    employee: exp.employee?.name || '—',
                    payment: 'paid'
                });
            }
        });
    }

    // Сортируем по дате (сначала новые)
    items.sort((a, b) => {
        const dateA = new Date(a.date || 0).getTime();
        const dateB = new Date(b.date || 0).getTime();
        return dateB - dateA;
    });

    registryCache = items;
    log.info(`Загружено записей в реестр: ${registryCache.length}`);

    renderRegistryFilters();
    renderRegistry();
}

// =====================================================================
// ФИЛЬТРЫ
// =====================================================================

function renderRegistryFilters() {
    const projects = [...new Set(registryCache.map(i => i.project))].filter(Boolean).sort();
    const projectsSel = document.getElementById('reg-filter-project');
    if (projectsSel) {
        const current = projectsSel.value;
        projectsSel.innerHTML = '<option value="">Все объекты</option>' +
            projects.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
        projectsSel.value = current;
    }

    const sections = [...new Set(registryCache.map(i => i.section))].filter(Boolean).sort();
    const sectionsSel = document.getElementById('reg-filter-section');
    if (sectionsSel) {
        const current = sectionsSel.value;
        sectionsSel.innerHTML = '<option value="">Все разделы</option>' +
            sections.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
        sectionsSel.value = current;
    }

    const employees = [...new Set(registryCache.map(i => i.employee))].filter(Boolean).sort();
    const empSel = document.getElementById('reg-filter-employee');
    if (empSel) {
        const current = empSel.value;
        empSel.innerHTML = '<option value="">Все сотрудники</option>' +
            employees.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
        empSel.value = current;
    }
}

export function applyRegistryFilters() {
    filters.project = document.getElementById('reg-filter-project')?.value || '';
    filters.section = document.getElementById('reg-filter-section')?.value || '';
    filters.category = document.getElementById('reg-filter-category')?.value || '';
    filters.payment = document.getElementById('reg-filter-payment')?.value || '';
    filters.employee = document.getElementById('reg-filter-employee')?.value || '';
    filters.dateFrom = document.getElementById('reg-filter-date-from')?.value || '';
    filters.dateTo = document.getElementById('reg-filter-date-to')?.value || '';

    renderRegistry();
}

export function resetRegistryFilters() {
    document.getElementById('reg-filter-project').value = '';
    document.getElementById('reg-filter-section').value = '';
    document.getElementById('reg-filter-category').value = '';
    document.getElementById('reg-filter-payment').value = '';
    document.getElementById('reg-filter-employee').value = '';
    document.getElementById('reg-filter-date-from').value = '';
    document.getElementById('reg-filter-date-to').value = '';

    filters = { project: '', section: '', category: '', payment: '', employee: '', dateFrom: '', dateTo: '' };
    renderRegistry();
}

function getFilteredData() {
    return registryCache.filter(item => {
        if (filters.project && item.project !== filters.project) return false;
        if (filters.section && item.section !== filters.section) return false;
        if (filters.category && item.category !== filters.category) return false;
        if (filters.payment && item.payment !== filters.payment) return false;
        if (filters.employee && item.employee !== filters.employee) return false;

        if (filters.dateFrom) {
            const itemDate = (item.date || '').split('T')[0];
            if (itemDate < filters.dateFrom) return false;
        }
        if (filters.dateTo) {
            const itemDate = (item.date || '').split('T')[0];
            if (itemDate > filters.dateTo) return false;
        }
        return true;
    });
}

// =====================================================================
// ОТОБРАЖЕНИЕ
// =====================================================================

export function renderRegistry() {
    const tbody = document.getElementById('registry-tbody');
    if (!tbody) return;

    const data = getFilteredData();

    const totalSum = data.reduce((sum, i) => sum + (Number(i.sum) || 0), 0);
    const countEl = document.getElementById('registry-count');
    const sumEl = document.getElementById('registry-total-sum');
    if (countEl) countEl.textContent = data.length;
    if (sumEl) sumEl.textContent = formatMoney(totalSum);

    if (data.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="11" class="text-center text-gray-400 py-6 text-sm">
                    Нет данных в реестре
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = data.map(item => renderRegistryRow(item)).join('');
}

function renderRegistryRow(item) {
    const dateStr = formatDate(item.date);

    let sourceBadge = '';
    if (item._source === 'order') {
        sourceBadge = `<span class="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold" title="Заявка (оплата фирмой)">📦 Заявка</span>`;
    } else if (item._source === 'order_employee') {
        sourceBadge = `<span class="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold" title="Заявка (оплата сотрудником)">📦 Заявка</span>`;
    } else {
        sourceBadge = `<span class="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold" title="Прямой расход">💰 Расход</span>`;
    }

    const categoryLabels = {
        'materials': '📦 Материалы',
        'works': '🛠 Работы',
        'delivery': '🚚 Доставка',
        'other': '📋 Прочее'
    };
    const categoryLabel = categoryLabels[item.category] || item.category || '—';

    const paymentBadge = item.payment === 'debt'
        ? `<span class="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold text-[10px]">В долг</span>`
        : `<span class="bg-green-100 text-green-800 px-1.5 py-0.5 rounded font-bold text-[10px]">Оплачено</span>`;

    return `
        <tr class="hover:bg-emerald-50/60 transition border-b">
            <td class="p-2.5 whitespace-nowrap text-xs">${dateStr}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${sourceBadge}<div class="text-[10px] text-gray-500 mt-0.5">${escapeHtml(item._orderNumber)}</div></td>
            <td class="p-2.5 text-xs font-semibold text-gray-900">${escapeHtml(item.name)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${item.qty} ${escapeHtml(item.unit)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${formatMoney(item.unitPrice)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs font-bold text-[#15803d]">${formatMoney(item.sum)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${categoryLabel}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${paymentBadge}</td>
            <td class="p-2.5 text-xs text-gray-700">${escapeHtml(item.supplier)}</td>
            <td class="p-2.5 text-xs text-gray-700">
                <div class="font-medium">${escapeHtml(item.project)}</div>
                <div class="text-[10px] text-gray-500">${escapeHtml(item.section)}</div>
            </td>
            <td class="p-2.5 text-xs text-gray-700">${escapeHtml(item.employee)}</td>
        </tr>
    `;
}

// =====================================================================
// ЭКСПОРТ В EXCEL
// =====================================================================

export function exportRegistryToExcel() {
    const data = getFilteredData();

    if (data.length === 0) {
        toast('Нет данных для выгрузки', 'warning');
        return;
    }

    if (typeof XLSX === 'undefined') {
        toast('Библиотека XLSX не загружена', 'error');
        return;
    }

    const rows = data.map(item => ({
        'Дата': formatDate(item.date),
        'Источник': item._orderNumber,
        'Наименование': item.name,
        'Кол-во': item.qty,
        'Ед. изм.': item.unit,
        'Цена за ед.': item.unitPrice,
        'Сумма': item.sum,
        'Категория': item.category,
        'Оплата': item.payment === 'debt' ? 'В долг' : 'Оплачено',
        'Поставщик': item.supplier,
        'Объект': item.project,
        'Раздел': item.section,
        'Сотрудник': item.employee
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Реестр материалов');

    const fileName = `Reestr_Materialov_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(workbook, fileName);

    toast(`Экспортировано ${data.length} строк`, 'success');
}

// =====================================================================
// БЕЙДЖ
// =====================================================================

export function updateRegistryBadge() {
    // Пока не используем
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.applyRegistryFilters = applyRegistryFilters;
window.resetRegistryFilters = resetRegistryFilters;
window.exportRegistryToExcel = exportRegistryToExcel;