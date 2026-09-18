// =====================================================================
// МОДУЛЬ: РАЗДЕЛЫ ОБЪЕКТА (общие помощники)
// =====================================================================
// Раздел `sections` одновременно играет две роли:
//   1) строка сметы (план из Excel) — обновляется при каждой загрузке файла;
//   2) ось, к которой привязывается факт (расходы, заявки, задачи).
//
// Работы и материалы, которых НЕТ в смете, тоже нужно к чему-то привязать,
// иначе рвётся учёт: сотрудник потратил деньги, а расход негде показать.
// Для этого в каждом объекте есть ОДИН служебный раздел «Доп. расходы»
// (CONFIG.EXTRA_SECTION.NAME):
//   - создаётся лениво, при первом обращении к списку разделов (форма заказа,
//     финансового запроса, авансового отчёта, подвкладка «Доп. расходы»);
//   - никогда не перезаписывается сметой и не удаляется вместе с ней;
//   - НЕ попадает в план-факт и в график (см. js/modules/estimate.js,
//     js/modules/gantt.js, js/modules/dashboard.js);
//   - в выпадающих списках идёт отдельной группой, чтобы сотрудник видел:
//     это не раздел сметы, а «вне сметы».
//
// Файл намеренно не импортирует другие модули (только db/config/utils),
// чтобы его могли использовать и cash.js, и estimate.js без циклов.
// =====================================================================

import { db } from '../database.js';
import { CONFIG } from '../config.js';
import { log, escapeHtml, isExtraSectionName } from '../utils.js';

const EXTRA_SECTION_NAME = CONFIG.EXTRA_SECTION?.NAME || 'Доп. расходы';
const EXTRA_OPTION_LABEL = CONFIG.EXTRA_SECTION?.OPTION_LABEL || `⚠ ${EXTRA_SECTION_NAME} (вне сметы)`;

const NO_PROJECT_OPTION = '<option value="">Сначала выбери объект</option>';
const ERROR_OPTION = '<option value="">Ошибка загрузки разделов</option>';

export { isExtraSectionName, EXTRA_SECTION_NAME };

// =====================================================================
// РАЗДЕЛЕНИЕ СПИСКА
// =====================================================================

/**
 * Делит разделы объекта на «сметные» и служебный «Доп. расходы».
 * @param {Array<Object>} sections — строки таблицы sections
 * @returns {{ estimateSections: Array<Object>, extraSection: Object|null }}
 */
export function splitSections(sections) {
    const estimateSections = [];
    let extraSection = null;

    (sections || []).forEach(section => {
        if (isExtraSectionName(section.name)) {
            if (!extraSection) extraSection = section;
            return;
        }
        estimateSections.push(section);
    });

    return { estimateSections, extraSection };
}

// =====================================================================
// ЗАГРУЗКА РАЗДЕЛОВ ДЛЯ ВЫПАДАЮЩИХ СПИСКОВ
// =====================================================================

/**
 * Загружает разделы объекта и гарантирует, что служебный раздел «Доп. расходы»
 * существует (создаётся один раз, если его нет).
 *
 * @param {number} projectId
 * @returns {Promise<{ estimateSections: Array<Object>, extraSection: Object|null, error }>}
 */
export async function loadSectionsWithExtra(projectId) {
    if (!projectId) return { estimateSections: [], extraSection: null, error: null };

    const { data, error } = await db.select('sections', {
        filters: { project_id: projectId },
        orderBy: { column: 'id', asc: true }
    });

    if (error) {
        log.error('Ошибка загрузки разделов:', error.message);
        return { estimateSections: [], extraSection: null, error };
    }

    const { estimateSections, extraSection } = splitSections(data);

    if (extraSection) {
        return { estimateSections, extraSection, error: null };
    }

    // Раздела ещё нет (новый объект или объект без сметы) — создаём.
    // План нулевой: на план-факт сметы это не влияет.
    const { data: created, error: insertError } = await db.insert('sections', {
        project_id: projectId,
        name: EXTRA_SECTION_NAME,
        plan_works: 0,
        plan_materials: 0,
        plan_total: 0
    });

    if (insertError) {
        log.error(`Не удалось создать раздел «${EXTRA_SECTION_NAME}»:`, insertError.message);
        return { estimateSections, extraSection: null, error: insertError };
    }

    log.info(`Создан служебный раздел «${EXTRA_SECTION_NAME}» для объекта #${projectId}`);

    return { estimateSections, extraSection: created, error: null };
}

/**
 * Универсальная перерисовка селекта «Раздел» по выбранному объекту.
 * Используется формами заказа материалов, финансового запроса и расхода.
 *
 * @param {HTMLSelectElement|null} select
 * @param {number} projectId
 * @returns {Promise<{ estimateSections: Array<Object>, extraSection: Object|null, error }>}
 */
export async function fillSectionsSelect(select, projectId) {
    if (!select) return { estimateSections: [], extraSection: null, error: null };

    if (!projectId) {
        select.innerHTML = NO_PROJECT_OPTION;
        return { estimateSections: [], extraSection: null, error: null };
    }

    const { estimateSections, extraSection, error } = await loadSectionsWithExtra(projectId);

    if (error) {
        select.innerHTML = ERROR_OPTION;
        return { estimateSections: [], extraSection: null, error };
    }

    select.innerHTML = buildSectionOptionsHtml(estimateSections, extraSection);

    return { estimateSections, extraSection, error: null };
}

// =====================================================================
// HTML ВЫПАДАЮЩЕГО СПИСКА РАЗДЕЛОВ
// =====================================================================

/**
 * Собирает <option>/<optgroup> для селекта «Раздел».
 * Сметные разделы идут группой «📊 Разделы сметы», служебный — отдельной
 * группой «⚠ Вне сметы» и янтарным цветом, чтобы его нельзя было
 * перепутать с разделами из сметы.
 *
 * @param {Array<Object>} estimateSections
 * @param {Object|null} extraSection
 * @param {{ placeholder?: string, allowEmpty?: boolean }} options
 * @returns {string} — готовый innerHTML селекта
 */
export function buildSectionOptionsHtml(estimateSections, extraSection, options = {}) {
    const { placeholder = '— Выбери раздел —', allowEmpty = true } = options;

    const estimateOptions = (estimateSections || [])
        .map(section => `<option value="${section.id}">${escapeHtml(section.name)}</option>`)
        .join('');

    const estimateGroup = estimateOptions
        ? `<optgroup label="📊 Разделы сметы">${estimateOptions}</optgroup>`
        : '';

    const extraGroup = extraSection
        ? `<optgroup label="⚠ Вне сметы — этих работ и материалов нет в смете">` +
          `<option value="${extraSection.id}" data-extra-section="1" ` +
          `style="color:#b45309;font-weight:700">${escapeHtml(EXTRA_OPTION_LABEL)}</option>` +
          `</optgroup>`
        : '';

    const emptyOption = allowEmpty
        ? `<option value="">${escapeHtml(placeholder)}</option>`
        : '';

    return emptyOption + estimateGroup + extraGroup;
}
