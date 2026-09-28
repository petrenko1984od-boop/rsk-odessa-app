// =====================================================================
// FREEDOM — ПРАВА ДОСТУПА
// =====================================================================
// Здесь три вещи:
//   1. ЗАВОДСКАЯ матрица прав — что роль может «из коробки» (ROLE_PERMISSIONS);
//   2. каталог прав — закрытый список для экрана «🔐 Доступы» (PERMISSION_CATALOG):
//      он же проверяет, что в базе нет строк о несуществующем праве;
//   3. ОТЗЫВЫ прав, сделанные Администратором в приложении: таблица
//      public.role_permissions (database/migrate-v2.12-role-permissions.sql).
//      Строка там означает «право у роли СНЯТО», и `can()` это учитывает.
//
// ⚠️ ЧЕГО ЗДЕСЬ НЕТ — ВЫДАЧИ ПРАВ. Экран умеет только отзывать: настоящая
// защита данных — политики RLS в Postgres, а они перечисляют роли ПО ИМЕНАМ.
// Выданное в приложении право база всё равно отклонит при записи («new row
// violates row-level security policy»), поэтому новые права ролям добавляются
// правкой ROLE_PERMISSIONS ВМЕСТЕ с политиками. Это описано и на самом экране.
// =====================================================================

import { getCurrentEmployee } from './auth.js';
import { CONFIG } from './config.js';
import { db } from './database.js';
import { log, toast } from './utils.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let currentRole = null;
let currentEmployee = null;

// =====================================================================
// МАТРИЦА ПРАВ ПО РОЛЯМ
// =====================================================================

const ROLE_PERMISSIONS = {
    'Администратор': [
        // Сотрудники
        'view_employees',
        'add_employee',
        'edit_employee',
        'block_employee',
        'restore_employee',
        'delete_employee',
        'link_account',
        'unlink_account',
        'view_tab_employees',
        // Подотчёт
        'cash_expense_self',
        'cash_return_self',
        'cash_issue',
        'cash_view_all',
        // Заявки финансов
        'process_cash_request',
        // Объекты
        'view_projects_all',
        'add_project',
        'edit_project',
        'delete_project',
        // Заявки на материалы
        'create_order',
        'process_order',
        // Задачи
        'create_task',
        'assign_task_to_employee',    // поставить задачу из карточки сотрудника
        'view_all_tasks',
        'cancel_any_task',
        // График работ, документация и смета
        'edit_gantt',
        'manage_files',              // документация по объекту (загрузка/удаление)
        'manage_estimate',           // файл сметы: виден только тройке ролей ниже
        // Дашборд
        'view_dashboard',
        // Вкладки
        'view_registry',
        'view_orders_tab',           // ← Снабжение
        'view_diagnostics',          // ← журнал ошибок (RLS пускает ту же пару ролей)
        'manage_access'              // ← экран «🔐 Доступы» (только эта роль)
    ],
    'Директор': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'cash_issue',
        'cash_view_all',
        'process_cash_request',
        'pay_material_invoice',       // отметить счёт снабжения оплаченным (безнал)
        'view_projects_all',
        'view_registry',
        'create_task',
        'assign_task_to_employee',    // поставить задачу из карточки сотрудника
        'view_all_tasks',
        'view_dashboard',
        // Вкладки
        'view_orders_tab',           // ← Снабжение: директор смотрит, но заявки не создаёт
        'view_diagnostics'           // ← журнал ошибок: то же чтение, что Администратор (RLS)
        // create_order — НЕТ (директор не создаёт заявки на материалы)
        // manage_estimate — НЕТ (смета — рабочий файл ПТО, директору блок сметы не показывается)
    ],
    'Главный инженер': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'cash_issue',
        'cash_view_all',
        'process_cash_request',
        'view_projects_all',
        'view_registry',
        'create_order',
        'create_task',
        'assign_task_to_employee',    // поставить задачу из карточки сотрудника
        'edit_gantt',
        'manage_files',
        'manage_estimate',            // файл сметы (блок на вкладке «📁 Файлы»)
        'view_dashboard'
        // view_orders_tab — НЕТ
    ],
    'Снабженец': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'view_projects_all',
        'view_registry',
        'create_order',
        'process_order',
        'become_task_assignee',
        'view_orders_tab'            // ← Снабжение
    ],
    'Инженер ПТО': [
        'view_employees',
        'view_tab_employees',
        'cash_expense_self',
        'cash_return_self',
        'view_projects_all',
        'view_registry',
        'create_order',
        'create_task',
        'become_task_assignee',
        'edit_gantt',
        'manage_files',
        'manage_estimate',            // файл сметы (блок на вкладке «📁 Файлы»)
        'view_dashboard'
        // view_orders_tab — НЕТ
    ],
    'Прораб': [
        // Только своё
        'cash_expense_self',
        'cash_return_self',
        'view_projects_own',
        'create_order',
        'become_task_assignee',
        'close_section',             // закрытие раздела на своём объекте
        'view_dashboard'
        // view_registry, view_orders_tab, manage_estimate — НЕТ
    ],
    'Финансист': [
        // Рабочий стол — одобренные директором заявки на финансирование.
        // Заявки он НЕ согласует (одобряет директор) и НЕ создаёт: только
        // выдаёт деньги по одобренным и отмечает «Выдано» — сумма уходит
        // с его подотчёта на подотчёт получателя (см. cash-requests.js).
        'cash_view_all',             // видит заявки всех сотрудников
        'issue_cash_request',        // выдача денег по одобренной заявке
        'cash_return_self',          // может вернуть остаток подотчёта в кассу
        'pay_material_invoice',      // оплата счетов снабжения (безнал фирмы):
                                     // деньги НЕ списываются с его подотчёта
        'view_projects_all',
        'view_registry',
        'view_employees',
        'view_tab_employees'
        // process_cash_request — НЕТ (это согласование директора)
        // cash_issue, cash_expense_self, create_order — НЕТ
    ]
};

// =====================================================================
// КАКИЕ ВКЛАДКИ ВИДНЫ ПО РОЛЯМ
// =====================================================================

const TAB_REQUIREMENTS = {
    'projects':      null,                   // Видна всем
    'employees':     'view_tab_employees',   // Только по праву
    'orders':        'view_orders_tab',      // Только Админ + Снабженец
    'cash-requests': 'cash_view_all',        // Кассиры (Админ, Директор, Гл. инженер) + Финансист
    'registry':      'view_registry',        // Только по праву
    // Журнал ошибок — внутренняя диагностика: читают Администратор и Директор
    // (та же пара ролей, что в RLS на public.app_errors,
    // database/migrate-v2.9-ops-monitoring.sql).
    'diagnostics':   'view_diagnostics',
    // Сметы (конструктор для ПТО): то же право, что у блока «📊 Смета объекта»
    // на вкладке «📁 Файлы» — Администратор, Главный инженер, Инженер ПТО.
    // В базе то же правило повторено политиками RLS: смета содержит цены
    // «наряд» и «кошторис», то есть прибыль компании
    // (database/migrate-v2.10-estimates.sql → rsk_is_estimate_editor()).
    'estimates':     'manage_estimate',
    // Доступы: матрица прав по ролям (js/modules/access.js). Право выдано
    // только Администратору и НЕ отзывается (LOCKED_PERMISSIONS): иначе он
    // закрыл бы себе вход на этот же экран, и вернуть его можно было бы лишь
    // SQL-запросом. В базе то же правило повторено политикой RLS на таблицу
    // role_permissions (database/migrate-v2.12-role-permissions.sql).
    'access':        'manage_access'
};

// =====================================================================
// УРЕЗАННЫЙ ИНТЕРФЕЙС ПО РОЛЯМ
// =====================================================================
// У некоторых ролей рабочее место — один экран, и остальные разделы только
// мешают. Здесь перечислено, что такая роль НЕ видит, как называется её
// раздел, в каком порядке стоят кнопки-разделы в шапке (`navOrder`) и куда
// она попадает после входа. Права (`ROLE_PERMISSIONS`) при этом
// не меняются — речь только о видимости разделов и кнопок. Если роли нужен
// раздел, которого у неё нет по правам, право добавляется там же, в матрице
// (так директору открыли раздел «Снабжение»: `view_orders_tab`).
const ROLE_UI = {
    'Снабженец': {
        // Остаётся: «Рабочий экран» (Снабжение) + «Реестр» + кнопка «Финансовые запросы»
        hiddenTabs:    ['tasks', 'projects', 'employees', 'cash-requests'],
        // «Заказ материалов» в шапке — дубль: заказ создаётся из «Рабочего экрана»
        hiddenButtons: ['btn-new-order'],
        // Для снабженца «Снабжение» и есть его рабочий экран
        navLabels:     { orders: '📋 Рабочий экран' },
        // После входа — сразу на рабочий экран, а не на «Добро пожаловать»
        startTab:      'orders'
    },

    'Директор': {
        // Видит все разделы, но заявок сам не оформляет: ни на материалы,
        // ни на свой подотчёт — он их согласует (одобрить / на доработку /
        // отклонить), передаёт на выдачу финансисту и пополняет его подотчёт.
        hiddenButtons: [
            'btn-new-order',            // «📦 Заказ материалов» в шапке
            'btn-new-cash-request',     // «💰 Финансовые запросы» в шапке
            'create-cash-request-btn'   // «➕ Создать заявку» внутри раздела «💰 Финансы»
        ]
    },

    'Финансист': {
        // Рабочий стол финансиста — раздел заявок на финансирование
        // (в шапке он называется «💼 Рабочий стол»): там только одобренные
        // директором заявки и выданные им же. Плюс «Реестр», «Объекты»
        // и «Сотрудники». Заявок на материалы и задач у него нет.
        hiddenTabs:    ['tasks', 'orders'],
        // Ничего не создаёт: ни заявок на материалы, ни заявок на подотчёт
        hiddenButtons: [
            'btn-new-order',
            'btn-new-cash-request',
            'create-cash-request-btn'
        ],
        navLabels:     { 'cash-requests': '💼 Рабочий стол' },
        // Порядок кнопок-разделов в шапке именно для этой роли: рабочий стол —
        // первым, потому что он и есть основное место работы финансиста
        // (у остальных ролей кнопки стоят в порядке разметки index.html).
        navOrder:      ['cash-requests', 'projects', 'employees', 'registry'],
        // После входа — сразу на свой рабочий стол
        startTab:      'cash-requests'
    }
};

// =====================================================================
// КАТАЛОГ ПРАВ — что показывает экран «🔐 Доступы»
// =====================================================================
// Группа названа ключом, а не заголовком: подписи живут в js/modules/access.js
// (LABELS), потому что права — это код, а подписи — интерфейс и язык. Прогон
// tools/checks/access-check.mjs сверяет, что у каждой группы и каждого права
// есть подпись на обоих языках и что каталог покрывает всю матрицу прав.
//
// Порядок групп и прав здесь — порядок строк на экране. Права, которых нет в
// каталоге, приложение не знает: строку о таком праве из базы оно игнорирует
// и показывает администратору предупреждение (право, возможно, осталось от
// старой версии — её каталог был другим).
export const PERMISSION_CATALOG = [
    {
        id: 'employees',
        rights: [
            'view_employees',       // список сотрудников и карточка сотрудника
            'view_tab_employees',   // сама вкладка «👥 Сотрудники»
            'add_employee',
            'edit_employee',
            'block_employee',
            'restore_employee',
            'delete_employee',
            'link_account',
            'unlink_account'
        ]
    },
    {
        id: 'projects',
        rights: [
            'view_projects_all',    // все объекты; без права — только свои
            'view_projects_own',    // объекты, где сотрудник прорабом
            'add_project',
            'edit_project',
            'delete_project'
        ]
    },
    {
        id: 'tasks',
        rights: [
            'create_task',
            'assign_task_to_employee',  // «➕ Поставить задачу» в карточке сотрудника
            'become_task_assignee',     // можно назначать исполнителем
            'view_all_tasks',           // задачи всех сотрудников, а не только свои
            'cancel_any_task'
        ]
    },
    {
        id: 'orders',
        rights: [
            'create_order',         // «📦 Заказ материалов»
            'process_order'         // принять, закрыть, отправить в архив
        ]
    },
    {
        id: 'money',
        rights: [
            'cash_expense_self',        // расход со своего подотчёта
            'cash_return_self',         // возврат остатка в кассу
            'cash_issue',               // выдать деньги и пополнить подотчёт
            'cash_view_all',            // подотчёты всех сотрудников
            'process_cash_request',     // согласовать заявку (одобрить / доработка / отказ)
            'issue_cash_request',       // выдать деньги по одобренной заявке
            'pay_material_invoice'      // отметить счёт снабжения оплаченным (безнал)
        ]
    },
    {
        id: 'site',
        rights: [
            'edit_gantt',           // график работ объекта
            'manage_files',         // документация по объекту
            'manage_estimate',      // файл сметы (цены «наряд» и «кошторис»)
            'close_section'         // закрыть раздел на своём объекте
        ]
    },
    {
        id: 'tabs',
        rights: [
            'view_registry',        // раздел «📊 Реестр»
            'view_orders_tab',      // раздел «📦 Снабжение»
            'view_diagnostics',     // раздел «🩺 Диагностика» (RLS пускает ту же пару ролей)
            'view_dashboard'        // личный экран сотрудника вместо списка задач
        ]
    },
    {
        // Служебные права: у них своя защита, и отзывать их нельзя (см.
        // LOCKED_PERMISSIONS). На экране они стоят последней группой.
        id: 'system',
        rights: [
            'manage_access'         // этот самый экран «🔐 Доступы»
        ]
    }
];

/** Все права, которые знает приложение (закрытый список). */
export const ALL_PERMISSIONS = PERMISSION_CATALOG.flatMap((group) => group.rights);

/**
 * Права, которые экран «🔐 Доступы» не отзывает.
 *
 * `manage_access` — вход на сам экран: сняв его у Администратора, он закрыл бы
 * себе управление доступами, и вернуть право можно было бы только SQL-запросом
 * в Supabase. Такие права показываются на экране с замком.
 */
export const LOCKED_PERMISSIONS = ['manage_access'];

// =====================================================================
// ОТЗЫВЫ ПРАВ ИЗ БАЗЫ (public.role_permissions)
// =====================================================================
// Здесь хранится то, что администратор снял в приложении:
//     роль → Map<право, { revoked, changed_at, changed_by }>
// Права, которых в этом хранилище нет, работают как записаны в коде
// (ROLE_PERMISSIONS) — поэтому таблица в базе почти всегда пустая.
//
// ⚠️ Хранилище только УРЕЗАЕТ права. Строку с revoked = false экран пишет,
// когда администратор возвращает заводское значение: так в таблице остаётся
// история («это право когда-то снимали»), а поведение становится прежним.
// =====================================================================

const revocationStore = new Map();

let storeRead = false;      // отзывы прочитаны из базы
let storeReason = '';       // почему не прочитались: '' | 'no_table' | 'error'
let storeMessage = '';      // техническая причина (для подсказки на экране)
let storeUnknown = [];      // строки о правах/ролях, которых в коде больше нет

/** Есть ли у роли право по ЗАВОДСКОЙ матрице (без учёта отзывов). */
export function isPermissionDefault(role, right) {
    return (ROLE_PERMISSIONS[role] || []).includes(right);
}

/** Снято ли право у роли администратором (таблица public.role_permissions). */
export function isPermissionRevoked(role, right) {
    const forRole = revocationStore.get(role);
    const row = forRole && forRole.get(right);
    return !!(row && row.revoked);
}

/** Служебное право: показывается на экране с замком и не отзывается. */
export function isPermissionLocked(right) {
    return LOCKED_PERMISSIONS.includes(right);
}

/** Знает ли приложение такое право (каталог — закрытый список). */
export function isPermissionKnown(right) {
    return ALL_PERMISSIONS.includes(right);
}

/**
 * Каталог групп и прав для экрана «🔐 Доступы»: тот же закрытый список, по
 * которому проверяются строки из базы. Отдаём как есть — экран только читает
 * его (группы и порядок строк), поэтому копию не делаем.
 */
export function getPermissionCatalog() {
    return PERMISSION_CATALOG;
}

/**
 * Роли для колонок экрана — в порядке справочника должностей
 * (CONFIG.POSITIONS, он же список для формы сотрудника). Роль без матрицы
 * прав в этот список не попадает: у неё доступ «по минимуму».
 */
export function getRoles() {
    return CONFIG.POSITIONS.filter((role) => Array.isArray(ROLE_PERMISSIONS[role]));
}

/** Права роли С УЧЁТОМ отзывов — то, чем роль реально пользуется сейчас. */
export function getRolePermissions(role) {
    return (ROLE_PERMISSIONS[role] || []).filter((right) => !isPermissionRevoked(role, right));
}

/** Что записано в базе про пару «роль + право» (или null). */
export function getRevocationRow(role, right) {
    const forRole = revocationStore.get(role);
    const row = forRole && forRole.get(right);
    return row ? { ...row } : null;
}

/** Состояние хранилища: прочитано ли, что не поняли, сколько строк. */
export function getRevocationStore() {
    let rows = 0;
    revocationStore.forEach((forRole) => { rows += forRole.size; });

    return {
        read: storeRead,
        reason: storeReason,
        message: storeMessage,
        rows,
        unknown: [...storeUnknown]
    };
}

/**
 * Читает отзывы прав из базы. Вызывается при входе (loadPermissions) и кнопкой
 * «🔄 Обновить» на экране «🔐 Доступы».
 *
 * Если таблицы ещё нет (миграция v2.12.0 не применена), приложение работает по
 * заводской матрице, а экран показывает, какой файл применить, — как раздел
 * «🩺 Диагностика» при отсутствии журнала ошибок.
 *
 * @returns {{ ok: boolean, reason: string, message: string, unknown: string[] }}
 */
export async function loadPermissionRevocations() {
    const { data, error } = await db.select('role_permissions', {
        select: 'role, permission, revoked, changed_at, changed_by'
    });

    if (error) {
        const text = error.message || String(error);
        // PGRST205 / 42P01 — PostgREST не находит таблицу: это не сбой связи,
        // а неприменённая миграция, и подсказка должна называть файл.
        storeReason = /PGRST205|42P01|Could not find the table/i.test(text) ? 'no_table' : 'error';
        storeMessage = text;
        storeRead = false;

        log.warn(`⚠️ Отзывы прав не прочитаны (${storeReason}): ${text}`);
        return { ok: false, reason: storeReason, message: storeMessage, unknown: [] };
    }

    revocationStore.clear();
    storeUnknown = [];

    (data || []).forEach((row) => {
        const role = String(row.role || '');
        const right = String(row.permission || '');

        // Строку о роли или праве, которых нет в коде, применить не к чему.
        // Показываем администратору перечень: чаще всего это право, которое
        // переименовали в новой версии.
        if (!ROLE_PERMISSIONS[role] || !isPermissionKnown(right)) {
            storeUnknown.push(`${role} → ${right}`);
            return;
        }

        if (!revocationStore.has(role)) revocationStore.set(role, new Map());
        revocationStore.get(role).set(right, {
            revoked: row.revoked !== false,
            changed_at: row.changed_at || null,
            changed_by: row.changed_by || null
        });
    });

    storeRead = true;
    storeReason = '';
    storeMessage = '';

    const state = getRevocationStore();
    const revokedCount = getRoles().reduce((sum, role) =>
        sum + (ROLE_PERMISSIONS[role] || []).filter((right) => isPermissionRevoked(role, right)).length, 0);

    log.auth(`Отзывы прав прочитаны: строк ${state.rows}, снятых прав ${revokedCount}` +
        (state.unknown.length ? `, не понято ${state.unknown.length}` : ''));

    return { ok: true, reason: 'ok', message: '', unknown: [...state.unknown] };
}

/**
 * Сохраняет решения администратора: [{ role, permission, revoked }].
 *
 * Строк, которых в базе ещё нет, — добавляются; уже известные — обновляются
 * (`revoked = false` возвращает право к заводскому, но строка остаётся ради
 * истории). Служебные права (LOCKED_PERMISSIONS) и неизвестные значения
 * отклоняются здесь же: в базу они не уходят и мусора не создают.
 *
 * @returns {{ ok: boolean, saved: number, failed: Array<{role: string, permission: string, reason: string, message: string}> }}
 */
export async function savePermissionRevocations(changes) {
    const list = Array.isArray(changes) ? changes : [];
    const failed = [];
    let saved = 0;

    for (const change of list) {
        const role = String(change?.role || '');
        const right = String(change?.permission || '');
        const revoked = change?.revoked !== false;

        if (!ROLE_PERMISSIONS[role]) {
            failed.push({ role, permission: right, reason: 'unknown_role', message: `Неизвестная должность: ${role}` });
            continue;
        }
        if (!isPermissionKnown(right)) {
            failed.push({ role, permission: right, reason: 'unknown_permission', message: `Неизвестное право: ${right}` });
            continue;
        }
        if (isPermissionLocked(right)) {
            failed.push({ role, permission: right, reason: 'locked', message: `Служебное право не отзывается: ${right}` });
            continue;
        }

        const exists = !!(revocationStore.get(role) && revocationStore.get(role).has(right));
        let error = null;

        if (!exists && revoked) {
            ({ error } = await db.insert('role_permissions', { role, permission: right, revoked: true }));
        } else if (exists) {
            ({ error } = await db.update('role_permissions', { revoked }, { role, permission: right }));
        } else {
            // Строки нет, и возвращать к заводскому нечего: право и так работает.
            continue;
        }

        if (error) {
            failed.push({ role, permission: right, reason: 'save_error', message: error.message || String(error) });
            continue;
        }

        if (!revocationStore.has(role)) revocationStore.set(role, new Map());
        revocationStore.get(role).set(right, {
            revoked,
            // Время и сотрудника ставит сама база (триггер): локально держим
            // только свежую отметку для экрана, до следующего чтения.
            changed_at: new Date().toISOString(),
            changed_by: currentEmployee ? currentEmployee.id : null
        });
        saved += 1;
    }

    return { ok: failed.length === 0, saved, failed };
}

// =====================================================================
// ЗАГРУЗКА ПРАВ
// =====================================================================

export async function loadPermissions() {
    const { employee, error } = await getCurrentEmployee();

    if (error || !employee) {
        currentRole = null;
        currentEmployee = null;
        log.warn('⚠️ Пользователь не привязан к сотруднику. Права: минимум.');
        return;
    }

    currentEmployee = employee;
    currentRole = employee.position || null;

    if (currentRole && !ROLE_PERMISSIONS[currentRole]) {
        log.warn(`⚠️ Должность "${currentRole}" отсутствует в матрице прав — доступ по минимуму. Проверь справочник CONFIG.POSITIONS.`);
    }

    log.auth(`Права загружены. Роль: ${currentRole}`);

    // Отзывы прав, сделанные администратором в приложении (экран «🔐 Доступы»).
    // Читаются ПОСЛЕ роли: хранилище сверяет строки с матрицей и каталогом.
    // Неудача чтения (нет миграции v2.12.0) не мешает работать: остаются
    // заводские права из ROLE_PERMISSIONS, а экран «🔐 Доступы» показывает,
    // какой файл применить.
    await loadPermissionRevocations();
}

// =====================================================================
// ПРОВЕРКА ПРАВ
// =====================================================================

/**
 * Может ли роль выполнить действие.
 *
 * Право берётся из заводской матрицы (ROLE_PERMISSIONS) и УРЕЗАЕТСЯ отзывом,
 * который администратор сделал в приложении («🔐 Доступы» → public.role_permissions):
 *     право есть в коде и не снято — true;
 *     право снято администратором — false, даже если оно есть в коде.
 * Выдать право сверх кода экран не может — это делается правкой матрицы
 * вместе с политиками RLS (см. шапку файла).
 */
export function can(action) {
    if (!currentRole) return false;
    if (isPermissionRevoked(currentRole, action)) return false;
    const permissions = ROLE_PERMISSIONS[currentRole] || [];
    return permissions.includes(action);
}

export function getRole() {
    return currentRole;
}

export function getEmployee() {
    return currentEmployee;
}

export function isAdmin() {
    return currentRole === 'Администратор';
}

export function isLinked() {
    return currentEmployee !== null;
}

/**
 * Проверяет, может ли текущий пользователь ВИДЕТЬ вкладку.
 * Сначала учитывается урезанный интерфейс роли (ROLE_UI), потом права.
 */
export function canSeeTab(tabId) {
    const ui = ROLE_UI[currentRole];
    const hiddenTabs = (ui && ui.hiddenTabs) || [];
    if (hiddenTabs.includes(tabId)) return false;

    const required = TAB_REQUIREMENTS[tabId];
    if (!required) return true;
    return can(required);
}

/**
 * Проверяет, видна ли роль кнопка-действие (по id элемента).
 * Это кнопки-действия в шапке («Заказ материалов», «Финансовые запросы»)
 * и их дубли внутри разделов (например, «➕ Создать заявку» во вкладке
 * «💰 Финансы»): кнопки, перечисленные в ROLE_UI.hiddenButtons, скрыты.
 */
export function canSeeHeaderButton(buttonId) {
    const ui = ROLE_UI[currentRole];
    const hiddenButtons = (ui && ui.hiddenButtons) || [];
    return !hiddenButtons.includes(buttonId);
}

/**
 * Своё название раздела для роли (например, снабженец видит «Снабжение»
 * как «📋 Рабочий экран»). Возвращает null, если название стандартное.
 */
export function getNavLabel(tabId) {
    const ui = ROLE_UI[currentRole];
    if (!ui || !ui.navLabels) return null;
    return ui.navLabels[tabId] || null;
}

/**
 * Свой порядок кнопок-разделов в шапке для роли (например, у финансиста
 * «💼 Рабочий стол» стоит первым). Возвращает null — значит порядок общий,
 * как в разметке index.html.
 */
export function getNavOrder() {
    const ui = ROLE_UI[currentRole];
    return (ui && ui.navOrder) || null;
}

/**
 * Вкладка, которую роль открывает сразу после входа.
 * Возвращает null — значит показываем «Добро пожаловать».
 *
 * Раздел мог быть закрыт администратором (отзыв права в «🔐 Доступах»): тогда
 * вход не должен бросать сотрудника в раздел, которого он не видит, — иначе
 * вместо рабочего экрана он получил бы тост «Недостаточно прав» и пустоту.
 */
export function getStartTab() {
    const ui = ROLE_UI[currentRole];
    const tab = (ui && ui.startTab) || null;
    if (!tab) return null;
    return canSeeTab(tab) ? tab : null;
}

/**
 * Требует наличия права. Если нет — тост + возврат false.
 */
export function requirePermission(action) {
    if (can(action)) return true;

    toast('Недостаточно прав для этого действия', 'error');

    log.warn(`❌ Отказано в доступе: ${action}. Роль: ${currentRole || 'не привязан'}`);
    return false;
}

export function getAllPermissions() {
    if (!currentRole) return [];
    return getRolePermissions(currentRole);
}

// Отладка через консоль
window.Permissions = {
    can,
    canSeeTab,
    canSeeHeaderButton,
    getNavLabel,
    getNavOrder,
    getStartTab,
    getRole,
    isAdmin,
    getAllPermissions,
    // экран «🔐 Доступы» (js/modules/access.js) и разбор проблем из консоли
    getRoles,
    getRolePermissions,
    getPermissionCatalog,
    isPermissionDefault,
    isPermissionRevoked,
    isPermissionLocked,
    isPermissionKnown,
    getRevocationStore,
    loadPermissionRevocations,
    savePermissionRevocations
};