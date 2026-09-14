// =====================================================================
// RSK ODESSA — ПРАВА ДОСТУПА
// =====================================================================
// Единое место для всех правил доступа.
//
// Использование:
//   import { loadPermissions, can, getRole, isAdmin } from './permissions.js';
//
//   await loadPermissions();
//   if (can('block_employee')) ...
// =====================================================================

import { getCurrentEmployee } from './auth.js';
import { log } from './utils.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let currentRole = null;      // 'Администратор' | 'Директор' | 'Прораб' | ...
let currentEmployee = null;  // объект сотрудника или null

// =====================================================================
// МАТРИЦА ПРАВ ПО РОЛЯМ
// =====================================================================

const ROLE_PERMISSIONS = {
    'Администратор': [
        'view_employees',
        'add_employee',
        'edit_employee',
        'block_employee',      // Блокировка (замена увольнения)
        'restore_employee',    // Восстановление
        'delete_employee',     // Полное удаление
        'link_account',        // Привязка аккаунта
        'unlink_account'       // Отвязка аккаунта
    ],
    'Директор': [
        'view_employees'
    ],
    'Главный инженер': ['view_employees'],
    'Прораб':          ['view_employees'],
    'Снабженец':       ['view_employees'],
    'Инженер ПТО':     ['view_employees']
};

// =====================================================================
// ЗАГРУЗКА ПРАВ
// =====================================================================

/**
 * Загружает текущего сотрудника и определяет его роль.
 * Вызывается один раз после логина.
 */
export async function loadPermissions() {
    const { employee, error } = await getCurrentEmployee();

    if (error || !employee) {
        currentRole = null;
        currentEmployee = null;
        log.warn('⚠️ Пользователь не привязан к сотруднику. Права: только просмотр.');
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
    getRole,
    isAdmin,
    getAllPermissions
};