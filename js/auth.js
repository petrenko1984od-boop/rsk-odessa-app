// =====================================================================
// RSK ODESSA — АВТОРИЗАЦИЯ
// =====================================================================
// Всё, что связано с входом/выходом/сессией пользователя.
// Работает через Supabase Auth.
//
// ВАЖНО: проверяем не только наличие сессии, но и статус сотрудника
// в таблице employees (active / blocked / fired).
// =====================================================================

import { supabase } from './config.js';
import { log, toast } from './utils.js';

// =====================================================================
// ВХОД И ВЫХОД
// =====================================================================

/**
 * Вход по email и паролю.
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
 */
export async function checkEmployeeAccess() {
    const { employee, error } = await getCurrentEmployee();

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
 * Привязывает ТЕКУЩЕГО Auth-пользователя к записи сотрудника.
 * Используется при самостоятельной привязке.
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

/**
 * Отвязывает аккаунт от записи сотрудника (user_id = null).
 * Используется Администратором.
 */
export async function unlinkUserFromEmployee(employeeId) {
    const { error } = await supabase
        .from('employees')
        .update({ user_id: null })
        .eq('id', employeeId);

    if (error) {
        log.error('Ошибка отвязки:', error.message);
        return { success: false, error };
    }

    log.auth(`✅ Аккаунт отвязан от сотрудника #${employeeId}`);
    return { success: true, error: null };
}

/**
 * Привязывает ПРОИЗВОЛЬНЫЙ user_id к сотруднику.
 * Используется Администратором для привязки чужих аккаунтов по UID.
 */
export async function linkUserById(employeeId, userId) {
    if (!userId || typeof userId !== 'string') {
        return { success: false, error: new Error('user_id не задан') };
    }

    // Проверка формата UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
        return { success: false, error: new Error('Некорректный формат UID') };
    }

    const { error } = await supabase
        .from('employees')
        .update({ user_id: userId })
        .eq('id', employeeId);

    if (error) {
        log.error('Ошибка привязки по UID:', error.message);
        return { success: false, error };
    }

    log.auth(`✅ user_id ${userId} привязан к сотруднику #${employeeId}`);
    return { success: true, error: null };
}

// =====================================================================
// СМЕНА ПАРОЛЯ
// =====================================================================

/**
 * Обновляет пароль текущего пользователя.
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
 * Инициализирует экран логина.
 */
export function initLoginScreen(options = {}) {
    const { onSuccess, onLogout } = options;
    const authScreen = document.getElementById('auth-screen');
    const loginForm = document.getElementById('login-form');
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');

    if (!authScreen || !loginForm) {
        log.error('Не найдены элементы экрана логина');
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

    // ----- Слежение за изменениями сессии -----
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
 * Функция выхода.
 */
export async function logout() {
    if (!confirm('Выйти из приложения?')) return;
    await signOut();
    location.reload();
}

window.logout = logout;