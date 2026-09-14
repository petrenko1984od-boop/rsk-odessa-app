// =====================================================================
// МОДУЛЬ: ПОДОТЧЁТНЫЕ СРЕДСТВА
// =====================================================================
// Учёт денег, выданных сотрудникам в подотчёт.
//
// Типы операций:
//   - issue      (выдача)         → + к балансу
//   - expense    (расход)         → − к балансу
//   - return     (возврат)        → − к балансу
//   - adjustment (корректировка)  → + к балансу
// =====================================================================

import { db } from '../database.js';
import { log, toast, formatMoney, formatDate, escapeHtml } from '../utils.js';
import { can, getEmployee, requirePermission } from '../permissions.js';
import { getCurrentUser } from '../auth.js';

// =====================================================================
// ФОРМАТИРОВАНИЕ БАЛАНСА
// =====================================================================

/**
 * Форматирует баланс с цветовой индикацией.
 */
export function formatBalance(balance) {
    const value = Number(balance) || 0;

    if (value > 0) {
        return { text: formatMoney(value), color: 'text-emerald-700', icon: '🟢' };
    }
    if (value < 0) {
        return { text: formatMoney(Math.abs(value)) + ' (долг)', color: 'text-red-700', icon: '🔴' };
    }
    return { text: formatMoney(0), color: 'text-gray-500', icon: '⚪' };
}

// =====================================================================
// ЗАГРУЗКА БАЛАНСА
// =====================================================================

export async function loadBalance(employeeId) {
    const { data, error } = await db.select('employee_cash_balance', {
        filters: { employee_id: employeeId },
        single: true
    });

    if (error) {
        log.error(`Ошибка загрузки баланса для #${employeeId}:`, error.message);
        return { balance: 0, error };
    }

    return { balance: data?.balance || 0, error: null };
}

export async function loadAllBalances() {
    const { data, error } = await db.select('employee_cash_balance', {
        orderBy: { column: 'name', asc: true }
    });

    if (error) {
        log.error('Ошибка загрузки балансов:', error.message);
        return { data: [], error };
    }

    return { data: data || [], error: null };
}

// =====================================================================
// ЗАГРУЗКА ИСТОРИИ ОПЕРАЦИЙ
// =====================================================================

export async function loadOperations(employeeId, limit = 50) {
    const { data, error } = await db.select('cash_operations', {
        filters: { employee_id: employeeId },
        orderBy: { column: 'created_at', asc: false },
        limit
    });

    if (error) {
        log.error('Ошибка загрузки операций:', error.message);
        return { data: [], error };
    }

    return { data: data || [], error: null };
}

// =====================================================================
// СОЗДАНИЕ ОПЕРАЦИЙ
// =====================================================================

/**
 * Выдаёт подотчёт (issue). Только для кассира.
 */
export async function addIssue(employeeId, amount, comment = '') {
    if (!requirePermission('cash_issue')) return { success: false };

    const sum = Number(amount);
    if (!sum || sum <= 0) {
        toast('Сумма должна быть больше нуля', 'error');
        return { success: false };
    }

    return await createOperation({
        employee_id: employeeId,
        operation_type: 'issue',
        amount: sum,
        description: comment || 'Выдача подотчёта'
    });
}

/**
 * Вносит расход (expense).
 */
export async function addExpense(employeeId, amount, category, projectId, sectionId, comment = '') {
    const current = getEmployee();
    const isSelf = current && current.id === employeeId;

    if (!can('cash_expense_any') && !(can('cash_expense_self') && isSelf)) {
        toast('Нет прав на внесение расхода', 'error');
        return { success: false };
    }

    const sum = Number(amount);
    if (!sum || sum <= 0) {
        toast('Сумма должна быть больше нуля', 'error');
        return { success: false };
    }

    if (!category) {
        toast('Выбери категорию расхода', 'error');
        return { success: false };
    }

    return await createOperation({
        employee_id: employeeId,
        operation_type: 'expense',
        amount: sum,
        category,
        project_id: projectId || null,
        section_id: sectionId || null,
        description: comment || 'Расход'
    });
}

/**
 * Возврат в кассу (return).
 */
export async function addReturn(employeeId, amount, comment = '') {
    const current = getEmployee();
    const isSelf = current && current.id === employeeId;

    if (!can('cash_return_any') && !(can('cash_return_self') && isSelf)) {
        toast('Нет прав на возврат', 'error');
        return { success: false };
    }

    const sum = Number(amount);
    if (!sum || sum <= 0) {
        toast('Сумма должна быть больше нуля', 'error');
        return { success: false };
    }

    return await createOperation({
        employee_id: employeeId,
        operation_type: 'return',
        amount: sum,
        description: comment || 'Возврат в кассу'
    });
}

/**
 * Внутренняя: создаёт запись в cash_operations.
 */
async function createOperation(payload) {
    const { user } = await getCurrentUser();

    const fullPayload = {
        ...payload,
        created_by: user?.id || null,
        operation_date: new Date().toISOString().split('T')[0]
    };

    const { data, error } = await db.insert('cash_operations', fullPayload);

    if (error) {
        log.error('Ошибка создания операции:', error.message);
        toast('Ошибка: ' + error.message, 'error');
        return { success: false, error };
    }

    log.info('Операция создана:', data);
    return { success: true, data };
}

// =====================================================================
// UI — БАЛАНС В ПРОФИЛЕ
// =====================================================================

/**
 * Обновляет отображение баланса в dropdown профиля (#profile-balance).
 */
export async function renderProfileBalance() {
    const emp = getEmployee();
    if (!emp) return;

    const el = document.getElementById('profile-balance');
    if (!el) return;

    const { balance } = await loadBalance(emp.id);
    const formatted = formatBalance(balance);

    el.innerHTML = `
        <span class="text-xs text-gray-500">💰 Баланс:</span>
        <span class="${formatted.color} font-bold text-sm ml-1">${formatted.icon} ${formatted.text}</span>
    `;
}

// =====================================================================
// UI — МОДАЛКА «ФИНАНСОВЫЙ ОТЧЁТ»
// =====================================================================

export async function openMyOperations() {
    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'warning');
        return;
    }

    // Закрываем dropdown профиля
    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');

    const { data: operations } = await loadOperations(emp.id, 50);
    const { balance } = await loadBalance(emp.id);
    const formatted = formatBalance(balance);

    const opsHtml = operations.length > 0
        ? operations.map(op => renderOperationRow(op)).join('')
        : '<p class="text-center text-gray-400 italic py-6 text-sm">Операций пока нет</p>';

    const content = document.getElementById('my-operations-content');
    if (!content) return;

    content.innerHTML = `
        <div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex justify-between items-center">
            <span class="text-xs font-bold text-gray-600 uppercase">Текущий баланс</span>
            <span class="${formatted.color} font-bold text-lg">${formatted.icon} ${formatted.text}</span>
        </div>
        <div class="space-y-2 pt-2">
            ${opsHtml}
        </div>
    `;

    document.getElementById('my-operations-modal').classList.remove('hidden');
}

/**
 * Рендер одной строки операции.
 */
function renderOperationRow(op) {
    const typeInfo = getOperationTypeInfo(op.operation_type);
    const isIncome = op.operation_type === 'issue' || op.operation_type === 'adjustment';
    const amountClass = isIncome ? 'text-emerald-700' : 'text-red-700';
    const sign = isIncome ? '+' : '−';

    const categoryLabel = op.category ? getCategoryLabel(op.category) : '';

    return `
        <div class="bg-white border rounded-lg p-3 text-xs space-y-1">
            <div class="flex justify-between items-start gap-2">
                <div class="flex-1">
                    <p class="font-semibold text-gray-800">
                        ${typeInfo.icon} ${escapeHtml(typeInfo.label)}
                        ${categoryLabel ? `<span class="text-[10px] bg-gray-100 px-1.5 py-0.5 rounded ml-1">${categoryLabel}</span>` : ''}
                    </p>
                    <p class="text-gray-500 text-[11px] mt-0.5">${escapeHtml(op.description || '—')}</p>
                </div>
                <span class="${amountClass} font-bold whitespace-nowrap">${sign} ${formatMoney(op.amount)}</span>
            </div>
            <p class="text-[10px] text-gray-400 pt-1 border-t">
                📅 ${formatDate(op.operation_date || op.created_at)}
            </p>
        </div>
    `;
}

// =====================================================================
// ХЕЛПЕРЫ
// =====================================================================

export function getOperationTypeInfo(type) {
    const map = {
        'issue':      { label: 'Выдача подотчёта', icon: '💵' },
        'expense':    { label: 'Расход',           icon: '🛒' },
        'return':     { label: 'Возврат в кассу',  icon: '↩️' },
        'adjustment': { label: 'Корректировка',    icon: '⚙️' }
    };
    return map[type] || { label: type, icon: '❓' };
}

export function getCategoryLabel(cat) {
    const map = {
        'materials': '📦 Материалы',
        'works':     '🛠 Работы',
        'delivery':  '🚚 Доставка',
        'other':     '📋 Прочее'
    };
    return map[cat] || cat;
}

// =====================================================================
// ЭКСПОРТ ГЛОБАЛЬНЫХ ФУНКЦИЙ
// =====================================================================

window.openMyOperations = openMyOperations;
window.closeMyOperations = () => {
    document.getElementById('my-operations-modal')?.classList.add('hidden');
};