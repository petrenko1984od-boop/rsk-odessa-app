// =====================================================================
// RSK ODESSA — ПРАВА ДОСТУПА
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
// Логика подотчёта:
//   - Расход/возврат — только за себя (cash_expense_self, cash_return_self)
//   - Выдача подотчёта — кассиры (cash_issue)
//   - Просмотр всех балансов — кассиры (cash_view_all)
// =====================================================================

const ROLE_PERMISSIONS = {
    'Администратор': [
        // Сотрудники
        'view_employees',
        'add_employee',
        'edit_employee',
        'block_employee',
        'restore_employee',
        'delete_employee',
        'link_account',
        'unlink_account',
        'view_tab_employees',
        // Подотчёт
        'cash_expense_self',
        'cash_return_self',
        'cash_issue',
        'cash_view_all',
        // Объекты
        'view_projects_all',
        'add_project',
        'edit_project',
        'delete_project'
    ],
    'Директор': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'cash_issue',
        'cash_view_all',
        'view_projects_all'
    ],
    'Главный инженер': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'cash_issue',
        'cash_view_all',
        'view_projects_all'
    ],
    'Снабженец': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'view_projects_all'
    ],
    'Инженер ПТО': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'view_projects_all'
    ],
    'Прораб': [
        'cash_expense_self',
        'cash_return_self',
        'view_projects_own'
    ]
};

// =====================================================================
// КАКИЕ ВКЛАДКИ ВИДНЫ ПО РОЛЯМ
// =====================================================================

const TAB_REQUIREMENTS = {
    'projects':  null,
    'employees': 'view_tab_employees',
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

export function canSeeTab(tabId) {
    const required = TAB_REQUIREMENTS[tabId];
    if (!required) return true;
    return can(required);
}

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