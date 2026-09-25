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
// Сотрудник выбирает его в форме заказа материалов или в авансовом отчёте,
// и всё это собирается здесь:
//   * расходы кассы/подотчёта (cash_operations, category: works/materials/delivery/other);
//   * заказы материалов с оплатой фирмой (закрытые/архив) — как в план-факте.
//
// ⚠️ Показываем ровно то, что попадает в реестр расходов: позиции закрытых заявок
// материалов и траты из авансового отчёта/кассы. Финансовых запросов (cash_requests)
// здесь НЕТ намеренно: выданные в подотчёт деньги — ещё не трата (она появится строкой
// после авансового отчёта), и в «Итого вне сметы» такие суммы никогда не входили.
// Таблица «💰 Финансовые запросы» удалена, чтобы подвкладка не смешивала реестр с заявками.
//
// Как это выглядит: два списка — «🛠 Работы» и «📦 Материалы» (+ «📋 Прочее»,
// если такие траты есть) и отдельно заявки, которые ещё в работе. Строка списка —
// одна запись вне сметы, клик по строке открывает окно подробностей
// (#extra-cost-detail-modal → showExtraCostDetail()).
//
// ⚠️ Почему раньше было «двойное» отображение: заявка с оплатой фирмой попадала
// на подвкладку ДВАЖДЫ — позиции заявки в блоке «Расходы подотчёта» (их собирает
// cash.js → extraOps) и сама заявка в таблице «Заказы материалов». Теперь закрытая
// заявка показывается один раз — строками в «Работах»/«Материалах», а таблица
// осталась только для заявок, которые ещё НЕ закрыты (в итог вне сметы они не входят).
//
// В план-факт по смете эти суммы НЕ попадают (там план = смета),
// поэтому карточка показывает их отдельной строкой «⚠ Доп. расходы».
// =====================================================================

import { db } from '../database.js';
import { CONFIG } from '../config.js';
import {
    log, escapeHtml, formatMoney, formatDate,
    getOrderStatusBadge,
    showModal, hideModal
} from '../utils.js';
import { canSeeTab } from '../permissions.js';
import { getCategoryLabel, loadExpensesForProject } from './cash.js';
import { loadSectionsWithExtra } from './sections.js';

const EXTRA_SECTION_NAME = CONFIG.EXTRA_SECTION?.NAME || 'Доп. расходы';

// Данные последнего рендера подвкладки: нужны окну подробностей, чтобы найти
// запись по id строки и показать заявку целиком (её позиции и статус).
let extraState = {
    project: null,
    extraSection: null,
    operations: [],
    ordersById: {},
    itemsByOrderId: {}
};

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
 * Всё, что привязано к служебному разделу «Доп. расходы».
 *
 * `operations` — записи вне сметы (они же строки списков «Работы»/«Материалы»):
 * расходы кассы/подотчёта + позиции закрытых заявок с оплатой фирмой.
 * `orders` — заявки раздела (в таблицу «в работе» идут только незакрытые),
 * `orderItems` — их позиции для окна подробностей.
 * Финансовые запросы не грузим вообще: подвкладка показывает только реестр (см. шапку файла).
 *
 * @param {Object} project
 * @returns {Promise<{ extraSection, operations, orders, orderItems, error }>}
 */
async function loadExtraCostsData(project) {
    const { extraSection, estimateSections, error: sectionError } = await loadSectionsWithExtra(project.id);

    if (!extraSection) {
        return { extraSection: null, estimateSections: [], operations: [], orders: [], orderItems: [], error: sectionError };
    }

    const [expensesResult, ordersResult] = await Promise.all([
        loadExpensesForProject(project.id),
        db.select('orders', {
            filters: { section_id: extraSection.id },
            orderBy: { column: 'created_at', asc: false }
        })
    ]);

    if (ordersResult.error) log.warn('Доп. расходы: не удалось загрузить заявки —', ordersResult.error.message);

    const operations = (expensesResult.extraOps || []).slice().sort(byOperationDateDesc);
    const orders = ordersResult.data || [];

    // Позиции заявок этого раздела — их показывает окно подробностей: и по заявке
    // в работе (в extraOps она не попадает), и целиком по закрытой заявке.
    let orderItems = [];
    if (orders.length > 0) {
        const { data: items, error: itemsError } = await db.select('order_items', {
            filters: { 'order_id.in': orders.map(order => order.id) }
        });

        if (itemsError) log.warn('Доп. расходы: не удалось загрузить позиции заявок —', itemsError.message);
        orderItems = items || [];
    }

    // Имена сотрудников — одним запросом на оба списка
    const employeeIds = [...new Set([
        ...operations.map(op => op.employee_id),
        ...orders.map(order => order.created_by_employee_id)
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

    return {
        extraSection,
        estimateSections,
        operations: operations.map(op => ({
            ...op,
            _employee: op._employee || employeeMap[op.employee_id] || null
        })),
        orders,
        orderItems,
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
// РЕНДЕР: СПИСКИ «РАБОТЫ» И «МАТЕРИАЛЫ»
// =====================================================================

// Блоки подвкладки. Показываем «Работы» и «Материалы» всегда, когда есть записи
// вне сметы, — сотрудник сразу видит и то, и другое (пустой блок подсказывает,
// что трат этого вида по объекту нет). «Прочее» появляется только при наличии.
const EXTRA_KINDS = {
    works:     { icon: '🛠', title: 'Работы',    empty: 'Работ вне сметы по объекту пока нет.' },
    materials: { icon: '📦', title: 'Материалы', empty: 'Материалов вне сметы по объекту пока нет.' },
    other:     { icon: '📋', title: 'Прочее',    empty: '' }
};

/**
 * Раскладывает записи вне сметы по блокам подвкладки.
 * Доставка идёт в «Материалы» — так же её считает план-факт (estimate.js → calcFacts)
 * и calcExtraTotals() выше, поэтому суммы блоков совпадают с карточками сводки.
 */
export function splitExtraOperations(operations) {
    const result = { works: [], materials: [], other: [] };

    (operations || []).forEach(op => {
        if (op.category === 'works') result.works.push(op);
        else if (op.category === 'materials' || op.category === 'delivery') result.materials.push(op);
        else result.other.push(op);
    });

    return result;
}

function sumExtraOperations(operations) {
    return (operations || []).reduce((sum, op) => sum + (Number(op.amount) || 0), 0);
}

/**
 * Заголовок строки: у позиции заявки — имя материала/работы, у расхода
 * из отчёта — первая позиция (или описание, если позиций нет).
 */
function extraOperationTitle(op) {
    const items = Array.isArray(op.items) ? op.items : [];

    if (items.length === 1) return items[0].name || op.description || '—';
    if (items.length > 1) return `${items[0].name || '—'} + ещё ${items.length - 1}`;
    return op.description || getCategoryLabel(op.category);
}

/**
 * Номер заявки для записи: у позиции заявки он уже есть в _orderNumber,
 * у расхода из подотчёта заявку ищем по order_id (заявки раздела загружены).
 */
function extraOrderNumber(op) {
    if (op._orderNumber) return op._orderNumber;

    const orderId = op._orderId || op.order_id;
    const order = orderId ? extraState.ordersById[orderId] : null;
    return order ? order.request_number : null;
}

/**
 * Источник записи. Важно: заявка, оплаченная фирмой, — это НЕ расход подотчёта,
 * поэтому подпись строки говорит прямо, откуда пришли деньги.
 */
function extraSourceBadge(op) {
    const orderNumber = extraOrderNumber(op);
    const suffix = orderNumber ? ` ${orderNumber}` : '';

    if (op._source === 'order') {
        return { text: `🏢 заявка${suffix} · оплата фирмой`, cls: 'bg-blue-50 text-blue-700' };
    }
    if (op._source === 'order_employee') {
        return { text: `💵 заявка${suffix} · из подотчёта`, cls: 'bg-amber-100 text-amber-800' };
    }
    return { text: '🧾 расход кассы / подотчёта', cls: 'bg-gray-100 text-gray-600' };
}

/**
 * Строка списка. Клик открывает окно подробностей
 * (window.__openExtraCostDetail → showExtraCostDetail).
 */
function renderExtraOperationRow(op, kind) {
    const source = extraSourceBadge(op);
    const showCategory = kind === 'other' || op.category === 'delivery';
    const categoryChip = showCategory
        ? `<span class="rounded bg-gray-100 px-1.5 py-0.5 font-bold text-gray-600">${escapeHtml(getCategoryLabel(op.category))}</span>`
        : '';

    return `
        <button type="button" data-action="__openExtraCostDetail" data-arg="${escapeHtml(String(op.id))}"
                class="flex w-full items-center justify-between gap-3 rounded-lg border border-amber-100 bg-white p-3 text-left text-xs transition hover:border-amber-300 hover:bg-amber-50/60">
            <div class="min-w-0 flex-1 space-y-1">
                <p class="truncate font-semibold text-gray-800">${escapeHtml(extraOperationTitle(op))}</p>
                <p class="flex flex-wrap items-center gap-1.5 text-[10px] text-gray-500">
                    <span class="rounded px-1.5 py-0.5 font-bold ${source.cls}">${escapeHtml(source.text)}</span>
                    ${categoryChip}
                    <span>👤 ${escapeHtml(op._employee?.name || '—')}</span>
                    <span>📅 ${formatDate(op.operation_date || op.created_at)}</span>
                </p>
            </div>
            <span class="shrink-0 font-bold text-red-700">− ${formatMoney(op.amount || 0)}</span>
        </button>
    `;
}

/**
 * Блок одного вида трат: заголовок со счётчиком и суммой + строки записей.
 * `kind` — ключ EXTRA_KINDS.
 */
function renderExtraKindBlock(kind, operations) {
    const meta = EXTRA_KINDS[kind];
    if (!meta) return '';
    if (!operations.length && !meta.empty) return '';

    const rowsHtml = operations.length
        ? operations.map(op => renderExtraOperationRow(op, kind)).join('')
        : `<p class="rounded-lg border border-dashed bg-gray-50 p-3 text-center text-[11px] italic text-gray-400">${meta.empty}</p>`;

    return `
        <div class="space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <h4 class="text-xs font-bold uppercase tracking-wider text-gray-700">
                    ${meta.icon} ${meta.title} <span class="text-gray-400">(${operations.length})</span>
                </h4>
                <span class="text-xs font-bold text-gray-700">${formatMoney(sumExtraOperations(operations))}</span>
            </div>
            <div class="space-y-1.5">${rowsHtml}</div>
        </div>
    `;
}

// =====================================================================
// РЕНДЕР: ЗАЯВКИ ВНЕ СМЕТЫ В РАБОТЕ
// =====================================================================
// 💰 Блока «Финансовые запросы» на подвкладке нет намеренно: выданные в подотчёт деньги —
// это ещё не трата, а подвкладка показывает только реестр (закрытые заявки материалов и
// расходы из авансового отчёта/кассы). Список самих запросов живёт в разделе «💰 Финансы»,
// а потраченная сумма появится здесь строкой в «Работах» / «Материалах» после отчёта.
// Здесь же важно не показать заявку дважды: закрытые разложены по строкам списков выше.

/**
 * Только НЕзакрытые заявки раздела: закрытые уже разложены строками по блокам
 * «Работы» / «Материалы» выше — второй раз их показывать нельзя (именно из-за
 * этого раньше одна заявка выглядела и расходом подотчёта, и заказом материала).
 */
function renderExtraOrdersBlock(orders) {
    if (!orders || orders.length === 0) return '';

    const total = orders.reduce((sum, order) => sum + (Number(order.total_sum) || 0), 0);

    const rows = orders.map(order => `
        <tr class="cursor-pointer hover:bg-amber-50/60" data-action="__openExtraOrderDetail" data-arg="${order.id}">
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
            <div class="flex flex-wrap items-center justify-between gap-2">
                <h4 class="text-xs font-bold uppercase tracking-wider text-gray-700">
                    ⏳ Заявки вне сметы в работе <span class="text-gray-400">(${orders.length})</span>
                </h4>
                <span class="text-xs font-bold text-gray-700">${formatMoney(total)}</span>
            </div>
            <p class="text-[11px] text-gray-500">
                Эти заявки ещё не закрыты, поэтому в «Итого вне сметы» не входят.
                После закрытия позиции появятся строками в «Работах» и «Материалах».
            </p>
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

    const { extraSection, estimateSections, operations, orders, orderItems, error } = await loadExtraCostsData(project);

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

    // Окно подробностей ищет запись по id строки, поэтому свежие данные
    // подвкладки держим в состоянии модуля (extraState).
    const ordersById = {};
    orders.forEach(order => { ordersById[order.id] = order; });

    const itemsByOrderId = {};
    orderItems.forEach(item => {
        if (!itemsByOrderId[item.order_id]) itemsByOrderId[item.order_id] = [];
        itemsByOrderId[item.order_id].push(item);
    });

    extraState = { project, extraSection, operations, ordersById, itemsByOrderId };

    const totals = calcExtraTotals(operations);
    const planTotal = (estimateSections || []).reduce((sum, section) => sum + (Number(section.plan_total) || 0), 0);
    const sectionName = escapeHtml(extraSection.name);

    const headerHtml = `
        <div class="overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-2 bg-amber-500 px-4 py-3 text-white">
                <h3 class="text-sm font-bold">⚠ ${sectionName} (вне сметы)</h3>
                <button data-action="__renderExtraCostsUI"
                        class="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold transition hover:bg-amber-700">
                    ↻ Обновить
                </button>
            </div>
            <div class="space-y-3 p-4">
                <p class="text-xs text-gray-500">
                    Здесь только то, что уже прошло по реестру: позиции закрытых заявок материалов и расходы
                    из авансового отчёта/кассы, в которых выбран раздел «${sectionName}». Они разложены по спискам
                    «🛠 Работы» и «📦 Материалы» — клик по строке открывает подробности. Заявки, которые ещё
                    в работе, показаны отдельным списком и в итог пока не входят.
                    Финансовых запросов тут нет: выданные в подотчёт деньги — ещё не трата.
                    В «📊 План-факт» эти суммы не входят — там план строго по смете.
                </p>
                ${renderExtraSummary(totals, planTotal)}
            </div>
        </div>
    `;

    const emptyHtml = `
        <div class="rounded-xl border bg-gray-50 p-6 text-center text-xs text-gray-500">
            Пока пусто.
            <br>Чтобы записать незапланированный расход, при оформлении заказа материалов
            или в авансовом отчёте выбери объект, а в поле «Раздел» — группу
            <b class="text-amber-700">⚠ Вне сметы → ${sectionName}</b>.
        </div>
    `;

    // «Работы» и «Материалы» показываем, как только появились записи вне сметы:
    // сотрудник должен видеть оба списка, даже если один из них пуст.
    const split = splitExtraOperations(operations);
    const operationsBlocks = operations.length > 0
        ? [
            renderExtraKindBlock('works', split.works),
            renderExtraKindBlock('materials', split.materials),
            renderExtraKindBlock('other', split.other)
        ]
        : [];

    // В таблицу заявок берём только НЕзакрытые: закрытые уже разложены по строкам
    // списков выше, иначе одна заявка показывалась бы дважды.
    const openOrders = orders.filter(order => order.status === 'new' || order.status === 'in_progress');

    const hasAnything = operations.length > 0 || openOrders.length > 0;

    const blocksHtml = hasAnything
        ? [...operationsBlocks, renderExtraOrdersBlock(openOrders)].filter(Boolean).join('')
        : emptyHtml;

    container.innerHTML = `
        <div class="space-y-4">
            ${headerHtml}
            ${blocksHtml}
        </div>
    `;
}

// =====================================================================
// ОКНО ПОДРОБНОСТЕЙ ЗАПИСИ (клик по строке списка)
// =====================================================================
// Разметка окна — index.html → #extra-cost-detail-modal.
// Содержимое заполняем здесь, поэтому окно одно на все виды записей:
// расход кассы/подотчёта, позиция закрытой заявки и заявка в работе.

function extraDetailItemRow(item) {
    const price = item.price !== undefined ? item.price : item.unit_price;
    const sum = item.sum !== undefined ? item.sum : item.total_price;

    return `
        <div class="flex items-center justify-between gap-2 rounded-lg border bg-white p-2 text-xs">
            <div class="min-w-0 flex-1">
                <p class="truncate font-semibold text-gray-800">${escapeHtml(item.name || '—')}</p>
                <p class="text-[10px] text-gray-500">${item.qty || 0} ${escapeHtml(item.unit || '')}${price ? ` × ${formatMoney(price)}` : ''}</p>
            </div>
            <span class="shrink-0 font-bold text-gray-800">${formatMoney(sum || 0)}</span>
        </div>
    `;
}

function extraDetailInfoRow(label, value) {
    return `<p><strong>${label}:</strong> <span class="font-semibold text-gray-800">${value}</span></p>`;
}

/**
 * Подробности записи вне сметы.
 * Передаётся запись (op), заявка (order) или и то, и другое.
 */
function showExtraCostDetail(op, order) {
    const container = document.getElementById('extra-cost-detail-content');
    const titleEl = document.getElementById('extra-cost-detail-title');

    if (!container) {
        log.warn('Не найден контейнер #extra-cost-detail-content — окно подробностей не открыто');
        return;
    }

    const amount = Number(op ? op.amount : order.total_sum) || 0;
    const categoryLabel = op ? getCategoryLabel(op.category) : '📦 Заказ материалов';
    const source = op
        ? extraSourceBadge(op)
        : { text: '🏢 заявка · оплата фирмой', cls: 'bg-blue-50 text-blue-700' };

    const recordItems = op && Array.isArray(op.items) ? op.items : [];
    const orderItems = order ? (extraState.itemsByOrderId[order.id] || []) : [];

    const infoRows = [
        extraDetailInfoRow('🏗 Объект', escapeHtml(extraState.project?.name || '—')),
        extraDetailInfoRow('📂 Раздел', escapeHtml(extraState.extraSection?.name || EXTRA_SECTION_NAME))
    ];

    if (op) {
        infoRows.push(extraDetailInfoRow('📅 Дата', formatDate(op.operation_date || op.created_at)));
        infoRows.push(extraDetailInfoRow(
            op._source === 'order' ? '👤 Создал заявку' : '👤 Сотрудник',
            escapeHtml(op._employee?.name || '—')
        ));
        if (op.description) infoRows.push(extraDetailInfoRow('📝 Описание', escapeHtml(op.description)));
    }

    if (order) {
        infoRows.push(extraDetailInfoRow('📦 Заявка', escapeHtml(order.request_number || '—')));
        infoRows.push(extraDetailInfoRow('📌 Статус заявки', getOrderStatusBadge(order.status)));
        infoRows.push(extraDetailInfoRow('🏬 Поставщик', escapeHtml(order.supplier || '—')));
        infoRows.push(extraDetailInfoRow('💳 Оплата', order.payment_source === 'employee' ? 'За счёт сотрудника (из подотчёта)' : 'За счёт фирмы'));
        infoRows.push(extraDetailInfoRow('📅 Создана', formatDate(order.created_at)));
        if (order.closed_at) infoRows.push(extraDetailInfoRow('✅ Закрыта', formatDate(order.closed_at)));
        if (order.purchase_notes) infoRows.push(extraDetailInfoRow('📝 Комментарий', escapeHtml(order.purchase_notes)));
    }

    // «Заявка целиком» нужна, если позиций больше одной, либо если окно открыто
    // по самой заявке — тогда записи-расхода ещё нет и позиции иначе не увидеть.
    const showOrderItems = orderItems.length > 0 && (orderItems.length > 1 || !op);
    const orderItemsLabel = op
        ? `📋 Заявка целиком (${orderItems.length}):`
        : `📦 Позиции заявки (${orderItems.length}):`;

    // Позиции самой записи выносим отдельным списком только если у заявки позиций
    // больше одной: иначе этот список и есть «заявка целиком» — дубль на глазах.
    const recordItemsLabel = orderItems.length > 1
        ? `📦 Запись (${recordItems.length}):`
        : `📦 Позиции (${recordItems.length}):`;
    const recordItemsHtml = recordItems.length > 0 ? `
        <div class="space-y-1.5">
            <p class="text-xs font-bold uppercase tracking-wider text-gray-500">${recordItemsLabel}</p>
            ${recordItems.map(extraDetailItemRow).join('')}
        </div>
    ` : '';

    const orderItemsHtml = showOrderItems ? `
        <div class="space-y-1.5">
            <p class="text-xs font-bold uppercase tracking-wider text-gray-500">${orderItemsLabel}</p>
            ${orderItems.map(extraDetailItemRow).join('')}
        </div>
    ` : '';

    const actionsHtml = [];

    if (op && op.receipt_path) {
        actionsHtml.push(`
            <button data-action="viewReceipt" data-arg="${escapeHtml(op.receipt_path)}"
                    class="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 transition hover:bg-blue-100">
                📎 Открыть чек
            </button>
        `);
    }

    if (order && canSeeTab('orders')) {
        actionsHtml.push(`
            <button data-action="__openExtraCostOrder" data-arg="${order.id}"
                    class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100">
                📦 Открыть карточку заявки
            </button>
        `);
    }

    if (titleEl) {
        titleEl.textContent = op ? `⚠ ${EXTRA_SECTION_NAME} — подробности` : '📦 Заявка вне сметы — подробности';
    }

    container.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-bold text-amber-900">${escapeHtml(categoryLabel)}</span>
                <span class="rounded px-1.5 py-0.5 text-[10px] font-bold ${source.cls}">${escapeHtml(source.text)}</span>
            </div>
            <span class="text-base font-bold text-red-700">− ${formatMoney(amount)}</span>
        </div>

        <div class="space-y-2 rounded-lg border bg-gray-50 p-3 text-xs">
            ${infoRows.join('')}
        </div>

        ${recordItemsHtml}
        ${orderItemsHtml}

        ${actionsHtml.length > 0 ? `<div class="flex flex-wrap justify-end gap-2 border-t pt-3">${actionsHtml.join('')}</div>` : ''}
    `;

    showModal('extra-cost-detail-modal');
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

// Кнопка «↻ Обновить» внутри подвкладки: берём текущий объект из карточки
window.__renderExtraCostsUI = () => {
    const project = window.__getCurrentProject?.();
    if (project) renderExtraCostsUI(project);
};

// Клик по строке списка «Работы» / «Материалы» → окно подробностей записи
window.__openExtraCostDetail = (id) => {
    const op = extraState.operations.find(item => String(item.id) === String(id));
    if (!op) return;

    const orderId = op._orderId || op.order_id;
    showExtraCostDetail(op, orderId ? extraState.ordersById[orderId] || null : null);
};

// Клик по строке «Заявки вне сметы в работе» → то же окно, но без записи расхода
window.__openExtraOrderDetail = (orderId) => {
    const order = extraState.ordersById[orderId];
    if (order) showExtraCostDetail(null, order);
};

// Из окна подробностей — переход в карточку заявки (раздел «Заявки»)
window.__openExtraCostOrder = async (orderId) => {
    hideModal('extra-cost-detail-modal');

    if (window.switchTab) window.switchTab('orders');

    try {
        // Импорт динамический: extra-costs не тянет orders при старте приложения
        const { loadOrders, openOrderDetail } = await import('./orders.js');
        await loadOrders();
        openOrderDetail(orderId);
    } catch (e) {
        log.error('Доп. расходы: не удалось открыть заявку —', e?.message || e);
    }
};
