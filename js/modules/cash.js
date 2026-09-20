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
    parseNumber, roundMoney, isExtraSectionName, todayISO
} from '../utils.js';
import { can, getEmployee, getRole, requirePermission } from '../permissions.js';
import { getCurrentUser } from '../auth.js';
import { CONFIG } from '../config.js';
import { t } from '../i18n.js';
import { fillSectionsSelect } from './sections.js';

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
// ОПЕРАЦИИ (история)
// =====================================================================

/**
 * История операций сотрудника.
 *
 * Вложенные выборки project/section нужны «Авансовому отчёту»: по объекту
 * работает фильтр, а в Excel выгружается читаемое название, а не id.
 * Синтаксис тот же, что в `loadRegistry()` для этой же таблицы.
 */
export async function loadOperations(employeeId, limit = 50) {
    const { data, error } = await db.select('cash_operations', {
        select: `
            id, employee_id, operation_type, amount, description, category, items,
            project_id, section_id, order_id, source, receipt_path,
            operation_date, created_at,
            project:projects ( id, name ),
            section:sections ( id, name )
        `,
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
// ФАКТ ПО ОБЪЕКТУ (для план-факта)
// =====================================================================
// Загружает ВСЕ источники факта для объекта:
//   1. cash_operations (расходы из кабинета + заявки, оплаченные сотрудником)
//   2. order_items (заявки с оплатой фирмой — closed + archived)
//
// Возвращает map: { [section_id]: [operations] } по разделам СМЕТЫ
// и отдельный массив extraOps — траты, привязанные к служебному разделу
// «Доп. расходы» (вне сметы). Их нельзя подмешивать в план-факт: там раздел
// считается «как в смете», а незапланированные траты видны на подвкладке
// «📦 Доп. расходы» карточки объекта (js/modules/extra-costs.js).
//
// ⚠️ .in фильтр не работает — грузим всё, фильтруем в JS.
// =====================================================================

export async function loadExpensesForProject(projectId) {
    if (!projectId) return { map: {}, data: [], extraOps: [], error: null };

    const allItems = [];

    // ----- 1. Загружаем разделы объекта -----
    const { data: allSections, error: secError } = await db.select('sections', {
        select: 'id, name',
        filters: { project_id: projectId }
    });

    if (secError) {
        log.error('Ошибка загрузки разделов:', secError.message);
        return { map: {}, data: [], extraOps: [], error: secError };
    }

    const projectSectionIds = (allSections || []).map(s => s.id);
    const extraSectionIds = (allSections || [])
        .filter(s => isExtraSectionName(s.name))
        .map(s => s.id);

    if (projectSectionIds.length === 0) {
        return { map: {}, data: [], extraOps: [], error: null };
    }

    // ----- 2. Загружаем расходы ТОЛЬКО по разделам этого объекта -----
    // (фильтр 'section_id.in' выполняется на стороне БД, а не выкачиванием всей таблицы)
    const { data: allExpenses, error: expError } = await db.select('cash_operations', {
        filters: {
            operation_type: 'expense',
            'section_id.in': projectSectionIds
        }
    });

    if (expError) {
        log.error('Ошибка загрузки расходов:', expError.message);
    }

    // Страховка: сервер уже отфильтровал, но проверим ещё раз
    const projectExpenses = (allExpenses || []).filter(exp =>
        exp.section_id && projectSectionIds.includes(exp.section_id)
    );

    // Догружаем сотрудников
    if (projectExpenses.length > 0) {
        const employeeIds = [...new Set(projectExpenses.map(o => o.employee_id).filter(Boolean))];
        if (employeeIds.length > 0) {
            const { data: allEmployees } = await db.select('employees', {
                select: 'id, name',
                filters: { 'id.in': employeeIds }
            });
            const empMap = {};
            (allEmployees || []).forEach(e => {
                empMap[e.id] = e;
            });
            projectExpenses.forEach(op => {
                op._employee = empMap[op.employee_id] || null;
            });
        }

        projectExpenses.forEach(exp => {
            allItems.push({
                ...exp,
                _source: exp.source === 'order' ? 'order_employee' : 'expense'
            });
        });
    }

    // ----- 3. Загружаем заявки с оплатой ФИРМОЙ -----
    const { data: allOrders, error: ordersError } = await db.select('orders', {
        filters: { payment_source: 'company' }
    });

    if (ordersError) {
        log.error('Ошибка загрузки заявок:', ordersError.message);
    }

    // Фильтруем: delivered + closed + archived + нужный объект
    const firmOrders = (allOrders || []).filter(o =>
        (o.status === 'delivered' || o.status === 'closed' || o.status === 'archived') &&
        o.project_id === projectId
    );

    if (firmOrders.length > 0) {
        // Позиции грузим только по нужным заявкам (фильтр на сервере)
        const orderIds = firmOrders.map(o => o.id);
        const { data: allOrderItems } = await db.select('order_items', {
            filters: { 'order_id.in': orderIds }
        });

        const orderMap = {};
        firmOrders.forEach(o => { orderMap[o.id] = o; });

        const firmOrderItems = (allOrderItems || []).filter(it =>
            orderMap[it.order_id]
        );

        // Загружаем создателей заявок (для отображения)
        const creatorIds = [...new Set(firmOrders.map(o => o.created_by_employee_id).filter(Boolean))];
        let creatorsMap = {};
        if (creatorIds.length > 0) {
            const { data: allEmployees } = await db.select('employees', {
                select: 'id, name',
                filters: { 'id.in': creatorIds }
            });
            (allEmployees || []).forEach(e => {
                creatorsMap[e.id] = e;
            });
        }

        // Преобразуем каждую позицию заявки в "псевдо-операцию"
        firmOrderItems.forEach(it => {
            const order = orderMap[it.order_id];
            if (!order) return;

            allItems.push({
                _source: 'order',
                _orderId: order.id,
                _orderNumber: order.request_number,
                _isOrderItem: true,
                id: `order_${it.id}`,
                employee_id: null,
                _employee: creatorsMap[order.created_by_employee_id] || null,
                operation_type: 'expense',
                category: 'materials',
                project_id: order.project_id,
                section_id: order.section_id,
                amount: Number(it.total_price) || 0,
                items: [{
                    name: it.name,
                    qty: it.qty,
                    unit: it.unit,
                    price: it.unit_price || 0,
                    sum: it.total_price || 0
                }],
                description: `Заявка ${order.request_number}`,
                operation_date: order.closed_at || order.created_at,
                supplier: order.supplier,
                receipt_path: null
            });
        });
    }

    // ----- 4. Группируем: разделы сметы — в map, «Доп. расходы» — в extraOps -----
    const map = {};
    (allSections || [])
        .filter(section => !isExtraSectionName(section.name))
        .forEach(section => { map[section.id] = []; });

    const extraOps = [];

    allItems.forEach(item => {
        if (!item.section_id) return;
        if (extraSectionIds.includes(item.section_id)) {
            extraOps.push(item);
            return;
        }
        if (!map[item.section_id]) map[item.section_id] = [];
        map[item.section_id].push(item);
    });

    log.db(`Загружено для объекта #${projectId}: ${allItems.length} записей факта (вне сметы: ${extraOps.length})`);

    return { map, data: allItems, extraOps, error: null };
}

// =====================================================================
// СОЗДАНИЕ ОПЕРАЦИЙ
// =====================================================================

/**
 * Выдача подотчёта (для будущего интерфейса кассира).
 * @param {number} employeeId — кому выдаём
 * @param {number} amount — сумма
 * @param {string} comment — комментарий
 * @param {string|null} source — пометка операции (например 'financier_topup'):
 *   по ней ведомость отличает пополнение подотчёта финансиста от обычной выдачи.
 */
export async function addIssue(employeeId, amount, comment = '', source = null) {
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
        description: comment || 'Выдача подотчёта',
        // Пометка нужна ведомости пополнений финансиста, см. ниже
        source: source || null
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

    const totalAmount = roundMoney(items.reduce((sum, it) => sum + (Number(it.sum) || 0), 0));

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
        source: 'manual',
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

// =====================================================================
// ПОПОЛНЕНИЕ БАЛАНСА ФИНАНСИСТА
// =====================================================================
// Директор передаёт финансисту деньги — они ложатся ему в подотчёт операцией
// 'issue' БЕЗ привязки к объекту (см. addIssue). Из этого подотчёта финансист
// выдаёт суммы по заявкам, одобренным директором (js/modules/cash-requests.js).
// Рядом с кнопкой пополнения директор видит актуальный баланс финансиста
// (renderFinancierBalanceHint) — сумму не нужно выяснять отдельно.

/**
 * Активные сотрудники с должностью «Финансист» — те, чей подотчёт пополняем.
 * Должность есть в справочнике (CONFIG.POSITIONS), но самого сотрудника с ней
 * в базе может ещё не быть, поэтому список бывает пустым.
 */
async function loadFinanciers() {
    const { data, error } = await db.select('employees', {
        select: 'id, name, position, status',
        filters: { position: 'Финансист' },
        orderBy: { column: 'name', asc: true }
    });

    if (error) return { financiers: [], error };

    return {
        financiers: (data || []).filter(emp => !emp.status || emp.status === 'active'),
        error: null
    };
}

/**
 * Баланс финансиста рядом с кнопкой «💼 Пополнить баланс финансиста» в разделе
 * «💰 Финансы». Показывается тем же правом, что и кнопка (cash_issue), поэтому
 * прораб и сам финансист подсказки не видят.
 *
 * Сумма читается из представления employee_cash_balance — того же, что и в
 * карточке сотрудника, поэтому в шапке не может быть «своего» числа.
 */
export async function renderFinancierBalanceHint() {
    const hint = document.getElementById('financier-balance-hint');
    if (!hint) return;

    const show = (html) => {
        hint.innerHTML = html;
        hint.classList.remove('hidden');
        hint.style.display = 'inline-flex';
    };

    const hide = () => {
        hint.classList.add('hidden');
        hint.style.display = 'none';
        hint.innerHTML = '';
    };

    if (!can('cash_issue')) {
        hide();
        return;
    }

    const { financiers, error } = await loadFinanciers();

    if (error) {
        log.error('Ошибка загрузки финансистов:', error.message);
        show('<span>💰 Баланс финансиста: <b class="text-red-700">не удалось загрузить</b></span>');
        return;
    }

    if (financiers.length === 0) {
        show('<span>💰 Финансиста нет в штате</span>');
        return;
    }

    const balances = await Promise.all(financiers.map(emp => loadBalance(emp.id)));

    // Финансист обычно один — пишем без имени. Если их несколько, у каждой
    // суммы подписываем, чья она.
    show(financiers.map((emp, i) => {
        const formatted = formatBalance(balances[i].balance);
        const label = financiers.length === 1
            ? 'Баланс финансиста'
            : `Баланс: ${escapeHtml(emp.name)}`;

        return `<span>💰 ${label}: <b class="${formatted.color}">${formatted.icon} ${formatted.text}</b></span>`;
    }).join('<span class="text-gray-300 mx-1">•</span>'));
}

/** Открывает окно «💼 Пополнить баланс финансиста» (право cash_issue). */
export async function openTopUpBalanceModal() {
    if (!requirePermission('cash_issue')) return;

    const select = document.getElementById('topup-balance-employee');
    if (!select) return;

    select.innerHTML = '<option value="">Загрузка...</option>';

    const { financiers, error } = await loadFinanciers();

    if (error) {
        select.innerHTML = '<option value="">Ошибка загрузки</option>';
        toast('Не удалось загрузить список финансистов', 'error');
        return;
    }

    if (financiers.length === 0) {
        select.innerHTML = '<option value="">— нет активных финансистов —</option>';
        toast('Сотрудника с должностью «Финансист» нет. Добавьте его в разделе «Сотрудники».', 'warning');
    } else {
        select.innerHTML = '<option value="">— Выбери финансиста —</option>' +
            financiers.map(emp => `<option value="${emp.id}">${escapeHtml(emp.name)}</option>`).join('');

        // Финансист обычно один — подставляем его сразу
        if (financiers.length === 1) select.value = String(financiers[0].id);
    }

    document.getElementById('topup-balance-amount').value = '';
    document.getElementById('topup-balance-comment').value = '';

    showModal('topup-balance-modal');
}

/**
 * Пополнение подотчёта финансиста: одна операция 'issue'.
 * Кнопку возвращаем в рабочее состояние в finally — иначе после первой
 * попытки форма молча не отправлялась бы (та же ловушка, что была в заявках).
 */
export async function saveTopUpBalance(event) {
    event.preventDefault();

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');

    const employeeId = parseInt(document.getElementById('topup-balance-employee')?.value, 10);
    const amount = parseNumber(document.getElementById('topup-balance-amount')?.value);
    const comment = document.getElementById('topup-balance-comment')?.value.trim();

    if (!employeeId) {
        toast('Выбери финансиста', 'error');
        return;
    }
    if (!amount || amount <= 0) {
        toast('Сумма должна быть больше нуля', 'error');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняем...';

    try {
        const { success, error } = await addIssue(
            employeeId,
            amount,
            comment || 'Пополнение подотчёта финансиста',
            'financier_topup'   // пометка: попадёт в ведомость пополнений
        );

        if (!success) {
            if (error) toast('Не удалось пополнить баланс: ' + error.message, 'error');
            return;
        }

        toast(`Подотчёт финансиста пополнен на ${formatMoney(amount)}`, 'success');
        hideModal('topup-balance-modal');
        form.reset();

        // Баланс рядом с кнопкой переписываем сразу: директор только что передал
        // деньги и должен видеть новую сумму, не переключая раздел.
        await renderFinancierBalanceHint();

    } catch (err) {
        log.error('Исключение при пополнении подотчёта финансиста:', err);
        toast('Не удалось пополнить баланс: ' + (err?.message || 'неизвестная ошибка'), 'error');

    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '💼 Пополнить';
    }
}

// =====================================================================
// ВЕДОМОСТЬ ПОПОЛНЕНИЙ ПОДОТЧЁТА ФИНАНСИСТА
// =====================================================================
// Документ для директора и финансиста: когда и сколько денег передали в
// подотчёт финансиста (открывают из «💰 Финансы» и с рабочего стола).
//
// Пополнения помечаются source = 'financier_topup' (см. saveTopUpBalance),
// поэтому в ведомость не попадают выдачи по заявкам и расходы финансиста.
// Пополнения, сделанные до v2.4.0, помечает миграция
// database/migrate-v2.4.sql (блок 3) — без неё они в ведомость не войдут.

const TOPUP_SOURCE = 'financier_topup';

let statementRows = [];

/**
 * Пополнение подотчёта финансиста — это оно или обычная выдача?
 * Пометка source надёжнее, но для строк, созданных до v2.4.0, оставлен
 * запасной признак — комментарий по умолчанию.
 */
function isFinancierTopUp(op) {
    if (op.source === TOPUP_SOURCE) return true;
    return /пополнени/i.test(op.description || '');
}

/** Читает пополнения подотчёта финансистов (свежие сверху). */
async function loadFinancierTopUps() {
    const { financiers, error } = await loadFinanciers();
    if (error) return { rows: [], financiers: [], error };
    if (financiers.length === 0) return { rows: [], financiers, error: null };

    const namesById = {};
    financiers.forEach(emp => { namesById[emp.id] = emp.name; });

    const { data, error: operationsError } = await db.select('cash_operations', {
        select: 'id, employee_id, operation_type, amount, description, source, operation_date, created_at',
        filters: {
            'employee_id.in': financiers.map(emp => emp.id),
            operation_type: 'issue'
        },
        orderBy: { column: 'created_at', asc: false },
        limit: 500
    });

    if (operationsError) return { rows: [], financiers, error: operationsError };

    const rows = (data || [])
        .filter(isFinancierTopUp)
        .map(op => ({
            date: op.operation_date || op.created_at,
            amount: Number(op.amount) || 0,
            comment: op.description || '',
            financier: namesById[op.employee_id] || '—'
        }));

    return { rows, financiers, error: null };
}

/**
 * Открывает окно ведомости. Доступно кассирам (cash_issue) и финансисту:
 * первый передаёт деньги, второй их получает — ведомость у них одна и та же,
 * отличаются только кнопки в разных разделах.
 */
export async function openFinancierTopUpStatement() {
    if (!can('cash_issue') && getRole() !== 'Финансист') {
        toast('Недостаточно прав для этого действия', 'error');
        return;
    }

    showModal('financier-statement-modal');
    await renderFinancierTopUpStatement();
}

/** Рисует строки ведомости (дата, кто передал, сумма, комментарий) и итоги. */
export async function renderFinancierTopUpStatement() {
    const body = document.getElementById('financier-statement-body');
    if (!body) return;

    body.innerHTML = `<p class="text-sm text-gray-500 py-4 text-center">${t('common.loading')}</p>`;

    const { rows, financiers, error } = await loadFinancierTopUps();
    statementRows = rows;

    if (error) {
        body.innerHTML = `<p class="text-sm text-red-600 py-4 text-center">
            Не удалось загрузить ведомость: ${escapeHtml(error.message)}</p>`;
        renderStatementSummary(0, 0);
        return;
    }

    if (financiers.length === 0 || rows.length === 0) {
        const hint = financiers.length === 0
            ? 'Сотрудника с должностью «Финансист» нет в штате'
            : t('statement.empty');

        body.innerHTML = `<p class="text-sm text-gray-500 py-6 text-center">${escapeHtml(hint)}</p>`;
        renderStatementSummary(0, 0);
        return;
    }

    const total = roundMoney(rows.reduce((sum, row) => sum + row.amount, 0));

    body.innerHTML = `
        <div class="overflow-x-auto border rounded-lg">
            <table class="w-full text-xs">
                <thead class="bg-gray-50 text-gray-500 uppercase text-[10px]">
                    <tr>
                        <th class="text-left px-2 py-2">${t('common.date')}</th>
                        <th class="text-left px-2 py-2">${t('statement.counterparty')}</th>
                        <th class="text-right px-2 py-2">${t('common.sum')}</th>
                        <th class="text-left px-2 py-2">${t('common.comment')}</th>
                    </tr>
                </thead>
                <tbody class="divide-y">
                    ${rows.map(row => `
                        <tr>
                            <td class="px-2 py-1.5 whitespace-nowrap">${formatDate(row.date)}</td>
                            <td class="px-2 py-1.5 text-gray-600">${escapeHtml(row.financier)}</td>
                            <td class="px-2 py-1.5 text-right font-semibold text-[#166534] whitespace-nowrap">${formatMoney(row.amount)}</td>
                            <td class="px-2 py-1.5 text-gray-600">${escapeHtml(row.comment || '—')}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;

    renderStatementSummary(total, rows.length);
}

/** Итоги ведомости: сколько всего передано и сколько было пополнений. */
function renderStatementSummary(total, count) {
    const summary = document.getElementById('financier-statement-summary');
    if (!summary) return;

    summary.innerHTML = `
        <div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <p class="text-[11px] font-bold uppercase tracking-wide text-emerald-700">${t('statement.total')}</p>
            <p class="text-lg font-bold text-[#166534]">${formatMoney(total)}</p>
        </div>
        <div class="bg-gray-50 border rounded-lg p-3">
            <p class="text-[11px] font-bold uppercase tracking-wide text-gray-500">${t('statement.count')}</p>
            <p class="text-lg font-bold text-gray-800">${count}</p>
        </div>
    `;
}

/**
 * Выгружает ведомость в Excel (SheetJS — как в других выгрузках приложения).
 * Суммы пишутся числами с денежным форматом, поэтому в Excel по колонке
 * «Сумма» можно считать, а не только читать.
 */
export function exportFinancierTopUpStatement() {
    if (typeof XLSX === 'undefined') {
        toast('Библиотека XLSX не загружена', 'error');
        return;
    }

    if (statementRows.length === 0) {
        toast('В ведомости нет строк для выгрузки', 'warning');
        return;
    }

    const sumHeader = t('common.sum');

    const rows = statementRows.map(row => ({
        [t('common.date')]: formatDate(row.date),
        [sumHeader]: row.amount,
        [t('statement.counterparty')]: row.financier,
        [t('common.comment')]: row.comment || ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const columns = Object.keys(rows[0]);

    worksheet['!cols'] = columns.map(header => {
        const maxLen = rows.reduce((max, row) => {
            const value = row[header];
            return Math.max(max, String(value ?? '').length);
        }, header.length);

        return { wch: Math.max(12, Math.min(maxLen + 2, 60)) };
    });

    // Колонка суммы: числа + формат «два знака после запятой»
    const sumColumn = columns.indexOf(sumHeader);
    if (sumColumn > -1) {
        rows.forEach((row, index) => {
            const cell = worksheet[XLSX.utils.encode_cell({ r: index + 1, c: sumColumn })];
            if (!cell) return;
            const num = Number(cell.v);
            if (isNaN(num)) return;
            cell.t = 'n';
            cell.v = num;
            cell.z = '#,##0.00';
            delete cell.w;
        });
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, t('statement.sheet').slice(0, 31));
    XLSX.writeFile(workbook, `${t('statement.fileName')}_${todayISO()}.xlsx`);

    toast(`Выгружено строк: ${rows.length}`, 'success');
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
// UI — «АВАНСОВЫЙ ОТЧЁТ»
// =====================================================================

// Сколько последних операций грузим в отчёт. Фильтры и экспорт работают
// по этому окну, поэтому 50 (как было раньше) мало: отчёт по объекту или
// за период оказывался обрезанным. У одного сотрудника операций немного.
const MY_OPERATIONS_LIMIT = 500;

// Значение фильтра «объект не указан»: расход можно внести без объекта.
const MY_OPS_NO_PROJECT = 'none';

// Кэш операций текущего отчёта и активные фильтры.
// Контейнер отчёта перерисовывается целиком (после «Внести расход»,
// возврата и повторного открытия), поэтому состояние фильтров живёт здесь,
// а не в DOM — иначе выбор пользователя терялся бы.
let myOperationsCache = [];
let myOperationsEmployeeId = null;
let myOperationsFilters = { projectId: '', dateFrom: '', dateTo: '' };

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

    const { data: operations } = await loadOperations(emp.id, MY_OPERATIONS_LIMIT);
    const { balance } = await loadBalance(emp.id);
    const formatted = formatBalance(balance);

    // Отчёт всегда по текущему сотруднику. Если аккаунт сменился (перелогин
    // без перезагрузки страницы), чужие фильтры по объектам не сохраняем.
    if (myOperationsEmployeeId !== null && String(myOperationsEmployeeId) !== String(emp.id)) {
        myOperationsFilters = { projectId: '', dateFrom: '', dateTo: '' };
    }

    myOperationsCache = operations || [];
    myOperationsEmployeeId = emp.id;

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
            <div class="bg-gray-50 border rounded-lg p-2 space-y-2">
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div>
                        <label for="my-ops-filter-project" class="block text-[10px] font-semibold text-gray-500 mb-0.5">Объект</label>
                        <select id="my-ops-filter-project" onchange="window.applyMyOperationsFilters()"
                                class="w-full border rounded-lg p-2 text-xs bg-white text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                            <option value="">Все объекты</option>
                        </select>
                    </div>
                    <div>
                        <label for="my-ops-filter-date-from" class="block text-[10px] font-semibold text-gray-500 mb-0.5">Дата с</label>
                        <input type="date" id="my-ops-filter-date-from" onchange="window.applyMyOperationsFilters()"
                               class="w-full border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                    </div>
                    <div>
                        <label for="my-ops-filter-date-to" class="block text-[10px] font-semibold text-gray-500 mb-0.5">Дата по</label>
                        <input type="date" id="my-ops-filter-date-to" onchange="window.applyMyOperationsFilters()"
                               class="w-full border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                    </div>
                </div>
                <div class="flex gap-2">
                    <button onclick="window.resetMyOperationsFilters()"
                            class="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold px-3 py-2 rounded-lg text-xs transition">🗑 Сброс фильтра</button>
                    <button onclick="window.exportMyOperationsToExcel()"
                            class="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold px-3 py-2 rounded-lg text-xs transition shadow">📥 Excel</button>
                </div>
            </div>
            <p id="my-ops-summary" class="text-[11px] text-gray-500"></p>
            <div id="my-ops-list" class="space-y-2"></div>
        </div>
    `;

    renderMyOperationsProjectOptions();
    renderMyOperationsList();
}

// =====================================================================
// ФИЛЬТРЫ «АВАНСОВОГО ОТЧЁТА»
// =====================================================================
// Фильтруем в браузере по уже загруженному окну операций (MY_OPERATIONS_LIMIT):
// отдельный запрос на каждое изменение фильтра не нужен. Дата операции —
// YYYY-MM-DD, поэтому сравнивается со значением input[type=date] как строка
// и часовые пояса не мешают.
// =====================================================================

/** Дата операции как YYYY-MM-DD (для фильтра «с / по»). */
function operationDateISO(op) {
    return String(op?.operation_date || op?.created_at || '').slice(0, 10);
}

/** Операции, прошедшие активные фильтры (объект + период). */
function getFilteredMyOperations() {
    return myOperationsCache.filter(op => {
        const projectFilter = myOperationsFilters.projectId;

        if (projectFilter === MY_OPS_NO_PROJECT) {
            if (op.project_id) return false;
        } else if (projectFilter && String(op.project_id) !== String(projectFilter)) {
            return false;
        }

        const date = operationDateISO(op);

        if (myOperationsFilters.dateFrom && date < myOperationsFilters.dateFrom) return false;
        if (myOperationsFilters.dateTo && date > myOperationsFilters.dateTo) return false;

        return true;
    });
}

/**
 * Итоги по операциям. Знак тот же, что в списке: приход — выдача подотчёта
 * и корректировка, расход — расход и возврат в кассу.
 */
function getMyOperationTotals(operations) {
    let income = 0;
    let expense = 0;

    operations.forEach(op => {
        const amount = Number(op.amount) || 0;
        if (op.operation_type === 'issue' || op.operation_type === 'adjustment') income += amount;
        else expense += amount;
    });

    return { income: roundMoney(income), expense: roundMoney(expense) };
}

function renderOperationRow(op) {
    const typeInfo = getOperationTypeInfo(op.operation_type);
    const isIncome = op.operation_type === 'issue' || op.operation_type === 'adjustment';
    const amountClass = isIncome ? 'text-emerald-700' : 'text-red-700';
    const sign = isIncome ? '+' : '−';

    const categoryLabel = op.category ? getCategoryLabel(op.category) : '';

    // Объект и раздел — их видно и в фильтре отчёта, поэтому показываем в строке
    const projectLabel = [op.project?.name, op.section?.name].filter(Boolean).join(' · ');

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
                    ${projectLabel ? `<p class="text-[11px] text-gray-500 mt-0.5">🏗 ${escapeHtml(projectLabel)}</p>` : ''}
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

/** Список объектов для фильтра — из загруженных операций, без лишних запросов. */
function renderMyOperationsProjectOptions() {
    const select = document.getElementById('my-ops-filter-project');
    if (!select) return;

    const projects = [];
    const seen = new Set();
    let hasWithoutProject = false;

    myOperationsCache.forEach(op => {
        if (!op.project_id) { hasWithoutProject = true; return; }

        const key = String(op.project_id);
        if (seen.has(key)) return;
        seen.add(key);

        projects.push({ id: op.project_id, name: op.project?.name || `Объект #${op.project_id}` });
    });

    projects.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    select.innerHTML = '<option value="">Все объекты</option>' +
        projects.map(p => `<option value="${escapeHtml(String(p.id))}">${escapeHtml(p.name)}</option>`).join('') +
        (hasWithoutProject ? `<option value="${MY_OPS_NO_PROJECT}">— Без объекта —</option>` : '');

    // Контейнер отчёта перерисовывается целиком, поэтому выбор фильтра
    // восстанавливаем из состояния. Если такого объекта в данных уже нет —
    // фильтр сбрасываем, чтобы селект и список не расходились.
    select.value = myOperationsFilters.projectId;
    if (select.value !== myOperationsFilters.projectId) {
        myOperationsFilters.projectId = '';
        select.value = '';
    }

    const fromInput = document.getElementById('my-ops-filter-date-from');
    if (fromInput) fromInput.value = myOperationsFilters.dateFrom;

    const toInput = document.getElementById('my-ops-filter-date-to');
    if (toInput) toInput.value = myOperationsFilters.dateTo;
}

/** Перерисовывает список под текущие фильтры (сами контролы не трогает). */
function renderMyOperationsList() {
    const list = document.getElementById('my-ops-list');
    if (!list) return;

    const operations = getFilteredMyOperations();
    const totals = getMyOperationTotals(operations);

    const isFiltered = Boolean(
        myOperationsFilters.projectId || myOperationsFilters.dateFrom || myOperationsFilters.dateTo
    );

    list.innerHTML = operations.length > 0
        ? operations.map(op => renderOperationRow(op)).join('')
        : `<p class="text-center text-gray-400 italic py-6 text-sm">${
              isFiltered ? 'Ничего не найдено по фильтру' : 'Операций пока нет'
          }</p>`;

    const summary = document.getElementById('my-ops-summary');
    if (summary) {
        summary.textContent = `📊 Показано: ${operations.length} из ${myOperationsCache.length}`
            + ` · 🟢 Приход: ${formatMoney(totals.income)}`
            + ` · 🔴 Расход: ${formatMoney(totals.expense)}`;
    }
}

export function applyMyOperationsFilters() {
    myOperationsFilters.projectId = document.getElementById('my-ops-filter-project')?.value || '';
    myOperationsFilters.dateFrom = document.getElementById('my-ops-filter-date-from')?.value || '';
    myOperationsFilters.dateTo = document.getElementById('my-ops-filter-date-to')?.value || '';

    // Границы периода можно ставить по одной: «с» без «по» и наоборот.
    renderMyOperationsList();
}

export function resetMyOperationsFilters() {
    myOperationsFilters = { projectId: '', dateFrom: '', dateTo: '' };

    renderMyOperationsProjectOptions();
    renderMyOperationsList();
}

// =====================================================================
// ЭКСПОРТ «АВАНСОВОГО ОТЧЁТА» В EXCEL
// =====================================================================
// Выгружаем ровно то, что видно в отчёте: активные фильтры (объект, период)
// уважаются — иначе «Excel по объекту» приносил бы весь подотчёт сотрудника.
// =====================================================================

export function exportMyOperationsToExcel() {
    const operations = getFilteredMyOperations();

    if (operations.length === 0) {
        toast('Нет данных для выгрузки', 'warning');
        return;
    }

    if (typeof XLSX === 'undefined') {
        toast('Библиотека XLSX не загружена', 'error');
        return;
    }

    // Дату пишем настоящей датой Excel (формат встроенный, поэтому Excel
    // покажет её по локали: в русской — 14.08.2026). Тогда автофильтр и
    // сортировка по дате работают правильно, а не как по тексту.
    const excelDate = value => {
        const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
        if (!parts) return formatDate(value);

        const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
        return isNaN(date.getTime()) ? formatDate(value) : date;
    };

    // Числа округляем до копеек; значение, которое не удалось распарсить,
    // оставляем как есть — roundMoney() молча превратил бы его в 0.
    const money = value => {
        if (value === null || value === undefined) return value;
        if (typeof value === 'string' && value.trim() === '') return value;
        const num = Number(value);
        return Number.isFinite(num) ? Math.round((num + Number.EPSILON) * 100) / 100 : value;
    };

    // Расход с позициями разворачиваем в строку на позицию — иначе в Excel не
    // видно, из чего сложилась сумма. У выдачи/возврата позиций нет.
    const rows = [];

    operations.forEach(op => {
        const typeInfo = getOperationTypeInfo(op.operation_type);
        const isIncome = op.operation_type === 'issue' || op.operation_type === 'adjustment';
        const items = Array.isArray(op.items) ? op.items : [];

        const base = {
            'Дата': excelDate(operationDateISO(op)),
            'Операция': typeInfo.label,
            'Тип': isIncome ? 'Приход' : 'Расход',
            'Категория': op.category ? getCategoryLabel(op.category) : '—',
            'Объект': op.project?.name || '—',
            'Раздел': op.section?.name || '—'
        };

        if (op.operation_type === 'expense' && items.length > 0) {
            items.forEach(it => {
                // У старых позиций суммы может не быть — считаем из кол-ва и цены.
                const sum = it.sum !== null && it.sum !== undefined && it.sum !== ''
                    ? it.sum
                    : (Number(it.qty) || 0) * (Number(it.price) || 0);

                rows.push({
                    ...base,
                    'Наименование': it.name || '',
                    'Кол-во': it.qty !== null && it.qty !== undefined ? it.qty : '',
                    'Ед. изм.': it.unit || '',
                    'Цена за ед.': money(it.price),
                    'Сумма': money(sum),
                    'Комментарий': op.description || ''
                });
            });
            return;
        }

        rows.push({
            ...base,
            'Наименование': '',
            'Кол-во': '',
            'Ед. изм.': '',
            'Цена за ед.': '',
            'Сумма': money(op.amount),
            'Комментарий': op.description || ''
        });
    });

    // ── ЛИСТ ─────────────────────────────────────────────────────────
    const worksheet = XLSX.utils.json_to_sheet(rows);

    // Колонки берём в том порядке, в каком они перечислены в rows выше
    const columns = Object.keys(rows[0]);

    // ── ЧИТАЕМОСТЬ ФАЙЛА ─────────────────────────────────────────────
    // Excel открывает .xlsx со своей шириной колонок (~8 символов), поэтому
    // длинный текст в ячейках не видно. Ширину считаем по тому, как значение
    // покажет Excel: дата — «14.08.2026», деньги — «40 000,00» с разрядами и
    // двумя знаками, а не как сырое число «40000».
    const moneyLength = value => {
        if (value === null || value === undefined || value === '') return 0;

        const num = Number(value);
        if (!Number.isFinite(num)) return String(value).length;

        return num
            .toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            .length;
    };

    const displayLength = (header, value) => {
        if (value === null || value === undefined) return 0;
        if (value instanceof Date) return formatDate(value).length;
        if (header === 'Цена за ед.' || header === 'Сумма') return moneyLength(value);
        return String(value).length;
    };

    worksheet['!cols'] = columns.map(header => {
        const maxLen = rows.reduce((max, row) => {
            const len = displayLength(header, row[header]);
            return len > max ? len : max;
        }, header.length);

        // +2 — внутренние отступы Excel. Потолок 250 символов — предел ширины
        // колонки в Excel (255), чтобы даже длинное наименование было видно.
        return { wch: Math.max(10, Math.min(maxLen + 2, 250)) };
    });

    // Автофильтр по шапке — сортировка и фильтр доступны сразу в Excel.
    // Диапазон считаем ДО строк итогов, чтобы они в фильтр не попадали.
    worksheet['!autofilter'] = {
        ref: XLSX.utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: rows.length, c: columns.length - 1 }
        })
    };

    // Числовые колонки пишем числами (а не текстом), деньги — с форматом
    // «два знака после запятой»: суммы читаются и считаются формулами.
    const numericFormats = {
        'Кол-во': '',
        'Цена за ед.': '#,##0.00',
        'Сумма': '#,##0.00'
    };

    Object.entries(numericFormats).forEach(([header, numberFormat]) => {
        const col = columns.indexOf(header);
        if (col === -1) return;

        rows.forEach((row, rowIndex) => {
            const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: col })];
            if (!cell) return;

            const num = Number(cell.v);
            if (cell.v === null || cell.v === undefined
                || String(cell.v).trim() === '' || isNaN(num)) return;

            cell.t = 'n';
            cell.v = num;
            if (numberFormat) cell.z = numberFormat;
            delete cell.w;
        });
    });

    // ── ИТОГИ ────────────────────────────────────────────────────────
    // Три строки под таблицей: иначе приход/расход пришлось бы считать в
    // Excel вручную. В диапазон автофильтра они не попадают.
    let income = 0;
    let expense = 0;

    rows.forEach(row => {
        const sum = Number(row['Сумма']) || 0;
        if (row['Тип'] === 'Приход') income += sum;
        else expense += sum;
    });

    income = roundMoney(income);
    expense = roundMoney(expense);

    const sumCol = columns.indexOf('Сумма');
    const totalsStart = rows.length + 2;   // +1 — пустая строка после таблицы

    const addTotalRow = (offset, label, value) => {
        worksheet[XLSX.utils.encode_cell({ r: totalsStart + offset, c: 0 })] = { t: 's', v: label };
        worksheet[XLSX.utils.encode_cell({ r: totalsStart + offset, c: sumCol })] = {
            t: 'n',
            v: value,
            z: '#,##0.00'
        };
    };

    addTotalRow(0, 'Итого приход', income);
    addTotalRow(1, 'Итого расход', expense);
    addTotalRow(2, 'Баланс (приход − расход)', roundMoney(income - expense));

    // Ячейки итогов лежат ниже диапазона json_to_sheet — расширяем !ref,
    // иначе Excel их не увидит.
    worksheet['!ref'] = XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: totalsStart + 2, c: columns.length - 1 }
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Авансовый отчёт');

    // Имя файла — через sanitizeFileName(): кириллица транслитерируется,
    // поэтому файл открывается без «кракозябр» в любой системе.
    const stamp = new Date().toISOString().split('T')[0];
    const employee = getEmployee();
    const fileName = sanitizeFileName(`Авансовый отчёт ${employee?.name || ''} ${stamp}.xlsx`);

    XLSX.writeFile(workbook, fileName);

    toast(`Экспортировано строк: ${rows.length}`, 'success');
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

    // isSelf проверен выше — в отчёте всегда текущий сотрудник.
    // Кэш «Сотрудники» для этого не годится: он заполняется только при
    // открытии вкладки «Сотрудники» (loadEmployees), а отчёт доступен всем.
    const emp = current;

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

    // См. комментарий в openExpenseModal — берём привязанного сотрудника.
    const emp = current;

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

/**
 * Селект «Раздел» в форме расхода (авансовый отчёт).
 * Список: разделы сметы + служебный раздел «Доп. расходы» (вне сметы).
 * Служебный раздел создаётся автоматически, поэтому выбрать всегда есть что:
 * сотрудник фиксирует незапланированную покупку, а не бросает отчёт.
 */
export async function loadSectionsForExpense() {
    const projectId = parseInt(document.getElementById('cash-expense-project')?.value, 10);
    const sectionSelect = document.getElementById('cash-expense-section');

    await fillSectionsSelect(sectionSelect, projectId);
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
        toast(`Расход на ${formatMoney(roundMoney(items.reduce((s, i) => s + i.sum, 0)))} сохранён`, 'success');
        window.hideModal('cash-expense-modal');

        const current = getEmployee();
        if (current && current.id === employeeId) {
            await renderProfileBalance();

            // Форму открыли из «Авансового отчёта» — возвращаемся в него
            if (returnToReport) {
                await renderMyOperationsContent(current);
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

            // Форму открыли из «Авансового отчёта» — возвращаемся в него
            if (returnToReport) {
                await renderMyOperationsContent(current);
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
window.applyMyOperationsFilters = applyMyOperationsFilters;
window.resetMyOperationsFilters = resetMyOperationsFilters;
window.exportMyOperationsToExcel = exportMyOperationsToExcel;
window.viewReceipt = viewReceipt;
window.addExpenseItemRow = addExpenseItemRow;
window.recalcExpenseTotal = recalcExpenseTotal;
window.loadSectionsForExpense = loadSectionsForExpense;
window.myOpenExpense = myOpenExpense;
window.myOpenReturn = myOpenReturn;
window.openTopUpBalanceModal = openTopUpBalanceModal;
window.openFinancierTopUpStatement = openFinancierTopUpStatement;
window.exportFinancierTopUpStatement = exportFinancierTopUpStatement;