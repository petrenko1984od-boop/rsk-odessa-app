// =====================================================================
// FREEDOM — ТОЧКА ВХОДА ПРИЛОЖЕНИЯ
// =====================================================================

import { CONFIG } from './config.js';
import { log, toast } from './utils.js';
import { initLoginScreen } from './auth.js';
import { initPWA } from './pwa.js';   // установка приложения и обновление версии
import { initMonitoring } from './monitoring.js';   // журнал ошибок (эксплуатация)
import { initI18n, onLangChange } from './i18n.js';   // язык интерфейса (ru/uk)
import { initTheme } from './theme.js';               // цветовая схема
import './actions.js';   // нажатия кнопок по data-action (см. шапку файла, CSP)
import './settings.js';   // окно «⚙ Настройки»: язык интерфейса и цветовая схема
import {
    loadPermissions, canSeeTab, canSeeHeaderButton, getNavLabel, getNavOrder,
    getStartTab, getEmployee, can
} from './permissions.js';

// =====================================================================
// НАСТРОЙКИ ВНЕШНЕГО ВИДА — ДО ПЕРВОГО РЕНДЕРА
// =====================================================================
// Тема и язык применяются сразу при загрузке модуля: если сделать это позже,
// сотрудник успеет увидеть зелёную вспышку и русский текст, а потом они
// «моргнут» на выбранные. Обе настройки читаются из localStorage устройства
// (js/theme.js, js/i18n.js) — в базе они не хранятся.
initTheme();
initI18n();

// Модули разделов. Импортируются ради двух вещей: модуль выполняется и
// выставляет свои функции на `window` (на них ссылается разметка через
// data-action, см. js/actions.js), а здесь перечислены только те функции,
// которые точка входа вызывает сама (обработчики форм и загрузка данных).
import {
    loadEmployees,
    saveNewEmployee,
    confirmDeactivate,
} from './modules/employees.js';

import {
    loadProjects,
    saveNewProject
} from './modules/projects.js';

import {
    renderProfileBalance,
    saveExpense,
    saveReturn,
    saveTopUpBalance
} from './modules/cash.js';

import {
    loadOrders,
    saveNewOrder,
    closeOrder
} from './modules/orders.js';

import {
    loadCashRequests,
    saveNewCashRequest
} from './modules/cash-requests.js';

import {
    loadTasks,
    saveNewTask,
    completeTask
} from './modules/tasks.js';

import {
    saveAllDates,
    confirmCloseSection
} from './modules/gantt.js';

import {
    uploadProjectFile
} from './modules/files.js';

import {
    loadRegistry
} from './modules/registry.js';

import {
    loadDashboard,
    shouldShowEmployeeDashboard
} from './modules/dashboard.js';

import {
    loadDiagnostics
} from './modules/diagnostics.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

export const AppState = {
    currentUserEmail: null,
    currentEmployee: null,
    currentTab: 'welcome',
    isReady: false
};

// =====================================================================
// НАВИГАЦИЯ
// =====================================================================

const ALL_TABS = ['welcome', 'projects', 'project-detail', 'employees', 'tasks', 'orders', 'cash-requests', 'registry', 'diagnostics'];
const TAB_BUTTONS = ['projects', 'employees', 'tasks', 'orders', 'cash-requests', 'registry', 'diagnostics'];

export function switchTab(tabId) {
    if (!canSeeTab(tabId) && tabId !== 'welcome' && tabId !== 'project-detail') {
        toast('Недостаточно прав для этого раздела', 'error');
        return;
    }

    ALL_TABS.forEach(t => {
        const el = document.getElementById(`tab-${t}`);
        if (el) el.classList.add('hidden');
    });

    const target = document.getElementById(`tab-${tabId}`);
    if (target) target.classList.remove('hidden');

    const highlightTab = tabId === 'project-detail' ? 'projects' : tabId;

    TAB_BUTTONS.forEach(t => {
        const btn = document.getElementById(`btn-${t}`);
        if (!btn) return;
        // Кнопка активного раздела выделяется классом из css/theme.css
        // (nav-chip.is-active → подложка в цвете схемы и акцентная полоса
        // слева): раньше активная кнопка отличалась от остальных только
        // оттенком и на насыщенной схеме (красной) сливалась с фоном.
        btn.classList.toggle('is-active', t === highlightTab);
    });

    AppState.currentTab = tabId;

    if (tabId === 'projects') loadProjects();
    if (tabId === 'employees') loadEmployees();
    if (tabId === 'tasks') {
        const dashboard = document.getElementById('dashboard-content');
        const tasksContent = document.getElementById('tasks-content');
        if (shouldShowEmployeeDashboard()) {
            if (dashboard) dashboard.classList.remove('hidden');
            if (tasksContent) tasksContent.classList.add('hidden');
            loadDashboard();
        } else {
            if (dashboard) dashboard.classList.add('hidden');
            if (tasksContent) tasksContent.classList.remove('hidden');
            loadTasks();
        }
    }
    if (tabId === 'orders') loadOrders();
    if (tabId === 'cash-requests') loadCashRequests();
    if (tabId === 'registry') loadRegistry();
    if (tabId === 'diagnostics') loadDiagnostics();
}

window.switchTab = switchTab;

// =====================================================================
// ПРИМЕНЕНИЕ ПРАВ К UI
// =====================================================================

// Кнопки-разделы меню: id элемента → id вкладки. Порядок здесь — общий
// (как в разметке). Роль может переставить их у себя: ROLE_UI.navOrder.
// На ПК меню — сайдбар слева, на телефоне — верхняя шапка (разметка одна,
// раскладку задают классы lg: в index.html и css/style.css).
const TAB_BUTTONS_MAP = [
    ['btn-tasks',         'tasks'],
    ['btn-projects',      'projects'],
    ['btn-employees',     'employees'],
    ['btn-orders',        'orders'],
    ['btn-cash-requests', 'cash-requests'],
    ['btn-registry',      'registry'],
    ['btn-diagnostics',   'diagnostics']
];

/**
 * Переставляет кнопки-разделы меню по порядку роли (ROLE_UI.navOrder).
 * У финансиста «💼 Рабочий стол» должен быть первым: это его рабочее место.
 * Кнопки-действия («Заказ материалов», «Финансовые запросы») и меню кабинета
 * не трогаем — разделы вставляются перед первым таким элементом меню
 * (в разметке это разделитель низа сайдбара `#nav-sections-split`), поэтому
 * остаются на своих местах и после них. На ПК «первым» значит «верхним»
 * в колонке, на телефоне — «левым» в шапке: разметка общая, меняется только
 * раскладка.
 */
function applyNavOrder(order) {
    if (!order || order.length === 0) return;

    const container = document.getElementById('btn-tasks')?.parentElement;
    if (!container) return;

    const navIds = TAB_BUTTONS_MAP.map(([btnId]) => btnId);
    const anchor = [...container.children].find(el => !navIds.includes(el.id));
    if (!anchor) return;

    order.forEach(tabId => {
        const entry = TAB_BUTTONS_MAP.find(([, id]) => id === tabId);
        const btn = entry ? document.getElementById(entry[0]) : null;
        if (btn) container.insertBefore(btn, anchor);
    });
}

function applyPermissionsToUI() {
    TAB_BUTTONS_MAP.forEach(([btnId, tabId]) => {
        const btn = document.getElementById(btnId);
        if (!btn) return;

        const allowed = canSeeTab(tabId);
        btn.classList.toggle('hidden', !allowed);
        btn.style.display = allowed ? '' : 'none';

        // У роли может быть своё название раздела (снабженец: «Снабжение» → «Рабочий экран»)
        const label = getNavLabel(tabId);
        if (label) btn.textContent = label;
    });

    // Кнопка «Финансовые запросы» в шапке — только привязанным сотрудникам
    // и только если роль её не прячет (ROLE_UI, напр. директор)
    const newCashReqBtn = document.getElementById('btn-new-cash-request');
    if (newCashReqBtn) {
        const allowed = can('cash_expense_self') && canSeeHeaderButton('btn-new-cash-request');
        newCashReqBtn.style.display = allowed ? '' : 'none';
    }

    // Кнопка «Заказ материалов» в шапке. Дублируем логику orders.js — иначе
    // кнопка остаётся видимой до первого открытия вкладки «Снабжение».
    const newOrderBtn = document.getElementById('btn-new-order');
    if (newOrderBtn) {
        const allowed = can('create_order') && canSeeHeaderButton('btn-new-order');
        newOrderBtn.style.display = allowed ? '' : 'none';
    }

    // «💼 Пополнить баланс финансиста» — директор и другие кассиры (cash_issue).
    // Кнопка живёт в разделе «💰 Финансы», поэтому и показываем её здесь же:
    // прораб/финансист её не видят. Баланс рядом с кнопкой рисует
    // renderFinancierBalanceHint() при открытии раздела (js/modules/cash.js).
    const topUpBtn = document.getElementById('btn-topup-financier');
    const statementBtn = document.getElementById('btn-financier-statement');
    if (topUpBtn || statementBtn) {
        const allowed = can('cash_issue');
        [topUpBtn, statementBtn].forEach(btn => {
            if (!btn) return;
            btn.classList.toggle('hidden', !allowed);
            btn.style.display = allowed ? '' : 'none';
        });
    }

    // Свой порядок разделов в шапке (финансист: «Рабочий стол» — первым).
    // Делается после расстановки видимости: переставляем все кнопки раздела,
    // скрытые у роли просто не видны.
    applyNavOrder(getNavOrder());
}

// =====================================================================
// СМЕНА ЯЗЫКА НА ЛЕТУ
// =====================================================================
// Статичные надписи и фразы старых модулей переводит js/i18n.js прямо в DOM,
// но строки, собранные новыми модулями через t(), уже лежат в разметке
// украинскими — фразовый переводчик их назад не вернёт. Поэтому открытый
// раздел просто перерисовывается: switchTab() заново запрашивает данные.
onLangChange(() => {
    if (!AppState.isReady) return;

    const tab = AppState.currentTab;
    if (tab && tab !== 'welcome') switchTab(tab);
});

// =====================================================================
// ПРОФИЛЬ В ШАПКЕ
// =====================================================================

export function toggleProfileMenu() {
    const menu = document.getElementById('profile-menu');
    if (!menu) return;
    menu.classList.toggle('hidden');
}

window.toggleProfileMenu = toggleProfileMenu;

/**
 * «Мои заявки» (материалы + финансы).
 */
export async function openMyRequests() {
    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'warning');
        return;
    }

    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');

    await switchMyRequestsTab('materials');

    const modal = document.getElementById('my-requests-modal');
    if (modal) modal.classList.remove('hidden');
}

window.openMyRequests = openMyRequests;

window.closeMyRequests = () => {
    document.getElementById('my-requests-modal')?.classList.add('hidden');
};

export async function switchMyRequestsTab(tab) {
    const matBtn = document.getElementById('myreq-tab-materials');
    const finBtn = document.getElementById('myreq-tab-finance');

    if (tab === 'materials') {
        if (matBtn) { matBtn.classList.add('bg-[#15803d]', 'text-white'); matBtn.classList.remove('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200'); }
        if (finBtn) { finBtn.classList.remove('bg-[#15803d]', 'text-white'); finBtn.classList.add('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200'); }
    } else {
        if (finBtn) { finBtn.classList.add('bg-[#15803d]', 'text-white'); finBtn.classList.remove('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200'); }
        if (matBtn) { matBtn.classList.remove('bg-[#15803d]', 'text-white'); matBtn.classList.add('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200'); }
    }

    const container = document.getElementById('my-requests-content');
    if (!container) return;

    container.innerHTML = '<div class="app-loading text-sm"><span class="app-spinner" aria-hidden="true"></span><span>Загрузка заявок...</span></div>';

    const emp = getEmployee();
    if (!emp) return;

    const { db } = await import('./database.js');
    const { escapeHtml, formatDate, formatMoney } = await import('./utils.js');

    if (tab === 'materials') {
        const { data: orders } = await db.select('orders', {
            filters: { created_by_employee_id: emp.id },
            orderBy: { column: 'created_at', asc: false }
        });

        if (!orders || orders.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-400 py-6 text-sm">Заявок на материалы нет</p>';
            return;
        }

        // Грузим названия только тех объектов/разделов, что реально нужны
        const projectIds = [...new Set(orders.map(o => o.project_id).filter(Boolean))];
        const sectionIds = [...new Set(orders.map(o => o.section_id).filter(Boolean))];
        const [{ data: projects }, { data: sections }] = await Promise.all([
            projectIds.length
                ? db.select('projects', { select: 'id, name', filters: { 'id.in': projectIds } })
                : Promise.resolve({ data: [] }),
            sectionIds.length
                ? db.select('sections', { select: 'id, name', filters: { 'id.in': sectionIds } })
                : Promise.resolve({ data: [] })
        ]);
        const projMap = {};
        (projects || []).forEach(p => { projMap[p.id] = p.name; });
        const secMap = {};
        (sections || []).forEach(s => { secMap[s.id] = s.name; });

        const statusLabels = {
            'new':         { text: '🔴 Новая',      cls: 'bg-red-100 text-red-700' },
            'in_progress': { text: '🟡 В работе',   cls: 'bg-yellow-100 text-yellow-800' },
            'closed':      { text: '🟢 Закрыта',    cls: 'bg-green-100 text-green-700' },
            'archived':    { text: '📥 Архив',      cls: 'bg-gray-200 text-gray-600' }
        };

        container.innerHTML = orders.map(o => {
            const st = statusLabels[o.status] || { text: o.status, cls: 'bg-gray-100' };
            return `
                <div class="bg-white border rounded-lg p-3 text-xs space-y-1">
                    <div class="flex justify-between items-start gap-2">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-bold text-[#15803d] font-mono">${escapeHtml(o.request_number)}</span>
                            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${st.cls}">${st.text}</span>
                        </div>
                        ${o.total_sum > 0 ? `<span class="font-bold text-[#166534]">${formatMoney(o.total_sum)}</span>` : ''}
                    </div>
                    <p class="text-gray-600">🏗 ${escapeHtml(projMap[o.project_id] || '—')} / ${escapeHtml(secMap[o.section_id] || '—')}</p>
                    <p class="text-[10px] text-gray-400">📅 ${formatDate(o.created_at)}</p>
                </div>
            `;
        }).join('');

    } else {
        const { data: requests } = await db.select('cash_requests', {
            filters: { employee_id: emp.id },
            orderBy: { column: 'created_at', asc: false }
        });

        if (!requests || requests.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-400 py-6 text-sm">Заявок финансов нет</p>';
            return;
        }

        // Грузим названия только тех объектов/разделов, что реально нужны
        const projectIds = [...new Set(requests.map(r => r.project_id).filter(Boolean))];
        const sectionIds = [...new Set(requests.map(r => r.section_id).filter(Boolean))];
        const [{ data: projects }, { data: sections }] = await Promise.all([
            projectIds.length
                ? db.select('projects', { select: 'id, name', filters: { 'id.in': projectIds } })
                : Promise.resolve({ data: [] }),
            sectionIds.length
                ? db.select('sections', { select: 'id, name', filters: { 'id.in': sectionIds } })
                : Promise.resolve({ data: [] })
        ]);
        const projMap = {};
        (projects || []).forEach(p => { projMap[p.id] = p.name; });
        const secMap = {};
        (sections || []).forEach(s => { secMap[s.id] = s.name; });

        const statusLabels = {
            'pending':  { text: '🔴 Ожидает',      cls: 'bg-red-100 text-red-700' },
            'revision': { text: '✏️ На доработке', cls: 'bg-orange-100 text-orange-800' },
            'approved': { text: '🟡 Одобрено',     cls: 'bg-yellow-100 text-yellow-800' },
            'issued':   { text: '🟢 Выдано',       cls: 'bg-green-100 text-green-700' },
            'rejected': { text: '❌ Отклонено',    cls: 'bg-gray-200 text-gray-600' }
        };

        container.innerHTML = requests.map(r => {
            const st = statusLabels[r.status] || { text: r.status, cls: 'bg-gray-100' };
            return `
                <div class="bg-white border rounded-lg p-3 text-xs space-y-1">
                    <div class="flex justify-between items-start gap-2">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-bold text-[#15803d] font-mono">${escapeHtml(r.request_number)}</span>
                            <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${st.cls}">${st.text}</span>
                        </div>
                        <span class="font-bold text-[#166534]">${formatMoney(r.total_sum)}</span>
                    </div>
                    <p class="text-gray-600">🏗 ${escapeHtml(projMap[r.project_id] || '—')} / ${escapeHtml(secMap[r.section_id] || '—')}</p>
                    <p class="text-[10px] text-gray-400">📅 ${formatDate(r.created_at)}</p>
                </div>
            `;
        }).join('');
    }
}

window.switchMyRequestsTab = switchMyRequestsTab;

/**
 * «Мои задачи» (открывается из кабинета).
 */
export async function openMyTasks() {
    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'warning');
        return;
    }

    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');

    const container = document.getElementById('my-tasks-content');
    if (!container) return;

    container.innerHTML = '<div class="app-loading text-sm"><span class="app-spinner" aria-hidden="true"></span><span>Загрузка задач...</span></div>';

    const modal = document.getElementById('my-tasks-modal');
    if (modal) modal.classList.remove('hidden');

    const { db } = await import('./database.js');
    const { escapeHtml, formatDate } = await import('./utils.js');

    const { data: tasks } = await db.select('tasks', {
        filters: { assignee_employee_id: emp.id },
        orderBy: { column: 'created_at', asc: false }
    });

    if (!tasks || tasks.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-400 py-6 text-sm">У вас нет задач</p>';
        return;
    }

    const projectIds = [...new Set(tasks.map(t => t.project_id).filter(Boolean))];
    const { data: projects } = projectIds.length
        ? await db.select('projects', { select: 'id, name', filters: { 'id.in': projectIds } })
        : { data: [] };
    const projMap = {};
    (projects || []).forEach(p => { projMap[p.id] = p.name; });

    const statusLabels = {
        'pending':     { text: '🟡 Новая',      cls: 'bg-yellow-100 text-yellow-800' },
        'in_progress': { text: '🔵 В работе',   cls: 'bg-blue-100 text-blue-700' },
        'done':        { text: '🟢 Выполнена',  cls: 'bg-green-100 text-green-700' },
        'cancelled':   { text: '⚫ Отменена',   cls: 'bg-gray-200 text-gray-600' }
    };

    const priorityLabels = {
        'urgent':    '⚡ Срочно',
        'important': '⭐ Важный',
        'normal':    '📋 Обычная'
    };

    container.innerHTML = tasks.map(t => {
        const st = statusLabels[t.status] || { text: t.status, cls: 'bg-gray-100' };
        const prio = priorityLabels[t.priority] || '';
        return `
            <button data-action="openTaskDetail" data-arg="${t.id}" class="w-full text-left bg-white border rounded-lg p-3 text-xs space-y-1 hover:bg-emerald-50/60 transition">
                <div class="flex justify-between items-start gap-2">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100">${prio}</span>
                        <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${st.cls}">${st.text}</span>
                    </div>
                    ${t.deadline ? `<span class="text-[10px] text-gray-500">📅 ${formatDate(t.deadline)}</span>` : ''}
                </div>
                <p class="font-bold text-[#166534]">${escapeHtml(t.title || t.text || '—')}</p>
                ${t.project_id ? `<p class="text-gray-600">🏗 ${escapeHtml(projMap[t.project_id] || '—')}</p>` : ''}
            </button>
        `;
    }).join('');
}

window.openMyTasks = openMyTasks;

window.closeMyTasks = () => {
    document.getElementById('my-tasks-modal')?.classList.add('hidden');
};

// =====================================================================
// RENDER PROFILE
// =====================================================================

function renderProfile() {
    const emp = getEmployee();
    if (!emp) return;

    const initials = emp.name
        ? emp.name.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase()
        : '?';

    const avatarEl = document.getElementById('profile-avatar');
    if (avatarEl) avatarEl.textContent = initials;

    const nameShortEl = document.getElementById('profile-name-short');
    if (nameShortEl) nameShortEl.textContent = 'Кабинет';

    const nameEl = document.getElementById('profile-name');
    if (nameEl) nameEl.textContent = emp.name || '—';

    const posEl = document.getElementById('profile-position');
    if (posEl) posEl.textContent = emp.position || '—';

    renderProfileBalance().catch(err => log.error('Ошибка баланса:', err));
}

// =====================================================================
// КЛИК ВНЕ DROPDOWN
// =====================================================================

document.addEventListener('click', (e) => {
    const menu = document.getElementById('profile-menu');
    const btn = document.getElementById('profile-btn');
    if (!menu || !btn) return;
    if (menu.classList.contains('hidden')) return;

    if (!btn.contains(e.target) && !menu.contains(e.target)) {
        menu.classList.add('hidden');
    }
});

// =====================================================================
// СТАРТ / СТОП
// =====================================================================

async function startApp(user) {
    if (AppState.isReady) return;

    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('pending-screen').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');

    log.info('🚀 Запуск приложения для:', user?.email);
    AppState.currentUserEmail = user?.email || null;

    toast(`Добро пожаловать, ${user?.email || 'гость'}!`, 'success');

    await loadPermissions();
    applyPermissionsToUI();
    renderProfile();

    // Ленивая загрузка разделов: на старте нужны только задачи (личный дашборд
    // сотрудника). Остальное подгрузит switchTab() при первом открытии вкладки.
    try {
        await loadTasks();
    } catch (err) {
        log.error('Ошибка загрузки данных:', err);
    }

    const dashboard = document.getElementById('dashboard-content');
    const directorWelcome = document.getElementById('director-welcome');
    if (dashboard) dashboard.classList.add('hidden');

    const startTab = getStartTab();

    if (shouldShowEmployeeDashboard()) {
        // Сотрудник с личным дашбордом — сразу к своим задачам
        if (directorWelcome) directorWelcome.classList.add('hidden');
        switchTab('tasks');
    } else if (startTab) {
        // Роль с урезанным набором разделов (снабженец) — сразу на свой рабочий экран
        if (directorWelcome) directorWelcome.classList.add('hidden');
        switchTab(startTab);
    } else {
        if (directorWelcome) directorWelcome.classList.remove('hidden');
        switchTab('welcome');
    }

    AppState.isReady = true;
    log.info('✅ Приложение готово');
}

function stopApp() {
    log.info('Приложение остановлено (выход)');
    AppState.isReady = false;
    AppState.currentUserEmail = null;
    AppState.currentTab = 'welcome';

    document.getElementById('app-container').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
}

// =====================================================================
// ФОРМЫ
// =====================================================================

function bindForms() {
    // Сотрудники
    const empForm = document.getElementById('employee-form');
    if (empForm) empForm.addEventListener('submit', saveNewEmployee);

    const deactForm = document.getElementById('deactivate-form');
    if (deactForm) deactForm.addEventListener('submit', confirmDeactivate);

    // Объекты
    const projForm = document.getElementById('project-form');
    if (projForm) projForm.addEventListener('submit', saveNewProject);

    // Подотчёт
    const expenseForm = document.getElementById('cash-expense-form');
    if (expenseForm) expenseForm.addEventListener('submit', saveExpense);

    const returnForm = document.getElementById('cash-return-form');
    if (returnForm) returnForm.addEventListener('submit', saveReturn);

    const topUpForm = document.getElementById('topup-balance-form');
    if (topUpForm) topUpForm.addEventListener('submit', saveTopUpBalance);

    // Заявки на материалы
    const newOrderForm = document.getElementById('new-order-form');
    if (newOrderForm) newOrderForm.addEventListener('submit', saveNewOrder);

    const closeOrderForm = document.getElementById('close-order-form');
    if (closeOrderForm) closeOrderForm.addEventListener('submit', closeOrder);

    // Заявки финансов
    const newCashReqForm = document.getElementById('new-cashreq-form');
    if (newCashReqForm) newCashReqForm.addEventListener('submit', saveNewCashRequest);

    // Задачи
    const newTaskForm = document.getElementById('new-task-form');
    if (newTaskForm) newTaskForm.addEventListener('submit', saveNewTask);

    const completeTaskForm = document.getElementById('complete-task-form');
    if (completeTaskForm) completeTaskForm.addEventListener('submit', completeTask);

    // График (Gantt)
    const editDatesForm = document.getElementById('edit-dates-form');
    if (editDatesForm) editDatesForm.addEventListener('submit', saveAllDates);

    const closeSectionForm = document.getElementById('close-section-form');
    if (closeSectionForm) closeSectionForm.addEventListener('submit', confirmCloseSection);

    // Загрузка доп. файла
    const uploadFileForm = document.getElementById('upload-file-form');
    if (uploadFileForm) uploadFileForm.addEventListener('submit', uploadProjectFile);
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ХЕЛПЕРЫ
// =====================================================================

window.showModal = (id) => document.getElementById(id)?.classList.remove('hidden');
window.hideModal = (id) => document.getElementById(id)?.classList.add('hidden');

// =====================================================================
// ОФЛАЙН-ИНДИКАТОР
// =====================================================================
// Без интернета Supabase недоступен: любое сохранение молча упадёт.
// Показываем полосу внизу, чтобы пользователь не терял данные вслепую.

function initOfflineBanner() {
    let banner = document.getElementById('offline-banner');

    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'offline-banner';
        banner.setAttribute('role', 'status');
        banner.setAttribute('aria-live', 'polite');
        banner.style.cssText = [
            'display:none',
            'position:fixed',
            'left:0',
            'right:0',
            'bottom:0',
            'z-index:9999',
            'background:#b45309',
            'color:#fff',
            'font-size:12px',
            'font-weight:600',
            'text-align:center',
            'padding:6px 8px'
        ].join(';');
        banner.textContent = '⚠️ Нет соединения с интернетом — данные не сохраняются';
        document.body.appendChild(banner);
    }

    const sync = () => {
        banner.style.display = navigator.onLine ? 'none' : 'block';
    };

    window.addEventListener('online', () => {
        sync();
        toast('Соединение восстановлено', 'success');
    });
    window.addEventListener('offline', () => {
        sync();
        toast('Нет соединения с интернетом', 'warning');
    });

    sync();
}

// =====================================================================
// BOOT
// =====================================================================

function boot() {
    log.info(`Загрузка ${CONFIG.APP.NAME} v${CONFIG.APP.VERSION}`);
    bindForms();
    initOfflineBanner();
    initPWA();   // service worker + предложение установить приложение (PWA)
    initMonitoring();   // журнал ошибок: необработанные исключения и промисы

    initLoginScreen({
        onSuccess: (user) => {
            log.auth('Пользователь вошёл:', user?.email);
            startApp(user);
        },
        onLogout: () => {
            log.auth('Пользователь вышел');
            stopApp();
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

window.AppState = AppState;
