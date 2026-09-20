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

    // ----- СЛУЖЕБНЫЙ РАЗДЕЛ «ДОП. РАСХОДЫ» (вне сметы) -----
    // Работы и материалы, которых НЕТ в смете (незапланированные заказы, покупки
    // и оплата работникам), сотрудник привязывает к объекту через этот раздел.
    //   1) раздел с таким названием создаётся автоматически — по одному на объект
    //      (js/modules/sections.js → loadSectionsWithExtra);
    //   2) он НЕ приходит из Excel, не удаляется при перезагрузке и удалении сметы;
    //   3) в план-факте и графике он не показывается как раздел сметы —
    //      его траты собраны на подвкладке «📦 Доп. расходы» карточки объекта.
    // Имя — ключ сопоставления, поэтому менять его «на ходу» нельзя:
    // иначе приложение перестанет узнавать уже созданные разделы.
    EXTRA_SECTION: {
        NAME: 'Доп. расходы',
        OPTION_LABEL: '⚠ Доп. расходы (вне сметы)'
    },

    // ----- ПРИЛОЖЕНИЕ -----
    APP: {
        NAME: 'RSK Odessa',
        VERSION: '2.2.3',
        DEFAULT_REQUEST_PREFIX: 'З-',
        // true — печатать в консоль все SQL-запросы (log.db) и подробный лог.
        // В продакшене держим false, чтобы не светить данные и не тормозить приложение.
        DEBUG: false
    },

    // ----- СПРАВОЧНИКИ -----
    POSITIONS: [
        'Директор',
        'Администратор',
        'Главный инженер',
        'Прораб',
        'Снабженец',
        'Инженер ПТО',
        'Финансист'      // выдаёт деньги по заявкам, одобренным директором
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