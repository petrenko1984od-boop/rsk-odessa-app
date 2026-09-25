// =====================================================================
// МОДУЛЬ: РЕЕСТР МАТЕРИАЛОВ
// =====================================================================
// Сводная таблица всех закупок и расходов.
//
// Источники данных — вид базы public.registry_rows
// (database/migrate-v2.9-registry-view.sql). Вид собирает те же строки, что
// раньше собирал этот модуль в браузере:
//   1. Позиции заявок с payment_source = 'company' (delivered + closed + archived)
//   2. Расходы из cash_operations (source = 'manual')
//   3. Заявки с payment_source = 'employee' (деньги лежат в cash_operations)
//
// ЧТО ИЗМЕНИЛОСЬ В v2.9.0. Раньше здесь грузились ВСЕ заявки, ВСЕ их позиции
// и ВСЕ расходы кассы, а фильтры, «Записей: N» и «Итого» считались по этому
// массиву в браузере. Теперь:
//   * список — db.selectPage('registry_rows', …): база отдаёт ровно 25 строк
//     (страница) и общее количество, а не десятки тысяч строк;
//   * фильтры (объект, раздел, категория, оплата, сотрудник, период) уходят
//     в запрос и работают ДО выгрузки;
//   * «Записей» и «Итого» считает команда public.registry_totals(…): по всему
//     отфильтрованному набору, а не по видимой странице — иначе сумма была бы
//     меньше настоящей, а за такие цифры отвечает бухгалтер;
//   * выгрузка в Excel — db.selectAllPaged(…): страницами, с потолком и
//     предупреждением, если строк больше потолка.
//
// ⚠️ ЛОГИКА СТРОК ЖИВЁТ В ВИДЕ БАЗЫ. Правила ниже описаны и там — менять их
//    надо вместе, иначе реестр и план-факт начнут считать по-разному:
//   - Архивные заявки ТОЖЕ попадают в реестр (архив ≠ удаление)
//   - Материалы попадают в реестр сразу после «Доставлено на объект», даже
//     если счёт ещё не оплачен: тогда оплата = 'debt' («Ожидает оплаты»),
//     а отметку «Оплачено» ставит финансист (js/modules/invoices.js).
//   - Избегаем двойного учёта:
//       * заявка фирмой → из order_items
//       * заявка сотрудником → из cash_operations
//       * прямой расход → из cash_operations
//   - Дата: для заявок — delivered_at (closed_at у старых), для расходов — operation_date
//   - Доставка по заявке — отдельная позиция заявки (CONFIG.DELIVERY_ITEM, её
//     вписывает снабженец в окне счёта): показывается категорией «🚚 Доставка»,
//     поэтому фильтр «Категория → 🚚 Доставка» видит реальные суммы доставки.
//     Если доставку везла компания («Доставка компании»), сумма в счёт
//     поставщика не входила — в колонке «Оплата» у такой строки стоит
//     «🏢 Вне счёта», а не «Ожидает оплаты»: долга перед поставщиком нет.
//   - Своя доставка (v2.5.0): если она оплачена из подотчёта, деньги лежат в
//     cash_operations (source = 'own_delivery'), поэтому строка заявки в реестр
//     НЕ попадает — вместо неё показывается расход с пометкой «🚚 Своя
//     доставка». Иначе одна сумма стояла бы в таблице дважды.
//   - НДС: у строки показывается «в т.ч. ПДВ» (vat_amount). Сумма при этом
//     ВСЕГДА с налогом — колонка «Сумма» остаётся деньгами к оплате, поэтому
//     итоги реестра не меняются.
// =====================================================================

import { db } from '../database.js';
import { renderToolbar } from '../pagination.js';
import {
    log, toast, escapeHtml, formatMoney,
    formatDate, roundMoney
} from '../utils.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let registryCache = [];   // строки ТЕКУЩЕЙ СТРАНИЦЫ (v2.9.0)
// Текст предупреждения над таблицей: ошибка загрузки (например, в базе нет
// вида — не применена миграция) или усечённая выгрузка в Excel.
let registryWarning = '';
let filters = {
    projectId: '',
    sectionId: '',
    category: '',
    payment: '',
    employeeId: '',
    dateFrom: '',
    dateTo: ''
};

// --- страницы и итоги (v2.9.0) ---------------------------------------
let registryPage = 1;                      // текущая страница, с 1
let registryPageSize = db.PAGE_SIZE;       // строк на странице (слой ограничивает 100)
let registryTotal = null;                  // сколько строк всего (null — база не сообщила)
// Итог по ВСЕМУ отфильтрованному набору от команды базы. null — команда не
// ответила: показываем прочерк, а не сумму одной страницы.
let registryTotals = { count: null, sum: null };

// Справочники для фильтров (объекты, разделы, сотрудники). Загружаются при
// открытии раздела: фильтровать по названию нельзя — «Дом на Ленина» может
// быть у двух объектов, поэтому в условия запроса уходит id.
let registryFilterOptions = { projects: [], sections: [], employees: [] };

/** Сколько строк максимум выгружаем в Excel (см. db.selectAllPaged). */
const REGISTRY_EXPORT_LIMIT = 5000;

// Колонки вида. Перечислены явно: реестр читается страницами, и «*» отдавал бы
// лишние поля на каждую строку.
const REGISTRY_COLUMNS = `
    kind, source_number, order_id, row_key, entry_at, entry_date,
    name, unit, qty, unit_price, total_sum, vat_amount,
    category, payment, supplier,
    project_id, project_name, section_id, section_name,
    employee_id, employee_name
`;

// Человекочитаемые названия категорий (таблица реестра + экспорт в Excel)
const CATEGORY_LABELS = {
    'materials': '📦 Материалы',
    'works': '🛠 Работы',
    'delivery': '🚚 Доставка',
    'other': '📋 Прочее'
};

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

/**
 * Условия запроса к виду: только заполненные фильтры. Пустое поле фильтра —
 * это отсутствующее условие, а не «пустая строка»: иначе база не нашла бы
 * ничего.
 */
function registryRowFilters() {
    const conditions = {};

    if (filters.projectId) conditions.project_id = Number(filters.projectId);
    if (filters.sectionId) conditions.section_id = Number(filters.sectionId);
    if (filters.category) conditions.category = filters.category;
    if (filters.payment) conditions.payment = filters.payment;
    if (filters.employeeId) conditions.employee_id = Number(filters.employeeId);
    if (filters.dateFrom) conditions['entry_date.gte'] = filters.dateFrom;
    if (filters.dateTo) conditions['entry_date.lte'] = filters.dateTo;

    return conditions;
}

/** Те же условия для команды итогов (у неё параметры, а не условия запроса). */
function registryTotalsParams() {
    return {
        p_project_id: filters.projectId ? Number(filters.projectId) : null,
        p_section_id: filters.sectionId ? Number(filters.sectionId) : null,
        p_category: filters.category || null,
        p_payment: filters.payment || null,
        p_employee_id: filters.employeeId ? Number(filters.employeeId) : null,
        p_date_from: filters.dateFrom || null,
        p_date_to: filters.dateTo || null
    };
}

/**
 * Понятное объяснение отказа чтения реестра. Частые случаи:
 *   * вид не создан — PostgREST отвечает «Could not find the table
 *     'public.registry_rows' in the schema cache» (PGRST205), а база — 42P01:
 *     значит не применена database/migrate-v2.9-registry-view.sql;
 *   * команды итогов нет — PGRST202 («function not found»);
 *   * остальное (например, нет колонок v2.4.0) объяснит db.explainError():
 *     он называет файл нужной миграции.
 */
function explainRegistryError(error) {
    const text = String(error?.message || error || '');

    if (/registry_rows|PGRST205|42P01/i.test(text)) {
        return 'база не знает вид public.registry_rows. Выполните '
            + 'database/migrate-v2.9-registry-view.sql в Supabase → SQL Editor '
            + '(он создаёт вид реестра и команду итогов) и обновите страницу.';
    }

    if (/registry_totals|PGRST202/i.test(text)) {
        return 'база не знает команду public.registry_totals — итог по реестру '
            + 'посчитать нечем. Выполните database/migrate-v2.9-registry-view.sql '
            + 'в Supabase → SQL Editor.';
    }

    return db.explainError(error);
}

/**
 * Строка вида → строка таблицы. Имена колонок базы (snake_case) остаются в
 * базе, а показ и выгрузка работают с привычными полями — так разметку
 * таблицы и экспорт в Excel не пришлось переписывать.
 */
function mapRegistryRow(row) {
    return {
        _source: row.kind,
        _orderNumber: row.source_number || '—',
        _orderId: row.order_id,
        rowKey: row.row_key,
        date: row.entry_at,
        name: row.name || '—',
        unit: row.unit || 'шт',
        qty: Number(row.qty) || 0,
        unitPrice: Number(row.unit_price) || 0,
        sum: Number(row.total_sum) || 0,
        vat: Number(row.vat_amount) || 0,
        category: row.category || '',
        supplier: row.supplier || '—',
        project: row.project_name || '—',
        projectId: row.project_id,
        section: row.section_name || '—',
        sectionId: row.section_id,
        employee: row.employee_name || '—',
        // 'company' — доставка компании: суммы в счёте поставщика не было,
        // поэтому её нельзя показывать как долг фирмы.
        payment: row.payment || 'paid'
    };
}

export async function loadRegistry() {
    log.info('Загрузка реестра материалов...');

    // Справочники для фильтров читаются тем же заходом: сотрудник открывает
    // раздел и сразу видит и список, и чем фильтровать.
    const [pageResult, totalsResult] = await Promise.all([
        db.selectPage('registry_rows', {
            select: REGISTRY_COLUMNS,
            filters: registryRowFilters(),
            // Дата — первым, ключ строки — вторым: строки реестра делят одну
            // дату (позиции одной заявки, расходы одного дня), и без второго
            // поля страница могла показать строку дважды, а другую пропустить.
            orderBy: [
                { column: 'entry_at', asc: false },
                { column: 'row_key', asc: false }
            ],
            page: registryPage,
            pageSize: registryPageSize
        }),
        db.rpc('registry_totals', registryTotalsParams()),
        loadRegistryFilterOptions()
    ]);

    if (pageResult.error) {
        // Без объяснения реестр просто оказался бы пустым — сотрудник решил бы,
        // что данные пропали. db.explainError() превращает техническую ошибку
        // в инструкцию, что делать (например, назвать файл миграции).
        registryWarning = '⚠ Реестр не загрузился: ' + explainRegistryError(pageResult.error);
        log.error('Ошибка загрузки реестра:', pageResult.error.message);
        registryCache = [];
        registryTotal = null;
        registryTotals = { count: null, sum: null };
        renderRegistryFilters();
        renderRegistry();
        return;
    }

    registryWarning = '';
    registryCache = (pageResult.data || []).map(mapRegistryRow);
    registryTotal = pageResult.count;

    // Последнюю строку страницы могли оплатить или убрать в архив, а фильтр
    // остался: показываем предыдущую страницу, а не пустой экран.
    if (registryCache.length === 0 && registryPage > 1) {
        registryPage -= 1;
        return loadRegistry();
    }

    // Команда вернёт либо массив строк (PostgREST отдаёт таблицу как массив),
    // либо один объект — берём первую строку в обоих случаях.
    const totals = Array.isArray(totalsResult.data) ? totalsResult.data[0] : totalsResult.data;

    if (totalsResult.error || !totals) {
        // Цифра «Итого» — та, по которой сверяются с бухгалтерией. Молча
        // подставить сумму одной страницы нельзя: покажем прочерк и скажем.
        log.error('Ошибка подсчёта итога реестра:',
            totalsResult.error?.message || 'база не вернула результат');
        registryTotals = { count: null, sum: null };
        registryWarning = '⚠ Итог по реестру не посчитался: '
            + (totalsResult.error ? explainRegistryError(totalsResult.error) : 'база не вернула результат.');
    } else {
        registryTotals = {
            count: Number(totals.rows_count) || 0,
            sum: Number(totals.total_sum) || 0
        };
    }

    log.info(`Загружено строк реестра: ${registryCache.length} из ${registryTotal ?? 'неизвестно'}`);

    renderRegistryFilters();
    renderRegistry();
}

/**
 * Справочники для фильтров. Это небольшие таблицы (объекты, разделы,
 * сотрудники), поэтому их можно прочитать целиком — в отличие от самого
 * реестра, который читается страницей.
 */
async function loadRegistryFilterOptions() {
    const [projects, sections, employees] = await Promise.all([
        db.select('projects', { select: 'id, name', orderBy: { column: 'name', asc: true } }),
        db.select('sections', { select: 'id, project_id, name', orderBy: { column: 'name', asc: true } }),
        db.select('employees', { select: 'id, name', orderBy: { column: 'name', asc: true } })
    ]);

    registryFilterOptions = {
        projects: projects.data || [],
        sections: sections.data || [],
        employees: employees.data || []
    };

    // Справочники — не причина не показать реестр: если они не пришли, фильтры
    // останутся пустыми, а список и итоги будут работать.
    [projects, sections, employees].forEach((result, index) => {
        if (result.error) {
            log.warn('Не удалось загрузить справочник для фильтров реестра:',
                ['объекты', 'разделы', 'сотрудники'][index], result.error.message);
        }
    });

    return registryFilterOptions;
}

// =====================================================================
// ФИЛЬТРЫ
// =====================================================================

/**
 * Заполняет списки фильтров. Объекты и сотрудники — из справочников, а разделы
 * только выбранного объекта: у крупного объекта их сотни, и список «разделы
 * всех объектов» был бы бесполезен.
 */
function renderRegistryFilters() {
    const projectsSel = document.getElementById('reg-filter-project');
    if (projectsSel) {
        projectsSel.innerHTML = '<option value="">Все объекты</option>' + registryFilterOptions.projects
            .map(project => `<option value="${project.id}">${escapeHtml(project.name || '—')}</option>`)
            .join('');
        projectsSel.value = registryFilterOptions.projects
            .some(project => String(project.id) === filters.projectId) ? filters.projectId : '';
    }

    const sectionOptions = registryFilterOptions.sections.filter(section =>
        !filters.projectId || String(section.project_id) === filters.projectId);

    const sectionsSel = document.getElementById('reg-filter-section');
    if (sectionsSel) {
        sectionsSel.innerHTML = '<option value="">Все разделы</option>' + sectionOptions
            .map(section => `<option value="${section.id}">${escapeHtml(section.name || '—')}</option>`)
            .join('');
        sectionsSel.value = sectionOptions
            .some(section => String(section.id) === filters.sectionId) ? filters.sectionId : '';
    }

    const employeesSel = document.getElementById('reg-filter-employee');
    if (employeesSel) {
        employeesSel.innerHTML = '<option value="">Все сотрудники</option>' + registryFilterOptions.employees
            .map(employee => `<option value="${employee.id}">${escapeHtml(employee.name || '—')}</option>`)
            .join('');
        employeesSel.value = registryFilterOptions.employees
            .some(employee => String(employee.id) === filters.employeeId) ? filters.employeeId : '';
    }
}

export function applyRegistryFilters() {
    filters.projectId = document.getElementById('reg-filter-project')?.value || '';
    filters.sectionId = document.getElementById('reg-filter-section')?.value || '';
    filters.category = document.getElementById('reg-filter-category')?.value || '';
    filters.payment = document.getElementById('reg-filter-payment')?.value || '';
    filters.employeeId = document.getElementById('reg-filter-employee')?.value || '';
    filters.dateFrom = document.getElementById('reg-filter-date-from')?.value || '';
    filters.dateTo = document.getElementById('reg-filter-date-to')?.value || '';

    // Смена объекта меняет список разделов: раздел другого объекта надо снять,
    // иначе фильтр искал бы строки, которых в выбранном объекте нет.
    if (filters.sectionId && filters.projectId) {
        const section = registryFilterOptions.sections
            .find(item => String(item.id) === filters.sectionId);
        if (section && String(section.project_id) !== filters.projectId) filters.sectionId = '';
    }

    // Другой фильтр — другой набор строк: возвращаемся на первую страницу,
    // иначе с пятой страницы старого фильтра сотрудник попадёт в пустоту.
    // Промис загрузки возвращаем наружу: так прогоны (tools/checks) могут
    // дождаться ответа базы, а не читать таблицу «на глазок» через паузу.
    registryPage = 1;
    return loadRegistry();
}

export function resetRegistryFilters() {
    filters = {
        projectId: '',
        sectionId: '',
        category: '',
        payment: '',
        employeeId: '',
        dateFrom: '',
        dateTo: ''
    };

    ['reg-filter-project', 'reg-filter-section', 'reg-filter-category', 'reg-filter-payment',
        'reg-filter-employee', 'reg-filter-date-from', 'reg-filter-date-to'].forEach(id => {
        const field = document.getElementById(id);
        if (field) field.value = '';
    });

    registryPage = 1;
    return loadRegistry();
}

// =====================================================================
// ОТОБРАЖЕНИЕ
// =====================================================================

export function renderRegistry() {
    const tbody = document.getElementById('registry-tbody');
    if (!tbody) return;

    // Предупреждение о неполных данных (например, база без вида реестра —
    // не применена миграция) или о том, что выгрузка обрезана потолком.
    const warningEl = document.getElementById('registry-warning');
    if (warningEl) {
        warningEl.textContent = registryWarning;
        warningEl.classList.toggle('hidden', !registryWarning);
    }

    // «Записей» и «Итого» пришли командой базы по ВСЕМУ набору: на экране
    // только страница, и считать по ней нельзя. Нет ответа — прочерк, а не
    // чужая сумма.
    const countEl = document.getElementById('registry-count');
    const sumEl = document.getElementById('registry-total-sum');
    if (countEl) countEl.textContent = registryTotals.count === null ? '—' : registryTotals.count;
    if (sumEl) sumEl.textContent = registryTotals.sum === null ? '—' : formatMoney(registryTotals.sum);

    renderRegistryToolbar();

    if (registryCache.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="12" class="text-center text-gray-400 py-6 text-sm">
                    Нет данных в реестре
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = registryCache.map(item => renderRegistryRow(item)).join('');
}

/**
 * Панель списка: «Показано 1-25 из 137», размер страницы и «‹ Назад / Вперёд ›».
 * Разметку и события даёт общий модуль js/pagination.js. Поиска у реестра нет:
 * колонок двенадцать, а фильтров семь — строка поиска искала бы только по
 * названию, и сотрудник ждал бы от неё другого.
 */
function renderRegistryToolbar() {
    renderToolbar('registry-toolbar', {
        id: 'registry',
        showSearch: false,
        page: registryPage,
        pageSize: registryPageSize,
        count: registryTotal,
        rowsOnPage: registryCache.length,

        onPage: (page) => {
            registryPage = page;
            loadRegistry();
        },
        onPageSize: (size) => {
            registryPageSize = Math.min(Number(size) || db.PAGE_SIZE, db.MAX_PAGE_SIZE);
            registryPage = 1;
            loadRegistry();
        }
    });
}

function renderRegistryRow(item) {
    const dateStr = formatDate(item.date);

    let sourceBadge = '';
    if (item._source === 'order') {
        sourceBadge = `<span class="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold" title="Заявка (оплата фирмой)">📦 Заявка</span>`;
    } else if (item._source === 'order_employee') {
        sourceBadge = `<span class="text-[10px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold" title="Заявка (оплата сотрудником)">📦 Заявка</span>`;
    } else if (item._source === 'own_delivery') {
        // Своя доставка: расход подотчёта, созданный при сохранении счёта.
        // Отдельная пометка нужна, чтобы в реестре было видно: это не счёт
        // поставщика, а внутренний расход (водитель, транспортный отдел).
        sourceBadge = `<span class="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold" title="Своя доставка: расход подотчёта">🚚 Своя доставка</span>`;
    } else {
        sourceBadge = `<span class="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold" title="Прямой расход">💰 Расход</span>`;
    }

    const categoryLabel = CATEGORY_LABELS[item.category] || item.category || '—';

    // 'company' — доставка компании: суммы в счёте поставщика не было, поэтому
    // врать «Ожидает оплаты» нельзя — иначе долг перед поставщиком казался бы
    // больше, чем он есть.
    const paymentBadge = item.payment === 'debt'
        ? `<span class="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold text-[10px]">Ожидает оплаты</span>`
        : item.payment === 'company'
            ? `<span class="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-bold text-[10px]" title="Доставка компании: в счёт поставщика не входит">🏢 Вне счёта</span>`
            : `<span class="bg-green-100 text-green-800 px-1.5 py-0.5 rounded font-bold text-[10px]">Оплачено</span>`;

    return `
        <tr class="hover:bg-emerald-50/60 transition border-b">
            <td class="p-2.5 whitespace-nowrap text-xs">${dateStr}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${sourceBadge}<div class="text-[10px] text-gray-500 mt-0.5">${escapeHtml(item._orderNumber)}</div></td>
            <td class="p-2.5 text-xs font-semibold text-gray-900">${escapeHtml(item.name)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${item.qty} ${escapeHtml(item.unit)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${formatMoney(item.unitPrice)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs font-bold text-[#15803d]">${formatMoney(item.sum)}</td>
            <td class="p-2.5 whitespace-nowrap text-xs text-gray-600" title="НДС внутри суммы (справочно: деньги в колонке «Сумма» уже с налогом)">${item.vat > 0 ? formatMoney(item.vat) : '—'}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${categoryLabel}</td>
            <td class="p-2.5 whitespace-nowrap text-xs">${paymentBadge}</td>
            <td class="p-2.5 text-xs text-gray-700">${escapeHtml(item.supplier)}</td>
            <td class="p-2.5 text-xs text-gray-700">
                <div class="font-medium">${escapeHtml(item.project)}</div>
                <div class="text-[10px] text-gray-500">${escapeHtml(item.section)}</div>
            </td>
            <td class="p-2.5 text-xs text-gray-700">${escapeHtml(item.employee)}</td>
        </tr>
    `;
}

// =====================================================================
// ЭКСПОРТ В EXCEL
// =====================================================================

export async function exportRegistryToExcel() {
    // Выгрузка берёт ВСЕ строки под фильтром, а не видимую страницу: «скачать
    // по фильтру» значит «выгрузить ровно то, что видно», иначе в файле
    // оказалась бы четверть реестра. Читаем страницами с потолком — если строк
    // больше потолка, честно скажем об этом, а не выгрузим половину молча.
    const { data: fetchedRows, error, fetched, truncated } = await db.selectAllPaged('registry_rows', {
        select: REGISTRY_COLUMNS,
        filters: registryRowFilters(),
        orderBy: [
            { column: 'entry_at', asc: false },
            { column: 'row_key', asc: false }
        ],
        maxRows: REGISTRY_EXPORT_LIMIT
    });

    if (error) {
        toast('Не удалось выгрузить реестр: ' + db.explainError(error), 'error');
        return;
    }

    const data = (fetchedRows || []).map(mapRegistryRow);

    if (data.length === 0) {
        toast('Нет данных для выгрузки', 'warning');
        return;
    }

    if (truncated) {
        // Молчаливое усечение в деньгах — это неверный итог, за который
        // отвечает бухгалтер: говорим и в файле (предупреждение на экране), и
        // всплывающим сообщением.
        registryWarning = `⚠ В Excel попали не все строки: показаны первые ${fetched}. `
            + 'Сузьте период или другой фильтр и повторите выгрузку.';
        renderRegistry();
        toast(`Показаны первые ${fetched} строк — строк больше, уточните фильтр`, 'warning');
    }

    if (typeof XLSX === 'undefined') {
        toast('Библиотека XLSX не загружена', 'error');
        return;
    }

    // Дату пишем настоящей датой Excel (формат встроенный, поэтому Excel
    // покажет её по локали: в русской — 14.08.2026). Тогда автофильтр и
    // сортировка по дате работают правильно, а не как по тексту.
    // Если значение не в ISO-формате — оставляем исходный текст.
    const excelDate = value => {
        const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
        if (!parts) return formatDate(value);

        const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
        return isNaN(date.getTime()) ? formatDate(value) : date;
    };

    // Числа округляем до копеек; значение, которое не удалось распарсить,
    // оставляем как есть — roundMoney() молча превратил бы его в 0
    const money = value => {
        if (value === null || value === undefined) return value;
        if (typeof value === 'string' && value.trim() === '') return value;
        const num = Number(value);
        return Number.isFinite(num) ? Math.round((num + Number.EPSILON) * 100) / 100 : value;
    };

    const rows = data.map(item => ({
        'Дата': excelDate(item.date),
        'Источник': item._orderNumber,
        'Наименование': item.name,
        'Кол-во': item.qty,
        'Ед. изм.': item.unit,
        'Цена за ед.': money(item.unitPrice),
        'Сумма': money(item.sum),
        'в т.ч. ПДВ': item.vat > 0 ? money(item.vat) : 0,
        'Без ПДВ': item.vat > 0 ? money(roundMoney(Number(item.sum) - Number(item.vat))) : money(item.sum),
        'Категория': CATEGORY_LABELS[item.category] || item.category || '—',
        'Оплата': item.payment === 'debt' ? 'Ожидает оплаты'
            : item.payment === 'company' ? 'Вне счёта поставщика' : 'Оплачено',
        'Поставщик': item.supplier,
        'Объект': item.project,
        'Раздел': item.section,
        'Сотрудник': item.employee
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);

    // Колонки берём в том порядке, в каком они перечислены в rows выше
    const columns = Object.keys(rows[0]);

    // ── ЧИТАЕМОСТЬ ФАЙЛА ─────────────────────────────────────────────
    // Excel открывает .xlsx со своей шириной колонок (~8 символов), поэтому
    // длинный текст в ячейках не видно. Считаем ширину каждой колонки по
    // самому длинному значению (длину заголовка тоже учитываем).
    // Длину значения считаем по тому, как оно будет показано в Excel:
    // дата — как ДД.ММ.ГГГГ, а не как «Fri Aug 14 2026 00:00:00 GMT+0300»
    const textLength = value => {
        if (value instanceof Date) return formatDate(value).length;
        if (value === null || value === undefined) return 0;
        return String(value).length;
    };

    worksheet['!cols'] = columns.map(header => {
        const maxLen = rows.reduce((max, row) => {
            const len = textLength(row[header]);
            return len > max ? len : max;
        }, header.length);

        // +2 — внутренние отступы Excel. Потолок 250 символов — предел ширины
        // колонки в Excel (255), чтобы даже очень длинное наименование было видно
        return { wch: Math.max(10, Math.min(maxLen + 2, 250)) };
    });

    // Автофильтр по шапке — сортировка и фильтр доступны сразу в Excel
    worksheet['!autofilter'] = {
        ref: XLSX.utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: rows.length, c: columns.length - 1 }
        })
    };

    // Числовые колонки пишем числами (а не текстом), деньги — с форматом
    // «два знака после запятой»: суммы читаются и считаются формулами.
    // «Кол-во» оставляем без формата — 40 и 150,5 показываются как есть.
    const numericFormats = {
        'Кол-во': '',
        'Цена за ед.': '#,##0.00',
        'Сумма': '#,##0.00'
    };

    Object.entries(numericFormats).forEach(([header, numberFormat]) => {
        const col = columns.indexOf(header);
        if (col === -1) return;

        rows.forEach((row, rowIndex) => {
            const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: col })];
            if (!cell) return;

            const num = Number(cell.v);
            if (cell.v === null || cell.v === undefined
                || String(cell.v).trim() === '' || isNaN(num)) return;

            cell.t = 'n';
            cell.v = num;
            if (numberFormat) cell.z = numberFormat;
            delete cell.w;
        });
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Реестр материалов');

    const fileName = `Reestr_Materialov_${new Date().toISOString().split('T')[0]}.xlsx`;
    XLSX.writeFile(workbook, fileName);

    toast(`Экспортировано ${data.length} строк`, 'success');
}

// =====================================================================
// БЕЙДЖ
// =====================================================================

export function updateRegistryBadge() {
    // Пока не используем
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.applyRegistryFilters = applyRegistryFilters;
window.resetRegistryFilters = resetRegistryFilters;
window.exportRegistryToExcel = exportRegistryToExcel;


