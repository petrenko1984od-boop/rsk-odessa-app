// =====================================================================
// RSK ODESSA — ГЛОБАЛЬНАЯ КОНФИГУРАЦИЯ
// =====================================================================
// Этот файл содержит все настройки проекта.
// Меняешь здесь — меняется везде.
// =====================================================================

export const CONFIG = {
    // ----- SUPABASE -----
    SUPABASE_URL: 'https://qqdnovbbjytanknlcinx.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_-WU_eSHHve_pXkcKT0hkLA_RJY78Fqq',

    // ----- STORAGE (бакеты для файлов) -----
    STORAGE: {
        ESTIMATES_BUCKET: 'estimates',      // Excel-файлы смет
        TASK_PHOTOS_BUCKET: 'task-photos'   // Фотографии задач
    },

    // ----- ПРИЛОЖЕНИЕ -----
    APP: {
        NAME: 'RSK Odessa',
        VERSION: '2.0.0',
        DEFAULT_REQUEST_PREFIX: 'З-'  // Префикс номера заявки
    },

    // ----- СПРАВОЧНИКИ -----
    POSITIONS: [
        'Директор',
        'Администратор',
        'Главный инженер',
        'Прораб',
        'Снабженец',
        'Инженер ПТО'
    ],

    UNITS: [
        { value: 'шт', label: 'шт' },
        { value: 'м', label: 'м' },
        { value: 'кг', label: 'кг' },
        { value: 'т', label: 'т' },
        { value: 'м²', label: 'м²' },
        { value: 'м³', label: 'м³' },
        { value: 'уп', label: 'уп' },
        { value: 'л', label: 'л' }
    ],

    PRIORITIES: [
        { value: 'urgent', label: '⚡ Срочно' },
        { value: 'important', label: '⭐ Важный' },
        { value: 'normal', label: 'Обычная' }
    ],

    // ----- СТАТУСЫ -----
    ORDER_STATUS: {
        NEW: 'new',
        IN_PROGRESS: 'in_progress',
        CLOSED: 'closed',
        ARCHIVED: 'archived'
    },

    PAYMENT_STATUS: {
        PAID: 'paid',
        DEBT: 'debt'
    },

    // ----- UI -----
    UI: {
        TOAST_DURATION_MS: 3000,
        MODAL_ANIMATION_MS: 200
    }
};

// =====================================================================
// СОЗДАНИЕ КЛИЕНТА SUPABASE
// =====================================================================
// Клиент инициализируется здесь и экспортируется как синглтон.
// Все модули используют его через: import { supabase } from './config.js';
// =====================================================================

// window.supabase — это библиотека, загруженная в index.html через CDN.
// Мы обращаемся к ней через window, чтобы не путать с нашим клиентом.
export const supabase = window.supabase.createClient(
    CONFIG.SUPABASE_URL,
    CONFIG.SUPABASE_ANON_KEY,
    {
        auth: {
            persistSession: true,       // сохранять сессию между перезагрузками
            autoRefreshToken: true,      // автоматически продлевать токен
            detectSessionInUrl: false    // нам не нужны magic-ссылки
        }
    }
);

// Логируем успешную инициализацию
console.log(`✅ ${CONFIG.APP.NAME} v${CONFIG.APP.VERSION} — Supabase подключён`);