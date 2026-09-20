// =====================================================================
// МОДУЛЬ: ДАШБОРД СОТРУДНИКА
// =====================================================================

import { db } from '../database.js';
import { escapeHtml, formatDate, formatMoney, log, showModal, hideModal, roundMoney, isExtraSectionName } from '../utils.js';
import { can, getEmployee } from '../permissions.js';
// Заявки на финансирование: прораб видит их на своём рабочем экране рядом
// с задачами. loadCashRequests() наполняет кэш модуля, из которого берём
// свои заявки — карточки открываются тем же окном openCashRequestDetail().
import { loadCashRequests, getCashRequestsCache } from './cash-requests.js';
// Заявки на материалы: прораб видит их на рабочем экране — только по своим
// объектам. Подписи статусов берём тем же словарём, что и раздел «Снабжение»
// (getStatusInfo), а карточку открывает общая функция openOrderDetail
// (window.openOrderDetail), в которую добавлен добор заявки из базы по id.
import { getStatusInfo } from './orders.js';

let materialOverrunRowsCache = [];

/**
 * Показываем «Рабочий экран» тем, у кого есть право view_dashboard:
 * Прораб, Инженер ПТО, Администратор, Директор, Главный инженер.
 */
export function shouldShowEmployeeDashboard() {
    return can('view_dashboard');
}

function isActiveProject(project) {
    return !['closed', 'archived', 'completed'].includes(String(project.status || '').toLowerCase());
}

function isOverdueTask(task, today = new Date()) {
    if (!task.deadline || task.status === 'done' || task.status === 'cancelled') return false;
    const deadline = new Date(`${task.deadline}T23:59:59`);
    return !Number.isNaN(deadline.getTime()) && deadline < today;
}

function operationLabel(operation) {
    const labels = {
        issue: 'Выдача подотчёта',
        expense: 'Расход',
        return: 'Возврат',
        adjustment: 'Корректировка'
    };
    return labels[operation.operation_type] || operation.operation_type || 'Операция';
}

function renderMetric(icon, label, value, detail, tone = 'emerald', onClick = null) {
    const tones = {
        emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
        blue: 'border-blue-200 bg-blue-50 text-blue-800',
        amber: 'border-amber-200 bg-amber-50 text-amber-800',
        red: 'border-red-200 bg-red-50 text-red-800'
    };
    const content = `
        <div class="flex min-h-[104px] w-full flex-col justify-between rounded-xl border p-4 text-left ${tones[tone] || tones.emerald}">
            <div class="flex items-start justify-between gap-2">
                <span class="text-2xl" aria-hidden="true">${icon}</span>
                <span class="text-2xl font-bold leading-none">${value}</span>
            </div>
            <div class="mt-3">
                <p class="text-xs font-bold uppercase tracking-wide">${label}</p>
                <p class="mt-1 text-[11px] opacity-75">${detail}</p>
            </div>
        </div>
    `;

    if (!onClick) return content;

    return `
        <button type="button" onclick="${escapeHtml(onClick)}" class="w-full text-left focus:outline-none focus:ring-2 focus:ring-emerald-500/50">
            ${content}
        </button>
    `;
}

function renderOperations(operations, employees) {
    const employeeMap = new Map((employees || []).map(employee => [employee.id, employee.name]));
    if (!operations.length) {
        return '<p class="text-sm text-gray-500">Операций пока нет.</p>';
    }

    return operations.map(operation => {
        const isIncome = operation.operation_type === 'issue' || operation.operation_type === 'adjustment';
        const employeeName = employeeMap.get(operation.employee_id) || 'Сотрудник';
        return `
            <div class="flex items-center justify-between gap-3 border-b border-gray-100 py-3 last:border-0">
                <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-gray-800">${escapeHtml(operationLabel(operation))}</p>
                    <p class="truncate text-xs text-gray-500">${escapeHtml(employeeName)} · ${formatDate(operation.operation_date || operation.created_at)}</p>
                </div>
                <span class="whitespace-nowrap text-sm font-bold ${isIncome ? 'text-emerald-700' : 'text-red-700'}">
                    ${isIncome ? '+' : '-'} ${formatMoney(operation.amount)}
                </span>
            </div>
        `;
    }).join('');
}

function renderForemanTasks(tasks, projects) {
    const projectMap = new Map((projects || []).map(project => [project.id, project.name]));
    const groups = [
        { status: 'pending', title: 'Новые', tone: 'yellow' },
        { status: 'in_progress', title: 'В работе', tone: 'blue' },
        { status: 'done', title: 'Законченные', tone: 'green' }
    ];

    return groups.map(group => {
        const groupTasks = tasks.filter(task => task.status === group.status);
        return `
            <section class="min-w-0 rounded-xl bg-white p-5 shadow-sm">
                <div class="flex items-center justify-between gap-2 border-b pb-3">
                    <h3 class="text-sm font-bold text-gray-800">${group.title}</h3>
                    <span class="rounded-full bg-${group.tone}-100 px-2 py-1 text-xs font-bold text-${group.tone}-800">${groupTasks.length}</span>
                </div>
                <div class="mt-2 space-y-2">
                    ${groupTasks.length ? groupTasks.map(task => `
                        <button onclick="window.openTaskDetail(${task.id})" class="w-full rounded-lg border p-3 text-left transition hover:bg-emerald-50/60">
                            <p class="text-sm font-semibold text-gray-800">${escapeHtml(task.title || task.text || 'Без названия')}</p>
                            <p class="mt-1 text-xs text-gray-500">${escapeHtml(projectMap.get(task.project_id) || 'Объект не указан')}${task.deadline ? ` · Срок: ${formatDate(task.deadline)}` : ''}</p>
                        </button>
                    `).join('') : '<p class="py-3 text-sm text-gray-500">Заданий нет.</p>'}
                </div>
            </section>
        `;
    }).join('');
}

// =====================================================================
// СВОРАЧИВАЕМЫЕ БЛОКИ РАБОЧЕГО ЭКРАНА
// =====================================================================
// Прораб работает с телефона, и когда заявок много, они закрывают задачи.
// Поэтому блоки «Мои заявки на финансирование» и «Мои заявки на материалы»
// можно скрыть кнопкой в заголовке. Прячем ТОЛЬКО содержимое: заголовок с
// цифрой и кнопкой «Показать» остаётся, иначе скрытый блок было бы не вернуть.
// Выбор запоминается в localStorage (в браузере сотрудника), поэтому после
// обновления страницы экран выглядит так, как его оставили.
const DASHBOARD_HIDDEN_KEY = 'rsk.dashboard.hiddenBlocks';

function readHiddenBlocks() {
    try {
        const parsed = JSON.parse(localStorage.getItem(DASHBOARD_HIDDEN_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
        log.warn('Состояние блоков рабочего экрана прочитать не удалось:', err?.message || err);
        return {};
    }
}

function isBlockHidden(blockId) {
    return readHiddenBlocks()[blockId] === true;
}

/** Приводит блок к сохранённому состоянию: содержимое + подпись кнопки. */
function applyBlockState(blockId, hidden) {
    const body = document.getElementById(`dash-block-${blockId}-body`);
    const button = document.getElementById(`dash-block-${blockId}-toggle`);

    if (body) body.classList.toggle('hidden', hidden);
    if (button) {
        button.textContent = hidden ? 'Показать' : 'Скрыть';
        button.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    }
}

/**
 * Свернуть/развернуть блок рабочего экрана. Перерисовка дашборда не нужна:
 * состояние меняется прямо в DOM, а выбор сохраняется для следующего входа.
 */
export function toggleDashboardBlock(blockId) {
    const state = readHiddenBlocks();
    state[blockId] = !state[blockId];

    try {
        localStorage.setItem(DASHBOARD_HIDDEN_KEY, JSON.stringify(state));
    } catch (err) {
        log.warn('Состояние блоков рабочего экрана сохранить не удалось:', err?.message || err);
    }

    applyBlockState(blockId, state[blockId] === true);
}

/**
 * Каркас блока рабочего экрана: заголовок с цифрой, кнопки в заголовке и
 * содержимое, которое можно скрыть. Разметка одна на все блоки — прорабу
 * одинаково понятно, что можно свернуть, а порядок блоков задаёт вызывающий
 * код (задачи → финансы → материалы).
 */
function renderDashboardBlock({ id, title, badge, badgeClass = 'bg-emerald-100 text-emerald-800', actions = '', body }) {
    const hidden = isBlockHidden(id);

    return `
        <section id="dash-block-${id}" class="min-w-0 rounded-xl bg-white p-5 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                <div class="flex flex-wrap items-center gap-2">
                    <h3 class="text-sm font-bold text-gray-800">${title}</h3>
                    <span class="rounded-full px-2 py-1 text-xs font-bold ${badgeClass}">${badge}</span>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    ${actions}
                    <button type="button" id="dash-block-${id}-toggle" aria-expanded="${hidden ? 'false' : 'true'}"
                            onclick="window.toggleDashboardBlock('${id}')"
                            class="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-600 transition hover:bg-gray-100">
                        ${hidden ? 'Показать' : 'Скрыть'}
                    </button>
                </div>
            </div>
            <div id="dash-block-${id}-body" class="mt-2 space-y-2${hidden ? ' hidden' : ''}">
                ${body}
            </div>
        </section>
    `;
}

// =====================================================================
// ФИЛЬТРЫ БЛОКОВ РАБОЧЕГО ЭКРАНА (деньги и материалы)
// =====================================================================
// Заявок со временем становится много, и сотруднику нужны две разные «линзы»:
//   💰 по деньгам — на какой стадии заявка: подана, одобрена, на пересмотре,
//      отклонена, выдана;
//   📦 по материалам — что уже подано в снабжение, а что привезли на объект.
//
// Кнопки-фильтры не ходят в базу: данные последнего рендера лежат в
// переменных модуля ниже, поэтому нажатие перерисовывает ТОЛЬКО содержимое
// блока (#dash-block-<id>-body) — экран не мигает, лишних запросов нет.
// Выбор действует до перезагрузки страницы: у рабочего экрана нет своего
// адреса, а свёрнутость блоков — отдельный случай (DASHBOARD_HIDDEN_KEY выше).
let financeFilter = 'all';
let materialsFilter = 'all';
// Что показано в блоках: заявки на финансирование, заявки на материалы и
// объекты (из них берём названия объектов в карточках материалов)
let blockCashRequests = [];
let blockOrders = [];
let blockProjects = [];

/** Фильтры блока «💰 Мои заявки на финансирование» — по статусу заявки. */
const FINANCE_FILTERS = [
    { id: 'all',      label: '📋 Все' },
    { id: 'pending',  label: '⏳ Поданы' },        // ждут решения директора
    { id: 'approved', label: '🟡 Одобрены' },      // деньги выдаёт финансист
    { id: 'revision', label: '✏️ На пересмотр' },  // директор вернул с причиной
    { id: 'rejected', label: '❌ Отклонены' },     // директор отказал
    { id: 'issued',   label: '🟢 Выданы' }         // деньги уже в подотчёте
];

/** Подпись пустого списка: у каждого фильтра она своя. */
const FINANCE_EMPTY = {
    all: 'Заявок на финансирование нет. Нажмите «➕ Создать заявку», если нужны деньги на работы.',
    pending: 'Заявок на согласовании у директора нет.',
    approved: 'Одобренных заявок нет — выдавать пока нечего.',
    revision: 'Заявок на пересмотре нет.',
    rejected: 'Отклонённых заявок нет.',
    issued: 'Выданных заявок нет.'
};

/** Фильтры блока «📦 Мои заявки на материалы» — по этапу закупки. */
const MATERIAL_FILTERS = [
    { id: 'all',       label: '📋 Все',                  statuses: null },
    { id: 'supply',    label: '📤 Поданы в снабжение',   statuses: ['new', 'in_progress'] },
    { id: 'delivered', label: '🚚 Доставлено на объект', statuses: ['delivered'] }
];

const MATERIAL_EMPTY = {
    all: 'Заявок на материалы нет. Нажмите «📦 Заказать материалы», если материалы нужны на объект.',
    supply: 'Пока ни одна заявка не подана в снабжение.',
    delivered: 'Доставленных на объект заявок нет.'
};

/** Попадает ли заявка на материалы в фильтр (у «Все» статусов нет). */
function matchesMaterialFilter(order, filterId) {
    const filter = MATERIAL_FILTERS.find(item => item.id === filterId) || MATERIAL_FILTERS[0];
    return !filter.statuses || filter.statuses.includes(order.status);
}

/**
 * Кнопки-фильтры одного блока: активная — зелёная, остальные серые (как
 * фильтры разделов приложения). Цифра считается по всем загруженным заявкам,
 * поэтому она не зависит от выбранного фильтра.
 */
function renderBlockFilters(blockId, filters, active, handler) {
    return `
        <div class="flex flex-wrap gap-2 border-b border-gray-100 pb-3">
            ${filters.map(filter => {
                const isActive = filter.id === active;
                const cls = isActive
                    ? 'bg-[#15803d] text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200';

                return `<button type="button" id="${blockId}-filter-${filter.id}"
                                onclick="window.${handler}('${filter.id}')"
                                class="px-3 py-1.5 rounded-lg text-xs font-semibold transition ${cls}">${filter.label} (${filter.count})</button>`;
            }).join('')}
        </div>
    `;
}

// =====================================================================
// МОИ ЗАЯВКИ НА ФИНАНСИРОВАНИЕ (рабочий экран прораба и ПТО)
// =====================================================================
// Заявка, которую директор вернул на доработку, появляется здесь вместе
// с причиной — прораб правит её и отправляет снова. Одобренные заявки тоже
// видны: сотрудник знает, что деньги уже на пути к нему. Отклонённые и
// выданные — история: её показывает свой фильтр (FINANCE_FILTERS выше).

const CASH_REQUEST_BADGES = {
    'revision': { label: '✏️ Требует доработки', cls: 'bg-orange-100 text-orange-800', border: 'border-orange-300' },
    'approved': { label: '🟡 Одобрено — ожидает выдачи', cls: 'bg-yellow-100 text-yellow-800', border: 'border-yellow-300' },
    'pending':  { label: '⏳ На согласовании у директора', cls: 'bg-red-100 text-red-700', border: 'border-gray-200' },
    'issued':   { label: '🟢 Выдано', cls: 'bg-green-100 text-green-700', border: 'border-emerald-200' },
    'rejected': { label: '❌ Отклонено директором', cls: 'bg-red-100 text-red-700', border: 'border-red-200' }
};

/** Порядок вывода: сначала то, что требует внимания сотрудника. */
const CASH_REQUEST_ORDER = ['revision', 'approved', 'pending', 'rejected', 'issued'];

/**
 * Сколько карточек показывает фильтр «Все». Рабочие статусы — целиком,
 * история — хвостом: остальное видно в своём фильтре, там ограничений нет.
 */
const CASH_REQUEST_ALL_LIMITS = { revision: 20, approved: 20, pending: 20, rejected: 5, issued: 5 };

function renderMyCashRequests() {
    const mine = (blockCashRequests || []).filter(Boolean);
    const activeCount = mine.filter(req => ['revision', 'approved', 'pending'].includes(req.status)).length;

    const createBtn = can('cash_expense_self')
        ? `<button type="button" onclick="window.openNewCashRequestForm()"
                   class="shrink-0 rounded-lg bg-[#15803d] px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#166534]">➕ Создать заявку</button>`
        : '';

    return renderDashboardBlock({
        id: 'finance',
        title: '💰 Мои заявки на финансирование',
        badge: activeCount,
        actions: createBtn,
        body: renderMyCashRequestsBody()
    });
}

/** Содержимое блока: фильтры + карточки. Перерисовывается при смене фильтра. */
function renderMyCashRequestsBody() {
    const mine = (blockCashRequests || []).filter(Boolean);
    const visible = financeFilter === 'all' ? mine : mine.filter(req => req.status === financeFilter);

    // «Все» — прежний порядок (сначала то, что требует внимания); в конкретном
    // статусе — как отдаёт база: свежие сверху.
    const groups = financeFilter === 'all'
        ? CASH_REQUEST_ORDER
            .map(status => ({
                status,
                items: visible.filter(req => req.status === status).slice(0, CASH_REQUEST_ALL_LIMITS[status] || 20)
            }))
            .filter(group => group.items.length > 0)
        : [{ status: financeFilter, items: visible }];

    const cards = groups
        .flatMap(group => group.items.map(req => renderMyCashRequestCard(req, group.status)))
        .join('');

    const chips = renderBlockFilters('dash-block-finance', FINANCE_FILTERS.map(filter => ({
        ...filter,
        count: filter.id === 'all' ? mine.length : mine.filter(req => req.status === filter.id).length
    })), financeFilter, 'setMyFinanceFilter');

    return `${chips}
        <div class="space-y-2">
            ${cards || `<p class="py-3 text-sm text-gray-500">${FINANCE_EMPTY[financeFilter] || FINANCE_EMPTY.all}</p>`}
        </div>
    `;
}

/** Карточка заявки: статус, объект, сумма и подсказка, что делать дальше. */
function renderMyCashRequestCard(req, status) {
    const badge = CASH_REQUEST_BADGES[status] || CASH_REQUEST_BADGES.pending;
    const projectName = req.project?.name || '—';
    const approverName = req.approver?.name || '';

    const hint = req.status === 'revision'
        ? (req.rejection_reason
            ? `<p class="mt-2 rounded-lg border border-orange-200 bg-orange-50 p-2 text-[11px] font-semibold text-orange-800">✏️ Причина доработки: ${escapeHtml(req.rejection_reason)}</p>`
            : '<p class="mt-2 text-[11px] text-gray-500">✏️ Директор вернул заявку — исправьте её и отправьте снова.</p>')
        : req.status === 'approved'
            ? `<p class="mt-2 text-[11px] text-gray-500">💰 Одобрил${approverName ? ' ' + escapeHtml(approverName) : ''} — деньги выдаёт финансист.</p>`
            : req.status === 'issued'
                ? '<p class="mt-2 text-[11px] text-gray-500">Деньги зачислены в ваш подотчёт (см. «Авансовый отчёт»).</p>'
                : req.status === 'rejected'
                    ? (req.rejection_reason
                        ? `<p class="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-[11px] font-semibold text-red-700">❌ Причина отказа: ${escapeHtml(req.rejection_reason)}</p>`
                        : '<p class="mt-2 text-[11px] text-gray-500">❌ Директор отклонил заявку — деньги по ней не выдаются.</p>')
                    : '<p class="mt-2 text-[11px] text-gray-500">Ждёт решения директора.</p>';

    const editBtn = req.status === 'revision'
        ? `<div class="mt-2 flex justify-end">
                <button type="button" onclick="window.openCashRequestEdit(${req.id})"
                        class="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-orange-600">
                    ✏️ Исправить и отправить
                </button>
           </div>`
        : '';

    return `
        <div class="rounded-lg border ${badge.border} p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex flex-wrap items-center gap-2">
                    <button type="button" onclick="window.openCashRequestDetail(${req.id})"
                            class="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-mono text-xs font-bold text-[#15803d]">${escapeHtml(req.request_number)}</button>
                    <span class="rounded px-1.5 py-0.5 text-[10px] font-bold ${badge.cls}">${badge.label}</span>
                </div>
                <span class="text-sm font-bold text-[#166534]">${formatMoney(req.total_sum)}</span>
            </div>
            <p class="mt-1 text-[11px] text-gray-500">🏗 ${escapeHtml(projectName)}${req.section?.name ? ' · ' + escapeHtml(req.section.name) : ''}${req.created_at ? ' · 📅 ' + formatDate(req.created_at) : ''}</p>
            ${hint}
            ${editBtn}
        </div>
    `;
}

/**
 * Переключение фильтра блока заявок на финансирование
 * (`window.setMyFinanceFilter`): список пересобирается из уже загруженных
 * данных, поэтому запроса в базу нет.
 */
export function setMyFinanceFilter(filter) {
    financeFilter = FINANCE_FILTERS.some(item => item.id === filter) ? filter : 'all';

    const body = document.getElementById('dash-block-finance-body');
    if (body) body.innerHTML = renderMyCashRequestsBody();
}

// =====================================================================
// МОИ ЗАЯВКИ НА МАТЕРИАЛЫ (рабочий экран прораба)
// =====================================================================
// Показываем только заявки по СВОИМ объектам: фильтр project_id.in уходит в
// базу, поэтому чужая закупка сюда не попадёт. Фильтр «Все» — прежний порядок:
// сначала те, что в работе («🔴 Новая», «🟡 В обработке», «🚚 Доставлено на
// объект»), следом последние пять закрытых и архивных. Фильтры «Поданы в
// снабжение» и «Доставлено на объект» отвечают на два ежедневных вопроса
// прораба: что уже заказано и что привезли (см. MATERIAL_FILTERS выше).
const ORDER_STATUS_ORDER = ['new', 'in_progress', 'delivered', 'closed', 'archived'];
const ORDER_ACTIVE_STATUSES = ['new', 'in_progress', 'delivered'];

function renderMyMaterialOrders() {
    const rows = (blockOrders || []).filter(Boolean);
    const activeOrders = rows.filter(order => ORDER_ACTIVE_STATUSES.includes(order.status));

    const createBtn = can('create_order')
        ? `<button type="button" onclick="window.openNewOrderForm()"
                   class="shrink-0 rounded-lg bg-[#15803d] px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#166534]">📦 Заказать материалы</button>`
        : '';

    return renderDashboardBlock({
        id: 'materials',
        title: '📦 Мои заявки на материалы',
        badge: activeOrders.length,
        actions: createBtn,
        body: renderMyMaterialOrdersBody()
    });
}

/** Содержимое блока: фильтры + карточки. Перерисовывается при смене фильтра. */
function renderMyMaterialOrdersBody() {
    const rows = (blockOrders || []).filter(Boolean);
    const projectMap = new Map((blockProjects || []).map(project => [project.id, project.name]));

    const byStatus = (a, b) => ORDER_STATUS_ORDER.indexOf(a.status) - ORDER_STATUS_ORDER.indexOf(b.status);
    const byDate = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));

    const activeOrders = rows
        .filter(order => ORDER_ACTIVE_STATUSES.includes(order.status))
        .sort((a, b) => byStatus(a, b) || byDate(a, b));
    const archiveOrders = rows
        .filter(order => !ORDER_ACTIVE_STATUSES.includes(order.status))
        .sort(byDate)
        .slice(0, 5);

    // В конкретном фильтре «архивного хвоста» нет: это ответ на вопрос
    // «что ушло в снабжение / что привезли», а не обзор всей истории.
    const matched = materialsFilter === 'supply'
        ? rows.filter(order => matchesMaterialFilter(order, 'supply')).sort((a, b) => byStatus(a, b) || byDate(a, b))
        : rows.filter(order => matchesMaterialFilter(order, materialsFilter)).sort(byDate);

    const shown = materialsFilter === 'all' ? [...activeOrders, ...archiveOrders] : matched;

    const cards = shown.map(order => {
        const status = getStatusInfo(order.status);
        const projectName = order.project?.name || projectMap.get(order.project_id) || 'Объект не указан';
        const sectionName = order.section?.name || '';

        return `
            <div class="rounded-lg border ${status.border} p-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                        <button type="button" onclick="window.openOrderDetail(${order.id})"
                                class="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-mono text-xs font-bold text-[#15803d]">${escapeHtml(order.request_number)}</button>
                        <span class="rounded px-1.5 py-0.5 text-[10px] font-bold ${status.bg} ${status.color}">${status.label}</span>
                    </div>
                    <span class="text-sm font-bold text-[#166534]">${order.total_sum ? formatMoney(order.total_sum) : ''}</span>
                </div>
                <p class="mt-1 text-[11px] text-gray-500">🏗 ${escapeHtml(projectName)}${sectionName ? ' · ' + escapeHtml(sectionName) : ''}${order.supplier ? ' · 🚚 ' + escapeHtml(order.supplier) : ''}${order.created_at ? ' · 📅 ' + formatDate(order.created_at) : ''}</p>
            </div>
        `;
    }).join('');

    const chips = renderBlockFilters('dash-block-materials', MATERIAL_FILTERS.map(filter => ({
        ...filter,
        count: rows.filter(order => matchesMaterialFilter(order, filter.id)).length
    })), materialsFilter, 'setMyMaterialsFilter');

    return `${chips}
        <div class="space-y-2">
            ${cards || `<p class="py-3 text-sm text-gray-500">${MATERIAL_EMPTY[materialsFilter] || MATERIAL_EMPTY.all}</p>`}
        </div>
    `;
}

/**
 * Переключение фильтра блока заявок на материалы
 * (`window.setMyMaterialsFilter`): список пересобирается из уже загруженных
 * данных, поэтому запроса в базу нет.
 */
export function setMyMaterialsFilter(filter) {
    materialsFilter = MATERIAL_FILTERS.some(item => item.id === filter) ? filter : 'all';

    const body = document.getElementById('dash-block-materials-body');
    if (body) body.innerHTML = renderMyMaterialOrdersBody();
}

/**
 * Заявки на материалы по объектам прораба.
 *
 * Колонки берём только те, что есть с прошлых версий: экран должен
 * открываться и до применения database/migrate-v2.4.sql (без payment_status,
 * delivered_at и остальных колонок v2.4.0).
 * Ошибку не пробрасываем: если таблица недоступна, рабочий экран всё равно
 * покажет задачи и заявки на финансирование, а причина останется в консоли.
 */
async function loadForemanOrders(projectIds) {
    const { data, error } = await db.select('orders', {
        select: 'id, request_number, project_id, section_id, status, supplier, total_sum, created_at, section:sections ( id, name )',
        filters: { 'project_id.in': projectIds },
        orderBy: { column: 'created_at', asc: false }
    });

    if (error) {
        log.error('Ошибка загрузки заявок на материалы с рабочего экрана:', error.message);
        return [];
    }

    return data || [];
}

function renderEmployeeBalances(balances, employees) {
    const employeeMap = new Map((employees || []).map(employee => [employee.id, employee]));
    const rows = (balances || []).map(balance => ({
        ...balance,
        employee: employeeMap.get(balance.employee_id)
    })).filter(item => item.employee);

    if (!rows.length) return '<p class="text-sm text-gray-500">Балансов пока нет.</p>';

    return `
        <div class="overflow-x-auto">
            <table class="w-full min-w-[420px] text-sm">
                <thead class="border-b text-left text-[11px] uppercase text-gray-500"><tr><th class="px-2 py-2">Сотрудник</th><th class="px-2 py-2">Должность</th><th class="px-2 py-2 text-right">Баланс</th></tr></thead>
                <tbody class="divide-y">
                    ${rows.map(item => {
                        const value = Number(item.balance) || 0;
                        const tone = value < 0 ? 'text-red-700' : value > 0 ? 'text-emerald-700' : 'text-gray-500';
                        return `<tr><td class="px-2 py-3 font-semibold text-gray-800">${escapeHtml(item.employee.name || '—')}</td><td class="px-2 py-3 text-gray-500">${escapeHtml(item.employee.position || '—')}</td><td class="px-2 py-3 text-right font-bold ${tone}">${formatMoney(value)}</td></tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function renderTaskSummary(tasks) {
    const active = tasks.filter(task => ['pending', 'in_progress'].includes(task.status)).length;
    const overdue = tasks.filter(task => isOverdueTask(task)).length;
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 30);
    const done30 = tasks.filter(task => {
        if (task.status !== 'done' || !task.completed_at) return false;
        const dt = new Date(task.completed_at);
        return !Number.isNaN(dt.getTime()) && dt >= cutoff;
    }).length;

    return `
        <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            ${renderMetric('🟡', 'В работе', active, `${tasks.filter(task => task.status === 'pending').length} новых · ${tasks.filter(task => task.status === 'in_progress').length} в процессе`, 'amber', "openTaskFilterModal('active')")}
            ${renderMetric('🔴', 'Просрочено', overdue, 'дедлайн нарушен', overdue ? 'red' : 'emerald', "openTaskFilterModal('overdue')")}
            ${renderMetric('🟢', 'Выполнено', done30, 'за последние 30 дней', 'emerald', "openTaskFilterModal('done_30')")}
        </div>
        <div class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3 text-xs text-gray-500">
            <span>Всего задач в системе: <strong class="text-gray-800">${tasks.length}</strong></span>
            <button type="button" onclick="openTaskFilterModal('all')" class="font-semibold text-emerald-700 transition hover:text-emerald-900">📋 Все задачи</button>
        </div>
    `;
}

function renderExecutiveDashboard({ employees, balances, tasks, orders, orderItems, cashOperations, projects, sections }) {
    const employeeMap = new Map((employees || []).map(emp => [emp.id, emp]));
    const canCreateTask = can('create_task');

    const totalBalance = roundMoney((balances || []).reduce((sum, item) => sum + (Number(item.balance) || 0), 0));
    const negative = (balances || [])
        .map(item => ({ ...item, employee: employeeMap.get(item.employee_id) }))
        .filter(item => item.employee && (Number(item.balance) || 0) < 0)
        .sort((a, b) => (Number(a.balance) || 0) - (Number(b.balance) || 0))
        .slice(0, 8);
    const positive = (balances || [])
        .map(item => ({ ...item, employee: employeeMap.get(item.employee_id) }))
        .filter(item => item.employee && (Number(item.balance) || 0) > 0)
        .sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0))
        .slice(0, 8);

    const validOrderIds = new Set((orders || []).filter(order => ['delivered', 'closed', 'archived'].includes(order.status)).map(order => order.id));
    const unpaidDebt = (orderItems || [])
        .filter(item => validOrderIds.has(item.order_id) && (item.payment_status || 'paid') === 'debt')
        .reduce((sum, item) => sum + (Number(item.total_price) || 0), 0);
    const unpaidItemsCount = (orderItems || []).filter(item => validOrderIds.has(item.order_id) && (item.payment_status || 'paid') === 'debt').length;

    const unpaidSupplierMap = new Map();
    const orderMap = new Map((orders || []).map(order => [order.id, order]));
    (orderItems || [])
        .filter(item => validOrderIds.has(item.order_id) && (item.payment_status || 'paid') === 'debt')
        .forEach(item => {
            const order = orderMap.get(item.order_id);
            const supplier = order?.supplier || 'Без поставщика';
            const amount = Number(item.total_price) || 0;
            unpaidSupplierMap.set(supplier, (unpaidSupplierMap.get(supplier) || 0) + amount);
        });
    const supplierRows = [...unpaidSupplierMap.entries()]
        .map(([supplier, amount]) => ({ supplier, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8);

    const sectionPlanMap = new Map();
    (sections || []).forEach(section => {
        // Служебный раздел «Доп. расходы» в рейтинг перерасхода по разделам сметы
        // не берём: у него план 0, и он всегда «давал» бы 100% перерасхода.
        // Его траты видно в карточке объекта на подвкладке «📦 Доп. расходы».
        if (isExtraSectionName(section.name)) return;

        sectionPlanMap.set(String(section.id), {
            sectionId: section.id,
            projectId: section.project_id,
            name: section.name || 'Без названия',
            planWorks: Number(section.plan_works) || 0,
            planMaterials: Number(section.plan_materials) || 0
        });
    });

    const sectionFactMap = new Map();
    (cashOperations || []).forEach(operation => {
        if (operation.operation_type !== 'expense' || !operation.section_id) return;
        const category = String(operation.category || '').toLowerCase();
        if (!['materials', 'delivery', 'works'].includes(category)) return;
        const amount = Number(operation.amount) || 0;
        const sectionId = String(operation.section_id);
        const sectionFacts = sectionFactMap.get(sectionId) || { materials: 0, works: 0 };
        if (category === 'works') sectionFacts.works += amount;
        else sectionFacts.materials += amount;
        sectionFactMap.set(sectionId, sectionFacts);
    });

    const closedOrderIds = new Set((orders || [])
        .filter(order => ['delivered', 'closed', 'archived'].includes(order.status) && order.payment_source === 'company')
        .map(order => order.id));
    const orderIdsWithCashOperation = new Set((cashOperations || [])
        .map(operation => operation.order_id ? String(operation.order_id) : null)
        .filter(Boolean));
    const orderSectionMap = new Map((orders || [])
        .filter(order => closedOrderIds.has(order.id) && order.section_id && !orderIdsWithCashOperation.has(order.id))
        .map(order => [String(order.id), String(order.section_id)]));
    (orderItems || []).forEach(item => {
        const sectionId = orderSectionMap.get(String(item.order_id));
        const amount = Number(item.total_price) || 0;
        const sectionFacts = sectionFactMap.get(sectionId) || { materials: 0, works: 0 };
        sectionFacts.materials += amount;
        sectionFactMap.set(sectionId, sectionFacts);
    });

    const projectMap = new Map((projects || []).map(project => [String(project.id), project]));
    const projectRows = [...sectionPlanMap.entries()]
        .map(([sectionId, section]) => {
            const facts = sectionFactMap.get(sectionId) || { materials: 0, works: 0 };
            const totalPlan = section.planMaterials + section.planWorks;
            const totalFact = facts.materials + facts.works;
            const overrun = totalFact - totalPlan;
            const percent = totalPlan > 0 ? (overrun / totalPlan) * 100 : (overrun > 0 ? 100 : 0);
            return {
                sectionId,
                hasSectionOverrun: overrun > 0,
                project: projectMap.get(String(section.projectId)),
                sectionName: section.name,
                materialsPlan: section.planMaterials,
                materialsFact: facts.materials,
                worksPlan: section.planWorks,
                worksFact: facts.works,
                totalPlan,
                totalFact,
                overrun,
                percent
            };
        })
        .filter(row => row.project)
        .filter(row => row.hasSectionOverrun)
        .map(row => ({ ...row, ...row.project }))
        .sort((a, b) => b.percent - a.percent);
    materialOverrunRowsCache = projectRows;

    const negativeList = negative.length
        ? negative.map(item => `
            <div class="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs">
                <span class="font-medium text-red-700">${escapeHtml(item.employee?.name || '—')}</span>
                <span class="font-bold text-red-800">${formatMoney(Number(item.balance) || 0)}</span>
            </div>
        `).join('')
        : '<p class="text-sm text-gray-500">Нет должников.</p>';

    const positiveList = positive.length
        ? positive.map(item => `
            <div class="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs">
                <span class="font-medium text-emerald-700">${escapeHtml(item.employee?.name || '—')}</span>
                <span class="font-bold text-emerald-800">${formatMoney(Number(item.balance) || 0)}</span>
            </div>
        `).join('')
        : '<p class="text-sm text-gray-500">Нет крупных остатков.</p>';

    const overrunRows = projectRows.slice(0, 12).map((row, index) => {
        return `
            <tr onclick="openMaterialOverrunDetail(${index})" class="cursor-pointer transition hover:bg-emerald-50/60">
                <td class="px-2 py-3 text-left text-sm font-semibold text-gray-800">${escapeHtml(row.name || '—')}</td>
                <td class="px-2 py-3 text-left text-sm text-gray-700">${escapeHtml(row.sectionName || '—')}</td>
                <td class="px-2 py-3 text-right text-sm font-bold text-red-600">+${Math.round(row.percent || 0)}%</td>
            </tr>
        `;
    }).join('') || '<tr><td colspan="3" class="px-2 py-5 text-center text-sm text-emerald-700">✅ Перерасхода материалов ни на одном объекте нет</td></tr>';
    const totalOverrun = projectRows.reduce((sum, row) => sum + row.overrun, 0);

    const supplierDebtRows = supplierRows.length
        ? supplierRows.map((row, index) => `
            <tr>
                <td class="px-2 py-3 text-left text-sm font-semibold text-gray-800">${index + 1}. ${escapeHtml(row.supplier)}</td>
                <td class="px-2 py-3 text-right text-sm font-bold text-red-600">${formatMoney(row.amount)}</td>
            </tr>
        `).join('')
        : '<tr><td colspan="2" class="px-2 py-4 text-center text-sm text-gray-500">Нет задолженности.</td></tr>';

    return `
        <div class="w-full min-w-0 space-y-4">
            <div class="flex min-w-0 flex-wrap items-end justify-between gap-3 rounded-xl bg-white px-4 py-4 shadow-sm sm:px-5">
                <div>
                    <p class="text-xs font-semibold uppercase tracking-widest text-emerald-700">Дашборд руководителя</p>
                    <h2 class="mt-1 text-2xl font-bold text-gray-800">Компания в целом</h2>
                    <p class="mt-1 text-sm text-gray-500">Финансы, задачи, задолженности</p>
                </div>
                <button onclick="loadDashboard()" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-emerald-800">↻ Обновить</button>
            </div>

            <div class="flex min-w-0 flex-col gap-3">
                <details open class="min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm">
                    <summary class="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 font-bold text-gray-800 [&::-webkit-details-marker]:hidden">
                        <span>💰 Баланс сотрудников</span>
                        <span class="text-xs font-normal text-gray-400">общий остаток ·⌄</span>
                    </summary>
                    <div class="border-t border-gray-200 p-5">
                    <div class="mt-4 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-3">
                        ${renderMetric('💵', 'Общий баланс', formatMoney(totalBalance), 'все сотрудники', totalBalance >= 0 ? 'emerald' : 'amber')}
                        ${renderMetric('📉', 'С отрицательным балансом', negative.length, 'сотрудники с отрицательным балансом', 'red')}
                        ${renderMetric('📈', 'С большим остатком', positive.length, 'сотрудники с положительным балансом', 'blue')}
                    </div>
                    <div class="mt-4 grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
                        <div>
                            <p class="mb-2 text-[11px] font-bold uppercase tracking-wide text-red-600">Сотрудники с отрицательным балансом</p>
                            <div class="space-y-2">${negativeList}</div>
                        </div>
                        <div>
                            <p class="mb-2 text-[11px] font-bold uppercase tracking-wide text-emerald-600">Сотрудники с большим положительным балансом</p>
                            <div class="space-y-2">${positiveList}</div>
                        </div>
                    </div>
                    </div>
                </details>

                <details open class="min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm">
                    <summary class="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 font-bold text-gray-800 [&::-webkit-details-marker]:hidden">
                        <span class="min-w-0">
                            <span>📋 Задачи</span>
                            <span class="ml-2 text-xs font-normal text-gray-400">по плану ·⌄</span>
                        </span>
                    </summary>
                    <div class="border-t border-gray-200 p-5">
                        ${canCreateTask ? `
                            <div class="mb-3 flex justify-end">
                                <button type="button" onclick="window.openNewTaskForm()"
                                        class="shrink-0 rounded-lg bg-[#15803d] px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#166534]">
                                    ➕ Поставить задачу
                                </button>
                            </div>
                        ` : ''}
                        <div>${renderTaskSummary(tasks)}</div>
                    </div>
                </details>

                <details class="min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm">
                    <summary class="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 font-bold text-gray-800 [&::-webkit-details-marker]:hidden">
                        <span>💳 Задолженность по материалам</span>
                        <span class="text-xs font-normal text-gray-400">неоплаченные позиции ·⌄</span>
                    </summary>
                    <div class="border-t border-gray-200 p-5">
                    <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                    ${renderMetric('💸', 'Сумма задолженности', formatMoney(unpaidDebt), 'закрытые заявки', unpaidDebt > 0 ? 'amber' : 'emerald')}
                    ${renderMetric('📦', 'Позиции ожидают оплаты', unpaidItemsCount, 'неоплаченные позиции', unpaidItemsCount > 0 ? 'red' : 'emerald')}
                </div>
                <div class="mt-4">
                    <p class="mb-2 text-[11px] font-bold uppercase tracking-wide text-gray-500">Рейтинг не оплаченных материалов по поставщикам</p>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead class="border-b text-left text-[11px] uppercase text-gray-500">
                                <tr><th class="px-2 py-2">Поставщик</th><th class="px-2 py-2 text-right">Сумма</th></tr>
                            </thead>
                            <tbody class="divide-y">${supplierDebtRows}</tbody>
                        </table>
                    </div>
                </div>
                    </div>
                </details>

                <details class="min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm">
                    <summary class="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 font-bold text-gray-800 [&::-webkit-details-marker]:hidden">
                        <span>📊 Рейтинг объектов по перерасходу материалов</span>
                        <span class="text-xs font-normal text-gray-400">сверху — больше перерасход ·⌄</span>
                    </summary>
                    <div class="border-t border-gray-200 p-5">
                <div class="overflow-x-auto">
                    <table class="w-full min-w-[520px] text-sm">
                        <thead class="border-b text-left text-[11px] uppercase text-gray-500">
                            <tr>
                                <th class="px-2 py-2">Объект</th>
                                <th class="px-2 py-2">Раздел</th>
                                <th class="px-2 py-2 text-right">Перерасход, %</th>
                            </tr>
                        </thead>
                        <tbody class="${projectRows.length ? 'divide-y' : 'bg-emerald-50'}">${overrunRows}</tbody>
                    </table>
                </div>
                ${projectRows.length ? `<p class="mt-3 border-t border-gray-100 pt-3 text-xs text-gray-500">Всего: <strong class="text-gray-800">${new Set(projectRows.map(row => row.id)).size} объектов</strong> · Общий перерасход: <strong class="text-red-600">+${formatMoney(totalOverrun)}</strong></p>` : ''}
                    </div>
                </details>
            </div>
        </div>
    `;
}

export function openMaterialOverrunDetail(index) {
    const row = materialOverrunRowsCache[index];
    if (!row) return;

    const materialOverrun = row.materialsFact - row.materialsPlan;
    const worksOverrun = row.worksFact - row.worksPlan;
    const totalOverrun = row.totalFact - row.totalPlan;
    const title = document.getElementById('material-overrun-title');
    const content = document.getElementById('material-overrun-content');
    const projectButton = document.getElementById('material-overrun-project-button');
    if (!title || !content || !projectButton) return;

    title.textContent = `🏗 ${row.name || 'Объект'} — ${row.sectionName || 'Раздел'}`;
    content.innerHTML = `
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <h4 class="font-bold text-amber-900">📦 Материалы</h4>
                <div class="mt-3 space-y-2 text-sm">
                    <p class="flex justify-between gap-3"><span>План:</span><strong>${formatMoney(row.materialsPlan)}</strong></p>
                    <p class="flex justify-between gap-3"><span>Факт:</span><strong>${formatMoney(row.materialsFact)}</strong></p>
                    <p class="flex justify-between gap-3 border-t border-amber-200 pt-2"><span>Перерасход:</span><strong class="text-red-600">${materialOverrun >= 0 ? '+' : ''}${formatMoney(materialOverrun)}</strong></p>
                </div>
            </div>
            <div class="rounded-xl border border-blue-200 bg-blue-50 p-4">
                <h4 class="font-bold text-blue-900">🛠 Работы</h4>
                <div class="mt-3 space-y-2 text-sm">
                    <p class="flex justify-between gap-3"><span>План:</span><strong>${formatMoney(row.worksPlan)}</strong></p>
                    <p class="flex justify-between gap-3"><span>Факт:</span><strong>${formatMoney(row.worksFact)}</strong></p>
                    <p class="flex justify-between gap-3 border-t border-blue-200 pt-2"><span>Перерасход:</span><strong class="${worksOverrun > 0 ? 'text-red-600' : 'text-emerald-700'}">${worksOverrun >= 0 ? '+' : ''}${formatMoney(worksOverrun)}</strong></p>
                </div>
            </div>
        </div>
    `;
    projectButton.onclick = () => {
        const projectId = row.project?.id || row.id;
        if (!projectId || typeof window.openProjectDetail !== 'function') {
            log.error('Не удалось открыть объект из рейтинга:', { projectId, row });
            return;
        }

        hideModal('material-overrun-modal');
        window.openProjectDetail(projectId);
    };
    showModal('material-overrun-modal');
}

export async function loadDashboard() {
    const container = document.getElementById('dashboard-content');
    if (!container) return;

    container.innerHTML = '<div class="app-loading app-loading-card text-sm"><span class="app-spinner" aria-hidden="true"></span><span>Загрузка показателей...</span></div>';

    const employee = getEmployee();
        const isForeman = employee?.position === 'Прораб';

        if (isForeman) {
            const [tasksResult, projectsResult] = await Promise.all([
                db.select('tasks', {
                    filters: { assignee_employee_id: employee.id },
                    orderBy: { column: 'created_at', asc: false }
                }),
                db.select('projects', { select: 'id, name, foreman_id', filters: { foreman_id: employee.id } }),
                // Заявки на финансирование наполняют кэш модуля cash-requests:
                // из него же открываются карточки заявок (openCashRequestDetail)
                loadCashRequests()
            ]);

            const projects = projectsResult.data || [];
            const projectIds = new Set(projects.map(project => project.id));
            const foremanTasks = (tasksResult.data || []).filter(task => projectIds.has(task.project_id));
            const myCashRequests = getCashRequestsCache().filter(req => req.employee_id === employee.id);

            // Заявки на материалы — только по объектам прораба: фильтр уходит в
            // базу (project_id.in), поэтому чужие закупки сюда не попадут.
            const myOrders = projectIds.size
                ? await loadForemanOrders([...projectIds])
                : [];

            // Данные последнего рендера: из них работают фильтры блоков
            // (window.setMyFinanceFilter / window.setMyMaterialsFilter) —
            // список пересобирается без нового запроса в базу.
            blockCashRequests = myCashRequests;
            blockOrders = myOrders;
            blockProjects = projects;

            container.innerHTML = `
                <div class="w-full min-w-0 space-y-4">
                    <div class="flex min-w-0 flex-wrap items-end justify-between gap-3 rounded-xl bg-white px-4 py-4 shadow-sm sm:px-5">
                        <div>
                            <p class="text-xs font-semibold uppercase tracking-widest text-emerald-700">Рабочий экран</p>
                            <h2 class="mt-1 text-2xl font-bold text-gray-800">Задания от руководства</h2>
                            <p class="mt-1 text-sm text-gray-500">Только ваши задачи и заявки по объектам, где вы ответственный</p>
                        </div>
                        <button onclick="loadDashboard()" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-emerald-800">↻ Обновить</button>
                    </div>

                    <!-- ПОРЯДОК БЛОКОВ РАБОЧЕГО ЭКРАНА: 1) задачи, 2) заявки на
                         финансирование, 3) заявки на материалы. Второй и третий
                         сворачиваются кнопкой в заголовке («Скрыть»), выбор
                         запоминается в localStorage: см. toggleDashboardBlock(). -->
                    <div class="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
                        ${renderForemanTasks(foremanTasks, projects)}
                    </div>
                    ${renderMyCashRequests()}
                    ${renderMyMaterialOrders()}
                </div>
            `;
            return;
        }

    const isExecutive = ['Администратор', 'Директор', 'Главный инженер'].includes(employee?.position);

    if (isExecutive) {
        const [projectsResult, sectionsResult, cashOperationsResult, balancesResult, tasksResult, ordersResult, employeesResult, orderItemsResult] = await Promise.all([
            db.select('projects', { select: 'id, name, foreman_id' }),
            db.select('sections', { select: 'id, project_id, name, plan_works, plan_materials' }),
            db.select('cash_operations', {
                select: 'id, order_id, project_id, section_id, operation_type, category, amount, created_at',
                orderBy: { column: 'created_at', asc: false }
            }),
            db.select('employee_cash_balance', { select: 'employee_id, balance' }),
            db.select('tasks', { select: 'id, title, project_id, status, deadline, completed_at, created_at' }),
            db.select('orders', { select: 'id, status, project_id, section_id, payment_source, request_number, supplier, created_at' }),
            db.select('employees', { select: 'id, name, position, status' }),
            db.select('order_items', { select: 'id, order_id, total_price, payment_status' })
        ]);

        const failedResult = [
            projectsResult,
            sectionsResult,
            cashOperationsResult,
            balancesResult,
            tasksResult,
            ordersResult,
            employeesResult,
            orderItemsResult
        ].find(result => result.error);
        if (failedResult) {
            log.error('Ошибка загрузки данных дашборда:', failedResult.error.message);
            container.innerHTML = '<div class="app-loading app-loading-card text-sm text-red-600"><span>Не удалось загрузить данные дашборда.</span></div>';
            return;
        }

        const projects = projectsResult.data || [];
        const sections = sectionsResult.data || [];
        const cashOperations = cashOperationsResult.data || [];
        const balances = balancesResult.data || [];
        const tasks = tasksResult.data || [];
        const orders = ordersResult.data || [];
        const employees = employeesResult.data || [];
        const orderItems = orderItemsResult.data || [];

        container.innerHTML = renderExecutiveDashboard({
            employees,
            balances,
            tasks,
            orders,
            orderItems,
            cashOperations,
            projects,
            sections
        });
        return;
    }

    const [projectsResult, sectionsResult, expensesResult, balancesResult, tasksResult, ordersResult, operationsResult, employeesResult] = await Promise.all([
        db.select('projects', { select: 'id, name, foreman_id' }),
        db.select('sections', { select: 'id, project_id, plan_total' }),
        db.select('cash_operations', { filters: { operation_type: 'expense' } }),
        db.select('employee_cash_balance', { select: 'employee_id, balance' }),
        db.select('tasks', { select: 'id, title, project_id, status, deadline, created_at' }),
        db.select('orders', { select: 'id, project_id, request_number, status, created_at' }),
        db.select('cash_operations', { select: 'id, employee_id, project_id, operation_type, amount, operation_date, created_at', orderBy: { column: 'created_at', asc: false }, limit: 20 }),
        db.select('employees', { select: 'id, name, position' }),
        // Свои заявки на финансирование — блок на рабочем экране (кэш модуля)
        loadCashRequests()
    ]);

    const allProjects = projectsResult.data || [];
    const visibleProjectIds = isForeman
        ? new Set(allProjects.filter(project => project.foreman_id === employee.id).map(project => project.id))
        : null;
    const isVisibleProjectData = item => !visibleProjectIds || visibleProjectIds.has(item.project_id);

    const projects = visibleProjectIds
        ? allProjects.filter(project => visibleProjectIds.has(project.id))
        : allProjects;
    const sections = (sectionsResult.data || []).filter(isVisibleProjectData);
    const expenses = (expensesResult.data || []).filter(isVisibleProjectData);
    const balances = (balancesResult.data || []).filter(item => !isForeman || item.employee_id === employee.id);
    const tasks = (tasksResult.data || []).filter(isVisibleProjectData);
    const orders = (ordersResult.data || []).filter(isVisibleProjectData);
    const operations = (operationsResult.data || []).filter(isVisibleProjectData).slice(0, 6);
    const employees = employeesResult.data || [];

    const plan = sections.reduce((sum, section) => sum + (Number(section.plan_total) || 0), 0);
    const fact = expenses.reduce((sum, operation) => sum + (Number(operation.amount) || 0), 0);
    const debt = balances.reduce((sum, item) => sum + Math.max(0, -(Number(item.balance) || 0)), 0);
    const overdueTasks = tasks.filter(isOverdueTask);
    const activeOrders = orders.filter(order => order.status === 'new' || order.status === 'in_progress');
    const activeProjects = projects.filter(isActiveProject);
    const scopeLabel = isForeman ? 'по вашим объектам' : 'по компании';

    // Свои заявки на финансирование — блок на рабочем экране. Список кладём
    // в переменную модуля: из неё же фильтр блока собирает список после
    // нажатия кнопки (window.setMyFinanceFilter), без запроса в базу.
    blockCashRequests = getCashRequestsCache().filter(req => req.employee_id === employee.id);

    container.innerHTML = `
        <div class="w-full min-w-0 space-y-4">
            <div class="flex min-w-0 flex-wrap items-end justify-between gap-3 rounded-xl bg-white px-4 py-4 shadow-sm sm:px-5">
                <div>
                    <p class="text-xs font-semibold uppercase tracking-widest text-emerald-700">Рабочий обзор</p>
                    <h2 class="mt-1 text-2xl font-bold text-gray-800">Добрый день, ${escapeHtml(employee?.name || 'коллега')}</h2>
                    <p class="mt-1 text-sm text-gray-500">Ключевые показатели ${scopeLabel} на ${formatDate(new Date())}</p>
                </div>
                <button onclick="loadDashboard()" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-emerald-800">↻ Обновить</button>
            </div>

            <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                ${renderMetric('🏗', 'Объекты', activeProjects.length, `Всего: ${projects.length}`, 'emerald')}
                ${renderMetric('📊', 'План vs факт', formatMoney(fact), `План: ${formatMoney(plan)}`, fact > plan ? 'red' : 'blue')}
                ${renderMetric('💰', 'Задолженность', formatMoney(debt), isForeman ? 'Ваш подотчёт' : 'По подотчётам сотрудников', debt > 0 ? 'amber' : 'emerald')}
                ${renderMetric('⏰', 'Просроченные задачи', overdueTasks.length, `Всего задач: ${tasks.length}`, overdueTasks.length ? 'red' : 'emerald')}
            </div>

            ${renderMyCashRequests()}

            <div class="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
                <div class="min-w-0 rounded-xl bg-white p-5 shadow-sm lg:col-span-1">
                    <div class="flex items-center justify-between gap-2 border-b pb-3">
                        <h3 class="text-sm font-bold text-gray-800">💰 Баланс сотрудников</h3>
                        <span class="text-xs text-gray-400">получено − потрачено</span>
                    </div>
                    <div class="mt-2">${renderEmployeeBalances(balances, employees)}</div>
                </div>

                <div class="min-w-0 rounded-xl bg-white p-5 shadow-sm lg:col-span-2">
                    <div class="flex items-center justify-between gap-2 border-b pb-3">
                        <h3 class="text-sm font-bold text-gray-800">💳 Последние операции</h3>
                        <span class="text-xs text-gray-400">6 последних</span>
                    </div>
                    <div>${renderOperations(operations, employees)}</div>
                </div>
            </div>
        </div>
    `;
}

window.loadDashboard = loadDashboard;
window.toggleDashboardBlock = toggleDashboardBlock;
window.openMaterialOverrunDetail = openMaterialOverrunDetail;
// Фильтры блоков рабочего экрана: «💰 Мои заявки на финансирование»
// (все / поданы / одобрены / на пересмотр / отклонены / выданы) и
// «📦 Мои заявки на материалы» (все / поданы в снабжение / доставлено).
window.setMyFinanceFilter = setMyFinanceFilter;
window.setMyMaterialsFilter = setMyMaterialsFilter;
