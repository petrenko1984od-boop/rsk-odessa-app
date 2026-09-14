// =====================================================================
// RSK ODESSA — ПРАВА ДОСТУПА
// =====================================================================
// Единое место для всех правил доступа.
// =====================================================================

import { getCurrentEmployee } from './auth.js';
import { log } from './utils.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let currentRole = null;
let currentEmployee = null;

// =====================================================================
// МАТРИЦА ПРАВ ПО РОЛЯМ
// =====================================================================

const ROLE_PERMISSIONS = {
    'Администратор': [
        'view_employees',
        'add_employee',
        'edit_employee',
        'block_employee',
        'restore_employee',
        'delete_employee',
        'link_account',
        'unlink_account',
        'view_tab_employees'      // ← Видит вкладку «Сотрудники»
    ],
    'Директор': [
        'view_employees',
        'view_tab_employees'      // ← Видит вкладку, но не управляет
    ],
    'Главный инженер': [
        'view_employees',
        'view_tab_employees'
    ],
    'Снабженец': [
        'view_employees',
        'view_tab_employees'
    ],
    'Инженер ПТО': [
        'view_employees',
        'view_tab_employees'
    ],
    'Прораб': [
        // Прораб НЕ видит вкладку «Сотрудники»
        // Свою карточку смотрит через профиль в шапке
    ]
};

// =====================================================================
// КАКИЕ ВКЛАДКИ ВИДНЫ ПО РОЛЯМ
// =====================================================================
// Вкладка видна, если в её правах есть указанное разрешение.
// =====================================================================

const TAB_REQUIREMENTS = {
    'projects':  null,              // Видна всем
    'employees': 'view_tab_employees', // Только по правам
    'orders':    null,
    'registry':  null,
    'new-order': null
};

// =====================================================================
// ЗАГРУЗКА ПРАВ
// =====================================================================

export async function loadPermissions() {
    const { employee, error } = await getCurrentEmployee();

    if (error || !employee) {
        currentRole = null;
        currentEmployee = null;
        log.warn('⚠️ Пользователь не привязан к сотруднику. Права: минимум.');
        return;
    }

    currentEmployee = employee;
    currentRole = employee.position || null;
    log.auth(`Права загружены. Роль: ${currentRole}`);
}

// =====================================================================
// ПРОВЕРКА ПРАВ
// =====================================================================

export function can(action) {
    if (!currentRole) return false;
    const permissions = ROLE_PERMISSIONS[currentRole] || [];
    return permissions.includes(action);
}

export function getRole() {
    return currentRole;
}

export function getEmployee() {
    return currentEmployee;
}

export function isAdmin() {
    return currentRole === 'Администратор';
}

export function isLinked() {
    return currentEmployee !== null;
}

/**
 * Проверяет, может ли текущий пользователь ВИДЕТЬ вкладку.
 * Используется для скрытия кнопок в шапке.
 */
export function canSeeTab(tabId) {
    const required = TAB_REQUIREMENTS[tabId];
    if (!required) return true; // Вкладка без требований — видна всем
    return can(required);
}

/**
 * Требует наличия права. Если нет — тост + возврат false.
 */
export function requirePermission(action) {
    if (can(action)) return true;

    import('./utils.js').then(({ toast }) => {
        toast('Недостаточно прав для этого действия', 'error');
    });

    log.warn(`❌ Отказано в доступе: ${action}. Роль: ${currentRole || 'не привязан'}`);
    return false;
}

export function getAllPermissions() {
    if (!currentRole) return [];
    return ROLE_PERMISSIONS[currentRole] || [];
}

// Отладка через консоль
window.Permissions = {
    can,
    canSeeTab,
    getRole,
    isAdmin,
    getAllPermissions
};