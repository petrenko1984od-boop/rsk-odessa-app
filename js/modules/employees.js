// =====================================================================
// МОДУЛЬ: СОТРУДНИКИ
// =====================================================================
// Управление персоналом.
// Подотчёт находится в кабинете (см. cash.js).
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
// Баланс подотчёта — тот же, что в кабинете сотрудника
import { loadBalance, formatBalance } from './cash.js';
// Бейджи статуса и приоритета задачи — чтобы карточка выглядела как «Рабочий экран»
import {
    getTaskStatusInfo, getTaskPriorityInfo
} from './tasks.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let employeesCache = [];

// Сотрудник, карточка которого открыта сейчас: нужно, чтобы обновлять
// блоки карточки (объекты/баланс/задачи) после постановки задачи.
let currentCardEmployeeId = null;

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
}

export function getEmployeesCache() {
    return employeesCache;
}

// =====================================================================
// СПИСОК
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
// КАРТОЧКА СОТРУДНИКА (без блока подотчёта)
// =====================================================================

export async function openEmployeeCard(id) {
    const emp = employeesCache.find(e => e.id === id);
    if (!emp) { toast('Сотрудник не найден', 'error'); return; }

    const container = document.getElementById('employee-card-content');
    const status = emp.status || 'active';

    let statusInfo = '';
    if (status === 'blocked') {
        statusInfo = `
            <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-xs space-y-1">
                <p class="font-bold text-red-700">🚫 Заблокирован</p>
                ${emp.deactivated_at ? `<p class="text-gray-600">Дата: ${formatDate(emp.deactivated_at)}</p>` : ''}
                ${emp.deactivation_reason ? `<p class="text-gray-600">Причина: ${escapeHtml(emp.deactivation_reason)}</p>` : ''}
            </div>`;
    }

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

        <!-- Объекты / баланс / актуальные задачи заполняет refreshEmployeeCardExtra() -->
        <div id="employee-card-extra"></div>
    `;

    // Кнопки управления (только Админ)
    renderCardActions(emp);

    // Удаление
    const deleteBtn = document.getElementById('card-emp-delete-btn');
    if (can('delete_employee')) {
        deleteBtn.style.display = '';
        deleteBtn.onclick = () => confirmDeleteEmployee(emp.id, emp.name);
    } else {
        deleteBtn.style.display = 'none';
    }

    showModal('employee-card-modal');

    // Объекты, баланс и актуальные задачи догружаем уже после открытия
    // карточки, чтобы она открывалась мгновенно.
    currentCardEmployeeId = emp.id;
    refreshEmployeeCardExtra();
}

function renderCardActions(emp) {
    if (!isAdmin()) return;

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
    container.appendChild(actionsDiv);
}

// =====================================================================
// БЛОКИ КАРТОЧКИ: ОБЪЕКТЫ / БАЛАНС / АКТУАЛЬНЫЕ ЗАДАЧИ
// =====================================================================
// Карточка открывается мгновенно, а эти данные подтягиваются следом:
//   🏗 Объекты — объекты, где сотрудник прораб (projects.foreman_id);
//   💰 Баланс  — та же цифра, что в кабинете сотрудника
//                (представление employee_cash_balance);
//   🎯 Задачи  — только актуальные (pending / in_progress), назначенные
//                на сотрудника; выполненные и отменённые не показываем.
// =====================================================================

/**
 * Актуальная задача — новая или в работе.
 * Выполненные, отменённые и архивные в карточке сотрудника не показываем.
 */
function isActualTask(task) {
    return task.status === 'pending' || task.status === 'in_progress';
}

/**
 * Сортировка задач: сначала с ближайшим дедлайном, задачи без срока — в конце.
 */
function byDeadline(a, b) {
    if (!a.deadline && !b.deadline) return 0;
    if (!a.deadline) return 1;
    if (!b.deadline) return -1;
    return a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0;
}

/**
 * Может ли текущий пользователь поставить задачу этому сотруднику.
 * Право assign_task_to_employee есть у Администратора, Директора и
 * Главного инженера. create_task проверяем дополнительно: без него форма
 * создания задачи просто не откроется.
 */
function canAssignTaskTo(emp) {
    const status = emp.status || 'active';
    return status === 'active' && can('create_task') && can('assign_task_to_employee');
}

/**
 * Виден ли в карточке баланс подотчёта.
 * Кассиры (cash_view_all) видят баланс любого сотрудника, остальные — только свой.
 */
function canSeeEmployeeBalance(emp) {
    const me = getEmployee();
    return can('cash_view_all') || (!!me && me.id === emp.id);
}

/**
 * Загружает данные для дополнительных блоков карточки сотрудника.
 * @returns {Promise<{ projects, balance, tasks }>}
 */
async function loadEmployeeCardExtra(emp) {
    const [projectsRes, balanceRes, tasksRes] = await Promise.all([
        db.select('projects', {
            filters: { foreman_id: emp.id },
            orderBy: { column: 'name', asc: true }
        }),
        loadBalance(emp.id),
        db.select('tasks', {
            select: 'id, title, status, priority, deadline, created_at, author_employee_id, assignee_employee_id, project:projects ( id, name )',
            filters: { assignee_employee_id: emp.id },
            orderBy: { column: 'created_at', asc: false }
        })
    ]);

    const me = getEmployee();

    // Те же правила видимости, что canSeeTask() в модуле задач:
    // Админ/Директор — все задачи, остальные — где сотрудник автор или исполнитель.
    const tasks = (tasksRes.data || [])
        .filter(task => {
            if (!me) return false;
            if (can('view_all_tasks')) return true;
            return task.author_employee_id === me.id || task.assignee_employee_id === me.id;
        })
        .filter(isActualTask)
        .sort(byDeadline);

    return {
        projects: projectsRes.data || [],
        balance: Number(balanceRes.balance) || 0,
        tasks
    };
}

/**
 * Отрисовывает дополнительные блоки карточки сотрудника.
 * Чистая функция: данные приходят параметрами.
 */
function renderEmployeeCardExtra({
    employeeId,
    projects = [],
    balance = 0,
    tasks = [],
    canSeeBalance = false,
    canAssignTask = false
} = {}) {
    const money = formatBalance(balance);

    const projectsBlock = `
        <div class="bg-gray-50 p-3 rounded-lg border space-y-2 text-xs">
            <p class="font-bold text-gray-500 uppercase tracking-wider">🏗 Объекты, которые ведёт: ${projects.length}</p>
            ${projects.length
                ? `<div class="space-y-1">
                       ${projects.map(project => `
                           <button type="button" onclick="window.openProjectFromEmployeeCard(${project.id})"
                                   class="w-full text-left bg-white border border-gray-200 rounded-lg px-2 py-1.5 font-semibold text-[#15803d] transition hover:bg-emerald-50">
                               🏗 ${escapeHtml(project.name)}
                           </button>
                       `).join('')}
                   </div>`
                : '<p class="italic text-gray-400">Объекты не назначены</p>'}
        </div>`;

    const balanceBlock = canSeeBalance
        ? `
        <div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex justify-between items-center gap-2 text-xs">
            <span class="font-bold text-gray-600 uppercase tracking-wider">💰 Баланс подотчёта</span>
            <span class="${money.color} font-bold text-sm">${money.icon} ${money.text}</span>
        </div>`
        : '';

    const tasksBlock = `
        <div class="bg-gray-50 p-3 rounded-lg border space-y-2 text-xs">
            <div class="flex justify-between items-center gap-2 flex-wrap">
                <p class="font-bold text-gray-500 uppercase tracking-wider">🎯 Актуальные задачи: ${tasks.length}</p>
                ${canAssignTask
                    ? `<button type="button" onclick="window.openNewTaskForm(${employeeId})"
                              class="bg-[#15803d] hover:bg-[#166534] text-white font-semibold px-3 py-1.5 rounded-lg transition shrink-0">➕ Поставить задачу</button>`
                    : ''}
            </div>
            ${tasks.length
                ? `<div class="space-y-2">${tasks.map(renderEmployeeCardTask).join('')}</div>`
                : `<p class="italic text-gray-400">${canAssignTask
                        ? 'Актуальных задач нет — можно поставить новую'
                        : 'Актуальных задач нет'}</p>`}
        </div>`;

    return projectsBlock + balanceBlock + tasksBlock;
}

/**
 * Строка задачи в карточке сотрудника (клик — карточка задачи).
 */
function renderEmployeeCardTask(task) {
    const statusInfo = getTaskStatusInfo(task.status);
    const priorityInfo = getTaskPriorityInfo(task.priority);

    const today = new Date().toISOString().split('T')[0];
    const isOverdue = !!task.deadline && task.deadline < today;

    const projectName = task.project?.name || 'Без объекта';
    const title = task.title || task.text || '—';

    return `
        <button type="button" onclick="window.openTaskFromCard(${task.id})"
                class="w-full text-left bg-white border border-gray-200 rounded-lg p-2 space-y-1 transition hover:bg-emerald-50/60">
            <div class="flex items-center gap-1 flex-wrap">
                <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${priorityInfo.bg} ${priorityInfo.color}">${priorityInfo.label}</span>
                <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${statusInfo.bg} ${statusInfo.color}">${statusInfo.label}</span>
                ${isOverdue ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700">⚠️ Просрочено</span>' : ''}
            </div>
            <p class="font-semibold text-gray-800">${escapeHtml(title)}</p>
            <p class="text-[10px] text-gray-500">🏗 ${escapeHtml(projectName)}${task.deadline ? ` · 📅 ${formatDate(task.deadline)}` : ''}</p>
        </button>`;
}

/**
 * Данные карточки догрузились — можно ли ими перерисовать блоки?
 * Пока шли запросы, карточку могли закрыть или открыть другого сотрудника,
 * поэтому данные «опоздавшего» запроса в вёрстку не пускаем.
 */
function isCardStillOpenFor(employeeId) {
    const modal = document.getElementById('employee-card-modal');
    if (!modal || modal.classList.contains('hidden')) return false;
    return employeeId === currentCardEmployeeId;
}

/**
 * Заполняет блоки карточки открытого сотрудника.
 * Вызывается при открытии карточки и после постановки задачи.
 */
export async function refreshEmployeeCardExtra() {
    const modal = document.getElementById('employee-card-modal');
    if (!modal || modal.classList.contains('hidden')) return;

    const container = document.getElementById('employee-card-extra');
    if (!container) return;

    const emp = employeesCache.find(e => e.id === currentCardEmployeeId);
    if (!emp) return;

    container.innerHTML = '<div class="app-loading app-loading-card text-sm"><span class="app-spinner" aria-hidden="true"></span><span>Загрузка данных сотрудника...</span></div>';

    const { projects, balance, tasks } = await loadEmployeeCardExtra(emp);

    if (!isCardStillOpenFor(emp.id)) return;

    container.innerHTML = renderEmployeeCardExtra({
        employeeId: emp.id,
        projects,
        balance,
        tasks,
        canSeeBalance: canSeeEmployeeBalance(emp),
        canAssignTask: canAssignTaskTo(emp)
    });
}

/**
 * Переход из карточки сотрудника в карточку объекта.
 */
function openProjectFromEmployeeCard(projectId) {
    hideModal('employee-card-modal');

    if (typeof window.openProjectDetail === 'function') {
        window.openProjectDetail(projectId);
    } else {
        toast('Карточка объекта недоступна', 'error');
    }
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
window.openProjectFromEmployeeCard = openProjectFromEmployeeCard;
window.refreshEmployeeCardExtra = refreshEmployeeCardExtra;