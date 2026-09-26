// =====================================================================
// МОДУЛЬ: СМЕТА — СПРАВОЧНИКИ
// =====================================================================
// Прайс компании: работы и материалы с двумя ценами, их разделы, единицы
// измерения, нормы расхода материалов на работу, клиенты и реквизиты.
//
// Зачем отдельный модуль: справочник нужен сразу нескольким местам — редактору
// сметы (подставить работу/материал в позицию), самому справочнику (правка
// цен) и документам (шапка с реквизитами). Держать это в одном файле со
// сметой значило бы 2000 строк без возможности переиспользовать.
//
// ДАННЫЕ ГРУЗЯТСЯ ОДИН РАЗ в кэш (loadEstimateCatalog) и дальше правятся
// точечно: прайс компании — сотни строк, тянуть их на каждое окно незачем.
// После каждой правки кэш обновляется и вызывается слушатель (onEstimateCatalogChange),
// который перерисовывает и справочник, и открытую смету.
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal, formatMoney, formatNumber
} from '../utils.js';
import { CONFIG } from '../config.js';
import { can, requirePermission } from '../permissions.js';

const MODAL_IDS = {
    catalog: 'estimate-catalog-modal',
    work: 'estimate-work-modal',
    material: 'estimate-material-modal',
    section: 'estimate-section-modal',
    unit: 'estimate-unit-modal',
    client: 'estimate-client-modal',
    company: 'estimate-company-modal',
    workMaterials: 'estimate-work-materials-modal'
};

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

const state = {
    loaded: false,
    activeTab: 'works',        // works | materials | sections | units | clients
    search: '',
    sectionFilter: '',
    works: [],
    materials: [],
    workSections: [],
    materialSections: [],
    units: [],
    workMaterials: [],         // нормы: { id, work_id, material_id, consumption }
    clients: [],
    company: null,
    currentWorkId: null,       // чья норма расхода открыта в окне
    editingId: null            // что правит открытое окно (null — создание)
};

const listeners = [];

/** Подписка на изменения справочника: редактор сметы перерисовывает строки. */
export function onEstimateCatalogChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
}

function notifyChange() {
    listeners.forEach(fn => {
        try {
            fn();
        } catch (error) {
            log.error('Слушатель справочника сметы упал:', error);
        }
    });
}

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

/**
 * Понятная подсказка, если миграция смет ещё не применена: PostgREST отвечает
 * «Could not find the table … in the schema cache» (PGRST205), база — 42P01,
 * а справочник открывают раньше сметы — сотрудник должен увидеть, что делать.
 */
function explainCatalogError(error) {
    const text = String(error?.message || error || '');

    if (/estimate_|PGRST205|42P01/i.test(text)) {
        return 'база не знает таблицы справочников сметы. Выполните '
            + 'database/migrate-v2.10-estimates.sql в Supabase → SQL Editor '
            + '(он создаёт справочники и сметы и закрывает их RLS) и обновите страницу.';
    }

    return db.explainError(error);
}

/**
 * Загружает справочники сметы в кэш.
 * @param {{ force?: boolean }} options — force: перечитать из базы
 */
export async function loadEstimateCatalog({ force = false } = {}) {
    if (state.loaded && !force) return state;

    const [works, materials, workSections, materialSections, units, workMaterials, clients, company] =
        await Promise.all([
            db.select('estimate_works', { orderBy: { column: 'name', asc: true } }),
            db.select('estimate_materials', { orderBy: { column: 'name', asc: true } }),
            db.select('estimate_work_sections', { orderBy: { column: 'order_index', asc: true } }),
            db.select('estimate_material_sections', { orderBy: { column: 'order_index', asc: true } }),
            db.select('estimate_units', { orderBy: { column: 'order_index', asc: true } }),
            db.select('estimate_work_materials'),
            db.select('estimate_clients', { orderBy: { column: 'name', asc: true } }),
            db.select('estimate_company', { filters: { id: 1 }, single: true })
        ]);

    const failure = [works, materials, workSections, materialSections, units, workMaterials, clients]
        .find(result => result.error);

    if (failure) {
        log.error('Ошибка загрузки справочников сметы:', failure.error.message);
        toast('Не удалось загрузить справочники сметы: ' + explainCatalogError(failure.error), 'error');
        return state;
    }

    state.works = works.data || [];
    state.materials = materials.data || [];
    state.workSections = workSections.data || [];
    state.materialSections = materialSections.data || [];
    state.units = units.data || [];
    state.workMaterials = workMaterials.data || [];
    state.clients = clients.data || [];
    state.company = company.data || null;
    state.loaded = true;

    log.info(`Справочник сметы: работ ${state.works.length}, материалов ${state.materials.length}, ` +
        `норм ${state.workMaterials.length}, клиентов ${state.clients.length}`);

    return state;
}

/** Доступ к загруженному справочнику (модуль смет читает его отсюда). */
export function getEstimateCatalog() {
    return state;
}

/** Какая вкладка справочника открыта сейчас. */
export function getCatalogTab() {
    return state.activeTab;
}

/** Единицы измерения: из базы, а при пустом справочнике — из CONFIG. */
export function getEstimateUnits() {
    if (state.units.length > 0) return state.units.map(unit => unit.name);
    return (CONFIG.ESTIMATE?.UNITS || []).map(unit => unit.name);
}

/** Реквизиты своей компании (одна строка) — нужны документам. */
export function getEstimateCompany() {
    return state.company || {};
}

export function findEstimateWork(id) {
    return state.works.find(work => Number(work.id) === Number(id)) || null;
}

export function findEstimateMaterial(id) {
    return state.materials.find(material => Number(material.id) === Number(id)) || null;
}

/** Нормы расхода конкретной работы → материалы справочника с расходом. */
export function getWorkMaterialNorms(workId) {
    return state.workMaterials
        .filter(link => Number(link.work_id) === Number(workId))
        .map(link => ({
            link,
            material: findEstimateMaterial(link.material_id),
            consumption: Number(link.consumption) || 0
        }));
}

/** Нормы конкретной работы для редактора сметы: материал + расход. */
export function getWorkMaterialsFor(workId) {
    return getWorkMaterialNorms(workId).filter(entry => entry.material);
}

// =====================================================================
// ОКНО СПРАВОЧНИКА
// =====================================================================

/** Открывает окно справочника (с загрузкой данных, если кэш пуст). */
export async function openEstimateCatalog(tab = 'works') {
    if (!requirePermission('manage_estimate')) return;

    state.activeTab = tab;
    await loadEstimateCatalog();

    const search = document.getElementById('estimate-catalog-search');
    if (search) search.value = state.search;

    renderEstimateCatalog();
    showModal(MODAL_IDS.catalog);
}

export function setEstimateCatalogTab(tab) {
    state.activeTab = tab;
    state.search = '';
    state.sectionFilter = '';

    const search = document.getElementById('estimate-catalog-search');
    if (search) search.value = '';

    renderEstimateCatalog();
}

export function setEstimateCatalogSearch(value) {
    state.search = String(value || '').trim().toLowerCase();
    renderEstimateCatalog();
}

export function setEstimateCatalogSectionFilter(value) {
    state.sectionFilter = value ? String(value) : '';
    renderEstimateCatalog();
}

/** «➕ Добавить» в шапке окна: открывает окно той вкладки, что открыта. */
export function openEstimateCatalogAdd() {
    if (!requirePermission('manage_estimate')) return;

    const tab = state.activeTab;
    if (tab === 'works') return openEstimateWorkModal();
    if (tab === 'materials') return openEstimateMaterialModal();
    if (tab === 'sections') return openEstimateSectionModal(sectionsKind());
    if (tab === 'units') return openEstimateUnitModal();
    return openEstimateClientModal();
}

/**
 * Раздел работ или материалов правим на вкладке «Разделы»: там есть
 * переключатель вида («Разделы работ» / «Разделы материалов»), и значение
 * читается в момент открытия окна — отдельного состояния не нужно.
 */
function sectionsKind() {
    const select = document.getElementById('estimate-catalog-section-kind');
    return select && select.value === 'material' ? 'material' : 'work';
}

// =====================================================================
// ОТРИСОВКА СПРАВОЧНИКА
// =====================================================================

const TAB_LABELS = {
    works: 'работу',
    materials: 'материал',
    sections: 'раздел',
    units: 'единицу',
    clients: 'клиента'
};

export function renderEstimateCatalog() {
    const container = document.getElementById('estimate-catalog-table');
    if (!container) return;

    // Защита в глубину: справочник открывает то же право, что и весь раздел
    // смет (Администратор, Главный инженер, Инженер ПТО). Данные в базе
    // закрыты тем же правилом (RLS → rsk_is_estimate_editor()).
    if (!can('manage_estimate')) {
        container.innerHTML = emptyRow(
            'Справочник смет доступен Администратору, Главному инженеру и Инженеру ПТО.', 1);
        return;
    }

    const tabs = ['works', 'materials', 'sections', 'units', 'clients'];
    tabs.forEach(tab => {
        const btn = document.getElementById(`estimate-catalog-tab-${tab}`);
        if (!btn) return;
        const active = tab === state.activeTab;
        btn.classList.toggle('bg-[#15803d]', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('bg-gray-100', !active);
        btn.classList.toggle('text-gray-700', !active);
    });

    const addBtn = document.getElementById('estimate-catalog-add-btn');
    if (addBtn) addBtn.textContent = `➕ Добавить ${TAB_LABELS[state.activeTab] || ''}`.trim();

    // Фильтр по разделу — только у работ и материалов; переключатель вида —
    // только на вкладке «Разделы».
    const filterWrap = document.getElementById('estimate-catalog-section-filter-wrap');
    if (filterWrap) {
        filterWrap.classList.toggle('hidden', state.activeTab !== 'works' && state.activeTab !== 'materials');
    }

    const kindWrap = document.getElementById('estimate-catalog-section-kind-wrap');
    if (kindWrap) kindWrap.classList.toggle('hidden', state.activeTab !== 'sections');

    fillCatalogSectionFilter();

    const renderers = {
        works: renderWorksTable,
        materials: renderMaterialsTable,
        sections: renderSectionsTable,
        units: renderUnitsTable,
        clients: renderClientsTable
    };

    container.innerHTML = (renderers[state.activeTab] || renderWorksTable)();
}

/** Фильтр «Раздел»: значения зависят от вкладки (разделы работ/материалов). */
function fillCatalogSectionFilter() {
    const select = document.getElementById('estimate-catalog-section-filter');
    if (!select) return;

    const kind = state.activeTab === 'materials' ? 'material' : 'work';
    const sections = kind === 'material' ? state.materialSections : state.workSections;

    select.innerHTML = '<option value="">Все разделы</option>' + sections
        .map(section => `<option value="${section.id}">${escapeHtml(section.name)}</option>`)
        .join('');

    select.value = state.sectionFilter;
}

/** Отбор по поиску и разделу — общий для работ и материалов. */
function filterItems(items) {
    return items.filter(item => {
        if (state.sectionFilter && Number(item.section_id) !== Number(state.sectionFilter)) return false;
        if (!state.search) return true;

        return String(item.name || '').toLowerCase().includes(state.search);
    });
}

function sectionName(kind, id) {
    if (!id) return '—';

    const list = kind === 'material' ? state.materialSections : state.workSections;
    const section = list.find(item => Number(item.id) === Number(id));
    return section ? section.name : '—';
}

function emptyRow(text, columns) {
    return `<tr><td colspan="${columns}" class="px-3 py-6 text-center text-xs text-gray-500">${escapeHtml(text)}</td></tr>`;
}

/** Кнопки строки справочника: правка и удаление. */
function rowActions(actionEdit, actionDelete, id, extra = '') {
    return `
        <td class="px-3 py-2 text-right whitespace-nowrap">
            ${extra}
            <button data-action="${actionEdit}" data-arg="${id}" data-stop
                    class="text-xs px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold transition"
                    title="Править">✏</button>
            <button data-action="${actionDelete}" data-arg="${id}" data-stop
                    class="text-xs px-2 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-semibold transition"
                    title="Удалить">🗑</button>
        </td>
    `;
}

/** Работы: две цены рядом — сразу видно, где прибыль. */
function renderWorksTable() {
    const works = filterItems(state.works);

    if (works.length === 0) {
        return emptyRow('Работ пока нет. Нажми «➕ Добавить работу» — прайс заполняется один раз и работает во всех сметах.',
            7);
    }

    return `
        <table class="w-full text-xs">
            <thead class="bg-gray-50 text-gray-600">
                <tr>
                    <th class="px-3 py-2 text-left">Название работы</th>
                    <th class="px-3 py-2 text-left w-20">Ед.</th>
                    <th class="px-3 py-2 text-left w-40">Раздел</th>
                    <th class="px-3 py-2 text-right w-24">Наряд</th>
                    <th class="px-3 py-2 text-right w-24">Костор.</th>
                    <th class="px-3 py-2 text-center w-20">Нормы</th>
                    <th class="px-3 py-2 w-24"></th>
                </tr>
            </thead>
            <tbody class="divide-y">
                ${works.map(work => `
                    <tr class="hover:bg-gray-50">
                        <td class="px-3 py-2">
                            <div class="font-medium text-gray-800">${escapeHtml(work.name)}</div>
                            ${work.description ? `<div class="text-[10px] text-gray-500">${escapeHtml(work.description)}</div>` : ''}
                        </td>
                        <td class="px-3 py-2 text-gray-600">${escapeHtml(work.unit)}</td>
                        <td class="px-3 py-2 text-gray-600">${escapeHtml(sectionName('work', work.section_id))}</td>
                        <td class="px-3 py-2 text-right text-gray-700">${formatMoney(work.price_worker)}</td>
                        <td class="px-3 py-2 text-right font-semibold text-[#166534]">${formatMoney(work.price_client)}</td>
                        <td class="px-3 py-2 text-center text-gray-500">${getWorkMaterialNorms(work.id).length}</td>
                        ${rowActions('openEstimateWorkModal', 'deleteEstimateWork', work.id,
                            `<button data-action="openEstimateWorkNorms" data-arg="${work.id}" data-stop
                                     class="text-xs px-2 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 font-semibold transition"
                                     title="Нормы расхода материалов">📦</button>`)}
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

/** Материалы: закупка/кошторис + пометка «давальческий». */
function renderMaterialsTable() {
    const materials = filterItems(state.materials);

    if (materials.length === 0) {
        return emptyRow('Материалов пока нет. Нажми «➕ Добавить материал».', 7);
    }

    return `
        <table class="w-full text-xs">
            <thead class="bg-gray-50 text-gray-600">
                <tr>
                    <th class="px-3 py-2 text-left">Название материала</th>
                    <th class="px-3 py-2 text-left w-20">Ед.</th>
                    <th class="px-3 py-2 text-left w-40">Раздел</th>
                    <th class="px-3 py-2 text-right w-24">Закупка</th>
                    <th class="px-3 py-2 text-right w-24">Костор.</th>
                    <th class="px-3 py-2 text-center w-28">Давальч.</th>
                    <th class="px-3 py-2 w-24"></th>
                </tr>
            </thead>
            <tbody class="divide-y">
                ${materials.map(material => `
                    <tr class="hover:bg-gray-50">
                        <td class="px-3 py-2 font-medium text-gray-800">${escapeHtml(material.name)}</td>
                        <td class="px-3 py-2 text-gray-600">${escapeHtml(material.unit)}</td>
                        <td class="px-3 py-2 text-gray-600">${escapeHtml(sectionName('material', material.section_id))}</td>
                        <td class="px-3 py-2 text-right text-gray-700">${formatMoney(material.price_purchase)}</td>
                        <td class="px-3 py-2 text-right font-semibold text-[#166534]">${formatMoney(material.price_client)}</td>
                        <td class="px-3 py-2 text-center">
                            ${material.is_customer_supplied
                                ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">заказчика</span>'
                                : '<span class="text-[10px] text-gray-400">наш</span>'}
                        </td>
                        ${rowActions('openEstimateMaterialModal', 'deleteEstimateMaterial', material.id)}
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

/**
 * Дерево разделов: родитель, затем его подразделы с отступом.
 * Порядок — как в прайсе: «Покрівля» → «Покрівля скатна» → ...
 */
function sectionTree(kind, parentId = null, level = 0, acc = []) {
    const list = kind === 'material' ? state.materialSections : state.workSections;

    list
        .filter(section => (section.parent_id ?? null) === parentId)
        .forEach(section => {
            acc.push({ section, level });
            sectionTree(kind, section.id, level + 1, acc);
        });

    return acc;
}

/** Разделы: работа и материалы — два независимых дерева. */
function renderSectionsTable() {
    const kind = sectionsKind();
    const tree = sectionTree(kind);

    if (tree.length === 0) {
        return emptyRow('Разделов пока нет. Раздел — это «полка» прайса, например «Покрівля».', 3);
    }

    const kindLabel = kind === 'material' ? 'материалов' : 'работ';

    return `
        <table class="w-full text-xs">
            <thead class="bg-gray-50 text-gray-600">
                <tr>
                    <th class="px-3 py-2 text-left">Раздел ${kindLabel}</th>
                    <th class="px-3 py-2 text-left w-28">Позиций</th>
                    <th class="px-3 py-2 w-24"></th>
                </tr>
            </thead>
            <tbody class="divide-y">
                ${tree.map(({ section, level }) => {
                    const items = kind === 'material'
                        ? state.materials.filter(material => Number(material.section_id) === Number(section.id))
                        : state.works.filter(work => Number(work.section_id) === Number(section.id));

                    return `
                        <tr class="hover:bg-gray-50">
                            <td class="px-3 py-2 text-gray-800" style="padding-left:${12 + level * 20}px">
                                ${level > 0 ? '<span class="text-gray-400">↳ </span>' : ''}${escapeHtml(section.name)}
                            </td>
                            <td class="px-3 py-2 text-gray-500">${items.length}</td>
                            <td class="px-3 py-2 text-right whitespace-nowrap">
                                <button data-action="openEstimateSectionModal" data-arg="edit:${kind}:${section.id}" data-stop
                                        class="text-xs px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold transition"
                                        title="Править">✏</button>
                                <button data-action="deleteEstimateSection" data-arg="del:${kind}:${section.id}" data-stop
                                        class="text-xs px-2 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-semibold transition"
                                        title="Удалить">🗑</button>
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
    `;
}

/** Единицы измерения сметы. */
function renderUnitsTable() {
    if (state.units.length === 0) {
        return emptyRow('Единиц измерения нет. Их список задан в CONFIG.ESTIMATE.UNITS — можно добавить свою.', 3);
    }

    return `
        <table class="w-full text-xs">
            <thead class="bg-gray-50 text-gray-600">
                <tr>
                    <th class="px-3 py-2 text-left w-32">Сокращение</th>
                    <th class="px-3 py-2 text-left">Полное название</th>
                    <th class="px-3 py-2 w-24"></th>
                </tr>
            </thead>
            <tbody class="divide-y">
                ${state.units.map(unit => `
                    <tr class="hover:bg-gray-50">
                        <td class="px-3 py-2 font-semibold text-gray-800">${escapeHtml(unit.name)}</td>
                        <td class="px-3 py-2 text-gray-600">${escapeHtml(unit.full_name || '—')}</td>
                        ${rowActions('openEstimateUnitModal', 'deleteEstimateUnit', unit.id)}
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// =====================================================================
// МАЛЕНЬКИЕ ПОМОЩНИКИ РАБОТЫ С ФОРМОЙ
// =====================================================================

const el = (id) => document.getElementById(id);
const str = (id) => (el(id)?.value || '').trim();
const num = (id) => Number(String(el(id)?.value || '').replace(',', '.')) || 0;

function setValue(id, value) {
    const node = el(id);
    if (node) node.value = value === null || value === undefined ? '' : value;
}

/** Список единиц измерения в select. */
function fillUnitSelect(selectId, value) {
    const select = el(selectId);
    if (!select) return;

    const units = getEstimateUnits();
    const list = units.includes(value) || !value ? units : [...units, value];

    select.innerHTML = list.map(unit => `<option value="${escapeHtml(unit)}">${escapeHtml(unit)}</option>`).join('');
    select.value = value || list[0] || 'шт';
}

/** Список разделов (работ или материалов) в select: плоский, с отступами. */
function fillSectionSelect(selectId, kind, value, excludeId = null) {
    const select = el(selectId);
    if (!select) return;

    const options = sectionTree(kind)
        .filter(({ section }) => Number(section.id) !== Number(excludeId))
        .map(({ section, level }) =>
            `<option value="${section.id}">${'— '.repeat(level)}${escapeHtml(section.name)}</option>`
        )
        .join('');

    select.innerHTML = '<option value="">— Без раздела —</option>' + options;
    select.value = value ? String(value) : '';
}

// =====================================================================
// РАБОТА: ОКНО И СОХРАНЕНИЕ
// =====================================================================

/** Открывает окно работы. Без id — создание, с id — правка. */
export function openEstimateWorkModal(id) {
    if (!requirePermission('manage_estimate')) return;

    const work = id ? findEstimateWork(id) : null;
    if (id && !work) {
        toast('Работа не найдена — обнови справочник', 'error');
        return;
    }

    state.editingId = work ? work.id : null;

    el('estimate-work-modal-title').textContent = work ? '✏ Работа' : '➕ Новая работа';
    setValue('estimate-work-id', work ? work.id : '');
    setValue('estimate-work-name', work ? work.name : '');
    setValue('estimate-work-price-worker', work ? work.price_worker : 0);
    setValue('estimate-work-price-client', work ? work.price_client : 0);
    setValue('estimate-work-description', work ? work.description : '');

    fillUnitSelect('estimate-work-unit', work ? work.unit : 'м²');
    fillSectionSelect('estimate-work-section', 'work', work ? work.section_id : '');

    showModal(MODAL_IDS.work);
}

export async function saveEstimateWork(event) {
    event.preventDefault();
    if (!requirePermission('manage_estimate')) return false;

    const name = str('estimate-work-name');
    if (!name) {
        toast('Впиши название работы', 'error');
        return false;
    }

    const payload = {
        name,
        unit: str('estimate-work-unit') || 'шт',
        section_id: str('estimate-work-section') ? Number(str('estimate-work-section')) : null,
        price_worker: num('estimate-work-price-worker'),
        price_client: num('estimate-work-price-client'),
        description: str('estimate-work-description') || null
    };

    const id = str('estimate-work-id');
    const { error } = id
        ? await db.update('estimate_works', payload, { id: Number(id) })
        : await db.insert('estimate_works', payload);

    if (error) {
        log.error('Ошибка сохранения работы сметы:', error.message);
        toast('Не удалось сохранить работу: ' + db.explainError(error), 'error');
        return false;
    }

    toast(id ? 'Работа обновлена' : `Работа «${name}» добавлена`, 'success');
    hideModal(MODAL_IDS.work);

    await loadEstimateCatalog({ force: true });
    renderEstimateCatalog();
    notifyChange();
    return true;
}

export async function deleteEstimateWork(id) {
    if (!requirePermission('manage_estimate')) return;

    const work = findEstimateWork(id);
    if (!work) return;

    if (!window.confirm(`Удалить работу «${work.name}» из справочника?\n\n` +
        'В уже созданных сметах она останется — там свои названия и цены.')) {
        return;
    }

    const { error } = await db.remove('estimate_works', { id: Number(id) });

    if (error) {
        log.error('Ошибка удаления работы сметы:', error.message);
        toast('Не удалось удалить работу: ' + db.explainError(error), 'error');
        return;
    }

    toast('Работа удалена', 'success');
    await loadEstimateCatalog({ force: true });
    renderEstimateCatalog();
    notifyChange();
}

function renderClientsTable() {
    if (state.clients.length === 0) {
        return emptyRow('Клиентов пока нет. Заказчик попадает в шапку кошториса и наряда.', 5);
    }

    return `
        <table class="w-full text-xs">
            <thead class="bg-gray-50 text-gray-600">
                <tr>
                    <th class="px-3 py-2 text-left">Название / ФИО</th>
                    <th class="px-3 py-2 text-left w-40">Телефон</th>
                    <th class="px-3 py-2 text-left w-48">E-mail</th>
                    <th class="px-3 py-2 text-left">Адрес</th>
                    <th class="px-3 py-2 w-24"></th>
                </tr>
            </thead>
            <tbody class="divide-y">
                ${state.clients.map(client => `
                    <tr class="hover:bg-gray-50">
                        <td class="px-3 py-2 font-medium text-gray-800">${escapeHtml(client.name)}</td>
                        <td class="px-3 py-2 text-gray-600">${escapeHtml(client.phone || '—')}</td>
                        <td class="px-3 py-2 text-gray-600">${escapeHtml(client.email || '—')}</td>
                        <td class="px-3 py-2 text-gray-600">${escapeHtml(client.address || '—')}</td>
                        ${rowActions('openEstimateClientModal', 'deleteEstimateClient', client.id)}
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

// =====================================================================
// МАТЕРИАЛ: ОКНО И СОХРАНЕНИЕ
// =====================================================================

export function openEstimateMaterialModal(id) {
    if (!requirePermission('manage_estimate')) return;

    const material = id ? findEstimateMaterial(id) : null;
    if (id && !material) {
        toast('Материал не найден — обнови справочник', 'error');
        return;
    }

    state.editingId = material ? material.id : null;

    el('estimate-material-modal-title').textContent = material ? '✏ Материал' : '➕ Новый материал';
    setValue('estimate-material-id', material ? material.id : '');
    setValue('estimate-material-name', material ? material.name : '');
    setValue('estimate-material-price-purchase', material ? material.price_purchase : 0);
    setValue('estimate-material-price-client', material ? material.price_client : 0);

    const customerSupplied = el('estimate-material-customer-supplied');
    if (customerSupplied) customerSupplied.checked = Boolean(material?.is_customer_supplied);

    fillUnitSelect('estimate-material-unit', material ? material.unit : 'шт');
    fillSectionSelect('estimate-material-section', 'material', material ? material.section_id : '');

    showModal(MODAL_IDS.material);
}

export async function saveEstimateMaterial(event) {
    event.preventDefault();
    if (!requirePermission('manage_estimate')) return false;

    const name = str('estimate-material-name');
    if (!name) {
        toast('Впиши название материала', 'error');
        return false;
    }

    const isCustomerSupplied = Boolean(el('estimate-material-customer-supplied')?.checked);

    const payload = {
        name,
        unit: str('estimate-material-unit') || 'шт',
        section_id: str('estimate-material-section') ? Number(str('estimate-material-section')) : null,
        price_purchase: num('estimate-material-price-purchase'),
        price_client: num('estimate-material-price-client'),
        is_customer_supplied: isCustomerSupplied
    };

    const id = str('estimate-material-id');
    const { error } = id
        ? await db.update('estimate_materials', payload, { id: Number(id) })
        : await db.insert('estimate_materials', payload);

    if (error) {
        log.error('Ошибка сохранения материала сметы:', error.message);
        toast('Не удалось сохранить материал: ' + db.explainError(error), 'error');
        return false;
    }

    toast(id ? 'Материал обновлён' : `Материал «${name}» добавлен`, 'success');
    hideModal(MODAL_IDS.material);

    await loadEstimateCatalog({ force: true });
    renderEstimateCatalog();
    notifyChange();
    return true;
}

export async function deleteEstimateMaterial(id) {
    if (!requirePermission('manage_estimate')) return;

    const material = findEstimateMaterial(id);
    if (!material) return;

    if (!window.confirm(`Удалить материал «${material.name}» из справочника?\n\n` +
        'В уже созданных сметах он останется — там свои названия и цены. ' +
        'Нормы расхода работ на этот материал будут удалены.')) {
        return;
    }

    const { error } = await db.remove('estimate_materials', { id: Number(id) });

    if (error) {
        log.error('Ошибка удаления материала сметы:', error.message);
        toast('Не удалось удалить материал: ' + db.explainError(error), 'error');
        return;
    }

    toast('Материал удалён', 'success');
    await loadEstimateCatalog({ force: true });
    renderEstimateCatalog();
    notifyChange();
}

// =====================================================================
// НОРМЫ РАСХОДА: СКОЛЬКО МАТЕРИАЛА НУЖНО НА ЕДИНИЦУ РАБОТЫ
// =====================================================================
// Норма нужна, чтобы в смете материалы подставлялись сами: выбрал работу с
// объёмом 100 м² — приложение добавило столько материала, сколько требует
// норма (расход × объём). Считается это в редакторе сметы, здесь — только
// справочник норм.

export function openEstimateWorkNorms(workId) {
    if (!requirePermission('manage_estimate')) return;

    const work = findEstimateWork(workId);
    if (!work) {
        toast('Работа не найдена', 'error');
        return;
    }

    state.currentWorkId = Number(workId);
    setValue('estimate-work-norms-work-id', work.id);

    const title = el('estimate-work-norms-title');
    if (title) title.textContent = `📦 Нормы расхода: ${work.name}`;

    fillNormMaterialSelect();
    setValue('estimate-work-norms-consumption', 1);
    renderEstimateWorkNormsList();

    showModal(MODAL_IDS.workMaterials);
}

/** Материалы, которых ещё нет в нормах этой работы. */
function fillNormMaterialSelect() {
    const select = el('estimate-work-norms-material');
    if (!select) return;

    const linked = new Set(getWorkMaterialNorms(state.currentWorkId).map(entry => Number(entry.link.material_id)));
    const available = state.materials.filter(material => !linked.has(Number(material.id)));

    if (available.length === 0) {
        select.innerHTML = '<option value="">— Все материалы уже добавлены —</option>';
        return;
    }

    select.innerHTML = available
        .map(material => `<option value="${material.id}">${escapeHtml(material.name)} (${escapeHtml(material.unit)})</option>`)
        .join('');
}

export function renderEstimateWorkNormsList() {
    const container = el('estimate-work-norms-list');
    if (!container) return;

    const norms = getWorkMaterialNorms(state.currentWorkId);

    if (norms.length === 0) {
        container.innerHTML = `
            <p class="text-xs text-gray-500 p-3 bg-gray-50 rounded-lg border border-dashed">
                Норм пока нет. Добавь материал и укажи, сколько его нужно на 1 единицу работы.
                Например, «Цемент — 0.02 т на 1 м² стяжки».
            </p>
        `;
        return;
    }

    container.innerHTML = `
        <table class="w-full text-xs">
            <thead class="bg-gray-50 text-gray-600">
                <tr>
                    <th class="px-3 py-2 text-left">Материал</th>
                    <th class="px-3 py-2 text-right w-24">Расход</th>
                    <th class="px-3 py-2 text-left w-16">Ед.</th>
                    <th class="px-3 py-2 w-16"></th>
                </tr>
            </thead>
            <tbody class="divide-y">
                ${norms.map(({ link, material, consumption }) => `
                    <tr>
                        <td class="px-3 py-2 text-gray-800">${escapeHtml(material ? material.name : '— материал удалён —')}</td>
                        <td class="px-3 py-2 text-right">${formatNumber(consumption, 4)}</td>
                        <td class="px-3 py-2 text-gray-500">${escapeHtml(material ? material.unit : '')}</td>
                        <td class="px-3 py-2 text-right">
                            <button data-action="deleteEstimateWorkNorm" data-arg="${link.id}" data-stop
                                    class="text-xs px-2 py-1 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 font-semibold transition"
                                    title="Убрать норму">🗑</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

export async function addEstimateWorkNorm() {
    if (!requirePermission('manage_estimate')) return;

    const materialId = Number(str('estimate-work-norms-material'));
    const consumption = num('estimate-work-norms-consumption');

    if (!materialId) {
        toast('Выбери материал', 'error');
        return;
    }
    if (consumption <= 0) {
        toast('Расход должен быть больше нуля', 'error');
        return;
    }

    const existing = state.workMaterials.find(link =>
        Number(link.work_id) === state.currentWorkId && Number(link.material_id) === materialId);

    const { error } = existing
        ? await db.update('estimate_work_materials', { consumption }, { id: existing.id })
        : await db.insert('estimate_work_materials', {
            work_id: state.currentWorkId,
            material_id: materialId,
            consumption
        });

    if (error) {
        log.error('Ошибка сохранения нормы расхода:', error.message);
        toast('Не удалось сохранить норму: ' + db.explainError(error), 'error');
        return;
    }

    toast('Норма сохранена', 'success');
    await loadEstimateCatalog({ force: true });
    fillNormMaterialSelect();
    renderEstimateWorkNormsList();
    notifyChange();
}

export async function deleteEstimateWorkNorm(linkId) {
    if (!requirePermission('manage_estimate')) return;

    const { error } = await db.remove('estimate_work_materials', { id: Number(linkId) });

    if (error) {
        log.error('Ошибка удаления нормы расхода:', error.message);
        toast('Не удалось удалить норму: ' + db.explainError(error), 'error');
        return;
    }

    await loadEstimateCatalog({ force: true });
    fillNormMaterialSelect();
    renderEstimateWorkNormsList();
    notifyChange();
}

// =====================================================================
// РАЗДЕЛЫ: ОКНО, СОХРАНЕНИЕ, УДАЛЕНИЕ
// =====================================================================
// Разделы работ и материалов живут в разных таблицах, поэтому вид раздела
// («work» / «material») приходит в действии вместе с id: «edit:work:5»,
// «del:material:3». Иначе кнопка удаления не знала бы, какую таблицу чистить.

function parseSectionArg(arg) {
    const parts = String(arg || '').split(':');

    if (parts.length === 3) {
        return {
            mode: parts[0] === 'del' ? 'del' : 'edit',
            kind: parts[1] === 'material' ? 'material' : 'work',
            id: Number(parts[2]) || null
        };
    }

    return { mode: 'create', kind: parts[0] === 'material' ? 'material' : 'work', id: null };
}

function sectionList(kind) {
    return kind === 'material' ? state.materialSections : state.workSections;
}

export function openEstimateSectionModal(arg) {
    if (!requirePermission('manage_estimate')) return;

    const { kind, id } = parseSectionArg(arg);
    const section = id ? sectionList(kind).find(item => Number(item.id) === Number(id)) : null;

    setValue('estimate-section-kind', kind);
    setValue('estimate-section-id', section ? section.id : '');
    setValue('estimate-section-name', section ? section.name : '');
    setValue('estimate-section-order', section ? section.order_index : 0);

    const title = el('estimate-section-modal-title');
    if (title) {
        const label = kind === 'material' ? 'раздел материалов' : 'раздел работ';
        title.textContent = section ? `✏ Раздел: ${section.name}` : `➕ Новый ${label}`;
    }

    fillSectionSelect('estimate-section-parent', kind, section ? section.parent_id : '', section ? section.id : null);

    showModal(MODAL_IDS.section);
}

export async function saveEstimateSection(event) {
    event.preventDefault();
    if (!requirePermission('manage_estimate')) return false;

    const kind = str('estimate-section-kind') === 'material' ? 'material' : 'work';
    const table = kind === 'material' ? 'estimate_material_sections' : 'estimate_work_sections';
    const name = str('estimate-section-name');

    if (!name) {
        toast('Впиши название раздела', 'error');
        return false;
    }

    const payload = {
        name,
        parent_id: str('estimate-section-parent') ? Number(str('estimate-section-parent')) : null,
        order_index: num('estimate-section-order')
    };

    const id = str('estimate-section-id');
    const { error } = id
        ? await db.update(table, payload, { id: Number(id) })
        : await db.insert(table, payload);

    if (error) {
        log.error('Ошибка сохранения раздела сметы:', error.message);
        toast('Не удалось сохранить раздел: ' + db.explainError(error), 'error');
        return false;
    }

    toast(id ? 'Раздел обновлён' : `Раздел «${name}» добавлен`, 'success');
    hideModal(MODAL_IDS.section);

    await loadEstimateCatalog({ force: true });
    renderEstimateCatalog();
    notifyChange();
    return true;
}

export async function deleteEstimateSection(arg) {
    if (!requirePermission('manage_estimate')) return;

    const { kind, id } = parseSectionArg(arg);
    const table = kind === 'material' ? 'estimate_material_sections' : 'estimate_work_sections';
    const section = sectionList(kind).find(item => Number(item.id) === Number(id));

    if (!section) return;

    const used = kind === 'material'
        ? state.materials.filter(material => Number(material.section_id) === Number(id)).length
        : state.works.filter(work => Number(work.section_id) === Number(id)).length;

    const warning = used > 0
        ? `\n\nВ этом разделе ${used} позиц. — они останутся в прайсе, но без раздела.`
        : '';

    if (!window.confirm(`Удалить раздел «${section.name}»?${warning}`)) return;

    const { error } = await db.remove(table, { id: Number(id) });

    if (error) {
        log.error('Ошибка удаления раздела сметы:', error.message);
        toast('Не удалось удалить раздел: ' + db.explainError(error), 'error');
        return;
    }

    toast('Раздел удалён', 'success');
    await loadEstimateCatalog({ force: true });
    renderEstimateCatalog();
    notifyChange();
}

// =====================================================================
// ЕДИНИЦЫ ИЗМЕРЕНИЯ
// =====================================================================

export function openEstimateUnitModal(id) {
    if (!requirePermission('manage_estimate')) return;

    const unit = id ? state.units.find(item => Number(item.id) === Number(id)) : null;

    setValue('estimate-unit-id', unit ? unit.id : '');
    setValue('estimate-unit-name', unit ? unit.name : '');
    setValue('estimate-unit-full-name', unit ? unit.full_name : '');
    setValue('estimate-unit-order', unit ? unit.order_index : 0);

    const title = el('estimate-unit-modal-title');
    if (title) title.textContent = unit ? '✏ Единица измерения' : '➕ Новая единица измерения';

    showModal(MODAL_IDS.unit);
}

export async function saveEstimateUnit(event) {
    event.preventDefault();
    if (!requirePermission('manage_estimate')) return false;

    const name = str('estimate-unit-name');
    if (!name) {
        toast('Впиши сокращение (например, «м²»)', 'error');
        return false;
    }

    const payload = {
        name,
        full_name: str('estimate-unit-full-name') || null,
        order_index: num('estimate-unit-order')
    };

    const id = str('estimate-unit-id');
    const { error } = id
        ? await db.update('estimate_units', payload, { id: Number(id) })
        : await db.insert('estimate_units', payload);

    if (error) {
        log.error('Ошибка сохранения единицы измерения:', error.message);
        toast('Не удалось сохранить единицу: ' + db.explainError(error), 'error');
        return false;
    }

    toast(id ? 'Единица обновлена' : `Единица «${name}» добавлена`, 'success');
    hideModal(MODAL_IDS.unit);

    await loadEstimateCatalog({ force: true });
    renderEstimateCatalog();
    return true;
}

export async function deleteEstimateUnit(id) {
    if (!requirePermission('manage_estimate')) return;

    const unit = state.units.find(item => Number(item.id) === Number(id));
    if (!unit) return;

    if (!window.confirm(`Удалить единицу измерения «${unit.name}»?`)) return;

    const { error } = await db.remove('estimate_units', { id: Number(id) });

    if (error) {
        log.error('Ошибка удаления единицы измерения:', error.message);
        toast('Не удалось удалить единицу: ' + db.explainError(error), 'error');
        return;
    }

    await loadEstimateCatalog({ force: true });
    renderEstimateCatalog();
}

// =====================================================================
// КЛИЕНТЫ
// =====================================================================

export function openEstimateClientModal(id) {
    if (!requirePermission('manage_estimate')) return;

    const client = id ? state.clients.find(item => Number(item.id) === Number(id)) : null;

    setValue('estimate-client-id', client ? client.id : '');
    setValue('estimate-client-name', client ? client.name : '');
    setValue('estimate-client-phone', client ? client.phone : '');
    setValue('estimate-client-email', client ? client.email : '');
    setValue('estimate-client-address', client ? client.address : '');
    setValue('estimate-client-notes', client ? client.notes : '');

    const title = el('estimate-client-modal-title');
    if (title) title.textContent = client ? '✏ Клиент' : '➕ Новый клиент';

    showModal(MODAL_IDS.client);
}

export async function saveEstimateClient(event) {
    event.preventDefault();
    if (!requirePermission('manage_estimate')) return false;

    const name = str('estimate-client-name');
    if (!name) {
        toast('Впиши название или ФИО заказчика', 'error');
        return false;
    }

    const payload = {
        name,
        phone: str('estimate-client-phone') || null,
        email: str('estimate-client-email') || null,
        address: str('estimate-client-address') || null,
        notes: str('estimate-client-notes') || null
    };

    const id = str('estimate-client-id');
    const { error } = id
        ? await db.update('estimate_clients', payload, { id: Number(id) })
        : await db.insert('estimate_clients', payload);

    if (error) {
        log.error('Ошибка сохранения клиента:', error.message);
        toast('Не удалось сохранить клиента: ' + db.explainError(error), 'error');
        return false;
    }

    toast(id ? 'Клиент обновлён' : `Клиент «${name}» добавлен`, 'success');
    hideModal(MODAL_IDS.client);

    await loadEstimateCatalog({ force: true });
    renderEstimateCatalog();
    notifyChange();
    return true;
}

export async function deleteEstimateClient(id) {
    if (!requirePermission('manage_estimate')) return;

    const client = state.clients.find(item => Number(item.id) === Number(id));
    if (!client) return;

    if (!window.confirm(`Удалить клиента «${client.name}»?`)) return;

    const { error } = await db.remove('estimate_clients', { id: Number(id) });

    if (error) {
        log.error('Ошибка удаления клиента:', error.message);
        toast('Не удалось удалить клиента: ' + db.explainError(error), 'error');
        return;
    }

    await loadEstimateCatalog({ force: true });
    renderEstimateCatalog();
    notifyChange();
}

// =====================================================================
// РЕКВИЗИТЫ СВОЕЙ КОМПАНИИ
// =====================================================================
// Одна строка на всю компанию (id = 1): их печатают шапкой кошториса, наряда
// и ведомости материалов, поэтому в каждой смете они не дублируются.

export function openEstimateCompanyModal() {
    if (!requirePermission('manage_estimate')) return;

    const company = getEstimateCompany();

    setValue('estimate-company-name', company.company_name || '');
    setValue('estimate-company-phone', company.phone || '');
    setValue('estimate-company-email', company.email || '');
    setValue('estimate-company-website', company.website || '');
    setValue('estimate-company-address', company.address || '');
    setValue('estimate-company-notes', company.default_notes || '');

    showModal(MODAL_IDS.company);
}

export async function saveEstimateCompany(event) {
    event.preventDefault();
    if (!requirePermission('manage_estimate')) return false;

    const payload = {
        company_name: str('estimate-company-name') || null,
        phone: str('estimate-company-phone') || null,
        email: str('estimate-company-email') || null,
        website: str('estimate-company-website') || null,
        address: str('estimate-company-address') || null,
        default_notes: str('estimate-company-notes') || null,
        updated_at: new Date().toISOString()
    };

    // Строка одна: если её ещё нет — создаём с id = 1 (так требует ограничение
    // таблицы), иначе правим.
    const { error } = state.company
        ? await db.update('estimate_company', payload, { id: 1 })
        : await db.insert('estimate_company', { id: 1, ...payload });

    if (error) {
        log.error('Ошибка сохранения реквизитов компании:', error.message);
        toast('Не удалось сохранить реквизиты: ' + db.explainError(error), 'error');
        return false;
    }

    toast('Реквизиты сохранены', 'success');
    hideModal(MODAL_IDS.company);

    await loadEstimateCatalog({ force: true });
    notifyChange();
    return true;
}

// =====================================================================
// ФУНКЦИИ ДЛЯ РАЗМЕТКИ (data-action)
// =====================================================================

// Функции для разметки (data-action) — как в остальных модулях проекта:
// явное присваивание на window, чтобы прогон
// tools/checks/frontend-check.mjs видел реализацию каждого действия.
// (Список через Object.assign() проверка не разбирает.)
window.openEstimateCatalog = openEstimateCatalog;
window.setEstimateCatalogTab = setEstimateCatalogTab;
window.setEstimateCatalogSearch = setEstimateCatalogSearch;
window.setEstimateCatalogSectionFilter = setEstimateCatalogSectionFilter;
window.openEstimateCatalogAdd = openEstimateCatalogAdd;
window.renderEstimateCatalog = renderEstimateCatalog;
window.openEstimateWorkModal = openEstimateWorkModal;
window.saveEstimateWork = saveEstimateWork;
window.deleteEstimateWork = deleteEstimateWork;
window.openEstimateMaterialModal = openEstimateMaterialModal;
window.saveEstimateMaterial = saveEstimateMaterial;
window.deleteEstimateMaterial = deleteEstimateMaterial;
window.openEstimateWorkNorms = openEstimateWorkNorms;
window.addEstimateWorkNorm = addEstimateWorkNorm;
window.deleteEstimateWorkNorm = deleteEstimateWorkNorm;
window.openEstimateSectionModal = openEstimateSectionModal;
window.saveEstimateSection = saveEstimateSection;
window.deleteEstimateSection = deleteEstimateSection;
window.openEstimateUnitModal = openEstimateUnitModal;
window.saveEstimateUnit = saveEstimateUnit;
window.deleteEstimateUnit = deleteEstimateUnit;
window.openEstimateClientModal = openEstimateClientModal;
window.saveEstimateClient = saveEstimateClient;
window.deleteEstimateClient = deleteEstimateClient;
window.openEstimateCompanyModal = openEstimateCompanyModal;
window.saveEstimateCompany = saveEstimateCompany;
