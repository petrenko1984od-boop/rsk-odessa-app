// =====================================================================
// МОДУЛЬ: ДАШБОРД СОТРУДНИКА
// =====================================================================

import { db } from '../database.js';
import { escapeHtml, formatDate, formatMoney } from '../utils.js';
import { getEmployee } from '../permissions.js';

const DASHBOARD_ROLES = ['Прораб', 'Сметчик', 'Инженер ПТО', 'Администратор', 'Директор', 'Главный инженер'];

export function shouldShowEmployeeDashboard() {
    const position = getEmployee()?.position;
    return DASHBOARD_ROLES.includes(position);
}

function isActiveProject(project) {
    return !['closed', 'archived', 'completed'].includes(String(project.status || '').toLowerCase());
}

function isOverdueTask(task, today = new Date()) {
    if (!task.deadline || task.status === 'done' || task.status === 'cancelled') return false;
    const deadline = new Date(`${task.deadline}T23:59:59`);
    return !Number.isNaN(deadline.getTime()) && deadline < today;
}

function operationLabel(operation) {
    const labels = {
        issue: 'Выдача подотчёта',
        expense: 'Расход',
        return: 'Возврат',
        adjustment: 'Корректировка'
    };
    return labels[operation.operation_type] || operation.operation_type || 'Операция';
}

function renderMetric(icon, label, value, detail, tone = 'emerald', onClick = null) {
    const tones = {
        emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
        blue: 'border-blue-200 bg-blue-50 text-blue-800',
        amber: 'border-amber-200 bg-amber-50 text-amber-800',
        red: 'border-red-200 bg-red-50 text-red-800'
    };
    const content = `
        <div class="flex min-h-[104px] w-full flex-col justify-between rounded-xl border p-4 text-left ${tones[tone] || tones.emerald}">
            <div class="flex items-start justify-between gap-2">
                <span class="text-2xl" aria-hidden="true">${icon}</span>
                <span class="text-2xl font-bold leading-none">${value}</span>
            </div>
            <div class="mt-3">
                <p class="text-xs font-bold uppercase tracking-wide">${label}</p>
                <p class="mt-1 text-[11px] opacity-75">${detail}</p>
            </div>
        </div>
    `;

    if (!onClick) return content;

    return `
        <button type="button" onclick="${onClick}" class="w-full text-left focus:outline-none focus:ring-2 focus:ring-emerald-500/50">
            ${content}
        </button>
    `;
}

function renderOperations(operations, employees) {
    const employeeMap = new Map((employees || []).map(employee => [employee.id, employee.name]));
    if (!operations.length) {
        return '<p class="text-sm text-gray-500">Операций пока нет.</p>';
    }

    return operations.map(operation => {
        const isIncome = operation.operation_type === 'issue' || operation.operation_type === 'adjustment';
        const employeeName = employeeMap.get(operation.employee_id) || 'Сотрудник';
        return `
            <div class="flex items-center justify-between gap-3 border-b border-gray-100 py-3 last:border-0">
                <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-gray-800">${escapeHtml(operationLabel(operation))}</p>
                    <p class="truncate text-xs text-gray-500">${escapeHtml(employeeName)} · ${formatDate(operation.operation_date || operation.created_at)}</p>
                </div>
                <span class="whitespace-nowrap text-sm font-bold ${isIncome ? 'text-emerald-700' : 'text-red-700'}">
                    ${isIncome ? '+' : '-'} ${formatMoney(operation.amount)}
                </span>
            </div>
        `;
    }).join('');
}

function renderForemanTasks(tasks, projects) {
    const projectMap = new Map((projects || []).map(project => [project.id, project.name]));
    const groups = [
        { status: 'pending', title: 'Новые', tone: 'yellow' },
        { status: 'in_progress', title: 'В работе', tone: 'blue' },
        { status: 'done', title: 'Законченные', tone: 'green' }
    ];

    return groups.map(group => {
        const groupTasks = tasks.filter(task => task.status === group.status);
        return `
            <section class="min-w-0 rounded-xl bg-white p-5 shadow-sm">
                <div class="flex items-center justify-between gap-2 border-b pb-3">
                    <h3 class="text-sm font-bold text-gray-800">${group.title}</h3>
                    <span class="rounded-full bg-${group.tone}-100 px-2 py-1 text-xs font-bold text-${group.tone}-800">${groupTasks.length}</span>
                </div>
                <div class="mt-2 space-y-2">
                    ${groupTasks.length ? groupTasks.map(task => `
                        <button onclick="window.openTaskDetail(${task.id})" class="w-full rounded-lg border p-3 text-left transition hover:bg-emerald-50/60">
                            <p class="text-sm font-semibold text-gray-800">${escapeHtml(task.title || task.text || 'Без названия')}</p>
                            <p class="mt-1 text-xs text-gray-500">${escapeHtml(projectMap.get(task.project_id) || 'Объект не указан')}${task.deadline ? ` · Срок: ${formatDate(task.deadline)}` : ''}</p>
                        </button>
                    `).join('') : '<p class="py-3 text-sm text-gray-500">Заданий нет.</p>'}
                </div>
            </section>
        `;
    }).join('');
}

function renderEmployeeBalances(balances, employees) {
    const employeeMap = new Map((employees || []).map(employee => [employee.id, employee]));
    const rows = (balances || []).map(balance => ({
        ...balance,
        employee: employeeMap.get(balance.employee_id)
    })).filter(item => item.employee);

    if (!rows.length) return '<p class="text-sm text-gray-500">Балансов пока нет.</p>';

    return `
        <div class="overflow-x-auto">
            <table class="w-full min-w-[420px] text-sm">
                <thead class="border-b text-left text-[11px] uppercase text-gray-500"><tr><th class="px-2 py-2">Сотрудник</th><th class="px-2 py-2">Должность</th><th class="px-2 py-2 text-right">Баланс</th></tr></thead>
                <tbody class="divide-y">
                    ${rows.map(item => {
                        const value = Number(item.balance) || 0;
                        const tone = value < 0 ? 'text-red-700' : value > 0 ? 'text-emerald-700' : 'text-gray-500';
                        return `<tr><td class="px-2 py-3 font-semibold text-gray-800">${escapeHtml(item.employee.name || '—')}</td><td class="px-2 py-3 text-gray-500">${escapeHtml(item.employee.position || '—')}</td><td class="px-2 py-3 text-right font-bold ${tone}">${formatMoney(value)}</td></tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

function renderTaskSummary(tasks) {
    const active = tasks.filter(task => ['pending', 'in_progress'].includes(task.status)).length;
    const overdue = tasks.filter(task => isOverdueTask(task)).length;
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 30);
    const done30 = tasks.filter(task => {
        if (task.status !== 'done' || !task.completed_at) return false;
        const dt = new Date(task.completed_at);
        return !Number.isNaN(dt.getTime()) && dt >= cutoff;
    }).length;

    return `
        <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            ${renderMetric('📌', 'Активные', active, 'Активные задачи', 'blue', "switchTab('tasks'); openTaskFilterModal('active');")}
            ${renderMetric('⏰', 'Просроченные', overdue, 'Просроченные задачи', overdue ? 'red' : 'emerald', "switchTab('tasks'); openTaskFilterModal('overdue');")}
            ${renderMetric('✅', 'Выполнено за 30 дней', done30, 'Выполненные задачи', 'emerald', "switchTab('tasks'); openTaskFilterModal('done_30');")}
        </div>
    `;
}

function renderExecutiveDashboard({ employees, balances, tasks, orders, orderItems, cashOperations, projects, sections }) {
    const employeeMap = new Map((employees || []).map(emp => [emp.id, emp]));
    const canCreateTask = ['Администратор', 'Директор', 'Главный инженер', 'Инженер ПТО']
        .includes(getEmployee()?.position);

    const totalBalance = (balances || []).reduce((sum, item) => sum + (Number(item.balance) || 0), 0);
    const negative = (balances || [])
        .map(item => ({ ...item, employee: employeeMap.get(item.employee_id) }))
        .filter(item => item.employee && (Number(item.balance) || 0) < 0)
        .sort((a, b) => (Number(a.balance) || 0) - (Number(b.balance) || 0))
        .slice(0, 8);
    const positive = (balances || [])
        .map(item => ({ ...item, employee: employeeMap.get(item.employee_id) }))
        .filter(item => item.employee && (Number(item.balance) || 0) > 0)
        .sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0))
        .slice(0, 8);

    const validOrderIds = new Set((orders || []).filter(order => ['closed', 'archived'].includes(order.status)).map(order => order.id));
    const unpaidDebt = (orderItems || [])
        .filter(item => validOrderIds.has(item.order_id) && (item.payment_status || 'paid') === 'debt')
        .reduce((sum, item) => sum + (Number(item.total_price) || 0), 0);
    const unpaidItemsCount = (orderItems || []).filter(item => validOrderIds.has(item.order_id) && (item.payment_status || 'paid') === 'debt').length;

    const unpaidSupplierMap = new Map();
    const orderMap = new Map((orders || []).map(order => [order.id, order]));
    (orderItems || [])
        .filter(item => validOrderIds.has(item.order_id) && (item.payment_status || 'paid') === 'debt')
        .forEach(item => {
            const order = orderMap.get(item.order_id);
            const supplier = order?.supplier || 'Без поставщика';
            const amount = Number(item.total_price) || 0;
            unpaidSupplierMap.set(supplier, (unpaidSupplierMap.get(supplier) || 0) + amount);
        });
    const supplierRows = [...unpaidSupplierMap.entries()]
        .map(([supplier, amount]) => ({ supplier, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8);

    const sectionPlanMap = new Map();
    (sections || []).forEach(section => {
        sectionPlanMap.set(section.id, {
            projectId: section.project_id,
            plan: Number(section.plan_materials) || 0
        });
    });

    const sectionFactMap = new Map();
    (cashOperations || []).forEach(operation => {
        if (!operation.section_id) return;
        const category = String(operation.category || '').toLowerCase();
        if (operation.operation_type !== 'expense' || (!['materials', 'delivery'].includes(category) && !['materials', 'delivery'].includes(String(operation.category || '')))) return;
        sectionFactMap.set(operation.section_id, (sectionFactMap.get(operation.section_id) || 0) + (Number(operation.amount) || 0));
    });

    const closedOrderIds = new Set((orders || [])
        .filter(order => ['closed', 'archived'].includes(order.status))
        .map(order => order.id));
    const orderIdsWithCashOperation = new Set((cashOperations || [])
        .map(operation => operation.order_id)
        .filter(Boolean));
    const orderSectionMap = new Map((orders || [])
        .filter(order => closedOrderIds.has(order.id) && order.section_id && !orderIdsWithCashOperation.has(order.id))
        .map(order => [order.id, order.section_id]));
    (orderItems || []).forEach(item => {
        const sectionId = orderSectionMap.get(item.order_id);
        if (!sectionId) return;
        sectionFactMap.set(sectionId, (sectionFactMap.get(sectionId) || 0) + (Number(item.total_price) || 0));
    });

    const projectMap = new Map((projects || []).map(project => [project.id, project]));
    const projectRows = [...sectionPlanMap.entries()]
        .map(([sectionId, section]) => {
            const plan = section.plan;
            const fact = Number(sectionFactMap.get(sectionId)) || 0;
            const overrun = fact - plan;
            const percent = plan > 0 ? (overrun / plan) * 100 : (overrun > 0 ? 100 : 0);
            return {
                sectionId,
                sectionOverrun: overrun,
                hasSectionOverrun: overrun > 0,
                project: projectMap.get(section.projectId),
                plan,
                fact,
                overrun,
                percent
            };
        })
        .filter(row => row.project)
        .reduce((rows, row) => {
            const existing = rows.find(item => item.project.id === row.project.id);
            if (existing) {
                existing.plan += row.plan;
                existing.fact += row.fact;
                existing.overrun += row.overrun;
                existing.hasSectionOverrun = existing.hasSectionOverrun || row.hasSectionOverrun;
                existing.percent = existing.plan > 0 ? (existing.overrun / existing.plan) * 100 : 0;
            } else {
                rows.push({ ...row, ...row.project });
            }
            return rows;
        }, [])
        .filter(row => row.hasSectionOverrun)
        .sort((a, b) => b.overrun - a.overrun);

    const negativeList = negative.length
        ? negative.map(item => `
            <div class="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs">
                <span class="font-medium text-red-700">${escapeHtml(item.employee?.name || '—')}</span>
                <span class="font-bold text-red-800">${formatMoney(Number(item.balance) || 0)}</span>
            </div>
        `).join('')
        : '<p class="text-sm text-gray-500">Нет должников.</p>';

    const positiveList = positive.length
        ? positive.map(item => `
            <div class="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs">
                <span class="font-medium text-emerald-700">${escapeHtml(item.employee?.name || '—')}</span>
                <span class="font-bold text-emerald-800">${formatMoney(Number(item.balance) || 0)}</span>
            </div>
        `).join('')
        : '<p class="text-sm text-gray-500">Нет крупных остатков.</p>';

    const overrunRows = projectRows.slice(0, 8).map(project => {
        const tone = project.overrun > 0 ? 'text-red-600' : 'text-emerald-700';
        return `
            <tr>
                <td class="px-2 py-3 text-left text-sm font-semibold text-gray-800">${escapeHtml(project.name || '—')}</td>
                <td class="px-2 py-3 text-right text-sm text-gray-600">${formatMoney(project.plan)}</td>
                <td class="px-2 py-3 text-right text-sm text-gray-600">${formatMoney(project.fact)}</td>
                <td class="px-2 py-3 text-right text-sm font-bold ${tone}">${formatMoney(project.overrun)}</td>
                <td class="px-2 py-3 text-right text-sm font-bold ${project.overrun > 0 ? 'text-red-600' : 'text-emerald-700'}">${Math.abs(project.percent || 0).toFixed(1)}%</td>
            </tr>
        `;
    }).join('') || '<tr><td colspan="5" class="px-2 py-4 text-center text-sm text-gray-500">Нет данных по объектам.</td></tr>';

    const supplierDebtRows = supplierRows.length
        ? supplierRows.map((row, index) => `
            <tr>
                <td class="px-2 py-3 text-left text-sm font-semibold text-gray-800">${index + 1}. ${escapeHtml(row.supplier)}</td>
                <td class="px-2 py-3 text-right text-sm font-bold text-red-600">${formatMoney(row.amount)}</td>
            </tr>
        `).join('')
        : '<tr><td colspan="2" class="px-2 py-4 text-center text-sm text-gray-500">Нет задолженности.</td></tr>';

    return `
        <div class="w-full min-w-0 space-y-4">
            <div class="flex min-w-0 flex-wrap items-end justify-between gap-3 rounded-xl bg-white px-4 py-4 shadow-sm sm:px-5">
                <div>
                    <p class="text-xs font-semibold uppercase tracking-widest text-emerald-700">Дашборд руководителя</p>
                    <h2 class="mt-1 text-2xl font-bold text-gray-800">Компания в целом</h2>
                    <p class="mt-1 text-sm text-gray-500">Финансы, задачи, задолженности</p>
                </div>
                <button onclick="loadDashboard()" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-emerald-800">↻ Обновить</button>
            </div>

            <div class="flex min-w-0 flex-col gap-3">
                <details open class="min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm">
                    <summary class="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 font-bold text-gray-800 [&::-webkit-details-marker]:hidden">
                        <span>💰 Баланс сотрудников</span>
                        <span class="text-xs font-normal text-gray-400">общий остаток ·⌄</span>
                    </summary>
                    <div class="border-t border-gray-200 p-5">
                    <div class="mt-4 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-3">
                        ${renderMetric('💵', 'Общий баланс', formatMoney(totalBalance), 'все сотрудники', totalBalance >= 0 ? 'emerald' : 'amber')}
                        ${renderMetric('📉', 'С отрицательным балансом', negative.length, 'сотрудники с отрицательным балансом', 'red')}
                        ${renderMetric('📈', 'С большим остатком', positive.length, 'сотрудники с положительным балансом', 'blue')}
                    </div>
                    <div class="mt-4 grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
                        <div>
                            <p class="mb-2 text-[11px] font-bold uppercase tracking-wide text-red-600">Сотрудники с отрицательным балансом</p>
                            <div class="space-y-2">${negativeList}</div>
                        </div>
                        <div>
                            <p class="mb-2 text-[11px] font-bold uppercase tracking-wide text-emerald-600">Сотрудники с большим положительным балансом</p>
                            <div class="space-y-2">${positiveList}</div>
                        </div>
                    </div>
                    </div>
                </details>

                <details open class="min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm">
                    <summary class="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 font-bold text-gray-800 [&::-webkit-details-marker]:hidden">
                        <span class="min-w-0">
                            <span>📋 Задачи</span>
                            <span class="ml-2 text-xs font-normal text-gray-400">по плану ·⌄</span>
                        </span>
                    </summary>
                    <div class="border-t border-gray-200 p-5">
                        ${canCreateTask ? `
                            <div class="mb-3 flex justify-end">
                                <button type="button" onclick="window.openNewTaskForm()"
                                        class="shrink-0 rounded-lg bg-[#15803d] px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-[#166534]">
                                    ➕ Поставить задачу
                                </button>
                            </div>
                        ` : ''}
                        <div>${renderTaskSummary(tasks)}</div>
                    </div>
                </details>

                <details class="min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm">
                    <summary class="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 font-bold text-gray-800 [&::-webkit-details-marker]:hidden">
                        <span>💳 Задолженность по материалам</span>
                        <span class="text-xs font-normal text-gray-400">неоплаченные позиции ·⌄</span>
                    </summary>
                    <div class="border-t border-gray-200 p-5">
                    <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                    ${renderMetric('💸', 'Сумма задолженности', formatMoney(unpaidDebt), 'закрытые заявки', unpaidDebt > 0 ? 'amber' : 'emerald')}
                    ${renderMetric('📦', 'Позиции в долгу', unpaidItemsCount, 'неоплаченные позиции', unpaidItemsCount > 0 ? 'red' : 'emerald')}
                </div>
                <div class="mt-4">
                    <p class="mb-2 text-[11px] font-bold uppercase tracking-wide text-gray-500">Рейтинг не оплаченных материалов по поставщикам</p>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead class="border-b text-left text-[11px] uppercase text-gray-500">
                                <tr><th class="px-2 py-2">Поставщик</th><th class="px-2 py-2 text-right">Сумма</th></tr>
                            </thead>
                            <tbody class="divide-y">${supplierDebtRows}</tbody>
                        </table>
                    </div>
                </div>
                    </div>
                </details>

                <details class="min-w-0 rounded-xl border border-gray-200 bg-white shadow-sm">
                    <summary class="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 font-bold text-gray-800 [&::-webkit-details-marker]:hidden">
                        <span>📊 Рейтинг объектов по перерасходу материалов</span>
                        <span class="text-xs font-normal text-gray-400">сверху — больше перерасход ·⌄</span>
                    </summary>
                    <div class="border-t border-gray-200 p-5">
                <div class="overflow-x-auto">
                    <table class="w-full min-w-[520px] text-sm">
                        <thead class="border-b text-left text-[11px] uppercase text-gray-500">
                            <tr>
                                <th class="px-2 py-2">Объект</th>
                                <th class="px-2 py-2 text-right">План</th>
                                <th class="px-2 py-2 text-right">Факт</th>
                                <th class="px-2 py-2 text-right">Перерасход</th>
                                <th class="px-2 py-2 text-right">%</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y">${overrunRows}</tbody>
                    </table>
                </div>
                    </div>
                </details>
            </div>
        </div>
    `;
}

export async function loadDashboard() {
    const container = document.getElementById('dashboard-content');
    if (!container) return;

    container.innerHTML = '<div class="app-loading app-loading-card text-sm"><span class="app-spinner" aria-hidden="true"></span><span>Загрузка показателей...</span></div>';

    const employee = getEmployee();
        const isForeman = employee?.position === 'Прораб';

        if (isForeman) {
            const [tasksResult, projectsResult] = await Promise.all([
                db.select('tasks', {
                    filters: { assignee_employee_id: employee.id },
                    orderBy: { column: 'created_at', asc: false }
                }),
                db.select('projects', { select: 'id, name, foreman_id', filters: { foreman_id: employee.id } })
            ]);

            const projectIds = new Set((projectsResult.data || []).map(project => project.id));
            const foremanTasks = (tasksResult.data || []).filter(task => projectIds.has(task.project_id));

            container.innerHTML = `
                <div class="w-full min-w-0 space-y-4">
                    <div class="flex min-w-0 flex-wrap items-end justify-between gap-3 rounded-xl bg-white px-4 py-4 shadow-sm sm:px-5">
                        <div>
                            <p class="text-xs font-semibold uppercase tracking-widest text-emerald-700">Рабочий экран</p>
                            <h2 class="mt-1 text-2xl font-bold text-gray-800">Задания от руководства</h2>
                            <p class="mt-1 text-sm text-gray-500">Только ваши задания по объектам, где вы ответственный</p>
                        </div>
                        <button onclick="loadDashboard()" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-emerald-800">↻ Обновить</button>
                    </div>
                    <div class="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
                        ${renderForemanTasks(foremanTasks, projectsResult.data || [])}
                    </div>
                </div>
            `;
            return;
        }

    const isExecutive = ['Администратор', 'Директор', 'Главный инженер'].includes(employee?.position);

    if (isExecutive) {
        const [projectsResult, sectionsResult, cashOperationsResult, balancesResult, tasksResult, ordersResult, employeesResult, orderItemsResult] = await Promise.all([
            db.select('projects', { select: 'id, name, foreman_id, status' }),
            db.select('sections', { select: 'id, project_id, plan_materials' }),
            db.select('cash_operations', {
                select: 'id, order_id, project_id, section_id, operation_type, category, amount, created_at',
                orderBy: { column: 'created_at', asc: false }
            }),
            db.select('employee_cash_balance', { select: 'employee_id, balance' }),
            db.select('tasks', { select: 'id, title, project_id, status, deadline, completed_at, created_at' }),
            db.select('orders', { select: 'id, status, project_id, section_id, request_number, supplier, created_at' }),
            db.select('employees', { select: 'id, name, position, status' }),
            db.select('order_items', { select: 'id, order_id, total_price, payment_status' })
        ]);

        const projects = projectsResult.data || [];
        const sections = sectionsResult.data || [];
        const cashOperations = cashOperationsResult.data || [];
        const balances = balancesResult.data || [];
        const tasks = tasksResult.data || [];
        const orders = ordersResult.data || [];
        const employees = employeesResult.data || [];
        const orderItems = orderItemsResult.data || [];

        container.innerHTML = renderExecutiveDashboard({
            employees,
            balances,
            tasks,
            orders,
            orderItems,
            cashOperations,
            projects,
            sections
        });
        return;
    }

    const [projectsResult, sectionsResult, expensesResult, balancesResult, tasksResult, ordersResult, operationsResult, employeesResult] = await Promise.all([
        db.select('projects', { select: 'id, name, foreman_id' }),
        db.select('sections', { select: 'id, project_id, plan_total' }),
        db.select('cash_operations', { filters: { operation_type: 'expense' } }),
        db.select('employee_cash_balance', { select: 'employee_id, balance' }),
        db.select('tasks', { select: 'id, title, project_id, status, deadline, created_at' }),
        db.select('orders', { select: 'id, project_id, request_number, status, created_at' }),
        db.select('cash_operations', { select: 'id, employee_id, project_id, operation_type, amount, operation_date, created_at', orderBy: { column: 'created_at', asc: false }, limit: 20 }),
        db.select('employees', { select: 'id, name, position' })
    ]);

    const allProjects = projectsResult.data || [];
    const visibleProjectIds = isForeman
        ? new Set(allProjects.filter(project => project.foreman_id === employee.id).map(project => project.id))
        : null;
    const isVisibleProjectData = item => !visibleProjectIds || visibleProjectIds.has(item.project_id);

    const projects = visibleProjectIds
        ? allProjects.filter(project => visibleProjectIds.has(project.id))
        : allProjects;
    const sections = (sectionsResult.data || []).filter(isVisibleProjectData);
    const expenses = (expensesResult.data || []).filter(isVisibleProjectData);
    const balances = (balancesResult.data || []).filter(item => !isForeman || item.employee_id === employee.id);
    const tasks = (tasksResult.data || []).filter(isVisibleProjectData);
    const orders = (ordersResult.data || []).filter(isVisibleProjectData);
    const operations = (operationsResult.data || []).filter(isVisibleProjectData).slice(0, 6);
    const employees = employeesResult.data || [];

    const plan = sections.reduce((sum, section) => sum + (Number(section.plan_total) || 0), 0);
    const fact = expenses.reduce((sum, operation) => sum + (Number(operation.amount) || 0), 0);
    const debt = balances.reduce((sum, item) => sum + Math.max(0, -(Number(item.balance) || 0)), 0);
    const overdueTasks = tasks.filter(isOverdueTask);
    const activeOrders = orders.filter(order => order.status === 'new' || order.status === 'in_progress');
    const activeProjects = projects.filter(isActiveProject);
    const scopeLabel = isForeman ? 'по вашим объектам' : 'по компании';

    container.innerHTML = `
        <div class="w-full min-w-0 space-y-4">
            <div class="flex min-w-0 flex-wrap items-end justify-between gap-3 rounded-xl bg-white px-4 py-4 shadow-sm sm:px-5">
                <div>
                    <p class="text-xs font-semibold uppercase tracking-widest text-emerald-700">Рабочий обзор</p>
                    <h2 class="mt-1 text-2xl font-bold text-gray-800">Добрый день, ${escapeHtml(employee?.name || 'коллега')}</h2>
                    <p class="mt-1 text-sm text-gray-500">Ключевые показатели ${scopeLabel} на ${formatDate(new Date())}</p>
                </div>
                <button onclick="loadDashboard()" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-emerald-800">↻ Обновить</button>
            </div>

            <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                ${renderMetric('🏗', 'Объекты', activeProjects.length, `Всего: ${projects.length}`, 'emerald')}
                ${renderMetric('📊', 'План vs факт', formatMoney(fact), `План: ${formatMoney(plan)}`, fact > plan ? 'red' : 'blue')}
                ${renderMetric('💰', 'Задолженность', formatMoney(debt), isForeman ? 'Ваш подотчёт' : 'По подотчётам сотрудников', debt > 0 ? 'amber' : 'emerald')}
                ${renderMetric('⏰', 'Просроченные задачи', overdueTasks.length, `Всего задач: ${tasks.length}`, overdueTasks.length ? 'red' : 'emerald')}
            </div>

            <div class="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
                <div class="min-w-0 rounded-xl bg-white p-5 shadow-sm lg:col-span-1">
                    <div class="flex items-center justify-between gap-2 border-b pb-3">
                        <h3 class="text-sm font-bold text-gray-800">💰 Баланс сотрудников</h3>
                        <span class="text-xs text-gray-400">получено − потрачено</span>
                    </div>
                    <div class="mt-2">${renderEmployeeBalances(balances, employees)}</div>
                </div>

                <div class="min-w-0 rounded-xl bg-white p-5 shadow-sm lg:col-span-2">
                    <div class="flex items-center justify-between gap-2 border-b pb-3">
                        <h3 class="text-sm font-bold text-gray-800">💳 Последние операции</h3>
                        <span class="text-xs text-gray-400">6 последних</span>
                    </div>
                    <div>${renderOperations(operations, employees)}</div>
                </div>
            </div>
        </div>
    `;
}

window.loadDashboard = loadDashboard;
