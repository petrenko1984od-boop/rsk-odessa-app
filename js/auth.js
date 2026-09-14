// =====================================================================
// RSK ODESSA — АВТОРИЗАЦИЯ
// =====================================================================
// Всё, что связано с входом/выходом/сессией пользователя.
// Работает через Supabase Auth.
//
// ВАЖНО: проверяем не только наличие сессии, но и статус сотрудника
// в таблице employees (active / blocked / fired). Уволенные и
// заблокированные не пускаются в приложение, но их данные
// (объекты, заявки, задачи) остаются в базе.
// =====================================================================

import { supabase } from './config.js';
import { log, toast } from './utils.js';

// =====================================================================
// ВХОД И ВЫХОД
// =====================================================================

/**
 * Вход по email и паролю.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ user, session, error }>}
 */
export async function signIn(email, password) {
    log.auth(`Попытка входа: ${email}`);

    const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password
    });

    if (error) {
        log.error('Ошибка входа:', error.message);
        return { user: null, session: null, error };
    }

    log.auth('✅ Вход выполнен:', data.user.email);
    return { user: data.user, session: data.session, error: null };
}

/**
 * Выход из приложения.
 */
export async function signOut() {
    log.auth('Выход из приложения');
    const { error } = await supabase.auth.signOut();
    if (error) {
        log.error('Ошибка выхода:', error.message);
        return { error };
    }
    return { error: null };
}

// =====================================================================
// ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ
// =====================================================================

/**
 * Возвращает текущего авторизованного пользователя (или null).
 */
export async function getCurrentUser() {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError) {
        return { user: null, session: null, error: userError };
    }

    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) {
        return { user: null, session: null, error: sessionError };
    }

    return { user, session, error: null };
}

/**
 * Проверяет, авторизован ли пользователь.
 */
export async function isAuthenticated() {
    const { data: { session } } = await supabase.auth.getSession();
    return !!session;
}

/**
 * Возвращает email текущего пользователя.
 */
export async function getCurrentUserEmail() {
    const { data: { user } } = await supabase.auth.getUser();
    return user?.email || null;
}

// =====================================================================
// СЛЕЖЕНИЕ ЗА СЕССИЕЙ
// =====================================================================

/**
 * Подписывается на изменения авторизации.
 * @param {Function} callback — (event, session) => { ... }
 * @returns {Object} — { unsubscribe }
 */
export function onAuthChange(callback) {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        log.auth(`Событие: ${event}`, session?.user?.email || 'нет сессии');
        callback(event, session);
    });

    return {
        unsubscribe: () => subscription.unsubscribe()
    };
}

// =====================================================================
// СВЯЗЬ AUTH-ПОЛЬЗОВАТЕЛЯ С ТАБЛИЦЕЙ EMPLOYEES
// =====================================================================

/**
 * Находит запись сотрудника, привязанную к текущему Auth-пользователю.
 * @returns {Promise<{ employee, error }>}
 */
export async function getCurrentEmployee() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return { employee: null, error: new Error('Не авторизован') };
    }

    const { data, error } = await supabase
        .from('employees')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

    if (error) {
        log.error('Ошибка получения сотрудника:', error.message);
        return { employee: null, error };
    }

    return { employee: data, error: null };
}

/**
 * Проверяет статус текущего сотрудника.
 * Возвращает:
 *  - { allowed: true, employee } — если всё ок или если сотрудник ещё не привязан
 *  - { allowed: false, reason: 'blocked' | 'fired', employee } — если доступ закрыт
 */
export async function checkEmployeeAccess() {
    const { employee, error } = await getCurrentEmployee();

    // Если запись не привязана — не блокируем (это администратор/директор)
    if (error || !employee) {
        log.auth('Сотрудник не привязан к Auth — доступ разрешён');
        return { allowed: true, employee: null };
    }

    if (employee.status === 'active' || !employee.status) {
        return { allowed: true, employee };
    }

    log.warn(`Доступ запрещён. Статус: ${employee.status}`);
    return {
        allowed: false,
        reason: employee.status,
        employee
    };
}

/**
 * Привязывает текущего Auth-пользователя к записи сотрудника.
 * @param {number} employeeId
 * @returns {Promise<{ success, error }>}
 */
export async function linkUserToEmployee(employeeId) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return { success: false, error: new Error('Не авторизован') };
    }

    const { error } = await supabase
        .from('employees')
        .update({ user_id: user.id })
        .eq('id', employeeId);

    if (error) {
        log.error('Ошибка привязки пользователя:', error.message);
        return { success: false, error };
    }

    log.auth(`✅ Пользователь ${user.email} привязан к сотруднику #${employeeId}`);
    return { success: true, error: null };
}

// =====================================================================
// СМЕНА ПАРОЛЯ
// =====================================================================

/**
 * Обновляет пароль текущего пользователя.
 * @param {string} newPassword
 * @returns {Promise<{ success, error }>}
 */
export async function updatePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
        log.error('Ошибка смены пароля:', error.message);
        return { success: false, error };
    }
    return { success: true, error: null };
}

// =====================================================================
// UI — ЭКРАН ЛОГИНА
// =====================================================================

/**
 * Инициализирует экран логина:
 *  - Проверяет сессию при загрузке.
 *  - Проверяет статус сотрудника (active / blocked / fired).
 *  - Обрабатывает отправку формы.
 *
 * @param {Object} options — { onSuccess: Function, onLogout: Function }
 */
export function initLoginScreen(options = {}) {
    const { onSuccess, onLogout } = options;
    const authScreen = document.getElementById('auth-screen');
    const loginForm = document.getElementById('login-form');
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');

    if (!authScreen || !loginForm) {
        log.error('Не найдены элементы экрана логина (auth-screen, login-form)');
        return;
    }

    // ----- Проверка сессии при загрузке -----
    (async () => {
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
            authScreen.classList.remove('hidden');
            log.auth('🔒 Требуется вход');
            return;
        }

        // Есть сессия — проверяем статус сотрудника
        const access = await checkEmployeeAccess();

        if (!access.allowed) {
            log.warn(`Доступ запрещён: ${access.reason}`);
            await signOut();
            authScreen.classList.remove('hidden');
            errorEl.textContent = access.reason === 'fired'
                ? 'Ваш доступ закрыт. Обратитесь к администратору.'
                : 'Ваш доступ временно заблокирован.';
            errorEl.classList.remove('hidden');
            return;
        }

        authScreen.classList.add('hidden');
        log.auth('✅ Найдена активная сессия:', session.user.email);
        if (onSuccess) onSuccess(session.user);
    })();

    // ----- Обработка формы входа -----
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;

        btn.disabled = true;
        btn.textContent = 'Входим...';
        errorEl.classList.add('hidden');

        const { user, error } = await signIn(email, password);

        if (error) {
            errorEl.textContent = 'Ошибка: ' + error.message;
            errorEl.classList.remove('hidden');
            btn.disabled = false;
            btn.textContent = 'Войти';
            return;
        }

        // Проверяем статус сотрудника после входа
        const access = await checkEmployeeAccess();

        if (!access.allowed) {
            log.warn(`Доступ запрещён: ${access.reason}`);
            await signOut();
            errorEl.textContent = access.reason === 'fired'
                ? 'Ваш доступ закрыт. Обратитесь к администратору.'
                : 'Ваш доступ временно заблокирован.';
            errorEl.classList.remove('hidden');
            btn.disabled = false;
            btn.textContent = 'Войти';
            return;
        }

        authScreen.classList.add('hidden');
        toast('Добро пожаловать!', 'success');
        if (onSuccess) onSuccess(user);
    });

    // ----- Следим за изменениями сессии -----
    onAuthChange((event, session) => {
        if (event === 'SIGNED_OUT') {
            authScreen.classList.remove('hidden');
            if (onLogout) onLogout();
        }
        if (event === 'SIGNED_IN' && session) {
            authScreen.classList.add('hidden');
        }
    });
}

/**
 * Функция выхода — вызывается из кнопки в интерфейсе.
 */
export async function logout() {
    if (!confirm('Выйти из приложения?')) return;
    await signOut();
    location.reload();
}

// Делаем logout доступным глобально, чтобы onclick="logout()" работал в HTML
window.logout = logout;