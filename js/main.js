// =====================================================================
// RSK ODESSA — ТОЧКА ВХОДА ПРИЛОЖЕНИЯ
// =====================================================================
// Этот файл запускается первым. Он:
//   1. Инициализирует экран логина через auth.js
//   2. После успешного входа загружает приложение
//   3. Подключает модули по мере их появления
// =====================================================================

import { CONFIG } from './config.js';
import { log, toast } from './utils.js';
import { initLoginScreen, getCurrentUserEmail } from './auth.js';

// =====================================================================
// СОСТОЯНИЕ ПРИЛОЖЕНИЯ
// =====================================================================
// Здесь храним данные, которые нужны всем модулям:
// текущий пользователь, кэш списков и т.д.
// =====================================================================

export const AppState = {
    currentUserEmail: null,
    currentEmployee: null,
    projects: [],
    employees: [],
    orders: [],
    // Флаг, что приложение уже загружено (защита от двойного запуска)
    isReady: false
};

// =====================================================================
// ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ
// =====================================================================

/**
 * Запускается после успешного входа пользователя.
 * Здесь мы будем загружать данные из Supabase (позже).
 */
async function startApp(user) {
    if (AppState.isReady) {
        log.warn('Приложение уже запущено, пропускаем повторную инициализацию');
        return;
    }

    log.info('🚀 Запуск приложения для:', user?.email);
    AppState.currentUserEmail = user?.email || null;

    // Пока просто показываем тост — модули появятся позже
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
}

// =====================================================================
// ЗАПУСК
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

// Делаем AppState доступным из консоли для отладки
window.AppState = AppState;