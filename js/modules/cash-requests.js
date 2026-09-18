// =====================================================================
// МОДУЛЬ: ЗАЯВКИ ФИНАНСОВ (на выполнение работ)
// =====================================================================
// Прораб создаёт заявку → кассир одобряет → выдаёт деньги.
//
// Статусы:
//   pending   — 🔴 Ожидает
//   approved  — 🟡 Одобрено
//   rejected  — ❌ Отклонено
//   issued    — 🟢 Выдано
//
// Права:
//   - Создание: ВСЕ
//   - Просмотр: кассиры — все; остальные — только свои
//   - Обработка: кассиры (Админ/Директор/Гл. инженер)
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    formatDate, formatMoney, parseNumber, roundMoney
} from '../utils.js';
import { can, getEmployee, canSeeTab } from '../permissions.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let cashRequestsCache = [];
let currentFilter = 'active';   // 'active' | 'pending' | 'approved' | 'issued' | 'rejected' | 'all'
let currentRequestId = null;

// =====================================================================
// ПРАВА
// =====================================================================

/**
 * Может ли текущий пользователь обрабатывать заявки (одобрять/выдавать)?
 */
function canProcessCashRequest() {
    return can('process_cash_request');
}

/**
 * Видит ли текущий пользователь эту заявку?
 * Кассиры — все. Остальные — только свои.
 */
function canSeeCashRequest(req) {
    const emp = getEmployee();
    if (!emp) return false;

    if (canProcessCashRequest()) return true;
    return req.employee_id === emp.id;
}

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

export async function loadCashRequests() {
    log.info('Загрузка заявок финансов...');

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
}

// =====================================================================
// ФИЛЬТРАЦИЯ
// =====================================================================

function getFilteredCashRequests() {
    if (currentFilter === 'all') return cashRequestsCache;

    if (currentFilter === 'active') {
        // Активные: pending + approved
        return cashRequestsCache.filter(r => 
            r.status === 'pending' || r.status === 'approved'
        );
    }

    return cashRequestsCache.filter(r => r.status === currentFilter);
}

export function switchCashRequestsTab(filter) {
    currentFilter = filter;

    const filters = ['active', 'pending', 'approved', 'issued', 'rejected', 'all'];
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
    const container = document.getElementById('cash-requests-container');
    if (!container) return;

    const filtered = getFilteredCashRequests();

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="bg-white rounded-xl shadow-sm border-2 border-dashed border-gray-300 p-8 text-center space-y-2">
                <div class="text-5xl">💰</div>
                <h3 class="font-bold text-gray-700">Заявок нет</h3>
                <p class="text-sm text-gray-500">Нажми «➕ Создать заявку», чтобы оформить новую</p>
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
            ${req.rejection_reason ? `<p><strong>❌ Причина отклонения:</strong> ${escapeHtml(req.rejection_reason)}</p>` : ''}
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
    const isCashier = canProcessCashRequest();

    // Кассир: одобрить/отклонить (статус pending)
    if (req.status === 'pending' && isCashier) {
        buttonsHtml += `<button onclick="window.approveCashRequest(${req.id})" class="bg-yellow-500 hover:bg-yellow-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">✅ Одобрить</button>`;
        buttonsHtml += `<button onclick="window.rejectCashRequest(${req.id})" class="bg-red-500 hover:bg-red-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">❌ Отклонить</button>`;
    }

    // Кассир: выдать (статус approved)
    if (req.status === 'approved' && isCashier) {
        buttonsHtml += `<button onclick="window.issueCashRequest(${req.id})" class="bg-[#15803d] hover:bg-[#166534] text-white font-semibold px-4 py-2 rounded-lg text-sm transition">💵 Выдать</button>`;
    }

    // Автор: удалить (только свои новые pending)
    const emp = getEmployee();
    if (req.status === 'pending' && emp && req.employee_id === emp.id) {
        buttonsHtml += `<button onclick="window.deleteCashRequest(${req.id})" class="bg-red-100 hover:bg-red-200 text-red-700 font-semibold px-4 py-2 rounded-lg text-sm transition">🗑 Удалить</button>`;
    }

    actionsContainer.innerHTML = buttonsHtml;
}

// =====================================================================
// ХЕЛПЕРЫ
// =====================================================================

export function getCashRequestStatusInfo(status) {
    const map = {
        'pending':  { label: '🔴 Ожидает',   bg: 'bg-red-100',    color: 'text-red-700',    border: 'border-red-400' },
        'approved': { label: '🟡 Одобрено',  bg: 'bg-yellow-100', color: 'text-yellow-800', border: 'border-yellow-400' },
        'issued':   { label: '🟢 Выдано',    bg: 'bg-green-100',  color: 'text-green-700',  border: 'border-[#15803d]' },
        'rejected': { label: '❌ Отклонено', bg: 'bg-gray-200',   color: 'text-gray-600',   border: 'border-gray-400' }
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
// =====================================================================
// ФОРМА СОЗДАНИЯ ЗАЯВКИ
// =====================================================================

/**
 * Открывает форму создания заявки финансов.
 */
export async function openNewCashRequestForm() {
    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан к сотруднику', 'warning');
        return;
    }

    // Сбрасываем форму
    document.getElementById('new-cashreq-project').value = '';
    document.getElementById('new-cashreq-section').innerHTML = '<option value="">Сначала выбери объект</option>';
    document.getElementById('new-cashreq-comment').value = '';

    const itemsContainer = document.getElementById('new-cashreq-items');
    itemsContainer.innerHTML = '';
    addCashRequestItemRow();

    // Загружаем объекты (все — любой может создать заявку)
    await loadProjectsForCashRequest();

    recalcCashRequestTotal();

    showModal('new-cashreq-modal');
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
export async function loadSectionsForCashRequest() {
    const projectId = parseInt(document.getElementById('new-cashreq-project')?.value, 10);
    const sectionSelect = document.getElementById('new-cashreq-section');
    if (!sectionSelect) return;

    if (!projectId) {
        sectionSelect.innerHTML = '<option value="">Сначала выбери объект</option>';
        return;
    }

    const { data, error } = await db.select('sections', {
        filters: { project_id: projectId },
        orderBy: { column: 'id', asc: true }
    });

    if (error) {
        sectionSelect.innerHTML = '<option value="">Ошибка загрузки разделов</option>';
        return;
    }

    if (!data || data.length === 0) {
        sectionSelect.innerHTML = '<option value="">⚠️ У объекта нет разделов (загрузи смету)</option>';
        return;
    }

    sectionSelect.innerHTML = '<option value="">— Выбери раздел —</option>' +
        data.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
}

/**
 * Добавляет строку позиции (работы) в форму.
 */
export function addCashRequestItemRow() {
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

    const projectId = parseInt(document.getElementById('new-cashreq-project').value, 10);
    const sectionId = parseInt(document.getElementById('new-cashreq-section').value, 10);
    const comment = document.getElementById('new-cashreq-comment').value.trim();

    if (!projectId) {
        toast('Выбери объект', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Создать заявку';
        return;
    }
    if (!sectionId) {
        toast('Выбери раздел сметы', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Создать заявку';
        return;
    }

    // Собираем позиции
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
            submitBtn.disabled = false;
            submitBtn.textContent = '💾 Создать заявку';
            return;
        }
        if (qty <= 0 || unitPrice <= 0) {
            toast('Объём и цена должны быть больше нуля', 'error');
            submitBtn.disabled = false;
            submitBtn.textContent = '💾 Создать заявку';
            return;
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
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Создать заявку';
        return;
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
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Создать заявку';
        return;
    }

    const requestId = reqData.id;

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

    await loadCashRequests();
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
        approved_at: new Date().toISOString()
    }, { id });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    toast(`Заявка ${req.request_number} одобрена`, 'success');
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

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const { error } = await db.update('cash_requests', {
        status: 'rejected',
        approved_by_employee_id: emp.id,
        approved_at: new Date().toISOString(),
        rejection_reason: reason || null
    }, { id });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    toast(`Заявка ${req.request_number} отклонена`, 'warning');
    hideModal('cash-request-detail-modal');
    await loadCashRequests();
}

/**
 * Выдать заявку (status: approved → issued).
 * Создаёт cash_operation типа 'issue' → увеличивает баланс сотрудника.
 */
export async function issueCashRequest(id) {
    if (!canProcessCashRequest()) {
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

    if (!confirm(`Выдать ${formatMoney(totalSum)} сотруднику «${req.employee?.name || '—'}»?\n\nЭто увеличит его подотчёт.`)) {
        return;
    }

    // Создаём cash_operation типа 'issue'
    const { data: operationData, error: opError } = await db.insert('cash_operations', {
        employee_id: req.employee_id,
        operation_type: 'issue',
        amount: totalSum,
        description: `Заявка ${req.request_number} — ${req.section?.name || 'работы'}`,
        operation_date: new Date().toISOString().split('T')[0]
    });

    if (opError) {
        log.error('Ошибка создания операции:', opError.message);
        toast('Ошибка выдачи: ' + opError.message, 'error');
        return;
    }

    // Обновляем заявку
    const { error: reqError } = await db.update('cash_requests', {
        status: 'issued',
        issued_operation_id: operationData.id
    }, { id });

    if (reqError) {
        log.error('Ошибка обновления заявки:', reqError.message);
        toast('Операция создана, но заявка не обновлена', 'warning');
    }

    log.info('✅ Выдано по заявке', req.request_number, ':', totalSum);
    toast(`Выдано ${formatMoney(totalSum)} по заявке ${req.request_number}`, 'success');

    hideModal('cash-request-detail-modal');
    await loadCashRequests();

    // Обновляем баланс в профиле (если это текущий пользователь)
    const current = getEmployee();
    if (current && current.id === req.employee_id && window.renderProfileBalance) {
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

    if (req.status !== 'pending') {
        toast('Можно удалять только заявки в статусе «Ожидает»', 'warning');
        return;
    }

    if (!confirm(`Удалить заявку ${req.request_number}?\n\nЭто действие нельзя отменить.`)) return;

    // Удаляем позиции
    await db.remove('cash_request_items', { request_id: id });

    // Удаляем заявку
    const { error } = await db.remove('cash_requests', { id });

    if (error) {
        toast('Ошибка удаления: ' + error.message, 'error');
        return;
    }

    toast('Заявка удалена', 'success');
    hideModal('cash-request-detail-modal');
    await loadCashRequests();
}
// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.openCashRequestDetail = openCashRequestDetail;
window.switchCashRequestsTab = switchCashRequestsTab;
window.openNewCashRequestForm = openNewCashRequestForm;
window.loadSectionsForCashRequest = loadSectionsForCashRequest;
window.addCashRequestItemRow = addCashRequestItemRow;
window.removeCashRequestItemRow = removeCashRequestItemRow;
window.recalcCashRequestTotal = recalcCashRequestTotal;
window.approveCashRequest = approveCashRequest;
window.rejectCashRequest = rejectCashRequest;
window.issueCashRequest = issueCashRequest;
window.deleteCashRequest = deleteCashRequest;