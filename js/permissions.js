// =====================================================================
// RSK ODESSA — ПРАВА ДОСТУПА
// =====================================================================
// Единое место для всех правил доступа.
// Использование:
//   import { loadPermissions, can, getRole, isAdmin } from './permissions.js';
//
//   await loadPermissions();      // загрузить права текущего пользователя
//   if (can('fire_employee')) ... // проверить право
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
// Ключ — должность из CONFIG.POSITIONS
// Значение — массив разрешённых действий
// =====================================================================

const ROLE_PERMISSIONS = {
    'Администратор': [
        'view_employees',
        'add_employee',
        'edit_employee',
        'block_employee',
        'fire_employee',
        'restore_employee',
        'delete_employee',
        'link_account',
        'unlink_account'
    ],
    'Директор': [
        'view_employees'
    ],
    // Все остальные — только просмотр
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
        // Пользователь не привязан к сотруднику → минимальные права
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

/**
 * Проверяет, есть ли у текущего пользователя право.
 * @param {string} action — например 'fire_employee'
 * @returns {boolean}
 */
export function can(action) {
    if (!currentRole) return false;
    const permissions = ROLE_PERMISSIONS[currentRole] || [];
    return permissions.includes(action);
}

/**
 * Возвращает текущую роль.
 */
export function getRole() {
    return currentRole;
}

/**
 * Возвращает объект текущего сотрудника (или null).
 */
export function getEmployee() {
    return currentEmployee;
}

/**
 * Проверяет, является ли текущий пользователь Администратором.
 */
export function isAdmin() {
    return currentRole === 'Администратор';
}

/**
 * Проверяет, привязан ли текущий пользователь к сотруднику.
 */
export function isLinked() {
    return currentEmployee !== null;
}

/**
 * Требует наличия права. Если нет — показывает тост и возвращает false.
 * Используй в начале защищённых действий:
 *
 *   export async function deleteEmployee(id) {
 *       if (!requirePermission('delete_employee')) return;
 *       // ... код удаления
 *   }
 */
export function requirePermission(action) {
    if (can(action)) return true;

    // Динамический импорт toast, чтобы избежать циклических зависимостей
    import('./utils.js').then(({ toast }) => {
        toast('Недостаточно прав для этого действия', 'error');
    });

    log.warn(`❌ Отказано в доступе: ${action}. Роль: ${currentRole || 'не привязан'}`);
    return false;
}

// =====================================================================
// СПИСОК ВСЕХ ДЕЙСТВИЙ (для отладки и UI)
// =====================================================================

export function getAllPermissions() {
    if (!currentRole) return [];
    return ROLE_PERMISSIONS[currentRole] || [];
}

// Отладка
window.Permissions = {
    can,
    getRole,
    isAdmin,
    getAllPermissions
};