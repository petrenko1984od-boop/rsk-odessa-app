// =====================================================================
// RSK ODESSA — ТОЧКА ВХОДА ПРИЛОЖЕНИЯ
// =====================================================================

import { CONFIG } from './config.js';
import { log, toast } from './utils.js';
import { initLoginScreen } from './auth.js';
import { loadPermissions, canSeeTab, getEmployee } from './permissions.js';

// Модули разделов
import {
    loadEmployees,
    openAddEmployeeModal,
    saveNewEmployee,
    confirmDeactivate,
    openEmployeeCard
} from './modules/employees.js';

import {
    loadProjects,
    openAddProjectModal,
    saveNewProject
} from './modules/projects.js';

import {
    renderProfileBalance,
    saveExpense,
    saveReturn
} from './modules/cash.js';

import {
    loadOrders,
    switchOrdersTab,
    openNewOrderForm,
    loadSectionsForOrder,
    addOrderItemRow,
    removeOrderItemRow,
    recalcOrderTotal,
    saveNewOrder,
    takeOrderToWork,
    openCloseOrderModal,
    recalcCloseOrderTotal,
    closeOrder,
    archiveOrder,
    deleteOrder
} from './modules/orders.js';

import {
    loadCashRequests,
    switchCashRequestsTab,
    openNewCashRequestForm,
    loadSectionsForCashRequest,
    addCashRequestItemRow,
    removeCashRequestItemRow,
    recalcCashRequestTotal,
    saveNewCashRequest,
    approveCashRequest,
    rejectCashRequest,
    issueCashRequest,
    deleteCashRequest
} from './modules/cash-requests.js';

import {
    loadRegistry
} from './modules/registry.js';

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

const ALL_TABS = ['welcome', 'projects', 'project-detail', 'employees', 'orders', 'cash-requests', 'registry', 'new-order'];
const TAB_BUTTONS = ['projects', 'employees', 'orders', 'cash-requests', 'registry', 'new-order'];

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
        if (t === highlightTab) {
            btn.classList.remove('bg-[#16a34a]/70', 'hover:bg-[#16a34a]');
            btn.classList.add('bg-[#16a34a]');
        } else {
            btn.classList.add('bg-[#16a34a]/70', 'hover:bg-[#16a34a]');
            btn.classList.remove('bg-[#16a34a]');
        }
    });

    AppState.currentTab = tabId;

    // Триггеры загрузки данных при открытии вкладки
    if (tabId === 'projects') loadProjects();
    if (tabId === 'employees') loadEmployees();
    if (tabId === 'orders') loadOrders();
    if (tabId === 'cash-requests') loadCashRequests();
    if (tabId === 'registry') loadRegistry();
}

window.switchTab = switchTab;

// =====================================================================
// ПРИМЕНЕНИЕ ПРАВ К UI
// =====================================================================

function applyPermissionsToUI() {
    // Сотрудники — только если есть право
    const employeesBtn = document.getElementById('btn-employees');
    if (employeesBtn) {
        employeesBtn.style.display = canSeeTab('employees') ? '' : 'none';
    }

    // Заявки финансов в шапке — только для кассиров (роль проверит cash-requests.js)
    // Кнопка скрывается/показывается в updateCashRequestsBadge() при загрузке
    const cashReqBtn = document.getElementById('btn-cash-requests');
    if (cashReqBtn) {
        const role = getEmployee()?.position;
        const isCashier = role === 'Администратор' || role === 'Директор' || role === 'Главный инженер';
        cashReqBtn.style.display = isCashier ? '' : 'none';
    }
}

// =====================================================================
// ПРОФИЛЬ В ШАПКЕ
// =====================================================================

export function toggleProfileMenu() {
    const menu = document.getElementById('profile-menu');
    if (!menu) return;
    menu.classList.toggle('hidden');
}

window.toggleProfileMenu = toggleProfileMenu;

export function openMyCard() {
    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан к сотруднику', 'warning');
        return;
    }

    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');

    openEmployeeCard(emp.id);
}

window.openMyCard = openMyCard;

/**
 * Открыть модалку «Мои заявки» (объединённый список: материалы + финансы).
 */
export async function openMyRequests() {
    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'warning');
        return;
    }

    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');

    // По умолчанию — вкладка «Материалы»
    await switchMyRequestsTab('materials');

    const modal = document.getElementById('my-requests-modal');
    if (modal) modal.classList.remove('hidden');
}

window.openMyRequests = openMyRequests;

window.closeMyRequests = () => {
    document.getElementById('my-requests-modal')?.classList.add('hidden');
};

/**
 * Переключение вкладок в «Моих заявках».
 */
export async function switchMyRequestsTab(tab) {
    // Подсветка кнопок
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

    container.innerHTML = '<p class="text-center text-gray-400 py-6 text-sm">Загрузка...</p>';

    const emp = getEmployee();
    if (!emp) return;

    // Загружаем заявки автора
    const { db } = await import('./database.js');
    const { escapeHtml, formatDate, formatMoney } = await import('./utils.js');

    if (tab === 'materials') {
        // Заявки на материалы
        const { data: orders } = await db.select('orders', {
            filters: { created_by_employee_id: emp.id },
            orderBy: { column: 'created_at', asc: false }
        });

        if (!orders || orders.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-400 py-6 text-sm">Заявок на материалы нет</p>';
            return;
        }

        // Загружаем разделы и проекты
        const { data: projects } = await db.select('projects');
        const { data: sections } = await db.select('sections');
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
        // Заявки финансов
        const { data: requests } = await db.select('cash_requests', {
            filters: { employee_id: emp.id },
            orderBy: { column: 'created_at', asc: false }
        });

        if (!requests || requests.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-400 py-6 text-sm">Заявок финансов нет</p>';
            return;
        }

        const { data: projects } = await db.select('projects');
        const { data: sections } = await db.select('sections');
        const projMap = {};
        (projects || []).forEach(p => { projMap[p.id] = p.name; });
        const secMap = {};
        (sections || []).forEach(s => { secMap[s.id] = s.name; });

        const statusLabels = {
            'pending':  { text: '🔴 Ожидает',   cls: 'bg-red-100 text-red-700' },
            'approved': { text: '🟡 Одобрено',  cls: 'bg-yellow-100 text-yellow-800' },
            'issued':   { text: '🟢 Выдано',    cls: 'bg-green-100 text-green-700' },
            'rejected': { text: '❌ Отклонено', cls: 'bg-gray-200 text-gray-600' }
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

    // Права
    await loadPermissions();
    applyPermissionsToUI();
    renderProfile();

    // Первичная загрузка данных
    try {
        await Promise.all([
            loadEmployees(),
            loadProjects(),
            loadOrders(),
            loadCashRequests()
        ]);
    } catch (err) {
        log.error('Ошибка загрузки данных:', err);
    }

    switchTab('welcome');

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
// ОБРАБОТЧИКИ ФОРМ
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

    // Заявки на материалы
    const newOrderForm = document.getElementById('new-order-form');
    if (newOrderForm) newOrderForm.addEventListener('submit', saveNewOrder);

    const closeOrderForm = document.getElementById('close-order-form');
    if (closeOrderForm) closeOrderForm.addEventListener('submit', closeOrder);

    // Заявки финансов
    const newCashReqForm = document.getElementById('new-cashreq-form');
    if (newCashReqForm) newCashReqForm.addEventListener('submit', saveNewCashRequest);
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ХЕЛПЕРЫ
// =====================================================================

window.showModal = (id) => document.getElementById(id)?.classList.remove('hidden');
window.hideModal = (id) => document.getElementById(id)?.classList.add('hidden');

// =====================================================================
// BOOT
// =====================================================================

function boot() {
    log.info(`Загрузка ${CONFIG.APP.NAME} v${CONFIG.APP.VERSION}`);
    bindForms();

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