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
 * Адрес, куда Supabase вернёт сотрудника после клика по ссылке из письма.
 * При открытии с file:// origin === 'null', и такой адрес Supabase отклоняет,
 * поэтому передаём его только для http(s).
 */
function getAuthRedirectUrl() {
    return /^https?:$/.test(window.location.protocol) ? window.location.origin : undefined;
}

/**
 * Переводит стандартные английские ошибки Supabase Auth на понятный русский.
 * Показывать «Email not confirmed» сотруднику бессмысленно — он не знает,
 * что это за подтверждение и где его искать.
 */
export function describeAuthError(message = '') {
    const msg = String(message);

    if (/email not confirmed/i.test(msg)) {
        return 'Email не подтверждён. Откройте письмо от Supabase и нажмите ссылку подтверждения, ' +
               'либо попросите администратора подтвердить аккаунт (Users → … → Confirm email).';
    }
    if (/invalid login credentials/i.test(msg)) {
        return 'Неверный email или пароль.';
    }
    if (/user already registered|already been registered/i.test(msg)) {
        return 'Такой email уже зарегистрирован — войдите или попросите администратора сбросить пароль.';
    }
    if (/email rate limit exceeded|over_email_send_rate_limit/i.test(msg)) {
        return 'Слишком много писем подряд. Подождите несколько минут и попробуйте снова.';
    }
    if (/password should be at least/i.test(msg)) {
        return 'Пароль слишком короткий — минимум 6 символов.';
    }
    if (/failed to fetch|networkerror|network error/i.test(msg)) {
        return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
    }

    return msg;
}

/**
 * Регистрация нового пользователя (email + пароль).
 * После регистрации пользователь попадает в систему,
 * но без привязки к сотруднику — доступа к данным не будет.
 *
 * Возвращает `needsConfirmation: true`, если в проекте включена опция
 * Confirm email (Authentication → Sign In / Providers → Email): пользователь
 * создан, сессии нет, и войти он сможет только после клика по ссылке из письма.
 */
export async function signUp(email, password) {
    log.auth(`Попытка регистрации: ${email}`);

    const redirectTo = getAuthRedirectUrl();

    const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        ...(redirectTo ? { options: { emailRedirectTo: redirectTo } } : {})
    });

    if (error) {
        log.error('Ошибка регистрации:', error.message);
        return { user: null, needsConfirmation: false, error };
    }

    // session === null → подтверждение email включено: сначала письмо, потом вход
    const needsConfirmation = !data.session;

    log.auth(
        needsConfirmation
            ? `✉️ Требуется подтверждение email: ${data.user?.email || email}`
            : `✅ Регистрация успешна: ${data.user?.email || '(без email)'}`
    );

    return { user: data.user, needsConfirmation, error: null };
}

/**
 * Повторная отправка письма-подтверждения (кнопка «✉️ Отправить письмо-подтверждение ещё раз»).
 * Нужна, когда письмо не дошло: у встроенной почты Supabase жёсткие лимиты,
 * и без своего SMTP адреса вне организации проекта часто не получают письма.
 */
export async function resendConfirmation(email) {
    log.auth(`Повторная отправка подтверждения: ${email}`);

    const redirectTo = getAuthRedirectUrl();

    const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email.trim(),
        ...(redirectTo ? { options: { emailRedirectTo: redirectTo } } : {})
    });

    if (error) {
        log.error('Ошибка повторной отправки письма:', error.message);
        return { success: false, error };
    }

    log.auth('✅ Письмо-подтверждение отправлено повторно');
    return { success: true, error: null };
}

/**
 * Разбирает «хвост» адреса, который Supabase добавляет после клика по ссылке из письма:
 *   #access_token=…&type=signup      — подтверждение прошло;
 *   #error=access_denied&error_code=otp_expired — ссылка устарела.
 *
 * Сессию приложение по этим токенам не поднимает (`detectSessionInUrl: false`),
 * поэтому хвост просто убираем из адресной строки и показываем сотруднику подсказку.
 */
export function readAuthRedirectNotice() {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return null;

    let params;
    try {
        params = new URLSearchParams(hash);
    } catch {
        return null;
    }

    const hasToken = params.has('access_token');
    const errorDescription = params.get('error_description') || '';
    const errorCode = params.get('error_code') || '';

    if (!hasToken && !errorDescription && !errorCode) return null;

    // Хвост больше не нужен — в адресной строке оставляем чистый путь
    history.replaceState(null, '', window.location.pathname + window.location.search);

    if (hasToken) {
        return { type: 'ok', message: '✅ Email подтверждён. Войдите с паролем.' };
    }
    if (/expired|invalid/i.test(errorCode) || /expired|invalid/i.test(errorDescription)) {
        return {
            type: 'error',
            message: 'Ссылка подтверждения устарела или уже использована — ' +
                     'нажмите «Отправить письмо-подтверждение ещё раз».'
        };
    }

    return {
        type: 'error',
        message: `Ссылка подтверждения не сработала: ${errorDescription || errorCode}`
    };
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

    // Подсказки и кнопка повторной отправки письма относятся к конкретной
    // вкладке, поэтому при переключении их убираем (кто вызвал — тот и вернёт).
    document.getElementById('auth-note')?.classList.add('hidden');
    document.getElementById('resend-confirm-btn')?.classList.add('hidden');

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
    const noteEl = document.getElementById('auth-note');
    const resendBtn = document.getElementById('resend-confirm-btn');

    // Email последней попытки: по нему кнопка «отправить письмо ещё раз»
    // работает, даже если сотрудник уже переключился на вкладку регистрации.
    let lastAttemptedEmail = '';

    if (!authScreen || !loginForm || !registerForm) {
        log.error('Не найдены элементы экрана логина');
        return;
    }

    /** Красная строка ошибки под формой. */
    function showError(message) {
        if (!errorEl) return;
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }

    /**
     * Поясняющая строка под формой.
     * kind: 'error' — красная, 'ok' — зелёная, иначе — янтарная.
     */
    function showNote(message, kind = 'info') {
        if (!noteEl) return;
        const color = kind === 'error' ? 'text-red-500'
            : kind === 'ok' ? 'text-green-700'
            : 'text-amber-700';
        noteEl.className = `text-xs mt-3 text-center ${color}`;
        noteEl.textContent = message;
    }

    function hideResendButton() {
        if (resendBtn) resendBtn.classList.add('hidden');
    }

    // ----- Результат клика по ссылке из письма-подтверждения -----
    const redirectNotice = readAuthRedirectNotice();
    if (redirectNotice) {
        switchAuthTab('login');   // она прячет подсказки, поэтому сообщение — после неё
        if (redirectNotice.type === 'error') showError(redirectNotice.message);
        else showNote(redirectNotice.message, 'ok');
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
            lastAttemptedEmail = email;
            showError(describeAuthError(error.message));

            // Причина «Email not confirmed» — почти всегда недошедшее письмо,
            // поэтому сразу предлагаем отправить его повторно.
            if (/email not confirmed/i.test(error.message)) {
                if (resendBtn) resendBtn.classList.remove('hidden');
            } else {
                hideResendButton();
            }

            btn.disabled = false;
            btn.textContent = 'Войти';
            return;
        }

        lastAttemptedEmail = '';
        hideResendButton();

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

        const { user, needsConfirmation, error } = await signUp(email, password);

        btn.disabled = false;
        btn.textContent = 'Зарегистрироваться';

        if (error) {
            showError(describeAuthError(error.message));
            return;
        }

        // Confirm email включён: сессии нет, вход возможен только после письма.
        // Раньше приложение пыталось войти сразу и показывало «Email not confirmed».
        if (needsConfirmation) {
            lastAttemptedEmail = email;

            switchAuthTab('login');   // прячет подсказки — показываем их после переключения
            if (resendBtn) resendBtn.classList.remove('hidden');

            const loginEmail = document.getElementById('login-email');
            const loginPassword = document.getElementById('login-password');
            if (loginEmail) loginEmail.value = email;
            if (loginPassword) loginPassword.value = '';

            showNote(
                `✉️ Аккаунт ${email} создан. Подтверждение email включено, поэтому сначала откройте ` +
                'письмо и нажмите ссылку подтверждения, затем войдите с паролем. ' +
                'Письма нет — проверьте «Спам» и нажмите «Отправить письмо-подтверждение ещё раз».'
            );
            toast('Подтвердите email по ссылке из письма', 'info');
            return;
        }

        // Автоматически логиним после регистрации
        const loginResult = await signIn(email, password);

        if (loginResult.error) {
            showError('Регистрация прошла, но вход не удался: ' + describeAuthError(loginResult.error.message));
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

    // ----- Повторная отправка письма-подтверждения -----
    if (resendBtn) {
        resendBtn.addEventListener('click', async () => {
            const typed = document.getElementById('login-email')?.value || '';
            const email = typed.trim() || lastAttemptedEmail;

            if (!email) {
                showError('Сначала укажите email в форме — он нужен для повторной отправки.');
                return;
            }

            lastAttemptedEmail = email;
            resendBtn.disabled = true;
            resendBtn.textContent = 'Отправляем...';

            const { error } = await resendConfirmation(email);

            resendBtn.disabled = false;
            resendBtn.textContent = '✉️ Отправить письмо-подтверждение ещё раз';

            if (error) {
                showError(describeAuthError(error.message));
                return;
            }

            showNote(`✉️ Письмо отправлено на ${email}. Проверьте входящие и папку «Спам».`, 'ok');
        });
    }

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