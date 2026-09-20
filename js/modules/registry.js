// =====================================================================
// МОДУЛЬ: РЕЕСТР МАТЕРИАЛОВ
// =====================================================================
// Сводная таблица всех закупок и расходов.
//
// Источники данных (не хранит, а собирает):
//   1. Заявки с payment_source = 'company' (delivered + closed + archived)
//   2. Расходы из cash_operations (source = 'manual')
//   3. Заявки с payment_source = 'employee' (уже в cash_operations)
//
// ⚠️ ВАЖНО: 
//   - Архивные заявки ТОЖЕ попадают в реестр (архив ≠ удаление)
//   - Материалы попадают в реестр сразу после «Доставлено на объект», даже
//     если счёт ещё не оплачен: тогда оплата = 'debt' («Ожидает оплаты»),
//     а отметку «Оплачено» ставит финансист (js/modules/invoices.js).
//   - Избегаем двойного учёта:
//       * заявка фирмой → из order_items
//       * заявка сотрудником → из cash_operations
//       * прямой расход → из cash_operations
//   - Дата: для заявок — delivered_at (closed_at у старых), для расходов — operation_date
//   - Доставка по заявке — отдельная позиция заявки (CONFIG.DELIVERY_ITEM, её
//     вписывает снабженец в окне счёта): показывается категорией «🚚 Доставка»,
//     поэтому фильтр «Категория → 🚚 Доставка» видит реальные суммы доставки.
//     Если доставку везла компания («Доставка компании»), сумма в счёт
//     поставщика не входила — в колонке «Оплата» у такой строки стоит
//     «🏢 Вне счёта», а не «Ожидает оплаты»: долга перед поставщиком нет.
//   - Своя доставка (v2.5.0): если она оплачена из подотчёта, деньги лежат в
//     cash_operations (source = 'own_delivery'), поэтому строка заявки в реестр
//     НЕ попадает — вместо неё показывается расход с пометкой «🚚 Своя
//     доставка». Иначе одна сумма стояла бы в таблице дважды.
//   - НДС: у строки показывается «в т.ч. ПДВ» (order_items.vat_amount /
//     cash_operations.vat_amount). Сумма при этом ВСЕГДА с налогом — колонка
//     «Сумма» остаётся деньгами к оплате, поэтому итоги реестра не меняются.
// =====================================================================

import { db } from '../database.js';
import { CONFIG } from '../config.js';
import {
    log, toast, escapeHtml, formatMoney,
    formatDate, roundMoney, isDeliveryItem, getDeliveryItemType,
    isOwnDeliveryCovered, ownDeliveryCoveredOrderIds
} from '../utils.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let registryCache = [];
// Текст предупреждения, если заявки не загрузились (например, в базе нет
// колонок v2.4.0 — не применена миграция). Показывается над таблицей.
let registryWarning = '';
let filters = {
    project: '',
    section: '',
    category: '',
    payment: '',
    employee: '',
    dateFrom: '',
    dateTo: ''
};

// Человекочитаемые названия категорий (таблица реестра + экспорт в Excel)
const CATEGORY_LABELS = {
    'materials': '📦 Материалы',
    'works': '🛠 Работы',
    'delivery': '🚚 Доставка',
    'other': '📋 Прочее'
};

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

export async function loadRegistry() {
    log.info('Загрузка реестра материалов...');

    const items = [];       // готовые строки таблицы
    // Строки заявок собираем отдельно: их добавим ПОСЛЕ расходов. Причина —
    // своя доставка: если за неё уже заплатили из подотчёта, её деньги лежат
    // расходом кассы, и строку заявки показывать нельзя (сумма удвоилась бы).
    // Узнать об этом можно только по загруженным операциям (шаг 2).
    const orderRows = [];

    // ============================================================
    // 1. Заявки с оплатой фирмой (status: closed ИЛИ archived)
    //    ⚠️ .in не работает — загружаем всё, фильтруем в JS
    // ============================================================
    const { data: allOrders, error: ordersError } = await db.select('orders', {
        select: `
            id, request_number, project_id, section_id, 
            supplier, payment_source, payment_status, closed_at, delivered_at,
            invoice_path, status, created_at,
            project:projects ( id, name ),
            section:sections ( id, name ),
            created_by_emp:employees!orders_created_by_employee_id_fkey ( id, name )
        `,
        filters: {
            payment_source: 'company',
            'status.in': ['delivered', 'closed', 'archived']   // фильтруем на сервере, а не в JS
        }
    });

    if (ordersError) {
        // Без объяснения реестр просто оказался бы без заявок (а расходы на
        // месте) — сотрудник решил бы, что данные пропали. db.explainError()
        // превращает техническую ошибку в инструкцию, что делать.
        registryWarning = '⚠ Заявки на материалы не загрузились: ' + db.explainError(ordersError);
        log.error('Ошибка загрузки заявок для реестра:', ordersError.message);
    } else {
        registryWarning = '';
    }

    // Фильтруем только delivered + closed + archived
    const firmOrders = (allOrders || []).filter(o =>
        o.status === 'delivered' || o.status === 'closed' || o.status === 'archived'
    );

    if (firmOrders.length > 0) {
        // Загружаем order_items для этих заявок
        const orderIds = firmOrders.map(o => o.id);
        const { data: allOrderItems } = await db.select('order_items', {
            select: 'id, order_id, name, unit, qty, unit_price, total_price, payment_status',
            filters: { 'order_id.in': orderIds }
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

            // Доставка приходит отдельной позицией заявки, поэтому её и
            // показываем категорией «🚚 Доставка»: фильтр «Категория» тогда
            // видит реальные суммы доставки.
            const deliveryType = getDeliveryItemType(it);
            // Доставку компании поставщик не выставлял: её сумма в счёт
            // (и в долг фирмы перед поставщиком) не входила, поэтому у строки
            // своя отметка оплаты и в «Поставщике» прочерк.
            const companyDelivery = deliveryType === CONFIG.DELIVERY_ITEM.TYPE.COMPANY;

            orderRows.push({
                _source: 'order',
                _orderNumber: order.request_number,
                _orderId: order.id,
                order_id: order.id,
                date: order.delivered_at || order.closed_at || order.created_at,
                name: it.name,
                unit: it.unit || 'шт',
                qty: it.qty,
                unitPrice: it.unit_price || 0,
                sum: it.total_price || 0,
                // НДС внутри суммы (v2.5.0). У строк, созданных раньше, ноль —
                // колонка «в т.ч. ПДВ» тогда показывает прочерк.
                vat: Number(it.vat_amount) || 0,
                category: deliveryType ? 'delivery' : 'materials',
                supplier: companyDelivery ? '—' : (order.supplier || '—'),
                project: order.project?.name || '—',
                projectId: order.project_id,
                section: order.section?.name || '—',
                sectionId: order.section_id,
                employee: order.created_by_emp?.name || '—',
                // Статус оплаты берём у заявки: «Ожидает оплаты» держится до
                // отметки финансиста по счёту, а не по каждой позиции.
                payment: companyDelivery
                    ? 'company'
                    : (order.payment_status || it.payment_status || 'paid')
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
                select: 'id, request_number, supplier',
                filters: { 'id.in': orderIdsForNumbers }
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
            } else if (exp.source === 'own_delivery' && exp.order_id) {
                // Своя доставка: расход создало само приложение при сохранении
                // счёта (js/modules/orders.js). Поставщика нет — везли своими
                // силами, поэтому в «Поставщике» прочерк, а в «Источнике» —
                // номер заявки, к которой расход относится.
                const orderInfo = orderNumbersMap[exp.order_id];
                sourceLabel = orderInfo ? orderInfo.request_number : '—';
                supplier = '—';
            }

            // Тип строки: заявка, оплаченная сотрудником, прямой расход или
            // своя доставка из подотчёта (у неё своя пометка в таблице).
            const rowSource = exp.source === 'own_delivery'
                ? 'own_delivery'
                : (exp.source === 'order' ? 'order_employee' : 'expense');

            if (expItems.length > 0) {
                expItems.forEach(it => {
                    items.push({
                        _source: rowSource,
                        _orderNumber: sourceLabel,
                        _orderId: exp.order_id,
                        date: exp.operation_date || exp.created_at,
                        name: it.name,
                        unit: it.unit || 'шт',
                        qty: it.qty,
                        unitPrice: it.price || 0,
                        sum: it.sum || 0,
                        vat: Number(exp.vat_amount) || 0,
                        // Заявку оплатил снабженец из подотчёта — позиции пришли
                        // из cash_operation (category там одна на операцию),
                        // поэтому доставку тоже показываем её категорией.
                        category: isDeliveryItem(it) ? 'delivery' : exp.category,
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
                    _source: rowSource,
                    _orderNumber: sourceLabel,
                    _orderId: exp.order_id,
                    date: exp.operation_date || exp.created_at,
                    name: exp.description || '—',
                    unit: '—',
                    qty: 1,
                    unitPrice: exp.amount,
                    sum: exp.amount,
                    vat: Number(exp.vat_amount) || 0,
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

    // ---- Строки заявок: добавляем после расходов ----
    // Своя доставка, оплаченная из подотчёта, уже показана строкой расхода
    // (source = 'own_delivery'), поэтому строку заявки пропускаем: иначе одна
    // и та же сумма стояла бы в таблице дважды. Заявки, где доставку ещё не
    // оплатили (или платит фирма), проходят как раньше — «🏢 Вне счёта».
    const coveredOwnDelivery = ownDeliveryCoveredOrderIds(expenses || []);

    orderRows.forEach(row => {
        if (isOwnDeliveryCovered(row, coveredOwnDelivery)) {
            log.info(`Реестр: своя доставка по заявке ${row._orderNumber} — деньги в расходе подотчёта, строку заявки не показываем`);
            return;
        }
        items.push(row);
    });

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

    // Предупреждение о неполных данных (например, база без колонок v2.4.0)
    const warningEl = document.getElementById('registry-warning');
    if (warningEl) {
        warningEl.textContent = registryWarning;
        warningEl.classList.toggle('hidden', !registryWarning);
    }

    const data = getFilteredData();

    const totalSum = roundMoney(data.reduce((sum, i) => sum + (Number(i.sum) || 0), 0));
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
    } else if (item._source === 'own_delivery') {
        // Своя доставка: расход подотчёта, созданный при сохранении счёта.
        // Отдельная пометка нужна, чтобы в реестре было видно: это не счёт
        // поставщика, а внутренний расход (водитель, транспортный отдел).
        sourceBadge = `<span class="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold" title="Своя доставка: расход подотчёта">🚚 Своя доставка</span>`;
    } else {
        sourceBadge = `<span class="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold" title="Прямой расход">💰 Расход</span>`;
    }

    const categoryLabel = CATEGORY_LABELS[item.category] || item.category || '—';

    // 'company' — доставка компании: суммы в счёте поставщика не было, поэтому
    // врать «Ожидает оплаты» нельзя — иначе долг перед поставщиком казался бы
    // больше, чем он есть.
    const paymentBadge = item.payment === 'debt'
        ? `<span class="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold text-[10px]">Ожидает оплаты</span>`
        : item.payment === 'company'
            ? `<span class="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-bold text-[10px]" title="Доставка компании: в счёт поставщика не входит">🏢 Вне счёта</span>`
            : `<span class="bg-green-100 text-green-800 px-1.5 py-0.5 rounded font-bold text-[10px]">Оплачено</span>`;

    return `
        <tr class="hover:bg-emerald-50/60 transition border-b">
            <td class="p-2.5 whitespace-nowrap text-xs">${dateStr}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${sourceBadge}<div class="text-[10px] text-gray-500 mt-0.5">${escapeHtml(item._orderNumber)}</div></td>
            <td class="p-2.5 text-xs font-semibold text-gray-900">${escapeHtml(item.name)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${item.qty} ${escapeHtml(item.unit)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${formatMoney(item.unitPrice)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs font-bold text-[#15803d]">${formatMoney(item.sum)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs text-gray-600" title="НДС внутри суммы (справочно: деньги в колонке «Сумма» уже с налогом)">${item.vat > 0 ? formatMoney(item.vat) : '—'}</td>
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

    // Дату пишем настоящей датой Excel (формат встроенный, поэтому Excel
    // покажет её по локали: в русской — 14.08.2026). Тогда автофильтр и
    // сортировка по дате работают правильно, а не как по тексту.
    // Если значение не в ISO-формате — оставляем исходный текст.
    const excelDate = value => {
        const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
        if (!parts) return formatDate(value);

        const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
        return isNaN(date.getTime()) ? formatDate(value) : date;
    };

    // Числа округляем до копеек; значение, которое не удалось распарсить,
    // оставляем как есть — roundMoney() молча превратил бы его в 0
    const money = value => {
        if (value === null || value === undefined) return value;
        if (typeof value === 'string' && value.trim() === '') return value;
        const num = Number(value);
        return Number.isFinite(num) ? Math.round((num + Number.EPSILON) * 100) / 100 : value;
    };

    const rows = data.map(item => ({
        'Дата': excelDate(item.date),
        'Источник': item._orderNumber,
        'Наименование': item.name,
        'Кол-во': item.qty,
        'Ед. изм.': item.unit,
        'Цена за ед.': money(item.unitPrice),
        'Сумма': money(item.sum),
        'в т.ч. ПДВ': item.vat > 0 ? money(item.vat) : 0,
        'Без ПДВ': item.vat > 0 ? money(roundMoney(Number(item.sum) - Number(item.vat))) : money(item.sum),
        'Категория': CATEGORY_LABELS[item.category] || item.category || '—',
        'Оплата': item.payment === 'debt' ? 'Ожидает оплаты'
            : item.payment === 'company' ? 'Вне счёта поставщика' : 'Оплачено',
        'Поставщик': item.supplier,
        'Объект': item.project,
        'Раздел': item.section,
        'Сотрудник': item.employee
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);

    // Колонки берём в том порядке, в каком они перечислены в rows выше
    const columns = Object.keys(rows[0]);

    // ── ЧИТАЕМОСТЬ ФАЙЛА ─────────────────────────────────────────────
    // Excel открывает .xlsx со своей шириной колонок (~8 символов), поэтому
    // длинный текст в ячейках не видно. Считаем ширину каждой колонки по
    // самому длинному значению (длину заголовка тоже учитываем).
    // Длину значения считаем по тому, как оно будет показано в Excel:
    // дата — как ДД.ММ.ГГГГ, а не как «Fri Aug 14 2026 00:00:00 GMT+0300»
    const textLength = value => {
        if (value instanceof Date) return formatDate(value).length;
        if (value === null || value === undefined) return 0;
        return String(value).length;
    };

    worksheet['!cols'] = columns.map(header => {
        const maxLen = rows.reduce((max, row) => {
            const len = textLength(row[header]);
            return len > max ? len : max;
        }, header.length);

        // +2 — внутренние отступы Excel. Потолок 250 символов — предел ширины
        // колонки в Excel (255), чтобы даже очень длинное наименование было видно
        return { wch: Math.max(10, Math.min(maxLen + 2, 250)) };
    });

    // Автофильтр по шапке — сортировка и фильтр доступны сразу в Excel
    worksheet['!autofilter'] = {
        ref: XLSX.utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: rows.length, c: columns.length - 1 }
        })
    };

    // Числовые колонки пишем числами (а не текстом), деньги — с форматом
    // «два знака после запятой»: суммы читаются и считаются формулами.
    // «Кол-во» оставляем без формата — 40 и 150,5 показываются как есть.
    const numericFormats = {
        'Кол-во': '',
        'Цена за ед.': '#,##0.00',
        'Сумма': '#,##0.00'
    };

    Object.entries(numericFormats).forEach(([header, numberFormat]) => {
        const col = columns.indexOf(header);
        if (col === -1) return;

        rows.forEach((row, rowIndex) => {
            const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: col })];
            if (!cell) return;

            const num = Number(cell.v);
            if (cell.v === null || cell.v === undefined
                || String(cell.v).trim() === '' || isNaN(num)) return;

            cell.t = 'n';
            cell.v = num;
            if (numberFormat) cell.z = numberFormat;
            delete cell.w;
        });
    });

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