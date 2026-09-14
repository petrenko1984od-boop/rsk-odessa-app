// =====================================================================
// RSK ODESSA — АВТОРИЗАЦИЯ (полная версия с регистрацией)
// =====================================================================
// Всё, что связано с входом/регистрацией/выходом/сессией.
// Работает через Supabase Auth.
//
// Логика доступа:
//   - Если пользователь привязан к записи employee со status='active' → доступ есть.
//   - Если пользователь НЕ привязан → доступ закрыт (экран "Доступ не активирован").
//   - Bootstrap: если в системе НЕТ ни одного Администратора с привязкой —
//     первый вошедший пользователь получает доступ (для первичной настройки).
// =====================================================================

import { supabase } from './config.js';
import { log, toast } from './utils.js';

// =====================================================================
// ВХОД / РЕГИСТРАЦИЯ / ВЫХОД
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
 * Регистрация нового пользователя (email + пароль).
 * После регистрации пользователь попадает в систему,
 * но без привязки к сотруднику — доступа к данным не будет.
 */
export async function signUp(email, password) {
    log.auth(`Попытка регистрации: ${email}`);

    const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
            // Автоподтверждение — чтобы не ждать email
            emailRedirectTo: window.location.origin
        }
    });

    if (error) {
        log.error('Ошибка регистрации:', error.message);
        return { user: null, error };
    }

    log.auth('✅ Регистрация успешна:', data.user?.email || '(без email)');
    return { user: data.user, error: null };
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

export async function isAuthenticated() {
    const { data: { session } } = await supabase.auth.getSession();
    return !!session;
}

export async function getCurrentUserEmail() {
    const { data: { user } } = await supabase.auth.getUser();
    return user?.email || null;
}

// =====================================================================
// СЛЕЖЕНИЕ ЗА СЕССИЕЙ
// =====================================================================

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
 * Проверяет доступ текущего пользователя.
 *
 * Возвращает:
 *   { allowed: true, employee, bootstrap: false }   — привязан, status='active'
 *   { allowed: true, employee: null, bootstrap: true } — bootstrap (нет админов)
 *   { allowed: false, reason: 'blocked' | 'fired' | 'not_linked', employee }
 */
export async function checkEmployeeAccess() {
    const { employee, error } = await getCurrentEmployee();

    // Нашли запись и она активна — доступ есть
    if (employee && (!employee.status || employee.status === 'active')) {
        return { allowed: true, employee, bootstrap: false };
    }

    // Нашли запись, но она не активна — доступ закрыт
    if (employee && (employee.status === 'blocked' || employee.status === 'fired')) {
        log.warn(`Доступ закрыт. Статус: ${employee.status}`);
        return {
            allowed: false,
            reason: employee.status,
            employee
        };
    }

    // Записи нет. Проверяем bootstrap-условие.
    // Есть ли в системе хотя бы один активный Администратор с привязкой?
    const { count, error: countError } = await supabase
        .from('employees')
        .select('id', { count: 'exact', head: true })
        .eq('position', 'Администратор')
        .eq('status', 'active')
        .not('user_id', 'is', null);

    if (countError) {
        log.error('Ошибка проверки администраторов:', countError.message);
    }

    if (!count || count === 0) {
        // Нет ни одного активного Администратора → bootstrap
        log.warn('⚠️ Bootstrap-режим: в системе нет активного Администратора');
        return { allowed: true, employee: null, bootstrap: true };
    }

    // Администратор есть, но текущий пользователь не привязан
    log.warn('Доступ закрыт: пользователь не привязан к сотруднику');
    return {
        allowed: false,
        reason: 'not_linked',
        employee: null
    };
}

/**
 * Привязывает ТЕКУЩЕГО Auth-пользователя к записи сотрудника.
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
 * Отвязывает аккаунт от записи сотрудника.
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
 * Используется Администратором для привязки чужих аккаунтов.
 */
export async function linkUserById(employeeId, userId) {
    if (!userId || typeof userId !== 'string') {
        return { success: false, error: new Error('user_id не задан') };
    }

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

export async function updatePassword(newPassword) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
        log.error('Ошибка смены пароля:', error.message);
        return { success: false, error };
    }
    return { success: true, error: null };
}

// =====================================================================
// UI — ЭКРАНЫ ЛОГИНА / РЕГИСТРАЦИИ / ПЕНДИНГА
// =====================================================================

const AUTH_SCREEN_ID = 'auth-screen';
const PENDING_SCREEN_ID = 'pending-screen';
const APP_CONTAINER_ID = 'app-container';

function showScreen(id) {
    [AUTH_SCREEN_ID, PENDING_SCREEN_ID, APP_CONTAINER_ID].forEach(sid => {
        const el = document.getElementById(sid);
        if (el) el.classList.add('hidden');
    });

    const target = document.getElementById(id);
    if (target) target.classList.remove('hidden');
}

/**
 * Переключение вкладок «Войти» / «Регистрация».
 */
export function switchAuthTab(tab) {
    const tabLogin = document.getElementById('auth-tab-login');
    const tabRegister = document.getElementById('auth-tab-register');
    const formLogin = document.getElementById('login-form');
    const formRegister = document.getElementById('register-form');
    const errEl = document.getElementById('login-error');

    if (errEl) errEl.classList.add('hidden');

    if (tab === 'login') {
        tabLogin.className = 'flex-1 py-2 text-sm font-semibold rounded-md transition bg-white text-[#15803d] shadow';
        tabRegister.className = 'flex-1 py-2 text-sm font-semibold rounded-md transition text-gray-600 hover:text-gray-800';
        formLogin.classList.remove('hidden');
        formRegister.classList.add('hidden');
    } else {
        tabRegister.className = 'flex-1 py-2 text-sm font-semibold rounded-md transition bg-white text-[#15803d] shadow';
        tabLogin.className = 'flex-1 py-2 text-sm font-semibold rounded-md transition text-gray-600 hover:text-gray-800';
        formRegister.classList.remove('hidden');
        formLogin.classList.add('hidden');
    }
}

window.switchAuthTab = switchAuthTab;

/**
 * Показывает экран «Доступ не активирован».
 */
function showPendingScreen(email) {
    const emailEl = document.getElementById('pending-email');
    if (emailEl) emailEl.textContent = email || '—';
    showScreen(PENDING_SCREEN_ID);
}

/**
 * Инициализирует экран логина с вкладками и обеими формами.
 */
export function initLoginScreen(options = {}) {
    const { onSuccess, onLogout } = options;
    const authScreen = document.getElementById(AUTH_SCREEN_ID);
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const errorEl = document.getElementById('login-error');

    if (!authScreen || !loginForm || !registerForm) {
        log.error('Не найдены элементы экрана логина');
        return;
    }

    // ----- Проверка сессии при загрузке -----
    (async () => {
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
            showScreen(AUTH_SCREEN_ID);
            log.auth('🔒 Требуется вход');
            return;
        }

        const access = await checkEmployeeAccess();

        if (!access.allowed) {
            log.warn(`Доступ закрыт: ${access.reason}`);
            showPendingScreen(session.user.email);
            return;
        }

        showScreen(APP_CONTAINER_ID);
        log.auth('✅ Найдена активная сессия:', session.user.email);
        if (onSuccess) onSuccess(session.user);
    })();

    // ----- Обработка формы ВХОДА -----
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;
        const btn = document.getElementById('login-btn');

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
            // Не пускаем — показываем экран "Доступ не активирован"
            log.warn(`Доступ закрыт: ${access.reason}`);
            btn.disabled = false;
            btn.textContent = 'Войти';
            showPendingScreen(user?.email || email);
            return;
        }

        showScreen(APP_CONTAINER_ID);
        toast('Добро пожаловать!', 'success');
        if (onSuccess) onSuccess(user);
    });

    // ----- Обработка формы РЕГИСТРАЦИИ -----
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = document.getElementById('register-email').value.trim();
        const password = document.getElementById('register-password').value;
        const password2 = document.getElementById('register-password2').value;
        const btn = document.getElementById('register-btn');

        errorEl.classList.add('hidden');

        // Проверки
        if (password.length < 6) {
            errorEl.textContent = 'Пароль должен быть минимум 6 символов';
            errorEl.classList.remove('hidden');
            return;
        }
        if (password !== password2) {
            errorEl.textContent = 'Пароли не совпадают';
            errorEl.classList.remove('hidden');
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Регистрируем...';

        const { user, error } = await signUp(email, password);

        btn.disabled = false;
        btn.textContent = 'Зарегистрироваться';

        if (error) {
            errorEl.textContent = 'Ошибка: ' + error.message;
            errorEl.classList.remove('hidden');
            return;
        }

        // Автоматически логиним после регистрации
        const loginResult = await signIn(email, password);

        if (loginResult.error) {
            errorEl.textContent = 'Регистрация прошла, но вход не удался: ' + loginResult.error.message;
            errorEl.classList.remove('hidden');
            return;
        }

        const access = await checkEmployeeAccess();

        if (!access.allowed) {
            toast('Регистрация успешна! Ожидайте привязки к сотруднику.', 'info');
            showPendingScreen(email);
            return;
        }

        // Bootstrap-случай — попал сразу
        showScreen(APP_CONTAINER_ID);
        toast('Регистрация успешна! Добро пожаловать!', 'success');
        if (onSuccess) onSuccess(loginResult.user);
    });

    // ----- Слежение за изменениями сессии -----
    onAuthChange((event, session) => {
        if (event === 'SIGNED_OUT') {
            showScreen(AUTH_SCREEN_ID);
            if (onLogout) onLogout();
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