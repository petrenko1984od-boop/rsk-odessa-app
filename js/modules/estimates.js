// =====================================================================
// МОДУЛЬ: СМЕТЫ (конструктор для ПТО)
// =====================================================================
// Раздел «📐 Сметы»: список смет и редактор. Право — manage_estimate
// (Администратор, Главный инженер, Инженер ПТО): смета — рабочий документ ПТО
// и коммерческая тайна, в ней цены «наряд» и «кошторис», то есть прибыль.
// Раздел виден только этим трём ролям, и то же правило повторено в RLS базы
// (database/migrate-v2.10-estimates.sql → rsk_is_estimate_editor()).
//
// КАК УСТРОЕН РЕДАКТОР. Смета держится в памяти целиком (разделы → позиции →
// материалы позиции + лимиты) и правится без запросов к базе; в базу уходит
// только «💾 Сохранить» одной командой save_estimate(). Поэтому:
//   * поля правятся на месте (data-action="setEstimateField" + data-field),
//     перерисовки всей сметы на каждую букву нет — фокус не теряется;
//   * после правки пересчитываются только итоги и суммы строк;
//   * сохранение неделимо: обрыв сети не оставит смету без разделов.
//
// СВЯЗЬ С ОБЪЕКТОМ. Поля «Объект стройки (для плана и план-факта)» в редакторе
// больше нет: смету к объекту вручную не привязывают. У смет, которые к объекту
// уже привязаны (project_id пришёл из базы), кнопка «📤 В план объекта» работает
// как прежде: план уходит в разделы объекта, и план-факт, график и заявки на
// материалы обходятся без выгрузки Excel (как после загрузки файла сметы,
// js/modules/estimate.js). Дальше связь будет обратной — объект (план-факт)
// выбирает смету из списка смет этого раздела.
// =====================================================================

import { db, RPC_ESTIMATES } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    formatMoney, formatNumber, formatDate, normalizeSectionName, isExtraSectionName
} from '../utils.js';
import { CONFIG } from '../config.js';
import { requirePermission } from '../permissions.js';
import {
    calcEstimate, calcSection, calcItem, calcItemMaterial,
    exportEstimateExcel, exportEstimatePdf
} from './estimate-doc.js';
import {
    loadEstimateCatalog, getEstimateCatalog, getEstimateUnits, getEstimateCompany,
    getWorkMaterialsFor, findEstimateWork, findEstimateMaterial,
    getEstimateWorkSectionTree, getSectionNameHints,
    onEstimateCatalogChange, openEstimateCompanyModal
} from './estimate-catalog.js';

const STATUS_LABELS = CONFIG.ESTIMATE?.STATUS_LABELS || {};

// Документы сметы: сотрудник выбирает вид документа, вид кошториса (6/9 граф),
// колір шапки и формат файла (окно «📥 Експорт документа»). Списки живут в
// CONFIG — здесь только чтение, чтобы окно и документы не разошлись.
const DOC_KINDS = CONFIG.ESTIMATE?.DOC_KINDS || [];
const DOC_VIEWS = CONFIG.ESTIMATE?.DOC_VIEWS || [];
const DOC_COLORS = CONFIG.ESTIMATE?.DOC_COLORS || [];
const DOC_FORMATS = CONFIG.ESTIMATE?.DOC_FORMATS || [];
const DEFAULT_DOC = CONFIG.ESTIMATE?.DEFAULT_DOC
    || { kind: 'koshtorys', view: '9', color: 'none', format: 'pdf' };

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

const state = {
    loaded: false,
    view: 'list',          // list | editor
    list: [],
    // Объекты (projects) нужны списку смет: у смет, привязанных к объекту раньше,
    // в карточке видно его название. Поля «Объект стройки» в редакторе больше нет
    // (см. шапку файла) — здесь только чтение названия.
    projects: [],
    filters: { search: '', status: '' },
    editor: null,          // смета, которую правят сейчас
    totals: null,
    exportEstimateId: null,// смета, для которой открыто окно документов
    doc: { ...DEFAULT_DOC },// выбранный документ: вид, графка, колір шапки, формат
    keySeq: 0,             // счётчик локальных ключей строк (_key)
    picker: null           // { kind: 'work'|'material', sectionKey, itemKey }
};

/** Уникальный ключ строки внутри редактора (в базе строки пересоздаются). */
function nextKey(prefix) {
    state.keySeq += 1;
    return `${prefix}-${state.keySeq}`;
}

const el = (id) => document.getElementById(id);

/**
 * Понятное объяснение отказа чтения смет. Самый частый случай: миграцию
 * database/migrate-v2.10-estimates.sql ещё не выполнили в Supabase, и PostgREST
 * отвечает «Could not find the table 'public.estimates' in the schema cache»
 * (PGRST205) или база — 42P01. Без этого сотрудник видел бы английскую строку
 * и не знал, что делать. Остальное объясняет db.explainError().
 */
function explainEstimateError(error) {
    const text = String(error?.message || error || '');

    if (/estimates|estimate_sections|estimate_items|estimate_item_materials|estimate_limits|estimate_works|estimate_materials|PGRST205|42P01/i.test(text)) {
        return 'база не знает таблицы раздела «Сметы». Выполните '
            + 'database/migrate-v2.10-estimates.sql в Supabase → SQL Editor '
            + '(он создаёт справочники и сметы и закрывает их RLS) и обновите страницу.';
    }

    if (/save_estimate|delete_estimate|set_estimate_status|PGRST202/i.test(text)) {
        return 'база не знает команды смет — сохранение недоступно. Выполните '
            + 'database/migrate-v2.10-estimates.sql в Supabase → SQL Editor.';
    }

    return db.explainError(error);
}

// =====================================================================
// СПИСОК СМЕТ
// =====================================================================

export async function loadEstimates() {
    // Объекты читаем вместе со сметами: в карточке списка видно название объекта
    // у смет, привязанных к нему раньше (поля «Объект стройки» в редакторе нет).
    const [estimates, projects] = await Promise.all([
        db.select('estimates', { orderBy: { column: 'created_at', asc: false } }),
        db.select('projects', { orderBy: { column: 'name', asc: true } })
    ]);

    if (estimates.error) {
        log.error('Ошибка загрузки смет:', estimates.error.message);
        toast('Не удалось загрузить сметы: ' + explainEstimateError(estimates.error), 'error');
        setListMessage('Список смет недоступен: ' + explainEstimateError(estimates.error));
        return;
    }

    state.list = estimates.data || [];
    state.projects = projects.data || [];
    state.loaded = true;

    log.info(`Загружено смет: ${state.list.length}`);
    renderEstimatesList();
}

function setListMessage(text) {
    const container = el('estimates-list');
    if (!container) return;

    container.innerHTML = `
        <div class="bg-white rounded-xl shadow-sm border border-dashed p-6 text-center text-sm text-gray-600">
            ${escapeHtml(text)}
        </div>
    `;
}

export function setEstimatesSearch(value) {
    state.filters.search = String(value || '').trim().toLowerCase();
    renderEstimatesList();
}

export function setEstimatesStatus(value) {
    state.filters.status = String(value || '');
    renderEstimatesList();
}

/** Отбор списка: поиск по номеру/названию/объекту и статус. */
function filteredEstimates() {
    const { search, status } = state.filters;

    return state.list.filter(estimate => {
        if (status && estimate.status !== status) return false;
        if (!search) return true;

        const haystack = [estimate.number, estimate.title, estimate.object_name]
            .filter(Boolean).join(' ').toLowerCase();

        return haystack.includes(search);
    });
}

function statusBadge(status) {
    const label = STATUS_LABELS[status] || status;
    const tone = status === 'approved'
        ? 'bg-emerald-100 text-emerald-800'
        : (status === 'archived' ? 'bg-gray-200 text-gray-600' : 'bg-amber-100 text-amber-800');

    return `<span class="text-[10px] px-2 py-0.5 rounded-full font-semibold ${tone}">${escapeHtml(label)}</span>`;
}

export function renderEstimatesList() {
    const container = el('estimates-list');
    if (!container) return;

    state.view = 'list';
    toggleEstimateViews();

    if (!state.loaded) {
        container.innerHTML = '<p class="text-xs text-gray-500">Загрузка...</p>';
        return;
    }

    const estimates = filteredEstimates();

    if (estimates.length === 0) {
        container.innerHTML = `
            <div class="bg-white rounded-xl shadow-sm border-2 border-dashed border-gray-300 p-8 text-center space-y-2">
                <div class="text-5xl">📐</div>
                <h3 class="font-bold text-gray-700">Смет пока нет</h3>
                <p class="text-sm text-gray-500">
                    Нажми «➕ Новая смета». Сначала удобно заполнить «📚 Справочники» — работы и материалы
                    подставляются в смету оттуда.
                </p>
            </div>
        `;
        return;
    }

    container.innerHTML = estimates.map(renderEstimateCard).join('');
}

function projectName(id) {
    const project = state.projects.find(item => Number(item.id) === Number(id));
    return project ? project.name : '';
}

function clientName(id) {
    const client = (getEstimateCatalog().clients || []).find(item => Number(item.id) === Number(id));
    return client ? client.name : '';
}

function renderEstimateCard(estimate) {
    const client = clientName(estimate.client_id);
    const project = projectName(estimate.project_id);

    return `
        <div class="bg-white rounded-xl shadow-sm border-l-4 border-[#15803d] p-4 space-y-3">
            <div class="flex justify-between items-start gap-3 flex-wrap">
                <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-xs font-bold text-gray-500">№ ${escapeHtml(estimate.number)}</span>
                        ${statusBadge(estimate.status)}
                        ${estimate.project_id
                            ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 font-semibold">🏗 объект привязан</span>'
                            : ''}
                    </div>
                    <h3 data-action="openEstimateEditor" data-arg="${estimate.id}" role="button" tabindex="0"
                        class="font-bold text-[#166534] hover:underline cursor-pointer text-base break-words">
                        ${escapeHtml(estimate.title)}
                    </h3>
                    <p class="text-xs text-gray-600">
                        ${estimate.object_name ? '🏗 ' + escapeHtml(estimate.object_name) : ''}
                        ${client ? ' · 👤 ' + escapeHtml(client) : ''}
                        ${project ? ' · 📌 ' + escapeHtml(project) : ''}
                    </p>
                    <p class="text-[10px] text-gray-400">
                        Создана: ${formatDate(estimate.created_at)} · позиций: ${estimate.items_count || 0}
                    </p>
                </div>
                <div class="text-right">
                    <div class="text-[10px] text-gray-500 uppercase tracking-wider">К оплате</div>
                    <div class="text-lg font-bold text-[#166534]">${formatMoney(estimate.total_client)}</div>
                    <div class="text-[10px] text-gray-500">
                        материалы: ${formatMoney(estimate.total_materials)} · наряд: ${formatMoney(estimate.total_naryad)}
                    </div>
                </div>
            </div>

            <div class="flex flex-wrap gap-2 pt-2 border-t">
                <button data-action="openEstimateEditor" data-arg="${estimate.id}"
                        class="bg-[#15803d] hover:bg-[#166534] text-white px-3 py-1.5 rounded-lg text-xs font-semibold shadow transition">
                    ✏ Открыть
                </button>
                <button data-action="openEstimateExportModal" data-arg="${estimate.id}"
                        class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg text-xs font-semibold transition">
                    📥 Документы
                </button>
                <button data-action="toggleEstimateStatus" data-arg="${estimate.id}"
                        class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg text-xs font-semibold transition">
                    ${estimate.status === 'approved' ? '📝 В черновик' : '✅ Утвердить'}
                </button>
                <button data-action="deleteEstimate" data-arg="${estimate.id}"
                        class="bg-red-50 hover:bg-red-100 text-red-700 px-3 py-1.5 rounded-lg text-xs font-semibold transition">
                    🗑 Удалить
                </button>
            </div>
        </div>
    `;
}

/** Переключение «список ⇄ редактор». */
function toggleEstimateViews() {
    const list = el('estimates-list-view');
    const editor = el('estimate-editor-view');

    if (list) list.classList.toggle('hidden', state.view !== 'list');
    if (editor) editor.classList.toggle('hidden', state.view !== 'editor');
}

// =====================================================================
// РЕДАКТОР: ОТКРЫТИЕ
// =====================================================================

function createEmptyEditor() {
    return {
        id: null,
        number: '',
        title: '',
        object_name: '',
        project_id: '',
        client_id: '',
        status: 'draft',
        notes: '',
        vat_percent: 0,
        vat_base: 'both',
        sections: [],
        limits: []
    };
}

export async function openNewEstimate() {
    if (!requirePermission('manage_estimate')) return;

    await loadEstimateCatalog();

    state.editor = createEmptyEditor();
    state.view = 'editor';
    renderEstimateEditor();

    // Пустая смета сразу с одним разделом: без разделов позиции некуда класть.
    if (state.editor.sections.length === 0) addEstimateSection();
}

/**
 * Открывает смету: три плоских запроса (разделы, позиции, материалы) и лимиты.
 * Плоские вместо вложенных — так запрос не зависит от тонкостей встраивания
 * PostgREST, а собирается то же дерево.
 */
export async function openEstimateEditor(id) {
    if (!requirePermission('manage_estimate')) return;

    await loadEstimateCatalog();

    const editor = await fetchEstimateTree(id);
    if (!editor) return;

    state.editor = editor;
    state.view = 'editor';
    renderEstimateEditor();
}

/**
 * Читает смету целиком в структуру редактора. Возвращает null и показывает
 * сообщение, если сметы нет (например, её удалили в другой вкладке).
 */
export async function fetchEstimateTree(id) {
    const estimateResponse = await db.select('estimates', { filters: { id: Number(id) }, single: true });
    if (estimateResponse.error || !estimateResponse.data) {
        toast('Смета не найдена', 'error');
        return null;
    }

    const estimate = estimateResponse.data;

    const [sections, limits] = await Promise.all([
        db.select('estimate_sections', {
            filters: { estimate_id: Number(id) },
            orderBy: { column: 'order_index', asc: true }
        }),
        db.select('estimate_limits', {
            filters: { estimate_id: Number(id) },
            orderBy: { column: 'order_index', asc: true }
        })
    ]);

    const sectionRows = sections.data || [];
    const sectionIds = sectionRows.map(section => section.id);

    const items = sectionIds.length > 0
        ? await db.select('estimate_items', {
            filters: { 'section_id.in': sectionIds },
            orderBy: { column: 'order_index', asc: true }
        })
        : { data: [] };

    const itemRows = items.data || [];
    const itemIds = itemRows.map(item => item.id);

    const materials = itemIds.length > 0
        ? await db.select('estimate_item_materials', {
            filters: { 'item_id.in': itemIds },
            orderBy: { column: 'order_index', asc: true }
        })
        : { data: [] };

    const materialsByItem = new Map();
    (materials.data || []).forEach(material => {
        const list = materialsByItem.get(Number(material.item_id)) || [];
        list.push({
            _key: nextKey('m'),
            id: material.id,
            material_id: material.material_id,
            name: material.name,
            unit: material.unit,
            quantity: Number(material.quantity) || 0,
            price_purchase: Number(material.price_purchase) || 0,
            price_client: Number(material.price_client) || 0,
            consumption: material.consumption === null ? null : Number(material.consumption),
            is_customer_supplied: Boolean(material.is_customer_supplied)
        });
        materialsByItem.set(Number(material.item_id), list);
    });

    const itemsBySection = new Map();
    itemRows.forEach(item => {
        const list = itemsBySection.get(Number(item.section_id)) || [];
        list.push({
            _key: nextKey('i'),
            id: item.id,
            work_id: item.work_id,
            name: item.name,
            unit: item.unit,
            quantity: Number(item.quantity) || 0,
            price_worker: Number(item.price_worker) || 0,
            price_client: Number(item.price_client) || 0,
            materials: materialsByItem.get(Number(item.id)) || []
        });
        itemsBySection.set(Number(item.section_id), list);
    });

    return {
        id: estimate.id,
        number: estimate.number,
        title: estimate.title,
        object_name: estimate.object_name || '',
        project_id: estimate.project_id || '',
        client_id: estimate.client_id || '',
        status: estimate.status || 'draft',
        notes: estimate.notes || '',
        vat_percent: Number(estimate.vat_percent) || 0,
        vat_base: estimate.vat_base || 'both',
        sections: sectionRows.map(section => ({
            _key: nextKey('s'),
            id: section.id,
            name: section.name,
            items: itemsBySection.get(Number(section.id)) || []
        })),
        limits: (limits.data || []).map(limit => ({
            name: limit.name,
            percent: Number(limit.percent) || 0,
            base: limit.base || 'both'
        }))
    };
}

export function closeEstimateEditor() {
    state.editor = null;
    state.view = 'list';
    renderEstimatesList();
}

// =====================================================================
// РЕДАКТОР: ОТРИСОВКА
// =====================================================================

function setValue(id, value) {
    const node = el(id);
    if (node) node.value = value === null || value === undefined ? '' : value;
}

function unitsOptions(selected) {
    return getEstimateUnits()
        .map(unit => `<option value="${escapeHtml(unit)}"${unit === selected ? ' selected' : ''}>${escapeHtml(unit)}</option>`)
        .join('');
}

function fillClientSelect(selected) {
    const select = el('estimate-client');
    if (!select) return;

    select.innerHTML = '<option value="">— Не выбран —</option>' + (getEstimateCatalog().clients || [])
        .map(client => `<option value="${client.id}">${escapeHtml(client.name)}</option>`)
        .join('');

    select.value = selected ? String(selected) : '';
}

export function renderEstimateEditor() {
    if (!state.editor) return;

    state.view = 'editor';
    toggleEstimateViews();

    const editor = state.editor;

    const numberNode = el('estimate-number');
    if (numberNode) {
        numberNode.textContent = editor.id
            ? `№ ${editor.number}`
            : 'Новая смета — номер присвоит база при первом сохранении';
    }

    setValue('estimate-title', editor.title);
    setValue('estimate-object', editor.object_name);
    setValue('estimate-notes', editor.notes);
    setValue('estimate-vat-percent', editor.vat_percent);
    setValue('estimate-vat-base', editor.vat_base);
    setValue('estimate-status', editor.status);

    fillClientSelect(editor.client_id);

    // «В план объекта» нужен и объект, и сохранённая смета: до первого
    // сохранения переносить нечего — в базе ещё нет разделов сметы. Объект
    // (project_id) приходит только из базы: поля в редакторе больше нет, и у
    // новой сметы связи не будет — кнопку не показываем.
    const applyButton = el('estimate-apply-project-btn');
    if (applyButton) {
        const canApply = Boolean(editor.id && editor.project_id);
        applyButton.classList.toggle('hidden', !canApply);
    }

    const docsButton = el('estimate-docs-btn');
    if (docsButton) docsButton.classList.toggle('hidden', !editor.id);

    renderEstimateSections();
    renderEstimateLimits();
    renderEstimateTotals();
}

/** Пустое состояние раздела и списка позиций. */
function itemsEmptyState(sectionKey) {
    return `
        <p class="text-[11px] text-gray-500 p-3 bg-white rounded-lg border border-dashed">
            Позиций нет. Возьми работу из справочника («➕ Работа из справочника») — материалы
            подставятся по нормам расхода, если они заданы.
        </p>
        <div class="flex gap-2">
            <button data-action="openEstimateWorkPicker" data-arg="${sectionKey}"
                    class="bg-[#15803d] hover:bg-[#166534] text-white px-2.5 py-1 rounded-lg text-[11px] font-semibold transition">
                ➕ Работа из справочника
            </button>
            <button data-action="addEstimateBlankItem" data-arg="${sectionKey}"
                    class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition">
                ➕ Своя строка
            </button>
        </div>
    `;
}

export function renderEstimateSections() {
    const container = el('estimate-sections-container');
    if (!container || !state.editor) return;

    if (state.editor.sections.length === 0) {
        container.innerHTML = `
            <div class="bg-white rounded-xl border-2 border-dashed border-gray-300 p-6 text-center space-y-2">
                <p class="text-sm text-gray-600">В смете нет разделов — позиции некуда добавлять.</p>
                <button data-action="addEstimateSection"
                        class="bg-[#15803d] hover:bg-[#166534] text-white px-3 py-1.5 rounded-lg text-xs font-semibold shadow transition">
                    ➕ Добавить раздел
                </button>
            </div>
        `;
        return;
    }

    container.innerHTML = state.editor.sections
        .map((section, index) => renderEstimateSectionCard(section, index))
        .join('');
}

function renderEstimateSectionCard(section, index) {
    const items = section.items || [];

    return `
        <div class="bg-white rounded-xl shadow-sm border p-3 space-y-3">
            <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs font-bold text-gray-500 shrink-0">Раздел ${index + 1}</span>
                <input data-action="setEstimateField" data-pass-event data-on="input"
                       data-scope="section" data-key="${section._key}" data-field="name"
                       class="flex-1 min-w-[10rem] border rounded-lg px-2 py-1.5 text-sm font-semibold text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]"
                       value="${escapeHtml(section.name)}" placeholder="Название раздела (напр. Покрівля)">
                <button data-action="openEstimateWorkPicker" data-arg="${section._key}"
                        class="bg-[#15803d] hover:bg-[#166534] text-white px-2.5 py-1 rounded-lg text-[11px] font-semibold transition">
                    ➕ Работа из справочника
                </button>
                <button data-action="addEstimateBlankItem" data-arg="${section._key}"
                        class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition">
                    ➕ Своя строка
                </button>
                <button data-action="removeEstimateSection" data-arg="${section._key}"
                        class="bg-red-50 hover:bg-red-100 text-red-700 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition"
                        title="Удалить раздел вместе с позициями">🗑 Раздел</button>
            </div>

            ${items.length === 0 ? itemsEmptyState(section._key) : renderEstimateItemsTable(section, items)}</div>
    `;
}

const inputClass = 'border rounded-lg px-2 py-1 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]';

function renderEstimateItemsTable(section, items) {
    const calc = calcSection(section);

    return `
        <div class="overflow-x-auto">
            <table class="w-full text-xs min-w-[44rem]">
                <thead class="bg-gray-50 text-gray-600">
                    <tr>
                        <th class="px-2 py-2 w-8 text-left">№</th>
                        <th class="px-2 py-2 text-left">Наименование работы</th>
                        <th class="px-2 py-2 w-16 text-left">Од.</th>
                        <th class="px-2 py-2 w-20 text-right">К-сть</th>
                        <th class="px-2 py-2 w-24 text-right">Наряд</th>
                        <th class="px-2 py-2 w-24 text-right">Костор.</th>
                        <th class="px-2 py-2 w-28 text-right">Сумма</th>
                        <th class="px-2 py-2 w-24"></th>
                    </tr>
                </thead>
                <tbody class="divide-y">
                    ${items.map((item, index) => renderEstimateItemRows(item, index)).join('')}
                </tbody>
                <tfoot class="bg-gray-50 font-semibold text-gray-700">
                    <tr>
                        <td class="px-2 py-2" colspan="5">Разом за розділом</td>
                        <td class="px-2 py-2 text-right" colspan="2"
                            data-section-total="${section._key}">${formatMoney(calc.clientTotal)}</td>
                        <td class="px-2 py-2"></td>
                    </tr>
                    <tr class="text-[11px] text-gray-500 font-normal">
                        <td class="px-2 pb-2" colspan="3">в т.ч. работы ${formatMoney(calc.workClient)}</td>
                        <td class="px-2 pb-2 text-right" colspan="5">материалы ${formatMoney(calc.matClient)} ·
                            наряд ${formatMoney(calc.workerTotal)}</td>
                    </tr>
                </tfoot>
            </table>
        </div>
    `;
}

/** Строка позиции + строка её материалов (свёрнутая таблица под работой). */
function renderEstimateItemRows(item, index) {
    const sums = calcItem(item);

    const row = `
        <tr>
            <td class="px-2 py-2 text-gray-500">${index + 1}</td>
            <td class="px-2 py-2">
                <input data-action="setEstimateField" data-pass-event data-on="input"
                       data-scope="item" data-key="${item._key}" data-field="name"
                       class="${inputClass} w-full min-w-[12rem]" value="${escapeHtml(item.name)}"
                       placeholder="Название работы">
            </td>
            <td class="px-2 py-2">
                <select data-action="setEstimateField" data-pass-event data-on="change"
                        data-scope="item" data-key="${item._key}" data-field="unit"
                        class="${inputClass} w-full">${unitsOptions(item.unit)}</select>
            </td>
            <td class="px-2 py-2">
                <input type="number" step="0.01" data-action="setEstimateField" data-pass-event data-on="input"
                       data-scope="item" data-key="${item._key}" data-field="quantity"
                       class="${inputClass} w-full text-right" value="${item.quantity}">
            </td>
            <td class="px-2 py-2">
                <input type="number" step="0.01" data-action="setEstimateField" data-pass-event data-on="input"
                       data-scope="item" data-key="${item._key}" data-field="price_worker"
                       class="${inputClass} w-full text-right" value="${item.price_worker}">
            </td>
            <td class="px-2 py-2">
                <input type="number" step="0.01" data-action="setEstimateField" data-pass-event data-on="input"
                       data-scope="item" data-key="${item._key}" data-field="price_client"
                       class="${inputClass} w-full text-right" value="${item.price_client}">
            </td>
            <td class="px-2 py-2 text-right text-gray-800 font-semibold" data-item-sum="${item._key}">
                ${formatMoney(sums.clientTotal)}
            </td>
            <td class="px-2 py-2 text-right whitespace-nowrap">
                <button data-action="openEstimateMaterialPicker" data-arg="${item._key}"
                        class="px-2 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 font-semibold transition"
                        title="Добавить материал к позиции">📦</button>
                <button data-action="applyEstimateNormMaterials" data-arg="${item._key}"
                        class="px-2 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 font-semibold transition"
                        title="Подставить материалы по нормам расхода работы">💡</button>
                <button data-action="removeEstimateItem" data-arg="${item._key}"
                        class="px-2 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-semibold transition"
                        title="Удалить позицию">🗑</button>
            </td>
        </tr>
    `;

    return row + `
        <tr class="bg-gray-50/70">
            <td colspan="8" class="px-2 py-2">${renderItemMaterials(item)}</td>
        </tr>
    `;
}

/** Материалы позиции: подставляются по нормам, правятся на месте. */
function renderItemMaterials(item) {
    const materials = item.materials || [];

    if (materials.length === 0) {
        return `
            <p class="text-[11px] text-gray-400">
                Материалов нет: «📦» — добавить материал, «💡» — подставить по нормам расхода работы.
            </p>
        `;
    }

    const sums = calcItem(item);

    return `
        <table class="w-full text-[11px]">
            <thead class="text-gray-500">
                <tr>
                    <th class="px-2 py-1 text-left">Материал</th>
                    <th class="px-2 py-1 w-14 text-left">Од.</th>
                    <th class="px-2 py-1 w-20 text-right">К-сть</th>
                    <th class="px-2 py-1 w-24 text-right">Закупка</th>
                    <th class="px-2 py-1 w-24 text-right">Костор.</th>
                    <th class="px-2 py-1 w-20 text-center" title="Материал привозит заказчик: в суммы не входит">Заказч.</th>
                    <th class="px-2 py-1 w-24 text-right">Сумма</th>
                    <th class="px-2 py-1 w-10"></th>
                </tr>
            </thead>
            <tbody class="divide-y divide-gray-200">
                ${materials.map(material => {
                    const calc = calcItemMaterial(material);

                    return `
                        <tr>
                            <td class="px-2 py-1">
                                <input data-action="setEstimateField" data-pass-event data-on="input"
                                       data-scope="material" data-key="${material._key}" data-field="name"
                                       class="${inputClass} w-full min-w-[10rem]" value="${escapeHtml(material.name)}">
                            </td>
                            <td class="px-2 py-1">
                                <select data-action="setEstimateField" data-pass-event data-on="change"
                                        data-scope="material" data-key="${material._key}" data-field="unit"
                                        class="${inputClass} w-full">${unitsOptions(material.unit)}</select>
                            </td>
                            <td class="px-2 py-1">
                                <input type="number" step="0.01" data-action="setEstimateField" data-pass-event data-on="input"
                                       data-scope="material" data-key="${material._key}" data-field="quantity"
                                       class="${inputClass} w-full text-right" value="${material.quantity}">
                            </td>
                            <td class="px-2 py-1">
                                <input type="number" step="0.01" data-action="setEstimateField" data-pass-event data-on="input"
                                       data-scope="material" data-key="${material._key}" data-field="price_purchase"
                                       class="${inputClass} w-full text-right" value="${material.price_purchase}">
                            </td>
                            <td class="px-2 py-1">
                                <input type="number" step="0.01" data-action="setEstimateField" data-pass-event data-on="input"
                                       data-scope="material" data-key="${material._key}" data-field="price_client"
                                       class="${inputClass} w-full text-right" value="${material.price_client}">
                            </td>
                            <td class="px-2 py-1 text-center">
                                <input type="checkbox" data-action="setEstimateField" data-pass-event data-on="change"
                                       data-scope="material" data-key="${material._key}" data-field="is_customer_supplied"
                                       ${material.is_customer_supplied ? 'checked' : ''} class="accent-[#15803d]">
                            </td>
                            <td class="px-2 py-1 text-right" data-material-sum="${material._key}">
                                ${calc.skipped ? '—' : formatMoney(calc.client)}
                            </td>
                            <td class="px-2 py-1 text-right">
                                <button data-action="removeEstimateMaterial" data-arg="${material._key}"
                                        class="px-1.5 py-0.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-semibold transition"
                                        title="Убрать материал">🗑</button>
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
            <tfoot>
                <tr class="text-gray-600">
                    <td class="px-2 pt-1" colspan="6">
                        Материалы позиции (давальческие в суммы не входят)
                    </td>
                    <td class="px-2 pt-1 text-right font-semibold">${formatMoney(sums.matClient)}</td>
                    <td></td>
                </tr>
            </tfoot>
        </table>
    `;
}

// =====================================================================
// ЛИМИТИРОВАННЫЕ РАСХОДЫ
// =====================================================================

const LIMIT_BASES = CONFIG.ESTIMATE?.LIMIT_BASES || [];
const LIMIT_PRESETS = CONFIG.ESTIMATE?.LIMIT_PRESETS || [];

function renderEstimateLimits() {
    const container = el('estimate-limits-container');
    if (!container || !state.editor) return;

    const limits = state.editor.limits || [];
    const totals = state.totals || calcEstimate(state.editor);

    if (limits.length === 0) {
        container.innerHTML = `
            <p class="text-xs text-gray-500 p-3 bg-gray-50 rounded-lg border border-dashed">
                Лимитированных расходов нет. Это начисления сверх работ и материалов:
                непередбачені витрати, зимове удорожчання, кошторисний прибуток.
            </p>
        `;
        return;
    }

    container.innerHTML = `
        <div class="overflow-x-auto">
            <table class="w-full text-xs min-w-[34rem]">
                <thead class="bg-gray-50 text-gray-600">
                    <tr>
                        <th class="px-2 py-2 text-left">Название</th>
                        <th class="px-2 py-2 w-24 text-right">Процент, %</th>
                        <th class="px-2 py-2 w-48 text-left">Считается</th>
                        <th class="px-2 py-2 w-28 text-right">Сумма</th>
                        <th class="px-2 py-2 w-10"></th>
                    </tr>
                </thead>
                <tbody class="divide-y">
                    ${limits.map((limit, index) => {
                        const amount = (totals.limits[index] || {}).amount || 0;

                        return `
                            <tr>
                                <td class="px-2 py-2">
                                    <input list="estimate-limit-presets"
                                           data-action="setEstimateField" data-pass-event data-on="input"
                                           data-scope="limit" data-index="${index}" data-field="name"
                                           class="${inputClass} w-full" value="${escapeHtml(limit.name)}"
                                           placeholder="Например: Непередбачені витрати">
                                </td>
                                <td class="px-2 py-2">
                                    <input type="number" step="0.01"
                                           data-action="setEstimateField" data-pass-event data-on="input"
                                           data-scope="limit" data-index="${index}" data-field="percent"
                                           class="${inputClass} w-full text-right" value="${limit.percent}">
                                </td>
                                <td class="px-2 py-2">
                                    <select data-action="setEstimateField" data-pass-event data-on="change"
                                            data-scope="limit" data-index="${index}" data-field="base"
                                            class="${inputClass} w-full">
                                        ${LIMIT_BASES.map(base => `
                                            <option value="${base.value}"${base.value === limit.base ? ' selected' : ''}>
                                                ${escapeHtml(base.label)}
                                            </option>
                                        `).join('')}
                                    </select>
                                </td>
                                <td class="px-2 py-2 text-right font-semibold text-gray-800">${formatMoney(amount)}</td>
                                <td class="px-2 py-2 text-right">
                                    <button data-action="removeEstimateLimit" data-arg="${index}"
                                            class="px-1.5 py-0.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-semibold transition"
                                            title="Убрать лимит">🗑</button>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
                <tfoot class="bg-gray-50 font-semibold text-gray-700">
                    <tr>
                        <td class="px-2 py-2" colspan="3">Итого лимитированных расходов</td>
                        <td class="px-2 py-2 text-right">${formatMoney(totals.limitsTotal)}</td>
                        <td></td>
                    </tr>
                </tfoot>
            </table>
        </div>
    `;
}

// =====================================================================
// ПАНЕЛЬ ИТОГОВ
// =====================================================================
// Считает js/modules/estimate-doc.js — ровно те же цифры, что попадут в
// документы и в список смет. Своей арифметики в редакторе нет намеренно:
// иначе итог на экране и итог в кошторисе однажды разойдутся.

export function renderEstimateTotals() {
    const container = el('estimate-totals');
    if (!container || !state.editor) return;

    const totals = calcEstimate(state.editor);
    state.totals = totals;

    const rows = [
        ['Работы', totals.workClient, totals.workWorker],
        ['Материалы', totals.matClient, totals.matWorker],
        ['Лимитированные расходы', totals.limitsTotal, 0],
        [`ПДВ ${formatNumber(totals.vatPercent, 2)}%`, totals.vatAmount, 0]
    ];

    container.innerHTML = `
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            ${rows.map(([label, client, worker]) => `
                <div class="flex justify-between gap-2 text-xs bg-white rounded-lg border px-3 py-2">
                    <span class="text-gray-600">${escapeHtml(label)}</span>
                    <span class="text-right">
                        <b class="text-gray-900">${formatMoney(client)}</b>
                        ${worker > 0 ? `<span class="text-[10px] text-gray-500 block">наряд ${formatMoney(worker)}</span>` : ''}
                    </span>
                </div>
            `).join('')}
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
            ${totalsCard('💰 Заказчику до сплати', totals.grandTotal, 'bg-[#15803d] text-white')}
            ${totalsCard('🛠 Себестоимость (наряд)', totals.naryadTotal, 'bg-white border text-gray-800')}
            ${totalsCard(
                totals.profit >= 0 ? '📈 Прибыль' : '📉 Убыток',
                totals.profit,
                totals.profit >= 0
                    ? 'bg-emerald-50 border border-emerald-200 text-emerald-900'
                    : 'bg-red-50 border border-red-200 text-red-800'
            )}
        </div>
        <p class="text-[10px] text-gray-500 mt-2">
            Количество материалов округляется вверх (полмешка не купить), давальческие материалы в суммы
            не входят. ПДВ считается от подытога: работы + материалы + лимиты.
        </p>
        <datalist id="estimate-limit-presets">
            ${LIMIT_PRESETS.map(name => `<option value="${escapeHtml(name)}"></option>`).join('')}
        </datalist>
    `;
}

function totalsCard(label, value, tone) {
    return `
        <div class="rounded-xl px-3 py-2 ${tone}">
            <div class="text-[10px] uppercase tracking-wider opacity-80">${escapeHtml(label)}</div>
            <div class="text-lg font-bold">${formatMoney(value)}</div>
        </div>
    `;
}

// =====================================================================
// ПОИСК СТРОК ПО ЛОКАЛЬНОМУ КЛЮЧУ
// =====================================================================

function findSectionByKey(key) {
    return state.editor?.sections.find(section => section._key === key) || null;
}

function findItemByKey(key) {
    for (const section of state.editor?.sections || []) {
        const item = section.items.find(candidate => candidate._key === key);
        if (item) return item;
    }
    return null;
}

function findMaterialByKey(key) {
    for (const section of state.editor?.sections || []) {
        for (const item of section.items) {
            const material = (item.materials || []).find(candidate => candidate._key === key);
            if (material) return material;
        }
    }
    return null;
}

// =====================================================================
// ПРАВКА ПОЛЕЙ НА МЕСТЕ
// =====================================================================
// Один обработчик на все поля сметы: элемент сам называет область
// (data-scope), строку (data-key или data-index) и поле (data-field).
// Событие передаётся целиком (data-pass-event) — иначе не хватило бы одного
// data-arg на три параметра.
// После правки перерисовываются ТОЛЬКО итоги и суммы строк: полная
// перерисовка выбила бы курсор из поля, в которое человек печатает.

export function setEstimateField(event) {
    const node = event.target;

    if (!state.editor) return;

    const scope = node.dataset.scope;
    const field = node.dataset.field;
    if (!scope || !field) return;

    const value = node.type === 'checkbox' ? Boolean(node.checked) : node.value;
    const toNumber = (raw) => Number(String(raw).replace(',', '.')) || 0;

    if (scope === 'section') {
        const section = findSectionByKey(node.dataset.key);
        if (section) section[field] = value;
        return;
    }

    if (scope === 'estimate') {
        state.editor[field] = value;

        // ПДВ влияет на итоги: налог считается от подытога сметы.
        if (field === 'vat_percent') renderEstimateTotals();
        return;
    }

    if (scope === 'item') {
        const item = findItemByKey(node.dataset.key);
        if (!item) return;

        item[field] = ['quantity', 'price_worker', 'price_client'].includes(field)
            ? toNumber(value)
            : value;

        refreshEstimateRowSums(item);
        renderEstimateTotals();
        renderEstimateLimits();
        return;
    }

    if (scope === 'material') {
        const material = findMaterialByKey(node.dataset.key);
        if (!material) return;

        material[field] = ['quantity', 'price_purchase', 'price_client'].includes(field)
            ? toNumber(value)
            : value;

        const item = findItemByMaterialKey(node.dataset.key);
        if (item) refreshEstimateRowSums(item);
        renderEstimateTotals();
        renderEstimateLimits();
        return;
    }

    if (scope === 'limit') {
        const limit = state.editor.limits[Number(node.dataset.index)];
        if (!limit) return;

        limit[field] = field === 'percent' ? toNumber(value) : value;
        renderEstimateLimits();
        renderEstimateTotals();
    }
}

/** Позиция, которой принадлежит материал (для пересчёта сумм строки). */
function findItemByMaterialKey(materialKey) {
    for (const section of state.editor?.sections || []) {
        for (const item of section.items) {
            if ((item.materials || []).some(material => material._key === materialKey)) return item;
        }
    }
    return null;
}

/** Перерисовывает суммы строки позиции и её раздела (без полной перерисовки). */
function refreshEstimateRowSums(item) {
    const sums = calcItem(item);

    const itemCell = document.querySelector(`[data-item-sum="${item._key}"]`);
    if (itemCell) itemCell.textContent = formatMoney(sums.clientTotal);

    (item.materials || []).forEach(material => {
        const cell = document.querySelector(`[data-material-sum="${material._key}"]`);
        if (!cell) return;

        const calc = calcItemMaterial(material);
        cell.textContent = calc.skipped ? '—' : formatMoney(calc.client);
    });

    const section = state.editor.sections.find(candidate =>
        candidate.items.some(candidateItem => candidateItem._key === item._key));

    if (section) {
        const cell = document.querySelector(`[data-section-total="${section._key}"]`);
        if (cell) cell.textContent = formatMoney(calcSection(section).clientTotal);
    }
}

// =====================================================================
// РАЗДЕЛЫ, ПОЗИЦИИ, МАТЕРИАЛЫ, ЛИМИТЫ: ДОБАВЛЕНИЕ И УДАЛЕНИЕ
// =====================================================================

export function addEstimateSection() {
    if (!state.editor) return;

    state.editor.sections.push({ _key: nextKey('s'), id: null, name: '', items: [] });
    renderEstimateSections();
    renderEstimateTotals();
}

export function removeEstimateSection(sectionKey) {
    if (!state.editor) return;

    const section = findSectionByKey(sectionKey);
    if (!section) return;

    const title = section.name || 'без названия';

    if (section.items.length > 0 &&
        !window.confirm(`Удалить раздел «${title}» вместе с ${section.items.length} позиц.?`)) {
        return;
    }

    state.editor.sections = state.editor.sections.filter(candidate => candidate._key !== sectionKey);
    renderEstimateSections();
    renderEstimateTotals();
    renderEstimateLimits();
}

export function addEstimateBlankItem(sectionKey) {
    if (!state.editor) return;

    const section = findSectionByKey(sectionKey);
    if (!section) return;

    section.items.push({
        _key: nextKey('i'),
        id: null,
        work_id: null,
        name: '',
        unit: 'м²',
        quantity: 1,
        price_worker: 0,
        price_client: 0,
        materials: []
    });

    renderEstimateSections();
    renderEstimateTotals();
}

export function removeEstimateItem(itemKey) {
    if (!state.editor) return;

    const item = findItemByKey(itemKey);
    if (!item) return;

    if (!window.confirm(`Удалить позицию «${item.name || 'без названия'}»?`)) return;

    state.editor.sections.forEach(section => {
        section.items = section.items.filter(candidate => candidate._key !== itemKey);
    });

    renderEstimateSections();
    renderEstimateTotals();
    renderEstimateLimits();
}

export function removeEstimateMaterial(materialKey) {
    if (!state.editor) return;

    state.editor.sections.forEach(section => {
        section.items.forEach(item => {
            item.materials = (item.materials || []).filter(material => material._key !== materialKey);
        });
    });

    renderEstimateSections();
    renderEstimateTotals();
    renderEstimateLimits();
}

export function addEstimateLimit() {
    if (!state.editor) return;

    state.editor.limits.push({ name: '', percent: 0, base: 'both' });
    renderEstimateLimits();
    renderEstimateTotals();
}

export function removeEstimateLimit(index) {
    if (!state.editor) return;

    state.editor.limits.splice(Number(index), 1);
    renderEstimateLimits();
    renderEstimateTotals();
}

// =====================================================================
// СОХРАНЕНИЕ, УДАЛЕНИЕ, СТАТУС
// =====================================================================

/**
 * Собирает payload для save_estimate(): ровно те поля, которые ждёт
 * plpgsql-функция (database/migrate-v2.10-estimates.sql).
 */
function buildEstimatePayload(editor) {
    const toNumber = (value) => Number(value) || 0;

    return {
        title: String(editor.title || '').trim(),
        object_name: editor.object_name || '',
        project_id: editor.project_id || null,
        client_id: editor.client_id || null,
        notes: editor.notes || '',
        vat_percent: toNumber(editor.vat_percent),
        vat_base: editor.vat_base || 'both',
        status: editor.status || 'draft',
        sections: (editor.sections || []).map(section => ({
            name: section.name || '',
            items: (section.items || []).map(item => ({
                name: item.name || '',
                unit: item.unit || 'шт',
                quantity: toNumber(item.quantity),
                price_worker: toNumber(item.price_worker),
                price_client: toNumber(item.price_client),
                work_id: item.work_id || null,
                materials: (item.materials || []).map(material => ({
                    name: material.name || '',
                    unit: material.unit || 'шт',
                    quantity: toNumber(material.quantity),
                    price_purchase: toNumber(material.price_purchase),
                    price_client: toNumber(material.price_client),
                    consumption: material.consumption === null || material.consumption === undefined
                        ? null
                        : toNumber(material.consumption),
                    is_customer_supplied: Boolean(material.is_customer_supplied),
                    material_id: material.material_id || null
                }))
            }))
        })),
        limits: (editor.limits || []).map(limit => ({
            name: limit.name || '',
            percent: toNumber(limit.percent),
            base: limit.base || 'both'
        }))
    };
}

export async function saveEstimate() {
    if (!requirePermission('manage_estimate')) return false;

    const editor = state.editor;
    if (!editor) return false;

    const payload = buildEstimatePayload(editor);

    if (!payload.title) {
        toast('Впиши название сметы', 'error');
        return false;
    }

    const saveButton = el('estimate-save-btn');
    if (saveButton) {
        saveButton.disabled = true;
        saveButton.textContent = '⏳ Сохраняем...';
    }

    const { data, error } = await db.rpc(RPC_ESTIMATES.SAVE, {
        p_payload: payload,
        p_estimate_id: editor.id,
        p_command_key: db.newCommandKey()
    });

    if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = '💾 Сохранить';
    }

    if (error) {
        log.error('Ошибка сохранения сметы:', error.message);
        toast('Не удалось сохранить смету: ' + explainEstimateError(error), 'error');
        return false;
    }

    toast(`Смета № ${data.number} сохранена`, 'success');

    // Строки в базе пересоздаются, поэтому перечитываем смету: локальные ключи
    // и id строк должны совпасть с базой, иначе следующее сохранение уйдёт «в
    // никуда». Заодно обновляется список под карточкой.
    await loadEstimates();
    await openEstimateEditor(data.id);

    return true;
}

export async function deleteEstimate(id) {
    if (!requirePermission('manage_estimate')) return;

    const estimate = state.list.find(item => Number(item.id) === Number(id));
    const label = estimate ? `№ ${estimate.number} «${estimate.title}»` : `#${id}`;

    if (!window.confirm(`Удалить смету ${label}?\n\nРазделы, позиции и материалы уйдут вместе с ней.`)) {
        return;
    }

    const { error } = await db.rpc(RPC_ESTIMATES.DELETE, { p_estimate_id: Number(id) });

    if (error) {
        log.error('Ошибка удаления сметы:', error.message);
        toast('Не удалось удалить смету: ' + db.explainError(error), 'error');
        return;
    }

    toast('Смета удалена', 'success');

    if (state.editor && Number(state.editor.id) === Number(id)) {
        state.editor = null;
        state.view = 'list';
    }

    await loadEstimates();
}

export async function toggleEstimateStatus(id) {
    if (!requirePermission('manage_estimate')) return;

    const estimate = state.list.find(item => Number(item.id) === Number(id));
    if (!estimate) return;

    const next = estimate.status === 'approved' ? 'draft' : 'approved';

    const { error } = await db.rpc(RPC_ESTIMATES.SET_STATUS, {
        p_estimate_id: Number(id),
        p_status: next
    });

    if (error) {
        log.error('Ошибка смены статуса сметы:', error.message);
        toast('Не удалось изменить статус: ' + db.explainError(error), 'error');
        return;
    }

    toast(next === 'approved' ? 'Смета утверждена' : 'Смета вернулась в черновики', 'success');
    await loadEstimates();
}

// =====================================================================
// ДОКУМЕНТЫ: ОКНО ВЫГРУЗКИ
// =====================================================================
// Сотрудник выбирает четыре вещи (макет — «Експорт документа»):
//   1. тип документа   — кошторис / наряд на роботи / відомість матеріалів;
//   2. вид кошторису   — 6-ти графка (книжна) или 9-ти (альбомна);
//   3. колір шапки     — заливка строки заголовків таблицы;
//   4. формат          — PDF или Excel.
// Выбор держим в state.doc, а плитки окна перерисовывает
// renderEstimateExportOptions(): подсветка выбранного — это классы, собирать их
// в разметке (состояния на четыре группы выбора) было бы нечитаемо.
// Вид кошторису спрашивают только у кошториса — у наряда и ведомости таблица
// одна, поэтому блок «Вид кошторису» прячется (как в макете).

/** Классы плитки: выбранная — рамка и подложка схемы, остальные — серые. */
function docOptionClass(active) {
    return active
        ? 'border-[#15803d] bg-emerald-50 text-emerald-900'
        : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50';
}

/** Плитка окна: один вид разметки для всех четырёх групп выбора. */
function docTile(action, value, label, active) {
    return `
        <button type="button" data-action="${action}" data-arg="${escapeHtml(value)}"
                class="w-full text-left px-3.5 py-2.5 rounded-xl border-2 text-sm font-medium transition ${docOptionClass(active)}">
            ${escapeHtml(label)}
        </button>
    `;
}

/** Перерисовывает содержимое окна под текущий выбор. */
export function renderEstimateExportOptions() {
    const kinds = el('estimate-export-types');
    if (kinds) {
        kinds.innerHTML = DOC_KINDS
            .map(kind => docTile('setEstimateExportType', kind.value, kind.label, state.doc.kind === kind.value))
            .join('');
    }

    const kind = DOC_KINDS.find(item => item.value === state.doc.kind) || DOC_KINDS[0];
    const viewWrap = el('estimate-export-views-wrap');
    const showView = Boolean(kind && kind.view);
    if (viewWrap) viewWrap.classList.toggle('hidden', !showView);

    const views = el('estimate-export-views');
    if (views && showView) {
        views.innerHTML = DOC_VIEWS
            .map(view => docTile('setEstimateExportView', view.value, view.label, state.doc.view === view.value))
            .join('');
    }

    const colors = el('estimate-export-colors');
    if (colors) {
        colors.innerHTML = DOC_COLORS.map(color => {
            const active = state.doc.color === color.value;
            const ring = active
                ? 'border-[#15803d] ring-2 ring-emerald-200 scale-110'
                : 'border-gray-300 hover:border-gray-500';
            const mark = active
                ? '<span class="text-[10px] font-bold leading-none text-white">✓</span>'
                : '';

            return `
                <button type="button" data-action="setEstimateExportColor" data-arg="${escapeHtml(color.value)}"
                        title="${escapeHtml(color.label)}"
                        class="w-7 h-7 rounded-full border-2 transition flex items-center justify-center ${ring}"
                        style="background-color:${color.bg ? '#' + color.bg : '#ffffff'}">
                    ${color.bg ? mark : '<span class="w-full h-px bg-red-400 rotate-45"></span>'}
                </button>
            `;
        }).join('') + `<span class="text-xs text-gray-500 ml-1">${
            escapeHtml((DOC_COLORS.find(item => item.value === state.doc.color) || {}).label || '')
        }</span>`;
    }

    const formats = el('estimate-export-formats');
    if (formats) {
        formats.innerHTML = DOC_FORMATS
            .map(format => docTile('setEstimateExportFormat', format.value, format.label, state.doc.format === format.value))
            .join('');
    }
}

export function openEstimateExportModal(id) {
    if (!requirePermission('manage_estimate')) return;

    state.exportEstimateId = Number(id) || state.editor?.id || null;
    state.doc = { ...DEFAULT_DOC };

    renderEstimateExportOptions();
    showModal('estimate-export-modal');
}

export function setEstimateExportType(value) {
    state.doc = { ...state.doc, kind: String(value || '') };
    renderEstimateExportOptions();
}

export function setEstimateExportView(value) {
    state.doc = { ...state.doc, view: String(value || '') };
    renderEstimateExportOptions();
}

export function setEstimateExportColor(value) {
    state.doc = { ...state.doc, color: String(value || '') };
    renderEstimateExportOptions();
}

export function setEstimateExportFormat(value) {
    state.doc = { ...state.doc, format: String(value || '') };
    renderEstimateExportOptions();
}

/**
 * «⬇️ Завантажити»: собирает и скачивает документ с выбранными настройками.
 * Смету берём из редактора, если он открыт на ней (там свежие правки, которые
 * ещё не сохранены), иначе читаем из базы.
 */
export async function downloadEstimateDoc() {
    if (!requirePermission('manage_estimate')) return;

    const id = state.exportEstimateId || state.editor?.id;

    let estimate = null;

    if (state.editor && Number(state.editor.id) === Number(id)) {
        estimate = state.editor;
    } else if (id) {
        estimate = await fetchEstimateTree(id);
    }

    if (!estimate) {
        toast('Смета не найдена', 'error');
        return;
    }

    if (!estimate.sections || estimate.sections.length === 0) {
        toast('В смете нет разделов с позициями — документ будет пустым', 'error');
        return;
    }

    // В редакторе заказчик — только id: в документ печатаем имя из справочника
    // клиентов (строка «Замовник: …» в шапке).
    const payload = { ...estimate, client_name: clientName(estimate.client_id) };
    const company = getEstimateCompany();
    const options = { ...state.doc };

    if (options.format === 'excel') {
        exportEstimateExcel(payload, company, options);
    } else {
        await exportEstimatePdf(payload, company, options);
    }

    hideModal('estimate-export-modal');
}

/**
 * Выгрузка по формату аргументом — прежний вход (кнопки «📥 Excel»/«📄 PDF»).
 * Оставлен, чтобы старые вызовы продолжали работать: форматы теперь
 * выбираются в окне, поэтому аргумент просто переопределяет выбор.
 */
export async function exportEstimateDoc(format) {
    if (format === 'excel' || format === 'pdf') {
        state.doc = { ...state.doc, format };
    }
    return downloadEstimateDoc();
}

// =====================================================================
// ПУНКТЫ МЕНЮ КНОПКИ «СМЕТЫ»
// =====================================================================
// Кнопка «📐 Сметы» раскрывает меню действий (js/main.js → toggleEstimatesMenu):
// «Создать смету», «Список смет», «Справочники», «Клиенты», «Настройки».
// Действия уже существуют у модулей — здесь только те, которых не было.

/** «📋 Список смет»: закрывает редактор и показывает список. */
export async function showEstimatesList() {
    if (!requirePermission('manage_estimate')) return;

    state.editor = null;
    state.view = 'list';
    renderEstimatesList();

    // Список мог быть ещё не загружен: сотрудник мог нажать пункт меню, не
    // открывая раздел.
    if (!state.loaded) await loadEstimates();
}

/** «⚙️ Настройки»: реквизиты компании — ими печатается шапка документов. */
export function openEstimateSettings() {
    if (!requirePermission('manage_estimate')) return;
    openEstimateCompanyModal();
}

// =====================================================================
// ПЛАН СМЕТЫ → РАЗДЕЛЫ ОБЪЕКТА
// =====================================================================
// Это главная связка со всем остальным приложением: после переноса план-факт,
// график и заявки на материалы работают с планом из сметы — ровно так же, как
// после загрузки файла Excel (js/modules/estimate.js). Разделы сопоставляются
// ПО НАЗВАНИЮ (нормализованному), поэтому повторный перенос обновляет суммы,
// а не плодит дубли.

export async function applyEstimateToProject() {
    if (!requirePermission('manage_estimate')) return;

    const editor = state.editor;
    if (!editor) return;

    if (!editor.id) {
        toast('Сначала сохраните смету: до сохранения её разделов в базе нет', 'error');
        return;
    }
    if (!editor.project_id) {
        toast('У сметы не выбран объект — выберите его в шапке', 'error');
        return;
    }

    const totals = calcEstimate(editor);
    const sectionsToApply = totals.sections.filter(section => (section.section.name || '').trim());
    if (sectionsToApply.length === 0) {
        toast('В смете нет разделов с названиями', 'error');
        return;
    }

    const targetProjectName = projectName(editor.project_id) || `#${editor.project_id}`;

    if (!window.confirm(
        `Перенести план сметы № ${editor.number} в разделы объекта «${targetProjectName}»?\n\n` +
        'Разделы объекта с такими же названиями получат новые плановые суммы (работы, материалы, итого). ' +
        'Остальные разделы объекта останутся как есть. Лимиты и ПДВ — общие по смете, в план разделов не раскладываются.'
    )) {
        return;
    }

    const { data: existing, error } = await db.select('sections', {
        filters: { project_id: Number(editor.project_id) }
    });

    if (error) {
        log.error('Ошибка чтения разделов объекта:', error.message);
        toast('Не удалось прочитать разделы объекта: ' + db.explainError(error), 'error');
        return;
    }

    const byName = new Map();
    (existing || []).forEach(section => {
        const key = normalizeSectionName(section.name);
        if (!byName.has(key)) byName.set(key, section);
    });

    let created = 0;
    let updated = 0;

    for (const section of sectionsToApply) {
        const name = applySectionName(section);

        // Служебный раздел «Доп. расходы» смета не перезаписывает никогда:
        // иначе траты вне сметы получили бы план.
        if (isExtraSectionName(name)) {
            log.warn(`Раздел сметы «${name}» совпал со служебным — пропущен`);
            continue;
        }

        const payload = {
            name,
            plan_works: section.workClient,
            plan_materials: section.matClient,
            plan_total: section.clientTotal
        };

        const match = byName.get(normalizeSectionName(name));

        if (match) {
            const { error: updateError } = await db.update('sections', payload, { id: match.id });
            if (updateError) {
                toast(`Раздел «${name}» не обновлён: ` + db.explainError(updateError), 'error');
                continue;
            }
            updated += 1;
        } else {
            const { error: insertError } = await db.insert('sections', {
                project_id: Number(editor.project_id),
                ...payload
            });
            if (insertError) {
                toast(`Раздел «${name}» не создан: ` + db.explainError(insertError), 'error');
                continue;
            }
            created += 1;
        }
    }

    log.info(`План сметы № ${editor.number} перенесён в объект #${editor.project_id}: ` +
        `создано ${created}, обновлено ${updated}`);

    toast(`План перенесён: создано ${created}, обновлено ${updated}. Проверьте «📊 План-факт» объекта.`,
        'success');
}

/** Название раздела сметы (без лишних пробелов) — ключ сопоставления. */
function applySectionName(section) {
    return String(section.section.name || '').trim().replace(/\s+/g, ' ');
}

// =====================================================================
// ФУНКЦИИ ДЛЯ РАЗМЕТКИ (data-action)
// =====================================================================

// Функции для разметки (data-action) — как в остальных модулях проекта:
// явное присваивание на window, чтобы прогон
// tools/checks/frontend-check.mjs видел реализацию каждого действия
// (список через Object.assign() проверка не разбирает).
window.openNewEstimate = openNewEstimate;
window.openEstimateEditor = openEstimateEditor;
window.closeEstimateEditor = closeEstimateEditor;
window.setEstimatesSearch = setEstimatesSearch;
window.setEstimatesStatus = setEstimatesStatus;
window.renderEstimatesList = renderEstimatesList;
window.addEstimateSection = addEstimateSection;
window.removeEstimateSection = removeEstimateSection;
window.addEstimateBlankItem = addEstimateBlankItem;
window.removeEstimateItem = removeEstimateItem;
window.removeEstimateMaterial = removeEstimateMaterial;
window.addEstimateLimit = addEstimateLimit;
window.removeEstimateLimit = removeEstimateLimit;
window.setEstimateField = setEstimateField;
window.openEstimateWorkPicker = openEstimateWorkPicker;
window.setEstimateWorkPickerSearch = setEstimateWorkPickerSearch;
window.expandEstimateWorkPickerAll = expandEstimateWorkPickerAll;
window.collapseEstimateWorkPickerAll = collapseEstimateWorkPickerAll;
window.selectEstimateWork = selectEstimateWork;
window.toggleEstimateWorkPickerSection = toggleEstimateWorkPickerSection;
window.chooseEstimateWork = chooseEstimateWork;
window.openEstimateMaterialPicker = openEstimateMaterialPicker;
window.setEstimateMaterialPickerSearch = setEstimateMaterialPickerSearch;
window.chooseEstimateMaterial = chooseEstimateMaterial;
window.applyEstimateNormMaterials = applyEstimateNormMaterials;
window.saveEstimate = saveEstimate;
window.deleteEstimate = deleteEstimate;
window.toggleEstimateStatus = toggleEstimateStatus;
window.openEstimateExportModal = openEstimateExportModal;
window.renderEstimateExportOptions = renderEstimateExportOptions;
window.setEstimateExportType = setEstimateExportType;
window.setEstimateExportView = setEstimateExportView;
window.setEstimateExportColor = setEstimateExportColor;
window.setEstimateExportFormat = setEstimateExportFormat;
window.downloadEstimateDoc = downloadEstimateDoc;
window.exportEstimateDoc = exportEstimateDoc;
window.showEstimatesList = showEstimatesList;
window.openEstimateSettings = openEstimateSettings;
window.applyEstimateToProject = applyEstimateToProject;

// Правка справочника (цена, норма, единица) меняет подписи в списке смет:
// работы/материалы там показываются по своим копиям, а вот единицы и названия
// клиентов — из справочника. Открытый редактор не перерисовываем: человек
// может печатать в поле, и перерисовка выбила бы курсор.
onEstimateCatalogChange(() => {
    if (state.view === 'list' && state.loaded) renderEstimatesList();
});

// Отдельные окна, а не выпадающие списки: работ в прайсе сотни, и выбирают их
// по имени с поиском. Цена и единица подставляются из справочника, но
// остаются в позиции своими копиями — правка прайса не меняет готовую смету.

// =====================================================================
// ВЫБОР РАБОТЫ И МАТЕРИАЛА ИЗ СПРАВОЧНИКА
// =====================================================================
// Окно выбора работы — в две колонки (index.html → #estimate-work-picker-modal):
// слева дерево разделов и подразделов справочника с работами внутри, справа
// карточка выбранной работы и материалы, которые к ней привязаны (нормы
// расхода). Так сотрудник видит, что подставится в смету, ДО нажатия
// «➕ Добавить в смету»: в прежнем плоском списке были только название и цены,
// и материалы появлялись «сами собой».
// Разделы рисуются ТЕМ ЖЕ деревом, что и в справочнике
// (getEstimateWorkSectionTree), поэтому структура папок в окне и в прайсе одна,
// а подсказки ««Родитель»» у папок с одинаковым именем считает справочник
// (getSectionNameHints) — окно и прайс называют разделы одинаково.
// Папки при открытии СВЁРНУТЫ (v2.12.0-r9): у прайса на сотни работ дерево,
// раскрытое целиком, читается как одна простыня. Поиск показывает работы
// ПЛОСКИМ списком с папкой в строке — в дереве найденное пришлось бы искать
// глазами по раскрытым папкам.

export function openEstimateWorkPicker(sectionKey) {
    if (!state.editor) return;
    if (!findSectionByKey(sectionKey)) return;

    // collapsed — свёрнутые папки (id разделов; 0 — группа «Без раздела»).
    // При открытии свёрнуты ВСЕ папки (v2.12.0-r9): у прайса на сотни работ
    // развёрнутое дерево выглядит одной простынёй, и новый сотрудник не видит,
    // что это разделы, а не список работ. Группа «Без раздела» остаётся
    // раскрытой: её название ничего не говорит о том, что внутри.
    state.picker = {
        kind: 'work',
        sectionKey,
        workId: null,
        collapsed: new Set(workPickerSectionIds())
    };
    setValue('estimate-work-picker-search', '');

    renderEstimateWorkPicker();
    showModal('estimate-work-picker-modal');
}

export function setEstimateWorkPickerSearch(value) {
    setValue('estimate-work-picker-search', value);
    renderEstimateWorkPicker();
}

/** «▾ Раскрыть всё»: открыть все папки дерева, не кликая по каждой. */
export function expandEstimateWorkPickerAll() {
    if (!state.editor || state.picker?.kind !== 'work') return;

    pickerCollapsed().clear();
    renderEstimateWorkPickerTree();
}

/** «▸ Свернуть всё»: оставить только папки — по ним и ищут нужный раздел. */
export function collapseEstimateWorkPickerAll() {
    if (!state.editor || state.picker?.kind !== 'work') return;

    const collapsed = pickerCollapsed();
    workPickerSectionIds().forEach(id => collapsed.add(id));

    renderEstimateWorkPickerTree();
}

/** Id всех папок прайса: стартовое состояние дерева и кнопка «▸ Свернуть всё». */
function workPickerSectionIds() {
    return getEstimateWorkSectionTree().map(({ section }) => Number(section.id));
}

/** Перерисовывает обе половины окна: дерево работ и карточку выбранной работы. */
function renderEstimateWorkPicker() {
    // «✕» в поиске показывается только тогда, когда есть что очищать.
    const search = el('estimate-work-picker-search');
    const clear = el('estimate-work-picker-search-clear');
    if (clear) clear.classList.toggle('hidden', !(search?.value || '').trim());

    renderEstimateWorkPickerTree();
    renderEstimateWorkPickerPreview();
}

/** Клик по работе в дереве: подсветить её и показать её материалы справа. */
export function selectEstimateWork(workId) {
    if (!state.editor || state.picker?.kind !== 'work') return;
    if (!findEstimateWork(workId)) return;

    state.picker.workId = Number(workId);
    renderEstimateWorkPicker();
}

/** Свёрнутые папки дерева (id разделов; 0 — группа «Без раздела»). */
function pickerCollapsed() {
    if (!state.picker) return new Set();
    if (!(state.picker.collapsed instanceof Set)) state.picker.collapsed = new Set();

    return state.picker.collapsed;
}

/** Клик по папке: свернуть или раскрыть её работы вместе с подпапками. */
export function toggleEstimateWorkPickerSection(sectionId) {
    if (!state.editor || state.picker?.kind !== 'work') return;

    const id = Number(sectionId) || 0;
    const collapsed = pickerCollapsed();

    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);

    renderEstimateWorkPickerTree();
}

/**
 * Левая половина окна. Два режима (v2.12.0-r9):
 *   * дерево — раздел → подраздел → работы. Показываем ВСЕ созданные разделы
 *     (сотрудник видит ту же структуру, что в справочнике), папки свёрнуты и
 *     раскрываются кликом по заголовку. У заголовка — количество работ ВСЕЙ
 *     ветки, поэтому видно, есть ли в свёрнутой папке что раскрывать;
 *   * результаты поиска — ПЛОСКИЙ список работ с папкой в строке: найденное в
 *     дереве пришлось бы искать глазами по раскрытым папкам.
 * Над списком — полоса: что это за колонка, сколько работ, кнопки «Раскрыть папки»
 * и «Свернуть папки».
 */
function renderEstimateWorkPickerTree() {
    const container = el('estimate-work-picker-list');
    if (!container) return;

    // Перерисовка идёт и по клику (подсветить выбранную строку): сохраняем
    // прокрутку, иначе список прыгал бы в начало.
    const scrollTop = container.scrollTop;

    const search = (el('estimate-work-picker-search')?.value || '').trim().toLowerCase();
    const works = getEstimateCatalog().works || [];

    if (works.length === 0) {
        container.innerHTML = workPickerEmpty();
        return;
    }

    const found = works.filter(work => !search || work.name.toLowerCase().includes(search));
    const body = search ? pickerSearchRows(found) : pickerTreeRows(found);

    container.innerHTML = `
        <div class="sticky top-0 z-10 flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2">
            ${pickerPanelHead(works.length, found.length, Boolean(search))}
        </div>
        <div class="p-2 space-y-0.5">${body}</div>
    `;

    container.scrollTop = scrollTop;
}

/**
 * Полоса над списком: «Разделы справочника», счётчик работ и кнопки раскрытия.
 * Кнопки показываются по состоянию дерева: «▾ Раскрыть папки» — когда есть
 * свёрнутые папки, «▸ Свернуть папки» — когда есть раскрытые.
 */
function pickerPanelHead(total, found, searching) {
    const collapsed = pickerCollapsed();
    const folders = workPickerSectionIds();
    const count = searching
        ? `<span class="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">Найдено: ${found}</span>`
        : `<span class="shrink-0 rounded-full bg-white px-2 py-0.5 text-[10px] text-gray-500 ring-1 ring-gray-200">Работ: ${total}</span>`;
    const buttons = searching ? '' : `
        ${folders.some(id => collapsed.has(id)) ? `
            <button data-action="expandEstimateWorkPickerAll" title="Раскрыть все папки"
                    class="shrink-0 rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-gray-600 ring-1 ring-gray-200 transition hover:bg-gray-100">▾ Раскрыть папки</button>
        ` : ''}
        ${folders.some(id => !collapsed.has(id)) ? `
            <button data-action="collapseEstimateWorkPickerAll" title="Оставить только папки"
                    class="shrink-0 rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-gray-600 ring-1 ring-gray-200 transition hover:bg-gray-100">▸ Свернуть папки</button>
        ` : ''}
    `;

    return `
        <span class="min-w-0 truncate text-[10px] font-bold uppercase tracking-wider text-gray-500">Разделы справочника</span>
        ${count}
        <span class="ml-auto flex shrink-0 items-center gap-1">${buttons}</span>
    `;
}

/**
 * Дерево папок: у каждой — сколько работ в её ветке, а под раскрытой папкой её
 * собственные работы. Свёрнутая папка прячет и свои работы, и подпапки целиком.
 */
function pickerTreeRows(works) {
    const sections = getEstimateWorkSectionTree();
    // ««Родитель»» у папок с повторяющимся именем: «Земляные работы» внутри
    // «Земляные работы» иначе не отличить.
    const hints = getSectionNameHints(sections);

    // Родитель каждого раздела: по нему считаются работы ветки и прячутся
    // подпапки свёрнутой папки.
    const parentOf = new Map(sections.map(({ section }) =>
        [Number(section.id), section.parent_id ? Number(section.parent_id) : 0]));

    const bySection = new Map();
    const branchCount = new Map();

    works.forEach(work => {
        const id = work.section_id ? Number(work.section_id) : 0;
        if (!bySection.has(id)) bySection.set(id, []);
        bySection.get(id).push(work);

        // Считаем ветку: у папки с подпапками своих работ может и не быть.
        const seen = new Set();
        let current = id;
        while (current && !seen.has(current)) {
            seen.add(current);
            branchCount.set(current, (branchCount.get(current) || 0) + 1);
            current = parentOf.get(current) || 0;
        }
    });

    const collapsed = pickerCollapsed();
    const hidden = new Set();

    const inCollapsedFolder = (id) => {
        if (hidden.has(id)) return true;

        const seen = new Set([id]);
        let current = parentOf.get(id) || 0;

        // Предок идёт раньше потомка (дерево обходится сверху вниз), поэтому
        // состояние родителя к этому моменту уже известно — см. hidden.add ниже.
        while (current && !seen.has(current)) {
            seen.add(current);
            if (collapsed.has(current) || hidden.has(current)) {
                hidden.add(id);
                return true;
            }
            current = parentOf.get(current) || 0;
        }

        return false;
    };

    const rows = [];

    sections.forEach(({ section, level }) => {
        const id = Number(section.id);
        if (inCollapsedFolder(id)) return;

        const own = bySection.get(id) || [];
        const total = branchCount.get(id) || 0;
        const folded = collapsed.has(id);

        rows.push(pickerSectionTitle(section, level, total, folded, hints.get(id) || ''));
        if (!folded) own.forEach(work => rows.push(pickerWorkRow(work, level + 1)));
    });

    // Работы без раздела — отдельной группой внизу: потерять такую слишком легко.
    const orphans = bySection.get(0) || [];
    if (orphans.length > 0) {
        const folded = collapsed.has(0);

        rows.push(pickerSectionTitle(null, 0, orphans.length, folded));
        if (!folded) orphans.forEach(work => rows.push(pickerWorkRow(work, 1)));
    }

    return rows.length ? rows.join('') : workPickerEmpty();
}

/**
 * Результаты поиска — плоским списком: у каждой работы видно свою папку
 * (workSectionPath), поэтому раскрывать папки не нужно вовсе. Порядок — по
 * папкам, как в дереве, затем по названию работы.
 */
function pickerSearchRows(works) {
    if (works.length === 0) return workPickerEmpty();

    return works
        .slice()
        .sort((a, b) => workSectionPath(a.section_id).localeCompare(workSectionPath(b.section_id))
            || String(a.name).localeCompare(String(b.name)))
        .map(work => pickerWorkRow(work, 0, workSectionPath(work.section_id)))
        .join('');
}

/** Путь раздела работы по дереву справочника: «Земляные работы › Разработка грунта». */
function workSectionPath(sectionId) {
    if (!sectionId) return '';

    const byId = new Map(getEstimateWorkSectionTree()
        .map(({ section }) => [Number(section.id), section]));
    const names = [];
    const seen = new Set();
    let current = Number(sectionId);

    while (current && !seen.has(current)) {
        seen.add(current);

        const section = byId.get(current);
        if (!section) break;

        names.unshift(section.name);
        current = section.parent_id ? Number(section.parent_id) : 0;
    }

    return names.join(' › ');
}

/** Пустое состояние дерева: работ в прайсе нет или поиск ничего не нашёл. */
function workPickerEmpty() {
    const searching = Boolean((el('estimate-work-picker-search')?.value || '').trim());

    return `
        <p class="px-4 py-6 text-center text-xs text-gray-500">
            ${searching
                ? 'Ничего не найдено. Работы заполняются в «📚 Справочники → Работы».'
                : 'Работ нет. Их заполняют в «📚 Справочники → Работы».'}
        </p>
    `;
}

/**
 * Заголовок папки в дереве: отступы как у разделов справочника, но это КНОПКА —
 * клик сворачивает и раскрывает папку (toggleEstimateWorkPickerSection).
 * Стрелка и счётчик работ ветки показывают состояние, поэтому у свёрнутой папки
 * видно, есть ли что раскрывать. Подсказка note — ««Родитель»» у папок с
 * повторяющимся именем: без неё две строки «Земляные работы» не отличить.
 */
function pickerSectionTitle(section, level, count, folded, note = '') {
    const id = section ? Number(section.id) : 0;
    const icon = section ? '📁' : '📄';
    const name = section ? section.name : 'Без раздела';
    const arrow = section && level > 0 ? '↳ ' : '';

    return `
        <button data-action="toggleEstimateWorkPickerSection" data-arg="${id}"
                class="flex w-full items-center gap-1.5 rounded-lg py-2 pr-2 text-left transition hover:bg-white"
                style="padding-left:${8 + level * 14}px"
                title="${folded ? 'Раскрыть раздел' : 'Свернуть раздел'}">
            <span class="w-3 shrink-0 text-[10px] text-gray-400">${folded ? '▸' : '▾'}</span>
            <span class="min-w-0 truncate text-[11px] font-bold text-gray-700">${arrow}${icon} ${escapeHtml(name)}</span>
            ${note ? `<span class="shrink-0 text-[10px] text-gray-400">${escapeHtml(note)}</span>` : ''}
            <span class="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${count
                ? 'bg-white text-gray-500 ring-1 ring-gray-200'
                : 'text-gray-300'}">${count}</span>
        </button>
    `;
}

/**
 * Работа в дереве: клик выбирает её (материалы показываются справа). В строке
 * видно единицу измерения, обе цены и пилюлю «📦 N» — сколько материалов
 * подставится в смету по нормам. Для результатов поиска (path) сверху
 * печатается папка работы: искать её в дереве не нужно.
 */
function pickerWorkRow(work, level, path = '') {
    const active = Number(state.picker?.workId) === Number(work.id);
    const norms = getWorkMaterialsFor(work.id).length;

    return `
        <button data-action="selectEstimateWork" data-arg="${work.id}"
                class="block w-full rounded-xl border py-2 pr-2 text-left transition ${active
                    ? 'border-emerald-300 bg-emerald-50 ring-1 ring-emerald-200'
                    : 'border-transparent hover:border-emerald-200 hover:bg-emerald-50'}"
                style="padding-left:${12 + level * 14}px">
            ${path ? `<div class="truncate text-[10px] text-gray-400" title="${escapeHtml(path)}">📁 ${escapeHtml(path)}</div>` : ''}
            <div class="flex items-start justify-between gap-2">
                <span class="min-w-0 text-sm font-medium text-gray-800">${escapeHtml(work.name)}</span>
                ${norms ? `<span class="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                                  title="Материалы работы (нормы расхода): ${norms}">📦 ${norms}</span>` : ''}
            </div>
            <div class="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-gray-500">
                <span class="rounded bg-gray-100 px-1.5 py-0.5">${escapeHtml(work.unit)}</span>
                <span class="tabular-nums">наряд ${formatMoney(work.price_worker)}</span>
                <span class="text-gray-300">·</span>
                <span class="tabular-nums font-semibold text-[#166534]">кошторис ${formatMoney(work.price_client)}</span>
            </div>
        </button>
    `;
}

export function chooseEstimateWork(workId) {
    if (!state.editor || state.picker?.kind !== 'work') return;

    const work = findEstimateWork(workId);
    const section = findSectionByKey(state.picker.sectionKey);

    if (!work || !section) {
        toast('Работа или раздел не найдены', 'error');
        return;
    }

    const item = {
        _key: nextKey('i'),
        id: null,
        work_id: work.id,
        name: work.name,
        unit: work.unit,
        quantity: 1,
        price_worker: Number(work.price_worker) || 0,
        price_client: Number(work.price_client) || 0,
        materials: []
    };

    // Материалы по нормам расхода добавляем сразу: иначе о них забудут, и
    // смета выйдет без материалов.
    getWorkMaterialsFor(work.id).forEach(({ material, consumption }) => {
        item.materials.push(buildMaterialRow(material, consumption, item.quantity));
    });

    section.items.push(item);

    hideModal('estimate-work-picker-modal');
    state.picker = null;

    renderEstimateSections();
    renderEstimateTotals();
    renderEstimateLimits();

    toast(`Добавлено: ${work.name}`, 'success');
}

/**
 * Правая половина окна — карточка выбранной работы: путь до папки, две цены
 * плитками, материалы по нормам и кнопка «➕ Добавить в смету» внизу (она
 * «прилипает» к низу колонки, чтобы не искать её прокруткой). Пока работу не
 * выбрали, вместо карточки — три шага словами: окно, которое просто молчит,
 * новый сотрудник читает как «здесь ничего нет».
 */
function renderEstimateWorkPickerPreview() {
    const container = el('estimate-work-picker-preview');
    if (!container) return;

    const work = state.picker?.workId ? findEstimateWork(state.picker.workId) : null;

    if (!work) {
        container.innerHTML = `
            <div class="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
                <span class="text-3xl">👈</span>
                <p class="text-sm font-semibold text-gray-700">Выбери работу слева</p>
                <ol class="space-y-1 text-left text-[11px] text-gray-500">
                    <li>1. Раскрой папку — клик по её названию.</li>
                    <li>2. Кликни работу: справа появятся её материалы.</li>
                    <li>3. Нажми «➕ Добавить в смету» — работа попадёт в раздел.</li>
                </ol>
            </div>
        `;
        return;
    }

    const norms = getWorkMaterialsFor(work.id);
    const path = workSectionPath(work.section_id);

    container.innerHTML = `
        <div class="rounded-xl border bg-white p-3">
            <p class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Выбранная работа</p>
            <p class="text-sm font-bold text-gray-800">${escapeHtml(work.name)}</p>
            ${path ? `
                <p class="truncate text-[10px] text-gray-400" title="${escapeHtml(path)}">📁 ${escapeHtml(path)}</p>
            ` : ''}
            <div class="mt-2 grid grid-cols-2 gap-2">
                <div class="rounded-lg bg-gray-50 p-2">
                    <p class="text-[10px] text-gray-500">Наряд (рабочим)</p>
                    <p class="text-sm font-semibold tabular-nums text-gray-800">${formatMoney(work.price_worker)}</p>
                </div>
                <div class="rounded-lg bg-emerald-50 p-2">
                    <p class="text-[10px] text-emerald-700">Кошторис (заказчику)</p>
                    <p class="text-sm font-bold tabular-nums text-[#166534]">${formatMoney(work.price_client)}</p>
                </div>
            </div>
        </div>

        <p class="mt-3 flex items-center gap-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
            Материалы работы (нормы расхода)
            <span class="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">${norms.length}</span>
        </p>
        ${norms.length === 0 ? `
            <p class="mt-1 rounded-xl border border-dashed bg-gray-50 p-3 text-[11px] text-gray-500">
                К работе материалы не привязаны. Добавить их можно в справочнике
                («📚 Справочники → Работы → 📦») — тогда они подставятся в смету сами.
            </p>
        ` : `
            <div class="mt-1 overflow-hidden rounded-xl border bg-white">
                <table class="w-full text-[11px]">
                    <thead class="bg-gray-50 text-gray-500">
                        <tr>
                            <th class="px-2 py-1 text-left">Материал</th>
                            <th class="px-2 py-1 w-16 text-right">Расход</th>
                            <th class="px-2 py-1 w-12 text-left">Од.</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                        ${norms.map(({ material, consumption }) => `
                            <tr>
                                <td class="px-2 py-1 text-gray-800">
                                    ${escapeHtml(material.name)}
                                    ${material.is_customer_supplied
                                        ? '<span class="text-[10px] px-1 rounded bg-amber-100 text-amber-800">заказчика</span>'
                                        : ''}
                                </td>
                                <td class="px-2 py-1 text-right tabular-nums">${formatNumber(consumption, 4)}</td>
                                <td class="px-2 py-1 text-gray-500">${escapeHtml(material.unit)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `}

        <!-- Кнопка «прилипает» к низу колонки: у работы с десятком материалов её
             иначе приходилось бы искать прокруткой. -->
        <div class="sticky bottom-0 -mx-4 mt-3 border-t bg-white px-4 pb-1 pt-2">
            <button data-action="chooseEstimateWork" data-arg="${work.id}"
                    class="w-full bg-[#15803d] hover:bg-[#166534] text-white px-3 py-2.5 rounded-xl text-xs font-semibold shadow transition">
                ➕ Добавить в смету
            </button>
            <p class="mt-1 text-center text-[10px] text-gray-500">
                Материалы подставятся по нормам расхода работы.
            </p>
        </div>
    `;
}

/** Строка материала позиции из справочника (количество = расход × объём). */
function buildMaterialRow(material, consumption, quantity) {
    const qty = consumption > 0 ? Number((consumption * (Number(quantity) || 0)).toFixed(4)) : 1;

    return {
        _key: nextKey('m'),
        id: null,
        material_id: material.id,
        name: material.name,
        unit: material.unit,
        quantity: qty > 0 ? qty : 1,
        price_purchase: Number(material.price_purchase) || 0,
        price_client: Number(material.price_client) || 0,
        consumption: consumption > 0 ? consumption : null,
        is_customer_supplied: Boolean(material.is_customer_supplied)
    };
}

export function openEstimateMaterialPicker(itemKey) {
    if (!state.editor) return;
    if (!findItemByKey(itemKey)) return;

    state.picker = { kind: 'material', itemKey };
    setValue('estimate-material-picker-search', '');

    renderEstimateMaterialPickerList();
    showModal('estimate-material-picker-modal');
}

export function setEstimateMaterialPickerSearch(value) {
    setValue('estimate-material-picker-search', value);
    renderEstimateMaterialPickerList();
}

function renderEstimateMaterialPickerList() {
    const container = el('estimate-material-picker-list');
    if (!container) return;

    const search = (el('estimate-material-picker-search')?.value || '').trim().toLowerCase();
    const materials = (getEstimateCatalog().materials || [])
        .filter(material => !search || material.name.toLowerCase().includes(search));

    if (materials.length === 0) {
        container.innerHTML = `
            <p class="text-xs text-gray-500 p-4 text-center">
                Ничего не найдено. Материалы заполняются в «📚 Справочники → Материалы».
            </p>
        `;
        return;
    }

    container.innerHTML = materials.map(material => `
        <button data-action="chooseEstimateMaterial" data-arg="${material.id}"
                class="w-full text-left px-3 py-2 rounded-lg hover:bg-emerald-50 border border-transparent hover:border-emerald-200 transition">
            <div class="text-sm font-medium text-gray-800">
                ${escapeHtml(material.name)}
                ${material.is_customer_supplied
                    ? '<span class="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold ml-1">заказчика</span>'
                    : ''}
            </div>
            <div class="text-[11px] text-gray-500">
                ${escapeHtml(material.unit)} · закупка ${formatMoney(material.price_purchase)} ·
                кошторис ${formatMoney(material.price_client)}
            </div>
        </button>
    `).join('');
}

export function chooseEstimateMaterial(materialId) {
    if (!state.editor || state.picker?.kind !== 'material') return;

    const material = findEstimateMaterial(materialId);
    const item = findItemByKey(state.picker.itemKey);

    if (!material || !item) {
        toast('Материал или позиция не найдены', 'error');
        return;
    }

    const already = (item.materials || [])
        .some(row => Number(row.material_id) === Number(material.id));

    if (already) {
        toast('Этот материал уже есть в позиции', 'error');
        return;
    }

    item.materials.push(buildMaterialRow(material, 0, item.quantity));

    hideModal('estimate-material-picker-modal');
    state.picker = null;

    renderEstimateSections();
    renderEstimateTotals();
    renderEstimateLimits();
}

/** «💡» — подставить материалы позиции по нормам её работы из справочника. */
export function applyEstimateNormMaterials(itemKey) {
    if (!state.editor) return;

    const item = findItemByKey(itemKey);
    if (!item) return;

    if (!item.work_id) {
        toast('У позиции нет работы из справочника — нормы брать не из чего', 'error');
        return;
    }

    const norms = getWorkMaterialsFor(item.work_id);
    if (norms.length === 0) {
        toast('У работы нет норм расхода. Задайте их в «📚 Справочники → Работы → 📦»', 'error');
        return;
    }

    let added = 0;

    norms.forEach(({ material, consumption }) => {
        const exists = (item.materials || [])
            .some(row => Number(row.material_id) === Number(material.id));
        if (exists) return;

        item.materials.push(buildMaterialRow(material, consumption, item.quantity));
        added += 1;
    });

    renderEstimateSections();
    renderEstimateTotals();
    renderEstimateLimits();

    toast(
        added > 0 ? `Подставлено материалов: ${added}` : 'Все материалы по нормам уже добавлены',
        added > 0 ? 'success' : 'info'
    );
}
