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
const TAB_BUTTONS = ['projects', 'employees', 'orders', 'registry', 'new-order'];

export function switchTab(tabId) {
    // Проверка прав: есть ли доступ к вкладке?
    if (!canSeeTab(tabId) && tabId !== 'welcome') {
        toast('Недостаточно прав для этого раздела', 'error');
        return;
    }

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
// ПРИМЕНЕНИЕ ПРАВ К UI
// =====================================================================

/**
 * Скрывает/показывает вкладки по правам текущего пользователя.
 * Вызывается после loadPermissions().
 */
function applyPermissionsToUI() {
    // Вкладка «Сотрудники» — только если есть право
    const employeesBtn = document.getElementById('btn-employees');
    if (employeesBtn) {
        if (canSeeTab('employees')) {
            employeesBtn.style.display = '';
        } else {
            employeesBtn.style.display = 'none';
        }
    }

    // Остальные вкладки — видны всем (пока без ограничений)
    // Но структура готова: можно добавить аналогичные проверки
}

// =====================================================================
// ПРОФИЛЬ В ШАПКЕ
// =====================================================================

/**
 * Открывает/закрывает dropdown профиля.
 */
export function toggleProfileMenu() {
    const menu = document.getElementById('profile-menu');
    if (!menu) return;
    menu.classList.toggle('hidden');
}

window.toggleProfileMenu = toggleProfileMenu;

/**
 * Открывает карточку ТЕКУЩЕГО сотрудника (свой профиль).
 */
export function openMyCard() {
    const emp = getEmployee();

    if (!emp) {
        toast('Ваш аккаунт не привязан к сотруднику', 'warning');
        return;
    }

    // Закрываем dropdown
    const menu = document.getElementById('profile-menu');
    if (menu) menu.classList.add('hidden');

    // Открываем карточку
    openEmployeeCard(emp.id);
}

window.openMyCard = openMyCard;

/**
 * Заполняет шапку данными профиля.
 */
function renderProfile() {
    const emp = getEmployee();
    if (!emp) {
        // Если нет привязки — просто показываем "?"
        return;
    }

    // Инициалы
    const initials = emp.name
        ? emp.name.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase()
        : '?';

    const avatarEl = document.getElementById('profile-avatar');
    if (avatarEl) avatarEl.textContent = initials;

    const nameShortEl = document.getElementById('profile-name-short');
    if (nameShortEl) {
        nameShortEl.textContent = emp.name?.split(' ')[0] || 'Профиль';
    }

    const nameEl = document.getElementById('profile-name');
    if (nameEl) nameEl.textContent = emp.name || '—';

    const posEl = document.getElementById('profile-position');
    if (posEl) posEl.textContent = emp.position || '—';

    const phoneEl = document.getElementById('profile-phone');
    if (phoneEl) {
        phoneEl.innerHTML = emp.phone 
            ? `📞 <a href="tel:${emp.phone}" class="text-[#15803d] hover:underline">${emp.phone}</a>`
            : '📞 —';
    }
}

// =====================================================================
// ЗАКРЫТИЕ DROPDOWN ПРИ КЛИКЕ ВНЕ НЕГО
// =====================================================================

document.addEventListener('click', (e) => {
    const menu = document.getElementById('profile-menu');
    const btn = document.getElementById('profile-btn');
    if (!menu || !btn) return;
    if (menu.classList.contains('hidden')) return;

    // Если клик НЕ по кнопке и НЕ по меню → закрываем
    if (!btn.contains(e.target) && !menu.contains(e.target)) {
        menu.classList.add('hidden');
    }
});

// =====================================================================
// СТАРТ / СТОП ПРИЛОЖЕНИЯ
// =====================================================================

async function startApp(user) {
    if (AppState.isReady) return;

    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('pending-screen').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');

    log.info('🚀 Запуск приложения для:', user?.email);
    AppState.currentUserEmail = user?.email || null;

    toast(`Добро пожаловать, ${user?.email || 'гость'}!`, 'success');

    // Загружаем права ДО любых проверок
    await loadPermissions();

    // Применяем права к UI (скрытие вкладок)
    applyPermissionsToUI();

    // Обновляем профиль в шапке
    renderProfile();

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