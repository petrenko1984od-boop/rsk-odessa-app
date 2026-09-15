// =====================================================================
// МОДУЛЬ: ДАШБОРД СОТРУДНИКА
// =====================================================================

import { db } from '../database.js';
import { escapeHtml, formatDate, formatMoney } from '../utils.js';
import { getEmployee } from '../permissions.js';

const DASHBOARD_EXCLUDED_ROLES = ['Директор', 'Главный инженер'];

export function shouldShowEmployeeDashboard() {
    const position = getEmployee()?.position;
    return Boolean(position) && !DASHBOARD_EXCLUDED_ROLES.includes(position);
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

function renderMetric(icon, label, value, detail, tone = 'emerald') {
    const tones = {
        emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
        blue: 'border-blue-200 bg-blue-50 text-blue-800',
        amber: 'border-amber-200 bg-amber-50 text-amber-800',
        red: 'border-red-200 bg-red-50 text-red-800'
    };
    return `
        <div class="rounded-xl border p-4 ${tones[tone] || tones.emerald}">
            <div class="flex items-start justify-between gap-2">
                <span class="text-2xl" aria-hidden="true">${icon}</span>
                <span class="text-2xl font-bold leading-none">${value}</span>
            </div>
            <p class="mt-3 text-xs font-bold uppercase tracking-wide">${label}</p>
            <p class="mt-1 text-[11px] opacity-75">${detail}</p>
        </div>
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
            <section class="rounded-xl bg-white p-5 shadow-sm">
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

export async function loadDashboard() {
    const container = document.getElementById('dashboard-content');
    if (!container) return;

    container.innerHTML = '<div class="rounded-xl bg-white p-8 text-center text-sm text-gray-500 shadow-sm">Загрузка показателей...</div>';

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
                <div class="space-y-4">
                    <div class="flex flex-wrap items-end justify-between gap-3">
                        <div>
                            <p class="text-xs font-semibold uppercase tracking-widest text-emerald-700">Рабочий экран</p>
                            <h2 class="mt-1 text-2xl font-bold text-gray-800">Задания от руководства</h2>
                            <p class="mt-1 text-sm text-gray-500">Только ваши задания по объектам, где вы ответственный</p>
                        </div>
                        <button onclick="loadDashboard()" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-emerald-800">↻ Обновить</button>
                    </div>
                    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
                        ${renderForemanTasks(foremanTasks, projectsResult.data || [])}
                    </div>
                </div>
            `;
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
        <div class="space-y-4">
            <div class="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <p class="text-xs font-semibold uppercase tracking-widest text-emerald-700">Рабочий обзор</p>
                    <h2 class="mt-1 text-2xl font-bold text-gray-800">Добрый день, ${escapeHtml(employee?.name || 'коллега')}</h2>
                    <p class="mt-1 text-sm text-gray-500">Ключевые показатели ${scopeLabel} на ${formatDate(new Date())}</p>
                </div>
                <button onclick="loadDashboard()" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white shadow transition hover:bg-emerald-800">↻ Обновить</button>
            </div>

            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                ${renderMetric('🏗', 'Объекты', activeProjects.length, `Всего: ${projects.length}`, 'emerald')}
                ${renderMetric('📊', 'План vs факт', formatMoney(fact), `План: ${formatMoney(plan)}`, fact > plan ? 'red' : 'blue')}
                ${renderMetric('💰', 'Задолженность', formatMoney(debt), isForeman ? 'Ваш подотчёт' : 'По подотчётам сотрудников', debt > 0 ? 'amber' : 'emerald')}
                ${renderMetric('⏰', 'Просроченные задачи', overdueTasks.length, `Всего задач: ${tasks.length}`, overdueTasks.length ? 'red' : 'emerald')}
            </div>

            <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div class="rounded-xl bg-white p-5 shadow-sm lg:col-span-1">
                    <div class="flex items-center justify-between gap-2 border-b pb-3">
                        <h3 class="text-sm font-bold text-gray-800">💰 Баланс сотрудников</h3>
                        <span class="text-xs text-gray-400">получено − потрачено</span>
                    </div>
                    <div class="mt-2">${renderEmployeeBalances(balances, employees)}</div>
                </div>

                <div class="rounded-xl bg-white p-5 shadow-sm lg:col-span-2">
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
