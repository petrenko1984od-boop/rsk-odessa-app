// =====================================================================
// FREEDOM — ПРАВА ДОСТУПА
// =====================================================================
// Здесь три вещи:
//   1. ЗАВОДСКАЯ матрица прав — что роль может «из коробки» (ROLE_PERMISSIONS);
//   2. каталог прав — закрытый список для экрана «🔐 Доступы» (PERMISSION_CATALOG):
//      он же проверяет, что в базе нет строк о несуществующем праве;
//   3. ПРАВКИ прав, сделанные Администратором в приложении: таблица
//      public.role_permissions (database/migrate-v2.12-role-permissions.sql).
//      Строка там означает «право у роли СНЯТО» (revoked) или «ВЫДАНО сверх
//      кода» (granted), и `can()` учитывает оба решения.
//
// ⚠️ ВЫДАЧА ПРАВА ДЕЙСТВУЕТ НЕ ТОЛЬКО В ИНТЕРФЕЙСЕ. Право, поставленное
//    галочкой на экране «🔐 Доступы», обязана принять и база: иначе кнопка
//    открывала бы форму, которую RLS отклоняет при записи. Поэтому выдача
//    ложится в ту же строку public.role_permissions (granted = true), а
//    миграция v2.12.0 добавляет в политики RLS, в редактор смет и в
//    финансовые RPC проверку public.rsk_permission_granted() — она спрашивает
//    у той же таблицы. Права, которые меняются только кодом, — служебные
//    (LOCKED_PERMISSIONS): вход на сам экран.
//
// ⚠️ ЧЕГО ЭКРАН НЕ ДЕЛАЕТ. Он не меняет саму защиту: отзыв закрывает раздел,
//    кнопку и действие, но данные на закрытых таблицах всё равно стерегут
//    политики Postgres (они знают роли по именам). Выдача идёт ПО ЗАВОДСКИМ
//    правилам роли: политики, которые разрешают строку только автору («только
//    своя заявка»), остаются в силе и для выданного права.
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
    // только Администратору и НЕ меняется (LOCKED_PERMISSIONS): иначе он
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
//
// ⚠️ Администратор сильнее этого списка: выдача права в «🔐 Доступах» снимает
//    скрытие РАЗДЕЛА (см. canSeeTab). Иначе галочка в матрице открывала бы право,
//    которого сотрудник всё равно не видит. Кнопки-дубли (hiddenButtons) так
//    снять нельзя: у них нет своего права — это не запрет, а способ не
//    дублировать действие (заказ материалов создаётся из «Рабочего экрана»).
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
        // Служебные права: у них своя защита, и менять их нельзя (см.
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
 * Права, которые экран «🔐 Доступы» не меняет ни в одну сторону.
 *
 * `manage_access` — вход на сам экран. Сняв его у Администратора, он закрыл бы
 * себе управление доступами; выдав его другой роли, он показал бы экран, где
 * «💾 Сохранить» всё равно отклоняет база (таблица role_permissions принимает
 * записи только от Администратора). И то и другое чинилось бы лишь SQL-запросом
 * в Supabase, поэтому такие права стоят на экране с замком.
 */
export const LOCKED_PERMISSIONS = ['manage_access'];

// =====================================================================
// ПРАВКИ ПРАВ ИЗ БАЗЫ (public.role_permissions)
// =====================================================================
// Здесь хранится то, что администратор изменил в приложении:
//     роль → Map<право, { revoked, granted, changed_at, changed_by }>
// Права, которых в этом хранилище нет, работают как записаны в коде
// (ROLE_PERMISSIONS) — поэтому таблица в базе почти всегда пустая.
//
// Состояний у клетки матрицы три, и записываются они так:
//     revoked = true                    — право СНЯТО у роли;
//     granted = true                    — право ВЫДАНО сверх кода (у роли его не
//                                         было; теперь есть — и в интерфейсе,
//                                         и в базе: см. шапку файла);
//     revoked = false, granted = false  — вернули заводское значение. Строка
//                                         остаётся ради истории («это право
//                                         когда-то меняли»).
// Оба флага сразу невозможны: база держит это ограничением
// role_permissions_override_check.
// =====================================================================

const overrideStore = new Map();

let storeRead = false;      // правки прав прочитаны из базы
let storeReason = '';       // почему не прочитались: '' | 'no_table' | 'error'
let storeMessage = '';      // техническая причина (для подсказки на экране)
let storeUnknown = [];      // строки о правах/ролях, которых в коде больше нет

/** Строка хранилища для пары «роль + право» (или null, если её нет). */
function overrideOf(role, right) {
    const forRole = overrideStore.get(role);
    const row = forRole ? forRole.get(right) : null;

    // Map.get отдаёт undefined для отсутствующей пары, а вызывающий код
    // сравнивает результат именно с null: иначе «строки нет» выглядело бы как
    // «строка есть» и экран обновлял бы несуществующую запись вместо insert.
    return row || null;
}

/** Есть ли у роли право по ЗАВОДСКОЙ матрице (без правок администратора). */
export function isPermissionDefault(role, right) {
    return (ROLE_PERMISSIONS[role] || []).includes(right);
}

/** Снято ли право у роли администратором (таблица public.role_permissions). */
export function isPermissionRevoked(role, right) {
    const row = overrideOf(role, right);
    return !!(row && row.revoked);
}

/**
 * Выдано ли право роли администратором сверх заводской матрицы.
 * Отозванное право выданным не считается, даже если строка когда-то была и
 * выдачей (оба флага сразу база не принимает — см. ограничение таблицы).
 */
export function isPermissionGranted(role, right) {
    const row = overrideOf(role, right);
    return !!(row && row.granted && !row.revoked);
}

/**
 * Что стоит в клетке матрицы «право × роль»:
 *     'granted' — право выдано администратором (в коде у роли его не было);
 *     'revoked' — право снято администратором;
 *     'factory' — как в коде: строки в базе нет либо она вернула заводское.
 */
export function getPermissionState(role, right) {
    if (isPermissionGranted(role, right)) return 'granted';
    if (isPermissionRevoked(role, right)) return 'revoked';
    return 'factory';
}

/**
 * Действует ли право у роли ПРЯМО СЕЙЧАС: заводская матрица + выдачи − отзывы.
 *
 * Этим вопросом живёт и `can()` текущего сотрудника, и клетки экрана «🔐
 * Доступы», поэтому интерфейс и права роли всегда отвечают одинаково.
 */
export function hasPermission(role, right) {
    const state = getPermissionState(role, right);
    if (state === 'granted') return true;
    if (state === 'revoked') return false;
    return isPermissionDefault(role, right);
}

/** Служебное право: показывается на экране с замком и не меняется. */
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

/**
 * Права роли С УЧЁТОМ правок администратора — то, чем роль реально пользуется
 * сейчас. Порядок — как в каталоге (js/permissions.js → PERMISSION_CATALOG):
 * выданное право встаёт на своё место в списке, а не в конец.
 */
export function getRolePermissions(role) {
    return ALL_PERMISSIONS.filter((right) => hasPermission(role, right));
}

/** Что записано в базе про пару «роль + право» (или null). */
export function getPermissionOverrideRow(role, right) {
    const row = overrideOf(role, right);
    return row ? { ...row } : null;
}

/** Сколько прав сейчас отозвано, выдано и сколько строк лежит в базе. */
export function getPermissionCounts() {
    let rows = 0;
    let revoked = 0;
    let granted = 0;

    overrideStore.forEach((forRole) => {
        rows += forRole.size;
        forRole.forEach((row) => {
            if (row.revoked) revoked += 1;
            else if (row.granted) granted += 1;
        });
    });

    return { rows, revoked, granted };
}

/** Состояние хранилища: прочитано ли, что не поняли, сколько строк. */
export function getPermissionStore() {
    return {
        read: storeRead,
        reason: storeReason,
        message: storeMessage,
        ...getPermissionCounts(),
        unknown: [...storeUnknown]
    };
}

/**
 * Читает правки прав из базы. Вызывается при входе (loadPermissions) и кнопкой
 * «🔄 Обновить» на экране «🔐 Доступы».
 *
 * Если таблицы ещё нет (миграция v2.12.0 не применена), приложение работает по
 * заводской матрице, а экран показывает, какой файл применить, — как раздел
 * «🩺 Диагностика» при отсутствии журнала ошибок. Неудачное чтение безопасно
 * только пока таблица умеет ОТЗЫВАТЬ права: потерять отзыв — значит показать
 * лишнюю кнопку, а вот потерять выдачу — значит спрятать право, которое админ
 * дал, поэтому при ошибке чтения экран не даёт сохранять (см. js/modules/access.js).
 *
 * @returns {{ ok: boolean, reason: string, message: string, unknown: string[] }}
 */
export async function loadPermissionOverrides() {
    const { data, error } = await db.select('role_permissions', {
        select: 'role, permission, revoked, granted, changed_at, changed_by'
    });

    if (error) {
        const text = error.message || String(error);
        // PGRST205 / 42P01 — PostgREST не находит таблицу: это не сбой связи,
        // а неприменённая миграция, и подсказка должна называть файл.
        // Отдельный случай — таблица есть, а колонки granted нет: файл v2.12.0
        // применяли до появления выдачи прав (PGRST204 / 42703).
        storeReason = /PGRST205|42P01|Could not find the table/i.test(text) ? 'no_table'
            : /PGRST204|42703|granted/i.test(text) ? 'no_column' : 'error';
        storeMessage = text;
        storeRead = false;

        log.warn(`⚠️ Правки прав не прочитаны (${storeReason}): ${text}`);
        return { ok: false, reason: storeReason, message: storeMessage, unknown: [] };
    }

    overrideStore.clear();
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

        if (!overrideStore.has(role)) overrideStore.set(role, new Map());
        overrideStore.get(role).set(right, {
            revoked: row.revoked === true,
            granted: row.granted === true,
            changed_at: row.changed_at || null,
            changed_by: row.changed_by || null
        });
    });

    storeRead = true;
    storeReason = '';
    storeMessage = '';

    const state = getPermissionStore();

    log.auth(`Правки прав прочитаны: строк ${state.rows}, отозвано ${state.revoked}, выдано ${state.granted}` +
        (state.unknown.length ? `, не понято ${state.unknown.length}` : ''));

    return { ok: true, reason: 'ok', message: '', unknown: [...state.unknown] };
}

/**
 * Сохраняет решения администратора: [{ role, permission, allowed }].
 *
 * `allowed` — то, что стоит в клетке: true — галочка, false — пусто. Флаги
 * строки (revoked / granted) считаются здесь, а не на экране: решение у
 * администратора одно («право работает / не работает»), а запись в базу — это
 * два разных факта, и склеивать их в разметке значило бы разойтись с `can()`.
 *
 *     галочка + право есть в коде → заводское (revoked = false, granted = false);
 *     галочка + права в коде нет  → ВЫДАЧА (granted = true);
 *     пусто   + право есть в коде → ОТЗЫВ (revoked = true);
 *     пусто   + права в коде нет  → заводское (и так нет права).
 *
 * Строк, которых в базе ещё нет, — добавляются; уже известные — обновляются
 * (возврат к заводскому строку НЕ удаляет: остаётся история «это право
 * когда-то меняли»). Служебные права (LOCKED_PERMISSIONS) и неизвестные
 * значения отклоняются здесь же: в базу они не уходят и мусора не создают.
 *
 * @returns {{ ok: boolean, saved: number, failed: Array<{role: string, permission: string, reason: string, message: string}> }}
 */
export async function savePermissionOverrides(changes) {
    const list = Array.isArray(changes) ? changes : [];
    const failed = [];
    let saved = 0;

    for (const change of list) {
        const role = String(change?.role || '');
        const right = String(change?.permission || '');
        const allowed = change?.allowed === true;

        if (!ROLE_PERMISSIONS[role]) {
            failed.push({ role, permission: right, reason: 'unknown_role', message: `Неизвестная должность: ${role}` });
            continue;
        }
        if (!isPermissionKnown(right)) {
            failed.push({ role, permission: right, reason: 'unknown_permission', message: `Неизвестное право: ${right}` });
            continue;
        }
        if (isPermissionLocked(right)) {
            failed.push({ role, permission: right, reason: 'locked', message: `Служебное право не меняется: ${right}` });
            continue;
        }

        const factory = isPermissionDefault(role, right);
        const revoked = allowed ? false : factory;
        const granted = allowed && !factory;
        const exists = overrideOf(role, right) !== null;
        let error = null;

        if (!exists && !revoked && !granted) {
            // Строки нет и менять нечего: право и так работает по коду.
            continue;
        }

        if (!exists) {
            ({ error } = await db.insert('role_permissions', { role, permission: right, revoked, granted }));
        } else {
            ({ error } = await db.update('role_permissions', { revoked, granted }, { role, permission: right }));
        }

        if (error) {
            failed.push({ role, permission: right, reason: 'save_error', message: error.message || String(error) });
            continue;
        }

        if (!overrideStore.has(role)) overrideStore.set(role, new Map());
        overrideStore.get(role).set(right, {
            revoked,
            granted,
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

    // Правки прав, сделанные администратором в приложении (экран «🔐 Доступы»):
    // и отзывы, и выдачи. Читаются ПОСЛЕ роли: хранилище сверяет строки с
    // матрицей и каталогом. Неудача чтения (нет миграции v2.12.0) не мешает
    // работать: остаются заводские права из ROLE_PERMISSIONS, а экран
    // «🔐 Доступы» показывает, какой файл применить.
    await loadPermissionOverrides();
}

// =====================================================================
// ПРОВЕРКА ПРАВ
// =====================================================================

/**
 * Может ли роль выполнить действие.
 *
 * Право берётся из заводской матрицы (ROLE_PERMISSIONS), к нему применяются
 * правки администратора из раздела «🔐 Доступы» (public.role_permissions):
 *     право выдано администратором — true, даже если в коде его у роли не было;
 *     право снято администратором  — false, даже если оно есть в коде;
 *     правок нет                   — как записано в коде.
 * Тот же ответ даёт hasPermission(), которым живут клетки матрицы на экране, —
 * поэтому галочка и работа приложения не могут разойтись.
 */
export function can(action) {
    if (!currentRole) return false;
    return hasPermission(currentRole, action);
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
 *
 * ⚠️ Явная выдача права в «🔐 Доступах» сильнее урезанного рабочего места:
 * администратор видел эту строку матрицы и поставил галочку, значит раздел роли
 * нужен. Без этого правила галочка у «Снабженца» или «Финансиста» открывала бы
 * право, которого всё равно не видно (например, `view_tab_employees`).
 */
export function canSeeTab(tabId) {
    const required = TAB_REQUIREMENTS[tabId];
    const ui = ROLE_UI[currentRole];
    const hiddenTabs = (ui && ui.hiddenTabs) || [];
    const grantedOnPurpose = !!required && currentRole
        ? isPermissionGranted(currentRole, required)
        : false;

    if (hiddenTabs.includes(tabId) && !grantedOnPurpose) return false;

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
    isPermissionGranted,
    isPermissionLocked,
    isPermissionKnown,
    getPermissionState,
    hasPermission,
    getPermissionCounts,
    getPermissionOverrideRow,
    getPermissionStore,
    loadPermissionOverrides,
    savePermissionOverrides
};