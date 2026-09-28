// =====================================================================
// МОДУЛЬ: УПРАВЛЕНИЕ ДОСТУПАМИ (раздел «🔐 Доступы» для Администратора)
// =====================================================================
// ЗАЧЕМ. Матрица прав жила одним файлом кода (js/permissions.js →
// ROLE_PERMISSIONS), и чтобы убрать у роли раздел или кнопку, нужно было
// править код, пересобирать фронтенд и выпускать версию. Этот экран даёт
// администратору то же самое в приложении: таблица «право × роль» с галочками,
// сохранение — в таблицу public.role_permissions
// (database/migrate-v2.12-role-permissions.sql).
//
// ЧТО ЗДЕСЬ МОЖНО, А ЧТО НЕЛЬЗЯ.
//   * Снять право у роли (галочка выключается) — можно: раздел, кнопка и само
//     действие исчезают у этой роли сразу после сохранения. Данные при этом
//     остаются закрытыми: UI — это удобство, а не защита.
//   * Вернуть снятое право к заводскому — можно (кнопка «↩» у роли или
//     включённая галочка): строка в базе остаётся ради истории.
//   * ВЫДАТЬ право, которого у роли нет в коде, — НЕЛЬЗЯ. Настоящая защита —
//     политики RLS в Postgres, а они перечисляют роли по именам: выданное
//     право база всё равно отклонила бы при записи («new row violates
//     row-level security policy»), и админ увидел бы кнопку, которая не
//     работает. Такие клетки на экране пустые («—»), а новые права ролям
//     добавляются правкой ROLE_PERMISSIONS вместе с политиками.
//
// ⚠️ ГДЕ ЧТО ЛЕЖИТ. Заводские права — js/permissions.js; каталог групп и прав
//    для этого экрана — там же (PERMISSION_CATALOG); снятые галочки — таблица
//    public.role_permissions; служебные права (замок 🔒) отзывать нельзя
//    (LOCKED_PERMISSIONS) — иначе администратор закрыл бы себе вход сюда.
//
// ⚠️ ЧЬИ ПРАВА МЕНЯЮТСЯ. Только интерфейс приложения: экран не трогает ни
//    RLS, ни данные. Роль «Снабженец» и «Финансист» вдобавок работают на
//    урезанном рабочем месте (ROLE_UI в js/permissions.js) — часть разделов
//    им не показывается и без отзыва прав; это решение остаётся за кодом.
// =====================================================================

import { can, getRoles, getPermissionCatalog, getRevocationStore, getRevocationRow,
    isPermissionDefault, isPermissionRevoked, isPermissionLocked,
    loadPermissionRevocations, savePermissionRevocations } from '../permissions.js';
import { t, getLang } from '../i18n.js';
import {
    log, toast, escapeHtml, emptyState, formatDateTime
} from '../utils.js';

// =====================================================================
// ПОДПИСИ ГРУПП И ПРАВ (RU / UK)
// =====================================================================
// Строки лежат здесь, а не в словаре языков (js/i18n.js), по той же причине,
// что подписи документа сметы (js/modules/estimate-doc.js → DOC_TEXT): ключ
// собирается из данных ('access.right.' + right), а прогон i18n-check такие
// обращения не видит — пропавший перевод остался бы сырым ключом в интерфейсе.
// Что подписи есть на ОБОИХ языках и что они покрывают весь каталог прав,
// проверяет прогон tools/checks/access-check.mjs.
const LABELS = {
    ru: {
        groups: {
            employees: '👥 Сотрудники',
            projects: '🏗 Объекты',
            tasks: '📋 Задачи и личный экран',
            orders: '📦 Заявки на материалы',
            money: '💰 Деньги и заявки на подотчёт',
            site: '📅 График, файлы и смета',
            tabs: '🧭 Разделы приложения',
            system: '🔐 Служебные'
        },
        rights: {
            view_employees: 'Видеть список сотрудников',
            view_tab_employees: 'Раздел «👥 Сотрудники»',
            add_employee: 'Добавлять сотрудников',
            edit_employee: 'Править карточку сотрудника',
            block_employee: 'Блокировать сотрудника',
            restore_employee: 'Восстанавливать сотрудника',
            delete_employee: 'Удалять сотрудника навсегда',
            link_account: 'Привязывать аккаунт входа',
            unlink_account: 'Отвязывать аккаунт входа',
            view_projects_all: 'Видеть все объекты',
            view_projects_own: 'Объекты, где сотрудник прорабом',
            add_project: 'Добавлять объекты',
            edit_project: 'Править объекты',
            delete_project: 'Удалять объекты',
            create_task: 'Создавать задачи',
            assign_task_to_employee: 'Ставить задачу из карточки сотрудника',
            become_task_assignee: 'Можно назначать исполнителем задачи',
            view_all_tasks: 'Видеть задачи всех сотрудников',
            cancel_any_task: 'Отменять любую задачу',
            create_order: 'Создавать заявку на материалы',
            process_order: 'Вести заявку: принять, закрыть, в архив',
            cash_expense_self: 'Расход со своего подотчёта',
            cash_return_self: 'Возврат остатка в кассу',
            cash_issue: 'Выдавать деньги и пополнять подотчёт',
            cash_view_all: 'Видеть подотчёты всех сотрудников',
            process_cash_request: 'Согласовывать заявки: одобрить или отклонить',
            issue_cash_request: 'Выдавать деньги по одобренной заявке',
            pay_material_invoice: 'Отмечать счёт поставщика оплаченным',
            edit_gantt: 'Вести график работ объекта',
            manage_files: 'Документация объекта: загрузка и удаление',
            manage_estimate: 'Файл сметы (цены «наряд» и «кошторис»)',
            close_section: 'Закрывать раздел на своём объекте',
            view_registry: 'Раздел «📊 Реестр»',
            view_orders_tab: 'Раздел «📦 Снабжение»',
            view_diagnostics: 'Раздел «🩺 Диагностика»',
            view_dashboard: 'Личный экран сотрудника вместо списка задач',
            manage_access: 'Раздел «🔐 Доступы» (управление правами)'
        }
    },
    uk: {
        groups: {
            employees: '👥 Співробітники',
            projects: '🏗 Об’єкти',
            tasks: '📋 Завдання та особистий екран',
            orders: '📦 Заявки на матеріали',
            money: '💰 Гроші та заявки на підзвіт',
            site: '📅 Графік, файли та кошторис',
            tabs: '🧭 Розділи застосунку',
            system: '🔐 Службові'
        },
        rights: {
            view_employees: 'Бачити список співробітників',
            view_tab_employees: 'Розділ «👥 Співробітники»',
            add_employee: 'Додавати співробітників',
            edit_employee: 'Правити картку співробітника',
            block_employee: 'Блокувати співробітника',
            restore_employee: 'Відновлювати співробітника',
            delete_employee: 'Видаляти співробітника назавжди',
            link_account: 'Прив’язувати акаунт входу',
            unlink_account: 'Відв’язувати акаунт входу',
            view_projects_all: 'Бачити всі об’єкти',
            view_projects_own: 'Об’єкти, де співробітник виконробом',
            add_project: 'Додавати об’єкти',
            edit_project: 'Правити об’єкти',
            delete_project: 'Видаляти об’єкти',
            create_task: 'Створювати завдання',
            assign_task_to_employee: 'Ставити завдання з картки співробітника',
            become_task_assignee: 'Можна призначати виконавцем завдання',
            view_all_tasks: 'Бачити завдання всіх співробітників',
            cancel_any_task: 'Скасовувати будь-яке завдання',
            create_order: 'Створювати заявку на матеріали',
            process_order: 'Вести заявку: прийняти, закрити, в архів',
            cash_expense_self: 'Витрата з власного підзвіту',
            cash_return_self: 'Повернення залишку до каси',
            cash_issue: 'Видавати гроші та поповнювати підзвіт',
            cash_view_all: 'Бачити підзвіти всіх співробітників',
            process_cash_request: 'Погоджувати заявки: схвалити або відхилити',
            issue_cash_request: 'Видавати гроші за схваленою заявкою',
            pay_material_invoice: 'Позначати рахунок постачальника сплаченим',
            edit_gantt: 'Вести графік робіт об’єкта',
            manage_files: 'Документація об’єкта: завантаження та видалення',
            manage_estimate: 'Файл кошторису (ціни «наряд» і «кошторис»)',
            close_section: 'Закривати розділ на своєму об’єкті',
            view_registry: 'Розділ «📊 Реєстр»',
            view_orders_tab: 'Розділ «📦 Постачання»',
            view_diagnostics: 'Розділ «🩺 Діагностика»',
            view_dashboard: 'Особистий екран співробітника замість списку завдань',
            manage_access: 'Розділ «🔐 Доступи» (керування правами)'
        }
    }
};

/** Подписи выбранного языка: группа или право → текст. */
function labels() {
    return LABELS[getLang()] || LABELS.ru;
}

/** Подпись группы (employees → «👥 Сотрудники»). */
function groupLabel(id) {
    return labels().groups[id] || id;
}

/** Подпись права: ищем по имени, а незнакомое показываем как есть. */
function rightLabel(right) {
    return labels().rights[right] || right;
}

// =====================================================================
// СОСТОЯНИЕ ЭКРАНА
// =====================================================================

// Черновик решений администратора: роль → Map<право, снято?>. Пустой черновик
// значит «как в базе». Галочки живут здесь до нажатия «💾 Сохранить»: иначе
// каждое движение мыши писало бы в базу, а отменить пачку правок было бы нельзя.
const draft = new Map();

/** Что стоит в клетке: черновик, а если правки нет — состояние из базы. */
function cellRevoked(role, right) {
    const forRole = draft.get(role);
    if (forRole && forRole.has(right)) return forRole.get(right);
    return isPermissionRevoked(role, right);
}

/** Запомнить решение администратора в черновике. */
function setDraft(role, right, revoked) {
    if (!draft.has(role)) draft.set(role, new Map());
    draft.get(role).set(right, revoked);
}

/** Правки, которые ещё не в базе: [{ role, permission, revoked }]. */
function pendingChanges() {
    const out = [];

    draft.forEach((rights, role) => {
        rights.forEach((revoked, right) => {
            if (isPermissionRevoked(role, right) !== revoked) {
                out.push({ role, permission: right, revoked });
            }
        });
    });

    return out;
}

// =====================================================================
// ЗАГРУЗКА И ОТРИСОВКА
// =====================================================================

/**
 * Открывает раздел: перечитывает отзывы из базы и рисует матрицу.
 * Вызывается при открытии вкладки (js/main.js → switchTab), кнопкой
 * «🔄 Обновить» и после сохранения.
 */
export async function loadAccess() {
    const matrix = document.getElementById('access-matrix');
    if (!matrix) return;

    // Экран — администраторский: право manage_access выдано только ему и не
    // отзывается (LOCKED_PERMISSIONS). Проверка нужна для случая, когда вкладку
    // открыли из консоли или право когда-то выдадут в коде другой роли.
    if (!can('manage_access')) {
        matrix.innerHTML = emptyState(t('access.adminOnly'), 1);
        return;
    }

    draft.clear();
    matrix.innerHTML = `<div class="app-loading text-sm"><span class="app-spinner" aria-hidden="true"></span><span>${escapeHtml(t('access.loading'))}</span></div>`;

    const result = await loadPermissionRevocations();

    log.info(`Доступы: матрица прав (${result.ok ? 'отзывы прочитаны' : 'отзывы не прочитаны: ' + result.reason})`);

    renderAccess();
}

/** Полная перерисовка раздела: предупреждения, сводка, правки и матрица. */
function renderAccess() {
    const roles = getRoles();
    const groups = getPermissionCatalog();

    renderWarnings();
    renderSummary(roles);
    renderChanges();
    renderMatrix(roles, groups);
    updateButtons();
}

/** Плашки-предупреждения: нет миграции, ошибка чтения, неизвестные строки. */
function renderWarnings() {
    const box = document.getElementById('access-warning');
    if (!box) return;

    const store = getRevocationStore();
    const blocks = [];

    // Таблицы нет — значит не применена миграция v2.12.0. Экран об этом
    // говорит прямо и называет файл (тот же приём, что у неприменённых
    // колонок в js/database.js → explainError).
    if (store.reason === 'no_table') {
        blocks.push(`<p>${escapeHtml(t('access.migrationNeeded'))}</p>`);
    } else if (store.reason === 'error') {
        blocks.push(`<p>${escapeHtml(t('access.readError'))}</p>`
            + `<p class="text-[11px] text-gray-500 break-words">${escapeHtml(store.message)}</p>`);
    }

    if (store.unknown.length > 0) {
        blocks.push(`<p>${escapeHtml(t('access.unknownRights'))}</p>`
            + `<p class="text-[11px] text-gray-500 font-mono">${escapeHtml(store.unknown.join(', '))}</p>`);
    }

    box.innerHTML = blocks.map((html) =>
        `<div class="bg-amber-50 border border-amber-200 text-amber-800 p-3 rounded-xl shadow-sm text-xs space-y-1">${html}</div>`
    ).join('');
    box.classList.toggle('hidden', blocks.length === 0);
}

/** Сводка по ролям: сколько прав работает сейчас и сколько было в коде. */
function renderSummary(roles) {
    const box = document.getElementById('access-summary');
    if (!box) return;

    box.innerHTML = `
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            ${roles.map((role) => {
                const all = getAllRoleCount(role);
                return `
                    <div class="bg-white border rounded-xl p-3 shadow-sm text-xs">
                        <span class="font-bold text-gray-800">${escapeHtml(role)}</span>
                        <span class="block text-gray-500 mt-0.5">${escapeHtml(t('access.roleSummary', { count: all.current, total: all.total }))}</span>
                        ${all.revoked > 0 ? `<span class="block text-red-600 font-semibold mt-0.5">${escapeHtml(t('access.roleRevoked', { count: all.revoked }))}</span>` : ''}
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

/** Сколько прав у роли: всего в коде, работает сейчас и снято (с учётом черновика). */
function getAllRoleCount(role) {
    const total = (getPermissionCatalog().flatMap((group) => group.rights))
        .filter((right) => isPermissionDefault(role, right)).length;
    const revoked = getPermissionCatalog().flatMap((group) => group.rights)
        .filter((right) => isPermissionDefault(role, right) && cellRevoked(role, right)).length;

    return { total, current: total - revoked, revoked };
}

/** Плашка «что ещё не сохранено»: список правок черновика. */
function renderChanges() {
    const box = document.getElementById('access-changes');
    if (!box) return;

    const changes = pendingChanges();

    if (changes.length === 0) {
        box.innerHTML = `<p class="text-xs text-gray-500">${escapeHtml(t('access.noChanges'))}</p>`;
        return;
    }

    box.innerHTML = `
        <p class="text-xs font-semibold text-amber-800">${escapeHtml(t('access.changes', { count: changes.length }))}</p>
        <ul class="text-[11px] text-gray-600 space-y-0.5 mt-1">
            ${changes.map((change) => `<li>${escapeHtml(change.role)} — ${escapeHtml(rightLabel(change.permission))}: `
                + `${escapeHtml(change.revoked ? t('access.markRevoked') : t('access.markRestored'))}</li>`).join('')}
        </ul>
    `;
}

/**
 * Матрица «право × роль»: по таблице на группу прав.
 *
 * Колонки — роли из справочника должностей (js/permissions.js → getRoles),
 * строки — права из каталога, а в шапке каждой колонки стоит кнопка «↩»:
 * вернуть ЭТОЙ роли все снятые права к заводским одним нажатием.
 */
function renderMatrix(roles, groups) {
    const box = document.getElementById('access-matrix');
    if (!box) return;

    box.innerHTML = groups.map((group) => `
        <div class="bg-white p-4 rounded-xl shadow-sm space-y-3">
            <div class="flex justify-between items-center flex-wrap gap-2">
                <h3 class="font-bold text-gray-800 text-sm">${escapeHtml(groupLabel(group.id))}</h3>
                <span class="text-[11px] text-gray-400">${escapeHtml(t('access.rightsCount', { count: group.rights.length }))}</span>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-xs min-w-[52rem]">
                    <thead>
                        <tr class="text-gray-500">
                            <th class="text-left p-2 font-semibold">${escapeHtml(t('access.rightColumn'))}</th>
                            ${roles.map((role) => `
                                <th class="p-2 font-semibold whitespace-nowrap">
                                    ${escapeHtml(role)}
                                    <button data-action="resetRoleAccess" data-arg="${escapeHtml(role)}"
                                            title="${escapeHtml(t('access.resetRoleHint'))}"
                                            class="ml-1 text-gray-400 hover:text-[#15803d] transition">↩</button>
                                </th>
                            `).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${group.rights.map((right) => `
                            <tr class="border-t align-middle">
                                <td class="p-2">
                                    <span class="font-semibold text-gray-800">${escapeHtml(rightLabel(right))}</span>
                                    <span class="block text-[10px] text-gray-400 font-mono">${escapeHtml(right)}</span>
                                </td>
                                ${roles.map((role) => cellHtml(role, right)).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `).join('');
}

/** Одна клетка матрицы: галочка, замок или «—» (права у роли нет в коде). */
function cellHtml(role, right) {
    // Служебное право (вход на этот самый экран): отзывать нельзя — иначе
    // администратор закрыл бы себе управление доступами.
    if (isPermissionLocked(right)) {
        return `<td class="p-2 text-center text-gray-400" title="${escapeHtml(t('access.lockedHint'))}">🔒</td>`;
    }

    // Права у роли нет в коде: UI его не выдаёт. Выдача — правка матрицы
    // вместе с политиками базы, иначе база отклонит запись. Пустая клетка
    // честнее галочки, которая не работает.
    if (!isPermissionDefault(role, right)) {
        return `<td class="p-2 text-center text-gray-300" title="${escapeHtml(t('access.notGranted'))}">—</td>`;
    }

    const revoked = cellRevoked(role, right);
    const saved = getRevocationRow(role, right);
    const changed = saved ? saved.revoked !== revoked : revoked;

    const marks = [];
    if (revoked) marks.push(`<span class="block text-[10px] font-semibold text-red-600">${escapeHtml(t('access.markRevoked'))}</span>`);
    if (changed) marks.push(`<span class="block text-[10px] font-semibold text-amber-600">${escapeHtml(t('access.markChanged'))}</span>`);
    if (saved && saved.changed_at && !changed) {
        marks.push(`<span class="block text-[10px] text-gray-400">${escapeHtml(formatDateTime(saved.changed_at))}</span>`);
    }

    return `<td class="p-2 text-center">
        <input type="checkbox" ${revoked ? '' : 'checked'}
               data-action="toggleAccessRight" data-on="change" data-pass-event
               data-arg="${escapeHtml(role)}|${right}"
               aria-label="${escapeHtml(role + ': ' + rightLabel(right))}"
               class="w-4 h-4 accent-[#15803d] align-middle cursor-pointer">
        ${marks.join('')}
    </td>`;
}

/** Кнопки «Сохранить» и «Отменить»: активны, пока есть что сохранять. */
function updateButtons() {
    const saveBtn = document.getElementById('access-save-btn');
    const revertBtn = document.getElementById('access-revert-btn');
    const store = getRevocationStore();
    const changes = pendingChanges().length;

    // Нет таблицы в базе — сохранять некуда: кнопка гаснет, а плашка сверху
    // называет файл миграции (иначе админ нажимал бы «Сохранить» в пустоту).
    const enabled = store.read && changes > 0;

    [saveBtn, revertBtn].forEach((btn) => {
        if (!btn) return;
        btn.disabled = !enabled;
        btn.classList.toggle('opacity-50', !enabled);
        btn.classList.toggle('cursor-not-allowed', !enabled);
    });

    if (saveBtn) {
        saveBtn.textContent = changes > 0 ? t('access.saveCount', { count: changes }) : t('access.save');
    }
}

// =====================================================================
// ДЕЙСТВИЯ ЭКРАНА (кнопки разметки зовут их через data-action)
// =====================================================================

/**
 * Галочка в клетке: снять право у роли или вернуть его.
 * Решение идёт в черновик — в базу пишет только «💾 Сохранить», поэтому
 * случайное нажатие отменяется кнопкой «↩ Отменить».
 */
export function toggleAccessRight(event) {
    const input = event && event.target;
    if (!input || !input.dataset || !input.dataset.arg) return;

    const [role, right] = input.dataset.arg.split('|');
    setDraft(role, right, !input.checked);

    renderAccess();
}

/** «↩» у роли: вернуть к заводским все снятые у неё права (в черновике). */
export function resetRoleAccess(role) {
    let touched = 0;

    getPermissionCatalog().forEach((group) => group.rights.forEach((right) => {
        if (isPermissionLocked(right) || !cellRevoked(role, right)) return;
        setDraft(role, right, false);
        touched += 1;
    }));

    if (touched === 0) {
        toast(t('access.nothingToReset', { role }), 'info');
        return;
    }

    renderAccess();
}

/** «↩ Отменить»: выбросить черновик и вернуться к тому, что лежит в базе. */
export function revertAccessDraft() {
    if (pendingChanges().length === 0) {
        toast(t('access.noChanges'), 'info');
        return;
    }

    draft.clear();
    renderAccess();
    toast(t('access.reverted'), 'info');
}

/** «💾 Сохранить»: записать решения администратора в public.role_permissions. */
export async function saveAccessMatrix() {
    const changes = pendingChanges();

    if (changes.length === 0) {
        toast(t('access.noChanges'), 'info');
        return;
    }

    const result = await savePermissionRevocations(changes);

    if (result.ok) {
        toast(t('access.saved', { count: result.saved }), 'success');
    } else {
        log.warn('Доступы: часть правок не сохранилась', result.failed);
        toast(`${t('access.saveFailed')}: ${result.failed[0] ? result.failed[0].message : ''}`, 'error');
    }

    draft.clear();

    // Перечитываем из базы: у сохранённых строк появились время и сотрудник
    // (их ставит триггер), а часть правок база могла не принять.
    await loadPermissionRevocations();

    // Меню и кнопки — сразу по новым правам, не дожидаясь перезагрузки
    // страницы (window.applyPermissionsToUI выставляет js/main.js).
    if (typeof window.applyPermissionsToUI === 'function') window.applyPermissionsToUI();

    renderAccess();
}

window.loadAccess = loadAccess;
window.toggleAccessRight = toggleAccessRight;
window.resetRoleAccess = resetRoleAccess;
window.revertAccessDraft = revertAccessDraft;
window.saveAccessMatrix = saveAccessMatrix;

