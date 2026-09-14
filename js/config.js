// =====================================================================
// RSK ODESSA — ГЛОБАЛЬНАЯ КОНФИГУРАЦИЯ
// =====================================================================
// Этот файл содержит все настройки проекта.
// Меняешь здесь — меняется везде.
// =====================================================================

export const CONFIG = {
    // ----- SUPABASE (через Cloudflare Worker proxy) -----
    SUPABASE_URL: 'https://twilight-truth-ee41supabase-proxy-petrenko.petrenko1984-od.workers.dev',
    SUPABASE_ANON_KEY: 'sb_publishable_-WU_eSHHve_pXkcKT0hkLA_RJY78Fqq',

    // ----- STORAGE (бакеты для файлов) -----
    STORAGE: {
        ESTIMATES_BUCKET: 'estimates',      // Excel-файлы смет
        TASK_PHOTOS_BUCKET: 'task-photos',  // Фотографии задач
        RECEIPTS_BUCKET: 'receipts'         // Фото чеков / накладных
    },

    // ----- ПРИЛОЖЕНИЕ -----
    APP: {
        NAME: 'RSK Odessa',
        VERSION: '2.0.0',
        DEFAULT_REQUEST_PREFIX: 'З-'
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
        { value: 'шт',  label: 'шт' },
        { value: 'м',   label: 'м' },
        { value: 'кг',  label: 'кг' },
        { value: 'т',   label: 'т' },
        { value: 'м²',  label: 'м²' },
        { value: 'м³',  label: 'м³' },
        { value: 'уп',  label: 'уп' },
        { value: 'л',   label: 'л' },
        { value: 'меш', label: 'меш' }
    ],

    PRIORITIES: [
        { value: 'urgent',    label: '⚡ Срочно' },
        { value: 'important', label: '⭐ Важный' },
        { value: 'normal',    label: 'Обычная' }
    ],

    // ----- КАТЕГОРИИ РАСХОДОВ -----
    EXPENSE_CATEGORIES: [
        { value: 'materials', label: '📦 Материалы', icon: '📦' },
        { value: 'works',     label: '🛠 Работы',    icon: '🛠' },
        { value: 'delivery',  label: '🚚 Доставка',  icon: '🚚' },
        { value: 'other',     label: '📋 Прочее',    icon: '📋' }
    ],

    // ----- ТИПЫ ОПЕРАЦИЙ ПОДОТЧЁТА -----
    CASH_OPERATION_TYPES: {
        ISSUE:      'issue',       // Выдача подотчёта (+)
        EXPENSE:    'expense',     // Расход (−)
        RETURN:     'return',      // Возврат в кассу (−)
        ADJUSTMENT: 'adjustment'   // Корректировка (+)
    },

    // ----- СТАТУСЫ -----
    ORDER_STATUS: {
        NEW:         'new',
        IN_PROGRESS: 'in_progress',
        CLOSED:      'closed',
        ARCHIVED:    'archived'
    },

    PAYMENT_STATUS: {
        PAID: 'paid',
        DEBT: 'debt'
    },

    EMPLOYEE_STATUS: {
        ACTIVE:  'active',
        BLOCKED: 'blocked',
        FIRED:   'fired'
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

export const supabase = window.supabase.createClient(
    CONFIG.SUPABASE_URL,
    CONFIG.SUPABASE_ANON_KEY,
    {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false
        }
    }
);

console.log(`✅ ${CONFIG.APP.NAME} v${CONFIG.APP.VERSION} — Supabase подключён через Worker proxy`);