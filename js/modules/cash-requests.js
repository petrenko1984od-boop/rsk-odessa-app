// =====================================================================
// МОДУЛЬ: ЗАЯВКИ ФИНАНСОВ (на выполнение работ)
// =====================================================================
// Прораб создаёт заявку → директор согласует → финансист выдаёт деньги.
//
// Статусы:
//   pending   — 🔴 Ожидает        (ждёт решения директора)
//   approved  — 🟡 Одобрено       (директор согласовал, ждёт выдачи)
//   revision  — ✏️ На доработке    (директор вернул автору с причиной)
//   rejected  — ❌ Отклонено       (директор отказал, причина обязательна)
//   issued    — 🟢 Выдано         (деньги выданы, подотчёт получателя пополнен)
//
// Причина возврата и причина отказа хранятся в одной колонке
// rejection_reason: смысл однозначен по статусу заявки, а новой колонки
// и миграции базы не требуется. При повторной отправке причина стирается.
//
// Права:
//   - Создание: ВСЕ (у кого есть cash_expense_self)
//   - Просмотр: кассиры — все; финансист — одобренные и выданные;
//               остальные — только свои
//   - Согласование (одобрить / на доработку / отклонить): process_cash_request
//     (Админ, Директор, Гл. инженер)
//   - Выдача «Выдано»: Финансист (issue_cash_request) и кассиры
//     (Администратор, Главный инженер). ДИРЕКТОР денег не выдаёт: он только
//     согласует и передаёт заявку на выдачу — см. canIssueCashRequest().
//     У финансиста сумма списывается с ЕГО подотчёта.
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    formatDate, formatMoney, parseNumber, roundMoney
} from '../utils.js';
import { can, getEmployee, getRole, canSeeTab, canSeeHeaderButton } from '../permissions.js';
import { t } from '../i18n.js';
import { loadBalance, formatBalance, renderFinancierBalanceHint } from './cash.js';
import { renderMaterialInvoices } from './invoices.js';
import { fillSectionsSelect } from './sections.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let cashRequestsCache = [];
let currentFilter = 'active';   // 'active' | 'pending' | 'revision' | 'approved' | 'issued' | 'rejected' | 'all'
let currentRequestId = null;
// id заявки, которую автор дорабатывает в форме (null — создаётся новая)
let editingRequestId = null;

// =====================================================================
// ПРАВА
// =====================================================================

/**
 * Может ли текущий пользователь СОГЛАСОВЫВАТЬ заявки
 * (одобрить / вернуть на доработку / отклонить)?
 */
function canProcessCashRequest() {
    return can('process_cash_request');
}

/**
 * Может ли текущий пользователь выдавать деньги по одобренной заявке.
 *
 * Выдаёт деньги ФИНАНСИСТ (право issue_cash_request): он единственный, с чьего
 * подотчёта уходит сумма по заявке. ДИРЕКТОР заявки только согласует:
 * одобрил — и заявка ушла в работу финансисту. Кнопки «💵 Выдать» у директора
 * нет по бизнес-правилу (одобряет и выдаёт не один человек).
 * Администратор и Главный инженер сохраняют прежнюю возможность — у них есть
 * process_cash_request, они работают как касса.
 *
 * Проверка стоит и в интерфейсе (кнопка), и внутри issueCashRequest(),
 * поэтому выдать деньги из консоли браузера тоже не получится.
 */
function canIssueCashRequest() {
    if (getRole() === 'Директор') return false;
    return can('issue_cash_request') || can('process_cash_request');
}

/** Финансист платит из своего подотчёта, остальные выдают деньги фирмы. */
function isFinancier() {
    return getRole() === 'Финансист';
}

/**
 * Видит ли текущий пользователь эту заявку?
 * Кассиры — все. Финансист — только одобренные и выданные (его рабочий стол).
 * Остальные — только свои.
 */
function canSeeCashRequest(req) {
    const emp = getEmployee();
    if (!emp) return false;

    if (isFinancier()) {
        return req.status === 'approved' || req.status === 'issued';
    }

    if (canProcessCashRequest()) return true;
    return req.employee_id === emp.id;
}

/**
 * Может ли текущий пользователь доработать эту заявку
 * (она его и директор вернул её с причиной)?
 */
function canEditCashRequest(req) {
    const emp = getEmployee();
    return !!emp && req.employee_id === emp.id && req.status === 'revision';
}

/**
 * Видна ли кнопка создания своей заявки на подотчёт (по id элемента).
 * Урезанный интерфейс роли может её спрятать: директор только согласует
 * и выдаёт деньги, свои заявки он не оформляет (ROLE_UI в permissions.js).
 */
function canSeeCreateCashRequestButton(buttonId) {
    return can('cash_expense_self') && canSeeHeaderButton(buttonId);
}

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

export async function loadCashRequests() {
    log.info('Загрузка заявок финансов...');

    // Кнопку создания обновляем до запроса — иначе при ошибке загрузки
    // она осталась бы видимой у роли, которой её не видно
    updateCreateCashRequestButton();

    const { data, error } = await db.select('cash_requests', {
        select: `
            *,
            project:projects ( id, name ),
            section:sections ( id, name ),
            employee:employees!cash_requests_employee_id_fkey ( id, name, position ),
            approver:employees!cash_requests_approved_by_employee_id_fkey ( id, name )
        `,
        orderBy: { column: 'created_at', asc: false }
    });

    if (error) {
        log.error('Ошибка загрузки заявок финансов:', error.message);
        toast('Не удалось загрузить заявки', 'error');
        return;
    }

    // Фильтруем по правам
    const all = data || [];
    cashRequestsCache = all.filter(canSeeCashRequest);

    // Догружаем позиции одним запросом
    if (cashRequestsCache.length > 0) {
        const requestIds = cashRequestsCache.map(r => r.id);
        const { data: items } = await db.select('cash_request_items');

        const itemsMap = {};
        (items || []).forEach(it => {
            if (!requestIds.includes(it.request_id)) return;
            if (!itemsMap[it.request_id]) itemsMap[it.request_id] = [];
            itemsMap[it.request_id].push(it);
        });

        cashRequestsCache.forEach(r => {
            r._items = itemsMap[r.id] || [];
        });
    }

    log.info(`Загружено заявок финансов: ${cashRequestsCache.length}`);
    renderCashRequests();
    updateCashRequestsNavButton();
    await renderFinancierPanel();

    // Баланс финансиста рядом с кнопкой пополнения (директор и другие кассиры):
    // цифра тянется тем же открытием раздела, поэтому всегда свежая.
    await renderFinancierBalanceHint();

    // Счета на материалы — очередь оплаты финансиста (директор видит её тоже)
    await renderMaterialInvoices();
}

/**
 * Заявки, видимые текущему пользователю (кэш модуля).
 * Нужен дашборду прораба: там карточки открываются тем же окном
 * openCashRequestDetail(), которое ищет заявку в этом кэше.
 */
export function getCashRequestsCache() {
    return cashRequestsCache;
}

/**
 * Перерисовывает рабочий экран, если он открыт. Прораб создаёт и дорабатывает
 * заявки прямо с дашборда, поэтому после сохранения блок «Мои заявки на
 * финансирование» не должен показывать старый статус.
 * Дашборд не трогаем, когда открыт другой раздел (иначе лишний запрос).
 */
async function refreshDashboardIfVisible() {
    if (window.AppState?.currentTab !== 'tasks') return;
    if (typeof window.loadDashboard !== 'function') return;

    try {
        await window.loadDashboard();
    } catch (err) {
        log.warn('Не удалось обновить рабочий экран:', err?.message || err);
    }
}

/**
 * Панель «Рабочий стол финансиста»: его баланс (подотчёт) и сколько денег
 * нужно выдать по одобренным заявкам. У остальных ролей блок скрыт:
 * у директора на этом же месте — баланс финансиста рядом с кнопкой пополнения
 * (`renderFinancierBalanceHint()` из js/modules/cash.js).
 */
async function renderFinancierPanel() {
    const panel = document.getElementById('financier-balance-panel');
    if (!panel) return;

    if (!isFinancier()) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
    }

    // У финансиста раздел заявок — это его рабочий стол, поэтому заголовок свой
    const title = document.getElementById('cashreq-tab-title');
    const subtitle = document.getElementById('cashreq-tab-subtitle');
    if (title) title.textContent = '💼 Рабочий стол финансиста';
    if (subtitle) subtitle.textContent = 'Одобренные директором заявки: выдать деньги и отметить «Выдано»';

    const emp = getEmployee();
    const { balance } = emp ? await loadBalance(emp.id) : { balance: 0 };
    const formatted = formatBalance(balance);

    const approved = cashRequestsCache.filter(r => r.status === 'approved');
    const toIssue = roundMoney(approved.reduce((sum, r) => sum + (Number(r.total_sum) || 0), 0));

    panel.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <div>
                <p class="text-xs font-bold uppercase tracking-wide text-emerald-700">💰 Мой баланс</p>
                <p class="${formatted.color} text-2xl font-bold">${formatted.icon} ${formatted.text}</p>
            </div>
            <div class="text-right">
                <p class="text-xs font-bold uppercase tracking-wide text-emerald-700">🟡 К выдаче</p>
                <p class="text-2xl font-bold text-gray-800">${formatMoney(toIssue)}</p>
                <p class="mt-1 text-[11px] text-gray-500">Одобренных заявок: ${approved.length}</p>
                <!-- Ведомость пополнений подотчёта: кто, когда и сколько передал -->
                <button onclick="window.openFinancierTopUpStatement()"
                        class="mt-2 bg-white hover:bg-emerald-50 text-[#15803d] border border-[#15803d] px-3 py-1.5 rounded-lg text-xs font-semibold shadow-sm transition">${t('statement.buttonFinancier')}</button>
            </div>
        </div>
    `;

    panel.classList.remove('hidden');
}

// =====================================================================
// ФИЛЬТРАЦИЯ
// =====================================================================

function getFilteredCashRequests() {
    if (currentFilter === 'all') return cashRequestsCache;

    if (currentFilter === 'active') {
        // Активные: ждут решения директора, вернулись на доработку, одобрены
        return cashRequestsCache.filter(r =>
            r.status === 'pending' || r.status === 'revision' || r.status === 'approved'
        );
    }

    return cashRequestsCache.filter(r => r.status === currentFilter);
}

export function switchCashRequestsTab(filter) {
    currentFilter = filter;

    const filters = ['active', 'pending', 'revision', 'approved', 'issued', 'rejected', 'all'];
    filters.forEach(f => {
        const btn = document.getElementById(`cashreq-filter-${f}`);
        if (!btn) return;
        if (f === filter) {
            btn.classList.remove('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200');
            btn.classList.add('bg-[#15803d]', 'text-white');
        } else {
            btn.classList.add('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200');
            btn.classList.remove('bg-[#15803d]', 'text-white');
        }
    });

    renderCashRequests();
}

// =====================================================================
// РЕНДЕР
// =====================================================================

export function renderCashRequests() {
    // Кнопка создания — часть шапки раздела, обновляем при каждом рендере
    updateCreateCashRequestButton();

    const container = document.getElementById('cash-requests-container');
    if (!container) return;

    const filtered = getFilteredCashRequests();

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="bg-white rounded-xl shadow-sm border-2 border-dashed border-gray-300 p-8 text-center space-y-2">
                <div class="text-5xl">💰</div>
                <h3 class="font-bold text-gray-700">Заявок нет</h3>
                <p class="text-sm text-gray-500">${canSeeCreateCashRequestButton('create-cash-request-btn')
                    ? 'Нажми «➕ Создать заявку», чтобы оформить новую'
                    : 'Здесь появятся заявки сотрудников на подотчёт'}</p>
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(renderCashRequestCard).join('');
}

function renderCashRequestCard(req) {
    const statusInfo = getCashRequestStatusInfo(req.status);
    const items = req._items || [];
    const projectName = req.project?.name || '—';
    const sectionName = req.section?.name || '—';
    const employeeName = req.employee?.name || '—';
    const totalSum = Number(req.total_sum) || 0;

    return `
        <button onclick="window.openCashRequestDetail(${req.id})"
                class="w-full text-left bg-white rounded-xl shadow-sm border p-4 flex flex-col gap-3 border-l-4 ${statusInfo.border} hover:bg-emerald-50/50 transition cursor-pointer group">
            <div class="flex justify-between items-start gap-2 w-full">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-bold text-[#15803d] font-mono text-sm bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">${escapeHtml(req.request_number)}</span>
                    <span class="text-xs font-bold px-2 py-0.5 rounded ${statusInfo.bg} ${statusInfo.color}">${statusInfo.label}</span>
                </div>
                <span class="text-sm font-bold text-[#166534] whitespace-nowrap">${formatMoney(totalSum)}</span>
            </div>

            <div class="space-y-1">
                <p class="text-xs text-gray-600"><strong>🏗 Объект:</strong> <span class="text-gray-900 font-semibold">${escapeHtml(projectName)}</span></p>
                <p class="text-xs text-gray-600"><strong>📂 Раздел:</strong> ${escapeHtml(sectionName)}</p>
            </div>

            <div class="bg-gray-50 border rounded-lg p-2 text-xs space-y-0.5">
                ${items.length > 0 
                    ? items.slice(0, 3).map(it => `
                        <div class="flex justify-between text-gray-700">
                            <span>🛠 ${escapeHtml(it.name)} — ${it.qty} ${escapeHtml(it.unit || '')} × ${formatMoney(it.unit_price)}</span>
                            <span class="text-gray-500 font-semibold">${formatMoney(it.total_price)}</span>
                        </div>
                    `).join('') + (items.length > 3 ? `<p class="text-[10px] text-gray-400 italic pt-1">и ещё ${items.length - 3}...</p>` : '')
                    : `<p class="text-gray-400 italic">Нет позиций</p>`}
            </div>

            <div class="flex justify-between items-center pt-1 border-t text-[10px] text-gray-400">
                <span>👤 Создал: ${escapeHtml(employeeName)}</span>
                <span>📅 ${formatDate(req.created_at)}</span>
            </div>
        </button>
    `;
}

// =====================================================================
// КАРТОЧКА ЗАЯВКИ (просмотр)
// =====================================================================

export async function openCashRequestDetail(id) {
    const req = cashRequestsCache.find(r => r.id === id);
    if (!req) {
        toast('Заявка не найдена', 'error');
        return;
    }

    currentRequestId = id;

    const statusInfo = getCashRequestStatusInfo(req.status);
    const items = req._items || [];

    const projectName = req.project?.name || '—';
    const sectionName = req.section?.name || '—';
    const employeeName = req.employee?.name || '—';
    const approverName = req.approver?.name || null;

    const itemsHtml = items.length > 0
        ? items.map(it => `
            <div class="flex justify-between items-center bg-white border rounded-lg p-2 text-xs">
                <div class="flex-1 min-w-0">
                    <p class="font-semibold text-gray-800">🛠 ${escapeHtml(it.name)}</p>
                    <p class="text-[11px] text-gray-500">${it.qty} ${escapeHtml(it.unit || '')} × ${formatMoney(it.unit_price)}</p>
                </div>
                <div class="text-right shrink-0">
                    <p class="font-bold text-[#166534]">${formatMoney(it.total_price)}</p>
                </div>
            </div>
        `).join('')
        : '<p class="text-center text-gray-400 italic py-3 text-sm">Нет позиций</p>';

    const container = document.getElementById('cash-request-detail-content');
    if (!container) return;

    container.innerHTML = `
        <div class="flex flex-wrap justify-between items-center gap-2 bg-emerald-50 p-3 rounded-lg border border-emerald-200">
            <div class="flex items-center gap-2 flex-wrap">
                <span class="font-bold text-[#15803d] font-mono text-base">${escapeHtml(req.request_number)}</span>
                <span class="text-xs font-bold px-2 py-0.5 rounded ${statusInfo.bg} ${statusInfo.color}">${statusInfo.label}</span>
            </div>
            <span class="font-bold text-[#166534]">${formatMoney(req.total_sum)}</span>
        </div>

        <div class="bg-gray-50 p-3 rounded-lg border space-y-2 text-xs">
            <p><strong>🏗 Объект:</strong> <span class="font-semibold text-gray-800">${escapeHtml(projectName)}</span></p>
            <p><strong>📂 Раздел:</strong> <span class="font-semibold text-gray-800">${escapeHtml(sectionName)}</span></p>
            <p><strong>👤 Создал:</strong> ${escapeHtml(employeeName)}</p>
            <p><strong>📅 Создано:</strong> ${formatDate(req.created_at)}</p>
            ${req.comment ? `<p><strong>📝 Комментарий:</strong> ${escapeHtml(req.comment)}</p>` : ''}
            ${approverName ? `<p><strong>✅ Обработал:</strong> ${escapeHtml(approverName)}</p>` : ''}
            ${req.approved_at ? `<p><strong>📅 Обработано:</strong> ${formatDate(req.approved_at)}</p>` : ''}
            ${req.rejection_reason ? `<p><strong>${req.status === 'revision' ? '✏️ Причина доработки' : '❌ Причина отклонения'}:</strong> ${escapeHtml(req.rejection_reason)}</p>` : ''}
        </div>

        <div class="space-y-2 pt-2">
            <p class="text-xs font-bold text-gray-500 uppercase tracking-wider">🛠 Позиции (${items.length}):</p>
            <div class="space-y-1">
                ${itemsHtml}
            </div>
        </div>
    `;

    renderCashRequestActions(req);
    showModal('cash-request-detail-modal');
}

function renderCashRequestActions(req) {
    const actionsContainer = document.getElementById('cash-request-detail-actions');
    if (!actionsContainer) return;

    let buttonsHtml = '';

    // Директор (кассир): три решения по заявке, которая ждёт согласования
    if (req.status === 'pending' && canProcessCashRequest()) {
        buttonsHtml += `<button onclick="window.approveCashRequest(${req.id})" class="bg-yellow-500 hover:bg-yellow-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">✅ Одобрить</button>`;
        buttonsHtml += `<button onclick="window.requestRevisionCashRequest(${req.id})" class="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">✏️ На доработку</button>`;
        buttonsHtml += `<button onclick="window.rejectCashRequest(${req.id})" class="bg-red-500 hover:bg-red-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">❌ Отклонить</button>`;
    }

    // Выдача денег по одобренной заявке. Финансист платит со своего
    // подотчёта, поэтому у него кнопка называется «Выдано».
    if (req.status === 'approved' && canIssueCashRequest()) {
        const issueLabel = isFinancier() ? '💵 Выдано' : '💵 Выдать';
        buttonsHtml += `<button onclick="window.issueCashRequest(${req.id})" class="bg-[#15803d] hover:bg-[#166534] text-white font-semibold px-4 py-2 rounded-lg text-sm transition">${issueLabel}</button>`;
    }

    // Директор одобрил — и на этом его работа закончена: деньги выдаёт
    // финансист, у которого заявка уже стоит в списке «🟡 Одобрены».
    // Без этой подписи карточка выглядела бы «без кнопок» и директор ждал бы
    // от себя выдачи денег (раньше у него была кнопка «💵 Выдать»).
    if (req.status === 'approved' && canProcessCashRequest() && !canIssueCashRequest()) {
        buttonsHtml += `<span id="cash-request-awaiting-issue" class="text-xs font-semibold text-gray-500">` +
            '🟡 Одобрено — деньги выдаёт финансист в разделе «💼 Рабочий стол».' +
            '</span>';
    }

    // Автор: доработать заявку, которую директор вернул с причиной
    if (canEditCashRequest(req)) {
        buttonsHtml += `<button onclick="window.openCashRequestEdit(${req.id})" class="bg-orange-500 hover:bg-orange-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">✏️ Исправить и отправить</button>`;
    }

    // Автор: удалить заявку, которую директор ещё не обработал
    const emp = getEmployee();
    if (emp && req.employee_id === emp.id && (req.status === 'pending' || req.status === 'revision')) {
        buttonsHtml += `<button onclick="window.deleteCashRequest(${req.id})" class="bg-red-100 hover:bg-red-200 text-red-700 font-semibold px-4 py-2 rounded-lg text-sm transition">🗑 Удалить</button>`;
    }

    actionsContainer.innerHTML = buttonsHtml;
}

// =====================================================================
// ХЕЛПЕРЫ
// =====================================================================

export function getCashRequestStatusInfo(status) {
    const map = {
        'pending':  { label: '🔴 Ожидает',      bg: 'bg-red-100',    color: 'text-red-700',    border: 'border-red-400' },
        'revision': { label: '✏️ На доработке', bg: 'bg-orange-100', color: 'text-orange-800', border: 'border-orange-400' },
        'approved': { label: '🟡 Одобрено',     bg: 'bg-yellow-100', color: 'text-yellow-800', border: 'border-yellow-400' },
        'issued':   { label: '🟢 Выдано',       bg: 'bg-green-100',  color: 'text-green-700',  border: 'border-[#15803d]' },
        'rejected': { label: '❌ Отклонено',    bg: 'bg-gray-200',   color: 'text-gray-600',   border: 'border-gray-400' }
    };
    return map[status] || { label: status, bg: 'bg-gray-100', color: 'text-gray-700', border: 'border-gray-300' };
}

// =====================================================================
// КНОПКА НАВИГАЦИИ («Финансы»)
// =====================================================================
// Счётчики на кнопках навигации убраны — функция только показывает/скрывает
// саму кнопку. Видимость решает canSeeTab(): право cash_view_all
// (TAB_REQUIREMENTS) плюс урезанный интерфейс роли (ROLE_UI в permissions.js).

export function updateCashRequestsNavButton() {
    const btn = document.getElementById('btn-cash-requests');
    if (!btn) return;

    if (canSeeTab('cash-requests')) {
        btn.classList.remove('hidden');
        btn.style.display = '';
    } else {
        btn.classList.add('hidden');
        btn.style.display = 'none';
    }
}

/**
 * Кнопка «➕ Создать заявку» внутри раздела «💰 Финансы».
 * Её может спрятать урезанный интерфейс роли (ROLE_UI.hiddenButtons):
 * директор заявок не оформляет — он их согласует и выдаёт деньги.
 */
export function updateCreateCashRequestButton() {
    const btn = document.getElementById('create-cash-request-btn');
    if (!btn) return;

    const allowed = canSeeCreateCashRequestButton('create-cash-request-btn');
    btn.classList.toggle('hidden', !allowed);
    btn.style.display = allowed ? '' : 'none';
}
// =====================================================================
// ФОРМА СОЗДАНИЯ ЗАЯВКИ
// =====================================================================

/**
 * Открывает форму заявки финансов.
 * @param {number|null} requestId — id заявки, которую автор дорабатывает
 *   (статус «На доработке»). Без аргумента — создание новой заявки.
 */
export async function openNewCashRequestForm(requestId = null) {
    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан к сотруднику', 'warning');
        return;
    }

    // Доработка: только своя заявка и только возвращённая директором
    let editing = null;
    if (requestId) {
        editing = cashRequestsCache.find(r => r.id === requestId) || null;

        if (!editing) {
            toast('Заявка не найдена', 'error');
            return;
        }
        if (!canEditCashRequest(editing)) {
            toast('Доработать можно только свою заявку в статусе «На доработке»', 'error');
            return;
        }
    }

    editingRequestId = editing ? editing.id : null;
    setCashRequestFormMode(editing);

    // Сбрасываем форму
    document.getElementById('new-cashreq-project').value = '';
    document.getElementById('new-cashreq-section').innerHTML = '<option value="">Сначала выбери объект</option>';
    document.getElementById('new-cashreq-comment').value = '';

    const itemsContainer = document.getElementById('new-cashreq-items');
    itemsContainer.innerHTML = '';

    // Загружаем объекты (все — любой может создать заявку)
    await loadProjectsForCashRequest();

    if (editing) {
        // Подставляем то, что уже было в заявке: автор правит, а не вводит заново
        document.getElementById('new-cashreq-project').value = String(editing.project_id || '');
        await loadSectionsForCashRequest();
        document.getElementById('new-cashreq-section').value = String(editing.section_id || '');
        document.getElementById('new-cashreq-comment').value = editing.comment || '';

        const items = (editing._items || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0));
        if (items.length > 0) items.forEach(item => addCashRequestItemRow(item));
        else addCashRequestItemRow();
    } else {
        addCashRequestItemRow();
    }

    recalcCashRequestTotal();

    showModal('new-cashreq-modal');
}

/**
 * «✏️ Исправить и отправить»: закрывает карточку заявки и открывает форму
 * доработки. Используется и с дашборда прораба, и из карточки заявки.
 */
export function openCashRequestEdit(id) {
    hideModal('cash-request-detail-modal');
    return openNewCashRequestForm(id);
}

/**
 * Переключает окно заявки между «новой» и «доработкой»: заголовок, подпись
 * кнопки сохранения и напоминание о причине возврата.
 */
function setCashRequestFormMode(editing) {
    const title = document.getElementById('new-cashreq-modal-title');
    const submit = document.getElementById('new-cashreq-form')?.querySelector('button[type="submit"]');
    const hint = document.getElementById('new-cashreq-revision-hint');

    if (title) {
        title.textContent = editing
            ? `✏️ Доработка заявки ${editing.request_number}`
            : '💰 Новый финансовый запрос';
    }

    if (submit) {
        submit.textContent = editing ? '💾 Сохранить и отправить' : '💾 Создать заявку';
    }

    if (hint) {
        if (editing && editing.rejection_reason) {
            hint.textContent = 'Причина возврата от директора: ' + editing.rejection_reason;
            hint.classList.remove('hidden');
        } else {
            hint.textContent = '';
            hint.classList.add('hidden');
        }
    }
}

/**
 * Загружает объекты в dropdown.
 */
async function loadProjectsForCashRequest() {
    const select = document.getElementById('new-cashreq-project');
    if (!select) return;

    const { data, error } = await db.select('projects', {
        orderBy: { column: 'name', asc: true }
    });

    if (error || !data) {
        select.innerHTML = '<option value="">Ошибка загрузки объектов</option>';
        return;
    }

    if (data.length === 0) {
        select.innerHTML = '<option value="">Нет объектов</option>';
        return;
    }

    select.innerHTML = '<option value="">— Выбери объект —</option>' +
        data.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

/**
 * Загружает разделы выбранного объекта.
 */
/**
 * Селект «Раздел» в форме финансового запроса.
 * Разделы сметы — группой «📊 Разделы сметы», служебный «Доп. расходы» —
 * отдельной группой «⚠ Вне сметы» (если работы нет в смете).
 */
export async function loadSectionsForCashRequest() {
    const projectId = parseInt(document.getElementById('new-cashreq-project')?.value, 10);
    const sectionSelect = document.getElementById('new-cashreq-section');

    await fillSectionsSelect(sectionSelect, projectId);
}

/**
 * Добавляет строку позиции (работы) в форму.
 * @param {Object|null} item — позиция для доработки заявки: подставляем
 *   прежние значения, чтобы автор правил, а не вводил всё заново.
 */
export function addCashRequestItemRow(item = null) {
    const container = document.getElementById('new-cashreq-items');
    if (!container) return;

    const rowId = 'cashreq-item-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

    const row = document.createElement('div');
    row.className = 'cashreq-item-row bg-gray-50 border rounded-lg p-3 space-y-2';
    row.id = rowId;
    row.dataset.rowId = rowId;

    row.innerHTML = `
        <div class="flex gap-2 items-start">
            <div class="flex-1">
                <input type="text" placeholder="Вид работ (Штукатурка стен)" 
                       class="cashreq-item-name w-full border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
            </div>
            <button type="button" onclick="window.removeCashRequestItemRow('${rowId}')" 
                    class="text-red-500 hover:text-red-700 px-2 py-1 text-base font-bold shrink-0">✕</button>
        </div>
        <div class="grid grid-cols-3 gap-2">
            <input type="number" step="any" placeholder="Объём" 
                   class="cashreq-item-qty border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]"
                   oninput="window.recalcCashRequestTotal()">
            <select class="cashreq-item-unit border rounded-lg p-2 text-xs bg-white text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                <option value="м²">м²</option>
                <option value="м³">м³</option>
                <option value="м">м</option>
                <option value="шт">шт</option>
                <option value="кг">кг</option>
                <option value="т">т</option>
                <option value="уп">уп</option>
                <option value="л">л</option>
                <option value="меш">меш</option>
                <option value="пог.м">пог.м</option>
            </select>
            <input type="number" step="0.01" placeholder="Цена за ед." 
                   class="cashreq-item-price border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]"
                   oninput="window.recalcCashRequestTotal()">
        </div>
        <div class="text-[11px] text-gray-500 pl-1">
            Сумма: <span class="cashreq-item-sum font-bold text-[#15803d]">0,00 грн</span>
        </div>
    `;

    container.appendChild(row);

    // Доработка: подставляем то, что было в заявке
    if (item) {
        const nameInput = row.querySelector('.cashreq-item-name');
        const qtyInput = row.querySelector('.cashreq-item-qty');
        const unitSelect = row.querySelector('.cashreq-item-unit');
        const priceInput = row.querySelector('.cashreq-item-price');
        const sumEl = row.querySelector('.cashreq-item-sum');

        if (nameInput) nameInput.value = item.name || '';
        if (qtyInput) qtyInput.value = item.qty ?? '';
        if (priceInput) priceInput.value = item.unit_price ?? '';

        // Единица измерения могла быть в заявке не из списка — тогда добавим её
        if (unitSelect && item.unit) {
            unitSelect.value = item.unit;
            if (unitSelect.value !== item.unit) {
                const option = document.createElement('option');
                option.value = item.unit;
                option.textContent = item.unit;
                unitSelect.appendChild(option);
                unitSelect.value = item.unit;
            }
        }

        if (sumEl) sumEl.textContent = formatMoney(item.total_price);
    }

    recalcCashRequestTotal();
}

/**
 * Удаляет строку позиции.
 */
export function removeCashRequestItemRow(rowId) {
    const container = document.getElementById('new-cashreq-items');
    if (!container) return;

    if (container.querySelectorAll('.cashreq-item-row').length <= 1) {
        toast('Должна быть хотя бы одна позиция', 'warning');
        return;
    }

    const row = document.getElementById(rowId);
    if (row) {
        row.remove();
        recalcCashRequestTotal();
    }
}

/**
 * Пересчитывает суммы по позициям и общий итог.
 */
export function recalcCashRequestTotal() {
    const rows = document.querySelectorAll('.cashreq-item-row');
    let grandTotal = 0;

    rows.forEach(row => {
        const qty = parseNumber(row.querySelector('.cashreq-item-qty')?.value);
        const price = parseNumber(row.querySelector('.cashreq-item-price')?.value);
        const sum = roundMoney(qty * price);

        const sumEl = row.querySelector('.cashreq-item-sum');
        if (sumEl) sumEl.textContent = formatMoney(sum);

        grandTotal = roundMoney(grandTotal + sum);
    });

    const totalEl = document.getElementById('new-cashreq-total');
    if (totalEl) totalEl.textContent = formatMoney(grandTotal);

    const counterEl = document.getElementById('new-cashreq-items-count');
    if (counterEl) counterEl.textContent = rows.length;
}

/**
 * Сохранение новой заявки финансов.
 */
export async function saveNewCashRequest(event) {
    event.preventDefault();

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняем...';

    // Кнопку возвращаем в исходный вид в finally. Раньше после успешного
    // сохранения она оставалась «Сохраняем...» и выключенной, поэтому
    // следующая попытка молча не отправлялась — форма выглядела зависшей.
    try {
        const saved = await createCashRequest(form, emp);
        if (saved) {
            await loadCashRequests();   // список обновляем после закрытия окна
            await refreshDashboardIfVisible();
        }

    } catch (err) {
        log.error('Исключение при сохранении заявки финансов:', err);
        toast('Не удалось сохранить заявку: ' + (err?.message || 'неизвестная ошибка'), 'error');

    } finally {
        submitBtn.disabled = false;
        // Подпись зависит от режима окна: создание новой заявки или доработка
        submitBtn.textContent = editingRequestId ? '💾 Сохранить и отправить' : '💾 Создать заявку';
    }
}

/**
 * Собирает и сохраняет заявку финансов от имени сотрудника emp: создаёт
 * новую или дорабатывает возвращённую (editingRequestId).
 * Возвращает true, если заявка сохранена. Кнопку не трогает — это дело
 * saveNewCashRequest, иначе при сбое она осталась бы выключенной.
 */
async function createCashRequest(form, emp) {
    const projectId = parseInt(document.getElementById('new-cashreq-project').value, 10);
    const sectionId = parseInt(document.getElementById('new-cashreq-section').value, 10);
    const comment = document.getElementById('new-cashreq-comment').value.trim();

    if (!projectId) {
        toast('Выбери объект', 'error');
        return false;
    }
    if (!sectionId) {
        toast('Выбери раздел сметы', 'error');
        return false;
    }

    const collected = collectCashRequestItems();
    if (!collected) return false;   // тост уже показан

    const { items, totalSum } = collected;

    // Доработка: заявка уже есть — обновляем её и снова отправляем директору
    if (editingRequestId) {
        return await updateCashRequest({
            requestId: editingRequestId,
            projectId,
            sectionId,
            comment,
            items,
            totalSum
        });
    }

    // Номер заявки генерируем от МАКСИМУМА за год, а не от COUNT(*):
    // COUNT ломается при удалении заявок и в параллельных сессиях.
    let requestNumber = await generateCashRequestNumber();

    // Создаём заявку. При коллизии номера (UNIQUE 23505) — пробуем ещё раз.
    let reqData = null;
    let reqError = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const requestPayload = {
            request_number: requestNumber,
            project_id: projectId,
            section_id: sectionId,
            employee_id: emp.id,
            total_sum: totalSum,
            comment: comment || null,
            status: 'pending'
        };

        const result = await db.insert('cash_requests', requestPayload);
        reqData = result.data;
        reqError = result.error;

        if (!reqError) break;
        if (reqError.code !== '23505') break;

        log.warn(`Номер ${requestNumber} уже занят, повторная попытка...`);
        requestNumber = await generateCashRequestNumber();
    }

    if (reqError) {
        log.error('Ошибка создания заявки:', reqError.message);
        toast('Не удалось создать заявку: ' + reqError.message, 'error');
        return false;
    }

    // База может не вернуть созданную строку — например, если прокси отдал
    // ответ без тела. Без проверки здесь был бы TypeError, а кнопка молча
    // оставалась бы «Сохраняем...» и следующая попытка не отправлялась.
    const requestId = reqData ? reqData.id : null;

    if (!requestId) {
        log.error('База не вернула созданную заявку (пустой ответ на INSERT)');
        toast('Заявка не сохранилась: база не вернула запись. Повторите попытку.', 'error');
        return false;
    }

    // Создаём позиции
    const itemsPayload = items.map(it => ({
        request_id: requestId,
        name: it.name,
        unit: it.unit,
        qty: it.qty,
        unit_price: it.unit_price,
        total_price: it.total_price
    }));

    const { error: itemsError } = await db.insertMany('cash_request_items', itemsPayload);

    if (itemsError) {
        log.error('Ошибка создания позиций:', itemsError.message);
        toast('Заявка создана, но позиции не сохранились', 'warning');
    }

    log.info('✅ Заявка финансов создана:', requestNumber);
    toast(`Заявка ${requestNumber} создана`, 'success');

    hideModal('new-cashreq-modal');
    form.reset();
    editingRequestId = null;
    setCashRequestFormMode(null);

    return true;
}

/**
 * Собирает позиции из формы заявки.
 * @returns {{items: Array, totalSum: number}|null}
 *   null — данные неполные, пользователю уже показан тост.
 */
function collectCashRequestItems() {
    const rows = document.querySelectorAll('.cashreq-item-row');
    const items = [];
    let totalSum = 0;

    for (const row of rows) {
        const name = row.querySelector('.cashreq-item-name')?.value.trim();
        const qty = parseNumber(row.querySelector('.cashreq-item-qty')?.value);
        const unit = row.querySelector('.cashreq-item-unit')?.value || 'м²';
        const unitPrice = parseNumber(row.querySelector('.cashreq-item-price')?.value);

        if (!name) {
            toast('Заполни вид работ во всех позициях', 'error');
            return null;
        }
        if (qty <= 0 || unitPrice <= 0) {
            toast('Объём и цена должны быть больше нуля', 'error');
            return null;
        }

        const totalPrice = roundMoney(qty * unitPrice);
        totalSum = roundMoney(totalSum + totalPrice);

        items.push({
            name,
            qty,
            unit,
            unit_price: unitPrice,
            total_price: totalPrice
        });
    }

    if (items.length === 0) {
        toast('Добавь хотя бы одну позицию', 'error');
        return null;
    }

    return { items, totalSum };
}

/**
 * Доработка возвращённой заявки: позиции перезаписываются, сумма и раздел
 * обновляются, заявка снова уходит директору (status 'pending'), а причина
 * возврата стирается — она относилась к прошлому кругу.
 * Номер заявки не меняется: это та же заявка, а не новая.
 */
async function updateCashRequest({ requestId, projectId, sectionId, comment, items, totalSum }) {
    const requestNumber = cashRequestsCache.find(r => r.id === requestId)?.request_number || `#${requestId}`;

    // 1. Позиции: старые удаляем, новые вставляем (id позиций нигде не хранятся)
    const { error: removeError } = await db.remove('cash_request_items', { request_id: requestId });
    if (removeError) {
        log.error('Ошибка удаления старых позиций заявки:', removeError.message);
        toast('Не удалось обновить позиции: ' + removeError.message, 'error');
        return false;
    }

    const { error: itemsError } = await db.insertMany('cash_request_items', items.map(it => ({
        request_id: requestId,
        name: it.name,
        unit: it.unit,
        qty: it.qty,
        unit_price: it.unit_price,
        total_price: it.total_price
    })));

    if (itemsError) {
        log.error('Ошибка сохранения позиций заявки:', itemsError.message);
        toast('Позиции не сохранились: ' + itemsError.message, 'error');
        return false;
    }

    // 2. Сама заявка: снова «Ожидает», решение директора сброшено
    const { error: updateError } = await db.update('cash_requests', {
        project_id: projectId,
        section_id: sectionId,
        comment: comment || null,
        total_sum: totalSum,
        status: 'pending',
        approved_by_employee_id: null,
        approved_at: null,
        rejection_reason: null
    }, { id: requestId });

    if (updateError) {
        log.error('Ошибка обновления заявки:', updateError.message);
        toast(db.explainError(updateError), 'error');
        return false;
    }

    log.info('✏️ Заявка доработана и отправлена повторно:', requestNumber);
    toast(`Заявка ${requestNumber} отправлена директору повторно`, 'success');

    editingRequestId = null;
    const form = document.getElementById('new-cashreq-form');
    if (form) form.reset();
    setCashRequestFormMode(null);
    hideModal('new-cashreq-modal');

    return true;
}

/**
 * Генерирует номер заявки формата: Ф-N/YY
 */
async function generateCashRequestNumber() {
    const year = new Date().getFullYear();
    const yearShort = String(year).slice(-2);
    const prefix = 'Ф-';
    const suffix = `/${yearShort}`;

    const startOfYear = `${year}-01-01T00:00:00`;
    const startOfNextYear = `${year + 1}-01-01T00:00:00`;

    // Берём МАКСИМАЛЬНЫЙ номер за год (COUNT(*) давал дубли после удаления заявок)
    const { data } = await db.select('cash_requests', {
        select: 'request_number',
        filters: {
            'created_at.gte': startOfYear,
            'created_at.lt': startOfNextYear
        }
    });

    let maxNumber = 0;

    (data || []).forEach(row => {
        const raw = String(row.request_number || '');
        if (!raw.startsWith(prefix) || !raw.endsWith(suffix)) return;

        const num = parseInt(raw.slice(prefix.length, raw.length - suffix.length), 10);
        if (Number.isFinite(num) && num > maxNumber) maxNumber = num;
    });

    return `${prefix}${maxNumber + 1}${suffix}`;
}

// =====================================================================
// ОБРАБОТКА КАССИРОМ
// =====================================================================

/**
 * Одобрить заявку (status: pending → approved).
 * Причина возврата/отказа от прошлого круга стирается: заявка уходит дальше
 * чистой.
 */
export async function approveCashRequest(id) {
    if (!canProcessCashRequest()) {
        toast('Нет прав на обработку заявки', 'error');
        return;
    }

    const req = cashRequestsCache.find(r => r.id === id);
    if (!req) {
        toast('Заявка не найдена', 'error');
        return;
    }

    if (req.status !== 'pending') {
        toast('Заявка уже обработана', 'warning');
        return;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const { error } = await db.update('cash_requests', {
        status: 'approved',
        approved_by_employee_id: emp.id,
        approved_at: new Date().toISOString(),
        rejection_reason: null
    }, { id });

    if (error) {
        // Ошибку базы показываем по-русски: чаще всего это устаревшее
        // CHECK-ограничение на статусы или не применённая миграция
        // (js/database.js → explainError подсказывает, какой файл запустить).
        toast(db.explainError(error), 'error');
        return;
    }

    toast(`Заявка ${req.request_number} одобрена — ушла на выдачу`, 'success');
    hideModal('cash-request-detail-modal');
    await loadCashRequests();
}

/**
 * Вернуть заявку автору на доработку (status: pending → revision).
 * Причина обязательна: без неё прораб не знает, что исправлять.
 * Хранится в rejection_reason — статус заявки однозначно говорит,
 * возврат это или отказ (см. шапку модуля).
 */
export async function requestRevisionCashRequest(id) {
    if (!canProcessCashRequest()) {
        toast('Нет прав на обработку заявки', 'error');
        return;
    }

    const req = cashRequestsCache.find(r => r.id === id);
    if (!req) {
        toast('Заявка не найдена', 'error');
        return;
    }

    if (req.status !== 'pending') {
        toast('Заявка уже обработана', 'warning');
        return;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const reason = prompt(`Что нужно доработать в заявке ${req.request_number}?`);
    if (reason === null) return;   // директор отменил

    if (!reason.trim()) {
        toast('Опишите причину доработки — без неё заявку не вернуть', 'warning');
        return;
    }

    const { error } = await db.update('cash_requests', {
        status: 'revision',
        approved_by_employee_id: emp.id,
        approved_at: new Date().toISOString(),
        rejection_reason: reason.trim()
    }, { id });

    if (error) {
        toast(db.explainError(error), 'error');
        return;
    }

    toast(`Заявка ${req.request_number} возвращена на доработку`, 'warning');
    hideModal('cash-request-detail-modal');
    await loadCashRequests();
}

/**
 * Отклонить заявку (status: pending → rejected).
 */
export async function rejectCashRequest(id) {
    if (!canProcessCashRequest()) {
        toast('Нет прав на обработку заявки', 'error');
        return;
    }

    const req = cashRequestsCache.find(r => r.id === id);
    if (!req) return;

    if (req.status !== 'pending') {
        toast('Заявка уже обработана', 'warning');
        return;
    }

    const reason = prompt(`Причина отклонения заявки ${req.request_number}:`);
    if (reason === null) return; // отменил

    if (!reason.trim()) {
        toast('Опишите причину отказа — без неё заявку не отклонить', 'warning');
        return;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const { error } = await db.update('cash_requests', {
        status: 'rejected',
        approved_by_employee_id: emp.id,
        approved_at: new Date().toISOString(),
        rejection_reason: reason.trim()
    }, { id });

    if (error) {
        toast(db.explainError(error), 'error');
        return;
    }

    toast(`Заявка ${req.request_number} отклонена`, 'warning');
    hideModal('cash-request-detail-modal');
    await loadCashRequests();
}

/**
 * Выдать заявку (status: approved → issued).
 *
 * Получателю создаётся операция 'issue' → его подотчёт увеличивается.
 * Если деньги выдаёт ФИНАНСИСТ, та же сумма списывается с ЕГО подотчёта:
 * представление employee_cash_balance понимает только issue / expense /
 * return, а 'expense' здесь не годится — такая строка попала бы в «Реестр»
 * как реальная трата, хотя выданный подотчёт тратой ещё не является
 * (трата появится после авансового отчёта получателя).
 */
export async function issueCashRequest(id) {
    if (!canIssueCashRequest()) {
        toast('Нет прав на выдачу', 'error');
        return;
    }

    const req = cashRequestsCache.find(r => r.id === id);
    if (!req) {
        toast('Заявка не найдена', 'error');
        return;
    }

    if (req.status !== 'approved') {
        toast('Заявка должна быть в статусе «Одобрено»', 'warning');
        return;
    }

    const totalSum = Number(req.total_sum) || 0;
    if (totalSum <= 0) {
        toast('Сумма заявки должна быть больше нуля', 'error');
        return;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const recipientName = req.employee?.name || '—';
    const operationDate = new Date().toISOString().split('T')[0];

    // Финансист платит со своего подотчёта — перед выдачей показываем остаток
    const paysFromOwnBalance = isFinancier();

    if (paysFromOwnBalance) {
        const { balance } = await loadBalance(emp.id);
        const rest = Number(balance) || 0;
        const balanceHint = rest < totalSum
            ? `\n\n⚠️ На вашем подотчёте ${formatMoney(rest)} — баланс станет отрицательным (долг).`
            : `\n\nОстаток вашего подотчёта: ${formatMoney(rest)}.`;

        if (!confirm(`Выдать ${formatMoney(totalSum)} сотруднику «${recipientName}»?${balanceHint}\n\nСумма спишется с вашего подотчёта.`)) {
            return;
        }
    } else if (!confirm(`Выдать ${formatMoney(totalSum)} сотруднику «${recipientName}»?\n\nЭто увеличит его подотчёт.`)) {
        return;
    }

    // 1. Приход получателю: подотчёт сотрудника растёт (как было и раньше)
    const { data: operationData, error: opError } = await db.insert('cash_operations', {
        employee_id: req.employee_id,
        operation_type: 'issue',
        amount: totalSum,
        description: `Заявка ${req.request_number} — ${req.section?.name || 'работы'}`,
        operation_date: operationDate
    });

    if (opError) {
        log.error('Ошибка создания операции:', opError.message);
        toast(db.explainError(opError), 'error');
        return;
    }

    // 2. Финансист: списание с ЕГО подотчёта (деньги ушли получателю)
    if (paysFromOwnBalance) {
        const { error: debitError } = await db.insert('cash_operations', {
            employee_id: emp.id,
            operation_type: 'return',
            amount: totalSum,
            description: `Выдача по заявке ${req.request_number} — ${recipientName}`,
            operation_date: operationDate
        });

        if (debitError) {
            log.error('Ошибка списания с подотчёта финансиста:', debitError.message);
            toast('Получателю записано, но с вашего подотчёта сумма не списалась', 'warning');
        }
    }

    // 3. Заявка → «Выдано». База может не вернуть строку операции — тогда
    // issued_operation_id останется пустым, а статус всё равно поменяем.
    const { error: reqError } = await db.update('cash_requests', {
        status: 'issued',
        issued_operation_id: operationData?.id || null
    }, { id });

    if (reqError) {
        log.error('Ошибка обновления заявки:', reqError.message);
        toast('Операция создана, но заявка не обновлена', 'warning');
    }

    log.info('✅ Выдано по заявке', req.request_number, ':', totalSum);
    toast(`Выдано ${formatMoney(totalSum)} по заявке ${req.request_number}`, 'success');

    hideModal('cash-request-detail-modal');
    await loadCashRequests();

    // Обновляем баланс в профиле: у получателя он вырос, у финансиста упал
    if (window.renderProfileBalance) {
        await window.renderProfileBalance();
    }
}

/**
 * Удалить заявку (только автор, только pending).
 */
export async function deleteCashRequest(id) {
    const req = cashRequestsCache.find(r => r.id === id);
    if (!req) return;

    const emp = getEmployee();
    if (!emp || req.employee_id !== emp.id) {
        toast('Удалить можно только свои заявки', 'error');
        return;
    }

    // Удалить можно только то, что директор ещё не обработал: «Ожидает»
    // или вернул на доработку. По одобренным и выданным уже идут деньги.
    if (req.status !== 'pending' && req.status !== 'revision') {
        toast('Удалить можно только заявку «Ожидает» или «На доработке»', 'warning');
        return;
    }

    if (!confirm(`Удалить заявку ${req.request_number}?\n\nЭто действие нельзя отменить.`)) return;

    // Удаляем позиции
    await db.remove('cash_request_items', { request_id: id });

    // Удаляем заявку
    const { error } = await db.remove('cash_requests', { id });

    if (error) {
        toast(db.explainError(error), 'error');
        return;
    }

    toast('Заявка удалена', 'success');
    hideModal('cash-request-detail-modal');
    await loadCashRequests();
    await refreshDashboardIfVisible();
}
// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.openCashRequestDetail = openCashRequestDetail;
window.switchCashRequestsTab = switchCashRequestsTab;
window.openNewCashRequestForm = openNewCashRequestForm;
window.openCashRequestEdit = openCashRequestEdit;
window.loadSectionsForCashRequest = loadSectionsForCashRequest;
window.addCashRequestItemRow = addCashRequestItemRow;
window.removeCashRequestItemRow = removeCashRequestItemRow;
window.recalcCashRequestTotal = recalcCashRequestTotal;
window.approveCashRequest = approveCashRequest;
window.requestRevisionCashRequest = requestRevisionCashRequest;
window.rejectCashRequest = rejectCashRequest;
window.issueCashRequest = issueCashRequest;
window.deleteCashRequest = deleteCashRequest;