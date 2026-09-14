// =====================================================================
// RSK ODESSA — ТОЧКА ВХОДА ПРИЛОЖЕНИЯ
// =====================================================================
// Этот файл запускается первым. Он:
//   1. Инициализирует экран логина через auth.js
//   2. После успешного входа показывает приложение
//   3. Загружает данные из Supabase по мере готовности модулей
// =====================================================================

import { CONFIG } from './config.js';
import { log, toast } from './utils.js';
import { initLoginScreen } from './auth.js';

// =====================================================================
// СОСТОЯНИЕ ПРИЛОЖЕНИЯ
// =====================================================================

export const AppState = {
    currentUserEmail: null,
    currentEmployee: null,
    projects: [],
    employees: [],
    orders: [],
    isReady: false
};

// =====================================================================
// ЗАПУСК ПРИЛОЖЕНИЯ ПОСЛЕ ВХОДА
// =====================================================================

async function startApp(user) {
    if (AppState.isReady) {
        log.warn('Приложение уже запущено, пропускаем повторную инициализацию');
        return;
    }

    // ---- Показываем приложение, скрываем экран логина ----
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');

    log.info('🚀 Запуск приложения для:', user?.email);
    AppState.currentUserEmail = user?.email || null;

    // Приветствие
    toast(`Добро пожаловать, ${user?.email || 'гость'}!`, 'success');

    // =================================================================
    // ЗДЕСЬ ПОЗЖЕ БУДУТ ЗАГРУЖАТЬСЯ ДАННЫЕ
    // Пример (когда напишем модули):
    //
    //   import { loadEmployees } from './modules/employees.js';
    //   import { loadProjects }  from './modules/projects.js';
    //   import { loadOrders }    from './modules/orders.js';
    //
    //   await Promise.all([
    //       loadEmployees(),
    //       loadProjects(),
    //       loadOrders()
    //   ]);
    // =================================================================

    AppState.isReady = true;
    log.info('✅ Приложение готово');
}

/**
 * Вызывается при выходе пользователя.
 */
function stopApp() {
    log.info('Приложение остановлено (выход пользователя)');
    AppState.isReady = false;
    AppState.currentUserEmail = null;
    AppState.currentEmployee = null;
    AppState.projects = [];
    AppState.employees = [];
    AppState.orders = [];

    // Скрываем приложение, показываем логин
    document.getElementById('app-container').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
}

// =====================================================================
// ИНИЦИАЛИЗАЦИЯ ВКЛАДОК (заглушка — полноценно в модулях)
// =====================================================================

window.switchTab = function(tab) {
    log.info('switchTab:', tab, '(модуль ещё не подключён)');
    toast(`Раздел «${tab}» ещё в разработке`, 'info');
};

// Глобальные хелперы для модальных окон (используются в onclick HTML)
window.showModal = function(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
};

window.hideModal = function(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
};

// =====================================================================
// СТАРТ
// =====================================================================

function boot() {
    log.info(`Загрузка ${CONFIG.APP.NAME} v${CONFIG.APP.VERSION}`);

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

// Запускаем приложение, когда DOM готов
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

// Отладка через консоль
window.AppState = AppState;