// =====================================================================
// МОДУЛЬ: ПОДОТЧЁТНЫЕ СРЕДСТВА
// =====================================================================
// Учёт денег, выданных сотрудникам в подотчёт.
//
// Логика:
//   - Расход — только за себя
//   - Возврат — только за себя
//   - Выдача подотчёта — кассиры (интерфейс отложен)
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, formatMoney, formatDate, escapeHtml,
    parseNumber
} from '../utils.js';
import { can, getEmployee, requirePermission } from '../permissions.js';
import { getCurrentUser } from '../auth.js';
import { CONFIG } from '../config.js';

// =====================================================================
// ФОРМАТИРОВАНИЕ БАЛАНСА
// =====================================================================

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
// БАЛАНС
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
// ОПЕРАЦИИ
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

/**
 * Загружает все расходы по разделу сметы.
 * Используется в план-факте объекта.
 */
export async function loadExpensesBySection(sectionId) {
    if (!sectionId) return { data: [], error: null };

    const { data, error } = await db.select('cash_operations', {
        filters: {
            section_id: sectionId,
            operation_type: 'expense'
        },
        orderBy: { column: 'created_at', asc: false }
    });

    if (error) {
        log.error('Ошибка загрузки расходов по разделу:', error.message);
        return { data: [], error };
    }

    // Догружаем данные сотрудников
    const ops = data || [];
    if (ops.length > 0) {
        const employeeIds = [...new Set(ops.map(o => o.employee_id).filter(Boolean))];
        if (employeeIds.length > 0) {
            const { data: employees } = await db.select('employees', {
                filters: { 'id.in': employeeIds }
            });

            const empMap = {};
            (employees || []).forEach(e => { empMap[e.id] = e; });

            ops.forEach(op => {
                op._employee = empMap[op.employee_id] || null;
            });
        }
    }

    return { data: ops, error: null };
}

/**
 * Выдача подотчёта.
 * Пока не вызывается из UI (интерфейс отложен), но функция готова.
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
 * Расход. Только за себя.
 */
export async function addExpenseMulti(payload) {
    const {
        employeeId,
        projectId,
        sectionId,
        category,
        items,
        receiptFile,
        comment
    } = payload;

    const current = getEmployee();
    const isSelf = current && current.id === employeeId;

    if (!isSelf) {
        toast('Можно вносить расход только за себя', 'error');
        return { success: false };
    }

    if (!can('cash_expense_self')) {
        toast('Нет прав на внесение расхода', 'error');
        return { success: false };
    }

    if (!items || items.length === 0) {
        toast('Добавь хотя бы одну позицию', 'error');
        return { success: false };
    }

    if (!category) {
        toast('Выбери категорию', 'error');
        return { success: false };
    }

    const totalAmount = items.reduce((sum, it) => sum + (Number(it.sum) || 0), 0);

    if (totalAmount <= 0) {
        toast('Сумма расхода должна быть больше нуля', 'error');
        return { success: false };
    }

    let receiptPath = null;
    if (receiptFile) {
        const path = `expense_${employeeId}/${Date.now()}_${sanitizeFileName(receiptFile.name)}`;
        const uploadResult = await db.uploadFile(CONFIG.STORAGE.RECEIPTS_BUCKET || 'receipts', path, receiptFile);

        if (uploadResult.error) {
            log.warn('Не удалось загрузить чек:', uploadResult.error.message);
            toast('Чек не загружен, но расход сохранён', 'warning');
        } else {
            receiptPath = uploadResult.path;
        }
    }

    return await createOperation({
        employee_id: employeeId,
        operation_type: 'expense',
        amount: totalAmount,
        category,
        project_id: projectId || null,
        section_id: sectionId || null,
        items: items,
        receipt_path: receiptPath,
        description: comment || 'Расход'
    });
}

/**
 * Возврат. Только за себя.
 */
export async function addReturn(employeeId, amount, comment = '') {
    const current = getEmployee();
    const isSelf = current && current.id === employeeId;

    if (!isSelf) {
        toast('Можно делать возврат только за себя', 'error');
        return { success: false };
    }

    if (!can('cash_return_self')) {
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
// ПРОФИЛЬ В ШАПКЕ
// =====================================================================

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
// UI — «ФИНАНСОВЫЙ ОТЧЁТ»
// =====================================================================

export async function openMyOperations() {
    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'warning');
        return;
    }

    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');

    await renderMyOperationsContent(emp);
    document.getElementById('my-operations-modal').classList.remove('hidden');
}

async function renderMyOperationsContent(emp) {
    const container = document.getElementById('my-operations-content');
    if (!container) return;

    const { data: operations } = await loadOperations(emp.id, 50);
    const { balance } = await loadBalance(emp.id);
    const formatted = formatBalance(balance);

    const opsHtml = operations.length > 0
        ? operations.map(op => renderOperationRow(op)).join('')
        : '<p class="text-center text-gray-400 italic py-6 text-sm">Операций пока нет</p>';

    const isActive = !emp.status || emp.status === 'active';
    const canExpense = can('cash_expense_self') && isActive;
    const canReturn = can('cash_return_self') && isActive;

    let buttonsHtml = '';
    if (canExpense || canReturn) {
        buttonsHtml = `
            <div class="flex flex-wrap gap-2 pt-2">
                ${canExpense ? `<button onclick="window.myOpenExpense()" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg text-sm transition shadow">🛒 Внести расход</button>` : ''}
                ${canReturn ? `<button onclick="window.myOpenReturn()" class="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-semibold py-2.5 rounded-lg text-sm transition shadow">↩️ Возврат</button>` : ''}
            </div>
        `;
    }

    container.innerHTML = `
        <div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex justify-between items-center">
            <span class="text-xs font-bold text-gray-600 uppercase">Текущий баланс</span>
            <span class="${formatted.color} font-bold text-lg">${formatted.icon} ${formatted.text}</span>
        </div>
        ${buttonsHtml}
        <div class="space-y-2 pt-2 border-t mt-2">
            <p class="text-xs font-bold text-gray-500 uppercase tracking-wider pt-2">📋 История операций</p>
            ${opsHtml}
        </div>
    `;
}

function renderOperationRow(op) {
    const typeInfo = getOperationTypeInfo(op.operation_type);
    const isIncome = op.operation_type === 'issue' || op.operation_type === 'adjustment';
    const amountClass = isIncome ? 'text-emerald-700' : 'text-red-700';
    const sign = isIncome ? '+' : '−';

    const categoryLabel = op.category ? getCategoryLabel(op.category) : '';

    let itemsHtml = '';
    if (op.operation_type === 'expense' && Array.isArray(op.items) && op.items.length > 0) {
        itemsHtml = `
            <div class="mt-2 pt-2 border-t space-y-1">
                <p class="text-[10px] font-bold text-gray-500 uppercase">Позиции:</p>
                ${op.items.map(it => `
                    <div class="flex justify-between text-[11px] text-gray-600">
                        <span>${escapeHtml(it.name)} — ${it.qty} ${escapeHtml(it.unit || '')} × ${formatMoney(it.price)}</span>
                        <span class="font-semibold">${formatMoney(it.sum)}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    const receiptHtml = op.receipt_path 
        ? `<button onclick="window.viewReceipt('${escapeHtml(op.receipt_path)}')" class="text-[10px] text-blue-600 hover:underline mt-1">📎 Просмотреть чек</button>`
        : '';

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
            ${itemsHtml}
            ${receiptHtml}
            <p class="text-[10px] text-gray-400 pt-1 border-t">
                📅 ${formatDate(op.operation_date || op.created_at)}
            </p>
        </div>
    `;
}

// =====================================================================
// КНОПКИ В КАБИНЕТЕ
// =====================================================================

export function myOpenExpense() {
    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'warning');
        return;
    }

    hideModal('my-operations-modal');
    openExpenseModal(emp.id, true);
}

export function myOpenReturn() {
    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'warning');
        return;
    }

    hideModal('my-operations-modal');
    openReturnModal(emp.id, true);
}

// =====================================================================
// МОДАЛКИ
// =====================================================================

export async function openExpenseModal(employeeId, returnToReport = false) {
    const current = getEmployee();
    const isSelf = current && current.id === employeeId;

    if (!isSelf) {
        toast('Можно вносить расход только за себя', 'error');
        return;
    }
    if (!can('cash_expense_self')) {
        toast('Нет прав на внесение расхода', 'error');
        return;
    }

    const emp = window.__getEmployeeById?.(employeeId);
    if (!emp) { toast('Сотрудник не найден', 'error'); return; }

    document.getElementById('cash-expense-employee-id').value = employeeId;
    document.getElementById('cash-expense-employee-id').dataset.returnToReport = returnToReport ? '1' : '';
    document.getElementById('cash-expense-title').textContent = `🛒 Внести расход — ${emp.name}`;

    document.getElementById('cash-expense-project').value = '';
    document.getElementById('cash-expense-section').innerHTML = '<option value="">Сначала выбери объект</option>';
    document.getElementById('cash-expense-category').value = 'materials';
    document.getElementById('cash-expense-comment').value = '';
    document.getElementById('cash-expense-receipt').value = '';

    const itemsContainer = document.getElementById('cash-expense-items');
    itemsContainer.innerHTML = '';
    addExpenseItemRow();

    await loadProjectsForSelect();
    recalcExpenseTotal();

    window.showModal('cash-expense-modal');
}

export function openReturnModal(employeeId, returnToReport = false) {
    const current = getEmployee();
    const isSelf = current && current.id === employeeId;

    if (!isSelf) {
        toast('Можно делать возврат только за себя', 'error');
        return;
    }
    if (!can('cash_return_self')) {
        toast('Нет прав на возврат', 'error');
        return;
    }

    const emp = window.__getEmployeeById?.(employeeId);
    if (!emp) { toast('Сотрудник не найден', 'error'); return; }

    document.getElementById('cash-return-employee-id').value = employeeId;
    document.getElementById('cash-return-employee-id').dataset.returnToReport = returnToReport ? '1' : '';
    document.getElementById('cash-return-title').textContent = `↩️ Возврат — ${emp.name}`;
    document.getElementById('cash-return-amount').value = '';
    document.getElementById('cash-return-comment').value = '';

    window.showModal('cash-return-modal');
}

// =====================================================================
// ФОРМА РАСХОДА
// =====================================================================

export function addExpenseItemRow() {
    const container = document.getElementById('cash-expense-items');
    if (!container) return;

    const rowId = 'item_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

    const row = document.createElement('div');
    row.className = 'expense-item-row bg-gray-50 border rounded-lg p-3 space-y-2';
    row.id = rowId;
    row.innerHTML = `
        <div class="flex gap-2 items-start">
            <div class="flex-1">
                <input type="text" placeholder="Наименование (Цемент М400)" 
                       class="item-name w-full border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
            </div>
            <button onclick="document.getElementById('${rowId}').remove(); window.recalcExpenseTotal()" 
                    class="text-red-500 hover:text-red-700 px-2 py-1 text-base font-bold">✕</button>
        </div>
        <div class="grid grid-cols-3 gap-2">
            <input type="number" step="any" placeholder="Кол-во" 
                   class="item-qty border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]"
                   oninput="window.recalcExpenseTotal()">
            <select class="item-unit border rounded-lg p-2 text-xs bg-white text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                <option value="шт">шт</option>
                <option value="м">м</option>
                <option value="кг">кг</option>
                <option value="т">т</option>
                <option value="м²">м²</option>
                <option value="м³">м³</option>
                <option value="уп">уп</option>
                <option value="л">л</option>
                <option value="меш">меш</option>
            </select>
            <input type="number" step="any" placeholder="Цена за ед." 
                   class="item-price border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]"
                   oninput="window.recalcExpenseTotal()">
        </div>
    `;
    container.appendChild(row);
    recalcExpenseTotal();
}

export function recalcExpenseTotal() {
    const rows = document.querySelectorAll('.expense-item-row');
    let total = 0;

    rows.forEach(row => {
        const qty = parseNumber(row.querySelector('.item-qty')?.value);
        const price = parseNumber(row.querySelector('.item-price')?.value);
        total += qty * price;
    });

    const totalEl = document.getElementById('cash-expense-total');
    if (totalEl) totalEl.textContent = formatMoney(total);
}

async function loadProjectsForSelect() {
    const select = document.getElementById('cash-expense-project');
    if (!select) return;

    const { data, error } = await db.select('projects', {
        orderBy: { column: 'name', asc: true }
    });

    if (error || !data) {
        select.innerHTML = '<option value="">Ошибка загрузки</option>';
        return;
    }

    select.innerHTML = '<option value="">— Выбери объект —</option>' +
        data.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

export async function loadSectionsForExpense() {
    const projectId = parseInt(document.getElementById('cash-expense-project')?.value, 10);
    const sectionSelect = document.getElementById('cash-expense-section');
    if (!sectionSelect) return;

    if (!projectId) {
        sectionSelect.innerHTML = '<option value="">Сначала выбери объект</option>';
        return;
    }

    const { data, error } = await db.select('sections', {
        filters: { project_id: projectId },
        orderBy: { column: 'id', asc: true }
    });

    if (error || !data || data.length === 0) {
        sectionSelect.innerHTML = '<option value="">Нет разделов (загрузи смету)</option>';
        return;
    }

    sectionSelect.innerHTML = '<option value="">— Выбери раздел —</option>' +
        data.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
}

// =====================================================================
// СОХРАНЕНИЕ
// =====================================================================

export async function saveExpense(event) {
    event.preventDefault();

    const employeeId = parseInt(document.getElementById('cash-expense-employee-id').value, 10);
    const returnToReport = document.getElementById('cash-expense-employee-id').dataset.returnToReport === '1';

    const projectId = parseInt(document.getElementById('cash-expense-project').value, 10) || null;
    const sectionId = parseInt(document.getElementById('cash-expense-section').value, 10) || null;
    const category = document.getElementById('cash-expense-category').value;
    const comment = document.getElementById('cash-expense-comment').value.trim();
    const receiptFile = document.getElementById('cash-expense-receipt')?.files[0] || null;

    const rows = document.querySelectorAll('.expense-item-row');
    const items = [];

    for (const row of rows) {
        const name = row.querySelector('.item-name')?.value.trim();
        const qty = parseNumber(row.querySelector('.item-qty')?.value);
        const unit = row.querySelector('.item-unit')?.value || 'шт';
        const price = parseNumber(row.querySelector('.item-price')?.value);

        if (!name) { toast('Заполни наименование во всех позициях', 'error'); return; }
        if (qty <= 0 || price <= 0) { toast('Кол-во и цена должны быть больше нуля', 'error'); return; }

        items.push({ name, qty, unit, price, sum: qty * price });
    }

    if (items.length === 0) { toast('Добавь хотя бы одну позицию', 'error'); return; }

    const result = await addExpenseMulti({
        employeeId, projectId, sectionId, category, items, receiptFile, comment
    });

    if (result.success) {
        toast(`Расход на ${formatMoney(items.reduce((s, i) => s + i.sum, 0))} сохранён`, 'success');
        window.hideModal('cash-expense-modal');

        const current = getEmployee();
        if (current && current.id === employeeId) {
            await renderProfileBalance();
        }

        if (returnToReport) {
            const emp = window.__getEmployeeById?.(employeeId);
            if (emp) {
                await renderMyOperationsContent(emp);
                document.getElementById('my-operations-modal').classList.remove('hidden');
            }
        }
    }
}

export async function saveReturn(event) {
    event.preventDefault();

    const employeeId = parseInt(document.getElementById('cash-return-employee-id').value, 10);
    const returnToReport = document.getElementById('cash-return-employee-id').dataset.returnToReport === '1';

    const amount = parseNumber(document.getElementById('cash-return-amount').value);
    const comment = document.getElementById('cash-return-comment').value.trim();

    const result = await addReturn(employeeId, amount, comment);

    if (result.success) {
        toast(`Возврат ${formatMoney(amount)} сохранён`, 'success');
        window.hideModal('cash-return-modal');

        const current = getEmployee();
        if (current && current.id === employeeId) {
            await renderProfileBalance();
        }

        if (returnToReport) {
            const emp = window.__getEmployeeById?.(employeeId);
            if (emp) {
                await renderMyOperationsContent(emp);
                document.getElementById('my-operations-modal').classList.remove('hidden');
            }
        }
    }
}

// =====================================================================
// ПРОСМОТР ЧЕКА
// =====================================================================

export async function viewReceipt(path) {
    if (!path) return;

    const { url, error } = await db.getFileUrl('receipts', path, 3600);

    if (error || !url) {
        toast('Не удалось открыть чек', 'error');
        return;
    }

    window.open(url, '_blank');
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

function sanitizeFileName(originalName) {
    const lastDot = originalName.lastIndexOf('.');
    const namePart = lastDot > 0 ? originalName.slice(0, lastDot) : originalName;
    const ext = lastDot > 0 ? originalName.slice(lastDot) : '';

    const translitMap = {
        'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
        'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
        'с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'shch',
        'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
        'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'E','Ж':'Zh','З':'Z',
        'И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R',
        'С':'S','Т':'T','У':'U','Ф':'F','Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch',
        'Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya'
    };

    let result = '';
    for (const ch of namePart) {
        if (translitMap[ch]) result += translitMap[ch];
        else if (/[a-zA-Z0-9._-]/.test(ch)) result += ch;
        else result += '_';
    }
    result = result.replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!result) result = 'receipt';
    if (result.length > 60) result = result.slice(0, 60);

    return result + ext.toLowerCase();
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.openMyOperations = openMyOperations;
window.closeMyOperations = () => {
    document.getElementById('my-operations-modal')?.classList.add('hidden');
};
window.viewReceipt = viewReceipt;
window.addExpenseItemRow = addExpenseItemRow;
window.recalcExpenseTotal = recalcExpenseTotal;
window.loadSectionsForExpense = loadSectionsForExpense;
window.myOpenExpense = myOpenExpense;
window.myOpenReturn = myOpenReturn;