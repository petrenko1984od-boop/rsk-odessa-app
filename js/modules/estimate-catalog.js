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
    // Выбранная в левой половине окна папка: '' — «Все разделы», id раздела —
    // эта папка вместе с подпапками, '0' — группа «📄 Без раздела».
    sectionFilter: '',
    // Свёрнутые в левой панели ветки (ключи «вид:id», см. collapseKey). Живёт
    // до перезагрузки страницы: окно открывают и закрывают много раз, и
    // заново раскрывать всё дерево каждый раз незачем.
    collapsed: new Set(),
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

    // Вкладки «Разделы» больше нет: если её id пришёл из старого вызова или из
    // ссылки, открываем «Работы» — там те же папки.
    state.activeTab = CATALOG_TABS.includes(tab) ? tab : 'works';
    await loadEstimateCatalog();

    const search = document.getElementById('estimate-catalog-search');
    if (search) search.value = state.search;

    renderEstimateCatalog();
    showModal(MODAL_IDS.catalog);
}

export function setEstimateCatalogTab(tab) {
    state.activeTab = CATALOG_TABS.includes(tab) ? tab : 'works';
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

/**
 * Клик по папке в левой половине окна (или по «Все разделы» / «Без раздела»):
 * справа остаётся эта папка вместе с её подпапками.
 */
export function selectEstimateCatalogSection(value) {
    state.sectionFilter = value === undefined || value === null ? '' : String(value);

    // Папку показываем развёрнутой: иначе после сворачивания ветки выбранную
    // папку не было бы видно, и непонятно, чей прайс справа.
    const id = Number(state.sectionFilter) || 0;
    if (id) {
        sectionChain(catalogKind(), id)
            .forEach(section => state.collapsed.delete(collapseKey(catalogKind(), section.id)));
    }

    renderEstimateCatalog();
}

/** Стрелка у папки: сворачивает и разворачивает её ветку в левой панели. */
export function toggleEstimateCatalogFolder(arg) {
    const parts = String(arg || '').split(':');
    const kind = parts[0] === 'material' ? 'material' : 'work';
    const id = Number(parts[1]) || 0;
    if (!id) return;

    const key = collapseKey(kind, id);
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);

    renderEstimateCatalog();
}

/** «➕ Добавить» в шапке окна: открывает окно той вкладки, что открыта. */
export function openEstimateCatalogAdd() {
    if (!requirePermission('manage_estimate')) return;

    const tab = state.activeTab;
    if (tab === 'works') return openEstimateWorkModal();
    if (tab === 'materials') return openEstimateMaterialModal();
    if (tab === 'units') return openEstimateUnitModal();
    return openEstimateClientModal();
}

// =====================================================================
// ОТРИСОВКА СПРАВОЧНИКА
// =====================================================================

const TAB_LABELS = {
    works: 'работу',
    materials: 'материал',
    units: 'единицу',
    clients: 'клиента'
};

// Вкладки справочника. Отдельной вкладки «Разделы» нет намеренно (v2.11.0):
// прайс заполняется сверху вниз — сначала папка, потом позиция внутри неё.
// Поэтому разделы (папки и подпапки) видны деревом в панели слева, а справа
// идёт прайс выбранной папки (v2.12.0-r7: renderCatalogSections + folderActions)
// — кнопки «📁➕ Подраздел» и «➕ Работа» стоят в полосе над прайсом.
const CATALOG_TABS = ['works', 'materials', 'units', 'clients'];

export function renderEstimateCatalog() {
    const container = document.getElementById('estimate-catalog-table');
    if (!container) return;

    // Защита в глубину: справочник открывает то же право, что и весь раздел
    // смет (Администратор, Главный инженер, Инженер ПТО). Данные в базе
    // закрыты тем же правилом (RLS → rsk_is_estimate_editor()).
    if (!can('manage_estimate')) {
        container.innerHTML = emptyCard('🔒', 'Справочник закрыт для этой должности',
            'Справочник смет доступен Администратору, Главному инженеру и Инженеру ПТО.');
        // Панель папок в этом случае пуста: иначе слева остались бы разделы
        // прошлого открытия, а справа — объяснение, что доступа нет.
        const denied = document.getElementById('estimate-catalog-sections');
        if (denied) {
            denied.innerHTML = '';
            denied.classList.add('hidden');
        }
        return;
    }

    CATALOG_TABS.forEach(tab => {
        const btn = document.getElementById(`estimate-catalog-tab-${tab}`);
        if (!btn) return;
        const active = tab === state.activeTab;

        // Активная вкладка — белая «пилюля» в серой полосе (v2.12.0-r9), счётчик
        // в ней зелёный: видно, какой прайс открыт, даже в оттенках серого.
        btn.classList.toggle('bg-white', active);
        btn.classList.toggle('text-[#166534]', active);
        btn.classList.toggle('shadow-sm', active);
        btn.classList.toggle('text-gray-600', !active);
        btn.classList.toggle('hover:text-gray-800', !active);

        const pill = document.getElementById(`estimate-catalog-tab-${tab}-count`);
        if (pill) {
            pill.classList.toggle('bg-emerald-100', active);
            pill.classList.toggle('text-emerald-800', active);
            pill.classList.toggle('bg-white/70', !active);
            pill.classList.toggle('text-gray-500', !active);
        }
    });

    // «✕» в поле поиска показывается только тогда, когда есть что очищать.
    const searchClear = document.getElementById('estimate-catalog-search-clear');
    if (searchClear) searchClear.classList.toggle('hidden', !state.search);

    const addBtn = document.getElementById('estimate-catalog-add-btn');
    if (addBtn) addBtn.textContent = `➕ Добавить ${TAB_LABELS[state.activeTab] || ''}`.trim();

    // Панель папок и кнопка «📁 Добавить раздел» — только у работ и материалов:
    // у единиц и клиентов разделов нет.
    const withSections = state.activeTab === 'works' || state.activeTab === 'materials';

    // Выбранной папки может уже не быть: её удалили в другой вкладке или на
    // другом устройстве, а id живёт в состоянии между открытиями окна.
    dropStaleSectionFilter(withSections);

    const folderWrap = document.getElementById('estimate-catalog-folder-wrap');
    if (folderWrap) folderWrap.classList.toggle('hidden', !withSections);

    // Левая половина окна — папки прайса. В пустом справочнике панель скрыта:
    // выбирать там нечего, а кнопка «📁 Добавить раздел» и так на виду.
    const aside = document.getElementById('estimate-catalog-sections');
    if (aside) {
        aside.classList.toggle('hidden', !withSections || sectionTree(catalogKind()).length === 0);
    }

    renderCatalogSections();
    renderCatalogPaneHead();

    const renderers = {
        works: renderWorksTable,
        materials: renderMaterialsTable,
        units: renderUnitsTable,
        clients: renderClientsTable
    };

    renderCatalogTabCounts();
    container.innerHTML = (renderers[state.activeTab] || renderWorksTable)();
    renderCatalogPaneFoot();
}

/** Счётчики в пилюлях вкладок: видно, что есть в прайсе, не открывая вкладку. */
function renderCatalogTabCounts() {
    const counts = {
        works: state.works.length,
        materials: state.materials.length,
        units: state.units.length,
        clients: state.clients.length
    };

    CATALOG_TABS.forEach(tab => {
        const node = document.getElementById(`estimate-catalog-tab-${tab}-count`);
        if (node) node.textContent = String(counts[tab] || 0);
    });
}

/** Вид справочника по открытой вкладке: работы или материалы. */
function catalogKind() {
    return state.activeTab === 'materials' ? 'material' : 'work';
}

/** Позиции справочника выбранного вида. */
function catalogItems(kind) {
    return kind === 'material' ? state.materials : state.works;
}

/**
 * Левая половина окна — папки прайса: «Все разделы», дерево разделов и группа
 * «📄 Без раздела». Клик выбирает папку, и справа остаётся только её прайс
 * (см. scopeSectionIds): работы ищут по разделам, а не листая сотни строк.
 *
 * Панель объясняет себя сама (v2.12.0-r9): заголовок «Папки прайса», счётчики
 * позиций у каждой папки, «↳» и имя родителя у повторяющихся имён, а выходы
 * «Все разделы» / «Без раздела» вынесены из прокрутки — новичок открывает окно
 * и сразу видит, где папки, где прайс и что нажимать.
 */
function renderCatalogSections() {
    const aside = document.getElementById('estimate-catalog-sections');
    if (!aside) return;

    // У «Единиц» и «Клиентов» разделов нет — панель пустая и скрытая.
    if (state.activeTab !== 'works' && state.activeTab !== 'materials') {
        aside.innerHTML = '';
        return;
    }

    const kind = catalogKind();
    const all = catalogItems(kind);
    const active = String(state.sectionFilter || '');
    const orphans = all.filter(item => !item.section_id).length;
    const tree = sectionTree(kind);
    const nameHints = getSectionNameHints(tree);
    const rows = [];
    const collapsedLevels = [];         // уровни, внутри которых ветка свёрнута

    // Дерево, а не плоский список: видно, что «Покрівля скатна» — подпапка
    // «Покрівля», поэтому вложенная папка идёт с отступом и направляющей линией.
    tree.forEach(({ section, level }, index) => {
        while (collapsedLevels.length && collapsedLevels[collapsedLevels.length - 1] >= level) {
            collapsedLevels.pop();
        }
        if (collapsedLevels.length) return;         // строка внутри свёрнутой ветки

        const id = Number(section.id);
        // Стрелка — только если под папкой в дереве есть строки (следующая строка
        // дерева на уровень глубже). В данных с петлёй («А внутри Б, Б внутри А»)
        // ребёнок уже показан выше, и стрелка врала бы: сворачивать нечего.
        const hasChildren = index + 1 < tree.length && tree[index + 1].level > level;
        const expanded = hasChildren ? !isCollapsed(kind, id) : undefined;

        rows.push(sectionLink({
            kind,
            value: String(id),
            level,
            active: String(id) === active,
            label: `${level > 0 ? '↳ ' : ''}📁 ${escapeHtml(section.name)}`,
            title: sectionPath(kind, id),
            // Подсказка у папки, чьё имя повторяется в дереве («Земляные работы»
            // внутри «Земляные работы»): без неё две одинаковые строки не отличить
            // — именно на это и жаловались («в справочнике легко запутаться»).
            note: nameHints.get(id) || '',
            // Счётчик — по всей ветке: у папки может быть пусто, а работы лежат
            // в подпапке, и «0» у неё выглядело бы враньём.
            count: branchItems(kind, id).length,
            expanded
        }));

        if (expanded === false) collapsedLevels.push(level);
    });

    // «Все разделы» сверху и «Без раздела» снизу не прокручиваются вместе с
    // деревом: выход к целому прайсу и к позициям без папки всегда под рукой.
    // Заголовок панели называет колонку: новичок не догадывается, что слева
    // именно папки прайса, а не второй список работ.
    aside.innerHTML = `
        <div class="shrink-0 flex items-center justify-between gap-2 px-3 pb-1 pt-2.5">
            <span class="text-[10px] font-bold uppercase tracking-wider text-gray-500">Папки прайса</span>
            <span class="shrink-0 rounded-full bg-white px-1.5 text-[10px] text-gray-400 ring-1 ring-gray-200">Папок: ${tree.length}</span>
        </div>
        <div class="shrink-0 px-1.5 pb-1.5">
            ${sectionLink({
                kind, value: '', level: 0, active: active === '', strong: true,
                label: '📚 Все разделы', title: 'Весь прайс целиком', count: all.length
            })}
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-1.5 pb-1.5 space-y-0.5">${rows.join('')}</div>
        ${orphans > 0 ? `
            <div class="shrink-0 border-t border-gray-200 p-1.5">
                ${sectionLink({
                    kind, value: '0', level: 0, active: active === '0',
                    label: '📄 Без раздела', title: 'Позиции без папки', count: orphans
                })}
            </div>
        ` : '<div class="shrink-0 h-1.5"></div>'}
    `;
}

/** Ключ имени раздела: по нему видно, повторяется ли имя в дереве. */
function sectionNameKey(section) {
    return String(section.name || '').trim().toLowerCase();
}

/**
 * Имена, которые в дереве встречаются больше одного раза. У таких папок в
 * панели показывается родитель — иначе «Земляные работы» и её подпапка
 * «Земляные работы» выглядят двумя одинаковыми строками.
 */
function repeatedNames(tree) {
    const counts = new Map();

    tree.forEach(({ section }) => {
        const key = sectionNameKey(section);
        counts.set(key, (counts.get(key) || 0) + 1);
    });

    return new Set([...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([key]) => key));
}

/**
 * Подсказки к папкам, чьё имя в дереве повторяется: Map(id → «Имя родителя»).
 * Нужны и панели справочника, и дереву окна выбора работы
 * (js/modules/estimates.js): «Земляные работы» внутри «Земляные работы» иначе
 * выглядят двумя одинаковыми строками — с этого и начиналась путаница в
 * справочнике.
 */
export function getSectionNameHints(tree) {
    const repeated = repeatedNames(tree);
    const byId = new Map(tree.map(({ section }) => [Number(section.id), section]));
    const hints = new Map();

    tree.forEach(({ section }) => {
        const id = Number(section.id);
        const parentId = section.parent_id ? Number(section.parent_id) : 0;
        const parent = parentId ? byId.get(parentId) : null;

        if (parent && repeated.has(sectionNameKey(section))) hints.set(id, `«${parent.name}»`);
    });

    return hints;
}

/** Ключ свёрнутой папки: разделы работ и материалов — разные таблицы. */
function collapseKey(kind, id) {
    return `${kind}:${Number(id)}`;
}

/** Свёрнута ли ветка папки в левой панели. */
function isCollapsed(kind, id) {
    return state.collapsed.has(collapseKey(kind, id));
}

/**
 * Раздел и его подпапки ПО ВИДИМОМУ дереву (см. sectionTree): подпапкой
 * считается то, что показано вложенной строкой, а не сырой parent_id. В данных
 * с петлёй («А внутри Б, Б внутри А») счётчик и отбор тогда совпадают с тем,
 * что сотрудник видит слева: у «Петли Б» своей ветки нет, а у «Петли А» — есть.
 */
function branchIds(kind, id) {
    const branch = new Set([Number(id)]);
    let level = -1;

    sectionTree(kind).forEach(({ section, level: current }) => {
        if (Number(section.id) === Number(id)) {
            level = current;
            return;
        }
        if (level < 0) return;
        if (current <= level) { level = -1; return; }     // ветка раздела кончилась

        branch.add(Number(section.id));
    });

    return branch;
}

/** Позиции раздела вместе с его подпапками. */
function branchItems(kind, id) {
    const branch = branchIds(kind, id);
    return catalogItems(kind).filter(item => branch.has(Number(item.section_id)));
}

/**
 * Разделы от корня до указанного: [{ id, name, parent_id }, …].
 * Петля в данных (раздел сам себе родитель) не зацикливает окно: через
 * интерфейс её не создать, но данные приходят не только из него.
 */
function sectionChain(kind, id) {
    const chain = [];
    const seen = new Set();
    let current = Number(id) || 0;

    while (current && !seen.has(current)) {
        seen.add(current);
        const section = sectionList(kind).find(item => Number(item.id) === current);
        if (!section) break;

        chain.unshift(section);
        current = section.parent_id ? Number(section.parent_id) : 0;
    }

    return chain;
}

/** Путь раздела от корня: «Земляные работы › Разработка грунта». */
function sectionPath(kind, id) {
    return sectionChain(kind, id).map(section => section.name).join(' › ');
}

/**
 * Строка левой панели: папка, «📚 Все разделы» или «📄 Без раздела».
 * Клик выбирает папку (справа остаётся только её прайс), стрелка сворачивает
 * ветку. Кнопок правки и удаления здесь нет намеренно: они повторялись у
 * каждой папки и занимали пол-строки — они в полосе над прайсом, у выбранной
 * папки (см. folderActions).
 *
 * Выбранная строка подкрашена (emerald + ring), счётчик — «пилюлей»: глаз
 * находит текущую папку в дереве из десятков строк, не перечитывая названия.
 */
function sectionLink(options) {
    const guides = '<span class="shrink-0 self-stretch w-3.5 border-l border-gray-200"></span>'
        .repeat(options.level);
    const chevron = options.expanded === undefined
        ? '<span class="shrink-0 w-4"></span>'
        : `
            <button data-action="toggleEstimateCatalogFolder" data-arg="${options.kind}:${options.value}" data-stop
                    class="shrink-0 w-4 text-[10px] leading-none text-gray-500 transition hover:text-gray-900"
                    title="${options.expanded ? 'Свернуть раздел' : 'Раскрыть раздел'}">${options.expanded ? '▾' : '▸'}</button>
        `;
    const nameClass = options.active
        ? 'font-semibold text-emerald-900'
        : (options.strong ? 'font-semibold text-gray-800' : 'text-gray-700');

    return `
        <div class="flex items-stretch rounded-lg transition ${options.active
            ? 'bg-emerald-100/70 ring-1 ring-inset ring-emerald-200'
            : 'hover:bg-white'}">
            ${guides}${chevron}
            <button data-action="selectEstimateCatalogSection" data-arg="${options.value}"
                    class="flex-1 min-w-0 py-2 pr-1 text-left" title="${escapeHtml(options.title || '')}">
                <span class="flex min-w-0 items-baseline gap-1">
                    <span class="min-w-0 truncate text-xs ${nameClass}">${options.label}</span>
                    ${options.note ? `<span class="shrink-0 text-[10px] text-gray-400">${escapeHtml(options.note)}</span>` : ''}
                </span>
            </button>
            <span class="shrink-0 self-center mr-1.5 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${options.count
                ? (options.active ? 'bg-white font-semibold text-emerald-800' : 'bg-white/70 text-gray-500')
                : 'text-gray-300'}">${options.count}</span>
        </div>
    `;
}

/**
 * Сброс выбранной папки, если её больше нет в справочнике: иначе правая
 * половина окна осталась бы пустой без объяснения (раздел удалили в другой
 * вкладке, окно закрыли и открыли снова — id при этом сохранился).
 */
function dropStaleSectionFilter(withSections) {
    if (!withSections || !state.sectionFilter) return;

    const id = Number(state.sectionFilter) || 0;
    if (id === 0) return;       // «📄 Без раздела» — не папка, ей теряться незачем

    const exists = sectionList(catalogKind()).some(section => Number(section.id) === id);
    if (!exists) state.sectionFilter = '';
}

/**
 * Разделы правой половины окна: выбранная папка вместе с её подпапками.
 * Ветка берётся по видимому дереву (branchIds) — так отбор и счётчик у папки
 * в левой панели всегда говорят об одном и том же.
 */
function scopeSectionIds(kind) {
    if (!state.sectionFilter) return null;      // «Все разделы» — весь прайс

    const id = Number(state.sectionFilter) || 0;
    return new Set(id ? branchIds(kind, id) : [0]);
}

/**
 * Отбор по выбранной папке и поиску — общий для работ и материалов.
 * Поиск смотрит и на путь папки: сотрудник ищет «Покрівля» и ждёт работы этой
 * папки, а не помнит название каждой из них.
 */
function filterItems(items, scope = null, kind = null) {
    return items.filter(item => {
        const id = item.section_id ? Number(item.section_id) : 0;
        if (scope && !scope.has(id)) return false;
        if (!state.search) return true;

        if (String(item.name || '').toLowerCase().includes(state.search)) return true;

        return kind ? sectionPath(kind, id).toLowerCase().includes(state.search) : false;
    });
}

/**
 * Карточка пустого состояния. Раньше это была строка таблицы с текстом: без
 * обёртки-таблицы браузер выбрасывал `<tr>` и `<td>` (правило разбора HTML —
 * строка таблицы вне таблицы), но и с обёрткой подсказка была просто серым
 * текстом без действия — сотрудник читал «прайс пуст» и не знал, что нажать.
 * Теперь это карточка с иконкой, заголовком, объяснением и КНОПКАМИ (завести
 * папку, добавить позицию, выйти к «Все разделы», очистить поиск).
 */
function emptyCard(icon, title, hint, actions = '') {
    return `
        <div class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <span class="text-3xl">${icon}</span>
            ${title ? `<p class="text-sm font-semibold text-gray-700">${title}</p>` : ''}
            <p class="max-w-lg text-xs text-gray-500">${escapeHtml(hint)}</p>
            ${actions ? `<div class="mt-1 flex flex-wrap items-center justify-center gap-2">${actions}</div>` : ''}
        </div>
    `;
}

/**
 * Пустое состояние прайса: у четырёх ситуаций свой заголовок и свои кнопки.
 * Пустой прайс — завести папку, пустая папка — добавить позицию или выйти к
 * «Все разделы», поиск без результата — очистить запрос.
 */
function catalogEmptyState(kind) {
    const id = Number(state.sectionFilter) || 0;

    if (state.search) {
        return emptyCard('🔍', 'Ничего не найдено', catalogEmptyText(kind), `
            <button data-action="setEstimateCatalogSearch" data-arg=""
                    class="bg-gray-900 hover:bg-gray-800 text-white px-3 py-1.5 rounded-lg text-[11px] font-semibold transition">
                ✕ Очистить поиск</button>
        `);
    }

    const actions = `
        ${id ? '' : `
            <button data-action="addEstimateFolder"
                    class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition">
                📁 Добавить раздел</button>
        `}
        <button data-action="addEstimateCatalogItem" data-arg="${id}"
                class="bg-[#15803d] hover:bg-[#166534] text-white px-3 py-1.5 rounded-lg text-[11px] font-semibold shadow-sm transition">
            ➕ ${itemTitle(kind)}</button>
        ${id ? `
            <button data-action="selectEstimateCatalogSection" data-arg=""
                    class="bg-white ring-1 ring-gray-200 hover:bg-gray-100 text-gray-700 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition">
                📚 Все разделы</button>
        ` : ''}
    `;

    return emptyCard(
        kind === 'material' ? '📦' : '🛠',
        state.sectionFilter ? 'Здесь пока пусто' : '',
        catalogEmptyText(kind),
        actions
    );
}

/** Кнопки строки справочника: правка и удаление. */
function rowActions(actionEdit, actionDelete, id, extra = '') {
    return `
        <td class="px-3 py-1.5 text-right align-top whitespace-nowrap">
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

/** «работу» или «материал» — для подсказок пустого списка. */
function itemWord(kind) {
    return kind === 'material' ? 'материал' : 'работу';
}

/** «Работа» или «Материал» — подпись кнопки добавления. */
function itemTitle(kind) {
    return kind === 'material' ? 'Материал' : 'Работа';
}

/**
 * Подсказка пустого списка. Это четыре разные ситуации, и каждая ведёт к
 * своему действию: пустой прайс — завести папку, пустая папка — добавить
 * позицию или выйти к «Все разделы», «ничего не нашлось» — поправить запрос.
 * Фразы собраны целиком (без вставки слов по частям): их переводит фразовый
 * словарь js/i18n.js, а он ищет фразу целиком в тексте узла.
 */
function catalogEmptyText(kind) {
    const material = kind === 'material';

    if (state.search) {
        return 'Ничего не найдено — проверь название или выбери «📚 Все разделы» слева.';
    }

    if (state.sectionFilter === '0') {
        return material
            ? 'Позиций без раздела нет — новый материал создаётся кнопкой «➕ Материал» сверху.'
            : 'Позиций без раздела нет — новая работа создаётся кнопкой «➕ Работа» сверху.';
    }

    if (state.sectionFilter) {
        return material
            ? 'В этой папке (и её подпапках) материалов нет — добавь кнопкой «➕ Материал» сверху или выбери другую папку слева.'
            : 'В этой папке (и её подпапках) работ нет — добавь кнопкой «➕ Работа» сверху или выбери другую папку слева.';
    }

    return material
        ? 'Прайс пока пуст. Заведи папку («📁 Добавить раздел») и добавь материал кнопкой «➕ Материал» над списком.'
        : 'Прайс пока пуст. Заведи папку («📁 Добавить раздел») и добавь работу кнопкой «➕ Работа» над списком.';
}

/** Работы: две цены рядом — сразу видно, где прибыль. */
function renderWorksTable() {
    return renderCatalogList('work', {
        head: `
            <th class="px-3 py-2 text-left">Название работы</th>
            <th class="px-3 py-2 text-left w-44">Раздел</th>
            <th class="px-3 py-2 text-left w-16">Ед.</th>
            <th class="px-3 py-2 text-right w-24">Наряд</th>
            <th class="px-3 py-2 text-right w-24">Костор.</th>
            <th class="px-3 py-2 text-center w-16">Нормы</th>
            <th class="px-3 py-2 w-28"></th>
        `,
        row: (work) => `
            <tr class="hover:bg-emerald-50/40">
                <td class="px-3 py-2 align-top">
                    <div class="font-medium text-gray-800">${escapeHtml(work.name)}</div>
                    ${work.description ? `<div class="text-[10px] text-gray-500">${escapeHtml(work.description)}</div>` : ''}
                </td>
                ${sectionCell('work', work.section_id)}
                <td class="px-3 py-2 align-top">
                    <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">${escapeHtml(work.unit)}</span>
                </td>
                <td class="px-3 py-2 text-right align-top tabular-nums text-gray-700">${formatMoney(work.price_worker)}</td>
                <td class="px-3 py-2 text-right align-top tabular-nums font-semibold text-[#166534]">${formatMoney(work.price_client)}</td>
                <td class="px-3 py-2 text-center align-top">${normsBadge(work.id)}</td>
                ${rowActions('openEstimateWorkModal', 'deleteEstimateWork', work.id, normsButton(work.id))}
            </tr>
        `
    });
}

/**
 * Сколько материалов привязано к работе: «0» серым (искать нечего), число —
 * жёлтой пилюлей, как и кнопка «📦» рядом: видно, у каких работ материалы
 * подставятся в смету сами.
 */
function normsBadge(workId) {
    const count = getWorkMaterialNorms(workId).length;

    return count
        ? `<span class="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">${count}</span>`
        : '<span class="text-[10px] text-gray-300">0</span>';
}

/** «📦» — окно норм расхода материалов работы (сколько материала на 1 ед.). */
function normsButton(workId) {
    return `
        <button data-action="openEstimateWorkNorms" data-arg="${workId}" data-stop
                class="text-xs px-2 py-1 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 font-semibold transition"
                title="Нормы расхода материалов">📦</button>
    `;
}

/** Материалы: закупка/кошторис + пометка «давальческий». */
function renderMaterialsTable() {
    return renderCatalogList('material', {
        head: `
            <th class="px-3 py-2 text-left">Название материала</th>
            <th class="px-3 py-2 text-left w-44">Раздел</th>
            <th class="px-3 py-2 text-left w-16">Ед.</th>
            <th class="px-3 py-2 text-right w-24">Закупка</th>
            <th class="px-3 py-2 text-right w-24">Костор.</th>
            <th class="px-3 py-2 text-center w-20">Давальч.</th>
            <th class="px-3 py-2 w-28"></th>
        `,
        row: (material) => `
            <tr class="hover:bg-emerald-50/40">
                <td class="px-3 py-2 align-top font-medium text-gray-800">${escapeHtml(material.name)}</td>
                ${sectionCell('material', material.section_id)}
                <td class="px-3 py-2 align-top">
                    <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">${escapeHtml(material.unit)}</span>
                </td>
                <td class="px-3 py-2 text-right align-top tabular-nums text-gray-700">${formatMoney(material.price_purchase)}</td>
                <td class="px-3 py-2 text-right align-top tabular-nums font-semibold text-[#166534]">${formatMoney(material.price_client)}</td>
                <td class="px-3 py-2 text-center align-top">
                    ${material.is_customer_supplied
                        ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">заказчика</span>'
                        : '<span class="text-[10px] text-gray-400">наш</span>'}
                </td>
                ${rowActions('openEstimateMaterialModal', 'deleteEstimateMaterial', material.id)}
            </tr>
        `
    });
}

// =====================================================================
// ПРАВАЯ ПОЛОВИНА ОКНА: ПОЛОСА НАД ПРАЙСОМ
// =====================================================================
// Здесь видно, чей прайс показан («📚 Все разделы» или путь до выбранной
// папки), сколько в нём позиций и что можно сделать с этой папкой. Раньше эти
// кнопки стояли у каждой папки прямо в таблице: одна и та же папка была видна
// и слева, и справа, а ряд кнопок повторялся в каждой строке.

/** Полоса над таблицей: где мы находимся и что можно сделать с папкой. */
function renderCatalogPaneHead() {
    const head = document.getElementById('estimate-catalog-pane-head');
    if (!head) return;

    // У «Единиц» и «Клиентов» папок нет — полоса не нужна.
    if (state.activeTab !== 'works' && state.activeTab !== 'materials') {
        head.innerHTML = '';
        head.classList.add('hidden');
        return;
    }

    head.classList.remove('hidden');

    const kind = catalogKind();
    const value = String(state.sectionFilter || '');
    const shown = filterItems(catalogItems(kind), scopeSectionIds(kind), kind).length;
    // Счётчик — зелёной «пилюлей»: это число позиций в показанном прайсе,
    // по нему сразу видно, попал ли в выборку нужный раздел.
    const counter = `<span class="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">${shown} ${itemsWord(shown)}</span>`;

    if (!value) {
        head.innerHTML = `
            <div class="flex min-w-0 items-center gap-2">
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-xs">📚</span>
                <span class="shrink-0 text-xs font-semibold text-gray-700">Все разделы</span>
                ${counter}
            </div>
            <p class="ml-auto hidden shrink-0 text-[11px] text-gray-400 xl:block">
                Выбери папку слева — останется только её прайс
            </p>
        `;
        return;
    }

    const id = Number(value) || 0;
    const crumbs = id
        ? sectionChain(kind, id).map(section => crumbHtml(kind, section))
            .join('<span class="shrink-0 px-0.5 text-gray-300">›</span>')
        : '<span class="shrink-0 text-xs font-semibold text-gray-700">📄 Без раздела</span>';

    head.innerHTML = `
        <div class="flex min-w-0 items-center gap-1.5">
            ${crumbs}
            ${counter}
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-1.5">${folderActions(kind, id)}</div>
    `;
}

/** Звено пути раздела: по родителю можно кликнуть, последний — подпись. */
function crumbHtml(kind, section) {
    const name = escapeHtml(section.name);
    const path = escapeHtml(sectionPath(kind, section.id));

    if (String(section.id) === String(state.sectionFilter)) {
        return `<span class="min-w-0 max-w-[16rem] truncate text-xs font-semibold text-gray-800"
                      title="${path}">${name}</span>`;
    }

    return `
        <button data-action="selectEstimateCatalogSection" data-arg="${section.id}"
                class="min-w-0 max-w-[10rem] truncate text-xs text-gray-500 transition hover:text-gray-800 hover:underline"
                title="${path}">${name}</button>
    `;
}

/**
 * Кнопки выбранной папки: подпапка внутри, позиция внутри, переименовать,
 * удалить. Позиция создаётся СРАЗУ в этой папке — окно откроется с уже
 * выбранным разделом, поэтому прайс заполняется сверху вниз, от папки к работе.
 * Кнопки «папки» стоят вместе, «служебные» ✏/🗑 — отдельно: новичок жмёт
 * зелёную кнопку и не боится задеть удаление раздела.
 */
function folderActions(kind, id) {
    const addItem = `
        <button data-action="addEstimateCatalogItem" data-arg="${id}"
                class="bg-[#15803d] hover:bg-[#166534] text-white px-2.5 py-1 rounded-lg text-[11px] font-semibold shadow-sm transition"
                title="Добавить ${itemWord(kind)} в этот раздел">➕ ${itemTitle(kind)}</button>
    `;

    // «📄 Без раздела» — не папка: её нельзя переименовать или удалить.
    if (!id) return addItem;

    return `
        <div class="flex items-center gap-1 rounded-lg bg-gray-100 p-0.5">
            <button data-action="addEstimateSubsection" data-arg="${kind}:${id}"
                    class="bg-white hover:bg-emerald-50 text-emerald-800 px-2 py-1 rounded-md text-[11px] font-semibold shadow-sm transition"
                    title="Создать папку внутри">📁➕ Подраздел</button>
            ${addItem}
        </div>
        <button data-action="openEstimateSectionModal" data-arg="edit:${kind}:${id}"
                class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-1 rounded-lg text-[11px] font-semibold transition"
                title="Переименовать раздел">✏</button>
        <button data-action="deleteEstimateSection" data-arg="del:${kind}:${id}"
                class="bg-red-50 hover:bg-red-100 text-red-700 px-2 py-1 rounded-lg text-[11px] font-semibold transition"
                title="Удалить раздел">🗑</button>
    `;
}

/**
 * Полоса под таблицей: сколько строк показано и на какую сумму. Раньше тут
 * стояло просто «Итого» — внутри папки непонятно, итого по чему. Теперь полоса
 * называет охват («по всему прайсу» или «в папке «Покрівля»»).
 */
function renderCatalogPaneFoot() {
    const foot = document.getElementById('estimate-catalog-pane-foot');
    if (!foot) return;

    const search = state.search ? `🔍 «${escapeHtml(state.search)}» · ` : '';

    if (state.activeTab === 'units' || state.activeTab === 'clients') {
        const units = state.activeTab === 'units';
        foot.innerHTML = `${search}${units ? 'Единиц' : 'Клиентов'}: `
            + `${(units ? state.units : state.clients).length}`;
        return;
    }

    const kind = catalogKind();
    const items = filterItems(catalogItems(kind), scopeSectionIds(kind), kind);
    const sum = (field) => formatMoney(items.reduce((acc, item) => acc + (Number(item[field]) || 0), 0));
    const prices = kind === 'material'
        ? `закупка ${sum('price_purchase')} · костор. ${sum('price_client')}`
        : `наряд ${sum('price_worker')} · костор. ${sum('price_client')}`;

    foot.innerHTML = `${search}${catalogScopeText(kind)}: ${items.length} ${itemsWord(items.length)} · ${prices}`;
}

/** Охват полосы итогов: весь прайс, папка или позиции без раздела. */
function catalogScopeText(kind) {
    const id = Number(state.sectionFilter) || 0;

    if (!id) return state.sectionFilter === '0' ? 'Итого без раздела' : 'Итого по всему прайсу';

    const name = (sectionList(kind).find(section => Number(section.id) === id) || {}).name;
    return name ? `Итого в папке «${name}»` : 'Итого по всему прайсу';
}

/** Склонение слова «позиция» для подписи у папки. */
function itemsWord(count) {
    const tail = count % 10;
    if (tail === 1 && count % 100 !== 11) return 'позиция';
    if (tail >= 2 && tail <= 4 && (count % 100 < 12 || count % 100 > 14)) return 'позиции';
    return 'позиций';
}

/**
 * Ячейка «Раздел»: папка позиции «пилюлей», полный путь — в подсказке.
 * Внутри выбранной папки показывается только ПОДпапка позиции
 * (relativeSectionPath): повторять в каждой строке имя папки, которая и так
 * открыта слева, — это тот шум, из-за которого прайс читался тяжело.
 */
function sectionCell(kind, sectionId) {
    if (!sectionId) {
        return `<td class="px-3 py-2 align-top">
            <span class="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-400">без раздела</span>
        </td>`;
    }

    const known = sectionPath(kind, sectionId);
    const text = known || 'раздел не найден';

    return `
        <td class="px-3 py-2 align-top">
            <span class="inline-flex max-w-[11rem] items-center gap-1 rounded-full bg-gray-50 px-2 py-0.5 text-[10px] text-gray-600 ring-1 ring-gray-200"
                  title="${escapeHtml(text)}">
                <span>📁</span>
                <span class="truncate">${escapeHtml(relativeSectionPath(kind, sectionId))}</span>
            </span>
        </td>
    `;
}

/** Путь раздела без выбранной папки: остаётся только подпапка позиции. */
function relativeSectionPath(kind, sectionId) {
    const chain = sectionChain(kind, sectionId);
    const id = Number(state.sectionFilter) || 0;
    const at = id ? chain.findIndex(section => Number(section.id) === id) : -1;

    if (at >= 0 && at < chain.length - 1) {
        return chain.slice(at + 1).map(section => section.name).join(' › ');
    }

    return chain.map(section => section.name).join(' › ');
}

/**
 * Порядок папок как в дереве слева: позиции идут за своей папкой, поэтому
 * список читается сверху вниз так же, как дерево.
 */
function sectionOrder(kind) {
    const order = new Map();
    sectionTree(kind).forEach(({ section }, index) => order.set(Number(section.id), index));
    return order;
}

/**
 * Плоская таблица прайса: позиции выбранной папки вместе с её подпапками.
 *
 * Дерева в правой половине нет намеренно: папки не должны быть видны дважды —
 * слева навигация, справа прайс. Откуда позиция, видно по колонке «Раздел»
 * (полный путь в подсказке), а порядок строк — как в дереве слева: позиции
 * идут за своей папкой, позиции без папки — в конце списка.
 *
 * В «Все разделы» видны ВСЕ позиции прайса, чем бы ни была заполнена их
 * папка: спрятать строку из-за незнакомого section_id окно не может.
 */
function renderCatalogList(kind, options) {
    const scope = scopeSectionIds(kind);
    const order = sectionOrder(kind);
    const rank = (item) => {
        const id = item.section_id ? Number(item.section_id) : 0;
        const at = order.get(id);
        return typeof at === 'number' ? at : order.size + 1;   // без папки или папка не найдена
    };

    const rows = filterItems(catalogItems(kind), scope, kind)
        .slice()
        .sort((a, b) => rank(a) - rank(b))
        .map(options.row);

    if (rows.length === 0) return catalogEmptyState(kind);

    return `
        <table class="w-full text-xs">
            <thead class="sticky top-0 z-10 border-b border-gray-200 bg-gray-50 text-gray-600">
                <tr>${options.head}</tr>
            </thead>
            <tbody class="divide-y divide-gray-100">${rows.join('')}</tbody>
        </table>
    `;
}

/**
 * Дерево разделов: родитель, затем его подразделы с отступом.
 * Порядок — как в прайсе: «Покрівля» → «Покрівля скатна» → ...
 */
/**
 * Дерево разделов: родитель, затем его подразделы с отступом.
 * Порядок — как в прайсе: «Покрівля» → «Покрівля скатна» → ...
 *
 * Корнем считается и раздел, чьего родителя в списке нет: данные приходят не
 * только из интерфейса. Раздел, до которого обход не дошёл (в данных петля:
 * «А внутри Б, Б внутри А»), тоже показывается корнем — иначе он вместе со
 * своими позициями исчез бы из окна молча, а счётчики не сошлись бы.
 */
function sectionTree(kind) {
    const list = sectionList(kind);
    const known = new Set(list.map(section => Number(section.id)));
    const acc = [];
    const seen = new Set();

    const walk = (parentId, level) => {
        list
            .filter(section => {
                const parent = section.parent_id ? Number(section.parent_id) : 0;
                return parentId ? parent === parentId : (!parent || !known.has(parent));
            })
            .forEach(section => {
                const id = Number(section.id);
                if (seen.has(id)) return;
                seen.add(id);

                acc.push({ section, level });
                walk(id, level + 1);
            });
    };

    walk(0, 0);

    list.forEach(section => {
        const id = Number(section.id);
        if (seen.has(id)) return;

        seen.add(id);
        acc.push({ section, level: 0 });
        walk(id, 1);
    });

    return acc;
}

/**
 * Разделы работ деревом: [{ section, level }] — папка, затем её подпапки.
 * Тем же списком показывает разделы окно «➕ Работа из справочника»
 * (js/modules/estimates.js): дерево строится здесь, поэтому окно выбора работы
 * и сам справочник не разойдутся.
 */
export function getEstimateWorkSectionTree() {
    return sectionTree('work');
}

/** Единицы измерения сметы. */
function renderUnitsTable() {
    if (state.units.length === 0) {
        return emptyCard('📏', 'Единиц измерения нет',
            'Список задан в CONFIG.ESTIMATE.UNITS — можно добавить свою единицу.');
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

    // Из списка убираем сам раздел и все его подпапки: выбрать их родителем
    // значило бы замкнуть дерево само на себя.
    const excluded = excludeId ? sectionAndDescendants(kind, excludeId) : [];

    const options = sectionTree(kind)
        .filter(({ section }) => !excluded.includes(Number(section.id)))
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
export function openEstimateWorkModal(id, sectionId) {
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
    // sectionId приходит от кнопки «➕» у папки: новая работа сразу попадает в
    // тот раздел, у которого её нажали (и в раздел, и в подпапку).
    fillSectionSelect('estimate-work-section', 'work',
        work ? work.section_id : (Number(sectionId) || ''));

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
        return emptyCard('👥', 'Клиентов пока нет',
            'Заказчик попадает в шапку кошториса и наряда — добавь первого кнопкой сверху.');
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

export function openEstimateMaterialModal(id, sectionId) {
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
    // sectionId — от кнопки «➕» у папки: материал попадает в свой раздел.
    fillSectionSelect('estimate-material-section', 'material',
        material ? material.section_id : (Number(sectionId) || ''));

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
//
// ПАПКИ И ПОДПАПКИ — это одно и то же дерево: у раздела есть parent_id, поэтому
// «папка» — раздел без родителя, а «подпапка» — раздел внутри раздела.
// Вложенность любая, ограничений в базе нет (estimate_work_sections.parent_id
// ссылается на саму таблицу, см. database/migrate-v2.10-estimates.sql).

function parseSectionArg(arg) {
    const parts = String(arg || '').split(':');

    // «folder:work» — новая папка, «sub:work:5» — подпапка в разделе 5.
    if (parts[0] === 'folder' || parts[0] === 'sub') {
        return {
            mode: parts[0],
            kind: parts[1] === 'material' ? 'material' : 'work',
            id: Number(parts[2]) || null
        };
    }

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

/** Раздел и все его подпапки: их нельзя выбрать родителем — вышел бы цикл. */
function sectionAndDescendants(kind, id) {
    const ids = [];
    const seen = new Set();

    const walk = (parentId) => {
        sectionList(kind)
            .filter(item => (item.parent_id ? Number(item.parent_id) : 0) === parentId)
            .forEach(item => {
                const childId = Number(item.id);
                // Петля в данных («А внутри Б, Б внутри А») не зацикливает окно.
                if (seen.has(childId)) return;
                seen.add(childId);

                ids.push(childId);
                walk(childId);
            });
    };

    if (id) {
        ids.push(Number(id));
        seen.add(Number(id));
        walk(Number(id));
    }

    return ids;
}

/** Подпись окна раздела: создание, правка, новая папка или подпапка. */
function sectionTitle(mode, kind, section) {
    const label = kind === 'material' ? 'раздел материалов' : 'раздел работ';

    if (mode === 'edit' && section) return `✏ Раздел: ${section.name}`;
    if (mode === 'sub' && section) return `📁 Подпапка в «${section.name}»`;
    if (mode === 'folder') return '📁 Новая папка';
    return `➕ Новый ${label}`;
}

/** «📁 Добавить раздел»: раздел верхнего уровня (parent_id пустой). */
export function addEstimateFolder() {
    if (!requirePermission('manage_estimate')) return;
    openEstimateSectionModal(`folder:${catalogKind()}`);
}

/**
 * «➕» у раздела: новая работа или материал СРАЗУ в этом разделе (в том числе в
 * подпапке). Вид берётся с открытой вкладки, поэтому одна кнопка обслуживает и
 * работы, и материалы; без аргумента позиция создаётся без раздела.
 */
export function addEstimateCatalogItem(sectionId) {
    if (!requirePermission('manage_estimate')) return;

    const id = Number(sectionId) || null;

    if (catalogKind() === 'material') return openEstimateMaterialModal(null, id);
    return openEstimateWorkModal(null, id);
}

/** «➕ Подпапка» у строки: раздел внутри выбранного (arg = «work:5»). */
export function addEstimateSubsection(arg) {
    if (!requirePermission('manage_estimate')) return;

    const parts = String(arg || '').split(':');
    const kind = parts[0] === 'material' ? 'material' : 'work';
    const parentId = Number(parts[1]) || null;
    if (!parentId) return;

    openEstimateSectionModal(`sub:${kind}:${parentId}`);
}

export function openEstimateSectionModal(arg) {
    if (!requirePermission('manage_estimate')) return;

    const { mode, kind, id } = parseSectionArg(arg);
    const section = id ? sectionList(kind).find(item => Number(item.id) === Number(id)) : null;
    const isEditing = mode === 'edit' && Boolean(section);

    setValue('estimate-section-kind', kind);
    setValue('estimate-section-id', isEditing ? section.id : '');
    setValue('estimate-section-name', isEditing ? section.name : '');
    setValue('estimate-section-order', isEditing ? section.order_index : 0);

    const title = el('estimate-section-modal-title');
    if (title) title.textContent = sectionTitle(mode, kind, section);

    // Подпапка создаётся сразу внутри выбранного раздела — родитель уже стоит.
    const parentValue = mode === 'sub' && section
        ? section.id
        : (isEditing ? section.parent_id : '');

    fillSectionSelect('estimate-section-parent', kind, parentValue, isEditing ? section.id : null);

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

    toast(id
        ? 'Раздел обновлён'
        : (payload.parent_id
            ? `Подпапка добавлена: «${name}»`
            : `Папка добавлена: «${name}»`), 'success');
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
window.selectEstimateCatalogSection = selectEstimateCatalogSection;
window.toggleEstimateCatalogFolder = toggleEstimateCatalogFolder;
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
window.addEstimateFolder = addEstimateFolder;
window.addEstimateCatalogItem = addEstimateCatalogItem;
window.addEstimateSubsection = addEstimateSubsection;
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
