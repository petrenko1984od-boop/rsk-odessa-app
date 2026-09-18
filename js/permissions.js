// =====================================================================
// RSK ODESSA — ПРАВА ДОСТУПА
// =====================================================================

import { getCurrentEmployee } from './auth.js';
import { log, toast } from './utils.js';

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
        // Заявки финансов
        'process_cash_request',
        // Объекты
        'view_projects_all',
        'add_project',
        'edit_project',
        'delete_project',
        // Заявки на материалы
        'create_order',
        'process_order',
        // Задачи
        'create_task',
        'assign_task_to_employee',    // поставить задачу из карточки сотрудника
        'view_all_tasks',
        'cancel_any_task',
        // График работ и файлы
        'edit_gantt',
        'manage_files',
        // Дашборд
        'view_dashboard',
        // Вкладки
        'view_registry',
        'view_orders_tab'            // ← Снабжение
    ],
    'Директор': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'cash_issue',
        'cash_view_all',
        'process_cash_request',
        'view_projects_all',
        'view_registry',
        'create_task',
        'assign_task_to_employee',    // поставить задачу из карточки сотрудника
        'view_all_tasks',
        'view_dashboard',
        // Вкладки
        'view_orders_tab'            // ← Снабжение: директор смотрит, но заявки не создаёт
        // create_order — НЕТ (директор не создаёт заявки на материалы)
    ],
    'Главный инженер': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'cash_issue',
        'cash_view_all',
        'process_cash_request',
        'view_projects_all',
        'view_registry',
        'create_order',
        'create_task',
        'assign_task_to_employee',    // поставить задачу из карточки сотрудника
        'edit_gantt',
        'manage_files',
        'view_dashboard'
        // view_orders_tab — НЕТ
    ],
    'Снабженец': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'view_projects_all',
        'view_registry',
        'create_order',
        'process_order',
        'become_task_assignee',
        'view_orders_tab'            // ← Снабжение
    ],
    'Инженер ПТО': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'view_projects_all',
        'view_registry',
        'create_order',
        'create_task',
        'become_task_assignee',
        'edit_gantt',
        'manage_files',
        'view_dashboard'
        // view_orders_tab — НЕТ
    ],
    'Прораб': [
        // Только своё
        'cash_expense_self',
        'cash_return_self',
        'view_projects_own',
        'create_order',
        'become_task_assignee',
        'close_section',             // закрытие раздела на своём объекте
        'view_dashboard'
        // view_registry, view_orders_tab — НЕТ
    ]
};

// =====================================================================
// КАКИЕ ВКЛАДКИ ВИДНЫ ПО РОЛЯМ
// =====================================================================

const TAB_REQUIREMENTS = {
    'projects':      null,                   // Видна всем
    'employees':     'view_tab_employees',   // Только по праву
    'orders':        'view_orders_tab',      // Только Админ + Снабженец
    'cash-requests': 'cash_view_all',        // Только кассиры (Админ, Директор, Гл. инженер)
    'registry':      'view_registry'         // Только по праву
};

// =====================================================================
// УРЕЗАННЫЙ ИНТЕРФЕЙС ПО РОЛЯМ
// =====================================================================
// У некоторых ролей рабочее место — один экран, и остальные разделы только
// мешают. Здесь перечислено, что такая роль НЕ видит, как называется её
// раздел и куда она попадает после входа. Права (`ROLE_PERMISSIONS`) при этом
// не меняются — речь только о видимости разделов и кнопок. Если роли нужен
// раздел, которого у неё нет по правам, право добавляется там же, в матрице
// (так директору открыли раздел «Снабжение»: `view_orders_tab`).
const ROLE_UI = {
    'Снабженец': {
        // Остаётся: «Рабочий экран» (Снабжение) + «Реестр» + кнопка «Финансовые запросы»
        hiddenTabs:    ['tasks', 'projects', 'employees', 'cash-requests'],
        // «Заказ материалов» в шапке — дубль: заказ создаётся из «Рабочего экрана»
        hiddenButtons: ['btn-new-order'],
        // Для снабженца «Снабжение» и есть его рабочий экран
        navLabels:     { orders: '📋 Рабочий экран' },
        // После входа — сразу на рабочий экран, а не на «Добро пожаловать»
        startTab:      'orders'
    },

    'Директор': {
        // Видит все разделы, но заявок сам не оформляет: ни на материалы,
        // ни на свой подотчёт — он их согласует и выдаёт деньги.
        hiddenButtons: [
            'btn-new-order',            // «📦 Заказ материалов» в шапке
            'btn-new-cash-request',     // «💰 Финансовые запросы» в шапке
            'create-cash-request-btn'   // «➕ Создать заявку» внутри раздела «💰 Финансы»
        ]
    }
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

    if (currentRole && !ROLE_PERMISSIONS[currentRole]) {
        log.warn(`⚠️ Должность "${currentRole}" отсутствует в матрице прав — доступ по минимуму. Проверь справочник CONFIG.POSITIONS.`);
    }

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
 * Сначала учитывается урезанный интерфейс роли (ROLE_UI), потом права.
 */
export function canSeeTab(tabId) {
    const ui = ROLE_UI[currentRole];
    const hiddenTabs = (ui && ui.hiddenTabs) || [];
    if (hiddenTabs.includes(tabId)) return false;

    const required = TAB_REQUIREMENTS[tabId];
    if (!required) return true;
    return can(required);
}

/**
 * Проверяет, видна ли роль кнопка-действие (по id элемента).
 * Это кнопки-действия в шапке («Заказ материалов», «Финансовые запросы»)
 * и их дубли внутри разделов (например, «➕ Создать заявку» во вкладке
 * «💰 Финансы»): кнопки, перечисленные в ROLE_UI.hiddenButtons, скрыты.
 */
export function canSeeHeaderButton(buttonId) {
    const ui = ROLE_UI[currentRole];
    const hiddenButtons = (ui && ui.hiddenButtons) || [];
    return !hiddenButtons.includes(buttonId);
}

/**
 * Своё название раздела для роли (например, снабженец видит «Снабжение»
 * как «📋 Рабочий экран»). Возвращает null, если название стандартное.
 */
export function getNavLabel(tabId) {
    const ui = ROLE_UI[currentRole];
    if (!ui || !ui.navLabels) return null;
    return ui.navLabels[tabId] || null;
}

/**
 * Вкладка, которую роль открывает сразу после входа.
 * Возвращает null — значит показываем «Добро пожаловать».
 */
export function getStartTab() {
    const ui = ROLE_UI[currentRole];
    return (ui && ui.startTab) || null;
}

/**
 * Требует наличия права. Если нет — тост + возврат false.
 */
export function requirePermission(action) {
    if (can(action)) return true;

    toast('Недостаточно прав для этого действия', 'error');

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
    canSeeHeaderButton,
    getNavLabel,
    getStartTab,
    getRole,
    isAdmin,
    getAllPermissions
};