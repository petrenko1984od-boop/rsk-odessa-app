// =====================================================================
// МОДУЛЬ: СОТРУДНИКИ (с подотчётом)
// =====================================================================
// Управление персоналом + UI подотчёта в карточке.
//
// Логика доступа:
//   - Просмотр: все с правом view_employees
//   - Управление: только Администратор
//   - Подотчёт: кассиры (Админ/Директор/Гл. инженер) — всем
//               остальные — только по себе
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    formatDate
} from '../utils.js';
import { CONFIG } from '../config.js';
import {
    linkUserById,
    unlinkUserFromEmployee
} from '../auth.js';
import {
    can, requirePermission, isAdmin, getEmployee
} from '../permissions.js';
import {
    renderFinancialReport,
    openIssueModal,
    openExpenseModal,
    openReturnModal,
    formatBalance,
    loadBalance
} from './cash.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let employeesCache = [];
let currentCardEmpId = null;

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

export async function loadEmployees() {
    log.info('Загрузка сотрудников...');

    const { data, error } = await db.select('employees', {
        orderBy: { column: 'name', asc: true }
    });

    if (error) {
        log.error('Не удалось загрузить сотрудников:', error.message);
        toast('Ошибка загрузки сотрудников', 'error');
        return;
    }

    employeesCache = data || [];
    log.info(`Загружено: ${employeesCache.length}`);
    renderEmployees();
    updateEmployeesBadge();

    // Глобальный доступ (для cash.js / других модулей)
    window.__getEmployeeById = (id) => employeesCache.find(e => e.id === id);
}

/**
 * Возвращает кэш сотрудников.
 */
export function getEmployeesCache() {
    return employeesCache;
}

// =====================================================================
// РЕНДЕР СПИСКА
// =====================================================================

export function renderEmployees() {
    const container = document.getElementById('employees-container');
    if (!container) return;

    const addBtn = document.getElementById('add-employee-btn');
    if (addBtn) {
        addBtn.style.display = can('add_employee') ? '' : 'none';
    }

    if (employeesCache.length === 0) {
        container.innerHTML = `
            <div class="col-span-2 bg-white rounded-xl shadow-sm border-2 border-dashed border-gray-300 p-8 text-center space-y-2">
                <div class="text-5xl">👥</div>
                <h3 class="font-bold text-gray-700">Список сотрудников пуст</h3>
                <p class="text-sm text-gray-500">${can('add_employee') ? 'Нажми «➕ Добавить сотрудника»' : 'Обратитесь к администратору'}</p>
            </div>
        `;
        return;
    }

    const active = employeesCache.filter(e => !e.status || e.status === 'active');
    const blocked = employeesCache.filter(e => e.status === 'blocked');
    const sorted = [...active, ...blocked];

    container.innerHTML = sorted.map(renderEmployeeCard).join('');
}

function renderEmployeeCard(emp) {
    const status = emp.status || 'active';
    let statusBadge = '';
    let cardBorder = 'border-[#15803d]';
    let cardOpacity = '';

    if (status === 'blocked') {
        statusBadge = `<span class="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold">🚫 Заблокирован</span>`;
        cardBorder = 'border-red-400';
        cardOpacity = 'opacity-70';
    } else {
        statusBadge = `<span class="text-[10px] bg-green-100 text-green-800 px-2 py-0.5 rounded font-bold">🟢 Активен</span>`;
    }

    return `
        <button onclick="window.openEmployeeCard(${emp.id})"
                class="w-full text-left bg-white rounded-xl shadow-sm border p-4 flex gap-4 items-start border-l-4 ${cardBorder} ${cardOpacity} hover:bg-emerald-50/50 transition cursor-pointer group">
            <div class="w-12 h-12 rounded-full bg-[#15803d] text-white flex items-center justify-center text-base font-bold shrink-0">
                ${getInitials(emp.name)}
            </div>
            <div class="flex-1 min-w-0 space-y-1">
                <div class="flex justify-between items-start gap-2">
                    <h3 class="font-bold text-[#166534] text-base group-hover:underline truncate">${escapeHtml(emp.name)}</h3>
                    ${statusBadge}
                </div>
                <p class="text-xs text-gray-600"><strong>💼 ${escapeHtml(emp.position)}</strong></p>
                ${emp.phone ? `<p class="text-xs text-gray-600">📞 ${escapeHtml(emp.phone)}</p>` : ''}
                ${emp.user_id ? `<p class="text-[10px] text-emerald-600 pt-1">🔗 Привязан к аккаунту</p>` : `<p class="text-[10px] text-gray-400 pt-1">🔓 Аккаунт не привязан</p>`}
            </div>
        </button>
    `;
}

function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
}

// =====================================================================
// ДОБАВЛЕНИЕ
// =====================================================================

export function openAddEmployeeModal() {
    if (!requirePermission('add_employee')) return;

    const posSelect = document.getElementById('emp-position');
    if (posSelect) {
        posSelect.innerHTML = CONFIG.POSITIONS
            .map(p => `<option value="${p}">${p}</option>`)
            .join('');
    }

    document.getElementById('employee-form').reset();
    showModal('employee-modal');
}

export async function saveNewEmployee(event) {
    event.preventDefault();
    if (!requirePermission('add_employee')) return;

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняем...';

    const name     = document.getElementById('emp-name').value.trim();
    const position = document.getElementById('emp-position').value;
    const phone    = document.getElementById('emp-phone').value.trim();
    const notes    = document.getElementById('emp-notes').value.trim();

    if (!name || !position || !phone) {
        toast('Заполни обязательные поля', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Сохранить';
        return;
    }

    const { error } = await db.insert('employees', {
        name, position, phone, notes, status: 'active'
    });

    submitBtn.disabled = false;
    submitBtn.textContent = '💾 Сохранить';

    if (error) {
        toast('Не удалось сохранить: ' + error.message, 'error');
        return;
    }

    toast(`${name} добавлен`, 'success');
    hideModal('employee-modal');
    form.reset();
    await loadEmployees();
}

// =====================================================================
// КАРТОЧКА СОТРУДНИКА
// =====================================================================

export async function openEmployeeCard(id) {
    const emp = employeesCache.find(e => e.id === id);
    if (!emp) { toast('Сотрудник не найден', 'error'); return; }

    currentCardEmpId = id;
    const container = document.getElementById('employee-card-content');
    const status = emp.status || 'active';
    const currentUser = getEmployee();
    const isSelf = currentUser && currentUser.id === emp.id;

    // Определяем права на управление карточкой
    const canManageEmployee = isAdmin();
    const canViewCash = can('cash_view_all') || isSelf;
    const canIssueCash = can('cash_issue');
    const canExpenseCash = can('cash_expense_any') || (can('cash_expense_self') && isSelf);
    const canReturnCash = can('cash_return_any') || (can('cash_return_self') && isSelf);

    // Блок статуса (уволен/заблокирован)
    let statusInfo = '';
    if (status === 'blocked') {
        statusInfo = `
            <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-xs space-y-1">
                <p class="font-bold text-red-700">🚫 Заблокирован</p>
                ${emp.deactivated_at ? `<p class="text-gray-600">Дата: ${formatDate(emp.deactivated_at)}</p>` : ''}
                ${emp.deactivation_reason ? `<p class="text-gray-600">Причина: ${escapeHtml(emp.deactivation_reason)}</p>` : ''}
            </div>`;
    }

    // Основная информация
    container.innerHTML = `
        <div class="flex items-center gap-3 bg-emerald-50 p-3 rounded-lg border border-emerald-100">
            <div class="w-14 h-14 rounded-full bg-[#15803d] text-white flex items-center justify-center text-lg font-bold">
                ${getInitials(emp.name)}
            </div>
            <div class="flex-1">
                <p class="font-bold text-[#166534] text-base">${escapeHtml(emp.name)}</p>
                <p class="text-xs text-gray-600">${escapeHtml(emp.position)}</p>
            </div>
        </div>

        <div class="bg-gray-50 p-3 rounded-lg border space-y-2 text-xs">
            <p><strong>📞 Телефон:</strong> <a href="tel:${escapeHtml(emp.phone)}" class="text-[#15803d] hover:underline">${escapeHtml(emp.phone)}</a></p>
            <p><strong>📅 Добавлен:</strong> ${formatDate(emp.created_at)}</p>
            ${emp.notes ? `<p><strong>📝 Заметки:</strong> ${escapeHtml(emp.notes)}</p>` : ''}
            ${emp.user_id ? `<p class="text-[10px] text-emerald-700 break-all"><strong>🔗 user_id:</strong> <code class="bg-white px-1 rounded">${escapeHtml(emp.user_id)}</code></p>` : ''}
        </div>

        ${statusInfo}

        <!-- Блок подотчёта -->
        <div id="employee-card-cash" class="space-y-3"></div>
    `;

    // Кнопки управления (только Администратор)
    renderCardActions(emp, canManageEmployee, canIssueCash, canExpenseCash, canReturnCash);

    // Удаление в футере
    const deleteBtn = document.getElementById('card-emp-delete-btn');
    if (can('delete_employee')) {
        deleteBtn.style.display = '';
        deleteBtn.onclick = () => confirmDeleteEmployee(emp.id, emp.name);
    } else {
        deleteBtn.style.display = 'none';
    }

    showModal('employee-card-modal');

    // Загружаем баланс подотчёта, если есть права
    if (canViewCash) {
        await renderCashBlock(emp.id);
    }
}

function renderCardActions(emp, canManage, canIssue, canExpense, canReturn) {
    // Блок кнопок управления (не относится к подотчёту)
    if (!canManage) return;

    const container = document.getElementById('employee-card-content');
    const status = emp.status || 'active';

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'pt-3 border-t flex flex-wrap gap-2';

    let buttonsHTML = '';

    if (status === 'active') {
        if (emp.user_id) {
            buttonsHTML += `<button onclick="window.unlinkAccount(${emp.id})" class="bg-gray-500 hover:bg-gray-600 text-white text-xs font-semibold px-3 py-2 rounded-lg transition">🔓 Отвязать аккаунт</button>`;
        } else {
            buttonsHTML += `<button onclick="window.openLinkModal(${emp.id})" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition">🔗 Привязать аккаунт</button>`;
        }
        buttonsHTML += `<button onclick="window.openDeactivateModal(${emp.id})" class="bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition">🚫 Заблокировать</button>`;
    } else {
        buttonsHTML += `<button onclick="window.restoreEmployee(${emp.id})" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition">♻️ Восстановить</button>`;
    }

    actionsDiv.innerHTML = buttonsHTML;

    // Вставляем ПЕРЕД блоком подотчёта
    const cashBlock = document.getElementById('employee-card-cash');
    if (cashBlock && cashBlock.parentNode) {
        cashBlock.parentNode.insertBefore(actionsDiv, cashBlock);
    } else {
        container.appendChild(actionsDiv);
    }
}

// =====================================================================
// БЛОК ПОДОТЧЁТА В КАРТОЧКЕ
// =====================================================================

async function renderCashBlock(employeeId) {
    const container = document.getElementById('employee-card-cash');
    if (!container) return;

    const currentUser = getEmployee();
    const isSelf = currentUser && currentUser.id === employeeId;

    const canIssue = can('cash_issue');
    const canExpense = can('cash_expense_any') || (can('cash_expense_self') && isSelf);
    const canReturn = can('cash_return_any') || (can('cash_return_self') && isSelf);

    // Кнопки операций
    let buttonsHTML = '';
    if (canIssue) {
        buttonsHTML += `<button onclick="window.cashOpenIssue(${employeeId})" class="bg-[#15803d] hover:bg-[#166534] text-white text-xs font-semibold px-3 py-2 rounded-lg transition shadow">💵 Выдать</button>`;
    }
    if (canExpense) {
        buttonsHTML += `<button onclick="window.cashOpenExpense(${employeeId})" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition shadow">🛒 Расход</button>`;
    }
    if (canReturn) {
        buttonsHTML += `<button onclick="window.cashOpenReturn(${employeeId})" class="bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold px-3 py-2 rounded-lg transition shadow">↩️ Возврат</button>`;
    }

    container.innerHTML = `
        <div class="border-t pt-3 space-y-3">
            <div class="flex items-center justify-between">
                <h4 class="text-xs font-bold text-gray-700 uppercase tracking-wider">💰 Подотчёт</h4>
                <div id="employee-card-balance" class="text-sm font-bold">—</div>
            </div>
            ${buttonsHTML ? `<div class="flex flex-wrap gap-2">${buttonsHTML}</div>` : ''}
            <div class="space-y-2 pt-1">
                <p class="text-xs font-semibold text-gray-600">📋 Последние операции:</p>
                <div id="employee-card-operations" class="space-y-2">
                    <p class="text-center text-gray-400 italic text-xs py-3">Загрузка...</p>
                </div>
            </div>
        </div>
    `;

    await refreshEmployeeFinancials(employeeId);
}

/**
 * Обновляет баланс и список операций в карточке.
 * Вызывается после каждой операции.
 */
export async function refreshEmployeeFinancials(employeeId) {
    // Баланс
    const balanceEl = document.getElementById('employee-card-balance');
    if (balanceEl) {
        const { balance } = await loadBalance(employeeId);
        const f = formatBalance(balance);
        balanceEl.innerHTML = `<span class="${f.color}">${f.icon} ${f.text}</span>`;
    }

    // Операции
    const opsContainer = document.getElementById('employee-card-operations');
    if (opsContainer) {
        await renderFinancialReport(employeeId, 'employee-card-operations', true);
    }
}

// Делаем глобальной для вызова из cash.js
window.refreshEmployeeFinancials = refreshEmployeeFinancials;

// =====================================================================
// ОБЁРТКИ ДЛЯ КНОПОК ПОДОТЧЁТА
// =====================================================================

export function cashOpenIssue(employeeId) {
    openIssueModal(employeeId);
}
export function cashOpenExpense(employeeId) {
    openExpenseModal(employeeId);
}
export function cashOpenReturn(employeeId) {
    openReturnModal(employeeId);
}

// =====================================================================
// БЛОКИРОВКА / ВОССТАНОВЛЕНИЕ
// =====================================================================

export function openDeactivateModal(id) {
    if (!requirePermission('block_employee')) return;

    const emp = employeesCache.find(e => e.id === id);
    if (!emp) return;

    document.getElementById('deactivate-emp-id').value = id;
    document.getElementById('deactivate-reason').value = '';

    hideModal('employee-card-modal');
    showModal('deactivate-modal');
}

export async function confirmDeactivate(event) {
    event.preventDefault();
    if (!requirePermission('block_employee')) return;

    const id = parseInt(document.getElementById('deactivate-emp-id').value);
    const reason = document.getElementById('deactivate-reason').value.trim();

    const { error } = await db.update('employees', {
        status: 'blocked',
        user_id: null,
        deactivated_at: new Date().toISOString(),
        deactivation_reason: reason || null
    }, { id });

    if (error) { toast('Ошибка: ' + error.message, 'error'); return; }

    const emp = employeesCache.find(e => e.id === id);
    toast(`${emp.name} заблокирован`, 'success');

    hideModal('deactivate-modal');
    await loadEmployees();
}

export async function restoreEmployee(id) {
    if (!requirePermission('restore_employee')) return;
    if (!confirm('Восстановить сотрудника? После восстановления нужно заново привязать аккаунт.')) return;

    const { error } = await db.update('employees', {
        status: 'active',
        deactivated_at: null,
        deactivation_reason: null
    }, { id });

    if (error) { toast('Ошибка: ' + error.message, 'error'); return; }

    toast('Сотрудник восстановлен', 'success');
    hideModal('employee-card-modal');
    await loadEmployees();
}

// =====================================================================
// ПРИВЯЗКА / ОТВЯЗКА
// =====================================================================

export function openLinkModal(id) {
    if (!requirePermission('link_account')) return;

    const emp = employeesCache.find(e => e.id === id);
    if (!emp) return;

    hideModal('employee-card-modal');

    const content = document.getElementById('link-user-content');
    content.innerHTML = `
        <div class="bg-blue-50 p-3 rounded-lg border border-blue-200 text-xs space-y-1">
            <p class="font-bold text-blue-800">👤 ${escapeHtml(emp.name)}</p>
            <p class="text-gray-600">${escapeHtml(emp.position)}</p>
        </div>
        <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">UID пользователя (из Supabase → Authentication → Users):</label>
            <input type="text" id="link-uid-input" placeholder="933d90ab-33d1-4645-9e94-40d72d32f05b"
                   class="w-full border rounded-lg p-2.5 text-xs font-mono text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
        </div>
        <p class="text-[11px] text-gray-500 bg-gray-50 p-2 rounded border">
            💡 Скопируй UID из Supabase Dashboard → <b>Authentication</b> → <b>Users</b>.
        </p>
        <div class="flex gap-2 pt-2">
            <button onclick="window.confirmLinkAccount(${emp.id})" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg text-sm transition">🔗 Привязать</button>
        </div>
    `;
    showModal('link-user-modal');
}

export async function confirmLinkAccount(id) {
    if (!requirePermission('link_account')) return;

    const input = document.getElementById('link-uid-input');
    const uid = input.value.trim();

    if (!uid) { toast('Введи UID', 'error'); return; }

    const result = await linkUserById(id, uid);

    if (!result.success) {
        toast('Ошибка: ' + result.error.message, 'error');
        return;
    }

    toast('Аккаунт привязан', 'success');
    hideModal('link-user-modal');
    await loadEmployees();
}

export async function unlinkAccount(id) {
    if (!requirePermission('unlink_account')) return;
    if (!confirm('Отвязать аккаунт от сотрудника?')) return;

    const { success, error } = await unlinkUserFromEmployee(id);
    if (!success) { toast('Ошибка: ' + error.message, 'error'); return; }

    toast('Аккаунт отвязан', 'success');
    hideModal('employee-card-modal');
    await loadEmployees();
}

// =====================================================================
// УДАЛЕНИЕ
// =====================================================================

async function confirmDeleteEmployee(id, name) {
    if (!requirePermission('delete_employee')) return;

    if (!confirm(`УДАЛИТЬ "${name}" навсегда?\n\n⚠️ Рекомендуется использовать "Заблокировать".`)) return;

    const { error } = await db.remove('employees', { id });
    if (error) { toast('Ошибка удаления: ' + error.message, 'error'); return; }

    toast('Сотрудник удалён', 'success');
    hideModal('employee-card-modal');
    await loadEmployees();
}

// =====================================================================
// БЕЙДЖ
// =====================================================================

export function updateEmployeesBadge() {
    const badge = document.getElementById('employees-badge');
    if (badge) badge.textContent = employeesCache.length;
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.openEmployeeCard = openEmployeeCard;
window.openDeactivateModal = openDeactivateModal;
window.restoreEmployee = restoreEmployee;
window.openAddEmployeeModal = openAddEmployeeModal;
window.saveNewEmployee = saveNewEmployee;
window.confirmDeactivate = confirmDeactivate;
window.openLinkModal = openLinkModal;
window.confirmLinkAccount = confirmLinkAccount;
window.unlinkAccount = unlinkAccount;
window.cashOpenIssue = cashOpenIssue;
window.cashOpenExpense = cashOpenExpense;
window.cashOpenReturn = cashOpenReturn;