// =====================================================================
// МОДУЛЬ: ДИАГНОСТИКА (журнал ошибок сотрудников — «что падает и у кого»)
// =====================================================================
// ЗАЧЕМ. Журнал ошибок (таблица public.app_errors, пишет js/monitoring.js,
// создаёт database/migrate-v2.9-ops-monitoring.sql) до этой правки читался
// только SQL-запросом из ops/README.md. Администратор — не аналитик: чтобы
// ответить «у кого не сохраняется», он должен был открыть Supabase → SQL
// Editor и выполнить запрос. Раздел показывает те же четыре среза в
// интерфейсе — ровно то, что уже описано в инструкции:
//   1. сколько ошибок и у скольких сотрудников (сводка);
//   2. что повторяется чаще всего (группировка по тексту ошибки);
//   3. последние записи и подробности одной из них (стек, страница, версия,
//      ревизия оболочки, браузер, context);
//   4. у кого именно падает (сколько ошибок у каждого сотрудника).
//
// ОТКУДА ДАННЫЕ И КТО ИХ ВИДИТ. Раздел читает ту же таблицу app_errors, что и
// SQL-запросы: ничего не дублируется и не пишется. Права — те же, что в базе:
// RLS пускает к журналу Администратора и Директора
// (database/migrate-v2.9-ops-monitoring.sql → политика
// rsk_app_errors_select_admin), поэтому право view_diagnostics в
// js/permissions.js выдано этой же паре ролей. Остальным раздел не виден:
// это внутренняя диагностика, а не рабочие данные.
//
// ⚠️ ЧЕГО ЗДЕСЬ НЕТ. В журнале только текст ошибки, стек, адрес страницы,
// версия и ревизия оболочки, браузер и сотрудник. Сумм, файлов и паролей там
// не бывает: модуль js/monitoring.js их не передаёт, а команда базы
// rsk_log_app_errors принимает лишь перечисленные поля.
//
// ⚠️ СЧЁТ ИДЁТ ПО ЗАГРУЖЕННЫМ ЗАПИСЯМ. PostgREST не умеет group by, поэтому
// раздел берёт последние DIAG_LIMIT записей выбранного периода и группирует
// их в браузере. Если записей больше, чем поместилось, это видно подсказкой
// «показаны последние 300 записей — сузьте период»: выдавать выборку за «все
// ошибки компании» нельзя, поэтому числа всегда относятся к загруженным
// строкам.
//
// ⚠️ ЖУРНАЛ ЖИВЁТ 90 ДНЕЙ: записи старше удаляет сама команда записи при
// следующем обращении. Поэтому период «за 90 дней» — это весь журнал целиком.
// =====================================================================

import { db } from '../database.js';
import { t } from '../i18n.js';
import {
    log, toast, escapeHtml, emptyState, formatDateTime, showModal
} from '../utils.js';

// =====================================================================
// НАСТРОЙКИ И СОСТОЯНИЕ
// =====================================================================

// Периоды отчёта в днях. Период длиннее 90 дней смысла не имеет: более
// старых записей в журнале не бывает.
const PERIODS = { day: 1, week: 7, month: 30, all: 90 };

// Сколько записей журнала забираем за один раз (в браузер, не в базу).
// 300 последних записей периода — представительная выборка для разбора;
// если строк пришло ровно столько, раздел об этом предупреждает.
const DIAG_LIMIT = 300;

// Цвет плашки по виду события. Классы записаны целыми строками (а не
// собираются из частей): их должен увидеть сборщик Tailwind (`npm run build`),
// иначе стиля в готовом CSS не будет.
const KIND_BADGES = {
    error: 'bg-red-100 text-red-800',
    rejection: 'bg-amber-100 text-amber-800',
    save: 'bg-yellow-100 text-yellow-800',
    network: 'bg-blue-100 text-blue-800',
    sw: 'bg-gray-200 text-gray-700'
};
const KIND_BADGE_DEFAULT = 'bg-gray-100 text-gray-700';

let rows = [];                  // загруженные записи журнала (свежие сверху)
let groups = [];                // срез «что повторяется» (по тексту ошибки)
let people = [];                // срез «у кого падает» (по сотруднику)
const employeesById = new Map();
let employeesLoaded = false;    // имена тянем из базы один раз за сеанс
let readError = '';             // журнал не читается (нет миграции / нет прав)

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

/**
 * Читает журнал за выбранный период и рисует раздел.
 * Вызывается при открытии раздела (js/main.js → switchTab), кнопкой
 * «🔄 Обновить» и сменой фильтра (data-action в index.html).
 */
export async function loadDiagnostics() {
    const periodEl = document.getElementById('diag-period');
    const kindEl = document.getElementById('diag-kind');

    const period = (periodEl && periodEl.value) || 'week';
    const kind = (kindEl && kindEl.value) || '';
    const days = PERIODS[period] || PERIODS.week;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    log.info(`Диагностика: чтение журнала ошибок (${period}${kind ? ', ' + kind : ''})...`);

    const { data, error } = await db.select('app_errors', {
        select: 'id, created_at, kind, message, stack, page, user_agent, ' +
            'app_version, shell_revision, employee_id, role, context',
        // Фильтры уходят в запрос, а не отсеиваются в браузере: иначе журнал
        // грузился бы целиком при каждом открытии раздела.
        filters: { 'created_at.gte': since, ...(kind ? { kind } : {}) },
        orderBy: { column: 'created_at', asc: false },
        limit: DIAG_LIMIT
    });

    if (error) {
        // Ошибку не глотаем: без объяснения раздел выглядел бы просто пустым,
        // и администратор решил бы, что ошибок у сотрудников нет.
        readError = readErrorMessage(error);
        rows = [];
        groups = [];
        people = [];
        log.error('Диагностика: журнал не прочитан —', error.message || error);
        renderDiagnostics();
        return;
    }

    readError = '';
    rows = data || [];
    if (rows.length) await loadEmployeeNames();

    groups = groupByMessage(rows);
    people = groupByEmployee(rows);

    log.info(`Диагностика: записей ${rows.length}, разных ошибок ${groups.length}, сотрудников ${people.length}`);
    renderDiagnostics();
}

/**
 * Понятное объяснение отказа чтения журнала. Частые случаи:
 *   * миграция не применена — PostgREST отвечает «Could not find the table
 *     'public.app_errors' in the schema cache» (PGRST205), база — 42P01;
 *   * чтение запрещено — «permission denied» (42501).
 * Остальное отдаём db.explainError(): он уже умеет объяснять отказы базы
 * (отсутствующая колонка, устаревшее ограничение, отказ команды).
 */
function readErrorMessage(error) {
    const text = String((error && (error.message || error.error_description)) || error || '');

    if (/app_errors|PGRST205|42P01/i.test(text)) return t('diag.readErrorMigration');
    if (/permission|42501/i.test(text)) return t('diag.readErrorRights');

    return db.explainError(error);
}

/**
 * Имена сотрудников для срезов: в журнале лежит только employee_id, а
 * показывать «Сотрудник №7» администратору бесполезно. Справочник читается
 * один раз за сеанс; не получилось — показываем номер (отчёт всё равно
 * работает: имена здесь удобство, а не суть).
 */
async function loadEmployeeNames() {
    if (employeesLoaded) return;

    const { data, error } = await db.select('employees', { select: 'id, name, position' });

    if (error) {
        log.warn('Диагностика: имена сотрудников не загрузились —', error.message);
        return;
    }

    (data || []).forEach((employee) => employeesById.set(employee.id, employee));
    employeesLoaded = true;
}

// =====================================================================
// СРЕЗЫ (группировка в браузере)
// =====================================================================

/**
 * «Что повторяется чаще всего»: одна строка на пару «вид события + текст
 * ошибки». Здесь же запоминается id самой свежей записи группы — по нему
 * открывается окно подробностей (стек и context этой ошибки).
 */
function groupByMessage(list) {
    const map = new Map();

    for (const row of list) {
        const key = `${row.kind}|${row.message}`;
        let group = map.get(key);

        if (!group) {
            group = {
                kind: row.kind,
                message: row.message,
                times: 0,
                first: row.created_at,
                last: row.created_at,
                latestId: row.id,
                people: new Set()
            };
            map.set(key, group);
        }

        group.times += 1;
        if (row.created_at < group.first) group.first = row.created_at;
        if (row.created_at > group.last) {
            group.last = row.created_at;
            group.latestId = row.id;
        }
        if (row.employee_id !== null && row.employee_id !== undefined) group.people.add(row.employee_id);
    }

    // Сверху — то, с чего начинают разбор: сначала частые, при равенстве — свежие.
    return [...map.values()].sort((a, b) =>
        b.times - a.times || String(b.last).localeCompare(String(a.last)));
}

/** «У кого падает»: сколько ошибок у каждого сотрудника за период. */
function groupByEmployee(list) {
    const map = new Map();

    for (const row of list) {
        const bound = row.employee_id !== null && row.employee_id !== undefined;
        const key = bound ? String(row.employee_id) : `none|${row.role || ''}`;
        let item = map.get(key);

        if (!item) {
            item = { employeeId: bound ? row.employee_id : null, role: row.role || '', errors: 0, last: row.created_at };
            map.set(key, item);
        }

        item.errors += 1;
        if (row.created_at > item.last) item.last = row.created_at;
    }

    return [...map.values()].sort((a, b) => b.errors - a.errors);
}

// =====================================================================
// ПОДПИСИ
// =====================================================================

/** Плашка вида события: 'error', 'rejection', 'save', 'network', 'sw'. */
function kindBadge(kind) {
    const style = KIND_BADGES[kind] || KIND_BADGE_DEFAULT;
    return `<span class="${style} px-1.5 py-0.5 rounded font-bold text-[10px]">${escapeHtml(kind || '—')}</span>`;
}

/**
 * Кто видел ошибку. Сотрудник мог быть удалён, а мог вообще не иметь
 * привязки к аккаунту (в журнал тогда попадает только роль) — оба случая
 * подписаны честно, без «неизвестно».
 */
function employeeLabel(row) {
    const bound = row.employee_id !== null && row.employee_id !== undefined;
    const employee = bound ? employeesById.get(row.employee_id) : null;

    if (employee) {
        return employee.position ? `${employee.name} · ${employee.position}` : employee.name;
    }

    const role = row.role ? ` · ${row.role}` : '';
    if (!bound) return `${t('diag.unknownEmployee')}${role}`;

    return `${t('diag.employeeNumber')}${row.employee_id}${role}`;
}

/** Кто именно видел ошибку в группе: до трёх имён, дальше — «и ещё N». */
function peopleLabel(ids) {
    const names = [...ids]
        .map((id) => (employeesById.get(id) || {}).name || `${t('diag.employeeNumber')}${id}`);

    if (names.length === 0) return t('diag.unknownEmployee');
    if (names.length <= 3) return names.join(', ');

    return `${names.slice(0, 3).join(', ')} ${t('diag.andMore', { count: names.length - 3 })}`;
}

// =====================================================================
// ОТРИСОВКА
// =====================================================================

/**
 * Рисует раздел целиком. Контейнеры — пустые блоки в index.html
 * (#diag-note, #diag-summary, #diag-groups-block, #diag-recent-block,
 * #diag-people-block): разметку собирает модуль, потому что в ней нет
 * ничего статичного — одни данные.
 */
function renderDiagnostics() {
    renderNote();

    const summaryEl = document.getElementById('diag-summary');
    if (summaryEl) summaryEl.innerHTML = readError ? '' : summaryHtml();

    renderBlock('diag-groups-block', t('diag.groupsTitle'), [
        t('diag.colKind'), t('diag.colMessage'), t('diag.colTimes'),
        t('diag.colFirst'), t('diag.colLast'), t('diag.colWho')
    ], groupsHtml(), 6);

    renderBlock('diag-recent-block', t('diag.recentTitle'), [
        t('diag.colWhen'), t('diag.colWho'), t('diag.colKind'),
        t('diag.colMessage'), t('diag.colPage')
    ], recentHtml(), 5);

    renderBlock('diag-people-block', t('diag.peopleTitle'), [
        t('diag.colEmployee'), t('diag.colRole'), t('diag.colErrors'), t('diag.colLast')
    ], peopleHtml(), 4);
}

/**
 * Подсказка над срезами: либо «журнал не читается» с причиной и что с этим
 * делать, либо предупреждение «показаны не все записи периода».
 */
function renderNote() {
    const note = document.getElementById('diag-note');
    if (!note) return;

    let text = '';
    let style = '';

    if (readError) {
        text = t('diag.readError', { reason: readError });
        style = 'rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-semibold text-amber-900';
    } else if (rows.length >= DIAG_LIMIT) {
        text = t('diag.limitHit', { rows: DIAG_LIMIT });
        style = 'rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs font-semibold text-amber-800';
    }

    note.textContent = text;
    note.className = text ? style : 'hidden';
}

/** Сводка: сколько записей, разных ошибок, сотрудников и когда последняя. */
function summaryHtml() {
    const employees = people.filter((item) => item.employeeId !== null).length;
    const parts = [
        `${escapeHtml(t('diag.sumRows'))}: <b>${rows.length}</b>`,
        `${escapeHtml(t('diag.sumGroups'))}: <b>${groups.length}</b>`,
        `${escapeHtml(t('diag.sumPeople'))}: <b>${employees}</b>`
    ];

    if (rows.length) {
        parts.push(`${escapeHtml(t('diag.sumLast'))}: <b>${escapeHtml(formatDateTime(rows[0].created_at))}</b>`);
    }

    return parts
        .map((part) => `<span class="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5 text-xs">${part}</span>`)
        .join('');
}

/**
 * Общий каркас среза: заголовок + таблица. Один код на три таблицы —
 * иначе три копии разметки разошлись бы при первой правке.
 *
 * Готовый текст перевода приходит сюда уже переведённым (вызовы t в
 * renderDiagnostics): так ключ виден в коде, и прогон tools/checks/i18n-check.mjs
 * проверяет оба языка (та же конвенция, что в js/pagination.js).
 *
 * @param {string} containerId — пустой блок из index.html
 * @param {string} title — название среза
 * @param {string[]} headers — названия колонок
 * @param {string} bodyHtml — строки таблицы (или '' → заглушка пустого списка)
 * @param {number} colSpan — на сколько колонок растянуть заглушку
 */
function renderBlock(containerId, title, headers, bodyHtml, colSpan) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const empty = readError ? emptyState(t('diag.readErrorShort'), colSpan)
        : emptyState(t('diag.empty'), colSpan);

    container.innerHTML = `
        <div class="bg-white p-4 rounded-xl shadow-sm space-y-3">
            <h3 class="text-sm font-bold text-gray-700 uppercase tracking-wider">${escapeHtml(title)}</h3>
            <div class="overflow-x-auto">
                <table class="w-full text-xs">
                    <thead>
                        <tr class="bg-gray-50 text-gray-600">
                            ${headers.map((header) => `<th class="p-2.5 text-left font-semibold">${escapeHtml(header)}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody class="divide-y">${bodyHtml || empty}</tbody>
                </table>
            </div>
        </div>`;
}

// ------------------------------------------------------------ «что повторяется»

function groupsHtml() {
    if (readError || groups.length === 0) return '';

    return groups.map((group) => `
        <tr data-action="openDiagnosticEntry" data-arg="${group.latestId}" role="button" tabindex="0"
            class="cursor-pointer hover:bg-emerald-50/60 transition" title="${escapeHtml(t('diag.openDetails'))}">
            <td class="p-2.5 whitespace-nowrap">${kindBadge(group.kind)}</td>
            <td class="p-2.5 text-gray-800" data-i18n-skip>${escapeHtml(group.message)}</td>
            <td class="p-2.5 font-bold text-[#15803d]">${group.times}</td>
            <td class="p-2.5 text-gray-500 whitespace-nowrap">${escapeHtml(formatDateTime(group.first))}</td>
            <td class="p-2.5 text-gray-500 whitespace-nowrap">${escapeHtml(formatDateTime(group.last))}</td>
            <td class="p-2.5 text-gray-600" data-i18n-skip>${escapeHtml(peopleLabel(group.people))}</td>
        </tr>`).join('');
}

// ------------------------------------------------------------- «последние записи»

function recentHtml() {
    if (readError || rows.length === 0) return '';

    return rows.map((row) => `
        <tr data-action="openDiagnosticEntry" data-arg="${row.id}" role="button" tabindex="0"
            class="cursor-pointer hover:bg-emerald-50/60 transition" title="${escapeHtml(t('diag.openDetails'))}">
            <td class="p-2.5 text-gray-500 whitespace-nowrap">${escapeHtml(formatDateTime(row.created_at))}</td>
            <td class="p-2.5 text-gray-700" data-i18n-skip>${escapeHtml(employeeLabel(row))}</td>
            <td class="p-2.5 whitespace-nowrap">${kindBadge(row.kind)}</td>
            <td class="p-2.5 text-gray-800" data-i18n-skip>${escapeHtml(row.message)}</td>
            <td class="p-2.5 text-gray-500" data-i18n-skip>${escapeHtml(row.page || '—')}</td>
        </tr>`).join('');
}

// ------------------------------------------------------------------ «у кого падает»

function peopleHtml() {
    if (readError || people.length === 0) return '';

    return people.map((item) => {
        const employee = item.employeeId !== null ? employeesById.get(item.employeeId) : null;
        const name = employee
            ? employee.name
            : (item.employeeId === null
                ? t('diag.unknownEmployee')
                : `${t('diag.employeeNumber')}${item.employeeId}`);
        const role = (employee && employee.position) || item.role || '—';

        return `
        <tr class="hover:bg-emerald-50/60 transition">
            <td class="p-2.5 text-gray-800 font-semibold" data-i18n-skip>${escapeHtml(name)}</td>
            <td class="p-2.5 text-gray-600" data-i18n-skip>${escapeHtml(role)}</td>
            <td class="p-2.5 font-bold text-[#15803d]">${item.errors}</td>
            <td class="p-2.5 text-gray-500 whitespace-nowrap">${escapeHtml(formatDateTime(item.last))}</td>
        </tr>`;
    }).join('');
}

// =====================================================================
// ПОДРОБНОСТИ ОДНОЙ ЗАПИСИ
// =====================================================================

/**
 * Открывает окно подробностей записи журнала: кто, когда, стек, страница,
 * версия и ревизия оболочки, браузер и context. Вызывается нажатием строки
 * в любом из срезов (data-action="openDiagnosticEntry"): из «что повторяется»
 * приходит id самой свежей записи этой ошибки, из «последних записей» — id
 * самой строки.
 */
export function openDiagnosticEntry(id) {
    const row = rows.find((item) => Number(item.id) === Number(id));

    if (!row) {
        // Список успели перечитать, пока нажатие было в пути.
        toast(t('diag.entryNotFound'), 'warning');
        return;
    }

    const head = document.getElementById('diag-detail-head');
    if (head) head.textContent = `${employeeLabel(row)} · ${formatDateTime(row.created_at)}`;

    const body = document.getElementById('diag-detail-body');
    if (body) body.innerHTML = detailHtml(row);

    showModal('diagnostics-modal');
}

/** Тело окна: пары «подпись → значение» плюс три текстовых блока. */
function detailHtml(row) {
    const fields = [
        [t('diag.fieldEmployee'), employeeLabel(row)],
        [t('diag.fieldRole'), row.role || '—'],
        [t('diag.fieldKind'), row.kind || '—'],
        [t('diag.fieldVersion'), row.app_version || '—'],
        [t('diag.fieldRevision'), row.shell_revision || '—'],
        [t('diag.fieldPage'), row.page || '—'],
        [t('diag.fieldBrowser'), row.user_agent || '—']
    ];

    return `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            ${fields.map(([label, value]) => `
                <div class="bg-gray-50 border rounded-lg p-2">
                    <p class="text-[10px] uppercase tracking-wider text-gray-500">${escapeHtml(label)}</p>
                    <p class="text-xs text-gray-800 break-words" data-i18n-skip>${escapeHtml(value)}</p>
                </div>`).join('')}
        </div>
        ${textBlock(t('diag.fieldMessage'), row.message)}
        ${textBlock(t('diag.fieldStack'), row.stack)}
        ${textBlock(t('diag.fieldContext'), contextText(row.context))}`;
}

/**
 * Блок «подпись + текст». Стек и context показываются КАК ЕСТЬ (переносы и
 * отступы сохраняет <pre>): это технические данные для разработчика, и
 * переписывать их нельзя. data-i18n-skip — чтобы фразовый переводчик не
 * трогал текст ошибки на украинском интерфейсе.
 */
function textBlock(label, value) {
    return `
        <div class="border-t pt-3">
            <p class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">${escapeHtml(label)}</p>
            <pre class="whitespace-pre-wrap break-words bg-gray-50 border rounded-lg p-2 text-[11px] text-gray-800 max-h-64 overflow-auto" data-i18n-skip>${escapeHtml(value || '—')}</pre>
        </div>`;
}

/** context — колонка jsonb: показываем читаемый JSON, а не «[object Object]». */
function contextText(context) {
    if (!context || typeof context !== 'object') return context ? String(context) : '';
    if (Object.keys(context).length === 0) return '';

    try {
        return JSON.stringify(context, null, 2);
    } catch {
        return '';
    }
}

// =====================================================================
// ТОЧКИ ВХОДА ИЗ РАЗМЕТКИ (data-action, см. js/actions.js)
// =====================================================================
// loadDiagnostics вызывают три места: открытие раздела (js/main.js),
// кнопка «🔄 Обновить» и оба фильтра (data-on="change").

window.loadDiagnostics = loadDiagnostics;
window.openDiagnosticEntry = openDiagnosticEntry;
