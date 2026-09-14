// =====================================================================
// МОДУЛЬ: СОТРУДНИКИ
// =====================================================================
// Всё, что связано с разделом «Сотрудники»:
//   - Загрузка из Supabase
//   - Отображение карточками
//   - Добавление / просмотр / редактирование
//   - Блокировка / увольнение (soft delete)
//   - Привязка Auth-пользователя к записи
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    getFormData, formatDate, getPaymentStatusBadge
} from '../utils.js';
import { CONFIG } from '../config.js';
import {
    getCurrentUser, linkUserToEmployee as linkUserAuth
} from '../auth.js';

// =====================================================================
// СОСТОЯНИЕ МОДУЛЯ
// =====================================================================

let employeesCache = [];
let currentCardId = null;

// =====================================================================
// ЗАГРУЗКА СПИСКА СОТРУДНИКОВ
// =====================================================================

export async function loadEmployees() {
    log.info('Загрузка сотрудников из Supabase...');

    const { data, error } = await db.select('employees', {
        orderBy: { column: 'name', asc: true }
    });

    if (error) {
        log.error('Не удалось загрузить сотрудников:', error.message);
        toast('Ошибка загрузки сотрудников', 'error');
        return;
    }

    employeesCache = data || [];
    log.info(`Загружено сотрудников: ${employeesCache.length}`);
    renderEmployees();
    updateEmployeesBadge();
}

// =====================================================================
// ОТРИСОВКА СПИСКА
// =====================================================================

export function renderEmployees() {
    const container = document.getElementById('employees-container');
    if (!container) return;

    if (employeesCache.length === 0) {
        container.innerHTML = `
            <div class="col-span-2 bg-white rounded-xl shadow-sm border-2 border-dashed border-gray-300 p-8 text-center space-y-2">
                <div class="text-5xl">👥</div>
                <h3 class="font-bold text-gray-700">Список сотрудников пуст</h3>
                <p class="text-sm text-gray-500">Нажми «➕ Добавить сотрудника», чтобы создать первого.</p>
            </div>
        `;
        return;
    }

    // Группируем: сначала активные, потом заблокированные, потом уволенные
    const active = employeesCache.filter(e => !e.status || e.status === 'active');
    const blocked = employeesCache.filter(e => e.status === 'blocked');
    const fired = employeesCache.filter(e => e.status === 'fired');

    const sorted = [...active, ...blocked, ...fired];

    container.innerHTML = sorted.map(emp => renderEmployeeCard(emp)).join('');
}

function renderEmployeeCard(emp) {
    const status = emp.status || 'active';

    let statusBadge = '';
    let cardBorder = 'border-[#15803d]';
    let cardOpacity = '';

    if (status === 'blocked') {
        statusBadge = `<span class="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold">🟡 Заблокирован</span>`;
        cardBorder = 'border-amber-400';
    } else if (status === 'fired') {
        statusBadge = `<span class="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded font-bold">🚫 Уволен</span>`;
        cardBorder = 'border-red-400';
        cardOpacity = 'opacity-70';
    } else {
        statusBadge = `<span class="text-[10px] bg-green-100 text-green-800 px-2 py-0.5 rounded font-bold">🟢 Активен</span>`;
    }

    const initials = getInitials(emp.name);

    return `
        <button onclick="window.openEmployeeCard(${emp.id})"
                class="w-full text-left bg-white rounded-xl shadow-sm border p-4 flex gap-4 items-start border-l-4 ${cardBorder} ${cardOpacity} hover:bg-emerald-50/50 transition cursor-pointer group">
            <div class="w-12 h-12 rounded-full bg-[#15803d] text-white flex items-center justify-center text-base font-bold shrink-0">
                ${initials}
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
// ДОБАВЛЕНИЕ СОТРУДНИКА
// =====================================================================

export function openAddEmployeeModal() {
    // Заполняем справочник должностей
    const posSelect = document.getElementById('emp-position');
    if (posSelect) {
        posSelect.innerHTML = CONFIG.POSITIONS
            .map(p => `<option value="${p}">${p}</option>`)
            .join('');
    }

    // Сбрасываем форму
    document.getElementById('employee-form').reset();
    showModal('employee-modal');
}

export async function saveNewEmployee(event) {
    event.preventDefault();

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняем...';

    const name = document.getElementById('emp-name').value.trim();
    const position = document.getElementById('emp-position').value;
    const phone = document.getElementById('emp-phone').value.trim();
    const notes = document.getElementById('emp-notes').value.trim();

    if (!name || !position || !phone) {
        toast('Заполни обязательные поля', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Сохранить';
        return;
    }

    const { data, error } = await db.insert('employees', {
        name, position, phone, notes,
        status: 'active'
    });

    submitBtn.disabled = false;
    submitBtn.textContent = '💾 Сохранить';

    if (error) {
        log.error('Ошибка добавления сотрудника:', error.message);
        toast('Не удалось сохранить: ' + error.message, 'error');
        return;
    }

    log.info('Сотрудник добавлен:', data);
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
    if (!emp) {
        toast('Сотрудник не найден', 'error');
        return;
    }

    currentCardId = id;
    const container = document.getElementById('employee-card-content');
    const status = emp.status || 'active';

    let statusInfo = '';
    if (status === 'fired') {
        statusInfo = `
            <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-xs space-y-1">
                <p class="font-bold text-red-700">🚫 Уволен</p>
                ${emp.deactivated_at ? `<p class="text-gray-600">Дата: ${formatDate(emp.deactivated_at)}</p>` : ''}
                ${emp.deactivation_reason ? `<p class="text-gray-600">Причина: ${escapeHtml(emp.deactivation_reason)}</p>` : ''}
            </div>
        `;
    } else if (status === 'blocked') {
        statusInfo = `
            <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs space-y-1">
                <p class="font-bold text-amber-800">🟡 Заблокирован</p>
                ${emp.deactivated_at ? `<p class="text-gray-600">Дата: ${formatDate(emp.deactivated_at)}</p>` : ''}
                ${emp.deactivation_reason ? `<p class="text-gray-600">Причина: ${escapeHtml(emp.deactivation_reason)}</p>` : ''}
            </div>
        `;
    }

    const user = await getCurrentUser();
    const isMyAccount = user?.user?.id && emp.user_id === user.user.id;
    const canLink = !emp.user_id && status === 'active';

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
        </div>

        ${statusInfo}

        ${isMyAccount ? `
            <div class="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs">
                <p class="font-bold text-blue-800">🔗 Это твой аккаунт</p>
                <p class="text-gray-600 mt-1">Привязан к ${escapeHtml(user.user.email)}</p>
            </div>
        ` : ''}
    `;

    // Кнопки в футере карточки
    const deleteBtn = document.getElementById('card-emp-delete-btn');
    deleteBtn.onclick = () => confirmDeleteEmployee(emp.id, emp.name);

    // Кнопки управления в карточке
    renderCardActions(emp);

    showModal('employee-card-modal');
}

function renderCardActions(emp) {
    const container = document.getElementById('employee-card-content');
    const status = emp.status || 'active';
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'pt-3 border-t flex flex-wrap gap-2';

    let buttonsHTML = '';

    if (status === 'active') {
        if (!emp.user_id) {
            buttonsHTML += `<button onclick="window.linkMyAccount(${emp.id})" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition">🔗 Привязать мой аккаунт</button>`;
        }
        buttonsHTML += `<button onclick="window.openDeactivateModal(${emp.id}, 'blocked')" class="bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold px-3 py-2 rounded-lg transition">🟡 Заблокировать</button>`;
        buttonsHTML += `<button onclick="window.openDeactivateModal(${emp.id}, 'fired')" class="bg-red-600 hover:bg-red-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition">🚫 Уволить</button>`;
    } else {
        buttonsHTML += `<button onclick="window.restoreEmployee(${emp.id})" class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-3 py-2 rounded-lg transition">♻️ Восстановить</button>`;
    }

    actionsDiv.innerHTML = buttonsHTML;
    container.appendChild(actionsDiv);
}

// =====================================================================
// ДЕАКТИВАЦИЯ (БЛОКИРОВКА / УВОЛЬНЕНИЕ)
// =====================================================================

export function openDeactivateModal(id, action) {
    const emp = employeesCache.find(e => e.id === id);
    if (!emp) return;

    document.getElementById('deactivate-emp-id').value = id;
    document.getElementById('deactivate-action').value = action;
    document.getElementById('deactivate-reason').value = '';
    document.getElementById('deactivate-title').textContent =
        action === 'fired' ? '🚫 Увольнение сотрудника' : '🟡 Блокировка сотрудника';

    hideModal('employee-card-modal');
    showModal('deactivate-modal');
}

export async function confirmDeactivate(event) {
    event.preventDefault();

    const id = parseInt(document.getElementById('deactivate-emp-id').value);
    const action = document.getElementById('deactivate-action').value;
    const reason = document.getElementById('deactivate-reason').value.trim();

    const updates = {
        status: action,
        deactivated_at: new Date().toISOString(),
        deactivation_reason: reason || null
    };

    const { error } = await db.update('employees', updates, { id });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    const emp = employeesCache.find(e => e.id === id);
    toast(action === 'fired' ? `${emp.name} уволен` : `${emp.name} заблокирован`, 'success');

    hideModal('deactivate-modal');
    await loadEmployees();
}

export async function restoreEmployee(id) {
    if (!confirm('Восстановить сотрудника?')) return;

    const { error } = await db.update('employees', {
        status: 'active',
        deactivated_at: null,
        deactivation_reason: null
    }, { id });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    toast('Сотрудник восстановлен', 'success');
    hideModal('employee-card-modal');
    await loadEmployees();
}

// =====================================================================
// ПРИВЯЗКА АККАУНТА
// =====================================================================

export async function linkMyAccount(id) {
    const emp = employeesCache.find(e => e.id === id);
    if (!emp) return;

    if (!confirm(`Привязать твой аккаунт к "${emp.name}"?`)) return;

    const result = await linkUserAuth(id);

    if (!result.success) {
        toast('Ошибка привязки: ' + result.error.message, 'error');
        return;
    }

    toast(`Аккаунт привязан к ${emp.name}`, 'success');
    hideModal('employee-card-modal');
    await loadEmployees();
}

// =====================================================================
// УДАЛЕНИЕ
// =====================================================================

async function confirmDeleteEmployee(id, name) {
    if (!confirm(`УДАЛИТЬ "${name}" навсегда?\n\nВнимание: если у сотрудника есть объекты/заявки, они потеряют связь. Рекомендуется использовать "Уволить" вместо удаления.`)) {
        return;
    }

    const { error } = await db.remove('employees', { id });

    if (error) {
        toast('Ошибка удаления: ' + error.message, 'error');
        return;
    }

    toast('Сотрудник удалён', 'success');
    hideModal('employee-card-modal');
    await loadEmployees();
}

// =====================================================================
// ОБНОВЛЕНИЕ БЕЙДЖА В ШАПКЕ
// =====================================================================

export function updateEmployeesBadge() {
    const badge = document.getElementById('employees-badge');
    if (badge) badge.textContent = employeesCache.length;
}

// =====================================================================
// ЭКСПОРТ ГЛОБАЛЬНЫХ ФУНКЦИЙ (для onclick в HTML)
// =====================================================================

window.openEmployeeCard = openEmployeeCard;
window.openDeactivateModal = openDeactivateModal;
window.restoreEmployee = restoreEmployee;
window.linkMyAccount = linkMyAccount;
window.openAddEmployeeModal = openAddEmployeeModal;
window.saveNewEmployee = saveNewEmployee;
window.confirmDeactivate = confirmDeactivate;