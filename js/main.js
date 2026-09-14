// =====================================================================
// RSK ODESSA — ТОЧКА ВХОДА ПРИЛОЖЕНИЯ
// =====================================================================
// Запускается первым. Он:
//   1. Инициализирует экран логина
//   2. После входа показывает приложение
//   3. Загружает права доступа
//   4. Подключает модули разделов
// =====================================================================

import { CONFIG } from './config.js';
import { log, toast } from './utils.js';
import { initLoginScreen } from './auth.js';
import { loadPermissions } from './permissions.js';

// Модули разделов
import {
    loadEmployees,
    openAddEmployeeModal,
    saveNewEmployee,
    confirmDeactivate
} from './modules/employees.js';

// =====================================================================
// СОСТОЯНИЕ ПРИЛОЖЕНИЯ
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
const TAB_BUTTONS = ['projects', 'employees', 'orders', 'registry', 'new-order'];

export function switchTab(tabId) {
    // Скрываем все вкладки
    ALL_TABS.forEach(t => {
        const el = document.getElementById(`tab-${t}`);
        if (el) el.classList.add('hidden');
    });

    // Показываем нужную
    const target = document.getElementById(`tab-${tabId}`);
    if (target) target.classList.remove('hidden');

    // Подсветка активной кнопки
    TAB_BUTTONS.forEach(t => {
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

    // Триггеры загрузки данных при открытии вкладки
    if (tabId === 'employees') {
        loadEmployees();
    }
}

window.switchTab = switchTab;

// =====================================================================
// СТАРТ ПРИЛОЖЕНИЯ
// =====================================================================

async function startApp(user) {
    if (AppState.isReady) {
        log.warn('Приложение уже запущено');
        return;
    }

    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');

    log.info('🚀 Запуск приложения для:', user?.email);
    AppState.currentUserEmail = user?.email || null;

    toast(`Добро пожаловать, ${user?.email || 'гость'}!`, 'success');

    // Загружаем права доступа ДО загрузки данных
    await loadPermissions();

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
    const empForm = document.getElementById('employee-form');
    if (empForm) empForm.addEventListener('submit', saveNewEmployee);

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

// Для отладки через консоль
window.AppState = AppState;