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

const ALL_TABS = ['welcome', 'projects', 'project-detail', 'employees', 'orders', 'registry', 'new-order'];
const TAB_BUTTONS = ['projects', 'employees', 'orders', 'registry', 'new-order'];

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

    if (tabId === 'projects') loadProjects();
    if (tabId === 'employees') loadEmployees();
}

window.switchTab = switchTab;

// =====================================================================
// ПРИМЕНЕНИЕ ПРАВ К UI
// =====================================================================

function applyPermissionsToUI() {
    const employeesBtn = document.getElementById('btn-employees');
    if (employeesBtn) {
        employeesBtn.style.display = canSeeTab('employees') ? '' : 'none';
    }
}

// =====================================================================
// ПРОФИЛЬ
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

    try {
        await Promise.all([
            loadEmployees(),
            loadProjects()
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