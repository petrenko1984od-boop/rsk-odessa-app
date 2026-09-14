// =====================================================================
// RSK ODESSA — ТОЧКА ВХОДА ПРИЛОЖЕНИЯ
// =====================================================================

import { CONFIG } from './config.js';
import { log, toast } from './utils.js';
import { initLoginScreen } from './auth.js';

// Модули разделов
import {
    loadEmployees,
    openAddEmployeeModal,
    saveNewEmployee,
    confirmDeactivate
} from './modules/employees.js';

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
// НАВИГАЦИЯ ПО ВКЛАДКАМ
// =====================================================================

const ALL_TABS = ['welcome', 'projects', 'employees', 'orders', 'registry', 'new-order'];

export function switchTab(tabId) {
    // Скрываем все вкладки
    ALL_TABS.forEach(t => {
        const el = document.getElementById(`tab-${t}`);
        if (el) el.classList.add('hidden');
    });

    // Показываем нужную
    const target = document.getElementById(`tab-${tabId}`);
    if (target) target.classList.remove('hidden');

    // Подсветка кнопки
    ['projects', 'employees', 'orders', 'registry', 'new-order'].forEach(t => {
        const btn = document.getElementById(`btn-${t}`);
        if (!btn) return;
        if (t === tabId) {
            btn.classList.remove('bg-[#16a34a]/70', 'hover:bg-[#16a34a]');
            btn.classList.add('bg-[#16a34a]');
        } else {
            btn.classList.add('bg-[#16a34a]/70', 'hover:bg-[#16a34a]');
            btn.classList.remove('bg-[#16a34a]');
        }
    });

    AppState.currentTab = tabId;

    // Триггеры на загрузку данных
    if (tabId === 'employees') {
        loadEmployees();
    }
}

window.switchTab = switchTab;

// =====================================================================
// СТАРТ ПРИЛОЖЕНИЯ
// =====================================================================

async function startApp(user) {
    if (AppState.isReady) return;

    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');

    log.info('🚀 Запуск приложения для:', user?.email);
    AppState.currentUserEmail = user?.email || null;

    toast(`Добро пожаловать, ${user?.email || 'гость'}!`, 'success');

    // Загружаем данные
    try {
        await loadEmployees();
    } catch (err) {
        log.error('Ошибка загрузки данных:', err);
    }

    // Открываем приветственную вкладку
    switchTab('welcome');

    AppState.isReady = true;
    log.info('✅ Приложение готово');
}

function stopApp() {
    log.info('Приложение остановлено (выход пользователя)');
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
    // Форма добавления сотрудника
    const empForm = document.getElementById('employee-form');
    if (empForm) empForm.addEventListener('submit', saveNewEmployee);

    // Форма деактивации
    const deactForm = document.getElementById('deactivate-form');
    if (deactForm) deactForm.addEventListener('submit', confirmDeactivate);
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